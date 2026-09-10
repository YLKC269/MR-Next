// panels/editor.js — 剪辑（剪映式）：素材栏(多选删除) + 预览 + V1/V2 视频轨 + A1 音频轨 → 合成
import { h, clear } from "../core/dom.js";
import { relToViewUrl, editorThumbUrl } from "../core/api.js";
import { assetRegistry } from "../core/assets.js";

// 面板可能被重建（切换导航），文档级监听器必须换新前解绑旧的，否则重复触发/泄漏
let _prevKeys = null;

// ---- 全局快捷键护栏 ----
// ComfyUI 自己也把 Ctrl+Z（撤销工作流）绑在 window 的捕获阶段，且注册得比扩展早。
// 若等到「面板创建」时才注册，我们的 handler 永远排在它后面 → 一次 Ctrl+Z 会同时
// 把画布上的 MRBoard 节点撤掉（表现为面板 DOM 被拆、后续交互全部失效）。
// 因此这里在**模块加载期**就抢注一个 window 捕获监听，把当前激活剪辑面板的处理函数
// 转发进去；只要模块比 ComfyUI 的热键注册得更早，就能第一时间吃掉这几个键。
let _activeEditorKeyHandler = null;
try {
  window.addEventListener("keydown", (e) => {
    if (typeof _activeEditorKeyHandler === "function") {
      try { _activeEditorKeyHandler(e); } catch (_) {}
    }
  }, true);
} catch (_) {}

const F_MEDIA = [
  ["视频", "*.mp4 *.mov *.webm *.mkv *.m4v"],
  ["音频", "*.wav *.mp3 *.flac *.ogg *.m4a"],
  ["全部", "*.*"],
];

