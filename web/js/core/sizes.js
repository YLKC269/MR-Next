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
// 采样设置页 / 工具栏 / 一键流水线 三处共用，改一处即全对。
export const mpToWH = (mp, w0, h0) => {
  const w = Math.max(1, Math.round(Number(w0) || 16)), hh = Math.max(1, Math.round(Number(h0) || 9));
  const g = (a, b) => (b ? g(b, a % b) : a);
  const k = g(w, hh) || 1, aw = w / k, ah = hh / k;
  const v = Math.max(0.1, Math.min(2, Number(mp) || 0));
  const scale = Math.sqrt((v * 1024 * 1024) / (aw * ah));
  return [Math.max(32, Math.round((aw * scale) / 32) * 32), Math.max(32, Math.round((ah * scale) / 32) * 32)];
};

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
