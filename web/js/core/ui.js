// core/ui.js — 跨面板共享的小 UI 助手：媒体灯箱 / 分类计数 tab / 素材卡骨架 + 能量脉冲。
import { h } from "./dom.js";

export const CAT_LABEL = { role: "角色", scene: "场景", asset: "素材", audio: "音频", other: "其他" };
export const CAT_CLS = { role: "role", scene: "scene", asset: "asset", audio: "audio" };

/* 「能量脉冲」点击反馈：在按钮点击点周围生成一道金色光圈，0.65s 后自动清理。
 * 使用事件代理，只在根 root 上挂一次；找到点击坐标最近的 .btn / .ptab / .tl-tab /
 * .mx-nav-item / .mm-playbtn / .mcard .abtn 等交互元素就播一次。
 * 需要按钮有 overflow:hidden 才能把光圈裁在按钮内（CSS 已统一加上）。 */
let _rippleBound = false;
export function setupEnergyRipple(root) {
  if (!root || _rippleBound) return;
  _rippleBound = true;
  const SEL = ".btn, .ptab, .tl-tab, .mx-nav-item, .mm-playbtn, .scard > .hd .no, .mcard .abtn";
  const spawn = (btn, ev) => {
    if (!btn || btn.disabled) return;
    // 防抖：同一按钮已有 pulse 时不重复
    if (!btn.querySelector(".mx-pulse")) {
      const ripple = document.createElement("span");
      ripple.className = "mx-pulse";
      btn.appendChild(ripple);
      setTimeout(() => { try { ripple.remove(); } catch (_) {} }, 800);
    }
    // 🔥 火焰主题：点击时火焰向四周喷发（火环 + 火星）
    spawnFireBurst(root, btn, ev && ev.clientX, ev && ev.clientY);
  };
  // pointerdown 覆盖鼠标/触屏原生点击
  root.addEventListener("pointerdown", (e) => spawn(e.target.closest && e.target.closest(SEL), e), true);
  // click 兜底程序化 .click() 触发的场景（如探针 / 脚本调用）
  root.addEventListener("click", (e) => spawn(e.target.closest && e.target.closest(SEL), e), true);
}

// ---------------------------------------------------------------- 🔥 火焰喷发
// 仅在「🔥 火焰流动」主题下启用：点任意按钮/页签/导航，火星从点击点向四周喷射 + 按钮火环扩散。
// 纯 DOM 粒子（无 canvas / 无依赖），粒子 1s 内自行移除，不留内存。
let _fireLayer = null;
let _lastBurstAt = 0;

function _ensureFireLayer(root) {
  if (_fireLayer && _fireLayer.isConnected && root.contains(_fireLayer)) return _fireLayer;
  const layer = document.createElement("div");
  layer.className = "mx-fire-layer";
  root.appendChild(layer);
  _fireLayer = layer;
  return layer;
}

export function isFireTheme(root) {
  return !!(root && root.classList && root.classList.contains("mrnext-theme-fire"));
}

export function spawnFireBurst(root, btn, clientX, clientY, opts) {
  if (!isFireTheme(root)) return false;
  const now = Date.now();
  const minGap = (opts && opts.minGap) || 70;   // 连点防刷屏
  if (now - _lastBurstAt < minGap) return false;
  _lastBurstAt = now;

  const layer = _ensureFireLayer(root);
  const lr = layer.getBoundingClientRect();
  let x, y;
  if (typeof clientX === "number" && clientX > 0) {
    x = clientX - lr.left;
    y = clientY - lr.top;
  } else if (btn) {
    const b = btn.getBoundingClientRect();
    x = b.left + b.width / 2 - lr.left;
    y = b.top + b.height / 2 - lr.top;
  } else {
    return false;
  }

  // ① 按钮本体：火环扩散
  if (btn) {
    const ring = document.createElement("span");
    ring.className = "mx-fire-ring";
    btn.appendChild(ring);
    setTimeout(() => { try { ring.remove(); } catch (_) {} }, 560);
  }

  // ② 火星四射：均分角度 + 抖动，距离/大小/时长随机，带上飘
  const n = (opts && opts.count) || 12;
  const base = Math.random() * 360;
  for (let i = 0; i < n; i++) {
    const ang = ((base + (360 / n) * i + (Math.random() * 26 - 13)) * Math.PI) / 180;
    const dist = 26 + Math.random() * 46;
    const size = 5 + Math.random() * 7;
    const pt = document.createElement("span");
    pt.className = "mx-fire-particle";
    pt.style.left = x + "px";
    pt.style.top = y + "px";
    pt.style.width = size.toFixed(1) + "px";
    pt.style.height = size.toFixed(1) + "px";
    pt.style.setProperty("--dx", (Math.cos(ang) * dist).toFixed(1) + "px");
    pt.style.setProperty("--dy", (Math.sin(ang) * dist - 8 - Math.random() * 10).toFixed(1) + "px");
    pt.style.setProperty("--sc", (0.12 + Math.random() * 0.2).toFixed(2));
    pt.style.setProperty("--rot", (Math.random() * 180 - 90).toFixed(0) + "deg");
    pt.style.setProperty("--dur", (0.5 + Math.random() * 0.3).toFixed(2) + "s");
    pt.style.setProperty("--dly", (Math.random() * 0.06).toFixed(2) + "s");
    layer.appendChild(pt);
    setTimeout(() => { try { pt.remove(); } catch (_) {} }, 1000);
  }
  return true;
}