export function createEditorPanel(ctx) {
  const folder = () => ctx.store.get().folder || "mrboard_next";
  const materials = []; // {rel,kind,name}
  const v1 = []; // 视频主轨
  const v2 = []; // 视频副轨
  const a1 = []; // 音频轨
  let tab = "all";
  let selected = null; // {row,idx,obj}
  const delSet = new Set(); // 素材多选删除

  // ---------- 剪映式时间轴：像素/秒、播放头、吸附步长 ----------
  const PPS = 30;        // 时间轴基准缩放：30px = 1s（素材放得下时用这个）
  // ---- 自适应缩放（fit-to-width）：素材一多自动缩小比例，让整条时间线放得进轨道可视宽度 ----
  // 以前比例固定 30px/s：片段一多 → .ed-track 的 scrollWidth > clientWidth，
  // 末尾片段被顶到可视区外（看起来"被裁切"），而且标尺是独立元素、不跟轨道滚 →
  // 刻度与片段错位。现在按"整条时长 ÷ 轨道内宽"自动算比例；实在太多片段时停止缩小、
  // 保留横向滚动（标尺/三条轨一起滚）。
  const MIN_FIT_PPS = 1.5;   // 比例下限（px/秒）：再挤也不小于它
  const MIN_CLIP_PX = 20;    // 片段平均宽度软下限：低于它就不再缩，改由横向滚动兜底
  let ppsNow = PPS;          // 当前实际比例（标尺/播放头/裁剪换算全部用它）
  // 注意：必须用"布局像素"（clientWidth），不能用 getBoundingClientRect().width ——
  // 后者含画布缩放（实测 0.9），会把缩放系数带进宽度计算，导致自适应永远填不满。
  const trackBoxW = () => {
    try {
      const w = rowV1.clientWidth;
      if (w > 40) return w + 2;   // +2 = 左右边框，还原成 border-box 宽
    } catch (_) {}
    return 900;
  };
  const trackInnerW = () => {
    // 可用裁剪宽度 = 轨道宽 - 轨标签(46) - 边框与内边距(12) - 标签与首片段间距(6)
    //                - 片段之间的 gap(6×(n-1)) - 余量(6)
    const n = Math.max(v1.length, v2.length, a1.length, 1);
    return Math.max(90, trackBoxW() - 46 - 12 - 6 - 6 * Math.max(0, n - 1) - 6);
  };
  const recalcFit = () => {
    const avail = trackInnerW();
    const span = Math.max(trackDur(v1), trackDur(v2), trackDur(a1));
    const n = Math.max(v1.length, v2.length, a1.length, 1);
    let p = PPS;
    if (span > 0.01) {
      p = Math.min(PPS, avail / span);                                  // ① 整条放得进可视宽度
      const avg = span / n;                                             // ② 但别把片段压到看不清
      p = Math.max(p, Math.min(PPS, MIN_CLIP_PX / Math.max(0.01, avg)));
    }
    const changed = Math.abs(p - ppsNow) > 0.01;
    ppsNow = Math.max(MIN_FIT_PPS, p);
    return changed;
  };
  // ---- 画布缩放补偿 ----
  // 节点 DOM widget 会被 ComfyUI 画布整体缩放（实测 0.9）：指针事件给的是"屏幕像素"，
  // 而我们的 left/width 是"布局像素"。换算像素↔秒时必须除以这个系数，
  // 否则拖动播放头/裁剪边缘会整体偏小（缩放 90% 时偏差 10%，越拖越不准）。
  const uiScale = () => {
    try {
      const w = ruler.offsetWidth || 0;
      const r = ruler.getBoundingClientRect().width || 0;
      if (w > 0 && r > 0) return r / w;
    } catch (_) {}
    return 1;
  };
  const SNAP = 0.1;      // 吸附步长（秒）
  const snapTo = (v) => Math.round(v / SNAP) * SNAP;
  let playheadSec = 0;   // 播放头位置（秒，整条时间轴）

  // 片段有效播放时长（考虑入出点裁剪 + 变速）
  const effDur = (c) => {
    if (!c) return 0;
    const base = c.in || 0;
    const out = (c.out != null && c.dur ? Math.min(c.out, c.dur) : c.out);
    const len = (out != null && out > base) ? (out - base) : Math.max(0, (c.dur || 0) - base);
    const spd = Math.max(0.5, Math.min(2, Number(c.speed) || 1));
    return Math.max(0.1, len / spd);
  };
  const trackDur = (arr) => (arr || []).reduce((a, c) => a + effDur(c), 0);

  // ---------- 丝滑剪辑基础设施 ----------
  // 1) 片段对象 → DOM 元素（拖拽/异步探时长后只改这一个元素，不做全量重绘）
  const _clipEls = new Map();
  // 2) 全局共用一个裁剪浮层提示（拖拽时显示实时入出点/时长）
  let _trimTip = null;
  const getTrimTip = () => {
    if (_trimTip && _trimTip.isConnected) return _trimTip;
    _trimTip = document.createElement("div");
    _trimTip.className = "ed-trimtip";
    document.body.appendChild(_trimTip);
    return _trimTip;
  };
  // 3) rAF 节流器：一次屏幕刷新最多处理一次 pointermove，避免高频事件拖垮主线程
  const rafThrottle = (fn) => {
    let queued = false, lastArg = null;
    return (arg) => {
      lastArg = arg;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn(lastArg); });
    };
  };
  // 片段宽度按当前自适应比例换算（下限 8px，几乎不参与布局；主要由 ppsNow 决定总宽）
  const clipW = (c) => Math.max(8, Math.min(460, Math.round(effDur(c) * ppsNow)));
  const fmt = (s) => (s == null ? "?" : Number(s).toFixed(1) + "s");
  const MINLEN = 0.1;   // 片段最短时长（秒），裁剪拖拽的下限
  const clampSpeed = (c) => Math.max(0.5, Math.min(2, Number(c && c.speed) || 1));
  // 探时长结果缓存：重复入轨不重复请求 ffprobe（「全部入轨」不再卡）
  const probeCache = new Map();
  // 预览视频当前对应哪个 V1 片段 + 它的前置累计时长（用于播放时播放头实时跟随）
  let _previewClip = null, _previewAcc = 0;
  // 只刷新单个片段的宽度 + 时长读数（<1ms，不触碰其它 DOM）
  const updateClipVisual = (c) => {
    const el = _clipEls.get(c);
    if (!el) return;
    const w = clipW(c);
    el.style.width = w + "px";
    el.style.minWidth = w + "px";
    const cd = el.querySelector(".cd");
    if (cd) cd.textContent = fmt(effDur(c));
  };

  // ---------- 撤销 / 重做（剪映式 Ctrl+Z / Ctrl+Shift+Z） ----------
  const _snap = () => JSON.stringify({ v1, v2, a1 });
  const undoStack = [];
  let redoStack = [];
  const pushHistory = () => {
    undoStack.push(_snap());
    if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
  };
  const _applySnap = (js) => {
    const o = JSON.parse(js);
    v1.length = 0; v2.length = 0; a1.length = 0;
    (o.v1 || []).forEach((x) => v1.push(x));
    (o.v2 || []).forEach((x) => v2.push(x));
    (o.a1 || []).forEach((x) => a1.push(x));
    selected = null;
    renderTracks(); renderEdit(); syncMatSel();
  };
  const doUndo = () => {
    if (!undoStack.length) { ctx.toast("没有可撤销的操作"); return; }
    redoStack.push(_snap()); _applySnap(undoStack.pop()); ctx.toast("已撤销");
  };
  const doRedo = () => {
    if (!redoStack.length) { ctx.toast("没有可重做的操作"); return; }
    undoStack.push(_snap()); _applySnap(redoStack.pop()); ctx.toast("已重做");
  };

  // ---- 预览 ----
  const video = h("video", { controls: true, playsInline: true });
  const ph = h("div", { class: "ph" }, "点选下方素材 / 成片预览");
  const preview = h("div", { class: "ed-preview" }, ph, video);
  const result = h("div", { class: "muted" });

  // ---- 连播预览：把 V1 主轨的多段素材按顺序无缝串联播放（双缓冲：当前段播完立即切预载好的下一段）----
  // 内置剪映式控制：暂停/继续、下一段、✂ 在当前播放位置分割当前段（直接写回轨道）
  const playSequential = (clips) => {
    const list = clips.filter((c) => c && c.rel);
    if (!list.length) { ctx.toast("轨道是空的——先把素材加进 V1 主轨", true); return; }
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(2,4,9,.94);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;";
    const stage = document.createElement("div");
    stage.style.cssText = "position:relative;width:min(88vw,1100px);aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;box-shadow:0 12px 60px rgba(0,0,0,.7);";
    const mk = () => {
      const v = document.createElement("video");
      // 默认有声（连播预览由用户点击触发，属用户手势，允许非静音播放）；
      // 若浏览器策略拦截，play() 失败会自动降级为静音播放 + 控制条出现「🔊 取消静音」
      v.muted = false; v.playsInline = true; v.preload = "auto";
      v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;";
      stage.appendChild(v);
      return v;
    };
    const va = mk(), vb = mk();
    vb.style.display = "none";
    const lbl = document.createElement("div");
    lbl.style.cssText = "color:#ffcf6b;font-size:13px;font-weight:700;";
    const ctl = document.createElement("div");
    ctl.style.cssText = "display:flex;gap:8px;align-items:center;";
    const mkBtn = (text, title, fn) => {
      const btn = document.createElement("button");
      btn.textContent = text; btn.title = title;
      btn.style.cssText = "padding:7px 14px;border-radius:8px;border:1px solid rgba(255,207,102,.5);background:#141d30;color:#ffcf6b;font-size:12.5px;font-weight:700;cursor:pointer;";
      btn.onclick = fn;
      ctl.appendChild(btn);
      return btn;
    };
    const closeBtn = mkBtn("✕ 关闭预览", "关闭（Esc）", () => close());
    ov.append(stage, lbl, ctl);
    document.body.appendChild(ov);
    let idx = 0, cur = va, nxt = vb, stopped = false, paused = false;
    const close = () => { stopped = true; try { va.pause(); vb.pause(); } catch (_) {} ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    const segDur = (c) => {
      const a = c.in || 0;
      const b = (c.out != null && c.dur ? Math.min(c.out, c.dur) : c.out);
      return (b && b > a) ? (b - a) : (c.dur || 0);
    };
    const totalTime = () => list.reduce((a, c) => a + segDur(c), 0);
    const show = (i) => {
      const c = list[i];
      const done = list.slice(0, i).reduce((a, x) => a + segDur(x), 0);
      lbl.textContent = `▶ 连播预览  第 ${i + 1} / ${list.length} 段 · ${c.name || ""}（累计 ${done.toFixed(1)}s / 约 ${totalTime().toFixed(1)}s）`;
    };
    // 预览内分割：把当前段在当前播放位置切成两段，直接写回轨道数组
    const splitHere = () => {
      const c = list[idx];
      const t = cur.currentTime || 0;
      const base = c.in || 0;
      const splitAt = t - base;
      const effDur = c.dur != null ? ((c.out != null ? Math.min(c.out, c.dur) : c.out ?? c.dur) - base) : null;
      if (splitAt <= 0.08 || (effDur != null && splitAt >= effDur - 0.08)) { ctx.toast("播放头太靠近段边，无法分割", true); return; }
      const at = clips.indexOf(c);
      if (at < 0) { ctx.toast("片段不在 V1 轨上", true); return; }
      const tail = { rel: c.rel, name: c.name, dur: c.dur, in: base + splitAt, out: c.out };
      c.out = base + splitAt;
      clips.splice(at + 1, 0, tail);
      list.splice(idx + 1, 0, tail);
      renderTracks(); renderEdit();
      ctx.toast(`✂ 已在 ${splitAt.toFixed(1)}s 处分割为两段（轨道已更新）`);
      show(idx);
    };
    const pauseBtn = mkBtn("⏸ 暂停", "暂停 / 继续", () => {
      paused = !paused;
      if (paused) cur.pause(); else cur.play().catch(() => {});
      pauseBtn.textContent = paused ? "▶ 继续" : "⏸ 暂停";
    });
    // 🔊 静音切换（浏览器自动播放策略拦截时会自动降级静音，用这个按钮解除）
    let userMuted = false;
    const muteBtn = mkBtn("🔊 声音开", "切换静音 / 有声", () => {
      userMuted = !userMuted;
      va.muted = userMuted; vb.muted = userMuted;
      muteBtn.textContent = userMuted ? "🔇 静音" : "🔊 声音开";
      if (!userMuted && cur.paused && !paused) cur.play().catch(() => {});
    });
    mkBtn("✂ 分割此处", "在当前播放位置把这一段切成两段（写回轨道）", splitHere);
    mkBtn("⏭ 下一段", "跳到下一段", () => { cur.pause(); advance(); });
    const playSeg = (v, i) => {
      if (stopped || i >= list.length) { if (!stopped) close(); return; }
      const c = list[i];
      show(i);
      v.style.display = "block";
      (v === va ? vb : va).style.display = "none";
      v.src = relToViewUrl(c.rel);
      v.onloadedmetadata = () => {
        if (stopped) return;
        const a = c.in || 0;
        try { if (a > 0) v.currentTime = a; } catch (_) {}
        // 有声播放被浏览器策略拦截 → 降级静音播 + 提示用「🔊 声音开」解除
        v.play().catch(() => {
          v.muted = true;
          v.play().then(() => { muteBtn.textContent = "🔇 静音（已自动静音，点此解除）"; }).catch(() => {});
        });
      };
      v.ontimeupdate = () => {
        if (stopped) return;
        const b = (c.out != null && c.dur ? Math.min(c.out, c.dur) : c.out);
        if (b && b > (c.in || 0) && v.currentTime >= b) { v.pause(); advance(); }
      };
      v.onended = () => { if (!stopped) advance(); };
      // 预载下一段到另一个 video
      const nx = list[i + 1];
      if (nx) { nxt.src = relToViewUrl(nx.rel); nxt.load(); }
    };
    const advance = () => {
      idx += 1;
      if (idx >= list.length || stopped) { close(); return; }
      [cur, nxt] = [nxt, cur]; // 交换：预载好的顶上，旧的变预载器
      paused = false; pauseBtn.textContent = "⏸ 暂停";
      playSeg(cur, idx);
    };
    playSeg(va, 0);
  };

  // 记住预览当前放的是 V1 上的哪一段（播放时播放头才能跟着走）
  const markPreviewClip = (rel) => {
    let acc = 0;
    _previewClip = null; _previewAcc = 0;
    for (const c of v1) {
      if (c && c.rel === rel) { _previewClip = c; _previewAcc = acc; break; }
      acc += effDur(c);
    }
  };
  const showVideo = (rel) => {
    if (!rel) return;
    video.src = relToViewUrl(rel);
    video.style.display = "block";
    ph.style.display = "none";
    markPreviewClip(rel);
  };
  const showNote = (t) => {
    ph.textContent = t;
    ph.style.display = "flex";
    video.style.display = "none";
  };

  // ---- 素材池（多选删除；仅视频+音频，不含图片）----
  const matsRow = h("div", { class: "ed-mats" });
  const tabSel = h(
    "select", { class: "select", style: { width: "auto" } },
    ...["all", "video", "audio"].map((k) => h("option", { value: k }, k === "all" ? "全部素材" : k))
  );
  const matCount = h("span", { class: "muted" });

  let _refreshing = false;
  const refreshMaterials = async () => {
    if (_refreshing) return;   // 防重入：create 手动调用 + activate update 会并发触发，导致素材重复
    _refreshing = true;
    try {
      clear(matsRow);
      materials.length = 0;
      try {
        const au = await ctx.api.files(folder(), "audio");
        for (const f of au.files || []) materials.push({ rel: (folder() ? folder() + "/" : "") + f.name, kind: "audio", name: f.name });
        const vd = await ctx.api.videos(folder());
        for (const f of vd.videos || []) materials.push({ rel: f.rel || (folder() ? folder() + "/video/" : "video/") + f.name, kind: "video", name: f.name });
      } catch (e) {
        ctx.toast("素材扫描失败: " + e.message, true);
      }
      renderMats();
      // 接收时间线「去剪辑」发来的视频：自动加到 V1 轨并预览
      const pending = ctx.store.get().pendingEditorVideo;
      if (pending) {
        ctx.store.set({ pendingEditorVideo: null });
        const m = materials.find((x) => x.rel === pending);
        if (m && m.kind === "video") {
          addToTrack(v1, m);
          selected = { row: null, idx: -1, obj: m };
          showVideo(m.rel);
          renderMats();
          renderTracks();
          renderEdit();
          ctx.toast("已加入 V1 轨：" + m.name);
        } else {
          ctx.toast("未在素材库找到该视频：" + pending, true);
        }
      }
    } finally {
      _refreshing = false;
    }
  };

  const delLbl = h("span", { class: "muted" });
  const _matCards = new Map();   // rel → { card, m }：选中态只切类名，不重建缩略图
  const renderMats = () => {
    const sc = matsRow.scrollLeft;          // 保留滚动位置（重建不再"跳回开头"）
    clear(matsRow);
    _matCards.clear();
    const shown = materials.filter((m) => tab === "all" || m.kind === tab);
    matCount.textContent = `${shown.length} 个素材`;
    for (const m of shown) {
      const card = h("div", { class: "ed-mat" + (selected && selected.obj === m ? " sel" : "") + (delSet.has(m.rel) ? " chk" : ""), onclick: () => pickMaterial(m) });
      // 缩略图加载失败 → 隐藏破图
      if (m.kind === "video") card.appendChild(h("img", { src: editorThumbUrl(m.rel), alt: m.name, loading: "lazy", onerror: "this.style.display='none'" }));
      else card.appendChild(h("div", { style: { height: 54, lineHeight: "54px", fontSize: 20 } }, "♪"));
      card.appendChild(h("div", { class: "mi" }, m.name));
      // 多选删除勾选框（onclick 阻止冒泡，避免触发 card 的 pickMaterial 重渲染把勾选状态冲掉）
      const ck = h("input", { type: "checkbox", style: { position: "absolute", top: 4, left: 4, width: 16, height: 16, cursor: "pointer", zIndex: 2 } });
      ck.checked = delSet.has(m.rel);
      ck.onclick = (e) => { e.stopPropagation(); };
      ck.onchange = (e) => { e.stopPropagation(); if (ck.checked) delSet.add(m.rel); else delSet.delete(m.rel); card.classList.toggle("chk", ck.checked); delLbl.textContent = delSet.size ? `已选 ${delSet.size}` : ""; };
      card.style.position = "relative";
      card.appendChild(ck);
      matsRow.appendChild(card);
      _matCards.set(m.rel, { card, m });
    }
    matsRow.scrollLeft = sc;
  };
  // 只同步"选中"样式：素材上百个时点一下不再重建整排缩略图（原实现每次点击都重建 → 卡）
  const syncMatSel = () => {
    for (const rec of _matCards.values()) rec.card.classList.toggle("sel", !!(selected && selected.obj === rec.m));
  };

  const pickMaterial = (m) => {
    if (m.kind === "video") showVideo(m.rel);
    else showNote("音频：" + m.name + "（可加入 A1 音频轨）");
    selected = { row: null, idx: -1, obj: m };
    syncMatSel();
    renderEdit();
  };

  // ---- 轨道 ----
  // 时间标尺（秒刻度 + 可点击定位播放头）——剪映式
  const ruler = h("div", { class: "ed-ruler", style: { position: "relative", height: 22, margin: "0 0 4px 0",
    background: "rgba(8,14,28,.6)", border: "1px solid #1d2b44", borderRadius: 6, overflow: "hidden", cursor: "pointer" } });
  const playheadEl = h("div", { style: { position: "absolute", top: 0, bottom: 0, width: 2, background: "#ffcf6b",
    boxShadow: "0 0 6px #ffcf6b", pointerEvents: "none", left: 0 } });
  let _rulerTotal = -1;   // 缓存：总时长没变就不重建刻度（拖拽时省掉上百个 DOM 节点）
  const drawPlayhead = () => {
    playheadEl.style.left = Math.round(playheadSec * ppsNow) + "px";
  };
  const renderRuler = () => {
    const total = Math.max(4, Math.max(trackDur(v1), trackDur(v2)));
    if (Math.abs(total - _rulerTotal) < 1e-6) {
      drawPlayhead();
      return;
    }
    _rulerTotal = total;
    clear(ruler);
    // 刻度步长随缩放自适应：比例小的时候不再画几百条线（可视区里保持 8~60 个主刻度）
    const px = Math.min(8000, Math.round(total * ppsNow));
    const stepSec = Math.max(1, Math.ceil(total / Math.max(6, Math.min(60, Math.round(trackInnerW() / 62)))));
    for (let t = 0; t <= total + 0.001; t += stepSec) {
      const x = Math.round(t * ppsNow);
      const major = t === 0 || Math.abs((t / stepSec) % 5) < 1e-6;
      ruler.appendChild(h("div", { style: { position: "absolute", left: x + "px", bottom: 0,
        width: 1, height: major ? 12 : 6, background: major ? "#5b7ba6" : "#31456b" } }));
      if (major) ruler.appendChild(h("span", { style: { position: "absolute", left: (x + 3) + "px", top: 1,
        fontSize: 10, color: "#7d9dba", userSelect: "none" } }, Math.round(t * 10) / 10 + "s"));
    }
    ruler.appendChild(playheadEl);
    ruler.style.minWidth = px + "px";
    drawPlayhead();
  };

  // ---- 播放头：只改 left（零重排），拖动时 rAF 节流跟手 ----
  const setPlayhead = (sec, seekPreview) => {
    playheadSec = Math.max(0, snapTo(sec));
    drawPlayhead();
    if (!seekPreview) return;
    let acc = 0;
    for (const c of v1) {
      const d = effDur(c);
      if (playheadSec <= acc + d + 1e-6) {
        if (video.src && c.rel) {
          const local = (c.in || 0) + (playheadSec - acc) * clampSpeed(c);
          try { video.currentTime = local; } catch (_) {}
        }
        break;
      }
      acc += d;
    }
  };
  const _scrubTip = () => getTrimTip();
  ruler.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const tip = _scrubTip();
    const r0 = ruler.getBoundingClientRect();
    // 指针 → 秒：比例用自适应值；标尺在溢出兜底时被 translateX 平移，r0 已含偏移，无需再加
    const px2sec = (clientX) => Math.max(0, (clientX - r0.left) / (ppsNow * uiScale()));
    const paintHead = rafThrottle((clientX) => {
      setPlayhead(px2sec(clientX), false);
      tip.textContent = `播放头 ${playheadSec.toFixed(1)}s`;
      tip.style.left = clientX + "px";
      tip.style.top = (r0.top - 6) + "px";
      tip.classList.add("on");
    });
    setPlayhead(px2sec(e.clientX), false);
    ruler.classList.add("dragging");
    const mv = (e2) => paintHead(e2.clientX);
    const up = (e2) => {
      document.removeEventListener("pointermove", mv);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      ruler.classList.remove("dragging");
      tip.classList.remove("on");
      setPlayhead(playheadSec, true);      // 松手才真的 seek 预览（拖动期间不 seek，避免解码抖动）
      ctx.toast(`播放头 ${playheadSec.toFixed(1)}s`);
    };
    document.addEventListener("pointermove", mv, { passive: true });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  });

  // 自适应缩放提示（比例 < 基准时才显示，如「已自适应 12.0px/s · 整条 45.0s 全览」）
  const fitLbl = h("span", { class: "muted", style: { fontSize: 10.5 } });
  const rowV1 = h("div", { class: "ed-track" });
  const rowV2 = h("div", { class: "ed-track" });
  const rowA1 = h("div", { class: "ed-track" });
  let dragFrom = null;

  // ---- 轨道 ↔ 标尺横向滚动同步 ----
  // 比例自适应后一般放得下（不滚动）；万一素材极多仍溢出，三条轨 + 标尺共用同一个
  // 横向偏移（标尺用 translateX 跟随），否则滚了轨道刻度还停在原处、和片段对不上。
  const syncHScroll = (src) => {
    const x = Math.max(0, src.scrollLeft || 0);
    [rowV1, rowV2, rowA1].forEach((el) => { if (el !== src && el.scrollLeft !== x) el.scrollLeft = x; });
    ruler.style.transform = x ? "translateX(" + (-x) + "px)" : "";
  };
  [rowV1, rowV2, rowA1].forEach((el) => el.addEventListener("scroll", () => syncHScroll(el), { passive: true }));

  // ---- 面板宽度变化（节点缩放 / 协作台抽屉开合）→ 重算比例并重绘 ----
  // 只在比例真的变了才重建轨道，避免"重建→尺寸微变→再重建"的抖动循环
  if (typeof ResizeObserver === "function") {
    let _roRaf = 0;
    const ro = new ResizeObserver(() => {
      if (_roRaf) return;
      _roRaf = requestAnimationFrame(() => {
        _roRaf = 0;
        try { if (!el.isConnected) return; } catch (_) { return; }
        const changed = recalcFit();
        if (changed) renderTracks();
        renderRuler();
      });
    });
    try { ro.observe(rowV1); } catch (_) {}
  }

  // 探时长（带缓存）：回来后只刷新该片段宽度 + 标尺（总时长没变则连标尺也不重建）
  const probeDur = (clip) => {
    if (!clip || !clip.rel) return;
    if (probeCache.has(clip.rel)) { clip.dur = probeCache.get(clip.rel); updateClipVisual(clip); refitSoon(); return; }
    ctx.api.probeEditor(clip.rel).then((p) => {
      const d = (p && p.duration != null) ? Number(p.duration) : null;
      if (d != null) probeCache.set(clip.rel, d);
      clip.dur = d;
      updateClipVisual(clip);
      refitSoon();     // 总时长变了 → 重算自适应比例
      renderRuler();
    }).catch(() => { clip.dur = null; });
  };

  const addToTrack = (arr, m) => {
    if (!m) return;
    if (arr === a1) {
      if (m.kind !== "audio") { ctx.toast("音频轨只能放音频素材", true); return; }
    } else if (m.kind !== "video") { ctx.toast("视频轨只能放视频素材", true); return; }
    pushHistory();
    const clip = { rel: m.rel, name: m.name, dur: null, in: null, out: null };
    arr.push(clip);
    renderTracks();
    if (m.kind === "video") probeDur(clip);
  };

  // 批量入轨：只做 1 次全量重绘 + 异步补时长（「⏩ 全部入轨」不再逐个重绘卡顿）
  const addManyToTrack = (arr, list) => {
    const ok = (list || []).filter((m) => m && m.kind === "video");
    if (!ok.length) return 0;
    pushHistory();
    const clips = ok.map((m) => ({ rel: m.rel, name: m.name, dur: null, in: null, out: null }));
    arr.push(...clips);
    renderTracks();
    clips.forEach(probeDur);
    return clips.length;
  };

  const updateFitLabel = () => {
    try {
      const _span = Math.max(trackDur(v1), trackDur(v2), trackDur(a1));
      fitLbl.textContent = ppsNow < PPS - 0.5
        ? `（已自适应缩放 ${ppsNow.toFixed(1)}px/s，整条 ${_span.toFixed(1)}s 全览）` : "";
    } catch (_) {}
  };
  // ★ 时长是"异步探回来"的：addManyToTrack 入轨那一刻 clip.dur 还是 null（按 0.1s 算），
  //   等 ffprobe 结果回来总时长才变长 → 必须重算一次自适应比例，否则永远按 0.1s 判"放得下"。
  //   这里只就地改每个片段的宽度（不重建 DOM），保持丝滑。
  let _fitRaf = 0;
  const refitSoon = () => {
    if (_fitRaf) return;
    _fitRaf = requestAnimationFrame(() => {
      _fitRaf = 0;
      if (!recalcFit()) { renderRuler(); return; }
      _clipEls.forEach((el, c) => {
        const w = clipW(c);
        el.style.width = w + "px";
        el.style.minWidth = w + "px";
      });
      updateFitLabel();
      renderRuler();
    });
  };

  const renderTracks = () => {
    // 先按当前素材量算一次自适应比例（决定片段宽度），再重建轨道
    recalcFit();
    updateFitLabel();
    clear(rowV1); clear(rowV2); clear(rowA1);
    _clipEls.clear();
    [[v1, rowV1, "V1 视频主轨"], [v2, rowV2, "V2 视频副轨"], [a1, rowA1, "A1 音频轨"]].forEach(([arr, row, label]) => {
      row.appendChild(h("div", { class: "ed-track-lbl" }, label));
      row.ondragover = (e) => e.preventDefault();
      row.ondrop = (e) => {
        e.preventDefault();
        if (!dragFrom) return;
        const [sa, si] = dragFrom;
        dragFrom = null;
        pushHistory();
        const it = sa.splice(si, 1)[0];
        if (it) { arr.push(it); renderTracks(); }
      };
      arr.forEach((c, i) => {
        if (c === null) return;
        const trimmed = (c.in != null || c.out != null) ? " ✂" : ""; // 有裁剪标记
        const spd = clampSpeed(c);
        const badge = [];
        if (spd !== 1) badge.push(spd + "×");
        if (c.muted) badge.push("🔇");
        else if (c.volume != null && Math.abs(Number(c.volume) - 1) > 1e-6) badge.push("🔊" + c.volume);
        const wpx = clipW(c);
        const el = h("div", {
          class: "ed-clip" + (selected && selected.row === arr && selected.idx === i ? " sel" : ""),
          draggable: "true",
          style: { width: wpx + "px", minWidth: wpx + "px", position: "relative", flex: "0 0 auto" },
          title: `${c.name}\n时长 ${fmt(c.dur)}${c.in != null || c.out != null ? " · 已裁剪 ✂" : ""}${spd !== 1 ? " · 变速 " + spd + "×" : ""}\n拖动左右边缘可裁剪时长（吸附 0.1s）`,
          onclick: () => { selected = { row: arr, idx: i, obj: c }; renderTracks(); renderEdit(); if (c.rel && arr !== a1) showVideo(c.rel); },
        },
          h("div", { class: "nm", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.name + trimmed),
          h("div", { class: "row", style: { gap: 4, alignItems: "center" } },
            h("div", { class: "cd" }, fmt(effDur(c))),
            badge.length ? h("span", { style: { fontSize: 10, color: "#ffcf6b" } }, badge.join(" ")) : null),
          h("div", { style: { cursor: "pointer", color: "#ff9d9d", fontSize: 11, position: "absolute", right: 3, top: 1 }, onclick: (e) => { e.stopPropagation(); pushHistory(); arr.splice(i, 1); selected = null; renderTracks(); renderEdit(); } }, "✕"),
          // 左右裁剪把手（拖拽改入出点，吸附 0.1s）——剪映式边缘拖拽
          h("div", { class: "ed-handle", style: { position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: "rgba(255,207,107,.35)" }, title: "拖拽改「入点」" }),
          h("div", { class: "ed-handle", style: { position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: "rgba(255,207,107,.35)" }, title: "拖拽改「出点」" }));
        _clipEls.set(c, el);
        // 绑定裁剪拖拽（丝滑版：pointermove 只改被拖片段宽度 + 浮层提示，零全量重绘）
        const hd = el.querySelectorAll(".ed-handle");
        const bindTrim = (node, side) => {
          node.addEventListener("pointerdown", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            if (!c.dur) { ctx.toast("该素材缺少时长信息，无法拖拽裁剪（可用下方入点/出点输入框）", true); return; }
            pushHistory();
            const startX = ev.clientX;
            const in0 = c.in != null ? c.in : 0;
            const out0 = (c.out != null ? c.out : c.dur);
            const MAXLEN = c.dur;
            const tip = getTrimTip();
            let lastEv = null;

            // —— 每个动画帧只做：算新入出点 → 写 1 个宽度 → 更新浮层文字 ——
            const paint = () => {
              const e2 = lastEv;
              if (!e2) return;
              // 屏幕像素 → 秒：先补画布缩放系数，再除自适应比例；按变速折算到源时间
              const ds = ((e2.clientX - startX) / (ppsNow * uiScale())) * spd;
              if (side === "in") {
                c.in = Math.max(0, Math.min(snapTo(in0 + ds), out0 - MINLEN));
              } else {
                c.out = Math.max(in0 + MINLEN, Math.min(snapTo(out0 + ds), MAXLEN));
              }
              updateClipVisual(c);
              tip.textContent =
                `${side === "in" ? "入点" : "出点"} ${((side === "in" ? c.in : c.out) || 0).toFixed(2)}s` +
                ` · 时长 ${effDur(c).toFixed(2)}s`;
              tip.style.left = e2.clientX + "px";
              tip.style.top = e2.clientY + "px";
              tip.classList.add("on");
            };
            const onMove = rafThrottle((e2) => { lastEv = e2; paint(); });

            el.classList.add("trimming");
            node.classList.add("hot");
            row.classList.add("dragging");
            try { node.setPointerCapture(ev.pointerId); } catch (_) {}
            const up = () => {
              document.removeEventListener("pointermove", onMove);
              document.removeEventListener("pointerup", up);
              document.removeEventListener("pointercancel", up);
              el.classList.remove("trimming");
              node.classList.remove("hot");
              row.classList.remove("dragging");
              tip.classList.remove("on");
              // 收尾才做一次全量重绘（标尺/吸附后的最终宽度）
              renderTracks(); renderEdit();
              if (selected && selected.obj === c) { inIn.value = c.in == null ? "" : c.in; outIn.value = c.out == null ? "" : c.out; }
            };
            document.addEventListener("pointermove", onMove, { passive: true });
            document.addEventListener("pointerup", up);
            document.addEventListener("pointercancel", up);
            // 立即给一次反馈（不移动也能看到提示）
            lastEv = { clientX: ev.clientX, clientY: ev.clientY };
            paint();
          });
        };
        bindTrim(hd[0], "in");
        bindTrim(hd[1], "out");
        // 悬浮排序条：◀ 左移 / 右移 ▶（不用拖拽也能调顺序）
        const mv = h("div", { class: "row", style: { gap: 3, marginTop: 3 } });
        if (i > 0) {
          mv.appendChild(h("span", { title: "左移一位", style: { cursor: "pointer", color: "#9fd0ff", fontSize: 11 },
            onclick: (e) => { e.stopPropagation(); pushHistory(); [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; renderTracks(); } }, "◀"));
        }
        if (i < arr.length - 1) {
          mv.appendChild(h("span", { title: "右移一位", style: { cursor: "pointer", color: "#9fd0ff", fontSize: 11 },
            onclick: (e) => { e.stopPropagation(); pushHistory(); [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; renderTracks(); } }, "▶"));
        }
        if (mv.children.length) el.appendChild(mv);
        el.ondragstart = (e) => { dragFrom = [arr, i]; el.classList.add("drag"); e.dataTransfer.effectAllowed = "move"; };
        el.ondragend = () => { el.classList.remove("drag"); dragFrom = null; };
        el.ondragover = (e) => e.preventDefault();
        el.ondrop = (e) => {
          e.preventDefault();
          if (!dragFrom) return;
          const [sa, si] = dragFrom;
          dragFrom = null;
          pushHistory();
          const it = sa.splice(si, 1)[0];
          if (!it) return;
          const at = arr.indexOf(c);
          arr.splice(at, 0, it);
          renderTracks();
        };
        row.appendChild(el);
      });
    });
    try { renderRuler(); } catch (_) { /* 标尺渲染失败不影响轨道 */ }
  };

  // ---- 选中片段编辑（入点/出点裁剪 + 分割）----
  const editBar = h("div", { class: "ed-editbar", style: { display: "none" } });
  const inIn = h("input", { class: "input", type: "number", step: 0.1, min: 0, style: { width: 88 }, placeholder: "入点s" });
  const outIn = h("input", { class: "input", type: "number", step: 0.1, min: 0, style: { width: 88 }, placeholder: "出点s" });

  // ---------- 片段操作（按钮 + 快捷键共用同一套实现，行为永远一致） ----------
  const splitSelected = () => {
    if (!selected || !selected.row) { ctx.toast("先选中一个片段", true); return; }
    const c = selected.obj;
    const t = playheadSec > 0 ? playheadSec : (video.currentTime || 0);
    const base = c.in || 0;
    const stop = (c.out != null && c.dur != null) ? Math.min(c.out, c.dur) : (c.out != null ? c.out : c.dur);
    const span = (stop != null) ? (stop - base) : null;
    const at = t - base;
    if (at <= MINLEN || (span != null && at >= span - MINLEN)) { ctx.toast("播放头需在片段内部才能分割（先拖动预览进度条或标尺）", true); return; }
    pushHistory();
    const tail = { rel: c.rel, name: c.name, dur: c.dur, in: base + at, out: c.out,
                   speed: c.speed, volume: c.volume, muted: c.muted };
    c.out = base + at;
    selected.row.splice(selected.idx + 1, 0, tail);
    selected = null;
    renderTracks(); renderEdit(); syncMatSel();
    ctx.toast(`✂ 已在 ${at.toFixed(1)}s 处分割为两段`);
  };
  const duplicateSelected = () => {
    if (!selected || !selected.row) { ctx.toast("先选中一个片段", true); return; }
    pushHistory();
    selected.row.splice(selected.idx + 1, 0, { ...selected.obj });
    renderTracks();
    ctx.toast("已复制片段");
  };
  const deleteSelected = () => {
    if (!selected || !selected.row) { ctx.toast("先选中一个片段", true); return; }
    pushHistory();
    selected.row.splice(selected.idx, 1);
    selected = null;
    renderTracks(); renderEdit(); syncMatSel();
  };
  const nudgeSelected = (side, delta) => {
    if (!selected || !selected.row) return false;
    const c = selected.obj;
    if (c.dur == null) return false;
    const base = c.in || 0;
    const out = (c.out != null ? c.out : c.dur);
    pushHistory();
    if (side === "in") c.in = Math.max(0, Math.min(snapTo(base + delta), out - MINLEN));
    else c.out = Math.max(base + MINLEN, Math.min(snapTo(out + delta), c.dur));
    updateClipVisual(c); renderRuler();
    if (inIn) inIn.value = c.in == null ? "" : c.in;
    if (outIn) outIn.value = c.out == null ? "" : c.out;
    ctx.toast(`${side === "in" ? "入点" : "出点"} → ${((side === "in" ? c.in : c.out) || 0).toFixed(2)}s`);
    return true;
  };

  const renderEdit = () => {
    clear(editBar);
    if (!selected || !selected.row) { editBar.style.display = "none"; return; }
    editBar.style.display = "flex";
    editBar.appendChild(h("span", { class: "muted" }, "选中："));
    editBar.appendChild(h("b", { style: { fontSize: 12 } }, selected.obj.name));
    inIn.value = selected.obj.in == null ? "" : selected.obj.in;
    outIn.value = selected.obj.out == null ? "" : selected.obj.out;
    inIn.oninput = () => { selected.obj.in = inIn.value === "" ? null : Number(inIn.value); };
    outIn.oninput = () => { selected.obj.out = outIn.value === "" ? null : Number(outIn.value); };
    editBar.appendChild(h("span", { class: "muted" }, "入点:"));
    editBar.appendChild(inIn);
    editBar.appendChild(h("span", { class: "muted" }, "出点:"));
    editBar.appendChild(outIn);
    // ---- 变速（剪映式）----
    const spdSel = h("select", { class: "select", style: { width: "auto", padding: "3px 6px", fontSize: 11.5 },
      title: "变速 0.5–2×（视频 setpts + 音频 atempo，合成时生效）" },
      ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => h("option", { value: String(v) }, v === 1 ? "1.0× 原速" : v + "×")));
    spdSel.value = String(Math.max(0.5, Math.min(2, Number(selected.obj.speed) || 1)));
    spdSel.onchange = () => { pushHistory(); selected.obj.speed = Number(spdSel.value) || 1; renderTracks(); };
    editBar.appendChild(h("span", { class: "muted" }, "变速"));
    editBar.appendChild(spdSel);
    // ---- 音量 / 静音 ----
    const volIn = h("input", { class: "input", type: "range", min: 0, max: 3, step: 0.1,
      value: selected.obj.muted ? 0 : (selected.obj.volume == null ? 1 : Number(selected.obj.volume)),
      style: { width: 86 }, title: "音量 0–3（1=原声）" });
    const volLbl = h("span", { class: "muted", style: { fontSize: 11, minWidth: 34 } },
      (selected.obj.muted ? 0 : (selected.obj.volume == null ? 1 : Number(selected.obj.volume))).toFixed(1));
    volIn.oninput = () => { selected.obj.volume = Number(volIn.value); selected.obj.muted = Number(volIn.value) === 0; volLbl.textContent = Number(volIn.value).toFixed(1); };
    volIn.onchange = () => { pushHistory(); renderTracks(); };
    const muteCk = h("input", { type: "checkbox", style: { accentColor: "#ffd166" },
      checked: selected.obj.muted ? "checked" : null, title: "静音该片段" });
    muteCk.onchange = () => {
      pushHistory();
      selected.obj.muted = muteCk.checked;
      if (muteCk.checked) { selected.obj.volume = 0; volIn.value = 0; volLbl.textContent = "0.0"; }
      else { selected.obj.volume = 1; volIn.value = 1; volLbl.textContent = "1.0"; }
      renderTracks();
    };
    editBar.appendChild(h("span", { class: "muted" }, "音量"));
    editBar.appendChild(volIn);
    editBar.appendChild(volLbl);
    editBar.appendChild(h("label", { class: "row", style: { gap: 3, fontSize: 11, cursor: "pointer" } }, muteCk, "静音"));
    // 分割：在播放头位置把选中片段切成两段
    editBar.appendChild(h("button", { class: "btn", style: { padding: "4px 10px" }, title: "在播放头位置分割片段（快捷键 S）", onclick: () => splitSelected() }, "✂ 分割"));
    // 复制：复制选中片段到同轨道后一位
    editBar.appendChild(h("button", { class: "btn", style: { padding: "4px 10px" }, title: "复制选中片段（Ctrl+D）", onclick: () => duplicateSelected() }, "⧉ 复制"));
    // 排序：左移 / 右移（不用拖拽的快速排序）
    editBar.appendChild(h("button", { class: "btn", style: { padding: "4px 10px" }, title: "左移一位", onclick: () => {
      const { row, idx } = selected;
      if (idx > 0) { [row[idx - 1], row[idx]] = [row[idx], row[idx - 1]]; selected.idx = idx - 1; renderTracks(); renderEdit(); }
    } }, "◀ 左移"));
    editBar.appendChild(h("button", { class: "btn", style: { padding: "4px 10px" }, title: "右移一位", onclick: () => {
      const { row, idx } = selected;
      if (idx < row.length - 1) { [row[idx], row[idx + 1]] = [row[idx + 1], row[idx]]; selected.idx = idx + 1; renderTracks(); renderEdit(); }
    } }, "右移 ▶"));
    editBar.appendChild(h("button", { class: "btn", style: { padding: "4px 10px" }, title: "删除选中片段（Delete）", onclick: () => deleteSelected() }, "✕ 删除片段"));
    editBar.appendChild(h("button", { class: "btn", style: { padding: "4px 10px" }, onclick: () => { selected = null; syncMatSel(); renderTracks(); renderEdit(); } }, "取消"));
  };

  // ---- 合成（V1→V2 顺序 + A1 音频轨）----
  const musicSel = h("select", { class: "select", style: { width: "auto" } }, h("option", { value: "" }, "（无背景音乐）"));
  const loadMusic = async () => {
    try {
      const r = await ctx.api.files(folder(), "audio");
      for (const f of r.files || []) musicSel.appendChild(h("option", { value: f.name }, f.name));
    } catch (_) {}
  };
  const composeBtn = h("button", {
    class: "btn btn-primary",
    onclick: async () => {
      const clips = [...v1, ...v2].filter((c) => c && c.rel);
      if (!clips.length) { ctx.toast("V1/V2 轨道为空", true); return; }
      composeBtn.disabled = true; composeBtn.textContent = "合成中…";
      try {
        const audios = a1.filter((c) => c && c.rel).map((c) => ({ rel: c.rel, in: c.in, out: c.out }));
        const r = await ctx.api.composeEditor(
          folder(),
          clips.map((c) => ({ rel: c.rel, in: c.in, out: c.out, speed: c.speed, volume: c.volume, muted: c.muted })),
          musicSel.value,
          audios.map((a) => ({ rel: a.rel, in: a.in, out: a.out, volume: a.volume, muted: a.muted })));
        if (r.ok) { result.textContent = "成片已生成：input/" + r.rel; ctx.toast("合成成功"); await refreshMaterials(); }
        else ctx.toast("合成失败: " + r.error, true);
      } catch (e) { ctx.toast("合成失败: " + e.message, true); }
      finally { composeBtn.disabled = false; composeBtn.textContent = "🎬 合成成片"; }
    },
  }, "🎬 合成成片");

  // ---- 导入 ----
  const nativePick = async (kind) => {
    try {
      const r = await ctx.api.nativePick({ kind, title: kind === "folder" ? "选择文件夹（递归导入）" : "选择素材文件（多选）", filetypes: kind === "folder" ? [] : F_MEDIA, multiple: kind !== "folder" });
      return r.cancel ? [] : (r.paths || []);
    } catch (e) { ctx.toast("选择失败: " + e.message, true); return []; }
  };
  const importFilesBtn = h("button", { class: "btn", onclick: async () => {
    const paths = await nativePick("file");
    if (!paths.length) return;
    try { const r = await ctx.api.importFiles(folder(), paths); ctx.toast(`导入 ${r.copied.length} 个文件`); await refreshMaterials(); }
    catch (e) { ctx.toast("导入失败: " + e.message, true); }
  } }, "📂 导入文件");
  const importFolderBtn = h("button", { class: "btn", onclick: async () => {
    const paths = await nativePick("folder");
    if (!paths.length) return;
    try { const r = await ctx.api.importFolder(paths[0], folder()); ctx.toast(`导入 ${r.copied} 个素材`); await refreshMaterials(); }
    catch (e) { ctx.toast("导入失败: " + e.message, true); }
  } }, "🗂 导入文件夹");
  const localIn = h("input", { type: "file", style: { display: "none" }, multiple: true, accept: "video/*,audio/*" });
  const localBtn = h("button", { class: "btn", onclick: () => localIn.click() }, "⬆ 浏览器导入");
  localIn.onchange = async () => {
    const fld = folder();
    for (const f of localIn.files) {
      const isVideo = f.type.startsWith("video/");
      const target = isVideo ? (fld ? fld + "/video" : "video") : fld;
      try { await ctx.api.upload(target, f); } catch (e) { ctx.toast(`上传失败 ${f.name}: ${e.message}`, true); }
    }
    localIn.value = "";
    await refreshMaterials();
    const vids = materials.filter((m) => m.kind === "video");
    if (vids.length) showVideo(vids[vids.length - 1].rel);
  };
  const refreshBtn = h("button", { class: "btn", onclick: refreshMaterials }, "↻ 刷新");
  const undoBtn = h("button", { class: "btn", style: { padding: "6px 11px" }, title: "撤销（Ctrl+Z）", onclick: () => doUndo() }, "↩ 撤销");
  const redoBtn = h("button", { class: "btn", style: { padding: "6px 11px" }, title: "重做（Ctrl+Shift+Z）", onclick: () => doRedo() }, "↪ 重做");

  // ---- 单一导入入口：一个按钮 + 下拉（文件 / 文件夹 / 浏览器）----
  const importMenu = h("div", { style: "position:absolute;z-index:2147483000;display:none;flex-direction:column;min-width:190px;background:#101a2a;border:1px solid #31446a;border-radius:9px;padding:4px;box-shadow:0 12px 40px rgba(0,0,0,.6);" });
  const importWrap = h("div", { style: "position:relative;display:inline-block;" });
  const mkMenuItem = (label, fn) => h("button", { class: "btn", style: { textAlign: "left", padding: "7px 10px", border: "none" },
    onclick: async (e) => { e.stopPropagation(); importMenu.style.display = "none"; await fn(); } }, label);
  importMenu.append(
    mkMenuItem("📂 选择视频/音频文件（可多选）", async () => {
      const paths = await nativePick("file");
      if (!paths.length) return;
      try { const r = await ctx.api.importFiles(folder(), paths); ctx.toast(`导入 ${r.copied.length} 个文件`); await refreshMaterials(); }
      catch (e) { ctx.toast("导入失败: " + e.message, true); }
    }),
    mkMenuItem("🗂 选择文件夹（递归导入）", async () => {
      const paths = await nativePick("folder");
      if (!paths.length) return;
      try { const r = await ctx.api.importFolder(paths[0], folder()); ctx.toast(`导入 ${r.copied} 个素材`); await refreshMaterials(); }
      catch (e) { ctx.toast("导入失败: " + e.message, true); }
    }),
    mkMenuItem("⬆ 浏览器上传（本地文件）", () => localIn.click()),
  );
  importWrap.append(importMenu);
  const importBtn = h("button", { class: "btn btn-primary", style: { padding: "6px 12px" },
    title: "导入本地视频/音频（点右侧 ▾ 可选文件夹 / 浏览器上传）",
    onclick: async () => {
      if (importMenu.style.display === "flex") { importMenu.style.display = "none"; return; }
      const paths = await nativePick("file");
      if (!paths.length) return;
      try { const r = await ctx.api.importFiles(folder(), paths); ctx.toast(`导入 ${r.copied.length} 个文件`); await refreshMaterials(); }
      catch (e) { ctx.toast("导入失败: " + e.message, true); }
    } }, "📂 导入本地视频");
  const importMoreBtn = h("button", { class: "btn", style: { padding: "6px 8px" }, title: "更多导入方式",
    onclick: (e) => { e.stopPropagation(); importMenu.style.display = importMenu.style.display === "flex" ? "none" : "flex"; } }, "▾");
  importWrap.append(importBtn, importMoreBtn);
  document.addEventListener("click", () => { importMenu.style.display = "none"; });

  // 按内容 md5 删重复素材（input/{folder}/video + input/{folder} 根 + output/video）
  const dedupeBtn = h("button", {
    class: "btn", style: { borderColor: "#c98a1e" },
    onclick: async () => {
      if (!confirm("按文件内容 md5 扫描剪辑素材区，删除重复的视频/音频（每组保留按文件名排序的第一个）。继续？")) return;
      dedupeBtn.disabled = true; dedupeBtn.textContent = "扫描中…";
      try {
        const r = await ctx.api.dedupeMaterials(folder());
        ctx.toast(r.note || `扫描 ${r.scanned || 0} · 删除 ${r.removed || 0}`);
        await refreshMaterials();
      } catch (e) { ctx.toast("删重复失败: " + e.message, true); }
      finally { dedupeBtn.disabled = false; dedupeBtn.textContent = "🧹 删重复"; }
    },
  }, "🧹 删重复");

  // 素材多选删除
  const delSelBtn = h("button", { class: "btn", style: { borderColor: "#a33" }, onclick: async () => {
    if (!delSet.size) { ctx.toast("先勾选素材（左上角复选框）", true); return; }
    if (!confirm(`删除 ${delSet.size} 个素材文件？（不可恢复）`)) return;
    const rels = [...delSet];
    try { const r = await ctx.api.deleteMaterials(rels); delSet.clear(); delLbl.textContent = ""; ctx.toast(`已删除 ${r.count} 个`); await refreshMaterials(); }
    catch (e) { ctx.toast("删除失败: " + e.message, true); }
  } }, "🗑 删除选中素材");
  const delAllBtn = h("button", { class: "btn", style: { padding: "6px 11px" }, onclick: () => {
    const vis = materials.filter((m) => tab === "all" || m.kind === tab).map((m) => m.rel);
    if (delSet.size && vis.every((r) => delSet.has(r))) { delSet.clear(); } else { vis.forEach((r) => delSet.add(r)); }
    delLbl.textContent = delSet.size ? `已选 ${delSet.size}` : "";
    renderMats();
  } }, "☑ 全选/取消");

  const upSel = h("select", { class: "select", style: { width: "auto" } },
    h("option", { value: "rtx" }, "⚡ RTX VSR"),
    h("option", { value: "flash" }, "⚡ TE-FlashVSR"),
    h("option", { value: "seedvr2" }, "✨ SeedVR2"),
    h("option", { value: "vosr2" }, "⚡ VOSR2（H3 二采平替）"));
  // 放大倍率（自定义 1–4）：RTX / FlashVSR / VOSR2 直接用倍数；SeedVR2 由后端按「源短边 × 倍率」换算目标短边
  const upScaleEd = h("input", { class: "input", type: "number", min: 1, max: 4, step: 0.5, value: 2,
    style: { width: 56, padding: "4px 6px", fontSize: 11.5 },
    title: "放大倍率 1–4（各引擎统一）：RTX/FlashVSR/VOSR2 直接倍数；SeedVR2 目标短边 = 源短边 × 倍率" });
  // ⏩ 全部入轨：当前素材区可见的所有视频，按顺序一键加入 V1 主轨
  const allToTrackBtn = h("button", {
    class: "btn btn-primary", style: { padding: "6px 11px" },
    title: "把素材区全部视频按当前顺序一键加入 V1 主轨",
    onclick: () => {
      const vids = materials.filter((m) => m.kind === "video" && (tab === "all" || tab === "video"));
      if (!vids.length) { ctx.toast("素材区没有视频素材", true); return; }
      const n = addManyToTrack(v1, vids);   // 批量：只重绘 1 次
      ctx.toast(`已把 ${n} 个视频按顺序加入 V1 主轨`);
    },
  }, "⏩ 全部入轨");
  const upBtn = h("button", {
    class: "btn", style: { padding: "6px 11px" },
    title: "对选中视频做高清放大（RTX 最快 / FlashVSR 快 / SeedVR2 质量佳 / VOSR2 新一代一步超分更快更省）",
    onclick: async () => {
      const m = selected && selected.obj;
      if (!m || m.kind !== "video") { ctx.toast("先在素材区选中一个视频", true); return; }
      const eng = upSel.value;
      const sc = Math.max(1, Math.min(4, Number(upScaleEd.value) || 2));
      const opts = eng === "rtx" ? { scale: sc, quality: "HIGH" } : eng === "seedvr2" ? { scale: sc } : eng === "vosr2" ? { scale: sc } : {};
      // 弹文件夹选择：超分视频保存到选定文件夹
      let outDir = "";
      try {
        const pick = await ctx.api.nativePick({ kind: "folder", title: "选择超分视频保存文件夹" });
        if (pick.cancel || !(pick.paths || []).length) { ctx.toast("已取消超分", true); return; }
        outDir = pick.paths[0];
      } catch (_) { /* 弹不出则输出到视频同目录 */ }
      upBtn.disabled = true; upBtn.textContent = "超分中…";
      try {
        const r = await ctx.api.h3Upscale(m.rel, eng, outDir ? { ...opts, out_dir: outDir } : opts);
        if (!r.ok) { ctx.toast("超分失败: " + (r.error || ""), true); upBtn.disabled = false; upBtn.textContent = "✨ 超分放大"; return; }
        if (r.rel) { ctx.toast("超分完成！" + (outDir ? "已存到 " + outDir : "")); await refreshMaterials(); upBtn.disabled = false; upBtn.textContent = "✨ 超分放大"; return; }
        const timer = setInterval(async () => {
          let st; try { st = await ctx.api.h3UpscaleStatus(r.task_id); } catch (_) { return; }
          if (st.status === "done") { clearInterval(timer); ctx.toast("超分完成！" + (st.path ? " 已存到 " + st.path : "")); refreshMaterials(); upBtn.disabled = false; upBtn.textContent = "✨ 超分放大"; }
          else if (st.status === "error") { clearInterval(timer); ctx.toast("超分失败: " + (st.error || ""), true); upBtn.disabled = false; upBtn.textContent = "✨ 超分放大"; }
        }, 3000);
      } catch (e) { ctx.toast("超分失败: " + e.message, true); upBtn.disabled = false; upBtn.textContent = "✨ 超分放大"; }
    },
  }, "✨ 超分放大");

  const el = h("div", { class: "ed-layout" },
    h("div", { class: "row" }, importWrap, refreshBtn, undoBtn, redoBtn, composeBtn,
      h("span", { class: "muted" }, "超分方案"), upSel,
      h("span", { class: "muted" }, "倍率"), upScaleEd, upBtn,
      h("button", { class: "btn", style: { borderColor: "#a33" }, onclick: () => { if (!v1.length && !v2.length && !a1.length) return; if (!confirm("清空全部轨道？")) return; v1.length = 0; v2.length = 0; a1.length = 0; selected = null; renderTracks(); renderEdit(); } }, "🗑 清轨"),
      h("button", { class: "btn", style: { borderColor: "#a33" }, onclick: async () => {
        if (!confirm("⚠️ 清空剪辑素材区所有视频+音频文件？（不可恢复，图片不受影响）")) return;
        try { const r = await ctx.api.clearMaterials(folder()); delSet.clear(); delLbl.textContent = ""; ctx.toast(`已清空 ${r.count} 个素材`); await refreshMaterials(); }
        catch (e) { ctx.toast("清空失败: " + e.message, true); }
      } }, "🧹 清空素材"),
      dedupeBtn,
      musicSel),
    preview,
    h("div", { class: "row" }, tabSel, matCount, allToTrackBtn, delAllBtn, delSelBtn, delLbl,
      h("span", { class: "muted" }, "（⏩ 全部视频按顺序入 V1 轨 · 勾选素材可多选删除）")),
    matsRow,
    h("div", { class: "ed-trackwrap" },
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: () => { const cur = selected && selected.obj; if (cur && cur.kind === "video") addToTrack(v1, cur); else ctx.toast("先选中一个视频素材", true); } }, "＋ V1 主轨"),
        h("button", { class: "btn btn-primary", style: { padding: "6px 11px" }, title: "把 V1 主轨的多段素材按顺序无缝串联预览（尊重每段入点/出点裁剪）", onclick: () => playSequential(v1) }, "▶ 连播预览"),
        h("button", { class: "btn", onclick: () => { const cur = selected && selected.obj; if (cur && cur.kind === "video") addToTrack(v2, cur); else ctx.toast("先选中一个视频素材", true); } }, "＋ V2 副轨"),
        h("button", { class: "btn", onclick: () => { const cur = selected && selected.obj; if (cur && cur.kind === "audio") addToTrack(a1, cur); else ctx.toast("先选中一个音频素材", true); } }, "＋ A1 音频轨"),
        fitLbl),
      ruler, rowV1, rowV2, rowA1, editBar),
    result);

  tabSel.onchange = () => { tab = tabSel.value; renderMats(); };
  refreshMaterials();
  loadMusic();
  // 素材库/收藏库改名（或删素材）→ 剪辑素材区实时重扫，缩略图与文件名跟着变（不用切走再回来）
  assetRegistry.subscribe(() => { if (el.isConnected) refreshMaterials(); });

  // ---- 播放时播放头实时跟随（rAF 节流，只改 left，不触发重排）----
  const _followHead = rafThrottle(() => {
    if (!_previewClip || video.paused) return;
    const local = Math.max(0, (video.currentTime || 0) - (_previewClip.in || 0));
    setPlayhead(_previewAcc + local / clampSpeed(_previewClip), false);
  });
  video.addEventListener("timeupdate", _followHead);
  video.addEventListener("seeked", _followHead);

  // ---- 快捷键（剪映式）：与按钮共用同一套实现 ----
  //   Space 播放/暂停 · S 在播放头分割 · Delete/Backspace 删除片段 · Ctrl+D 复制
  //   Ctrl+Z / Ctrl+Shift+Z 撤销重做 · ←/→ 播放头 ±0.1s（Shift 为 ±1s）· Alt+←/→ 微调入点
  //   A 音频轨 / Esc 取消选中
  const _onKey = (e) => {
    if (!el.isConnected) return;                                  // 面板没激活 → 不抢按键
    // shadow DOM 会把 event.target 重定向成宿主元素 → 用 composedPath 拿真实目标，
    // 否则在面板里的输入框打字会被当成快捷键（例如打 "s" 触发分割）。
    const t = (typeof e.composedPath === "function" && e.composedPath()[0]) || e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
    const k = (e.key || "").toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    // 吃掉按键：本面板激活时这些键归剪辑面板所有。
    // 必须 stopImmediatePropagation —— 否则 Ctrl+Z 会同时触发 ComfyUI 自己的「撤销工作流」，
    // 把 MRBoard 节点从画布上撤掉（表现为面板 DOM 被拆掉、后续测量全 0）。
    const grab = (ev) => { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation && ev.stopImmediatePropagation(); };
    if (mod && k === "z") { grab(e); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && k === "y") { grab(e); doRedo(); return; }
    if (mod && k === "d") { grab(e); duplicateSelected(); return; }
    if (mod && k === "s") { grab(e); composeBtn.click(); return; }
    if (e.code === "Space") {
      if (!video.src) return;
      grab(e);
      if (video.paused) video.play().catch(() => {}); else video.pause();
      return;
    }
    if (k === "s" && !mod) { grab(e); splitSelected(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { if (selected) { grab(e); deleteSelected(); } return; }
    if (e.key === "Escape") { if (selected) { grab(e); selected = null; syncMatSel(); renderTracks(); renderEdit(); } return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const step = e.shiftKey ? 1 : 0.1;
      const d = e.key === "ArrowLeft" ? -step : step;
      // Alt + ←/→：微调选中片段的「入点」；否则一律移动播放头（剪映习惯）
      if (e.altKey && selected && selected.obj) { grab(e); if (nudgeSelected("in", d)) return; }
      grab(e);
      setPlayhead(playheadSec + d, true);
      return;
    }
  };
  // 用 window 捕获阶段注册：ComfyUI 自己也在 window 捕获阶段抢方向键/Ctrl+Z，
  // 冒泡阶段会晚于它。捕获阶段先拿到 + composedPath 拿真实目标，快捷键才稳定生效。
  // 另外把这个 handler 挂到模块级护栏上（模块加载期就抢注了 window 捕获），双保险。
  _activeEditorKeyHandler = _onKey;
  window.addEventListener("keydown", _onKey, true);
  _prevKeys = _onKey;   // 记录本次绑定（面板对象全局只创建一次；isConnected 守卫保证切走后面板不抢按键）

  return { el, update: refreshMaterials };
}
