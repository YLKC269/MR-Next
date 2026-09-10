// panels/timeline.js — 导演台（剪映式可视轨道）。v0.9.4 信息层级重构：
// 顶部参数「一段式切换」（模式/模型/输出/加速，默认收起，占位极小）；
// 中部可视化时间线占据最大可视区；选中镜头在下方编辑：左素材九宫格 + 右提示词（等高）。
import { h, clear } from "../core/dom.js";
import { relToViewUrl, editorThumbUrl } from "../core/api.js";
import { createMentionEditor } from "../core/mentions.js";
import { assetRegistry } from "../core/assets.js";
import { lightbox, closeLightbox } from "../core/ui.js";
import { stripVirtualRefs, isUsableRel } from "../core/purify.js";
import { VIDEO_SIZES, DEFAULT_VID_SIZE_INDEX, CUSTOM_VID_SIZE_INDEX, resolveVidSize } from "../core/sizes.js";

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
  r2v: "参考图 ≤9（音/视频槽引擎接入中）",
};
const SPEED_MODES = [
  { v: "off", label: "关（不加速）" },
  { v: "standard", label: "TE-Speed 标准" },
  { v: "4-step LoRA", label: "4步 LoRA" },
  { v: "8-step LoRA", label: "8步 LoRA" },
];
const PX = 16; // 每秒像素
const IMG_CAP = 9;