// 媒体灯箱：挂到 document.body，Esc/点击遮罩关闭。全内联样式（body 在 shadow 外，拿不到 shadow CSS）。
// 可选 actions: [{label, title?, onClick, primary?, danger?}] 在底部渲染一行操作按钮。
// 可选 gallery: [src...] + index：显示左右切换按钮（前后图）、滚轮缩放、右下角显示 n/total。
let _lb = null;
export function lightbox(src, kind = "image", options = {}) {
  closeLightbox();
  const wrap = document.createElement("div");
  const st = wrap.style;
  st.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(2,4,9,.92);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;";
  const media = kind === "video"
    ? Object.assign(document.createElement("video"), { src, controls: true, autoplay: true, muted: true, playsInline: true, preload: "metadata" })
    : Object.assign(document.createElement("img"), { src, alt: "" });
  media.style.cssText = "max-width:92vw;max-height:78vh;border-radius:10px;box-shadow:0 12px 60px rgba(0,0,0,.7);transition:transform .12s ease;transform-origin:center center;";
  if (kind === "video") {
    media.addEventListener("error", () => {
      const err = h("div", { style: "color:#ffb4b4;font-size:13px;text-align:center;max-width:80vw;padding:12px 18px;background:rgba(0,0,0,.55);border-radius:8px;" },
        "视频加载失败：", h("br"), h("code", { style: "color:#9fd0ff;word-break:break-all;" }, src));
      if (wrap.contains(media)) wrap.replaceChild(err, media);
      else wrap.appendChild(err);
    });
  }

  // ---- 滚轮缩放（图片/视频通用）----
  let zoom = 1;
  const applyZoom = () => { media.style.transform = `scale(${zoom})`; if (zoomLbl) zoomLbl.textContent = Math.round(zoom * 100) + "%"; };
  const zoomLbl = document.createElement("div");
  zoomLbl.style.cssText = "position:fixed;right:18px;bottom:16px;color:#ffd98f;background:rgba(0,0,0,.55);border:1px solid rgba(255,209,102,.35);border-radius:8px;padding:3px 9px;font-size:11.5px;font-weight:700;z-index:2147483001;";
  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom = Math.min(5, Math.max(0.1, zoom + (e.deltaY < 0 ? 0.12 : -0.12)));
    applyZoom();
  }, { passive: false });
  // 双击复位
  media.addEventListener("dblclick", () => { zoom = 1; applyZoom(); });

  // ---- 多图导航（gallery）----
  const gallery = Array.isArray(options.gallery) && options.gallery.length ? options.gallery : null;
  let gidx = gallery ? Math.max(0, Math.min(options.index || 0, gallery.length - 1)) : -1;
  const navLbl = document.createElement("div");
  const mkNav = (label, dir) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `position:fixed;top:50%;${dir < 0 ? "left" : "right"}:18px;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.55);color:#fff;font-size:20px;line-height:1;cursor:pointer;z-index:2147483001;transition:background .15s,border-color .15s;`;
    b.onmouseenter = () => { b.style.background = "rgba(255,209,102,.85)"; b.style.borderColor = "#ffe9a8"; b.style.color = "#3a2503"; };
    b.onmouseleave = () => { b.style.background = "rgba(0,0,0,.55)"; b.style.borderColor = "rgba(255,255,255,.25)"; b.style.color = "#fff"; };
    b.onclick = (ev) => { ev.stopPropagation(); showAt(gidx + dir); };
    return b;
  };
  function showAt(i) {
    if (!gallery) return;
    gidx = (i + gallery.length) % gallery.length;
    zoom = 1; applyZoom();
    const url = gallery[gidx];
    if (kind === "video") { media.src = url; media.play().catch(() => {}); }
    else media.src = url;
    if (navLbl) navLbl.textContent = `${gidx + 1} / ${gallery.length}`;
    if (typeof options.onNavigate === "function") { try { options.onNavigate(gidx); } catch (_) {} }
  }
  if (gallery && gallery.length > 1) {
    navLbl.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);color:#e9effa;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:4px 14px;font-size:12px;font-weight:700;z-index:2147483001;";
    navLbl.textContent = `${gidx + 1} / ${gallery.length}`;
  }

  // 操作工具栏（仅在传 actions 时渲染）
  let toolbar = null;
  if (Array.isArray(options.actions) && options.actions.length) {
    toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:92vw;";
    options.actions.forEach((a) => {
      const b = document.createElement("button");
      b.textContent = a.label || "";
      if (a.title) b.title = a.title;
      const primary = a.primary ? "linear-gradient(180deg,#ffe9a8 0%,#f5ca57 45%,#e0a83a 100%)" : "rgba(255,255,255,.08)";
      const danger = a.danger ? "linear-gradient(135deg,#ff5d5d,#c43838)" : primary;
      const col = a.danger ? "#fff" : (a.primary ? "#3a2503" : "#fff");
      b.style.cssText = `padding:9px 16px;border-radius:8px;border:1px solid ${a.danger ? "#ff7d7d" : (a.primary ? "#f5ca57" : "#3a4a66")};background:${danger};color:${col};font-size:13px;font-weight:700;cursor:pointer;box-shadow:${a.primary ? "inset 0 1px 0 rgba(255,255,255,.7), 0 3px 12px rgba(222,170,60,.38)" : "0 2px 10px rgba(0,0,0,.4)"};transition:transform .15s cubic-bezier(.22,.68,.32,1),box-shadow .15s cubic-bezier(.22,.68,.32,1);`;
      b.onmouseenter = () => { b.style.transform = "translateY(-2px)"; b.style.boxShadow = a.primary ? "inset 0 1px 0 rgba(255,255,255,.8), 0 6px 20px rgba(235,185,70,.5)" : "0 4px 14px rgba(0,0,0,.5)"; };
      b.onmouseleave = () => { b.style.transform = ""; b.style.boxShadow = a.primary ? "inset 0 1px 0 rgba(255,255,255,.7), 0 3px 12px rgba(222,170,60,.38)" : "0 2px 10px rgba(0,0,0,.4)"; };
      b.onclick = (ev) => { ev.stopPropagation(); try { a.onClick && a.onClick(); } catch (e) { console.error("[lightbox action]", e); } };
      toolbar.appendChild(b);
    });
  }
  const close = document.createElement("button");
  close.textContent = "✕";
  close.style.cssText = "position:fixed;top:14px;right:18px;color:#fff;cursor:pointer;font-size:20px;background:rgba(255,255,255,.1);width:38px;height:38px;border-radius:50%;border:0;transition:background .15s,transform .15s;z-index:2147483001;";
  close.onmouseenter = () => { close.style.background = "rgba(255,120,120,.8)"; close.style.transform = "rotate(90deg)"; };
  close.onmouseleave = () => { close.style.background = "rgba(255,255,255,.1)"; close.style.transform = ""; };
  close.onclick = closeLightbox;
  wrap.onclick = (e) => { if (e.target === wrap) closeLightbox(); };
  wrap.appendChild(media);
  if (toolbar) wrap.appendChild(toolbar);
  wrap.appendChild(close);
  // 导航/缩放控件挂到 body（fixed 定位，避免被 wrap 的 flex 布局影响）
  const extras = [];
  if (gallery && gallery.length > 1) {
    const prev = mkNav("‹", -1), next = mkNav("›", 1);
    extras.push(prev, next, navLbl);
  }
  extras.push(zoomLbl);
  applyZoom();
  _lb = wrap;
  _lb._extras = extras;
  document.body.appendChild(wrap);
  extras.forEach((el) => document.body.appendChild(el));
  const onKey = (e) => {
    if (e.key === "Escape") closeLightbox();
    else if (gallery && gallery.length > 1 && e.key === "ArrowLeft") showAt(gidx - 1);
    else if (gallery && gallery.length > 1 && e.key === "ArrowRight") showAt(gidx + 1);
  };
  document.addEventListener("keydown", onKey);
  wrap._key = onKey;
}
export function closeLightbox() {
  if (_lb) {
    document.removeEventListener("keydown", _lb._key);
    if (Array.isArray(_lb._extras)) _lb._extras.forEach((el) => { try { el.remove(); } catch (_) {} });
    _lb.remove();
    _lb = null;
  }
}

