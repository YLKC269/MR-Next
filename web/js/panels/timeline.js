// panels/timeline.js — 导演台（剪映式可视轨道）。v0.9.4 信息层级重构：
// 顶部参数「一段式切换」（模式/模型/输出/加速，默认收起，占位极小）；
// 中部可视化时间线占据最大可视区；选中镜头在下方编辑：左素材九宫格 + 右提示词（等高）。
import { h, clear } from "../core/dom.js";
import { relToViewUrl, editorThumbUrl } from "../core/api.js";
import { createMentionEditor } from "../core/mentions.js";
import { assetRegistry } from "../core/assets.js";
import { lightbox, closeLightbox, videoThumb, audioThumb } from "../core/ui.js";
import { stripVirtualRefs, isUsableRel } from "../core/purify.js";
import { VIDEO_SIZES, DEFAULT_VID_SIZE_INDEX, CUSTOM_VID_SIZE_INDEX, resolveVidSize, mpToWH, orientVidIndex } from "../core/sizes.js";

const MODES = [
  { v: "t2v", label: "文生视频（纯文字→视频）T2V" },
  { v: "i2v", label: "首帧生视频（首帧图→视频）I2V" },
  { v: "fl2v", label: "首尾帧生视频（首帧+尾帧→视频）FL2V" },
  { v: "fl2v_tail", label: "尾帧生视频（尾帧图→视频）L2V" },
  { v: "r2v", label: "参考生视频（多参考图→视频）R2V" },
];
const modeLabel = (v) => { const m = MODES.find((x) => x.v === v); return m ? m.label : v; };

// 取当前画布的工作流图（「外部节点接口」扫描用）。
// ComfyUI 把 app 挂在 window 上；不同版本取不到就返回 null（调用方给提示，不抛错）。
function liveGraph() {
  try {
    const w = typeof window !== "undefined" ? window : null;
    const a = w ? (w.app || (w.comfyAPI && w.comfyAPI.app && w.comfyAPI.app.app)) : null;
    if (a && a.graph && typeof a.graph.serialize === "function") return a.graph.serialize();
  } catch (_) {}
  return null;
}
const MODE_HINT = {
  t2v: "纯文本 → 完整时间线",
  i2v: "首帧 = 本镜 图[0]/视[0]",
  fl2v: "首=本镜图[0] 尾=本镜图[1]",
  fl2v_tail: "尾帧 = 本镜图[0]",
  r2v: "参考图 ≤9 · 音/视频参考 ≤3 · 调度器优选 beta/normal（社区实测比 simple 更稳）",
};
const PX = 16; // 每秒像素
const IMG_CAP = 9;

// ---------- LoRA 家族判定（只拦「结构上根本不对」的 LoRA）----------
// ⚠ 历史教训：早先这里按文件名推断「精度族 / 任务族」（bf16 LoRA × pruned 基座、
// Ref2VA LoRA × FL2VA 基座…）并标红 —— **那是误判**，会造成"明明能用却被判不能用"：
//   * 名字里的 bf16 / fp16 是 **LoRA 文件自身的存储精度**，不是「要求 bf16 基座」；
//     配 pruned-int8 基座是正常用法（官方导演台就是这么跑的）。
//   * ref2v / fl2v 变体互配时，ComfyUI 对不上的 LoRA key 是**跳过**（最多打一条
//     "lora key not loaded"），照样出片 —— 不是错误。
// 真正跑不了的只有「完全不属于 H3/MiniMax 的 LoRA」（Krea2 / LTX / 放大模型…）：
// 它们的 key 与 H3 一个都对不上 = 等于没加载。所以这里改成**黑名单**：
// 只拦已知的非 H3 家族，其余（含 bf16 / pruned / ref2v / fl2v 各种变体）一律放行。
const NON_H3_LORA_RE = /(krea2|ltx|clearreality|seedvr|vosr|esrgan|realesrgan|swinir)/i;
const TURBO_LORA_RE = /(turbo|acc[-_ ]?\d*step|\d+\s*step|nfe|\d+\s*步)/i;
const isForeignLora = (n) => !!n && NON_H3_LORA_RE.test(String(n));
// 返回提示（空串 = 放行）。只对「完全不是 H3 家族」的 LoRA 报警。
const loraUnetConflict = (lora) => {
  if (!lora || lora === "(无)") return "";
  if (isForeignLora(lora)) {
    return `「${lora}」不是 H3/MiniMax 的 LoRA（Krea2 / LTX / 放大模型等），key 与 H3 对不上 = 等于没加载，请改用 H3 的 LoRA`;
  }
  return "";
};

const DEFAULT_PARAMS = () => ({
  mode: "t2v",
  model: { unet: "", clip: "", vvae: "", avae: "", lora: "(无)", loraS: 1, autoUnet: true },
  speed: { lora: "(无)", loraS: 1, sage: "disabled", free_vram: true,
           // 内置注意力加速：off / sage / block_sparse（不需要外接节点；不可用时后端自动降级）
           accel: "off", accelInfo: null,
           // 外部节点接口：external = 画布上检测到的第三方加速类型（非空 → 内置加速自动失效）
           external: [], forceBuiltin: false, extInfo: null },
  output: {
    // 采样设置（官方 bd_grp_sample）
    cfg: 1, seed: 0, fps: 24, width: 768, height: 1344, ref_size: 864, sec: 5,
    // 全局时长开关：true = 所有分镜统一用 sec（忽略各镜单独设置）；false = 各镜用自己的 sec（未设则跟随 sec）
    global_sec: false,
    // 高级采样（官方 bd_grp_advanced）
    // 社区成片基线：18–22 步（20 = 生产档；>24 收益极低、时间成倍）；res_multistep + simple + cfg=1（引导蒸馏，拉高 CFG 反而闪烁）
    steps: 20, sampler: "res_multistep", scheduler: "simple", shift_video: 12, shift_audio: 3,
    // 性能（官方 bd_grp_perf）
    clear_vram: true, export_src: false,   // 官方 clear_vram_between_segments 默认 True（对齐官方）
    // 导出模式：all=全部合成一条视频，segments=每镜独立导出（官方导演台同款）
    exportMode: "all",
    continuity: false,          // 官方 continuityEnabled：段间重叠帧衔接（与「衔接下镜」的提示词级衔接不同）
    // 官方 continuityOverlapFrames：合法集只有 5/22/39/56（snap_context_frames），官方默认 22。
    // 旧默认 9 是非法值，会被官方归成 5（用户设了等于没设）。
    continuity_overlap: 22,
    // 二采高清放大（官方 MiniMaxH3DirectorRefine）
    refine_mode: "off", refine_megapixels: 1.0, refine_passes: 1,
    // 一采二采方案：mode(off/auto/manual) + engine(rtx/flash/seedvr2)
    upscale_mode: "off", upscale_engine: "rtx", upscale_scale: 2,
    // 画质档位：draft(低步数·快) / standard(均衡) / final(成品·最佳)
    quality: "standard",
    // 官方 ref_image_size 组合框（MiniMaxH3ReferenceToVideo）：match=按生成画布像素面积等比缩小（快）；
    // max=参考图短边上限 2048（身份保真最好，但参考 token 每步都带 → 慢数倍）。官方默认 match。
    ref_image_size: "match",
  },
  // —— 公共提示词（官方导演台 common prompt：整条时间线共用，逐镜并入）——
  common: { text: "", enabled: true },
  // —— 声音 / 台词（H3 官方三段式提示词）——
  // H3 是音视频联合生成：不写声音字段，模型会自己"补"人声 →「说话乱说」。
  audio: {
    structure: true,       // 启用官方 integrated/overall_soundscape/non_diegetic_music 三段式
    lang: "Chinese",       // 台词语言标签 [Chinese] / [English] …
    ambience: "",          // 环境音（留空 = 自动保守兜底：只留底噪，禁止额外人声）
    music: "",             // 画外配乐（留空 = N/A）
    no_speech: false,      // 静音模式：完全不要人声
    guard: true,           // 低步数音频护栏（steps < min_steps 自动抬升）
    // 参考视频自带声轨也作为 <Audio j> 送进模型（官方 ref_video_audios.ref_video_audio_k，同号配对）。
    // ⚠ 官方呈现顺序：图片 → 每个视频(先它的 <Audio j>、再 <Video k>) → 独立音频，
    //   所以启用后 <Audio> 编号会「先数视频声轨、再数独立音频」。默认关，避免改变既有提示词。
    video_audio_ref: false,
    min_steps: 8,          // 护栏安全线（社区实测 <8 步音频失真）
  },
});

// —— 参数持久化：导演台参数记忆在 localStorage，刷新/重开节点不丢 ——
const PARAMS_LS_KEY = "mrnext.timeline.params.v1";
function _deepMerge(base, override) {
  const out = { ...base };
  for (const k of Object.keys(override || {})) {
    const bv = base[k], ov = override[k];
    if (ov && typeof ov === "object" && !Array.isArray(ov) && bv && typeof bv === "object" && !Array.isArray(bv)) {
      out[k] = { ...bv, ...ov };
    } else {
      out[k] = ov;
    }
  }
  return out;
}
function _loadParams() {
  try { return _deepMerge(DEFAULT_PARAMS(), JSON.parse(localStorage.getItem(PARAMS_LS_KEY) || "{}")); }
  catch (_) { return DEFAULT_PARAMS(); }
}
// 递归 Proxy：嵌套对象（P.output.width 等）赋值时也触发保存
function _persistent(obj, key) {
  const seen = new Map();
  const save = () => { try { localStorage.setItem(key, JSON.stringify(obj)); } catch (_) {} };
  const wrap = (target) => {
    if (seen.has(target)) return seen.get(target);
    const p = new Proxy(target, {
      get(t, k) {
        const v = t[k];
        if (v && typeof v === "object" && !Array.isArray(v)) return wrap(v);
        return v;
      },
      set(t, k, v) { t[k] = v; save(); return true; },
    });
    seen.set(target, p);
    return p;
  };
  return wrap(obj);
}

const sel = (list, value) => h("select", { class: "select", style: { width: "auto" } },
  ...list.map((x) => h("option", { value: x, selected: x === value ? "selected" : null }, x)));
const num = (val, ph, w = 64, step = 1) => h("input", { class: "input", type: "number", step, value: val, placeholder: ph, style: { width: w } });

// MiniMax H3 官方「百万像素」→ 宽高算式统一收在 core/sizes.js 的 mpToWH（与官方 ResolutionSelector 同源）

// 纯文本查看弹窗（用于「预览本镜提示词」）：全内联样式，不依赖外部 CSS 类
function showTextModal(title, text) {
  const dlg = document.createElement("div");
  dlg.style.cssText = "position:fixed;inset:0;z-index:2147483001;background:rgba(2,4,9,.8);display:flex;align-items:center;justify-content:center;padding:24px;";
  const box = document.createElement("div");
  box.style.cssText = "background:linear-gradient(180deg,#1a2238,#141b30);border:2px solid #2d3a55;border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:10px;width:min(760px,92vw);max-height:82vh;box-shadow:0 16px 50px rgba(0,0,0,.6);";
  const tt = document.createElement("div");
  tt.textContent = title;
  tt.style.cssText = "color:#ffd166;font-size:13.5px;font-weight:700;";
  const ta = document.createElement("textarea");
  ta.value = String(text || "");
  ta.readOnly = true;
  ta.style.cssText = "flex:1 1 auto;min-height:340px;background:#0e1526;color:#cfe3ff;border:1px solid #2d3a55;border-radius:8px;padding:10px 12px;font:12px/1.7 ui-monospace,Consolas,monospace;resize:vertical;white-space:pre-wrap;";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
  const cp = document.createElement("button");
  cp.textContent = "复制";
  cp.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid #3a4a66;background:rgba(255,255,255,.06);color:#cfe3ff;font-size:12px;cursor:pointer;";
  cp.onclick = () => { ta.select(); try { document.execCommand("copy"); } catch (_) {} cp.textContent = "已复制"; };
  const cl = document.createElement("button");
  cl.textContent = "关闭";
  cl.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid #444;background:transparent;color:#9aa6bd;font-size:12px;cursor:pointer;";
  const close = () => { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); };
  cl.onclick = close;
  bar.append(cp, cl);
  box.append(tt, ta, bar);
  dlg.appendChild(box);
  dlg.onclick = (e) => { if (e.target === dlg) close(); };
  document.body.appendChild(dlg);
}

