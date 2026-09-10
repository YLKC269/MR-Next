// core/purify.js — 素材 / 文本净化（唯一事实来源，前端后端同名同语义）。
//
// 背景（用户实报）：素材选择弹窗里出现「@image#1:Clipboard_Screenshot.png」这类「数字素材」，
// 且文生视频出片被它污染。根因：ComfyUI 新版前端在富文本域里粘贴/插入图片时，会写入
// 「虚拟引用 token」`@image#N:文件名.png`——它不是磁盘真实文件，只是前端引用标记。
// 一旦残留：
//   ① 被当素材名 → 素材列表出现脏项（尾部带一串数字/机器名）→ 用户看到"数字素材"；
//   ② 混进 prompt → 出片提示词里带一坨无意义 token → 生成被污染（t2v 尤其明显，纯文字模式）。
//
// 本模块提供统一识别 + 剥离能力。所有"要送去生成 / 要显示为素材"的地方都必须过这一层。
// 后端对应实现见 server/api.py 的 _strip_virtual_refs / _is_virtual_ref。

// 完整形态：`@image#1:Clipboard_Screenshot.png`（可能有空格、中文冒号、带路径）
// 非贪婪吃到最后一个合法媒体扩展名为止，避免把后续中文一起吃掉。
const VIRTUAL_REF_RE =
  /@\s*image\s*#\s*\d+\s*[:：]\s*[^@\s，,。;；、")）\]】]*?\.(?:png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v|wav|mp3|m4a|flac|ogg)/gi;
// 残缺形态：只有 `@image#1:` / `@image#1:noext`（扩展名缺失或被截断）。
// 冒号后只吃 ASCII 文件名段（中文不吃）——避免把正常中文正文一起删掉。
const VIRTUAL_REF_BARE_RE = /@\s*image\s*#\s*\d+\s*[:：]?\s*[A-Za-z0-9_.\-]*/gi;
// 同类虚拟引用（视频/音频/遮罩等），一并剥离，避免换个前缀又漏网
const VIRTUAL_REF_ANY_RE = /@\s*(?:image|video|audio|mask|lora)\s*#\s*\d+\s*[:：]?\s*[A-Za-z0-9_.\-]*/gi;

function _has(s) { return String(s || "").length > 0; }

/** 字符串里是否含虚拟引用 token（含 @image# / @video# / @audio# 等） */
export function isVirtualRef(s) {
  const t = String(s == null ? "" : s);
  if (!t) return false;
  // 重置 lastIndex，避免带 g 标志的正则跨调用复用导致漏判
  VIRTUAL_REF_RE.lastIndex = 0;
  VIRTUAL_REF_ANY_RE.lastIndex = 0;
  return VIRTUAL_REF_RE.test(t) || VIRTUAL_REF_ANY_RE.test(t);
}

/**
 * 剥离文本里的虚拟引用 token，返回干净文本。
 * 用于：出片 prompt / 剧本文本 / 公共前缀 —— 任何要送进模型或写入 store 的文本。
 */
export function stripVirtualRefs(text) {
  let s = String(text == null ? "" : text);
  if (!s) return "";
  s = s.replace(VIRTUAL_REF_RE, "");
  s = s.replace(VIRTUAL_REF_ANY_RE, "");
  s = s.replace(VIRTUAL_REF_BARE_RE, "");
  // 剥离后可能留下「空格 + 标点」的空洞（如 "镜头 ，然后推近"），收一下
  s = s.replace(/[ \t]+([，。；、！？,.;!?])/g, "$1");
  s = s.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * 素材项是否为「脏项」：虚拟引用、以 @ 开头、或空 rel。
 * 脏项一律不进素材列表 / 不写入绑定，从源头杜绝"数字素材"。
 */
export function isDirtyAsset(a) {
  if (!a) return true;
  const rel = String(a.rel || "");
  const name = String(a.name || a.fileName || "");
  // 空 rel / 纯空白 rel 一律视为脏项（没有真实文件可指，显示出来也是坏条目）
  if (!_has(rel.trim())) return true;
  if (isVirtualRef(rel) || isVirtualRef(name)) return true;
  // 任何以 @ 开头的都不是正常文件名（Windows 文件名也不允许这些字符）
  if (/^\s*@/.test(rel) || /^\s*@/.test(name)) return true;
  if (/[<>|]/.test(rel)) return true;
  return false;
}

/** 批量过滤脏素材（保持原顺序） */
export function cleanAssets(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => !isDirtyAsset(x));
}

/** 合法 rel 判定：非空、非虚拟引用、不是纯路径分隔符 */
export function isUsableRel(rel) {
  const r = String(rel || "").trim();
  if (!r) return false;
  if (isVirtualRef(r)) return false;
  if (/^\s*@/.test(r)) return false;
  return true;
}

// ---------------------------------------------------------------- 状态级净化
// 兜底最狠的一层：store 里任何"会被送去生成 / 会显示成素材"的字段都必须干净。
// 这样即使用户从别处粘贴了 @image#N:xxx.png，也不可能一路带进出片请求。
const TEXT_FIELDS = ["script", "prefix"];
const SHOT_TEXT_FIELDS = ["text", "prompt", "body", "raw", "desc"];

/** 净化单个镜头对象（不改原对象） */
export function sanitizeShot(s) {
  if (!s || typeof s !== "object") return s;
  const c = { ...s };
  SHOT_TEXT_FIELDS.forEach((k) => {
    if (typeof c[k] === "string") c[k] = stripVirtualRefs(c[k]);
  });
  return c;
}

/**
 * 净化整个 store 状态（返回新对象，只动认识的字段）。
 * 用于：store.set 入口 + localStorage 载入时。
 */
export function sanitizeState(state) {
  if (!state || typeof state !== "object") return state;
  const out = { ...state };
  TEXT_FIELDS.forEach((k) => {
    if (typeof out[k] === "string") out[k] = stripVirtualRefs(out[k]);
  });
  if (Array.isArray(out.shots)) out.shots = out.shots.map(sanitizeShot);
  // refMap：丢掉 rel 不可用的条目（虚拟引用 / @ 开头 / 空），避免"幽灵素材"再次出现
  if (Array.isArray(out.refMap)) {
    out.refMap = out.refMap.filter((m) => !m || typeof m !== "object" || isUsableRel(m.rel));
  }
  return out;
}

/** 净化任意对象里的字符串字段（粘贴入口用） */
export function sanitizeText(t) {
  return stripVirtualRefs(String(t == null ? "" : t));
}
