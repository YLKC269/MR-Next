// core/sizes.js — 生图尺寸档位（官方 H3 竖版/横版/方形/4:3/21:9）。
// generate（生图）面板与 script（公共前缀生成设定图）面板共用，store.genSize 联动。
export const SIZES = [
  // 竖版 9:16（官方 H3 档位）
  ["480×864 竖版 9:16 · 0.4MP", 480, 864],
  ["608×1056 竖版 9:16 · 0.6MP", 608, 1056],
  ["768×1344 竖版 9:16 · 0.98MP", 768, 1344],
  ["768×1376 竖版 9:16 · 1.0MP", 768, 1376],
  ["960×1696 竖版 9:16 · 1.6MP", 960, 1696],
  ["1088×1920 竖版 9:16 · 2.0MP", 1088, 1920],
  // 横版 16:9（官方 H3 档位）
  ["480×270 横版 16:9 · 0.13MP", 480, 270],
  ["864×480 横版 16:9 · 0.4MP", 864, 480],
  ["1056×608 横版 16:9 · 0.6MP", 1056, 608],
  ["1344×768 横版 16:9 · 0.98MP", 1344, 768],
  ["1696×960 横版 16:9 · 1.6MP", 1696, 960],
  ["1920×1088 横版 16:9 · 2.0MP", 1920, 1088],
  // 方形 1:1
  ["480×480 方形 1:1 · 0.23MP", 480, 480],
  ["768×768 方形 1:1 · 0.59MP", 768, 768],
  ["960×960 方形 1:1 · 0.92MP", 960, 960],
  ["1280×1280 方形 1:1 · 1.64MP", 1280, 1280],
  // 4:3 / 3:4
  ["1024×768 横版 4:3 · 0.79MP", 1024, 768],
  ["768×1024 竖版 3:4 · 0.79MP", 768, 1024],
  ["1152×864 横版 4:3 · 1.0MP", 1152, 864],
  // 21:9 超宽
  ["896×384 超宽 21:9 · 0.34MP", 896, 384],
  ["1344×576 超宽 21:9 · 0.77MP", 1344, 576],
  ["1920×832 超宽 21:9 · 1.6MP", 1920, 832],
  // 自定义宽高（w/h=0 占位，实际用 store.genW / store.genH）
  ["自定义 宽×高", 0, 0],
];

// 默认档位：768×1344 竖版 9:16（角色三视图 / 场景概念图通用）
export const DEFAULT_SIZE_INDEX = 2;
// 自定义档位索引（SIZES 最后一项）
export const CUSTOM_SIZE_INDEX = SIZES.length - 1;

// 根据档位索引 + 自定义宽高解析 [width, height]（自定义时 32 对齐，最小 64）
export function resolveSize(index, customW, customH) {
  const i = Number(index) || 0;
  if (i === CUSTOM_SIZE_INDEX) {
    const w = Math.max(64, Math.round((Number(customW) || 768) / 32) * 32);
    const h = Math.max(64, Math.round((Number(customH) || 1344) / 32) * 32);
    return [w, h];
  }
  const [, w, h] = SIZES[i] || SIZES[DEFAULT_SIZE_INDEX];
  return [w, h];
}

// ---------- 视频分辨率档位（H3 导演台出片，与「一键流水线」面板共用 store.vidSize/vidW/vidH）----------
// 选官方 H3 导演台常用的视频分辨率档位；含 16:9 横屏、9:16 竖屏、1:1 方形 + 自定义
export const VIDEO_SIZES = [
  // 9:16 竖屏（短剧/漫剧）
  ["480×854 竖屏 9:16 · 0.4MP", 480, 854],
  ["720×1280 竖屏 9:16 · 0.92MP", 720, 1280],
  ["1080×1920 竖屏 9:16 · 2.07MP", 1080, 1920],
  // 16:9 横屏（标准视频）
  ["640×360 横屏 16:9 · 0.23MP", 640, 360],
  ["854×480 横屏 16:9 · 0.41MP", 854, 480],
  ["1280×720 横屏 16:9 · 0.92MP", 1280, 720],
  ["1920×1080 横屏 16:9 · 2.07MP", 1920, 1080],
  // 1:1 方形
  ["480×480 方形 1:1 · 0.23MP", 480, 480],
  ["720×720 方形 1:1 · 0.52MP", 720, 720],
  ["1080×1080 方形 1:1 · 1.17MP", 1080, 1080],
  // 自定义宽高（w/h=0 占位，实际用 store.vidW / store.vidH）
  ["自定义 宽×高", 0, 0],
];