const DEFAULT_PARAMS = () => ({
  mode: "t2v",
  model: { unet: "", clip: "", vvae: "", avae: "", lora: "(无)", loraS: 1 },
  speed: { node: "off", dev: "auto", lora: "(无)", loraS: 1, sage: "disabled", free_vram: true,
           // 外部节点接口：external = 画布上检测到的第三方加速类型（非空 → 内置加速自动失效）
           external: [], forceBuiltin: false, extInfo: null },
  output: {
    // 采样设置（官方 bd_grp_sample）
    cfg: 1, seed: 0, fps: 24, width: 768, height: 1344, ref_size: 864, sec: 5,
    // 全局时长开关：true = 所有分镜统一用 sec（忽略各镜单独设置）；false = 各镜用自己的 sec（未设则跟随 sec）
    global_sec: false,
    // 高级采样（官方 bd_grp_advanced）
    steps: 25, sampler: "res_multistep", scheduler: "simple", shift_video: 12, shift_audio: 3,
    // 性能（官方 bd_grp_perf）
    clear_vram: false, export_src: false,
    // 导出模式：all=全部合成一条视频，segments=每镜独立导出（官方导演台同款）
    exportMode: "all",
    // 二采高清放大（官方 MiniMaxH3DirectorRefine）
    refine_mode: "off", refine_megapixels: 1.0, refine_passes: 1,
    // 一采二采方案：mode(off/auto/manual) + engine(rtx/flash/seedvr2)
    upscale_mode: "off", upscale_engine: "rtx", upscale_scale: 2,
    // 画质档位：draft(低步数·快) / standard(均衡) / final(成品·最佳)
    quality: "standard",
  },
  // —— 声音 / 台词（H3 官方三段式提示词）——
  // H3 是音视频联合生成：不写声音字段，模型会自己"补"人声 →「说话乱说」。
  audio: {
    structure: true,       // 启用官方 integrated/overall_soundscape/non_diegetic_music 三段式
    lang: "Chinese",       // 台词语言标签 [Chinese] / [English] …
    ambience: "",          // 环境音（留空 = 自动保守兜底：只留底噪，禁止额外人声）
    music: "",             // 画外配乐（留空 = N/A）
    no_speech: false,      // 静音模式：完全不要人声
    guard: true,           // 低步数音频护栏（steps < min_steps 自动抬升）
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
  };
  const _syncStoreFromP = () => {
    ctx.store.set({ vidW: P.output.width, vidH: P.output.height });
  };
  // 1) 初始化：从 store 读初始值（避免来回切换面板反复覆盖）
  _syncPfromStore();
  // 2) 订阅：其他面板改 store → 这里 P.output.width/height 同步 + 顶部分辨率控件刷新
  ctx.store.subscribe((st) => {
    const ow = P.output.width, oh = P.output.height;
    _syncPfromStore();
    if (P.output.width !== ow || P.output.height !== oh) {
      // 触发了 P.output 改动 → 持久化（_persistent Proxy 的 set 会 save）
      // 再刷新「⚙ 宽×高」按钮的 label
      try { refreshTopVid(); } catch (_) {}
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

  const track = h("div", { class: "tl-track" });
  const ruler = h("div", { class: "tl-ruler" });
  const scroll = h("div", { class: "tl-scroll" }, ruler, track);
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
  loadAssets().then(() => {
    if (assets && assets.length) renderAll && renderAll();
  });

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
  const mkGroup = (key) => {
    const row = h("div", { class: "tl-paramrow" });
    if (!opts) { row.appendChild(h("span", { class: "muted" }, "加载选项…")); return row; }
    if (key === "mode") {
      const msel = h("select", { class: "select", style: { width: "auto" } },
        ...MODES.map((m) => h("option", { value: m.v, selected: m.v === P.mode ? "selected" : null }, m.label)));
      // 切换模式要连编辑器一起重渲：t2v 无素材栏，其它模式有（否则要等下次刷新才生效）
      msel.onchange = () => {
        P.mode = msel.value;
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
      row.append(field("任务类型 task_type", msel), hint);
    } else if (key === "model") {
      const mkS = (vals, cur) => sel(["", ...(vals || [])], cur || "");
      const unetE = mkS(opts.unets, P.model.unet); unetE.onchange = () => { P.model.unet = unetE.value; };
      const clipE = mkS(opts.clips, P.model.clip);
      const vvaeE = mkS(opts.videoVaes, P.model.vvae); vvaeE.onchange = () => { P.model.vvae = vvaeE.value; };
      const avaeE = mkS(opts.audioVaes, P.model.avae); avaeE.onchange = () => { P.model.avae = avaeE.value; };
      const loraE = sel(["(无)"].concat(opts.loras || []), P.model.lora); loraE.onchange = () => { P.model.lora = loraE.value; };
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
      row.append(field("UNet 模型", unetE, "model"), field("CLIP 文本编码", clipE, "clip"),
        field("视频 VAE", vvaeE, "video_vae"), field("音频 VAE", avaeE, "audio_vae"),
        field("LoRA", loraE, "lora_name"), field("LoRA 强度", loraSE, "lora_strength"), clipNote);
      syncClipNote();
    } else if (key === "sample") {
      // 采样设置组（官方 bd_grp_sample + bd_grp_advanced + bd_grp_perf 合并）
      const aspects = opts?.aspects || [{ v: "768:1344", w: 768, h: 1344 }];
      // ---- 视频分辨率：改用 VIDEO_SIZES 下拉 + 自定义 w/h，与「一键流水线」面板共享 store.vidSize/vidW/vidH ----
      const vidSizeSel = h("select", { class: "select", style: { width: "auto" } },
        ...VIDEO_SIZES.map(([label], i) => h("option", { value: String(i) }, label)));
      const vidWIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 70, display: "none" }, value: P.output.width });
      const vidHIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 70, display: "none" }, value: P.output.height });
      const syncVidCustom = () => {
        const i = Number(vidSizeSel.value);
        if (i === CUSTOM_VID_SIZE_INDEX) {
          vidWIn.style.display = ""; vidHIn.style.display = "";
          vidWIn.value = P.output.width; vidHIn.value = P.output.height;
        } else {
          vidWIn.style.display = "none"; vidHIn.style.display = "none";
        }
      };
      vidSizeSel.value = String(ctx.store.get().vidSize ?? DEFAULT_VID_SIZE_INDEX);
      syncVidCustom();
      vidSizeSel.onchange = () => {
        ctx.store.set({ vidSize: Number(vidSizeSel.value) || 0 });
        syncVidCustom();
      };
      vidWIn.oninput = () => {
        ctx.store.set({ vidW: Number(vidWIn.value) || P.output.width });
        if (P.__syncStoreFromP) P.__syncStoreFromP();
        renderTrack();
      };
      vidHIn.oninput = () => {
        ctx.store.set({ vidH: Number(vidHIn.value) || P.output.height });
        if (P.__syncStoreFromP) P.__syncStoreFromP();
        renderTrack();
      };
      ctx.store.subscribe((st) => {
        if (st.vidSize != null && String(st.vidSize) !== vidSizeSel.value) {
          vidSizeSel.value = String(st.vidSize); syncVidCustom();
          const [w, h] = resolveVidSize(st.vidSize, st.vidW, st.vidH);
          if (w && h) { P.output.width = w; P.output.height = h; if (P.__syncStoreFromP) P.__syncStoreFromP(); renderTrack(); }
        }
      });
      const cfgE = num(P.output.cfg, "1", 64, 0.1); cfgE.oninput = () => { P.output.cfg = Number(cfgE.value) || 1; };
      const seedE = num(P.output.seed, "0", 84, 1); seedE.oninput = () => { P.output.seed = Number(seedE.value) || 0; };
      const fpsE = sel((opts?.framerates || [24]).map(String), String(P.output.fps)); fpsE.onchange = () => { P.output.fps = Number(fpsE.value) || 24; };
      const secE = num(P.output.sec, "5", 64, 0.5); secE.oninput = () => { P.output.sec = Math.max(0.5, Number(secE.value) || 5); renderAll(); };
      const secAll = h("button", { class: "btn", style: { padding: "3px 8px", fontSize: 11 }, title: "把当前默认秒写入每个分镜", onclick: () => { const ss = ctx.store.get().shots || []; ss.forEach((_, i) => { shot(i).sec = P.output.sec; }); renderTrack(); renderEditor(); ctx.toast(`已设全部 ${ss.length} 镜为 ${P.output.sec}s`); } }, "设全镜秒");
      const refE = num(P.output.ref_size, "864", 64, 32); refE.oninput = () => { P.output.ref_size = Number(refE.value) || 864; };
      const stepsE = sel((opts?.steps || [25]).map(String), String(P.output.steps));
      stepsE.onchange = () => { P.output.steps = Number(stepsE.value) || 25; if (stepsWarnPainter) stepsWarnPainter(); };
      const samplerE = sel((opts?.samplers || ["res_multistep"]), P.output.sampler || "res_multistep"); samplerE.onchange = () => { P.output.sampler = samplerE.value; };
      const schedE = sel((opts?.schedulers || ["simple"]), P.output.scheduler || "simple"); schedE.onchange = () => { P.output.scheduler = schedE.value; };
      // 采样方案按钮组（采样器+调度器组合预设，一键切换）
      const SAMPLE_PRESETS = [
        { label: "官方标准", sampler: "res_multistep", scheduler: "simple", tip: "官方推荐，质量稳定" },
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
      // 画质档位（社区实测基线：官方 res_multistep + simple + cfg=1 + shift 12/3；
      // 低步数必须配蒸馏 LoRA，且步数 <8 时音轨失真由「声音」页护栏兜底）
      const QUALITY_PRESETS = [
        { key: "draft", label: "草稿（快）", steps: 6, sampler: "res_multistep", scheduler: "simple", cfg: 1, sv: 12, sa: 3, turboS: 0.75, upscale: "off",
          tip: "6 步 + 蒸馏 LoRA：出图最快。低步数音轨易失真（ComfyUI 主仓 bug，需 nightly），已由「声音」页音频护栏自动兜底。Turbo LoRA 强度建议在 0.5–1.0 间扫，别盲套 alpha=8" },
        { key: "standard", label: "标准（推荐）", steps: 12, sampler: "res_multistep", scheduler: "simple", cfg: 1, sv: 12, sa: 3, turboS: 1, upscale: "off",
          tip: "官方推荐：12–20 步 + res_multistep + simple，cfg=1，shift 保持训练值 12/3。画质与音质均衡" },
        { key: "final", label: "成品（最佳）", steps: 20, sampler: "res_multistep", scheduler: "simple", cfg: 1, sv: 12, sa: 3, turboS: 0, upscale: "auto",
          tip: "20 步官方标准 + 出片后自动二采高清放大。最慢，但画质/音质最好" },
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
              if (q.turboS > 0) P.speed.loraS = q.turboS;
              stepsE.value = String(q.steps); samplerE.value = q.sampler; schedE.value = q.scheduler;
              cfgE.value = String(q.cfg); sVE.value = String(q.sv); sAE.value = String(q.sa);
              renderQual(); renderPreset();
              if (stepsWarnPainter) stepsWarnPainter();
              if (q.key === "draft" && (!P.speed.lora || P.speed.lora === "(无)")) {
                ctx.toast("草稿档请到「⚡加速」页选一个蒸馏 LoRA（4/8 步），否则低步数画质会崩", true);
              }
            },
          }, q.label));
        });
      };
      renderQual();
      const sVE = num(P.output.shift_video, "12", 64, 0.5); sVE.oninput = () => { P.output.shift_video = Number(sVE.value) || 0; };
      const sAE = num(P.output.shift_audio, "3", 64, 0.5); sAE.oninput = () => { P.output.shift_audio = Number(sAE.value) || 0; };
      const ck = (val, fn, label, official) => h("label", { class: "row", style: { gap: 5, cursor: "pointer", padding: "4px 6px" } },
        h("input", { type: "checkbox", checked: val ? "checked" : null, onchange: (e) => fn(e.target.checked), style: { accentColor: "#ffd166" } }),
        h("span", { style: { fontSize: 11.5, color: "#bcd3ea" }, title: official || "" }, label));
      row.append(
        field("步数", stepsE, "steps (1-200)"),
        field("画质档位", qualWrap, "低步数画质/音质预设：草稿 6 步 · 标准 12 步 · 成品 20 步+二采"),
        field("采样方案", presetWrap, "采样器+调度器组合预设（点击切换）"),
        field("采样器", samplerE, "sampler"),
        field("调度器", schedE, "scheduler"),
        // 视频分辨率（与「一键流水线」面板共享 store.vidSize/vidW/vidH）
        h("div", { class: "tl-field", style: { gridColumn: "span 2" } },
          h("div", { class: "tl-flabel" }, "视频分辨率"),
          h("div", { class: "row", style: { gap: 6, flexWrap: "wrap" } },
            vidSizeSel,
            h("span", { class: "muted", style: { fontSize: 11 } }, "宽"), vidWIn,
            h("span", { class: "muted", style: { fontSize: 11 } }, "高"), vidHIn,
            h("span", { class: "muted", style: { fontSize: 10.5, opacity: 0.7 } }, "↔ 与「一键流水线」面板")),
        ),
        field("CFG 引导", cfgE, "cfg"),
        field("种子", seedE, "seed"),
        field("参考图尺寸", refE, "ref_max_size"),
        field("视频 shift", sVE, "shift_video"),
        field("音频 shift", sAE, "shift_audio"),
        ck(P.output.clear_vram, (v) => { P.output.clear_vram = v; }, "段间清显存", "clear_vram_between_segments"),
        ck(P.output.export_src, (v) => { P.output.export_src = v; }, "导出源图", "export_source_images"));
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
      const muteCk = ckBox(() => !!A.no_speech, (v) => { A.no_speech = v; }, "静音模式（完全无人声）", "纯环境音/配乐，不要任何台词与说话声");
      const guardCk = ckBox(() => A.guard !== false, (v) => { A.guard = v; }, "低步数音频护栏", "ComfyUI 稳定版在 <8 步时音轨会失真（主仓 bug，修复 commit bdcb886，需 nightly）。开启后自动把步数抬到安全线");
      const minStepE = num(A.min_steps || 8, "8", 56, 1); minStepE.oninput = () => { A.min_steps = Math.max(4, Math.min(32, Number(minStepE.value) || 8)); };
      // 步数低于安全线时的警示（与护栏联动）
      const warn = h("div", { style: { fontSize: 11, color: "#ffb35c", lineHeight: 1.5 } });
      const paintWarn = () => {
        const st = Number(P.output.steps) || 0;
        if (st > 0 && st < Number(A.min_steps || 8)) {
          warn.textContent = A.guard === false
            ? `⚠ 当前 ${st} 步 < 安全线 ${A.min_steps} 步：低步数下音轨极易失真（画质正常、声音变噪音）。建议升 ComfyUI nightly，或关掉护栏时手动提到 ${A.min_steps} 步以上。`
            : `⏫ 当前 ${st} 步 < 安全线 ${A.min_steps} 步：出片时会自动抬到 ${A.min_steps} 步（护栏已开启）。`;
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
          const dlg = (r.dialogues || []).map((d) => `${d.speaker || "?"}: ${d.text}`).join("\n");
          showTextModal("H3 官方提示词预览", txt + (dlg ? "\n\n—— 识别到的对白 ——\n" + dlg : "\n\n（本镜没有识别到对白 → 已显式声明 No dialogue）"));
        } catch (e) { ctx.toast("预览失败: " + e.message, true); }
      } }, "🔍 预览本镜提示词");
      row.append(
        structCk,
        field("台词语言", langE, "av_lang（台词用 [语言] 包裹，绝不用双引号）"),
        h("div", { class: "tl-field", style: { gridColumn: "span 3" } },
          h("div", { class: "tl-flabel", title: "overall_soundscape" }, "环境音（overall_soundscape）"),
          ambE),
        h("div", { class: "tl-field", style: { gridColumn: "span 3" } },
          h("div", { class: "tl-flabel", title: "non_diegetic_music" }, "画外配乐（non_diegetic_music）"),
          musE),
        muteCk,
        guardCk,
        field("护栏最低步数", minStepE, "audio_min_steps"),
        h("div", { class: "tl-field", style: { gridColumn: "span 2" } }, pvBtn),
        h("div", { class: "tl-field", style: { gridColumn: "span 6" } }, warn),
        h("div", { class: "tl-field", style: { gridColumn: "span 6" } },
          h("div", { class: "muted", style: { fontSize: 10.5, lineHeight: 1.6, opacity: 0.85 } },
            "说话人编号 (S1)/(S2) 由「公共前缀」里的角色顺序自动分配，同一角色跨镜头同号（音色不串）。台词请写成「角色名：台词」或「角色名说：台词」；无台词时会自动声明 No dialogue，防止模型乱配音。")));
    } else if (key === "speed") {
      const speedE = sel(SPEED_MODES.map((m) => m.v), P.speed.node);
      speedE.onchange = () => { P.speed.node = speedE.value; };
      const devE = sel(["auto", "gpu", "cpu"], P.speed.dev); devE.onchange = () => { P.speed.dev = devE.value; };
      const loraPool = ["(无)"].concat((opts.loras || []).filter((n) => /(H3|h3|minimax).*(step|turbo)|(step|turbo).*(h3|H3|minimax)|Acc-8Step|Acc-4Step|8step|4step/i.test(n)));
      const accLoraE = sel(loraPool, P.speed.lora); accLoraE.onchange = () => { P.speed.lora = accLoraE.value; };
      const accLoraSE = num(P.speed.loraS, "1", 46, 0.1); accLoraSE.oninput = () => { P.speed.loraS = Number(accLoraSE.value) || 1; };
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
      sageE.onchange = () => { P.speed.sage = sageE.value; };
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
          title: "默认：画布上出现第三方加速节点时，内置加速（BlockSparse / TE-Speed / 蒸馏 LoRA）自动失效。勾上则强制保留内置加速（可能与外部加速重复叠加）。" },
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
            const had = (P.speed.sage && P.speed.sage !== "disabled") || (P.speed.node && P.speed.node !== "off")
              || (P.speed.lora && P.speed.lora !== "(无)");
            if ((r.kinds || []).length && !P.speed.forceBuiltin) {
              P.speed.sage = "disabled"; P.speed.node = "off"; P.speed.lora = "(无)";
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
        h("div", { class: "tl-field", style: { gridColumn: "span 6", display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { class: "tl-flabel", title: "外部模型节点 / 第三方加速节点接口：外接后内置加速自动失效" }, "外部节点（模型 / 加速）"),
          h("div", { class: "row", style: { gap: 8, flexWrap: "wrap", alignItems: "center" } }, scanBtn, forceCk, extLbl),
          extBox),
        field("BlockSparse 加速", sageE, "PathchSageAttentionKJ"),
        field("TE-Speed 模式", speedE, "TESpeedMiniMaxH3"),
        field("TE-Speed 设备", devE, "device"),
        field("蒸馏 LoRA", accLoraE, "speed_lora"),
        field("蒸馏 LoRA 强度", accLoraSE, "speed_lora_strength"),
        freeCk);
    }
    return row;
  };

  const TABS = [
    { key: "mode", label: "🎬 模式" },
    { key: "model", label: "🧠 模型" },
    { key: "sample", label: "📐 采样设置" },
    { key: "audio", label: "🎙️ 声音" },
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
      for (let k = 0; k < IMG_CAP; k++) {
        const rel = c.media.image[k];
        const cell = h("div", { class: "mm-cell", title: rel ? rel : "点击上传到此格" });
        if (rel) {
          // 缩略图加载失败（素材被删 / 脏引用）→ 隐藏破图
          cell.appendChild(h("img", { src: relToViewUrl(rel), onerror: "this.style.display='none'" }));
          cell.appendChild(h("span", { class: "mm-idx" }, String(k + 1)));
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
          cell.appendChild(h("span", { class: "mm-plus" }, k === c.media.image.length ? "＋" : ""));
          cell.onclick = () => { if (k === c.media.image.length) file.click(); };
        }
        grid.appendChild(cell);
      }
    };
    paint();
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
  const subSlot = (c, slot, refreshEditor) => {
    const grid = h("div", { class: "mm-grid" });
    const up = h("input", { type: "file", multiple: true, accept: slot.accept, style: { display: "none" } });
    const isV = slot.kind === "video";
    up.onchange = async () => {
      for (const f of up.files) {
        if (c.media[slot.kind].length >= slot.cap) { ctx.toast(`${slot.label}最多 ${slot.cap} 个`, true); break; }
        const target = isV && folder() ? folder() + "/video" : folder();
        try { await ctx.api.upload(target, f); c.media[slot.kind].push((target ? target + "/" : "") + f.name); } catch (e) { ctx.toast("上传失败: " + e.message, true); }
      }
      up.value = ""; paint(); refreshEditor();
    };
    const paint = () => {
      clear(grid);
      for (let k = 0; k < slot.cap; k++) {
        const rel = c.media[slot.kind][k];
        const cell = h("div", { class: "mm-cell", title: rel ? rel : `点击上传${slot.label}` });
        if (rel) {
          if (isV) cell.appendChild(h("img", { src: editorThumbUrl(rel), onerror: "this.style.display='none'" }));
          else cell.appendChild(h("div", { style: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "#9fb0c6" } }, "♪"));
          cell.appendChild(h("span", { class: "mm-x", title: "移除", onclick: (ev) => { ev.stopPropagation(); c.media[slot.kind].splice(k, 1); paint(); refreshEditor(); } }, "✕"));
        } else {
          cell.appendChild(h("span", { class: "mm-plus" }, k === c.media[slot.kind].length ? "＋" : ""));
          cell.onclick = () => { if (k === c.media[slot.kind].length) up.click(); };
        }
        grid.appendChild(cell);
      }
    };
    paint();
    return h("div", { class: "col", style: { gap: 3 } },
      h("div", { class: "row", style: { gap: 5 } },
        h("b", { style: { fontSize: 11.5 } }, slot.label),
        h("span", { class: "muted", style: { fontSize: 11 } }, `${c.media[slot.kind].length}/${slot.cap}`),
        h("div", { class: "mx-spacer" }),
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
      ref_max_size: P.output.ref_size, frame_rate: P.output.fps, steps: P.output.steps,
      cfg: P.output.cfg, shift_video: P.output.shift_video, shift_audio: P.output.shift_audio,
      sampler: P.output.sampler || undefined, scheduler: P.output.scheduler || undefined,
      clear_vram_between_segments: P.output.clear_vram || undefined,
      export_source_images: P.output.export_src || undefined,
      refine_mode: P.output.upscale_mode === "latent" ? "latent_upscale" : undefined,
      refine_megapixels: P.output.refine_megapixels,
      refine_passes: P.output.refine_passes,
      refine_latent_model: "minimax_h3_latent_upscaler_3d_bf16.safetensors",
      speed_node: P.speed.node !== "off" ? P.speed.node : undefined,
      speed_device: P.speed.dev === "auto" ? undefined : P.speed.dev,
      speed_lora: P.speed.lora && P.speed.lora !== "(无)" ? P.speed.lora : undefined,
      speed_lora_strength: P.speed.loraS,
      sage_attention: P.speed.sage !== "disabled" ? P.speed.sage : undefined,
      // 外部节点接口：非空 = 画布上外接了第三方加速 → 后端让内置加速失效（双保险）
      external_accel: (P.speed.external && P.speed.external.length) ? P.speed.external : undefined,
      force_builtin_accel: P.speed.forceBuiltin ? true : undefined,
      // —— 声音 / 台词（H3 官方三段式）——
      av_structure: P.audio && P.audio.structure === false ? false : true,
      av_lang: (P.audio && P.audio.lang) || "Chinese",
      av_ambience: (P.audio && P.audio.ambience) || undefined,
      av_music: (P.audio && P.audio.music) || undefined,
      av_no_speech: P.audio && P.audio.no_speech ? true : undefined,
      audio_guard: P.audio && P.audio.guard === false ? false : true,
      audio_min_steps: (P.audio && P.audio.min_steps) || undefined,
    };
    Object.keys(o).forEach((k) => { if (o[k] === undefined || o[k] === "" || o[k] === null) delete o[k]; });
    return o;
  };
  // 二采高清放大（自动/手动共用）：对 rel 视频用当前引擎超分，更新 shotPreview
  const doUpscale = async (i, rel) => {
    const eng = P.output.upscale_engine || "rtx";
    // 放大倍率（用户可自定义）：RTX/Flash/VOSR2 直接吃倍数；SeedVR2 由后端按"源短边×倍率"换算目标短边
    const sc = Math.max(1, Math.min(4, Number(P.output.upscale_scale) || 2));
    const opts = eng === "rtx" ? { scale: sc, quality: "HIGH" } : eng === "seedvr2" ? { scale: sc } : eng === "vosr2" ? { scale: sc } : {};
    // 弹文件夹选择：二采视频保存到选定文件夹
    let outDir = "";
    try {
      const pick = await ctx.api.nativePick({ kind: "folder", title: "选择二采视频保存文件夹" });
      if (pick.cancel || !(pick.paths || []).length) { println("✗ 已取消二采", "#ffd98f"); return null; }
      outDir = pick.paths[0];
    } catch (_) { /* 弹不出则输出到视频同目录 */ }
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
    else if (P.mode === "r2v") payload.refs = imgs;
    println(`▶ 第${sh.index}镜（${modeLabel(P.mode)} · ${sec}s · ${isFramesMode
      ? `首帧${(frames && frames[0]) ? "✓" : "✗"} 尾帧${(frames && frames[1]) ? "✓" : "✗"}`
      : `图${imgs.length} 视${c.media.video.length} 音${c.media.audio.length}`}${(!isFramesMode && !imgs.length) ? " · 无素材(纯文本)" : ""}）`, "#9fd0ff");
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
    topVidW.style.display = custom ? "" : "none";
    topVidH.style.display = custom ? "" : "none";
    topVidW.value = P.output.width; topVidH.value = P.output.height;
  };
  const topVidSel = h("select", { class: "select", style: { width: "auto", padding: "5px 6px", fontSize: 11.5 },
    title: "视频分辨率档位（与「一键流水线」面板联动）" },
    ...VIDEO_SIZES.map(([label], i) => h("option", { value: String(i) }, label)));
  const topVidW = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 62, padding: "4px 5px", fontSize: 11.5 }, title: "自定义宽（32 对齐）" });
  const topVidH = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 62, padding: "4px 5px", fontSize: 11.5 }, title: "自定义高（32 对齐）" });
  topVidSel.onchange = () => {
    const idx = Number(topVidSel.value) || 0;
    const [w, hgt] = resolveVidSize(idx, ctx.store.get().vidW, ctx.store.get().vidH);
    ctx.store.set({ vidSize: idx, vidW: w, vidH: hgt });
    P.output.width = w; P.output.height = hgt;
    refreshTopVid(); renderTrack();
  };
  const _topVidCustom = () => {
    const w = Math.max(64, Math.round((Number(topVidW.value) || P.output.width) / 32) * 32);
    const hgt = Math.max(64, Math.round((Number(topVidH.value) || P.output.height) / 32) * 32);
    ctx.store.set({ vidSize: CUSTOM_VID_SIZE_INDEX, vidW: w, vidH: hgt });
    P.output.width = w; P.output.height = hgt;
    renderTrack();
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
      refreshExportModeBtn();
      renderAll();
    },
  });
  function refreshExportModeBtn() {
    const isAll = P.output.exportMode !== "segments";
    exportModeBtn.textContent = isAll ? "🎬 全部导出（拼接）" : "📦 分段导出（独立）";
    exportModeBtn.classList.toggle("btn-primary", isAll);
  }
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

  const renderAll = () => { syncPlanStamp(); renderTrack(); renderEditor(); };
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

  const el = h("div", { class: "col", style: { flex: "1 1 0", minHeight: 0, gap: 6 } },
    h("div", { class: "col", style: { gap: 4, flex: "0 0 auto" } }, tabBar, paramRow),
    h("div", { class: "row", style: { flex: "0 0 auto", gap: 6, flexWrap: "wrap", alignItems: "center" } },
      runAllBtn,
      runSelBtn,
      selAllBtn,
      h("span", { class: "muted", style: { fontSize: 11 } }, "分辨率"), topVidSel, topVidW, topVidH,
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
      h("span", { class: "muted", style: { fontSize: 10.5 } }, upModeSel && upModeSel.value === "auto" ? "（出片后自动二采）" : upModeSel && upModeSel.value === "manual" ? "（出片后点预览区二采）" : "（仅一采）"),
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
    // 打开即用：模型字段为空时自动选中本机推荐默认模型（不覆盖用户已选）
    if (opts && opts.defaults) {
      const d = opts.defaults;
      if (!P.model.unet && d.unet) P.model.unet = d.unet;
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