// 分类计数 tab（含计数徽章）；返回 {bar, count:fn}
export function catTabs(categories, { active = "", onChange = () => {} } = {}) {
  const bar = h("div", { class: "pstrip" });
  let cur = active;
  const countBy = () => { };
  const mk = () => {
    bar.textContent = "";
    for (const c of categories) {
      const b = h("button", {
        class: "ptab" + (cur === c.key ? " on" : ""),
        onclick: () => { cur = c.key; onChange(c.key); mk(); },
      }, c.label, h("span", { class: "pc", dataset: { cnt: c.key } }, String(c.count || 0)));
      bar.appendChild(b);
    }
  };
  mk();
  return { bar, get: () => cur, setCount: (k, n) => { const el = bar.querySelector(`[data-cnt="${k}"]`); if (el) el.textContent = n; } };
}

// 弹 Windows 原生文件夹选择框，把所选绝对路径相对化到 ComfyUI input 目录 → 资产 folder 名。
// 返回：{cancel:true} 用户取消 | {error:"..."} 不在 input 内 | {folder:"子/目录"} 成功（"" = input 根目录）。
// 所有「跑之前先选保存位置」的入口（一键流水线 / 公共前缀生成设定图）共用此函数。
export async function pickAssetFolder(ctx, title) {
  let base = "";
  try { base = ((await ctx.api.paths()) || {}).input_base || ""; } catch (_) {}
  const pick = await ctx.api.nativePick({ kind: "folder", title: title || "选择保存文件夹", start_path: base });
  if (pick.cancel || !(pick.paths || []).length) return { cancel: true };
  const raw = pick.paths[0];
  const norm = (s) => String(s || "").replace(/\//g, "\\").replace(/\\+$/, "");
  const pn = norm(raw), bn = norm(base);
  const low = (s) => s.toLowerCase(); // Windows 路径大小写不敏感
  if (bn) {
    if (low(pn) === low(bn)) return { folder: "" };
    if (low(pn).startsWith(low(bn) + "\\")) {
      return { folder: pn.slice(bn.length + 1).replace(/\\/g, "/") };
    }
    return { error: "所选文件夹必须在 ComfyUI input 目录内（" + bn + "）" };
  }
  // 拿不到 input base（旧后端）：退化为取末级目录名
  return { folder: pn.split("\\").filter(Boolean).pop() || "" };
}

/* 就地改名：把显示名字的元素（如素材卡的 .mn / 收藏卡的 .mn）临时换成输入框。
 *   Enter / 失焦 = 提交；Esc = 取消。onCommit(newName) 由调用方负责调后端 + 刷新。
 * 返回 true 表示已进入编辑态（同一元素同时只允许一个编辑框）。
 * 注意：输入框内 stopPropagation —— 否则卡片自身的 pointerdown 拖拽换位、
 * 画布层/全局快捷键（空格、Delete、Ctrl+Z）会在打字时被触发。 */
export function inlineRename(labelEl, initial, onCommit) {
  if (!labelEl || labelEl.__mxEditing) return false;
  labelEl.__mxEditing = true;
  const prevText = labelEl.textContent;
  const start = String(initial != null ? initial : prevText || "");
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = start;
  inp.spellcheck = false;
  inp.setAttribute("style",
    "width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.35;padding:2px 5px;" +
    "border-radius:6px;border:1px solid var(--gold,#ffcf6b);background:#0b1526;color:#eaf1fb;outline:none;");
  labelEl.textContent = "";
  labelEl.appendChild(inp);
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    labelEl.__mxEditing = false;
    const v = inp.value.trim();
    labelEl.textContent = prevText;   // 先还原；成功后调用方会重渲染整块
    if (ok && v && v !== start) { try { onCommit(v); } catch (_) {} }
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("pointerdown", (e) => e.stopPropagation());
  inp.addEventListener("dblclick", (e) => e.stopPropagation());
  inp.addEventListener("blur", () => finish(true));
  setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 0);
  return true;
}