// 视频默认档位：720×1280 竖屏 9:16（短剧/漫剧主流）
export const DEFAULT_VID_SIZE_INDEX = 1;
export const CUSTOM_VID_SIZE_INDEX = VIDEO_SIZES.length - 1;

// MiniMax H3 官方「百万像素」→ 宽高（与官方 ResolutionSelector 同一算式：
//   vendor/ComfyUI_MiniMaxH3_Director/director/refine_pack.py::resolution_from_selector）
//   W = round(aw·√(MP·1024²/(aw·ah))/32)·32   （aw:ah = 当前宽高比；MP 官方钳 0.1–2）
//
// orient（朝向）控制"长边落在哪一侧"，让用户能自选横屏/竖屏（不必先去挑档位）：
//   "auto"（默认，兼容旧行为）：沿用 w0:h0 的原始朝向，只按 MP 缩放；
//   "portrait"（竖屏）：把当前的宽高比取倒数（需要时）→ 结果 h > w；
//   "landscape"（横屏）：结果 w > h。
// 实现：先以「比例」算出基准尺寸，再按朝向决定是否取倒数重算 —— 只动宽高比、不动像素规模，
// 因此无论当前是横还是竖，都能一键切到目标朝向且总像素数（MP）保持不变。
// 采样设置页 / 工具栏 / 一键流水线 三处共用，改一处即全对。
export const mpToWH = (mp, w0, h0, orient) => {
  const w = Math.max(1, Math.round(Number(w0) || 16)), hh = Math.max(1, Math.round(Number(h0) || 9));
  let aw = w, ah = hh;
  const mode = orient || "auto";
  if (mode === "portrait" && aw > ah) { const t = aw; aw = ah; ah = t; }      // 强制竖：高 ≥ 宽
  if (mode === "landscape" && ah > aw) { const t = aw; aw = ah; ah = t; }    // 强制横：宽 ≥ 高
  const g = (a, b) => (b ? g(b, a % b) : a);
  const k = g(aw, ah) || 1;
  const rw = aw / k, rh = ah / k;
  const v = Math.max(0.1, Math.min(2, Number(mp) || 0));
  const scale = Math.sqrt((v * 1024 * 1024) / (rw * rh));
  const snap = (x) => Math.max(32, Math.round(x / 32) * 32);
  const ow = snap(rw * scale), oh = snap(rh * scale);
  // 32 对齐后若朝向被破坏（极窄比例 + 小 MP 时可能发生），交换修正
  if (mode === "portrait" && ow > oh) return [oh, ow];
  if (mode === "landscape" && oh > ow) return [oh, ow];
  return [ow, oh];
};

// 按朝向挑档位（用于「分辨率」下拉里"跟着朝向自动选一个档位"）：
//   portrait → 9:16 竖屏档；landscape → 16:9 横屏档；square 保持 1:1。
// 只在当前档位朝向与目标不一致时才换，尽量沿用用户已选的比例（如 4:3）。
export function orientVidIndex(index, orient) {
  const i = Number(index) || 0;
  const want = orient === "landscape" ? "l" : orient === "portrait" ? "p" : null;
  if (!want) return i;
  const row = VIDEO_SIZES[i];
  if (!row) return i;
  const [, w, h] = row;
  if (!w || !h) return i;                       // 自定义档不动
  const isP = h > w, isL = w > h;
  if ((want === "p" && isP) || (want === "l" && isL)) return i;   // 已经对了
  if (w === h) {                                 // 1:1 → 按朝向给一个 16:9 / 9:16
    return want === "p" ? DEFAULT_VID_SIZE_INDEX : 5;
  }
  // 保住比例族：优先同一"像素规模"的镜像档（9:16 ↔ 16:9）
  const area = w * h;
  const cand = VIDEO_SIZES
    .map(([label, cw, ch], ci) => ({ ci, cw, ch, label }))
    .filter((c) => c.cw && c.ch && ((want === "p" && c.ch > c.cw) || (want === "l" && c.cw > c.ch)));
  if (!cand.length) return i;
  cand.sort((a, b) => Math.abs(a.cw * a.ch - area) - Math.abs(b.cw * b.ch - area));
  return cand[0].ci;
}

export function resolveVidSize(index, customW, customH) {
  const i = Number(index) || 0;
  if (i === CUSTOM_VID_SIZE_INDEX) {
    const w = Math.max(64, Math.round((Number(customW) || 720) / 32) * 32);
    const h = Math.max(64, Math.round((Number(customH) || 1280) / 32) * 32);
    return [w, h];
  }
  const [, w, h] = VIDEO_SIZES[i] || VIDEO_SIZES[DEFAULT_VID_SIZE_INDEX];
  return [w, h];
}