export function createTimelinePanel(ctx) {
  const folder = () => ctx.store.get().folder || "mrboard_next";
  const P = _persistent(_loadParams(), PARAMS_LS_KEY);  // 持久化参数（记忆保存）

  // 视频分辨率与 store 双向同步（与「一键流水线」面板共用 store.vidSize/vidW/vidH）：
  // 1) 初始化：若 store 有值，覆盖默认 768×1344
  // 2) 后续 wIn/hIn oninput（用户调）→ 写回 store
  // 3) 「一键流水线」改 store → 这里订阅同步 + 刷新顶部分辨率控件
  const _syncPfromStore = () => {
    const st = ctx.store.get();
    if (typeof st.vidW === "number" && st.vidW >= 64 && st.vidW !== P.output.width) P.output.width = st.vidW;
    if (typeof st.vidH === "number" && st.vidH >= 64 && st.vidH !== P.output.height) P.output.height = st.vidH;
    // H3 官方百万像素（0.1–2）：>0 时后端会按它换算宽高并写进 timeline_data.output.megapixels
    if (typeof st.vidMP === "number" && st.vidMP !== P.output.megapixels) P.output.megapixels = st.vidMP;
    // H3 官方 output 三开关（与「一键流水线」面板共享 store.exportMode/continuity/audioMute）
    if (st.exportMode && st.exportMode !== P.output.exportMode) P.output.exportMode = st.exportMode;
    if (typeof st.continuity === "boolean" && st.continuity !== !!P.output.continuity) P.output.continuity = st.continuity;
    if (typeof st.continuityOverlap === "number" && st.continuityOverlap !== Number(P.output.continuity_overlap)) P.output.continuity_overlap = st.continuityOverlap;
    const a = P.audio || (P.audio = {});
    if (typeof st.audioMute === "boolean" && st.audioMute !== !!a.no_speech) a.no_speech = st.audioMute;
    // 出片朝向（竖屏/横屏）也放 store，让「一键流水线」与工具栏一致
    if (st.vidOrient && st.vidOrient !== P.output.vidOrient) P.output.vidOrient = st.vidOrient;
  };
  const _syncStoreFromP = () => {
    ctx.store.set({
      vidW: P.output.width, vidH: P.output.height, vidMP: P.output.megapixels || 0,
      vidOrient: P.output.vidOrient || "auto",
      exportMode: P.output.exportMode === "segments" ? "segments" : "all",
      continuity: !!P.output.continuity,
      continuityOverlap: Number(P.output.continuity_overlap) || 9,
      audioMute: !!(P.audio && P.audio.no_speech),
    });
  };
  // 0) 一次性迁移：老版本这四个开关只存在导演台参数里（P），store 还没有对应键。
  //    ⚠ 只在 store 仍是默认值、且 P 里确实有用户选择时才灌（否则会把「一键流水线」
  //      刚写进 store 的开关反向冲回默认 —— 这正是把顺序写反时踩到的坑）。
  try {
    if (!localStorage.getItem("mrnext.tl.outflags.migrated")) {
      const st0 = ctx.store.get();
      const patch = {};
      if (st0.exportMode !== "segments" && P.output.exportMode === "segments") patch.exportMode = "segments";
      if (!st0.continuity && P.output.continuity) {
        patch.continuity = true;
        patch.continuityOverlap = Number(P.output.continuity_overlap) || 9;
      }
      if (!st0.audioMute && P.audio && P.audio.no_speech) patch.audioMute = true;
      if (Object.keys(patch).length) ctx.store.set(patch);
      localStorage.setItem("mrnext.tl.outflags.migrated", "1");
    }
  } catch (_) {}
  // 一次性迁移：v1.11.18–21 的画质档位会**自动**把加速设成 sage（该行为已移除）。
  // 存量 localStorage 里因此残留 accel=sage，而加速路径一旦与当前 ComfyUI/量化模型
  // 不兼容，就是「每次出片都崩、且报错不提加速」。这里把它清回 off 一次，
  // 让用户从「明确没开加速」的干净状态开始；想开可去「⚡ 加速」页自己选。
  let _accelResetNote = "";
  try {
    if (!localStorage.getItem("mrnext.tl.accel.migrated")) {
      if (P.speed.accel && P.speed.accel !== "off") {
        _accelResetNote = P.speed.accel;
        P.speed.accel = "off";
      }
      localStorage.setItem("mrnext.tl.accel.migrated", "1");
    }
  } catch (_) {}
  if (_accelResetNote) {
    setTimeout(() => ctx.toast(`已把残留的注意力加速（${_accelResetNote}）重置为「关闭」——之前的档位会自动开它，该行为已移除；需要提速请到「⚡ 加速」页手动选`, true), 1200);
  }
  // 1) 初始化：从 store 读初始值（避免来回切换面板反复覆盖）
  _syncPfromStore();
  // 2) 订阅：其他面板改 store → 这里 P.output.width/height 同步 + 顶部分辨率控件刷新
  ctx.store.subscribe((st) => {
    const ow = P.output.width, oh = P.output.height;
    const oem = P.output.exportMode, ocon = !!P.output.continuity, oam = !!(P.audio && P.audio.no_speech);
    _syncPfromStore();
    if (P.output.width !== ow || P.output.height !== oh) {
      // 触发了 P.output 改动 → 持久化（_persistent Proxy 的 set 会 save）
      // 再刷新「⚙ 宽×高」按钮的 label
      try { refreshTopVid(); } catch (_) {}
    }
    // 导出/连续性/音频模式被「一键流水线」改动 → 同步面板按钮文案与设置页控件
    if (P.output.exportMode !== oem) { try { refreshExportModeBtn(); } catch (_) {} }
    if (!!P.output.continuity !== ocon || !!(P.audio && P.audio.no_speech) !== oam) {
      try { syncOutFlagControls(); } catch (_) {}
    }
  });
  // 把 _syncStoreFromP 暴露给下面的 wIn/hIn oninput 用
  P.__syncStoreFromP = _syncStoreFromP;

  const shotsCfg = {};
  let opts = null;
  let favs = [];
  let selIdx = -1;
  let busy = false;
  let stopReq = false;
  const multiSel = new Set(); // 多选分镜（轨道块勾选）：批量出片用
  let openTab = null; // mode/model/sample/speed —— 官方分组
  let logOpen = false;
  let shotPreview = { idx: -1, rel: null }; // 最近出片结果（供编辑器实时预览框）
  let livePreviewUrl = null; // 生成过程中的实时预览图 URL（采样中轮询）
  // 本次出片的起始时间戳（epoch 秒）：只接受"本次开始之后"写的预览图，
  // 否则会把上一轮 / 别的模式留下的旧预览图当成实时预览显示（用户会以为"还在用以前的参考图"）。
  let previewRunSince = 0;
  let previewTimer = null;
  // 预览框就地重绘器：生成中只替换 <img src>，不整块重建编辑器。
  // （旧实现每 2.5s 调 renderEditor() 全量重建 DOM → 提示词框失焦、光标跳、布局跳动 = "界面错乱"）
  let previewPainter = null;
  // 「声音」页里步数警示的刷新器（改步数/护栏时重绘提示文案）
  let stepsWarnPainter = null;
  // 「⚙ 采样设置 / 🎙️ 声音」页里 导出模式/连续性/音频模式 三个控件的回填器集合
  // （被「一键流水线」面板改动 store 时，把新值刷回控件；由设置页构建时注册）
  const outFlagPainters = new Set();
  const syncOutFlagControls = () => { outFlagPainters.forEach((f) => { try { f(); } catch (_) {} }); };

  const track = h("div", { class: "tl-track" });
  const ruler = h("div", { class: "tl-ruler" });
  // 轨道滚动容器：强制 width:100% —— 不限宽的话 .tl-scroll（flex:0 0 auto）会被
  // 轨道内容撑开，分镜越多面板越宽，编辑区/实时预览被挤到可视区外。限宽后
  // overflow-x:auto 生效，轨道在固定宽度内横向滚动，下方编辑区布局不再随分镜数漂移。
  const scroll = h("div", { class: "tl-scroll", style: { width: "100%", minWidth: 0 } }, ruler, track);
  const tabBar = h("div", { class: "tl-tabs" });
  const paramRow = h("div", { class: "tl-parambox" });
  const editorHost = h("div", { class: "col", style: { flex: "0 0 auto" } });
  const logBar = h("div", { class: "tl-logbar" });
  const logFull = h("div", { class: "mono", style: { flex: "1 1 auto" } });
  const status = h("span", { style: { color: "#7fb0e8", fontSize: 11.5 } });

  const println = (t, c = "") => {
    logFull.textContent = t;
    logFull.title = t;
    if (c) logFull.style.color = c;
  };

  const loadFavs = async () => { await assetRegistry.refresh(folder()); favs = assetRegistry.favs; };
  loadFavs();
  // 素材库（点 <Picture N> 弹宫格预览）
  let assets = [];
  const loadAssets = async () => {
    await assetRegistry.refresh(folder());
    assets = assetRegistry.files; // 已含 rel
    return assets;
  };
  loadAssets();
  // 资产引用变化（公共前缀权威绑定 / 收藏库 / 素材库刷新）→ 重渲染导演台提示词 token 实时显示
  assetRegistry.subscribe(() => renderAll && renderAll());
  // 资产文件夹切换 → 刷新素材库 + 各镜 mention editor
  let _lastFolder = folder();
  setInterval(() => {
    const f = folder();
    if (f !== _lastFolder) { _lastFolder = f; loadAssets().then(() => renderAll && renderAll()); }
  }, 1500);
  // 首屏：editorFor 同步构建时 assets 可能还没加载完；这里 reload 一次并触发刷新
  // （同时给已建立的每镜补一次"正文引用"——那时素材库才有数据可解析）
  loadAssets().then(() => {
    if (assets && assets.length) {
      Object.keys(shotsCfg).forEach((k) => { try { mergeTextRefs(Number(k)); } catch (_) {} });
      renderAll && renderAll();
    }
  });

  // ---------- 从本镜正文里"读出"它引用的素材（与提示词里显示的标记保持一致）----------
  // 动机（用户实报）：自动拆分到导演台后，提示词里明明有 4 个素材标记，左边格子只有 1 张。
  // 规则与编辑器 token 的解析完全一致：
  //   <Picture N>/<Subject N> → 公共前缀手动绑定（relOfTag）优先，否则素材库第 N 张图
  //   <Video N>/<Audio N>     → 第 N 个视频/音频
  //   正文里直接写名字        → 收藏库优先、其次素材库文件名（长名优先，避免短名抢匹配）
  const refsFromText = (text) => {
    const out = { image: [], video: [], audio: [] };
    // 编号映射：官方参考槽是**按编号**对应的（ref_image_{k} ↔ <Picture {k+1}>），
    // 所以要把「标记里的第 N 号 → rel」单独留一份发给后端，否则 <Picture 1>/<Picture 3>
    // 会被按列表顺序接到槽 0/1 → 第 3 张永远进不了图（用户实报：标记了参考不作用）。
    const byNum = { image: {}, video: {}, audio: {} };
    const t = stripVirtualRefs(String(text || ""));
    const push = (kind, rel) => {
      if (!rel || !isUsableRel(rel)) return;
      const cap = kind === "image" ? IMG_CAP : 3;
      if (!out[kind].includes(rel) && out[kind].length < cap) out[kind].push(rel);
    };
    for (const m of t.matchAll(/<\s*(Picture|Subject|Video|Audio)\s*(\d+)\s*>/gi)) {
      const tag = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      const n = parseInt(m[2], 10) || 0;
      const kind = tag === "Audio" ? "audio" : tag === "Video" ? "video" : "image";
      const bound = assetRegistry.relOfTag(`<${tag} ${n}>`);
      const f = assetRegistry.fileByIndex(kind, n);
      const rel = bound || (f && f.rel) || "";
      push(kind, rel);
      if (rel && n >= 1 && isUsableRel(rel) && byNum[kind][n] == null) byNum[kind][n] = rel;
    }
    const names = new Set([
      ...(assetRegistry.favs || []).map((f) => f.name),
      ...(assetRegistry.files || []).map((f) => String((f && f.name) || "").replace(/\.[^.]+$/, "")),
    ].filter(Boolean));
    // 按名字引用（@名 或正文里直接写名字）：**必须按素材自身的 kind 归类** ——
    // 视频/音频名以前被一股脑塞进图片九宫格（于是音频永远进不了音频槽、引用不到）
    const allRecs = [...(assetRegistry.favs || []), ...(assetRegistry.files || [])];
    for (const nm of [...names].sort((a, b) => b.length - a.length)) {
      if (!t.includes(nm)) continue;
      const rec = allRecs.find((x) => {
        if (!x) return false;
        const stem = String(x.name || "").replace(/\.[^.]+$/, "");
        return x.name === nm || stem === nm;
      });
      const kk = rec && rec.kind === "video" ? "video" : rec && rec.kind === "audio" ? "audio" : "image";
      push(kk, (rec && rec.rel) || assetRegistry.relOf(nm));
    }
    out.byNum = byNum;
    return out;
  };
  // 把"正文里看得见的引用"补进本镜素材槽：幂等（只加不删）、每镜只补一次。
  // 用户手动挑过的素材不会被覆盖，只是把缺的补上。
  const mergeTextRefs = (i) => {
    const c = shotsCfg[i];
    if (!c || c.__textRefs) return false;
    // 素材库/收藏库还没加载完 → 先不标记，等 assets 到位后再补（否则会"补了个寂寞"）
    const hasRegistry = (assetRegistry.files || []).length || (assetRegistry.favs || []).length;
    const shots = ctx.store.get().shots || [];
    const text = c.prompt || (shots[i] && shots[i].text) || "";
    if (!hasRegistry && /<\s*(Picture|Subject|Video|Audio)\s*\d+\s*>/i.test(String(text))) return false;
    const got = refsFromText(text);
    let changed = false;
    for (const k of ["image", "video", "audio"]) {
      const cap = k === "image" ? IMG_CAP : 3;
      const arr = c.media[k] || (c.media[k] = []);
      for (const rel of got[k]) {
        if (arr.includes(rel)) continue;
        if (arr.filter(Boolean).length >= cap) break;
        arr.push(rel);
        changed = true;
      }
    }
    c.__textRefs = true;
    return changed;
  };

  const shot = (i) => {
    if (shotsCfg[i]) {
      // 兜底自动补：本镜素材区还空着、而 store.refMap[i] 已有引用（例如方案写入晚于本镜缓存建立）
      // → 按 refMap 补进来。只在"空着"时补，用户手动挑过的素材绝不会被覆盖。
      const refs0 = (ctx.store.get().refMap || [])[i];
      if (Array.isArray(refs0) && refs0.length) {
        const m = shotsCfg[i].media || (shotsCfg[i].media = { image: [], video: [], audio: [] });
        const empty = !((m.image || []).length + (m.video || []).length + (m.audio || []).length);
        if (empty) {
          m.image = refs0.filter((x) => x && x.kind === "image" && x.rel).map((x) => x.rel).slice(0, IMG_CAP);
          m.video = refs0.filter((x) => x && x.kind === "video" && x.rel).map((x) => x.rel).slice(0, 3);
          m.audio = refs0.filter((x) => x && x.kind === "audio" && x.rel).map((x) => x.rel).slice(0, 3);
        }
      }
      mergeTextRefs(i);     // 正文里看得见的标记/名字 → 补齐到格子（幂等，只加不删）
      return shotsCfg[i];
    }
    // 首次初始化：从 store.refMap[i]（切分时的素材引用）自动导入本镜素材九宫格
    const refMap = ctx.store.get().refMap || [];
    const refs = Array.isArray(refMap[i]) ? refMap[i] : [];
    shotsCfg[i] = {
      chosen: {},
      prompt: (ctx.store.get().shots || [])[i]?.text || "",
      media: {
        image: refs.filter((m) => m && m.kind === "image" && m.rel).map((m) => m.rel).slice(0, IMG_CAP),
        video: refs.filter((m) => m && m.kind === "video" && m.rel).map((m) => m.rel).slice(0, 3),
        audio: refs.filter((m) => m && m.kind === "audio" && m.rel).map((m) => m.rel).slice(0, 3),
      },
      sec: (ctx.store.get().shots || [])[i]?.sec ?? undefined,   // 未设=跟随顶部全局秒（旧包 split 自动时长自动进入）
      linkNext: false,  // 与下一镜衔接（上下文引导）
    };
    mergeTextRefs(i);     // 首次建立时也补一次（此时素材库可能还没加载完 → 下面 assets 到位后会再试）
    return shotsCfg[i];
  };
  // 本镜秒：全局时长开关开启时统一用 P.output.sec；否则用本镜 sec（未设则跟随全局）
  const effSec = (i) => {
    if (P.output.global_sec) return P.output.sec || 5;
    const s = shot(i).sec; return (s && s > 0) ? s : (P.output.sec || 5);
  };

  // ---------- 参数段控件（官方分组，每参数独立标签，网格排布不挤）----------
  // field = 一个参数 cell（中文标签在上、控件在下、可选官方名提示）
  const field = (label, control, officialName) => h("div", { class: "tl-field" },
    h("div", { class: "tl-flabel", title: officialName || "" }, label),
    control);
  // r2v 是"参考条件"任务：权重必须是 ref2va（官方 r2v 模板）；fl2va 是首尾帧权重，
  // 拿它跑 r2v 会把 ref_images/ref_videos/ref_audios 当噪声忽略 → 参考一律不生效。
  const unetIsRefCapable = (n) => /ref2va|hybrid/i.test(String(n || ""));
  const unetLooksFL2VOnly = (n) => /fl2va/i.test(String(n || "")) && !unetIsRefCapable(n);
  const refUnetName = () => (opts && ((opts.unetsByMode && opts.unetsByMode.r2v) || opts.refUnet)) || "";
  // 按模式自动选权重（只在用户没关掉开关时动，且不覆盖用户手动选择过的非等价权重）
  const applyModeUnet = (mode) => {
    if (!opts || P.model.autoUnet === false) return "";
    const want = (opts.unetsByMode && opts.unetsByMode[mode]) || "";
    if (!want || P.model.unet === want) return "";
    P.model.unet = want;
    return want;
  };

  const mkGroup = (key) => {
    const row = h("div", { class: "tl-paramrow" });
    outFlagPainters.clear();   // 页面重建 → 丢弃上一轮控件的回填器（避免 Set 无限增长 + 悬空 DOM 引用）
    if (!opts) { row.appendChild(h("span", { class: "muted" }, "加载选项…")); return row; }
    // ── 一键回到最佳画质 ──
    // 用户实报「视频好糊，没有之前清晰了，是不是加速开多了」。
    // 吃画质的开关散在 4 处（内置注意力加速 / 外接 SageAttention / 蒸馏 LoRA / 步数），
    // 而且都会持久化到 localStorage —— 没有一键回退就只能靠用户一个个试。
    // 20 步 = 社区成片基线（>24 收益极低）；这是「绝对画质」档，Sage 也不开（求稳）。
    const resetToBestQuality = () => {
      const changed = [];
      const st0 = Number(P.output.steps) || 0;
      if (st0 !== 20) { changed.push(`步数 ${st0}→20`); P.output.steps = 20; }
      if (String(P.output.sampler) !== "res_multistep") { changed.push("采样器 →res_multistep"); P.output.sampler = "res_multistep"; }
      if (String(P.output.scheduler) !== "simple") { changed.push("调度器 →simple"); P.output.scheduler = "simple"; }
      if (Number(P.output.cfg) !== 1) { changed.push(`cfg ${P.output.cfg}→1`); P.output.cfg = 1; }
      if (P.speed.accel && P.speed.accel !== "off") { changed.push(`内置注意力加速(${P.speed.accel})→关`); P.speed.accel = "off"; }
      if (P.speed.sage && P.speed.sage !== "disabled") { changed.push(`外接 SageAttention(${P.speed.sage})→关`); P.speed.sage = "disabled"; }
      if (P.speed.lora && P.speed.lora !== "(无)") { changed.push(`蒸馏 LoRA(${P.speed.lora})→关`); P.speed.lora = "(无)"; }
      if (String(P.output.upscale_mode || "off") === "off") { changed.push("出片后自动二采→开"); P.output.upscale_mode = "auto"; }
      P.output.quality = "final";
      ctx.toast(changed.length ? "已切到最佳画质：" + changed.join("；") : "当前已经是最佳画质，无需改动");
      // ⚠ 不要在按钮自己的事件派发过程中重建父容器（按钮会被摘掉）→ 下一帧再刷
      setTimeout(() => { try { renderParam(); } catch (_) {} }, 0);
    };
    if (key === "mode") {
      const msel = h("select", { class: "select", style: { width: "auto" } },
        ...MODES.map((m) => h("option", { value: m.v, selected: m.v === P.mode ? "selected" : null }, m.label)));
      // 切换模式要连编辑器一起重渲：t2v 无素材栏，其它模式有（否则要等下次刷新才生效）
      msel.onchange = () => {
        P.mode = msel.value;
        applyModeUnet(P.mode);   // r2v ↔ 首尾帧：权重跟着模式走（官方两份模板用的 UNET 不同）
        hint.textContent = MODE_HINT[P.mode] || "";
        // 切模式必须清掉"上一个模式的产物预览"：否则在 t2v 里还挂着 r2v 生成的旧视频帧，
        // 用户会以为"文生视频还在拿以前的参考图跑"。
        shotPreview = { idx: -1, rel: null };
        livePreviewUrl = null;
        previewRunSince = 0;
        renderTrack();
        renderEditor();
        renderParam();
      };
      const hint = h("span", { class: "muted" }, MODE_HINT[P.mode] || "");
      row.append(field("任务类型 task_type", msel), hint,
        h("span", {
          class: "muted", style: { fontSize: 10.5 },
          title: "官方 MiniMaxH3Director 的 task_type 还支持 v2v（源视频改视频）与 rv2v（参考素材改视频）；"
               + "这两条要源视频时间轴（<Video 1> + ref_videos/ref_video_audios 输入），本节点暂未接入 —— "
               + "不是 H3 不支持，是本节点没做这两条输入链路。",
        }, "（官方另有 v2v / rv2v：源视频编辑，本节点暂未接入）"));
    } else if (key === "model") {
      const mkS = (vals, cur) => sel(["", ...(vals || [])], cur || "");
      const unetE = mkS(opts.unets, P.model.unet);
      const unetWarn = h("div", { class: "muted", style: { gridColumn: "1 / -1", fontSize: "11px", lineHeight: "1.55" } });
      const paintUnetWarn = () => {
        const ok = P.mode !== "r2v" || !P.model.unet || unetIsRefCapable(P.model.unet);
        if (ok) {
          unetWarn.style.color = "";
          unetWarn.textContent = P.mode === "r2v"
            ? `✅ 当前是 r2v（参考生视频），权重 ${P.model.unet || "（未选）"} 支持参考条件`
            : `当前模式 ${P.mode}：用 fl2va 首尾帧权重即可（r2v 才需要 ref2va）`;
          return;
        }
        unetWarn.style.color = "#ffb4b4";
        unetWarn.textContent = `⚠ r2v 需要 ref2va（参考）权重，当前选的是「${P.model.unet}」—— fl2va 是首尾帧权重，`
          + `会把参考图 / 参考视频 / 参考音色当噪声忽略，参考一律不生效。点右边按钮一键切到 ${refUnetName() || "ref2va 权重"}`;
      };
      const fixUnetBtn = h("button", {
        class: "btn", style: { padding: "3px 9px", fontSize: 11.5 },
        title: "把 UNET 切到官方面向参考任务的 ref2va 权重",
        onclick: () => {
          const want = refUnetName();
          if (!want) { ctx.toast("本机没找到 ref2va 权重，请先下载 minimax_h3_ref2va_pruned_int8_convrot.safetensors", true); return; }
          P.model.unet = want;
          renderParam();
          ctx.toast("已切到 " + want);
        },
      }, "🔧 切到 ref2va");
      const unetFixRow = h("div", { class: "row", style: { gap: 8, alignItems: "center", gridColumn: "1 / -1" } },
        unetWarn, h("div", { class: "mx-spacer" }), fixUnetBtn);
      const autoUnetCk = h("input", { type: "checkbox", title: "切换模式时自动选择该模式的官方推荐权重（r2v → ref2va，首尾帧 → fl2va）" });
      autoUnetCk.checked = P.model.autoUnet !== false;
      autoUnetCk.onchange = () => {
        P.model.autoUnet = !!autoUnetCk.checked;
        if (autoUnetCk.checked) { applyModeUnet(P.mode); renderParam(); }
      };
      unetE.onchange = () => {
        P.model.unet = unetE.value;
        P.model.autoUnet = false;      // 手动选过就不再自动覆盖
        if (autoUnetCk.checked) autoUnetCk.checked = false;
        paintUnetWarn();
        paintLoraWarn();               // 换基座 → 立刻重判 LoRA 是否还配套
      };
      paintUnetWarn();
      const clipE = mkS(opts.clips, P.model.clip);
      const vvaeE = mkS(opts.videoVaes, P.model.vvae); vvaeE.onchange = () => { P.model.vvae = vvaeE.value; };
      const avaeE = mkS(opts.audioVaes, P.model.avae);
      // 音频 VAE 精度检查（社区高频翻车点）：fp16/bf16 的音频 VAE 会爆音、音画时序错位，必须 fp32。
      // 视频VAE 用 fp16 没问题 —— 只有音频那颗对精度敏感。
      const avaeNote = h("div", { class: "muted", style: { gridColumn: "1 / -1", fontSize: "11px", lineHeight: "1.55" } });
      const syncAvaeNote = () => {
        const cur = String(avaeE.value || "");
        if (!cur) {
          avaeNote.textContent = "音频 VAE 未指定：走示例工作流默认值；建议选 fp32 版（社区实测 fp16 直接爆音、音画错位）";
          avaeNote.style.color = "#7d9dba";
        } else if (/fp16|bf16/i.test(cur)) {
          avaeNote.textContent = `⚠ 当前音频 VAE「${cur}」是 fp16/bf16 —— 社区实测会爆音、音画时序错位，请换 fp32 版（如 minimax_h3_audio_vae_fp32.safetensors）`;
          avaeNote.style.color = "#ffb4b4";
        } else if (/fp32/i.test(cur)) {
          avaeNote.textContent = `✓ ${cur}（fp32 音频 VAE，音轨安全）`;
          avaeNote.style.color = "#8ff0c0";
        } else {
          avaeNote.textContent = `音频 VAE「${cur}」未标精度 —— 若出片爆音，优先换 fp32 版（minimax_h3_audio_vae_fp32.safetensors）`;
          avaeNote.style.color = "#7d9dba";
        }
      };
      avaeE.onchange = () => { P.model.avae = avaeE.value; syncAvaeNote(); };
      // 模型页 LoRA：只排除**已知的非 H3 家族**（Krea2 / LTX / 放大模型…）；
      // 其余一律列出（bf16 / pruned / ref2v / fl2v 各变体都能用，官方导演台同款行为）。
      const loraE = sel(["(无)"].concat((opts.loras || []).filter((n) => !isForeignLora(n))), P.model.lora);
      const loraWarn = h("div", { class: "muted", style: { gridColumn: "1 / -1", fontSize: "11px", lineHeight: "1.55" } });
      const paintLoraWarn = () => {
        const msg = loraUnetConflict(loraE.value);
        loraWarn.textContent = msg ? "⚠ " + msg : "";
        loraWarn.style.color = msg ? "#ffb4b4" : "";
      };
      loraE.onchange = () => { P.model.lora = loraE.value; paintLoraWarn(); };
      paintLoraWarn();
      const loraSE = num(P.model.loraS, "1", 52, 0.1); loraSE.oninput = () => { P.model.loraS = Number(loraSE.value) || 1; };
      // CLIP 选型提示：H3 是 cfg=1.0（无负引导）模型，画面全靠文本 embedding 指路。
      // nvfp4/fp4 这类 4bit 量化 CLIP 省内存，但语义会打折，症状就是「画面不按提示词走」，
      // 所以把这句话直接摆在下拉旁边，让用户知道自己此刻跑的是哪一档。
      const _clipNotes = (opts && opts.clipNotes) || {};
      const clipNote = h("div", { class: "muted", style: { gridColumn: "1 / -1", fontSize: "11px", lineHeight: "1.55" } });
      const syncClipNote = () => {
        const cur = clipE.value || ((opts && opts.defaults && opts.defaults.clip) || "");
        const t = _clipNotes[cur] || (clipE.value ? "" : "未指定时走示例工作流默认值；建议选 int8 版以获得最佳提示词遵循");
        clipNote.textContent = t;
        clipNote.style.color = t.indexOf("⚠") >= 0 ? "#ffb35c" : (t.indexOf("✓") >= 0 ? "#8ff0c0" : "#7d9dba");
      };
      clipE.onchange = () => { P.model.clip = clipE.value; syncClipNote(); };
      row.append(unetFixRow,
        h("div", { class: "row", style: { gap: 8, alignItems: "center" } }, autoUnetCk,
          h("span", { class: "muted", style: { fontSize: 11 } }, "跟随模式自动选权重（推荐：r2v → ref2va，首尾帧 → fl2va）")),
        field("UNet 模型", unetE, "model"), field("CLIP 文本编码", clipE, "clip"),
        field("视频 VAE", vvaeE, "video_vae"), field("音频 VAE", avaeE, "audio_vae"),
        field("LoRA", loraE, "lora_name"), field("LoRA 强度", loraSE, "lora_strength"), clipNote, avaeNote, loraWarn);
      syncClipNote();
      syncAvaeNote();
    } else if (key === "sample") {
      // 采样设置组（官方 bd_grp_sample + bd_grp_advanced + bd_grp_perf 合并）
      const aspects = opts?.aspects || [{ v: "768:1344", w: 768, h: 1344 }];
      // 注：视频分辨率 + H3 百万像素控件**只保留顶部工具栏那一份**（避免同一面板出现两套
      // 分辨率/MP 设置，用户实报「重复了好多个」）。本页不再重复渲染，改由工具栏统一负责：
      // 工具栏 → store.vidSize/vidW/vidH/vidMP → _syncPfromStore → P.output（本页照常读 P）。
      // 官方：cfg FLOAT 0–30（默认 1.0；H3 官方模板就是 cfg=1）
      const cfgE = num(P.output.cfg, "1", 64, 0.05);
      cfgE.min = 0; cfgE.max = 30;
      cfgE.oninput = () => { P.output.cfg = Math.max(0, Math.min(30, Number(cfgE.value) || 0)); };
      const seedE = num(P.output.seed, "0", 84, 1); seedE.oninput = () => { P.output.seed = Number(seedE.value) || 0; };
      // 官方：frame_rate FLOAT 1–240（默认 24；H3 按 24 训练）
      const fpsE = num(P.output.fps, "24", 64, 1);
      fpsE.min = 1; fpsE.max = 240;
      fpsE.oninput = () => { P.output.fps = Math.max(1, Math.min(240, Number(fpsE.value) || 24)); };
      const secE = num(P.output.sec, "5", 64, 0.5); secE.oninput = () => { P.output.sec = Math.max(0.5, Number(secE.value) || 5); renderAll(); };
      const secAll = h("button", { class: "btn", style: { padding: "3px 8px", fontSize: 11 }, title: "把当前默认秒写入每个分镜", onclick: () => { const ss = ctx.store.get().shots || []; ss.forEach((_, i) => { shot(i).sec = P.output.sec; }); renderTrack(); renderEditor(); ctx.toast(`已设全部 ${ss.length} 镜为 ${P.output.sec}s`); } }, "设全镜秒");
      // 官方：ref_max_size INT 32–8192 step 32（默认 864）—— 参考图长边上限
      const refE = num(P.output.ref_size, "864", 64, 32);
      refE.min = 32; refE.max = 8192;
      refE.oninput = () => { P.output.ref_size = Math.max(32, Math.min(8192, Number(refE.value) || 864)); };
      // 官方 ref_image_size（MiniMaxH3ReferenceToVideo 的组合框）：match / max
      const refImgSizeE = sel(["match", "max"], P.output.ref_image_size || "match");
      refImgSizeE.onchange = () => { P.output.ref_image_size = refImgSizeE.value; };
      // 官方：steps INT 1–200（社区基线 20）→ 用自由输入（以前是固定下拉，值不全）
      const stepsE = num(P.output.steps, "20", 64, 1);
      stepsE.min = 1; stepsE.max = 200;
      stepsE.oninput = () => { P.output.steps = Math.max(1, Math.min(200, Number(stepsE.value) || 20)); if (stepsWarnPainter) stepsWarnPainter(); };
      const samplerE = sel((opts?.samplers || ["res_multistep"]), P.output.sampler || "res_multistep"); samplerE.onchange = () => { P.output.sampler = samplerE.value; };
      const schedE = sel((opts?.schedulers || ["simple"]), P.output.scheduler || "simple"); schedE.onchange = () => { P.output.scheduler = schedE.value; };
      // 采样一律走官方单时钟（T8 双时钟方案已摘除：它是实验分支，跑不出片的代价远大于收益）。
      // 采样方案按钮组（采样器+调度器组合预设，一键切换）
      const SAMPLE_PRESETS = [
        { label: "官方标准", sampler: "res_multistep", scheduler: "simple", tip: "官方推荐，质量稳定" },
        { label: "R2V 优选", sampler: "res_multistep", scheduler: "beta", tip: "参考生视频社区实测：beta 调度比 simple 人物一致性更稳" },
        { label: "快速", sampler: "euler", scheduler: "simple", tip: "速度快" },
        { label: "均衡", sampler: "euler", scheduler: "normal", tip: "速度质量均衡" },
        { label: "高质量", sampler: "res_multistep", scheduler: "normal", tip: "画质优先（较慢）" },
      ];
      const presetWrap = h("div", { class: "row", style: { gap: 4, flexWrap: "wrap" } });
      const renderPreset = () => {
        clear(presetWrap);
        SAMPLE_PRESETS.forEach((p) => {
          const on = P.output.sampler === p.sampler && P.output.scheduler === p.scheduler;
          const b = h("button", {
            class: "btn" + (on ? " btn-primary" : ""),
            style: { padding: "4px 9px", fontSize: 11 },
            title: `${p.sampler} + ${p.scheduler}（${p.tip}）`,
            onclick: () => { P.output.sampler = p.sampler; P.output.scheduler = p.scheduler; samplerE.value = p.sampler; schedE.value = p.scheduler; renderPreset(); },
          }, p.label);
          presetWrap.appendChild(b);
        });
      };
      renderPreset();
      // 画质档位（对齐社区"预览归预览、成片归成片"两套工作流）。
      // 公共基线：res_multistep + simple + cfg=1（引导蒸馏）+ shift 12/3（训练值）。
      // 预览 = 蒸馏 LoRA 低步数；成片 = 16–20 步原生采样 + 二采。
      // 采样统一走官方单时钟（双时钟已摘除）；加速开关由「⚡ 加速」页显式控制，档位不动它。
      const QUALITY_PRESETS = [
        { key: "draft", label: "⚡ 草稿 6步", steps: 6, sampler: "res_multistep", scheduler: "simple", cfg: 1, sv: 12, sa: 3, turboS: 1.0, upscale: "off", turbo: true,
          tip: "社区预览方案：蒸馏 LoRA 6 步。最快，只用于验证构图/动作/台词。低步数音轨易失真，已由「声音」页音频护栏自动抬到安全步数" },
        { key: "standard", label: "⚖ 标准 16步", steps: 16, sampler: "res_multistep", scheduler: "simple", cfg: 1, sv: 12, sa: 3, upscale: "off", turbo: false,
          tip: "社区基线：res_multistep + simple + cfg=1。实测低于 ~15 步画质明显下降，16 步是画质/速度均衡点" },
        { key: "final", label: "✨ 成品 20步", steps: 20, sampler: "res_multistep", scheduler: "simple", cfg: 1, sv: 12, sa: 3, upscale: "auto", turbo: false,
          tip: "社区成片方案：20 步生产基线（>24 收益极低）+ 出片后自动二采高清放大。最慢，但画质/音质最好" },
      ];
      const qualWrap = h("div", { class: "row", style: { gap: 4, flexWrap: "wrap" } });
      const renderQual = () => {
        clear(qualWrap);
        QUALITY_PRESETS.forEach((q) => {
          const on = P.output.quality === q.key;
          qualWrap.appendChild(h("button", {
            class: "btn" + (on ? " btn-primary" : ""),
            style: { padding: "4px 9px", fontSize: 11 },
            title: q.tip,
            onclick: () => {
              P.output.quality = q.key;
              P.output.steps = q.steps; P.output.sampler = q.sampler; P.output.scheduler = q.scheduler;
              P.output.cfg = q.cfg; P.output.shift_video = q.sv; P.output.shift_audio = q.sa;
              P.output.upscale_mode = q.upscale || "off";
              const notes = [];
              // ⚠ 档位**不改加速开关**：加速属于「⚡ 加速」页的显式选择。
              // （历史上档位自动开 SageAttention，让用户在不知情的情况下换了采样路径；
              //   而且一旦加速路径与当前 ComfyUI/量化模型不兼容就直接采样失败。）
              // 蒸馏 LoRA 只属于预览档（社区结论：损伤音质，不进成片）—— 切标准/成品自动关掉
              if (q.turbo) {
                P.speed.loraS = q.turboS || 1;
                if (!P.speed.lora || P.speed.lora === "(无)") {
                  ctx.toast("草稿档请到「⚡加速」页选一个蒸馏 LoRA（4/8 步），否则低步数画质会崩", true);
                }
              } else if (P.speed.lora && P.speed.lora !== "(无)") {
                P.speed.lora = "(无)";
                notes.push("蒸馏 LoRA 已关（社区实测损伤音质，不进成片）");
              }
              stepsE.value = String(q.steps); samplerE.value = q.sampler; schedE.value = q.scheduler;
              cfgE.value = String(q.cfg); sVE.value = String(q.sv); sAE.value = String(q.sa);
              renderQual(); renderPreset();
              if (stepsWarnPainter) stepsWarnPainter();
              if (notes.length) ctx.toast(notes.join("；"));
            },
          }, q.label));
        });
        // 一键最佳画质也放这里：用户觉得「糊」时第一反应是来画质档位，不该跑到「⚡加速」页才对
        qualWrap.appendChild(h("button", {
          class: "btn", style: { padding: "4px 9px", fontSize: 11 },
          title: "步数 20（社区成片基线）+ 出片后自动二采 + 关掉内置注意力加速 / 外接 SageAttention / 蒸馏 LoRA。绝对画质，最慢",
          onclick: resetToBestQuality,
        }, "🧼 最佳画质"));
      };
      renderQual();
      // 官方：shift_video / shift_audio FLOAT 0.01–100（默认 12 / 3，训练值别乱动）
      // 官方：段间连续性 continuityEnabled + continuityOverlapFrames（合法集 5/22/39/56，默认 22）
      // 以前没暴露也没写进 timeline_data → 官方那套"段间重叠帧"根本没启用
      const contCk = h("input", { type: "checkbox", checked: P.output.continuity ? "checked" : null, style: { accentColor: "#ffd166" } });
      contCk.onchange = () => {
        P.output.continuity = contCk.checked;
        if (contCk.checked && !P.output.continuity_overlap) P.output.continuity_overlap = 22;
        if (P.__syncStoreFromP) P.__syncStoreFromP();   // → store.continuity（「一键流水线」联动）
      };
      const contOvSel = h("select", { class: "select", style: { width: "auto" } },
        ...[5, 22, 39, 56].map((n) => h("option", { value: String(n), selected: Number(P.output.continuity_overlap || 22) === n ? "selected" : null }, String(n) + " 帧")));
      contOvSel.onchange = () => {
        P.output.continuity_overlap = Number(contOvSel.value) || 22;
        if (P.__syncStoreFromP) P.__syncStoreFromP();   // → store.continuityOverlap
      };
      // 被「一键流水线」改 store → 回填这两个控件
      outFlagPainters.add(() => {
        contCk.checked = !!P.output.continuity;
        contOvSel.value = String(Number(P.output.continuity_overlap) || 22);
      });
      const sVE = num(P.output.shift_video, "12", 64, 0.1);
      sVE.min = 0.01; sVE.max = 100;
      sVE.oninput = () => { P.output.shift_video = Math.max(0.01, Math.min(100, Number(sVE.value) || 12)); };
      const sAE = num(P.output.shift_audio, "3", 64, 0.5); sAE.oninput = () => { P.output.shift_audio = Number(sAE.value) || 0; };
      const ck = (val, fn, label, official) => h("label", { class: "row", style: { gap: 5, cursor: "pointer", padding: "4px 6px" } },
        h("input", { type: "checkbox", checked: val ? "checked" : null, onchange: (e) => fn(e.target.checked), style: { accentColor: "#ffd166" } }),
        h("span", { style: { fontSize: 11.5, color: "#bcd3ea" }, title: official || "" }, label));
      // 采样设置页排版：以前 15 个字段平铺在 auto-fill 网格里 → 宽容器下大片留白、
      // 画质档位按钮被挤成竖排。现在分成 3 个视觉子组（全宽横条），每组内部自带网格，
      // 画质档位拿最宽的一格保证按钮横排。
      // ⚠ 子组各用命名变量再 append：内联 6 层嵌套的括号极易漏一个（漏了就是整块面板空白）。
      const subSection = (title, ...kids) => h("div", { style: { gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 5, padding: "5px 8px 7px", border: "1px solid rgba(120,170,255,.1)", borderRadius: 6, background: "rgba(8,16,32,.35)" } },
        h("div", { class: "muted", style: { fontSize: 10, fontWeight: 600, color: "#6f88a8", letterSpacing: ".4px" } }, title),
        ...kids);
      const secCore = subSection("采样核心",
        h("div", { style: { display: "grid", gridTemplateColumns: "minmax(80px, 1fr) minmax(240px, 2.6fr)", gap: 8, alignItems: "start" } },
          field("步数", stepsE, "steps (1-200)"),
          field("画质档位", qualWrap, "社区两套方案：预览（6 步+Turbo）/ 标准 16 步 / 成品 20 步+二采")));
      const secSampler = subSection("采样器与引导",
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))", gap: 6 } },
          field("采样器", samplerE, "sampler"),
          field("调度器", schedE, "scheduler"),
          field("CFG 引导", cfgE, "cfg"),
          field("种子", seedE, "seed"),
          field("视频 shift", sVE, "shift_video"),
          field("音频 shift", sAE, "shift_audio")));
      const contRow = h("div", { style: { gridColumn: "span 2", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 } },
        h("div", { class: "tl-flabel", title: "官方 continuityEnabled：段与段之间用重叠帧衔接（与「衔接下镜」的提示词级衔接是两回事）" }, "段间连续性"),
        h("div", { class: "row", style: { gap: 6 } }, contCk,
          h("span", { class: "muted", style: { fontSize: 10.5 }, title: "官方 continuityEnabled：段与段之间用重叠帧衔接" }, "continuityEnabled"),
          contOvSel));
      const outRow = h("div", { style: { gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 3 } },
        h("div", { class: "tl-flabel" }, "导出与显存"),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
          ck(P.output.clear_vram, (v) => { P.output.clear_vram = v; }, "段间清显存", "clear_vram_between_segments"),
          ck(P.output.export_src, (v) => { P.output.export_src = v; }, "导出源图", "export_source_images")));
      const secRef = subSection("采样方案 · 参考 · 段间",
        h("div", { style: { display: "flex", flexDirection: "column", gap: 7 } },
          field("采样方案", presetWrap, "采样器+调度器组合预设（点击切换）"),
          h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(126px, 1fr))", gap: 6 } },
            field("参考图尺寸", refE, "ref_max_size"),
            field("参考图缩放", refImgSizeE, "ref_image_size（官方 match / max）"),
            contRow,
            outRow)));
      row.append(secCore, secSampler, secRef);
    } else if (key === "audio") {
      // —— 声音 / 台词：H3 官方三段式提示词（治「说话乱说 / 语音乱码」）——
      // H3 音视频联合生成：只给画面描述、不写声音字段 → 模型自行补人声 → 胡言乱语。
      const A = P.audio || (P.audio = {});
      const ckBox = (get, set, label, tip) => h("label", { class: "row", style: { gap: 5, cursor: "pointer", padding: "4px 6px" } },
        h("input", { type: "checkbox", checked: get() ? "checked" : null, onchange: (e) => set(e.target.checked), style: { accentColor: "#ffd166" } }),
        h("span", { style: { fontSize: 11.5, color: "#bcd3ea" }, title: tip || "" }, label));
      const structCk = ckBox(() => A.structure !== false, (v) => { A.structure = v; }, "H3 官方三段式提示词", "必须开启：给模型补 integrated_multimodal_description / overall_soundscape / non_diegetic_music 三段。关掉则按原文直出（会出现乱说话）");
      const langE = sel(["Chinese", "English", "Japanese", "Korean", "Cantonese", "French", "German", "Spanish"], A.lang || "Chinese");
      langE.onchange = () => { A.lang = langE.value; };
      const ambE = h("input", { class: "input", value: A.ambience || "", placeholder: "留空 = 自动（只留底噪，禁止额外人声）", style: { width: "100%" } });
      ambE.oninput = () => { A.ambience = ambE.value; };
      const musE = h("input", { class: "input", value: A.music || "", placeholder: "留空 = N/A（无配乐）", style: { width: "100%" } });
      musE.oninput = () => { A.music = musE.value; };
      // 官方 output.audioMode：generate（正常生成人声）/ mute（完全无人声）/ source（保留源音频——仅 v2v 源视频模式用，本节点未接入）
      const amodeSel = sel(["generate", "mute"], A.no_speech ? "mute" : "generate");
      amodeSel.onchange = () => {
        A.no_speech = amodeSel.value === "mute";
        if (P.__syncStoreFromP) P.__syncStoreFromP();   // → store.audioMute（「一键流水线」联动）
      };
      outFlagPainters.add(() => { amodeSel.value = A.no_speech ? "mute" : "generate"; });
      const amodeWrap = h("div", { class: "row", style: { gap: 6, alignItems: "center" } }, amodeSel,
        h("span", { class: "muted", style: { fontSize: 10.5 }, title: "官方 audioMode：generate=正常生成人声；mute=完全无人声（纯环境音/配乐）；source=保留源音频（仅 v2v 源视频模式用，本节点未接入）" }, "generate / mute（source 需源视频，未接入）"));
      const guardCk = ckBox(() => A.guard !== false, (v) => { A.guard = v; }, "低步数音频护栏", "ComfyUI 稳定版在 <8 步时音轨会失真（主仓 bug，修复 commit bdcb886，需 nightly）。开启后自动把步数抬到安全线");
      const minStepE = num(A.min_steps || 8, "8", 56, 1); minStepE.oninput = () => { A.min_steps = Math.max(4, Math.min(32, Number(minStepE.value) || 8)); };
      // 步数低于安全线时的警示（与护栏联动）
      const warn = h("div", { style: { fontSize: 11, color: "#ffb35c", lineHeight: 1.5 } });
      const paintWarn = () => {
        const st = Number(P.output.steps) || 0;
        const minS = Number(A.min_steps || 8);
        warn.style.color = "#ffb35c";
        if (st > 0 && st < minS) {
          warn.textContent = A.guard === false
            ? `⚠ 当前 ${st} 步 < 安全线 ${minS} 步：低步数下音轨极易失真（画质正常、声音变噪音）。建议升 ComfyUI nightly，或关掉护栏时手动把步数提到 ${minS} 以上。`
            : `⏫ 当前 ${st} 步 < 安全线 ${minS} 步：出片时会自动抬到 ${minS} 步（护栏已开启）。`;
        } else { warn.textContent = ""; }
      };
      paintWarn();
      stepsWarnPainter = paintWarn;
      minStepE.onchange = paintWarn;
      // 预览提示词：调后端组装器看实际送进 H3 的文本（确认台词识别是否正确）
      const pvBtn = h("button", { class: "btn", style: { padding: "4px 10px", fontSize: 11.5 }, title: "查看本镜组装后的 H3 官方提示词（不出片）", onclick: async () => {
        const ss = ctx.store.get().shots || [];
        const i = Math.max(0, selIdx);
        const sh = ss[i];
        const raw = stripVirtualRefs((shotsCfg[i] && shotsCfg[i].prompt) || sh?.text || "");
        if (!raw.trim()) { ctx.toast("当前镜头没有提示词", true); return; }
        try {
          const r = await ctx.api.h3PromptPreview({
            prompt: raw, prefix: stripVirtualRefs(ctx.store.get().prefix || ""),
            seconds: effSec(i), index: (sh && sh.index) || i + 1, opts: collectOpts(),
          });
          if (!r.ok) { ctx.toast("预览失败: " + (r.error || ""), true); return; }
          const txt = r.prompt || "";
          // 回显里把「谁说的 + 第几号音色」也写出来：用户能一眼核对音色有没有绑对
          const dlg = (r.dialogues || []).map((d) => {
            const who = d.speaker ? `${d.speaker}${d.sid ? ` (${d.sid})` : ""}` : (d.sid ? `(${d.sid})` : "?");
            const au = Number(d.audio) > 0 ? `（音色参考 <Audio ${d.audio}>）` : "";
            return `${who}${au}${d.inner ? "［内心独白］" : ""}: ${d.text}`;
          }).join("\n");
          showTextModal("H3 官方提示词预览", txt + (dlg ? "\n\n—— 识别到的对白 ——\n" + dlg : "\n\n（本镜没有识别到对白 → 已显式声明 No dialogue）"));
        } catch (e) { ctx.toast("预览失败: " + e.message, true); }
      } }, "🔍 预览本镜提示词");
      row.append(
        structCk,
        field("台词语言", langE, "av_lang（台词用 [语言] 包裹，绝不用双引号）"),
        h("div", { class: "tl-field", style: { gridColumn: "1 / -1" } },
          h("div", { class: "tl-flabel", title: "overall_soundscape" }, "环境音（overall_soundscape）"),
          ambE),
        h("div", { class: "tl-field", style: { gridColumn: "1 / -1" } },
          h("div", { class: "tl-flabel", title: "non_diegetic_music" }, "画外配乐（non_diegetic_music）"),
          musE),
        field("音频模式", amodeWrap, "timeline_data.output.audioMode"),
        field("参考视频声轨", ckBox(() => A.video_audio_ref === true, (v) => { A.video_audio_ref = v; },
          "也作为音频参考", "官方 ref_video_audios.ref_video_audio_k：把本镜参考视频自带的声轨一起送进模型。\n"
          + "⚠ 官方 <Audio> 编号顺序是「先数参考视频的声轨、再数独立音频」—— 启用后本来写 <Audio 1> 的那句要往后挪。\n"
          + "（需要 VHS 的 LoadVideoPath / LoadVideo 节点提供音轨；LoadVideoUI 无音轨输出）"), "video_audio_ref"),
        guardCk,
        field("护栏最低步数", minStepE, "audio_min_steps"),
        h("div", { class: "tl-field", style: { gridColumn: "1 / -1" } }, pvBtn),
        h("div", { class: "tl-field", style: { gridColumn: "1 / -1" } }, warn),
        h("div", { class: "tl-field", style: { gridColumn: "1 / -1" } },
          h("div", { class: "muted", style: { fontSize: 10.5, lineHeight: 1.6, opacity: 0.85 } },
            "说话人编号 (S1)/(S2) 由「公共前缀」里的角色顺序自动分配，同一角色跨镜头同号（音色不串）。台词请写成「角色名：台词」或「角色名说：台词」；无台词时会自动声明 No dialogue，防止模型乱配音。")));
    } else if (key === "speed") {
      // ── 加速总览 + 一键回退（先定义，下面所有控件的 handler 都会调用它）──
      // 用户实报「视频好糊，是不是加速开多了」：加速项分散在 4 个控件里，
      // 没有总览就只能靠用户自己一个个关掉试 → 这里把「当前开着什么」直接摆出来。
      const accelStatus = h("div", { style: { fontSize: 11.5, lineHeight: 1.7 } });
      const paintAccelStatus = () => {
        const on = [];
        if (P.speed.accel && P.speed.accel !== "off") on.push(`内置注意力加速＝${P.speed.accel}`);
        if (P.speed.sage && P.speed.sage !== "disabled") on.push(`外接 SageAttention＝${P.speed.sage}`);
        const turbo = !!(P.speed.lora && P.speed.lora !== "(无)");
        if (turbo) on.push(`蒸馏 LoRA＝${P.speed.lora}（强度 ${P.speed.loraS}）`);
        const st = Number(P.output.steps) || 0;
        const up = String(P.output.upscale_mode || "off") !== "off";
        const tips = [];
        if (st && st < 16) tips.push(`步数只有 ${st}（社区基线 16–20，<15 画质明显下降）`);
        const rw = Number(P.output.width) || 0, rh = Number(P.output.height) || 0;
        const resTxt = (rw && rh) ? `｜画幅 ${rw}×${rh}（${(rw * rh / 1048576).toFixed(2)}MP）` : "";
        const tail = `｜步数 ${st}${up ? " · 出片后二采已开" : " · 出片后二采未开（开它能明显提清晰度）"}` + resTxt;
        // 社区分级：SageAttention 近乎无损（成片可开）；block_sparse 低损；蒸馏 LoRA 真吃音质（仅预览）。
        const hasSage = P.speed.accel === "sage" || !!(P.speed.sage && P.speed.sage !== "disabled");
        const hasLossy = P.speed.accel === "block_sparse" || turbo;
        if (turbo) {
          accelStatus.style.color = "#ffd9a8";
          accelStatus.textContent = `⚠ 蒸馏 LoRA＝${P.speed.lora} 在跑 —— 社区实测损伤音质（杂音/爆音），只用于快速预览；`
            + `出成片点「🧼 一键最佳画质」或选「标准 / 成品」档位关掉它`
            + (tips.length ? `。另外：${tips.join("；")}。` : "。") + tail;
        } else if (hasLossy) {
          accelStatus.style.color = "#ffd9a8";
          accelStatus.textContent = `⚠ 正在加速：${on.join("｜")}（block_sparse 属低损加速，细节极敏感时再关；别与外接加速叠加）`
            + (tips.length ? `。另外：${tips.join("；")}。` : "。") + tail;
        } else if (hasSage) {
          accelStatus.style.color = tips.length ? "#ffd9a8" : "#8ff0c0";
          accelStatus.textContent = `✅ SageAttention int8（社区首选 · 近乎无损 · 2–4×，成片可用）`
            + (tips.length ? `。⚠ ${tips.join("；")}。` : "") + tail;
        } else {
          accelStatus.style.color = tips.length ? "#ffd9a8" : "#8ff0c0";
          accelStatus.textContent = (tips.length ? `⚠ ${tips.join("；")}。` : "✅ 没有开任何加速（绝对画质，最慢；社区成片普遍开 SageAttention 提速 2–4×，近乎无损）") + tail;
        }
      };
      paintAccelStatus();
      const bestBtn = h("button", { class: "btn btn-primary", style: { padding: "4px 10px", fontSize: 11.5 },
        title: "一键回到最佳画质：步数 20（社区成片基线）+ 出片后自动二采 + 关掉内置注意力加速 / 外接 SageAttention / 蒸馏 LoRA",
        onclick: resetToBestQuality }, "🧼 一键最佳画质");
      // 蒸馏 LoRA 池：**必须同时**属于 H3 家族 + 带 turbo/步数标记。
      // ⚠ 旧正则里的裸 `4step|8step` 会把 `krea2_turbo_4step_*`（Krea2 图像模型的 LoRA）
      //    也收进来 —— 选它跑 H3 直接报 "Input and weight inner dimensions must match"。
      const loraPool = ["(无)"].concat((opts.loras || []).filter((n) => !isForeignLora(n) && TURBO_LORA_RE.test(n)));
      const accLoraE = sel(loraPool, P.speed.lora);
      const accLoraWarn = h("div", { class: "muted", style: { gridColumn: "1 / -1", fontSize: "11px", lineHeight: "1.55" } });
      const paintAccLoraWarn = () => {
        const msg = loraUnetConflict(accLoraE.value);
        accLoraWarn.textContent = msg ? "⚠ " + msg : "";
        accLoraWarn.style.color = msg ? "#ffb4b4" : "";
      };
      accLoraE.onchange = () => { P.speed.lora = accLoraE.value; paintAccelStatus(); paintAccLoraWarn(); };
      paintAccLoraWarn();
      const accLoraSE = num(P.speed.loraS, "1", 46, 0.1); accLoraSE.oninput = () => { P.speed.loraS = Number(accLoraSE.value) || 1; paintAccelStatus(); };
      // 官方 Block Sparse Attention 加速（sageattn）
      const SAGE_MODES = [
        ["disabled", "关闭"],
        ["auto", "自动(auto)"],
        ["sageattn_qk_int8_pv_fp16_cuda", "int8_qk/fp16_pv(CUDA)"],
        ["sageattn_qk_int8_pv_fp16_triton", "int8_qk/fp16_pv(Triton)"],
        ["sageattn_qk_int8_pv_fp8_cuda", "int8_qk/fp8_pv(CUDA)"],
        ["sageattn_qk_int8_pv_fp8_cuda++", "int8_qk/fp8_pv(CUDA++)"],
        ["sageattn3", "sageattn3"],
        ["sageattn3_per_block_mean", "sageattn3(per-block-mean)"],
      ];
      const sageE = sel(SAGE_MODES.map((m) => m[0]), P.speed.sage || "disabled");
      sageE.onchange = () => { P.speed.sage = sageE.value; paintAccelStatus(); };
      // 内置注意力加速（直连本节点采样路径，不需要外接节点）
      //   off          = 官方 attention（默认，最稳）
      //   sage         = SageAttention int8（H3 官方「加速版」工作流同款）
      //   block_sparse = 官方 Block-Sparse-Attention（需本地编译；sm_80–sm_100）
      // 后端不可用/抛错 → 自动降级（block_sparse→sage→off），绝不阻断出片。
      const ACCEL_MODES = [
        ["off", "关闭（官方 attention · 绝对画质 · 最慢）"],
        ["sage", "SageAttention int8（社区首选 · 近乎无损 · 2–4×）"],
        ["block_sparse", "官方 Block-Sparse-Attention（低损 · 需本地编译）"],
      ];
      const accelE = sel(ACCEL_MODES.map((m) => m[0]), P.speed.accel || "off");
      const accelNote = h("span", { class: "muted", style: { fontSize: 10.5, opacity: 0.85,
        minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } });
      // 备注和下拉放**同一个 cell**：不再单独占一个网格单元，也不用 gridColumn:"span N"
      //   —— auto-fill 网格里写死 span 会在窄容器下强行撑出列 → 横向溢出被裁切。
      const accelCell = h("div", { style: { display: "flex", alignItems: "center", gap: 5,
        minWidth: 0, flexWrap: "wrap" } }, accelE, accelNote);
      const syncAccelNote = () => {
        const v = P.speed.accel || "off";
        const inf = P.speed.accelInfo;
        if (v === "off") { accelNote.textContent = ""; accelNote.title = ""; return; }
        if (inf && inf[v] && !inf[v].available) {
          accelNote.textContent = "⚠ 本机不可用 → 将自动降级";
          accelNote.title = inf[v].note || "";
        } else if (inf && inf[v] && inf[v].available) {
          accelNote.textContent = "✓ 可用";
          accelNote.title = inf[v].note || "";
        } else { accelNote.textContent = ""; accelNote.title = ""; }
      };
      accelE.onchange = () => {
        P.speed.accel = accelE.value;
        // 选了内置加速就把「外接 BlockSparse 节点」关掉（两条路径叠加会双重改调度）。
        // ⚠ 这里**绝不能调 renderParam()** —— 它会 clear(paramRow) 把当前正在派发
        //   change 事件的这个 <select> 从 DOM 上摘掉并重建整页 → 面板错乱/崩掉。
        //   直接把兄弟控件的值改掉即可，重建 DOM 对一次赋值毫无必要。
        if (accelE.value !== "off" && sageE.value && sageE.value !== "disabled") {
          P.speed.sage = "disabled";
          sageE.value = "disabled";
        }
        syncAccelNote();
        paintAccelStatus();
      };
      syncAccelNote();
      // 探测后端可用性（纯提示；失败静默；api 可能不存在 —— 绝不能拖垮整页渲染）
      try {
        const _fn = ctx.api && ctx.api.attentionAccel;
        if (typeof _fn === "function") {
          _fn.call(ctx.api).then((r) => {
            if (r && r.ok && r.probe) { P.speed.accelInfo = r.probe; syncAccelNote(); }
          }).catch(() => {});
        }
      } catch (_) {}
      const freeCk = h("label", { class: "row", style: { gap: 5, cursor: "pointer", padding: "4px 6px" } },
        h("input", { type: "checkbox", checked: P.speed.free_vram ? "checked" : null, onchange: (e) => { P.speed.free_vram = e.target.checked; }, style: { accentColor: "#ffd166" } }),
        h("span", { style: { fontSize: 11.5, color: "#bcd3ea" }, title: "整条连跑时每 2 镜自动清理显存缓存，防止长时间连续出片显存累积 OOM" }, "段间清理显存（每2镜）"));

      // ---- 外部节点接口：外接「模型节点」/「第三方加速节点」 ----
      // 规则：画布上一旦出现第三方加速节点（SageAttention / TeaCache / torch.compile / Nunchaku…），
      //       本节点的内置加速整体失效（避免双重加速：调度被改两遍 → 画面发灰 / 显存反而爆）。
      //       外部模型加载器节点可以「采用」——把它们已选好的模型文件名填进本节点设置。
      const extLbl = h("span", { class: "muted", style: { fontSize: 11 } });
      const extBox = h("div", { style: { display: "flex", flexDirection: "column", gap: 4, width: "100%" } });
      const forceCk = h("label", { class: "row", style: { gap: 5, cursor: "pointer", padding: "4px 6px" } },
        h("input", { type: "checkbox", checked: P.speed.forceBuiltin ? "checked" : null,
          onchange: (e) => { P.speed.forceBuiltin = e.target.checked; renderExt(P.speed.extInfo); },
          style: { accentColor: "#ffd166" } }),
        h("span", { style: { fontSize: 11.5, color: "#bcd3ea" },
          title: "默认：画布上出现第三方加速节点时，内置加速（BlockSparse / 蒸馏 LoRA）自动失效。勾上则强制保留内置加速（可能与外部加速重复叠加）。" },
          "强制启用内置加速（忽略外部节点）"));
      const renderExt = (info) => {
        clear(extBox);
        if (P.speed.forceBuiltin) {
          extBox.appendChild(h("div", { style: { fontSize: 11, lineHeight: 1.6, color: "#ffd9a8" } },
            "已勾选「强制启用内置加速」→ 内置加速不会被自动关闭（可能与外部加速节点重复叠加；画面发灰/显存异常时取消勾选）。"));
        }
        if (info && info.note) {
          const bad = !!(info.kinds && info.kinds.length);
          extBox.appendChild(h("div", { style: { fontSize: 11, lineHeight: 1.6, color: bad ? "#ffb35c" : "#9fb6d0" } }, info.note));
        }
        const ROLE_CN = { unet: "UNET", clip: "CLIP", vae: "VAE", lora: "LoRA" };
        for (const m of ((info && info.models) || [])) {
          const target = m.role === "unet" ? "unet" : m.role === "clip" ? "clip" : m.role === "lora" ? "lora"
            : (/audio/i.test(m.value || "") ? "avae" : "vvae");
          const risky = m.compatible === false;
          extBox.appendChild(h("div", { class: "row", style: { gap: 6, fontSize: 11.5, color: risky ? "#ffd9a8" : "#cfe0f2" } },
            h("span", { style: { minWidth: 92, color: "#8fb0d6" } }, `${ROLE_CN[m.role] || m.role} #${m.id}`),
            h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              title: m.type + " ｜ " + (m.values || []).join(" / ") + (risky ? "\n⚠ 文件名里没有 minimax/h3 字样，可能不是 H3 用的模型" : "") },
              (risky ? "⚠ " : "") + (m.value || m.type)),
            h("button", { class: "btn", style: { padding: "2px 8px", fontSize: 11 },
              title: "把外部节点已经选好的这个模型文件填进本节点设置",
              onclick: () => {
                if (risky && !confirm(`这个文件名看起来不是 H3/MiniMax 的模型：\n${m.value}\n\n仍然采用？`)) return;
                P.model[target] = m.value;
                ctx.toast(`已采用外部 ${ROLE_CN[m.role] || m.role}：${m.value}`);
                renderParam();
              } }, "采用")));
        }
        for (const a of ((info && info.accels) || [])) {
          extBox.appendChild(h("div", { class: "row", style: { gap: 6, fontSize: 11.5, color: "#ffd9a8" } },
            h("span", { style: { minWidth: 92, color: "#e0b06a" } }, `加速 #${a.id}`),
            h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `${a.type}（${a.kind}）`),
            h("span", { class: "muted", style: { fontSize: 11 } }, "内置加速已让路")));
        }
      };
      const scanBtn = h("button", { class: "btn", style: { padding: "5px 10px" },
        title: "扫描当前画布：外部模型加载器节点 + 第三方加速节点（SageAttention / TeaCache / torch.compile / Nunchaku…）",
        onclick: async () => {
          const g = liveGraph();
          if (!g) { ctx.toast("拿不到当前画布图（app.graph 不可用）", true); return; }
          scanBtn.disabled = true; extLbl.textContent = "扫描中…";
          try {
            const r = await ctx.api.externalNodes(g);
            if (!r || !r.ok) { ctx.toast((r && r.error) || "扫描失败", true); extLbl.textContent = ""; return; }
            P.speed.extInfo = r;
            P.speed.external = r.kinds || [];
            const had = (P.speed.sage && P.speed.sage !== "disabled")
              || (P.speed.lora && P.speed.lora !== "(无)");
            if ((r.kinds || []).length && !P.speed.forceBuiltin) {
              P.speed.sage = "disabled"; P.speed.lora = "(无)";
              ctx.toast(had ? "已外接第三方加速节点 → 内置加速已自动关闭（避免双重加速）"
                            : "已外接第三方加速节点 → 内置加速保持关闭");
            } else if (!(r.kinds || []).length) {
              P.speed.external = [];
            }
            extLbl.textContent = `外部模型 ${(r.models || []).length} · 外部加速 ${(r.accels || []).length}`;
            renderExt(r);
            renderParam();
          } catch (e) {
            extLbl.textContent = ""; ctx.toast("扫描失败: " + e.message, true);
          } finally { scanBtn.disabled = false; }
        } }, "🔗 扫描画布外部节点");
      renderExt(P.speed.extInfo);
      row.append(
        // 加速总览 + 一键回退放最前面：用户抱怨画质时第一眼就能看到并一键关掉
        h("div", { class: "tl-field", style: { gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { class: "tl-flabel", title: "当前生效的加速项。社区分级：SageAttention 近乎无损（成片可开）／block_sparse 低损／蒸馏 LoRA 吃音质（仅预览）" }, "加速状态（画质被吃掉先看这里）"),
          accelStatus,
          h("div", { class: "row", style: { gap: 6, flexWrap: "wrap", alignItems: "center" } },
            bestBtn,
            h("span", { class: "muted", style: { fontSize: 11 } }, "＝ 20 步 + 出片后二采 + 关掉全部加速"))),
        h("div", { class: "tl-field", style: { gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { class: "tl-flabel", title: "外部模型节点 / 第三方加速节点接口：外接后内置加速自动失效" }, "外部节点（模型 / 加速）"),
          h("div", { class: "row", style: { gap: 8, flexWrap: "wrap", alignItems: "center" } }, scanBtn, forceCk, extLbl),
          extBox),
        field("内置注意力加速", accelCell, "attention_accel"),
        field("BlockSparse 加速", sageE, "PathchSageAttentionKJ"),
        field("蒸馏 LoRA", accLoraE, "speed_lora"),
        field("蒸馏 LoRA 强度", accLoraSE, "speed_lora_strength"),
        accLoraWarn,
        freeCk);
    } else if (key === "common") {
      // 公共提示词（对齐官方导演台 common prompt）：
      //   官方 external_groups 在 commonEnabled=true 时对每个分段做
      //   concat_common_segment_prompt(公共提示词, 本镜提示词) = 公共 + 空行 + 本镜
      //   → 写一次，整条时间线所有分镜（含「出片选中」与流水线）逐镜生效。
      const ta = h("textarea", {
        class: "input", rows: 4,
        style: { width: "100%", minHeight: 82, resize: "vertical", lineHeight: 1.5, fontFamily: "inherit", boxSizing: "border-box" },
        placeholder: "例：3D CG 皮克斯卡通渲染，Q 版比例，9:16 竖屏，暖灯笼光；全程无画面字幕。\n"
          + "（这段会拼在每个分镜提示词的最前面 → 全局统一风格/规则，不用每镜重复写）",
      });
      ta.value = (P.common && P.common.text) || "";
      const cnt = h("span", { class: "muted", style: { fontSize: 11 } });
      const paintCnt = () => { cnt.textContent = `${((P.common && P.common.text) || "").length} 字`; };
      ta.oninput = () => { P.common.text = ta.value; paintCnt(); };
      paintCnt();
      const ck = h("input", { type: "checkbox", title: "官方 commonEnabled：关掉则本段只在编辑区留档，不并入分镜" });
      ck.checked = !(P.common && P.common.enabled === false);
      const lbl = h("span", { class: "muted", style: { fontSize: 11 } }, "并入每个分镜（官方 commonEnabled）");
      ck.onchange = () => { P.common.enabled = !!ck.checked; };
      const pvBtn = h("button", {
        class: "btn", style: { padding: "4px 10px", fontSize: 11.5 },
        title: "用当前选中分镜演示「公共提示词 + 本镜」合并后的最终提示词",
        onclick: async () => {
          const shots = ctx.store.get().shots || [];
          const i = (selIdx >= 0 && selIdx < shots.length) ? selIdx : 0;
          const raw = stripVirtualRefs(shot(i).prompt || (shots[i] && shots[i].text) || "");
          pvBtn.disabled = true; pvBtn.textContent = "合并中…";
          try {
            const r = await ctx.api.h3PromptPreview({
              prompt: raw, prefix: stripVirtualRefs(ctx.store.get().prefix || ""),
              seconds: effSec(i), index: (shots[i] && shots[i].index) || i + 1, opts: collectOpts(),
            });
            if (!r.ok) { ctx.toast("预览失败: " + (r.error || ""), true); return; }
            showTextModal(`公共提示词合并预览 · 第 ${(shots[i] && shots[i].index) || i + 1} 镜`, r.prompt || "");
          } catch (e) { ctx.toast("预览失败: " + e.message, true); }
          finally { pvBtn.disabled = false; pvBtn.textContent = "🔍 预览合并效果"; }
        },
      }, "🔍 预览合并效果");
      row.append(h("div", { class: "tl-field", style: { gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 6 } },
        h("div", { class: "row", style: { gap: 8, alignItems: "center", flexWrap: "wrap" } },
          h("div", { class: "tl-flabel", title: "全局 · 每个分镜共用（官方 common prompt）" }, "公共提示词（全局 · 整条时间线共用）"),
          cnt, h("div", { class: "mx-spacer" }), ck, lbl, pvBtn),
        ta,
        h("div", { class: "muted", style: { fontSize: 10.5, lineHeight: 1.55 } },
          "合并规则（官方同款）：公共提示词 + 空行 + 本镜提示词。r2v/i2v/fl2v 由官方 commonEnabled 逐镜生效，"
          + "t2v 由本节点按同一规则拼接；「出片选中」与流水线也会带上它。")));
    }
    return row;
  };

  const TABS = [
    { key: "mode", label: "🎬 模式" },
    { key: "model", label: "🧠 模型" },
    { key: "sample", label: "📐 采样设置" },
    { key: "audio", label: "🎙️ 声音" },
    { key: "common", label: "🌐 公共提示词" },
    { key: "speed", label: "⚡ 加速" },
  ];
  const renderParam = () => {
    clear(tabBar); clear(paramRow);
    TABS.forEach((tb) => {
      const b = h("button", { class: "tl-tab" + (openTab === tb.key ? " on" : ""), onclick: () => { openTab = openTab === tb.key ? null : tb.key; renderParam(); } }, tb.label);
      tabBar.appendChild(b);
    });
    // 「🎬 模式」不依赖后端选项（只用内置 MODES 表），必须永远能开：
    // 否则后端选项一旦慢/失败，用户点「模式」看到空白，就会以为"模式切换没用"。
    if (openTab && (opts || openTab === "mode")) paramRow.appendChild(mkGroup(openTab));
    else if (openTab) paramRow.appendChild(h("div", { class: "tl-paramrow" }, h("span", { class: "muted" }, "模型选项加载中…")));
    // 无展开时放一个超矮提示，维持稳定占位
    if (!openTab) paramRow.appendChild(h("div", { class: "muted", style: { fontSize: 10.5, padding: "1px 2px" } }, "点上方按钮展开对应参数 · 参数整条时间线共用"));
  };

  // ---------- 图片九宫格 ----------
  // 反查「这个 rel 是正文里的第几号标记」：<Picture N> / <Video N> / <Audio N>。
  // 格子上标出编号，用户才能一眼看出"这张就是提示词里写的 2 号参考"，而不是一堆没信息的缩略图。
  const relMarkNo = (text, kind, rel) => {
    if (!rel) return 0;
    try {
      const m = (refsFromText(text).byNum || {})[kind] || {};
      for (const k of Object.keys(m)) { if (m[k] === rel) return Number(k) || 0; }
    } catch (_) { /* 解析失败不影响渲染 */ }
    return 0;
  };
  // 槽位数固定铺满：图片 9 / 视频 3 / 音频 3（与官方参考上限一致，用户明确要看到全部槽位）。
  // ⚠ 早期实现的坑：空格子的点击只挂在"下一个空位"上（if (k === arr.length)），
  //   其余格子既没图标也没响应 = **死格**（用户实报「有些格子没用」）。
  //   现在每一格都可点、都有 ＋，点任意空格都是"再添一个参考"（新加的排在最后）。
  // 为什么不是"点第 7 格就放第 7 号"：官方 presentation 对空槽不占号
  //   （MiniMaxH3ReferenceToVideo 里 for img in ref_images.values() 走插入顺序），
  //   后端会把跳号槽位压成连续序并把标记同步重编号 —— 所以"填哪个格"最终都等价于"排第几"，
  //   按顺序追加才是诚实的做法（见 h3shot.py _compact()/_renumber()）。
  const cellCount = (arr, cap) => cap;
  const markLabel = (kind, n) => (kind === "video" ? "Video" : kind === "audio" ? "Audio" : "Picture");

  const imageGrid = (c, refreshEditor) => {
    const file = h("input", { type: "file", multiple: true, accept: "image/*", style: { display: "none" } });
    const addFiles = async (list) => {
      for (const f of list) {
        if (c.media.image.length >= IMG_CAP) { ctx.toast("图片最多 9 张", true); break; }
        try { await ctx.api.upload(folder(), f); c.media.image.push((folder() ? folder() + "/" : "") + f.name); c.refsCleared = false; } catch (e) { ctx.toast("上传失败: " + e.message, true); }
      }
      file.value = ""; refreshEditor();
    };
    file.onchange = () => addFiles([...file.files]);
    const upBtn = h("button", { class: "btn", style: { padding: "3px 8px", fontSize: 11.5 }, onclick: () => file.click() }, "⬆ 上传");
    const pick = h("select", { class: "select", style: { width: 128, padding: "3px 6px", fontSize: 11.5 } }, h("option", { value: "" }, "素材库选图…"));
    const fillPick = async () => {
      const prev = pick.value; clear(pick);
      pick.appendChild(h("option", { value: "" }, "素材库选图…"));
      let pool = [];
      try { const r = await ctx.api.files(folder(), "image"); pool = (r.files || []).map((f) => (folder() ? folder() + "/" : "") + f.name); } catch (_) {}
      for (const p of pool) pick.appendChild(h("option", { value: p }, p.split("/").pop()));
      if (prev && [...pick.options].some((o) => o.value === prev)) pick.value = prev;
    };
    pick.onfocus = fillPick;
    pick.onchange = () => {
      if (!pick.value) return;
      if (c.media.image.includes(pick.value)) { ctx.toast("该图已在格子中", true); return; }
      if (c.media.image.length >= IMG_CAP) { ctx.toast("图片最多 9 张", true); return; }
      c.media.image.push(pick.value); c.refsCleared = false; refreshEditor();
    };
    const grid = h("div", { class: "mm-grid" });
    const paint = () => {
      clear(grid);
      const txt = String(c.prompt || "");
      const used = c.media.image.filter(Boolean).length;
      const n = cellCount(c.media.image, IMG_CAP);
      for (let k = 0; k < n; k++) {
        const rel = c.media.image[k];
        const markNo = relMarkNo(txt, "image", rel);
        const cell = h("div", { class: "mm-cell", title: rel
          ? `${rel}\n第 ${markNo || k + 1} 号参考图 · 正文里用 <Picture ${markNo || k + 1}> 引用\n（点击替换 · 右上角 ✕ 移除）`
          : `点击上传 / 从素材库选 → 加为第 ${used + 1} 张参考图（正文用 <Picture ${used + 1}> 引用）` });
        if (rel) {
          // 缩略图加载失败（素材被删 / 脏引用）→ 隐藏破图
          cell.appendChild(h("img", { src: relToViewUrl(rel), onerror: "this.style.display='none'" }));
          cell.appendChild(h("span", { class: "mm-idx" }, String(markNo || k + 1)));
          cell.appendChild(h("span", { class: "mm-x", title: "移除", onclick: (ev) => { ev.stopPropagation(); c.media.image.splice(k, 1); if (!c.media.image.length) c.refsCleared = true; paint(); refreshEditor(); } }, "✕"));
          cell.onclick = () => {
            if (!confirm(`替换第 ${k + 1} 格图片？`)) return;
            const swap = h("input", { type: "file", accept: "image/*", style: { display: "none" } });
            swap.onchange = async () => {
              const f = swap.files[0]; if (!f) return;
              try { await ctx.api.upload(folder(), f); c.media.image[k] = (folder() ? folder() + "/" : "") + f.name; paint(); refreshEditor(); } catch (e) { ctx.toast("替换失败: " + e.message, true); }
            };
            document.body.appendChild(swap); swap.click(); swap.remove();
          };
        } else {
          const isNext = k === used;   // 下一格是"直接加"，后面几格是同样的动作（淡一点，但不失活）
          cell.classList.add("mm-empty");
          cell.appendChild(h("span", { class: "mm-plus" + (isNext ? "" : " dim") }, "＋"));
          cell.onclick = () => file.click();
        }
        grid.appendChild(cell);
      }
    };
    paint();
    grid.appendChild(file);   // 隐藏 input 必须进 DOM：游离的 file input 在部分浏览器 click() 无反应
    return h("div", { class: "col", style: { gap: 5 } },
      h("div", { class: "row", style: { gap: 6 } }, h("b", { style: { fontSize: 12 } }, "图片"),
        h("span", { class: "mm-cap" }, `${c.media.image.length}/${IMG_CAP}`), h("div", { class: "mx-spacer" }), pick, upBtn),
      grid);
  };

  // ---------- 首帧 / 尾帧 素材槽（i2v / fl2v / fl2v_tail）----------
  // 对齐旧包（minimax_fl2v 的 .bd-fl2v-slots 两列槽）：切到「首尾帧生视频」时素材区
  // **只有两个框**（首帧 / 尾帧），不再给九宫格 —— 这两个槽就是该模式全部的参考图。
  // 数据仍写进 c.media.image[0] / [1]，与出片 payload 的映射保持一致：
  //   i2v        → first_frame = 槽0
  //   fl2v       → first_frame = 槽0，last_frame = 槽1
  //   fl2v_tail  → last_frame  = 槽0
  const framesPane = (c, refreshEditor) => {
    const mode = P.mode;
    const specs = mode === "i2v"
      ? [{ slot: 0, tag: "首帧", hint: "必填 · 视频从这张开始", color: "#4fff8f" }]
      : mode === "fl2v_tail"
        ? [{ slot: 0, tag: "尾帧", hint: "必填 · 视频结束在这张", color: "#f0a030" }]
        : [{ slot: 0, tag: "首帧", hint: "必填 · 视频从这张开始", color: "#4fff8f" },
           { slot: 1, tag: "尾帧", hint: "可选 · 留空则只锁首帧", color: "#f0a030" }];
    const slots = specs.map((s) => s.slot);
    const firstEmpty = () => { const k = slots.find((n) => !c.media.image[n]); return k == null ? slots[slots.length - 1] : k; };

    const file = h("input", { type: "file", accept: "image/*", style: { display: "none" } });
    let upSlot = 0;
    file.onchange = async () => {
      const f = file.files && file.files[0]; file.value = "";
      if (!f) return;
      try {
        await ctx.api.upload(folder(), f);
        c.media.image[upSlot] = (folder() ? folder() + "/" : "") + f.name;
        c.refsCleared = false;
        paint(); refreshEditor();
      } catch (e) { ctx.toast("上传失败: " + e.message, true); }
    };
    // 素材库选图：先填第一个空槽，都满了就替换最后一个槽（尾帧优先被替换）
    const pick = h("select", { class: "select", style: { width: 150, padding: "3px 6px", fontSize: 11.5 } },
      h("option", { value: "" }, "从素材库选图…"));
    const fillPick = async () => {
      const prev = pick.value; clear(pick);
      pick.appendChild(h("option", { value: "" }, "从素材库选图…"));
      let pool = [];
      try { const r = await ctx.api.files(folder(), "image"); pool = (r.files || []).map((f) => (folder() ? folder() + "/" : "") + f.name); } catch (_) {}
      for (const p of pool) pick.appendChild(h("option", { value: p }, p.split("/").pop()));
      if (prev && [...pick.options].some((o) => o.value === prev)) pick.value = prev;
    };
    pick.onfocus = fillPick;
    pick.onchange = () => {
      const rel = pick.value; if (!rel) return;
      pick.value = "";
      c.media.image[firstEmpty()] = rel;
      c.refsCleared = false;
      paint(); refreshEditor();
    };
    const upBtn = h("button", {
      class: "btn", style: { padding: "3px 8px", fontSize: 11.5 },
      title: "上传本地图片（首帧优先填空槽）",
      onclick: () => { upSlot = firstEmpty(); file.click(); },
    }, "⬆ 上传");
    const grid = h("div", { class: "mm-frames" + (specs.length === 1 ? " one" : "") });
    const ar = `${P.output.width || 720} / ${P.output.height || 1280}`;
    function paint() {
      clear(grid);
      for (const sp of specs) {
        const rel = c.media.image[sp.slot];
        const box = h("div", {
          class: "mm-frame" + (rel ? " has-img" : ""),
          style: { aspectRatio: ar },
          title: rel ? `${rel}\n（点击替换 · 右上角 × 移除）` : `${sp.tag}：点击上传 / 从素材库选`,
        });
        if (rel) {
          // 缩略图加载失败（源文件被删）→ 隐藏破图，不留裂图占位
          box.appendChild(h("img", { src: relToViewUrl(rel), onerror: "this.style.display='none'" }));
          box.appendChild(h("span", { class: "tag", style: { background: sp.color } }, sp.tag));
          box.appendChild(h("button", {
            class: "x", title: "移除（清空这一格）",
            onclick: (ev) => { ev.stopPropagation(); c.media.image[sp.slot] = ""; c.refsCleared = true; paint(); refreshEditor(); },
          }, "×"));
          box.onclick = () => { if (!confirm(`替换「${sp.tag}」？`)) return; upSlot = sp.slot; file.click(); };
        } else {
          box.appendChild(h("div", { class: "ph" }, `＋ ${sp.tag}`));
          box.appendChild(h("div", { class: "ph2" }, sp.hint));
          box.onclick = () => { upSlot = sp.slot; file.click(); };
        }
        grid.appendChild(box);
      }
    }
    paint();
    grid.appendChild(file);   // 同上：隐藏 input 必须进 DOM
    const filled = specs.filter((s) => c.media.image[s.slot]).length;
    return h("div", { class: "col", style: { gap: 5 } },
      h("div", { class: "row", style: { gap: 6 } },
        h("b", { style: { fontSize: 12 } }, specs.length === 2 ? "首帧 / 尾帧" : specs[0].tag),
        h("span", { class: "mm-cap" }, `${filled}/${specs.length}`),
        h("div", { class: "mx-spacer" }), pick, upBtn),
      grid,
      h("div", { class: "muted", style: { fontSize: 10.5, lineHeight: 1.5 } },
        mode === "fl2v"
          ? "两侧框就是本模式全部参考图：首帧必填；只填尾帧会自动按「尾帧生视频」出，只填首帧按「首帧生视频」出。"
          : mode === "i2v" ? "本模式只用首帧（尾帧/参考图不参与）。" : "本模式只用尾帧（首帧/参考图不参与）。"));
  };

  // ---------- 视频/音频 3 格小格子 ----------
  // 约定（与剪辑面板一致）：视频传到 <folder>/video、音频传到 <folder>/audio ——
  // 后端 _list_files 会收录这两个子目录，所以上传后**立刻能被素材库看到、被
  // `<Video N>` / `<Audio N>` 引用**（以前视频传子目录但列表页不扫子目录 → 出了片却引用不上）。
  // 预览：视频用 ffmpeg 抽首帧（失败退回 <video> 取帧），音频点开直接在灯箱里试听。
  const subSlot = (c, slot, refreshEditor) => {
    const grid = h("div", { class: "mm-grid" });
    const up = h("input", { type: "file", multiple: true, accept: slot.accept, style: { display: "none" } });
    const isV = slot.kind === "video";
    const subDir = isV ? "video" : "audio";     // 与剪辑面板/后端 _list_files 的子目录约定一致
    const targetDir = () => [folder(), subDir].filter(Boolean).join("/");
    up.onchange = async () => {
      let added = 0;
      for (const f of up.files) {
        if (c.media[slot.kind].length >= slot.cap) { ctx.toast(`${slot.label}最多 ${slot.cap} 个`, true); break; }
        const target = targetDir();
        try {
          await ctx.api.upload(target, f);
          c.media[slot.kind].push((target ? target + "/" : "") + f.name);
          added++;
        } catch (e) { ctx.toast("上传失败: " + e.message, true); }
      }
      up.value = "";
      // 上传后刷新全局资产注册表：新文件立刻进素材库、能按 <Video N>/<Audio N> 被引用
      if (added) { try { await assetRegistry.refresh(folder()); } catch (_) {} }
      paint(); refreshEditor();
      if (added) ctx.toast(`已上传 ${added} 个${slot.label}素材（可直接用 <${isV ? "Video" : "Audio"} N> 引用）`);
    };
    // 从素材库选（同一 kind 的现有素材），不用先重新上传
    const pick = h("select", { class: "select", style: { width: 128, padding: "2px 5px", fontSize: 11 } },
      h("option", { value: "" }, "素材库选…"));
    const fillPick = () => {
      const prev = pick.value;
      clear(pick);
      pick.appendChild(h("option", { value: "" }, "素材库选…"));
      const pool = (assetRegistry.files || []).filter((f) => f && f.kind === slot.kind && f.rel);
      for (const f of pool) {
        pick.appendChild(h("option", { value: String(f.index) }, `<${isV ? "Video" : "Audio"} ${f.index}> ${f.name}`));
      }
      if (prev && [...pick.options].some((o) => o.value === prev)) pick.value = prev;
    };
    pick.onfocus = fillPick;
    pick.onchange = async () => {
      fillPick();
      const idx = Number(pick.value);
      pick.value = "";
      if (!idx) return;
      const f = (assetRegistry.files || []).find((x) => x && x.kind === slot.kind && Number(x.index) === idx);
      if (!f || !f.rel) { ctx.toast("素材库里找不到这一项", true); return; }
      const arr = c.media[slot.kind];
      if (arr.includes(f.rel)) { ctx.toast("已经在格子里了", true); return; }
      if (arr.length >= slot.cap) { ctx.toast(`${slot.label}最多 ${slot.cap} 个`, true); return; }
      arr.push(f.rel);
      paint(); refreshEditor();
    };
    const paint = () => {
      clear(grid);
      const arr = c.media[slot.kind];
      const txt = String(c.prompt || "");
      const used = arr.filter(Boolean).length;
      const n = cellCount(arr, slot.cap);
      for (let k = 0; k < n; k++) {
        const rel = arr[k];
        const markNo = relMarkNo(txt, slot.kind, rel);
        const no = markNo || k + 1;
        const cell = h("div", { class: "mm-cell" + (rel && isV ? " has-video" : ""), title: rel
          ? `${rel}\n第 ${no} 号 · 正文里用 <${markLabel(slot.kind)} ${no}> 引用\n（点击预览${isV ? "播放" : "试听"} · 右上角 ✕ 移除）`
          : `点击上传 / 从素材库选 → 加为第 ${used + 1} 个${slot.label}素材（正文用 <${markLabel(slot.kind)} ${used + 1}> 引用）` });
        if (rel) {
          const url = relToViewUrl(rel);
          const thumb = isV ? videoThumb(rel, url) : audioThumb();
          thumb.style.width = "100%"; thumb.style.height = "100%";
          cell.appendChild(thumb);
          // 编号徽章：以前视频/音频格没有任何编号，用户看不出它对应 <Audio N>/<Video N> 几号
          cell.appendChild(h("span", { class: "mm-idx" }, String(no)));
          cell.onclick = (ev) => {
            if (ev.target && ev.target.closest && ev.target.closest(".mm-x")) return;
            if (url) lightbox(url, slot.kind);
          };
          cell.appendChild(h("span", { class: "mm-x", title: "移除", onclick: (ev) => { ev.stopPropagation(); arr.splice(k, 1); paint(); refreshEditor(); } }, "✕"));
        } else {
          const isNext = k === used;
          cell.classList.add("mm-empty");
          cell.appendChild(h("span", { class: "mm-plus" + (isNext ? "" : " dim") }, "＋"));
          cell.onclick = () => up.click();
        }
        grid.appendChild(cell);
      }
    };
    paint();
    grid.appendChild(up);   // 同上：隐藏 input 必须进 DOM
    return h("div", { class: "col", style: { gap: 3 } },
      h("div", { class: "row", style: { gap: 5 } },
        h("b", { style: { fontSize: 11.5 } }, slot.label),
        h("span", { class: "muted", style: { fontSize: 11 } }, `${c.media[slot.kind].length}/${slot.cap}`),
        h("div", { class: "mx-spacer" }),
        pick,
        h("button", { class: "btn", style: { padding: "2px 7px", fontSize: 11 }, onclick: () => up.click() }, "上传")),
      grid);
  };

  // ---------- 编辑器（九宫格 + 提示词等高） ----------
  const editorFor = (i, sh) => {
    const c = shot(i);
    const refreshEditor = () => renderEditor();
    const mention = createMentionEditor(ctx, {
      initial: c.prompt, favorites: favs, getAssets: () => assets, chosen: c.chosen,
      onCommit: (t) => { c.prompt = t; sh.text = t; sh.prompt = t; },
      onChoose: (nm, rel) => { const f = favs.find((x) => x.name === nm && x.rel === rel); if (f && f.kind === "image" && !c.media.image.includes(rel) && c.media.image.length < IMG_CAP) { c.media.image.push(rel); setTimeout(() => renderEditor(), 60); } },
    });
    // t2v（文生视频）是纯文字模式：没有首帧/尾帧/参考图，也不吃音视素材 → 不渲染素材栏，
    // 让提示词输入框占满整行（避免留一排空九宫格误导用户去"加图"）。
    const isT2V = P.mode === "t2v";
    // 首帧/尾帧一族（i2v / fl2v / fl2v_tail）：素材区**只有首帧+尾帧两个框**（对齐旧包），
    // 不给九宫格、也不给视频/音频小格 —— 这些素材本模式一概不用，留着只会让人以为"还能加"。
    const isFrames = P.mode === "i2v" || P.mode === "fl2v" || P.mode === "fl2v_tail";
    const mediaPane = isT2V ? null : h("div", { class: "mm-media" },
      isFrames ? framesPane(c, refreshEditor) : imageGrid(c, refreshEditor),
      isFrames ? null : h("div", { class: "mm-vasub" },
        h("div", { style: { flex: "0 0 auto" } }, subSlot(c, { kind: "video", label: "视频", cap: 3, accept: "video/*" }, refreshEditor)),
        h("div", { style: { flex: "0 0 auto" } }, subSlot(c, { kind: "audio", label: "音频", cap: 3, accept: "audio/*" }, refreshEditor))));
    const promptPane = h("div", { class: "mm-prompt" },
      h("div", { class: "row", style: { gap: 6 } }, h("b", { style: { fontSize: 12 } }, "提示词"),
        h("span", { class: "muted", style: { fontSize: 10.5 } }, isT2V
          ? "（文生视频模式：无素材输入，只写提示词；切到 I2V / FL2V / R2V 才需要素材图）"
          : isFrames
            ? `（${modeLabel(P.mode)}：素材只看左边${P.mode === "fl2v" ? "首/尾帧两格" : "那一个框"}）`
            : "（@收藏名 高亮为素材标记）")),
      mention);
    // ---------- 实时预览框：固定正方形，定死在提示词文本区右侧，永远存在、尺寸恒定 ----------
    // 生成中 → 采样预览图；出片后 → 视频（播放/暂停 + manual 二采）；空闲 → 占位文字。
    // 关键：框体不随"有没有预览"插入/移除（旧实现会突然多出 210px 一列 → 整行重排 = 界面错乱）。
    const manualUpBtn = h("button", {
      class: "btn", style: { padding: "3px 6px", fontSize: 11, marginTop: 2 },
      title: "视频已确定，点击二采高清放大（" + (P.output.upscale_engine || "rtx") + "）",
      onclick: async () => {
        const cur = shotPreview.idx === i ? shotPreview.rel : null;
        if (!cur) return;
        manualUpBtn.disabled = true; manualUpBtn.textContent = "二采中…";
        await doUpscale(i, cur);
        manualUpBtn.disabled = false; manualUpBtn.textContent = "✨ 二采高清放大";
        renderEditor();
      },
    }, "✨ 二采高清放大");
    // 出片后视频预览：默认暂停，点按钮播放/暂停（不再自动循环播放）
    const buildVideoWrap = (rel) => {
      const vidUrl = relToViewUrl(rel);
      const v = h("video", { src: vidUrl, muted: true, playsinline: true, preload: "metadata", loop: false, controls: false });
      const tg = h("button", { class: "mm-playbtn", title: "播放 / 暂停", onclick: () => {
        if (v.paused) v.play().catch((e) => { console.error("[MRBoardNext] preview play", e); ctx.toast("视频播放失败: " + (e.message || ""), true); });
        else v.pause();
      } }, "▶");
      v.onplay = () => { tg.textContent = "⏸"; };
      v.onpause = () => { tg.textContent = "▶"; };
      v.onended = () => { tg.textContent = "▶"; };
      const wrap = h("div", { class: "mm-pv-vwrap" }, v, tg);
      v.onerror = () => {
        console.error("[MRBoardNext] preview video error", vidUrl);
        tg.style.display = "none";
        wrap.appendChild(h("div", { class: "muted", style: { fontSize: 11, textAlign: "center", padding: 8, color: "#ffb4b4" } }, "视频加载失败"));
      };
      return wrap;
    };
    const pvTitle = h("div", { class: "mm-pv-title" }, "实时预览");
    const pvBody = h("div", { class: "mm-pv-body" });
    const pvFoot = h("div", { class: "mm-pv-foot" });
    const previewBox = h("div", { class: "mm-preview" }, pvTitle, pvBody, pvFoot);
    // 就地重绘预览内容：只换 pvBody/pvFoot 子节点，不碰提示词编辑器（不丢焦点、不跳版）
    const paintPreview = () => {
      const live = livePreviewUrl;
      const rel = shotPreview.idx === i ? shotPreview.rel : null;
      pvTitle.textContent = live ? "生成中…（采样预览）" : rel ? "出片预览" : "实时预览";
      pvTitle.style.color = live ? "#7ee2a0" : rel ? "#7ee2a0" : "";
      clear(pvBody); clear(pvFoot);
      if (live) {
        pvBody.appendChild(h("img", { class: "mm-pv-img", src: live, alt: "生成预览" }));
      } else if (rel) {
        pvBody.appendChild(buildVideoWrap(rel));
        if (P.output.upscale_mode === "manual") pvFoot.appendChild(manualUpBtn);
      } else {
        pvBody.appendChild(h("div", { class: "mm-pv-empty" }, "（等待生成）"));
      }
    };
    previewPainter = paintPreview;
    paintPreview();
    // 本镜秒（留空=跟随全局）；全局时长开关开启时禁用（统一用全局秒）
    const secI = h("input", { class: "input", type: "number", min: 0.5, step: 0.5, value: c.sec || "", placeholder: String(P.output.sec), style: { width: 54, padding: "2px 6px", fontSize: 11 } });
    secI.oninput = () => { const v = Number(secI.value); c.sec = (!secI.value || isNaN(v) || v <= 0) ? undefined : v; renderTrack(); };
    if (P.output.global_sec) { secI.disabled = true; secI.style.opacity = ".5"; secI.title = "已开启「统一全局时长」，单镜时长暂不生效（关闭开关后可单独设置）"; }
    const secCtl = h("span", { class: "row", style: { gap: 3 } }, h("span", { class: "muted", style: { fontSize: 11 } }, "秒"), secI);
    // 全局时长开关：开启 = 所有分镜统一用「默认秒/镜」；关闭 = 各镜可单独设时长
    const globalSecBtn = h("button", {
      class: "btn", style: { padding: "3px 9px", fontSize: 11 },
      title: "开关：开启后所有分镜统一用全局秒数（单镜时长设置暂不生效）；关闭后各镜可单独设时长",
      onclick: () => {
        P.output.global_sec = !P.output.global_sec;
        ctx.toast(P.output.global_sec ? `已开启统一全局时长：全部 ${P.output.sec}s` : "已关闭：各镜可单独设时长");
        renderAll();
      },
    }, P.output.global_sec ? `🔒 统一 ${P.output.sec}s` : `全局 ${P.output.sec}s`);
    // 衔接下一镜（上下文引导）
    const contCtl = h("label", { class: "row", style: { gap: 3, cursor: "pointer" } },
      h("input", { type: "checkbox", checked: c.linkNext ? "checked" : null, style: { accentColor: "#ffd166" } }),
      h("span", { style: { fontSize: 11, color: "#ffcf6b" } }, "衔接下镜"));
    contCtl.querySelector("input").onchange = (e) => { c.linkNext = e.target.checked; renderTrack(); };
  // 撑满时间线面板剩余高度：编辑区（素材宫格 + 提示词 + 预览）随面板变高而变高，
  // 消除面板下方大片空白；面板变矮时整块由 editorHost 内部滚动。
  return h("div", { class: "col", style: { gap: 6, borderTop: "1px solid #1d2b44", paddingTop: 6,
    flex: "1 1 auto", minHeight: 0 } },
    h("div", { class: "row" },
      h("b", { style: { fontSize: 12.5 } }, `第${sh.index}镜`),
      h("span", { class: "muted", style: { fontSize: 11 } }, `${modeLabel(P.mode)}`),
      // 纯文字模式却挂着图 → 明确告诉用户"这些图不会被用"，避免误会成"还在拿以前的参考图跑"
      (P.mode === "t2v" && (c.media.image || []).length)
        ? h("span", {
            style: { fontSize: 11, color: "#ffcf6b", border: "1px solid rgba(255,207,107,.45)",
                     borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" },
            title: "文生视频是纯文字模式：下面这 N 张素材不会参与生成（切到 i2v / fl2v / r2v 才会用到）",
          }, `⚠ 本模式不使用素材（已挂 ${c.media.image.length} 张，将被忽略）`)
        : null,
      secCtl,
      globalSecBtn,
      contCtl,
      h("div", { class: "mx-spacer" }),
      runBtnFor(i),
        h("button", { class: "btn", style: { padding: "5px 10px" }, title: "复制本镜（素材参数 + 提示词）为一个新分镜", onclick: () => duplicateShot(i) }, "⧉ 复制"),
        h("button", { class: "btn", style: { padding: "5px 10px" }, onclick: () => { delete shotsCfg[i]; renderAll(); } }, "重置"),
        h("button", { class: "btn", style: { padding: "5px 10px" }, onclick: () => removeShot(i) }, "删除")),
      // 编辑器三栏：素材九宫格（t2v 无） + 提示词 + 实时预览框（定死正方形，恒定占位不跳版）
      h("div", { class: "mm-split" }, mediaPane, promptPane, previewBox));
  };

  // ---------- 出片 ----------
  const collectOpts = () => {
    const o = {
      unet_name: P.model.unet || undefined, clip_name: P.model.clip || undefined,
      video_vae_name: P.model.vvae || undefined, audio_vae_name: P.model.avae || undefined,
      lora_name: P.model.lora && P.model.lora !== "(无)" ? P.model.lora : undefined,
      lora_strength: P.model.loraS, width: P.output.width, height: P.output.height,
      megapixels: P.output.megapixels || undefined,   // H3 官方百万像素（0.1–2）→ 后端换算并写进 timeline_data
      // 官方 timeline_data.output 的导出/音频/连续性开关（以前没传 → 改了也不生效）
      export_mode: P.output.exportMode === "segments" ? "segments" : "all",
      audio_mode: (P.audio && P.audio.no_speech) ? "mute" : "generate",
      // ⚠ 布尔开关必须**始终下发 true/false**：以前只在 true 时下发，false 会被
      //   `delete undefined` 删掉 → 官方读到模板默认值（clear_vram 模板=true）→ 取消勾选无效。
      continuity: !!(P.output && P.output.continuity),
      continuity_overlap: Number(P.output.continuity_overlap) || 22,
      ref_max_size: P.output.ref_size, frame_rate: P.output.fps, steps: P.output.steps,
      ref_image_size: P.output.ref_image_size || "match",
      cfg: P.output.cfg, shift_video: P.output.shift_video, shift_audio: P.output.shift_audio,
      sampler: P.output.sampler || undefined, scheduler: P.output.scheduler || undefined,
      clear_vram_between_segments: !!P.output.clear_vram,
      export_source_images: !!P.output.export_src,
      refine_mode: P.output.upscale_mode === "latent" ? "latent_upscale" : undefined,
      refine_megapixels: P.output.refine_megapixels,
      refine_passes: P.output.refine_passes,
      refine_latent_model: "minimax_h3_latent_upscaler_3d_bf16.safetensors",
      speed_lora: P.speed.lora && P.speed.lora !== "(无)" ? P.speed.lora : undefined,
      speed_lora_strength: P.speed.loraS,
      sage_attention: P.speed.sage !== "disabled" ? P.speed.sage : undefined,
      // 内置注意力加速（off / sage / block_sparse）—— 直接进本节点采样路径，不需要外接节点
      attention_accel: (P.speed.accel && P.speed.accel !== "off") ? P.speed.accel : "off",
      // 外部节点接口：非空 = 画布上外接了第三方加速 → 后端让内置加速失效（双保险）
      external_accel: (P.speed.external && P.speed.external.length) ? P.speed.external : undefined,
      force_builtin_accel: P.speed.forceBuiltin ? true : undefined,
      // —— 公共提示词（官方 common prompt）——
      // 放进 opts：导演台单镜/出片选中/干跑 都会自动带上；流水线另有同源读取
      common_prompt: (P.common && P.common.text) ? P.common.text : undefined,
      common_enabled: (P.common && P.common.enabled !== false) ? true : undefined,
      // —— 声音 / 台词（H3 官方三段式）——
      av_structure: P.audio && P.audio.structure === false ? false : true,
      av_lang: (P.audio && P.audio.lang) || "Chinese",
      av_ambience: (P.audio && P.audio.ambience) || undefined,
      av_music: (P.audio && P.audio.music) || undefined,
      av_no_speech: P.audio && P.audio.no_speech ? true : undefined,
      video_audio_ref: P.audio && P.audio.video_audio_ref ? true : undefined,
      audio_guard: P.audio && P.audio.guard === false ? false : true,
      audio_min_steps: (P.audio && P.audio.min_steps) || undefined,
    };
    Object.keys(o).forEach((k) => { if (o[k] === undefined || o[k] === "" || o[k] === null) delete o[k]; });
    return o;
  };
  // 二采输出目录（会话级记忆）：整条连跑自动二采时不必每镜弹一次文件夹选择，本次会话选定后沿用
  let _upOutDir = "";
  // 二采高清放大（自动/手动共用）：对 rel 视频用当前引擎超分，更新 shotPreview
  const doUpscale = async (i, rel) => {
    const eng = P.output.upscale_engine || "rtx";
    // 放大倍率（用户可自定义）：RTX/Flash/VOSR2 直接吃倍数；SeedVR2 由后端按"源短边×倍率"换算目标短边
    const sc = Math.max(1, Math.min(4, Number(P.output.upscale_scale) || 2));
    // ⚠ 所有引擎都要带 scale：flash（TE-FlashVSR）以前漏传 → 后端固定 2×，工具栏倍率对它无效
    const opts = eng === "rtx" ? { scale: sc, quality: "HIGH" } : { scale: sc };
    // 弹文件夹选择：二采视频保存到选定文件夹（本次会话记住，之后每镜自动沿用；弹不出则输出到视频同目录）
    let outDir = _upOutDir;
    if (!outDir) {
      try {
        const pick = await ctx.api.nativePick({ kind: "folder", title: "选择二采视频保存文件夹（本次会话内记住，后续不再询问）" });
        if (pick.cancel || !(pick.paths || []).length) { println("✗ 已取消二采", "#ffd98f"); return null; }
        outDir = _upOutDir = pick.paths[0];
      } catch (_) { /* 弹不出则输出到视频同目录 */ }
    }
    println(`✨ 二采（${eng} · ${sc}×）…`, "#7fd0ff");
    try {
      const r = await ctx.api.h3Upscale(rel, eng, outDir ? { ...opts, out_dir: outDir } : opts);
      if (!r.ok) { println(`✗ 二采失败: ${r.error}`, "#ffb4b4"); ctx.toast("二采失败: " + (r.error || ""), true); return null; }
      if (r.rel) { shotPreview = { idx: i, rel: r.rel }; println(`✓ 二采完成 → ${r.rel}${outDir ? "（" + outDir + "）" : ""}`, "#8ff0c0"); return r.rel; }
      return await new Promise((resolve) => {
        const timer = setInterval(async () => {
          let st; try { st = await ctx.api.h3UpscaleStatus(r.task_id); } catch (_) { return; }
          if (st.status === "done") { clearInterval(timer); shotPreview = { idx: i, rel: st.rel }; println(`✓ 二采完成 → ${st.rel || st.path}`, "#8ff0c0"); resolve(st.rel); }
          else if (st.status === "error") { clearInterval(timer); println(`✗ 二采失败: ${st.error}`, "#ffb4b4"); ctx.toast("二采失败: " + (st.error || ""), true); resolve(null); }
        }, 3000);
      });
    } catch (e) { println(`✗ 二采失败: ${e.message}`, "#ffb4b4"); ctx.toast("二采失败: " + e.message, true); return null; }
  };
  // 引擎选择弹窗（用于「选引擎超分」）：返回 Promise<engine|null>，全内联样式
  const pickEngine = () => new Promise((resolve) => {
    const dlg = document.createElement("div");
    dlg.style.cssText = "position:fixed;inset:0;z-index:2147483001;background:rgba(2,4,9,.78);display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:linear-gradient(180deg,#1a2238,#141b30);border:1px solid #2d3a55;border-radius:14px;padding:20px 22px;display:flex;flex-direction:column;gap:10px;min-width:300px;box-shadow:0 16px 50px rgba(0,0,0,.6);";
    const title = document.createElement("div");
    title.textContent = "选择超分引擎";
    title.style.cssText = "color:#9fd0ff;font-size:13.5px;font-weight:700;margin-bottom:4px;";
    box.appendChild(title);
    const engines = [
      ["rtx", "RTX VSR（NVIDIA GPU 加速 · 速度快）", "#6ee7a0"],
      ["flash", "TE-FlashVSR（扩散超分 · 画质最佳 · 较慢）", "#ffb35c"],
      ["seedvr2", "SeedVR2（修复型超分 · 适合大分辨率）", "#a78bfa"],
      ["vosr2", "VOSR2（H3 二采平替 · 更快更省 · 首跑自动下模型）", "#5eead4"],
    ];
    engines.forEach(([v, lbl, accent]) => {
      const b = document.createElement("button");
      b.textContent = lbl;
      b.style.cssText = `padding:9px 12px;border-radius:7px;border:1px solid #3a4a66;background:rgba(255,255,255,.05);color:#fff;font-size:12.5px;cursor:pointer;text-align:left;transition:all .12s;`;
      b.onmouseenter = () => { b.style.background = `${accent}22`; b.style.borderColor = accent; };
      b.onmouseleave = () => { b.style.background = "rgba(255,255,255,.05)"; b.style.borderColor = "#3a4a66"; };
      b.onclick = () => { document.body.removeChild(dlg); resolve(v); };
      box.appendChild(b);
    });
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.style.cssText = "padding:6px 10px;border-radius:6px;border:1px solid #444;background:transparent;color:#9aa6bd;font-size:11.5px;cursor:pointer;margin-top:4px;";
    cancel.onclick = () => { document.body.removeChild(dlg); resolve(null); };
    box.appendChild(cancel);
    dlg.appendChild(box);
    dlg.onclick = (e) => { if (e.target === dlg) { document.body.removeChild(dlg); resolve(null); } };
    document.body.appendChild(dlg);
  });
  // 选引擎超分：弹引擎选择 → 用所选引擎二采（不修改全局默认）
  const pickEngineThenUpscale = async (i, rel) => {
    const eng = await pickEngine();
    if (!eng) { println("✗ 已取消超分", "#ffd98f"); return; }
    const savedEng = P.output.upscale_engine;
    P.output.upscale_engine = eng;
    try {
      const r = await doUpscale(i, rel);
      if (r) { shotPreview = { idx: i, rel: r }; renderAll(); }
    } finally {
      P.output.upscale_engine = savedEng;
    }
  };
  // 发送到剪辑页面：写 pendingEditorVideo → 切到剪辑面板 → 剪辑面板 refreshMaterials 自动加到 V1
  const sendToEditor = (rel) => {
    ctx.store.set({ pendingEditorVideo: rel });
    ctx.switchTo("editor");
    ctx.toast("已发送到剪辑页面 V1 轨");
  };
  // 幽灵素材剔除：素材被清理（删文件 / 清空素材库）后，九宫格与 refMap 里可能还留着
  // 已不存在的 rel。不剔除的话这些旧参考图会继续参与构图，污染其它模式的适配生成。
  const dropGhosts = async (rels, i) => {
    if (!rels || !rels.length) return [];
    try {
      const r = await ctx.api.mediaExists(rels);
      const miss = (r && r.missing) || [];
      if (!miss.length) return rels;
      const c = shot(i);
      c.media.image = (c.media.image || []).filter((x) => !miss.includes(x));
      const rm = ctx.store.get().refMap || [];
      if (Array.isArray(rm[i])) rm[i] = rm[i].filter((m) => !miss.includes(m.rel));
      println(`⚠ 已剔除 ${miss.length} 个失效素材（源文件已不存在）：${miss.slice(0, 3).join(" · ")}${miss.length > 3 ? " …" : ""}`, "#ffd98f");
      renderEditor();
      return rels.filter((x) => !miss.includes(x));
    } catch (_) { return rels; }
  };
  // 首帧/尾帧模式的幽灵剔除：只把失效槽"置空"，绝不压缩数组 ——
  // 压缩会让"只填尾帧"顶到第 1 格，被当成首帧用（mode/payload 语义就串了）。
  const dropGhostsFrames = async (frames, i) => {
    const list = (frames || []).filter(Boolean);
    if (!list.length) return frames;
    try {
      const r = await ctx.api.mediaExists(list);
      const miss = (r && r.missing) || [];
      if (!miss.length) return frames;
      const missSet = new Set(miss);
      const c = shot(i);
      const imgs = c.media.image || [];
      for (let k = 0; k < imgs.length; k++) if (imgs[k] && missSet.has(imgs[k])) imgs[k] = "";
      const rm = ctx.store.get().refMap || [];
      if (Array.isArray(rm[i])) rm[i] = rm[i].filter((m) => !missSet.has(m.rel));
      println(`⚠ 已剔除 ${miss.length} 个失效素材（源文件已不存在）：${miss.slice(0, 3).join(" · ")}${miss.length > 3 ? " …" : ""}`, "#ffd98f");
      renderEditor();
      return frames.map((x) => (x && missSet.has(x) ? "" : x));
    } catch (_) { return frames; }
  };
  const runOne = async (i) => {
    // 注意：这里不再判断 busy，busy 由调用方（单镜 / 整条 / 选中）管理，
    // 避免「整条连跑」先 set busy=true 再调 runOne 导致每镜都误判为冲突。
    const shots = ctx.store.get().shots || [];
    const sh = shots[i];
    const c = shot(i);
    // 素材：优先九宫格手动图；为空则回退到「分镜面板」匹配命中的资产图（保证视频与资产图一致）
    // t2v 纯文字模式：完全不取图（连分镜匹配缓存也不回退），保证构图里没有任何图片输入。
    const isFramesMode = P.mode === "i2v" || P.mode === "fl2v" || P.mode === "fl2v_tail";
    let imgs = P.mode === "t2v" ? [] : c.media.image.slice();
    // 只有"从未手动清理过"才回退到分镜匹配缓存；用户在九宫格清空过（refsCleared）
    // 就说明不想再用这批参考图，切到其它模式时不能再被旧缓存图带回来。
    if (!imgs.length && !c.refsCleared && P.mode !== "t2v") {
      const refMap = ctx.store.get().refMap || [];
      imgs = ((refMap[i] || []).filter((m) => m.rel && m.kind === "image")).map((m) => m.rel);
    }
    // 脏 rel 过滤：虚拟引用 token（@image#1:xxx.png）不是真实文件，绝不能进 payload
    imgs = imgs.filter((x) => isUsableRel(x));
    if (imgs.length) imgs = await dropGhosts(imgs, i);
    // 首帧/尾帧模式：槽位语义必须**保序**（槽0=首帧、槽1=尾帧），不能像九宫格那样压缩。
    // 否则"只填尾帧"会被挤到第 1 格当成首帧，i2v/fl2v/fl2v_tail 三种模式全串。
    let frames = null;
    if (isFramesMode) {
      const raw = (c.media.image || []).slice(0, 2);
      frames = [isUsableRel(raw[0]) ? raw[0] : "", isUsableRel(raw[1]) ? raw[1] : ""];
      if (!frames[0] && !frames[1] && !c.refsCleared) {
        const refMap = ctx.store.get().refMap || [];
        const fb = ((refMap[i] || []).filter((m) => m.rel && m.kind === "image")).map((m) => m.rel);
        frames = [isUsableRel(fb[0]) ? fb[0] : "", isUsableRel(fb[1]) ? fb[1] : ""];
      }
      if (frames[0] || frames[1]) frames = await dropGhostsFrames(frames, i);
    }
    const sec = effSec(i);
    // 提示词净化：剥掉粘贴图片时残留的 @image#N:xxx.png 虚拟引用 token。
    // 不剥的话它会作为无意义文本混进 prompt（用户反馈「文生视频被污染」的真凶）。
    let text = stripVirtualRefs(c.prompt || sh?.text || "");
    // 素材前置校验：i2v/fl2v/fl2v_tail/r2v 必须有对应素材图，否则后端构图缺必需输入，出片静默失败
    // 首尾帧一族要**按槽位**判（i2v 只认「首帧」槽、fl2v_tail 只认「尾帧」槽），
    // 否则"只剩尾帧"会误判成"有图"→ 提交后才被后端 400 打回（白等一轮）。
    const _need = {
      i2v: "首帧图（素材区「首帧」那一格）",
      fl2v: "首帧图或尾帧图（素材区「首帧 / 尾帧」两格至少填一张）",
      fl2v_tail: "尾帧图（素材区「尾帧」那一格）",
      r2v: "参考图（九宫格至少 1 张，或先跑「分镜匹配」命中资产图）",
    };
    if (_need[P.mode]) {
      let ok = imgs.length > 0;
      if (isFramesMode) {
        const f0 = (frames && frames[0]) || "", f1 = (frames && frames[1]) || "";
        ok = P.mode === "fl2v" ? !!(f0 || f1) : !!f0;   // fl2v 留一张也能出（后端自动退化成单帧模式）
      }
      if (!ok) {
        ctx.toast(`${modeLabel(P.mode)} 模式需要 ${_need[P.mode]}，当前没有可用素材图，无法出片。请先加图或改用 t2v 模式`, true);
        println(`✗ 第${sh.index}镜：${modeLabel(P.mode)} 模式缺素材图（需 ${_need[P.mode]}）`, "#ffb4b4");
        return false;
      }
    }
    // 衔接上下文：若上一镜勾选「衔接下镜」，把上一镜结尾文本注入为引导
    if (i > 0 && shot(i - 1).linkNext) {
      const prevText = stripVirtualRefs(shot(i - 1).prompt || shots[i - 1]?.text || "").trim();
      if (prevText) text = `（承接上一镜画面——${prevText.slice(0, 90)}${prevText.length > 90 ? "…" : ""}；保持角色/场景/镜头一致，自然衔接）\n${text}`;
    }
    // prefix 同样净化：公共前缀里若残留虚拟引用 token，会拼进每镜提示词造成跨镜头污染
    // index 用于 H3 官方结构的 [Shot N] 编号（与分镜序号一致）
    const payload = { mode: P.mode, prompt: text, prefix: stripVirtualRefs(ctx.store.get().prefix || ""), folder: folder(), seconds: sec, seed: P.output.seed || 0, index: (sh && sh.index) || i + 1, opts: collectOpts() };
    if (P.mode === "i2v") payload.first_frame = (frames && frames[0]) || "";
    else if (P.mode === "fl2v") { payload.first_frame = (frames && frames[0]) || ""; payload.last_frame = (frames && frames[1]) || ""; }
    else if (P.mode === "fl2v_tail") payload.last_frame = (frames && frames[0]) || "";
    else if (P.mode === "r2v") {
      payload.refs = imgs;
      // 官方参考槽按编号：把正文里标记的「第 N 号 → rel」一并发过去，后端放进槽 N-1
      try {
        const _bn = refsFromText(c.prompt || (ctx.store.get().shots || [])[i]?.text || "").byNum || {};
        if (_bn.image && Object.keys(_bn.image).length) payload.refByNum = _bn.image;
        if (_bn.audio && Object.keys(_bn.audio).length) payload.audioByNum = _bn.audio;
        if (_bn.video && Object.keys(_bn.video).length) payload.videoByNum = _bn.video;
      } catch (_) { /* 解析失败不影响出片 */ }
      // 音色参考：r2v 组节点有 ref_audios.ref_audio_{k} 输入（官方），把音频小格里的素材一起送过去，
      // 否则「音色参考 <Audio N>」只是句空话（用户实报：音频参考不起作用）
      const auds = ((c.media && c.media.audio) || []).filter(Boolean).slice(0, 3);
      if (auds.length) payload.audio = auds;
      // 参考视频（<Video N> → 官方 ref_videos.ref_video_{k}）：素材区视频格里的素材一起发过去，
      // 否则视频只是"存了个路径"，出片完全不参考它
      const vids = ((c.media && c.media.video) || []).filter(Boolean).slice(0, 3);
      if (vids.length) payload.video = vids;
    }
    // ⚠ 日志栏是单行（println = logFull.textContent = t，后写覆盖前面的）：
    //    所以期间的告警先收集起来，最后与「▶ 第N镜」合并成**一条**输出 —— 否则会被状态行覆盖，
    //    用户根本看不到（"标了参考不生效"的提示就白打了）。
    const _warns = [];
    // 音色参考回执：官方只在「参考生视频(R2V)」有 ref_audios.ref_audio_{N-1} 槽位。
    // 别的模式标了 <Audio N> 也发不出去 → 必须明说，否则用户以为"标了就生效"（用户实报）。
    try {
      const _tags = [...new Set([...String(text).matchAll(/<\s*Audio\s*(\d+)\s*>/gi)]
        .map((m) => parseInt(m[1], 10)).filter((n) => n > 0))].sort((a, b) => a - b);
      if (_tags.length && P.mode !== "r2v") {
        _warns.push(`本镜标了 <Audio ${_tags.join("> <Audio ")}> 音色参考，但当前是「${modeLabel(P.mode)}」模式 —— 官方只有「参考生视频(R2V)」支持音色参考，切到 R2V 才会生效`);
      } else if (_tags.length) {
        // ⚠ 判定基准必须和**后端一致**：h3shot._compact() 只收「1 ≤ N ≤ 音色槽上限(3)
        //   且能解析出素材」的编号条目（编号→rel 走前端发过去的 byNum）；
        //   格子里的音频只是"没在正文标编号的额外参考"，排在编号条目之后。
        //   旧实现拿 `_au[n-1]`（本镜第 N 个格子）当判据 —— 那是另一套编号，
        //   素材库有第 3 个音频而格子只填了 2 条时会误报"不会生效"（用户实报）。
        const _abn = (refsFromText(text).byNum || {}).audio || {};
        const _aover = _tags.filter((n) => n > 3);
        const _aunres = _tags.filter((n) => n <= 3 && !_abn[n]);
        if (_aover.length) {
          _warns.push(`<Audio ${_aover.join("> <Audio ")}> 编号超出上限 —— 官方音色参考槽只有 3 个（ref_audio_0..2），编号 4 及以上会被丢弃、不会生效；请改成 1–3`);
        }
        if (_aunres.length) {
          _warns.push(`<Audio ${_aunres.join("> <Audio ")}> 解析不到音频素材（既没有手动绑定，素材库里也没有第 ${_aunres[0]} 个音频）→ 这几条音色参考不会生效；请在正文里改用 @音频名，或点音频格从素材库挑一个`);
        }
      }
      // 参考视频回执：官方只在 R2V 有 ref_videos.ref_video_{k} 槽位
      const _vtags = [...new Set([...String(text).matchAll(/<\s*Video\s*(\d+)\s*>/gi)]
        .map((m) => parseInt(m[1], 10)).filter((n) => n > 0))].sort((a, b) => a - b);
      if (_vtags.length) {
        if (P.mode !== "r2v") {
          _warns.push(`本镜标了 <Video ${_vtags.join("> <Video ")}> 参考视频，但当前是「${modeLabel(P.mode)}」模式 —— 官方只有「参考生视频(R2V)」支持参考视频，切到 R2V 才会生效`);
        } else {
          // 同 Audio：判据是"编号 1–3 且能解析出素材"，不是"本镜第 N 个格子"。
          const _vbn = (refsFromText(text).byNum || {}).video || {};
          const _vover = _vtags.filter((n) => n > 3);
          const _vunres = _vtags.filter((n) => n <= 3 && !_vbn[n]);
          if (_vover.length) {
            _warns.push(`<Video ${_vover.join("> <Video ")}> 编号超出上限 —— 官方参考视频槽只有 3 个（ref_video_0..2），编号 4 及以上会被丢弃、不会生效；请改成 1–3`);
          }
          if (_vunres.length) {
            _warns.push(`<Video ${_vunres.join("> <Video ")}> 解析不到视频素材（既没有手动绑定，素材库里也没有第 ${_vunres[0]} 个视频）→ 不会生效；请在「视频」格里上传，或点该格从素材库选`);
          }
        }
      }
      // 参考生效回执：填了格子但正文里没标编号的 → 会作为「额外参考」一起送模型（不是没用）。
      // 用户问「格子里的东西到底有没有生效」时，这一行就是答案。
      if (P.mode === "r2v") {
        const _bn2 = (refsFromText(c.prompt || text).byNum) || {};
        const _extra = [];
        for (const kv of [["image", "图"], ["video", "视频"], ["audio", "音频"]]) {
          const kind = kv[0], cn = kv[1];
          const arr = ((c.media && c.media[kind]) || []).filter(Boolean);
          const marked = new Set(Object.keys(_bn2[kind] || {}).map((k) => _bn2[kind][k]));
          const n = arr.filter((rel) => !marked.has(rel)).length;
          if (n) _extra.push(n + " 个" + cn);
        }
        if (_extra.length) {
          const _msg = "ℹ 有 " + _extra.join(" / ") + "没在正文里标编号 —— 已作为额外参考一起送进导演台"
            + "（想精确控制就写 <Picture N>/<Video N>/<Audio N>）";
          _warns.push(_msg);
        }
      }
    } catch (_) { /* 回执失败不影响出片 */ }
    // 权重回执：r2v 必须 ref2va。权重不对时参考全部失效——这是"标了参考不生效"最常见的环境原因。
    try {
      if (P.mode === "r2v" && P.model.unet && !unetIsRefCapable(P.model.unet)) {
        _warns.push("当前 r2v 用的是「" + P.model.unet + "」—— 不是 ref2va（参考）权重。"
          + "fl2va 是首尾帧权重，会把参考图 / 参考音色当噪声忽略，标了也不生效 → "
          + "去「🧠 模型」页一键切到 " + (refUnetName() || "ref2va 权重") + " 再重跑本镜");
      }
    } catch (_) {}
    // LoRA 家族回执：只提示「完全不属于 H3」的 LoRA（key 对不上 = 等于没加载）。
    // 不再按 bf16/pruned/ref2v/fl2v 之类的文件名特征判"不兼容"——那是误判：
    // LoRA 的 bf16 是它自己的存储精度，任务族变体互配时 ComfyUI 只会跳过对不上的 key。
    try {
      const _slots = [["模型页 LoRA", P.model.lora], ["蒸馏 LoRA", P.speed.lora]];
      for (const [slot, name] of _slots) {
        const msg = loraUnetConflict(name);
        if (msg) _warns.push(`${slot}：${msg} —— 或先设为「(无)」再跑本镜`);
      }
    } catch (_) {}
    println(`▶ 第${sh.index}镜（${modeLabel(P.mode)} · ${sec}s · ${isFramesMode
      ? `首帧${(frames && frames[0]) ? "✓" : "✗"} 尾帧${(frames && frames[1]) ? "✓" : "✗"}`
      : `图${imgs.length} 视${c.media.video.length} 音${c.media.audio.length}`}${(!isFramesMode && !imgs.length) ? " · 无素材(纯文本)" : ""}）`
      + (_warns.length ? ` ｜ ⚠ ${_warns.join(" ｜ ⚠ ")}` : ""), _warns.length ? "#ffb35c" : "#9fd0ff");
    // 生成中实时预览：低频轮询采样 preview 图（不占资源）
    // 关键：带本次起始时间戳，只认"本次开始之后写盘"的预览图 —— 否则会把上一轮（甚至别的
    // 模式 / 别的镜）留在预览目录里的旧图当成"本次实时预览"显示，看起来就像"还在用以前的参考图"。
    if (previewTimer) clearInterval(previewTimer);
    livePreviewUrl = null;
    previewRunSince = Date.now() / 1000 - 1; // 留 1s 余量给时钟误差
    try { if (previewPainter) previewPainter(); } catch (_) { /* 预览框还没建好，忽略 */ }
    previewTimer = setInterval(() => {
      const u = ctx.api.previewLatestUrl(null, previewRunSince);
      if (u && u !== livePreviewUrl) {
        livePreviewUrl = u;
        try { if (previewPainter) previewPainter(); } catch (_) { /* 忽略 */ }
      }
    }, 2500);
    try {
      const r = await ctx.api.h3Shot(payload);
      if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
      livePreviewUrl = null;
      if (r.ok && r.rel) {
        // 音频护栏回执：步数被自动抬升时明确告知（否则用户以为自己在跑 4 步）
        if (r.audio_note) println(`⚠ ${r.audio_note}`, "#ffb35c");
        // 外部加速节点回执：告诉用户"内置加速为什么没生效"（外接加速后自动让路）
        if (r.accel_note) println(`🔗 ${r.accel_note}`, "#9fd0ff");
        // 首尾帧让步回执：fl2v 只填了一张时后端会退化成 i2v / fl2v_tail，这里说明清楚
        if (r.mode_note) println(`🎬 ${r.mode_note}`, "#ffd98f");
        // 回显真正送进模型的最终提示词：用户怀疑「不按提示词走」时能一眼核对是不是这里被改过
        if (r.prompt_final) {
          const pf = String(r.prompt_final).replace(/\s+/g, " ").trim();
          println(`📝 实际送模型的提示词：${pf.slice(0, 220)}${pf.length > 220 ? "…" : ""}`, "#9fb6d0");
        }
        // 台词识别回执：让用户可以核对模型"要说的话"
        if (r.dialogues && r.dialogues.length) {
          const d = r.dialogues.map((x) => `${x.speaker || "?"}：${x.text}`).join(" / ");
          println(`🎙 台词 ${r.dialogues.length} 句：${d.slice(0, 160)}${d.length > 160 ? "…" : ""}`, "#c9b6ff");
        }
        println(`✓ 第${sh.index}镜 → ${r.rel}（${modeLabel(P.mode)} · 构图 ${r.graph_kind || "-"}${r.dropped && r.dropped.length ? ` · 剔除失效素材 ${r.dropped.length}` : ""}）`, "#8ff0c0");
        shotPreview = { idx: i, rel: r.rel };
        c.videoRel = r.rel;  // 存视频路径，块上播放按钮用
        // 视频已落盘在资产 video/ 目录（剪辑面板素材源），刷新剪辑面板素材列表即可见
        if (ctx.refreshPanel) ctx.refreshPanel("editor");
        // 自动二采：出片成功后立即二采高清放大
        if (P.output.upscale_mode === "auto") {
          await doUpscale(i, r.rel);
        }
        renderEditor();
        return true;
      }
      println(`✗ 第${sh.index}镜：${r.error || "采样成功但未找到视频产物"}`, "#ffb4b4"); renderEditor(); return false;
    } catch (e) { if (previewTimer) { clearInterval(previewTimer); previewTimer = null; } livePreviewUrl = null; println(`✗ 第${sh.index}镜：${e.message}`, "#ffb4b4"); renderEditor(); return false; }
  };
  const runBtnFor = (i) => h("button", { class: "btn btn-primary", style: { padding: "5px 12px" }, onclick: async (ev) => {
    ev.stopPropagation();
    if (busy) { ctx.toast("正在运行，先停止", true); return; }
    const b = ev.currentTarget;
    b.disabled = true; b.textContent = "采样中…";
    busy = true;
    try { await runOne(i); }
    catch (e) { ctx.toast("出片异常: " + e.message, true); }
    finally { busy = false; b.disabled = false; b.textContent = "▶ 出片"; }
  } }, "▶ 出片");

  // 全部衔接开关：一键在每个相邻分镜之间开启/关闭上下文引导
  const linkAllBtn = h("button", { class: "btn", style: { padding: "6px 11px" }, onclick: () => {
    const shots = ctx.store.get().shots || [];
    if (shots.length < 2) { ctx.toast("至少两个分镜才能衔接", true); return; }
    const anyOff = shots.some((_, k) => k < shots.length - 1 && !shot(k).linkNext);
    for (let k = 0; k < shots.length - 1; k++) shot(k).linkNext = anyOff;
    linkAllBtn.textContent = anyOff ? "⇄ 已全衔接" : "⇄ 全部衔接";
    setTimeout(() => { linkAllBtn.textContent = "⇄ 全部衔接"; }, 1600);
    renderAll();
  } }, "⇄ 全部衔接");

  // ---------- 轨道 ----------
  const appendShot = () => {
    const shots = (ctx.store.get().shots || []).slice();
    shots.push({ index: shots.length + 1, text: "", prompt: "", refs: [] });
    ctx.store.set({ shots });
    selIdx = shots.length - 1;
    renderAll();
  };
  const removeShot = (i) => {
    const shots = (ctx.store.get().shots || []).slice();
    shots.splice(i, 1);
    shots.forEach((s, k) => { s.index = k + 1; });
    ctx.store.set({ shots });
    // shotsCfg 以数组下标为 key：删除后整体左移
    const list = Object.keys(shotsCfg).map(Number).sort((a, b) => a - b);
    const next = {};
    list.forEach((k) => { const nk = k === i ? -1 : (k > i ? k - 1 : k); if (nk >= 0) next[nk] = shotsCfg[k]; });
    Object.keys(shotsCfg).forEach((k) => delete shotsCfg[k]);
    Object.assign(shotsCfg, next);
    // 多选集合同步左移（删除的镜移除，其后下标-1）
    const nextSel = new Set();
    multiSel.forEach((k) => { if (k < i) nextSel.add(k); else if (k > i) nextSel.add(k - 1); });
    multiSel.clear();
    nextSel.forEach((k) => multiSel.add(k));
    syncRunSelBtn();
    selIdx = -1;
    renderAll();
  };
  // 复制分镜：把该镜的全部素材参数（九宫格/视频/音频）+ 提示词 + 秒数 + 衔接 复制成一个新分镜
  const duplicateShot = (i) => {
    const shots = (ctx.store.get().shots || []).slice();
    const src = shots[i];
    if (!src) { ctx.toast("没有可复制的分镜", true); return; }
    const newIndex = shots.length + 1;
    const copy = { ...src, index: newIndex, text: src.text || "", prompt: src.prompt || "" };
    shots.push(copy);
    ctx.store.set({ shots });
    // 复制该镜配置（深拷 media/chosen，避免共享引用互相影响）
    const c = shot(i);
    const newIdx = shots.length - 1;
    shotsCfg[newIdx] = {
      chosen: { ...(c.chosen || {}) },
      prompt: c.prompt || "",
      media: {
        image: [...((c.media && c.media.image) || [])],
        video: [...((c.media && c.media.video) || [])],
        audio: [...((c.media && c.media.audio) || [])],
      },
      sec: c.sec,
      linkNext: c.linkNext,
    };
    selIdx = newIdx;
    renderAll();
    ctx.toast(`已复制第${src.index}镜 → 第${newIndex}镜（含素材参数与提示词）`);
  };
  // 全局视频分辨率：与「一键流水线」面板同款下拉（VIDEO_SIZES + 自定义宽高），直接放在分镜上方按钮行
  // 选择/输入 → 写 store.vidSize/vidW/vidH → store.subscribe → _syncPfromStore 同步 P.output.width/height
  const refreshTopVid = () => {
    const st = ctx.store.get();
    topVidSel.value = String(st.vidSize ?? DEFAULT_VID_SIZE_INDEX);
    const custom = Number(topVidSel.value) === CUSTOM_VID_SIZE_INDEX;
    const mpOn = Number(st.vidMP || 0) > 0;
    topVidW.style.display = (custom || mpOn) ? "" : "none";
    topVidH.style.display = (custom || mpOn) ? "" : "none";
    topVidW.value = P.output.width; topVidH.value = P.output.height;
    if (topVidMP) topVidMP.value = mpOn ? String(st.vidMP) : "";
    if (topVidOrientSel) {
      topVidOrientSel.value = st.vidOrient || "auto";
      const lk = (st.vidOrient || "auto") !== "auto";
      topVidOrientSel.style.opacity = mpOn || lk ? "1" : "0.75";
      topVidOrientSel.title = mpOn
        ? "MP 出片朝向：竖屏 / 横屏 / 沿用当前比例（改这里会立刻按新朝向重算宽高）"
        : "MP 留空时点这里也会按该朝向选一个对应档位（竖屏↔9:16，横屏↔16:9）";
    }
  };
  const topVidSel = h("select", { class: "select", style: { width: "auto", padding: "5px 6px", fontSize: 11.5 },
    title: "视频分辨率档位（与「一键流水线」面板联动）" },
    ...VIDEO_SIZES.map(([label], i) => h("option", { value: String(i) }, label)));
  const topVidW = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 62, padding: "4px 5px", fontSize: 11.5 }, title: "自定义宽（32 对齐）" });
  const topVidH = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 62, padding: "4px 5px", fontSize: 11.5 }, title: "自定义高（32 对齐）" });
  // 朝向（横屏/竖屏）：让用户不必先挑档位就能定出片朝向。
  //  - MP 已填 → 作为 mpToWH 的朝向参数，立刻按新朝向重算宽高（总像素/MP 不变）
  //  - MP 留空 → 按朝向挑一个对应档位（竖屏→9:16，横屏→16:9），保住 MP=0 的宽高模式
  const topVidOrientSel = h("select", { class: "select", style: { width: "auto", padding: "4px 5px", fontSize: 11 },
    title: "出片朝向" },
    h("option", { value: "auto" }, "按比例"),
    h("option", { value: "portrait" }, "竖屏 ▯"),
    h("option", { value: "landscape" }, "横屏 ▭"));
  // MiniMax H3 官方「百万像素」直填（0.1–2）：与官方 ResolutionSelector 同一算式
  //   W = round(aw*√(MP*1024²/(aw*ah))/32)*32   （aw:ah = 当前宽高比）
  // 填了就按它算宽高并真正写进工作流（timeline_data.output.megapixels + mode=fixed）
  const topVidMP = h("input", {
    class: "input", type: "number", min: 0.1, max: 2, step: 0.1, placeholder: "MP",
    style: { width: 58, padding: "4px 5px", fontSize: 11.5 },
    title: "MiniMax H3 官方百万像素（0.1–2）：填了就按当前比例算出宽高，并写进工作流（留空=用上面的宽高）",
  });
  // 按当前朝向重算一次 MP 尺寸（MP 已填）或按朝向换档位（MP 留空）
  const applyOrient = () => {
    const orient = topVidOrientSel.value || "auto";
    const st = ctx.store.get();
    const mp = Number(st.vidMP || 0);
    if (mp > 0) {
      const [w, hh] = mpToWH(mp, P.output.width || st.vidW, P.output.height || st.vidH, orient);
      P.output.megapixels = mp; P.output.width = w; P.output.height = hh;
      ctx.store.set({ vidOrient: orient, vidMP: mp, vidW: w, vidH: hh });
      ctx.toast(`已切到${orient === "portrait" ? "竖屏" : orient === "landscape" ? "横屏" : "原比例"} ${mp} MP：${w}×${hh}`);
    } else {
      const idx = Number(topVidSel.value) || 0;
      const ni = orientVidIndex(idx, orient === "auto" ? null : orient);
      const [w, hgt] = resolveVidSize(ni, st.vidW, st.vidH);
      // 若朝向与档位本来就一致（ni === idx）也保证宽高朝向正确
      const [fw, fh] = orient === "auto" ? [w, hgt]
        : (orient === "portrait" ? (hgt >= w ? [w, hgt] : [hgt, w]) : (w >= hgt ? [w, hgt] : [hgt, w]));
      P.output.width = fw; P.output.height = fh; P.output.megapixels = 0;
      ctx.store.set({ vidOrient: orient, vidSize: ni, vidW: fw, vidH: fh, vidMP: 0 });
    }
    refreshTopVid(); renderTrack();
  };
  topVidOrientSel.onchange = applyOrient;
  topVidMP.onchange = () => {
    const raw = Number(topVidMP.value);
    if (!raw || raw <= 0) {                     // 留空 → 回到纯宽高模式
      P.output.megapixels = 0;
      ctx.store.set({ vidMP: 0 });
      refreshTopVid(); renderTrack();
      return;
    }
    const mp = Math.max(0.1, Math.min(2, Math.round(raw * 100) / 100));
    topVidMP.value = String(mp);
    const orient = (ctx.store.get().vidOrient || "auto");
    const [w, hh] = mpToWH(mp, P.output.width, P.output.height, orient);
    P.output.megapixels = mp;
    P.output.width = w; P.output.height = hh;
    ctx.store.set({ vidMP: mp, vidW: w, vidH: hh });
    ctx.toast(`已按 H3 官方 ${mp} MP 设定分辨率：${w}×${hh}（32 对齐${orient === "auto" ? "" : orient === "portrait" ? "，竖屏" : "，横屏"}）`);
    refreshTopVid(); renderTrack();
  };
  topVidSel.onchange = () => {
    const idx = Number(topVidSel.value) || 0;
    const [w, hgt] = resolveVidSize(idx, ctx.store.get().vidW, ctx.store.get().vidH);
    ctx.store.set({ vidSize: idx, vidW: w, vidH: hgt, vidMP: 0 });
    P.output.width = w; P.output.height = hgt; P.output.megapixels = 0;
    refreshTopVid(); renderTrack();
  };
  const _topVidCustom = () => {
    const w = Math.max(64, Math.round((Number(topVidW.value) || P.output.width) / 32) * 32);
    const hgt = Math.max(64, Math.round((Number(topVidH.value) || P.output.height) / 32) * 32);
    ctx.store.set({ vidSize: CUSTOM_VID_SIZE_INDEX, vidW: w, vidH: hgt, vidMP: 0 });
    P.output.width = w; P.output.height = hgt; P.output.megapixels = 0;
    refreshTopVid(); renderTrack();
  };
  topVidW.oninput = _topVidCustom;
  topVidH.oninput = _topVidCustom;
  refreshTopVid();

  // 全部导出后拼接视频（官方导演台默认）+ 自动导入到剪辑面板素材库
  const composeIfAll = async (resultCallback) => {
    if (P.output.exportMode !== "all") return;
    const shots = ctx.store.get().shots || [];
    const segs = shots
      .map((_, i) => ({ rel: shot(i).videoRel, in_: 0, out_: 0 }))
      .filter((s) => s.rel);
    if (segs.length < 2) {
      if (typeof resultCallback === "function") resultCallback(null);
      return;
    }
    println(`🎬 正在拼接 ${segs.length} 段为完整视频…`, "#ffd98f");
    try {
      const r = await ctx.api.composeEditor(folder(), segs);
      if (r.ok && r.rel) {
        println(`✓ 已拼接 → ${r.rel}${r.filename ? `（${r.filename}）` : ""}`, "#8ff0c0");
        ctx.toast("视频已拼接完成，已入剪辑素材库");
        // compose_*.mp4 落盘在资产 video/ 目录，刷新剪辑面板素材列表即可见
        if (ctx.refreshPanel) ctx.refreshPanel("editor");
        if (typeof resultCallback === "function") resultCallback(r);
      } else {
        println(`✗ 拼接失败：${r.error || "未知错误"}`, "#ffb4b4");
        if (typeof resultCallback === "function") resultCallback(null);
      }
    } catch (e) {
      println(`✗ 拼接异常：${e.message}`, "#ffb4b4");
      if (typeof resultCallback === "function") resultCallback(null);
    }
  };
  const runAllBtn = h("button", { class: "btn btn-primary", style: { padding: "6px 13px" }, onclick: async () => {
    if (busy) { stopReq = true; runAllBtn.textContent = "停止中…"; return; }
    const shots = ctx.store.get().shots || [];
    if (!shots.length) { ctx.toast("先添加分镜", true); return; }
    busy = true; stopReq = false; logFull.textContent = ""; logFull.title = "";
    println(`▶ 整条连跑（${shots.length} 块 · ${modeLabel(P.mode)} · ${P.output.exportMode === "all" ? "全部导出（自动拼接）" : "分段导出"}）`);
    let ok = 0;
    try {
      for (let i = 0; i < shots.length; i++) {
        if (stopReq) { println("⏹ 已停止", "#ffd98f"); break; }
        status.textContent = `[${i + 1}/${shots.length}] 第${shots[i].index}块…（首块含模型加载）`;
        runAllBtn.textContent = `⏹ 停止（${i + 1}/${shots.length}）`;
        if (await runOne(i)) ok += 1;
        // 段间显存清理：每 2 镜后清一次缓存（防长时间连跑显存累积 OOM）
        if (P.speed.free_vram && (i + 1) % 2 === 0 && i < shots.length - 1) {
          println(`🧹 段间清理显存（第 ${i + 1}/${shots.length} 镜后）…`, "#7fd0ff");
          try { const fr = await ctx.api.h3FreeVram(); if (fr.ok) println(`    ✓ 剩余显存 ${fr.free_gb ?? "?"}/${fr.total_gb ?? "?"} GB`, "#8ff0c0"); }
          catch (_) { println("    ✗ 清理失败（继续）", "#ffb4b4"); }
        }
      }
    } catch (e) {
      println(`✗ 连跑异常：${e.message}`, "#ffb4b4");
    } finally {
      status.textContent = `连跑结束：成功 ${ok}/${shots.length}`;
      runAllBtn.textContent = "▶ 整条连跑";
      busy = false;
      if (ok > 1 && P.output.exportMode === "all") {
        const r = await composeIfAll();
        if (r && r.rel) {
          if (shots[0]) { shot(0).videoRel = r.rel; }
        }
      }
    }
  } }, "▶ 整条连跑");

  // ---------- 多选批量出片：只跑勾选的镜（升序），其余逻辑与整条连跑一致 ----------
  const runSelBtn = h("button", {
    class: "btn btn-primary", style: { padding: "6px 13px" },
    title: "只对轨道上勾选的分镜逐镜出片（未勾选的跳过）",
    onclick: async () => {
      if (busy) { stopReq = true; runSelBtn.textContent = "停止中…"; return; }
      const shots = ctx.store.get().shots || [];
      const sel = [...multiSel].filter((i) => i >= 0 && i < shots.length).sort((a, b) => a - b);
      if (!sel.length) { ctx.toast("先在轨道块右上角勾选要出片的分镜", true); return; }
      busy = true; stopReq = false; logFull.textContent = ""; logFull.title = "";
      println(`▶ 出片选中（${sel.length}/${shots.length} 镜 · ${modeLabel(P.mode)}）`);
      let ok = 0;
      try {
        for (let k = 0; k < sel.length; k++) {
          if (stopReq) { println("⏹ 已停止", "#ffd98f"); break; }
          const i = sel[k];
          status.textContent = `[${k + 1}/${sel.length}] 第${shots[i].index}镜…（首镜含模型加载）`;
          runSelBtn.textContent = `⏹ 停止（${k + 1}/${sel.length}）`;
          if (await runOne(i)) ok += 1;
          // 段间显存清理（与整条连跑同款：每 2 镜清一次防 OOM）
          if (P.speed.free_vram && (k + 1) % 2 === 0 && k < sel.length - 1) {
            println(`🧹 段间清理显存（第 ${k + 1}/${sel.length} 镜后）…`, "#7fd0ff");
            try { const fr = await ctx.api.h3FreeVram(); if (fr.ok) println(`    ✓ 剩余显存 ${fr.free_gb ?? "?"}/${fr.total_gb ?? "?"} GB`, "#8ff0c0"); }
            catch (_) { println("    ✗ 清理失败（继续）", "#ffb4b4"); }
          }
        }
      } catch (e) {
        println(`✗ 出片选中异常：${e.message}`, "#ffb4b4");
      } finally {
        status.textContent = `出片选中结束：成功 ${ok}/${sel.length}`;
        syncRunSelBtn();
        busy = false;
        if (ok > 1 && P.output.exportMode === "all") {
          const r = await composeIfAll();
          if (r && r.rel) {
            if (shots[sel[0]]) { shot(sel[0]).videoRel = r.rel; }
          }
        }
      }
    },
  }, "▶ 出片选中");
  const syncRunSelBtn = () => {
    runSelBtn.textContent = multiSel.size ? `▶ 出片选中 (${multiSel.size})` : "▶ 出片选中";
  };
  // 导出方式切换（全部导出=拼接视频 / 分段导出=独立视频）- 单一toggle按钮
  const exportModeBtn = h("button", {
    class: "btn", style: { padding: "5px 11px", fontSize: 11, minWidth: "140px" },
    title: "点击切换导出方式：全部导出（自动拼接）/ 分段导出（独立视频）",
    onclick: () => {
      P.output.exportMode = P.output.exportMode === "segments" ? "all" : "segments";
      if (P.__syncStoreFromP) P.__syncStoreFromP();   // → store.exportMode（「一键流水线」联动）
      refreshExportModeBtn();
      renderAll();
    },
  });
  function refreshExportModeBtn() {
    const isAll = P.output.exportMode !== "segments";
    exportModeBtn.textContent = isAll ? "🎬 全部导出（拼接）" : "📦 分段导出（独立）";
    exportModeBtn.classList.toggle("btn-primary", isAll);
  }
  // ⚠ 必须在构造后立刻刷一次：这个按钮创建时**不带文案**，如果只在 onclick 里刷新，
  // 首次打开面板得到的是一个「空文案按钮」——宽 126px 但有 padding 无内容 → 高仅 11px，
  // 视觉上就是"按钮没显示/只有一条细缝"；点一下（触发 onclick）才写上文案 → 用户报的
  // 「全部导出的按钮有时候不显示，点一下才出来」就是它。renderAll 里也刷，保证
  // 从 plan/store 恢复 exportMode 后文案同步。
  refreshExportModeBtn();
  // 全选/取消（只作用于当前所有镜）
  const selAllBtn = h("button", {
    class: "btn", style: { padding: "6px 11px" },
    title: "勾选/取消全部分镜（配合「出片选中」批量出片）",
    onclick: () => {
      const n = (ctx.store.get().shots || []).length;
      if (!n) { ctx.toast("先添加分镜", true); return; }
      if (multiSel.size >= n) multiSel.clear();
      else { multiSel.clear(); for (let i = 0; i < n; i++) multiSel.add(i); }
      syncRunSelBtn();
      renderTrack();
    },
  }, "☑ 全选");

  // ---------- 渲染 ----------
  const renderTrack = () => {
    const shots = ctx.store.get().shots || [];
    clear(ruler); clear(track);
    if (!shots.length) {
      // 空工作区：明确提示，避免看起来像"坏了"
      const hint = h("div", { class: "tl-empty", style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "20px 16px", width: "100%", color: "#7d92b3" } },
        h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 } },
          h("div", { style: { fontSize: 22, lineHeight: 1 } }, "🎬"),
          h("div", { style: { fontSize: 13, fontWeight: 600, color: "#aebdde" } }, "时间线还没有分镜"),
          h("div", { style: { fontSize: 11 } }, "在「剧本」面板拆好分镜，或直接点下方按钮开第一条"),
        ),
        h("button", { class: "btn btn-primary", onclick: appendShot, style: { padding: "6px 18px", fontSize: 12 } }, "＋ 添加第一个分镜"),
      );
      track.appendChild(hint);
      ruler.appendChild(h("div", { class: "tl-tick" }, "总长 0.0s"));
      return;
    }
    let cursor = 0;
    shots.forEach((sh, i) => {
      const c = shot(i);
      const sec = effSec(i);
      const w = Math.max(120, Math.round(sec * PX));
      const tick = h("div", { class: "tl-tick", style: { width: w } }, `${cursor}s`);
      ruler.appendChild(tick);
      const linkOn = i > 0 && shot(i - 1).linkNext;
      // 多选勾选框（批量出片）：块右上角，勾选不改变 selIdx
      const selChk = h("input", {
        type: "checkbox",
        title: "勾选加入批量出片",
        style: { position: "absolute", top: 3, right: 3, width: 14, height: 14, cursor: "pointer", zIndex: 3, accentColor: "#ffcf6b" },
      });
      selChk.checked = multiSel.has(i);
      selChk.onclick = (ev) => {
        ev.stopPropagation();
        if (selChk.checked) multiSel.add(i); else multiSel.delete(i);
        syncRunSelBtn();
      };
      const playBtn = c.videoRel ? h("button", {
        class: "tl-play", title: "播放该镜视频",
        onclick: (ev) => {
          ev.stopPropagation();
          const eng = P.output.upscale_engine || "rtx";
          const vidUrl = relToViewUrl(c.videoRel);
          lightbox(vidUrl, "video", {
            actions: [
              { label: "✨ 二采", title: `用当前引擎（${eng}）对该镜视频二采高清放大`, primary: true,
                onClick: async () => { closeLightbox(); const r = await doUpscale(i, c.videoRel); if (r) { shotPreview = { idx: i, rel: r }; renderAll(); } } },
              { label: "🎬 高清超分（选引擎）", title: "选择超分引擎后对该镜视频超分",
                onClick: async () => { closeLightbox(); await pickEngineThenUpscale(i, c.videoRel); } },
              { label: "✂️ 去剪辑", title: "将该镜视频加到剪辑页面 V1 主轨",
                onClick: () => { closeLightbox(); sendToEditor(c.videoRel); } },
              { label: "💾 保存到本机", title: "下载该镜视频文件",
                onClick: () => {
                  const a = document.createElement("a");
                  a.href = vidUrl; a.download = (c.videoRel.split("/").pop() || "mrnext_shot.mp4");
                  document.body.appendChild(a); a.click(); a.remove();
                } },
            ],
          });
        },
      }, "▶") : null;
      const block = h("div", {
        class: "tl-block" + (i === selIdx ? " act" : "") + (linkOn ? " ctx" : ""),
        style: { width: w, position: "relative" },
        onclick: () => { selIdx = i; renderAll(); },
      },
        selChk,
        playBtn,
        h("div", { class: "tl-idx" }, `#${sh.index} · ${sec}s${c.sec ? "✎" : ""} · 图${c.media.image.length}视${c.media.video.length}音${c.media.audio.length}${linkOn ? " ⇄" : ""}`),
        h("div", { class: "tl-txt" }, c.prompt || sh.text || "（空）"));
      track.appendChild(block);
      cursor += sec;
      if (i < shots.length - 1) {
        // 块间「衔接」开关：点亮表示 本镜→下镜 生成时注入上一镜上下文
        const nxt = shot(i + 1);
        const lk = h("div", {
          class: "tl-link" + (c.linkNext ? " on" : ""),
          title: c.linkNext ? "衔接中：下镜注入本镜上下文引导" : "点击开启与下一镜的上下文衔接",
          onclick: (ev) => { ev.stopPropagation(); c.linkNext = !c.linkNext; renderTrack(); },
        }, h("span", { class: "lk" }, "⇄"));
        track.appendChild(lk);
        ruler.appendChild(h("div", { class: "tl-link", style: { height: 10, cursor: "default", visibility: "hidden", background: "transparent", border: "none" } }));
      }
    });
    const addB = h("button", { class: "btn tl-add", onclick: appendShot }, "＋ 分镜");
    track.appendChild(addB);
    ruler.appendChild(h("div", { class: "tl-tick" }, `总长 ${cursor.toFixed(1)}s`));
  };
  const renderEditor = () => {
    clear(editorHost);
    const shots = ctx.store.get().shots || [];
    if (selIdx >= 0 && shots[selIdx]) editorHost.appendChild(editorFor(selIdx, shots[selIdx]));
    else if (shots.length) { selIdx = 0; editorHost.appendChild(editorFor(0, shots[0])); }
    else editorHost.appendChild(h("div", { class: "empty" }, "点「＋ 分镜」开始在轨道上加镜头块"));
  };
  // 分镜方案变更（拆分分镜 / 匹配引用 / 切分到导演台）→ 丢掉旧的每镜缓存，重新从 refMap 导入。
  // ⚠ 没有这一步的话：用户先打开过时间线（此时 shotsCfg[i] 已按"空 refMap"建好并被永久缓存），
  //   之后再切分到导演台时，本镜素材区仍然是空的 —— 表现就是"切分后素材不自动加载"。
  let _lastSplitStamp = null;
  const syncPlanStamp = () => {
    const stamp = ctx.store.get().splitStamp;
    if (_lastSplitStamp === null) { _lastSplitStamp = stamp; return; }
    if (stamp === _lastSplitStamp) return;
    _lastSplitStamp = stamp;
    Object.keys(shotsCfg).forEach((k) => delete shotsCfg[k]);   // 方案换了 → 每镜缓存作废
  };

  const renderAll = () => {
    // 工具条文案与状态同步：导出方式按钮（空文案 → 面板看起来"按钮不见了"）
    // 与二采提示（静态文案会与下拉值脱节）都必须每次渲染都刷一遍
    try { refreshExportModeBtn(); } catch (_) {}
    try { syncUpHint(); } catch (_) {}
    syncPlanStamp(); renderTrack(); renderEditor();
  };
  const toggleLog = () => {
    logOpen = !logOpen;
    logBar.classList.toggle("tl-log-open", logOpen);
    logToggle.textContent = logOpen ? "收起" : "日志";
  };
  const logToggle = h("span", { class: "toggle", onclick: toggleLog }, "日志");
  logBar.append(logFull, status, logToggle);

  // 一采二采方案：mode(off/auto/manual) + engine(rtx/flash/seedvr2)
  const upModeSel = h("select", { class: "select", style: { width: "auto", padding: "4px 6px", fontSize: 11 } },
    h("option", { value: "off" }, "关闭二采"),
    h("option", { value: "auto" }, "自动二采"),
    h("option", { value: "manual" }, "确定后再二采"));
  upModeSel.value = P.output.upscale_mode || "off";
  upModeSel.onchange = () => { P.output.upscale_mode = upModeSel.value; renderAll(); };
  // 二采提示文字：原来是写死在 el 里的静态文案 → 选完「自动二采」仍显示「（仅一采）」。
  // 改成随下拉值刷新（renderAll 里也会刷，保证从 plan/store 恢复后一致）。
  const upHint = h("span", { class: "muted", style: { fontSize: 10.5 } });
  function syncUpHint() {
    const v = upModeSel.value || "off";
    upHint.textContent = v === "auto" ? "（出片后自动二采）"
      : v === "manual" ? "（出片后点预览区二采）" : "（仅一采）";
  }
  syncUpHint();
  const upEngineSel = h("select", { class: "select", style: { width: "auto", padding: "4px 6px", fontSize: 11 } },
    h("option", { value: "rtx" }, "RTX VSR"),
    h("option", { value: "flash" }, "TE-FlashVSR"),
    h("option", { value: "seedvr2" }, "SeedVR2"),
    h("option", { value: "vosr2" }, "VOSR2（H3 二采平替）"));
  upEngineSel.value = P.output.upscale_engine || "rtx";
  upEngineSel.onchange = () => { P.output.upscale_engine = upEngineSel.value; };
  // 放大倍率（自定义）：RTX/Flash/VOSR2 = 直接倍数；SeedVR2 = 目标短边 = 源短边 × 本值（后端换算）
  const upScaleIn = h("input", { class: "input", type: "number", min: 1, max: 4, step: 0.5,
    value: P.output.upscale_scale || 2, style: { width: 56, padding: "4px 6px", fontSize: 11 },
    title: "放大倍率 1–4：RTX / TE-FlashVSR / VOSR2 直接按倍数放大；SeedVR2 按「源短边 × 倍率」换算目标短边" });
  upScaleIn.oninput = () => { P.output.upscale_scale = Math.max(1, Math.min(4, Number(upScaleIn.value) || 2)); };

  const el = h("div", { class: "col", style: { flex: "1 1 0", minWidth: 0, minHeight: 0, gap: 6 } },
    // 参数区：flex 0 1 auto + 内部滚动 —— 面板高度不够时"参数区自己缩"，而不是把下面的
    // 工具条行挤出可视区（.mx-content 是 overflow:hidden，以前矮面板下工具条会被裁掉，
    // 表现为"导出按钮有时候不显示，点一下参数 tab 才出来"）
    h("div", { class: "col", style: { gap: 4, flex: "0 1 auto", minHeight: 0, overflowY: "auto" } }, tabBar, paramRow),
    h("div", { class: "row", style: { flex: "0 0 auto", gap: 6, flexWrap: "wrap", alignItems: "center" } },
      runAllBtn,
      runSelBtn,
      selAllBtn,
      h("span", { class: "muted", style: { fontSize: 11 } }, "分辨率"), topVidSel, topVidW, topVidH,
      topVidMP, h("span", { class: "muted", style: { fontSize: 10.5 }, title: "MiniMax H3 官方百万像素：填 0.1–2 直接按比例定分辨率" }, "MP"),
      topVidOrientSel,
      h("button", { class: "btn", style: { padding: "6px 11px" }, onclick: appendShot }, "＋ 分镜"),
      linkAllBtn,
      h("span", { class: "muted", style: { fontSize: 11 } }, "导出"),
      exportModeBtn,
      // 🗑 清空 = 清空分镜 + 清理本地缓存（预览图/缩略图/旧分镜计划），
      // 避免上一轮残留影响后续生成（旧预览帧、旧计划被节点 execute 重跑、旧缩略图）
      h("button", {
        class: "btn", style: { padding: "6px 11px", borderColor: "#a33" },
        title: "清空全部分镜，并清理缓存：采样预览图 / 素材缩略图 / 旧分镜计划（_plan.json 归档为 _plan.prev.json）",
        onclick: async () => {
          const hasShots = (ctx.store.get().shots || []).length > 0;
          const msg = hasShots
            ? "清空全部镜头块，并清理缓存？\n\n会清掉：\n· 面板里的素材/提示词缓存\n· 采样实时预览图缓存\n· 素材缩略图缓存\n· 旧分镜计划（归档为 _plan.prev.json）\n\n这样旧缓存就不会再影响后续生成。"
            : "当前没有分镜。是否只清理缓存（预览图 / 缩略图 / 旧分镜计划）？";
          if (!confirm(msg)) return;
          // ① 面板内状态：分镜配置 / 选择 / 出片预览 / 实时预览轮询
          Object.keys(shotsCfg).forEach((k) => delete shotsCfg[k]);
          selIdx = -1; multiSel.clear();
          try { syncRunSelBtn(); } catch (_) {}
          shotPreview = { idx: -1, rel: null };
          livePreviewUrl = null;
          previewRunSince = 0;
          if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
          // ② 状态源（shots + refMap 一并清，防跨镜引用残留）
          ctx.store.set({ shots: [], refMap: [] });
          renderAll();
          ctx.toast(hasShots ? "已清空分镜" : "已清空缓存");
          // ③ 后端缓存（预览图 / 缩略图 / 旧计划）
          try {
            const r = await ctx.api.timelineClearCache(ctx.store.get().folder || "mrboard_next");
            const planTxt = r.plan === "archived" ? "旧计划已归档" : r.plan === "emptied" ? "旧计划已清空" : "无旧计划";
            println(`🧹 缓存已清理：采样预览图 ${r.previews || 0} · 素材缩略图 ${r.thumbs || 0} · ${planTxt}`, "#8ff0c0");
          } catch (e) {
            println("⚠ 缓存清理失败（不影响出片）：" + e.message, "#ffb35c");
          }
        },
      }, "🗑 清空"),
      h("span", { class: "muted", style: { fontSize: 11 } }, "二采"),
      upModeSel,
      upEngineSel,
      h("span", { class: "muted", style: { fontSize: 11 } }, "倍率"), upScaleIn,
      upHint,
      h("button", { class: "btn", style: { padding: "6px 11px" }, onclick: () => ctx.switchTo("editor") }, "去剪辑")),
    scroll,
    h("div", { class: "col", style: { gap: 4, flex: "1 1 auto", minHeight: 0, overflowY: "auto" } }, editorHost),
    logBar);

  (async () => {
    // 关键：选项与收藏库必须"各管各的"。以前用 Promise.all，收藏库读失败会把 opts
    // 一起带走 → opts 永远是 null → 所有参数页（含「🎬 模式」）都渲染不出来，
    // 用户看到的就是"切模式没反应"。改 allSettled 后互不影响。
    const [optRes, favRes] = await Promise.allSettled([ctx.api.editorOptions(), loadFavs()]);
    if (optRes.status === "fulfilled") opts = optRes.value;
    else {
      console.error("[MRBoardNext] editorOptions failed", optRes.reason);
      ctx.toast("模型选项加载失败：后端 /mrnext/editor/options 出错（" + (optRes.reason && optRes.reason.message || "") + "）", true);
    }
    if (favRes.status !== "fulfilled") console.error("[MRBoardNext] loadFavs failed", favRes.reason);
    // 自愈：把持久化里「已不在当前选项列表」的模型选择清掉，再从默认值补齐。
    // 动机：选项列表本身会变（v1.11.20 起音频/视频 VAE 互斥、LoRA 过滤掉非 H3 家族），
    // 而 localStorage 里的旧选择仍会被 collectOpts 原样发进出片请求 → 用错文件
    // → 采样期维度类报错（报错信息不提是哪个文件）。清掉后走默认值，绝不会用错。
    const _healed = [];
    if (opts) {
      const _drop = (key, list, label) => {
        const cur = P.model[key];
        if (cur && !(list || []).includes(cur)) { _healed.push(`${label}「${cur}」`); P.model[key] = ""; }
      };
      _drop("unet", opts.unets, "UNet");
      _drop("clip", opts.clips, "CLIP");
      _drop("vvae", opts.videoVaes, "视频VAE");
      _drop("avae", opts.audioVaes, "音频VAE");
      if (P.model.lora && P.model.lora !== "(无)" && !(opts.loras || []).includes(P.model.lora)) {
        _healed.push(`LoRA「${P.model.lora}」`); P.model.lora = "(无)";
      }
      if (P.speed.lora && P.speed.lora !== "(无)" && !(opts.loras || []).includes(P.speed.lora)) {
        _healed.push(`蒸馏LoRA「${P.speed.lora}」`); P.speed.lora = "(无)";
      }
    }
    if (_healed.length) {
      console.warn("[MRBoardNext] 已重置失效的模型选择：", _healed.join("、"));
      ctx.toast("检测到失效选择（已不在当前模型列表）并已重置：" + _healed.join("、"), true);
    }
    // 打开即用：模型字段为空时自动选中本机推荐默认模型（不覆盖用户已选）
    if (opts && opts.defaults) {
      const d = opts.defaults;
      if (!P.model.unet && d.unet) P.model.unet = d.unet;
      if (P.model.autoUnet !== false && opts.unetsByMode) {
        const want = opts.unetsByMode[P.mode] || opts.unetsByMode.i2v || "";
        if (want) P.model.unet = want;   // 打开面板就按当前模式对齐权重（r2v → ref2va）
      }
      if (!P.model.clip && d.clip) P.model.clip = d.clip;
      if (!P.model.vvae && d.video_vae) P.model.vvae = d.video_vae;
      if (!P.model.avae && d.audio_vae) P.model.avae = d.audio_vae;
    }
    renderParam();
    renderAll();
  })();

  ctx.store.subscribe(() => {
    if (scroll.contains(document.activeElement) || editorHost.contains(document.activeElement)) return;
    renderAll();
  });
  return { el, update: renderAll };
}
