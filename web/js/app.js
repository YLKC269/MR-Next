// app.js — 应用外壳：注入样式 → 左导航 + 单活动面板（每面板彩色图标头）。
import { h, clear } from "./core/dom.js";
import { StudioAPI, viewUrl } from "./core/api.js";
import { createStore } from "./core/store.js";
import { CSS } from "./core/styles.js";

import { createScriptPanel } from "./panels/script.js";
import { createPipelinePanel } from "./panels/pipeline.js";
import { createShotsPanel } from "./panels/shots.js";
import { createAssetsPanel } from "./panels/assets.js";
import { createFavoritesPanel } from "./panels/favorites.js";
import { createGeneratePanel } from "./panels/generate.js";
import { createSkillPanel } from "./panels/skill.js";
import { createTimelinePanel } from "./panels/timeline.js";
import { createEditorPanel } from "./panels/editor.js";
import { createToolsPanel } from "./panels/tools.js";
import { setupEnergyRipple } from "./core/ui.js";
import { stripVirtualRefs } from "./core/purify.js";
import { bindAssetStore } from "./core/assets.js";

const PANELS = [
  { name: "script", icon: "📜", label: "剧本", sub: "输入 / 拆分 / 定义 / 适配 / 设定图", accent: "#f0937a", make: createScriptPanel },
  { name: "pipeline", icon: "⚙️", label: "流水线", sub: "一键全自动 · 可选 H3 连跑", accent: "#f472b6", make: createPipelinePanel },
  { name: "shots", icon: "🎞️", label: "分镜", sub: "编辑正文 · 按素材匹配引用", accent: "#57c7ff", make: createShotsPanel },
  { name: "assets", icon: "🗂️", label: "素材库", sub: "浏览 / 上传 / 收藏入册", accent: "#6ee7a0", make: createAssetsPanel },
  { name: "favorites", icon: "⭐", label: "收藏库", sub: "名字 → 文件映射", accent: "#ffcf6b", make: createFavoritesPanel },
  { name: "generate", icon: "🎨", label: "生图", sub: "Krea2 真实生图 / 画质增强", accent: "#a78bfa", make: createGeneratePanel },
  { name: "skill", icon: "🛠️", label: "Skill 优化", sub: "本地 Qwen 提示词优化", accent: "#7dd3fc", make: createSkillPanel },
  { name: "timeline", icon: "🎬", label: "时间线", sub: "官方 H3 逐镜成片 · 5 模式", accent: "#ffb35c", make: createTimelinePanel },
  { name: "editor", icon: "✂️", label: "剪辑", sub: "序列 / 裁剪 / 背景音乐合成", accent: "#5eead4", make: createEditorPanel },
  { name: "tools", icon: "🧰", label: "工具", sub: "原生导入 / 导出 / 消毒", accent: "#c9a6ff", make: createToolsPanel },
];

export function mountApp(shadow, node) {
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);

  const root = h("div", { class: "mrnext-root" });
  shadow.appendChild(root);
  // 给所有按钮/tab 挂上「能量脉冲」点击反馈（事件代理，只挂一次）
  setupEnergyRipple(root);
  // 阻止文本框粘贴事件冒泡到 ComfyUI 画布：Ctrl+V 在节点内任意文本框粘贴，
  // 若冒泡到 document 会被 ComfyUI 当成「粘贴 workflow」→ 多出 MRBoardStudio 节点。
  // 这里只在冒泡阶段 stopPropagation（不 preventDefault），文本仍正常粘贴进文本框。
  root.addEventListener("paste", (e) => { e.stopPropagation(); });

  // 节点状态持久化：folder/script/prefix/shots/roles/scenes/refMap 等自动记忆（localStorage）
  const STORE_LS_KEY = "mrnext.store.v1";
  const _loadStore = () => {
    try { return JSON.parse(localStorage.getItem(STORE_LS_KEY) || "{}"); }
    catch (_) { return {}; }
  };
  const store = createStore({
    folder: "mrboard_next",
    script: "",
    shots: [],
    roles: [],
    scenes: [],
    // 视频分辨率档位（H3 导演台出片 + 一键流水线 共享；与生图档位分开）
    vidSize: 1, // 默认 720×1280 竖屏 9:16
    vidW: 720,
    vidH: 1280,
    // LoRA（3 个面板联动：生图 / 公共前缀 / 流水线）
    useLora: false,        // 是否启用 LoRA（关闭 = 编辑 LoRA 留空，不影响其他流程）
    loraFolder: "",        // 自定义 LoRA 文件夹（空 = 后端默认 models/loras）
    ..._loadStore(),
  });
  // 把 store 交给资产注册表：素材/收藏改名时自动重映射 store.refMap（每镜素材引用），
  // 这样时间线/分镜里的标记与预览会跟着改名实时刷新。
  bindAssetStore(store);
  // ---- 一次性数据清洗：删除正文里的机器文件名 token（历史 @ 插入的 1788963615883_82a78583_00001_.png 等）----
  // 匹配「≥10位数字_十六进制哈希_序号_?.扩展名」——特异性足够高，不会误删正常文本。
  const _MACHINE_FILE_RE = /\s*\d{10,}_[0-9a-fA-F]{6,}_\d+_?\.(?:png|jpg|jpeg|webp|gif|bmp|mp4|mov|webm|mkv|wav|mp3|flac|ogg|m4a)/g;
  // 机器名 + 虚拟引用（@image#1:xxx.png）一起剥：后者是粘贴图片时 ComfyUI 写入的引用标记，
  // 不是真实素材，留在正文里会污染出片提示词、也会在素材列表里变成"数字素材"。
  const _cleanMachines = (s) => (typeof s === "string" ? stripVirtualRefs(s.replace(_MACHINE_FILE_RE, "")) : s);
  (() => {
    const st = store.get();
    let dirty = false;
    const cleanShot = (sh) => {
      if (!sh || typeof sh !== "object") return sh;
      const t = _cleanMachines(sh.text || "");
      const p = _cleanMachines(sh.prompt || "");
      if (t !== sh.text || p !== sh.prompt) { dirty = true; return { ...sh, text: t, prompt: p }; }
      return sh;
    };
    const patch = {};
    const script2 = _cleanMachines(st.script || "");
    if (script2 !== st.script) { patch.script = script2; dirty = true; }
    const prefix2 = _cleanMachines(st.prefix || "");
    if (prefix2 !== st.prefix) { patch.prefix = prefix2; dirty = true; }
    if (Array.isArray(st.shots) && st.shots.length) {
      const shots2 = st.shots.map(cleanShot);
      if (dirty || shots2.some((s, i) => s !== st.shots[i])) { patch.shots = shots2; dirty = true; }
    }
    if (dirty) { store.set(patch); console.log("[MRBoardNext] 已自动清洗正文中的机器文件名 token"); }
  })();
  store.subscribe((st) => {
    try { localStorage.setItem(STORE_LS_KEY, JSON.stringify(st)); } catch (_) {}
  });

  const content = h("div", { class: "mx-content" });
  const nav = h("div", { class: "mx-nav" });
  const header = h(
    "div",
    { class: "mx-header" },
    h("div", { class: "mx-title" }, "MR分镜助手导演台 · Next"),
    h("div", { class: "mx-sub" }, "官方 H3 引擎 · 干净重写"),
    h("div", { class: "mx-spacer" }),
    // 主题色控制器
    h("div", { class: "row", style: { gap: 8, alignItems: "center", paddingRight: 4 } },
      h("span", { style: { fontSize: 11, color: "#9fb0c6" } }, "主题"),
      // 色盘预设按钮（6 色）
      ...["#4f9fe8", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#f87171"].map((c) =>
        h("div", {
          class: "mrnext-swatch",
          style: {
            width: 18, height: 18, borderRadius: "50%", cursor: "pointer",
            border: "2px solid transparent", background: c, boxShadow: `0 0 6px ${c}44`,
            transition: "transform .15s, border-color .15s",
          },
          title: "预设色：" + c,
          onclick: () => _applyThemeColor(c, true),
          onmouseenter: (e) => { e.target.style.transform = "scale(1.25)"; e.target.style.borderColor = "#fff"; },
          onmouseleave: (e) => { e.target.style.transform = ""; e.target.style.borderColor = "transparent"; },
        })
      ),
      // 自定义颜色选择器
      h("input", { type: "color", id: "mrnext-theme-color", value: store.get().themeColor || "#4f9fe8",
        style: { width: 24, height: 24, border: "2px solid #3a568a", borderRadius: "50%", cursor: "pointer", background: "transparent", padding: 2 } }),
      // 🌗 整体主题切换（三态循环）：🎨 默认 → ⚡ 蓝色流光 → 🔥 火焰流动
      // 一次切换即可覆盖「所有面板 + 所有按钮 + 导航 + 输入框 + 滚动条 + 动效」的整套配色
      h("button", { id: "mrnext-theme-mode", class: "btn", style: { padding: "3px 10px", fontSize: 11, borderRadius: 999 },
        title: "整体主题（点一次换一个）：🎨 默认 → ⚡ 蓝色流光 · 能量流动 → 🔥 火焰流动（全套面板/按钮配色 + 动效）",
        onclick: () => _cycleThemeMode() }, "🎨 默认"),
    )
  );

  const toast = (msg, err = false) => {
    const t = h("div", { class: "toast" + (err ? " err" : "") }, msg);
    shadow.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  };

  // 主题色 picker —— CSS 变量设到 shadow 内根元素 root（document 上的变量被 :host all:initial 切断，进不来）
  // 颜色工具：hex → {h,s,l}（s/l 0-100）与 hsl → hex，用于从主题色派生整套色阶
  const _hexToHsl = (hex) => {
    let r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s: s * 100, l: l * 100 };
  };
  const _hslToHex = (h, s, l) => {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
    return "#" + to(f(0)) + to(f(8)) + to(f(4));
  };
  const _shade = (hex, dl) => { const c = _hexToHsl(hex); return _hslToHex(c.h, c.s, Math.max(4, Math.min(96, c.l + dl))); };

  const _applyThemeColor = (color, isUser = false) => {
    const c = color || "#4f9fe8";
    // 用户手动选色才记 userThemeColor（切主题后回「默认」要还原它；主题自带的配色不算）
    store.set(isUser ? { themeColor: c, userThemeColor: c } : { themeColor: c });
    // 设到 shadow 内根元素：nav/header/content 全是 root 后代，继承生效
    root.style.setProperty("--mrnext-accent", c);
    root.style.setProperty("--mrnext-accent-soft", c + "26");
    root.style.setProperty("--accent", c);
    root.style.setProperty("--accent-soft", c + "26");
    // 从主题色派生整套色阶：覆盖金/蓝系变量 → 按钮、标题、面板底全部跟随主题色
    const glow = (() => { const n = parseInt(c.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.38)`; })();
    const hsl = _hexToHsl(c);
    // 按钮文字对比色：主题亮 → 深字；主题暗 → 白字
    const contrast = hsl.l > 55 ? "#241500" : "#ffffff";
    root.style.setProperty("--gold-contrast", contrast);
    root.style.setProperty("--gold-hi", _shade(c, 22));
    root.style.setProperty("--gold", c);
    root.style.setProperty("--gold-mid", _shade(c, -14));
    root.style.setProperty("--gold-deep", _shade(c, -30));
    root.style.setProperty("--gold-glow", glow);
    root.style.setProperty("--blue-hi", _hslToHex(hsl.h, Math.max(30, hsl.s * 0.8), 30));
    root.style.setProperty("--blue", _hslToHex(hsl.h, Math.max(35, hsl.s), 20));
    root.style.setProperty("--blue-deep", _hslToHex(hsl.h, Math.max(40, hsl.s), 11));
    // 当前激活面板的 content / 面板头也覆盖（有些样式引用更近的 --accent 声明）
    content.style.setProperty("--accent", c);
    content.style.setProperty("--accent-soft", c + "26");
    // 刷新所有 nav item 的 accent
    [...nav.children].forEach((item) => {
      item.style.setProperty("--accent", c);
      item.style.setProperty("--accent-soft", c + "26");
    });
    // 刷新所有已缓存 panel 的 content accent
    for (const name of Object.keys(panelCache)) {
      const el = content.querySelector(`[data-panel="${name}"]`);
      if (el) {
        el.style.setProperty("--accent", c);
        el.style.setProperty("--accent-soft", c + "26");
      }
    }
    // 颜色选择器同步（注意：元素在 shadow 内，必须用 header 查询，document.getElementById 查不到）
    try {
      const inp = header.querySelector("#mrnext-theme-color");
      if (inp && inp.value !== c) inp.value = c;
    } catch (_) {}
  };
  const ctx = { store, api: StudioAPI, viewUrl, toast, node, switchTo: (n) => activate(n) };
  const panelCache = {};
  let current = null;

  // 刷新已缓存面板（如出片后让剪辑面板重新拉素材列表）；面板未创建过则忽略
  ctx.refreshPanel = (name) => {
    const p = panelCache[name];
    if (p && typeof p.update === "function") { try { p.update(); } catch (_) {} }
  };

  // 颜色选择器 watcher（shadow 内查询）+ 延迟初始化（确保 current/panelCache 已声明）
  const thColorInp = header.querySelector("#mrnext-theme-color");
  if (thColorInp) {
    thColorInp.addEventListener("input", (e) => {
      _applyThemeColor(e.target.value, true);
    });
  }
  // ---- 整体主题：默认 / ⚡ 蓝色流光 / 🔥 火焰流动（三态循环，store.themeMode 持久化）----
  const THEME_MODES = [
    { id: "default", label: "🎨 默认", color: "#4f9fe8", cls: "" },
    { id: "flow", label: "⚡ 蓝色流光", color: "#00c8ff", cls: "mrnext-theme-flow" },
    { id: "fire", label: "🔥 火焰流动", color: "#ff7a18", cls: "mrnext-theme-fire" },
  ];
  const _applyThemeMode = (id) => {
    const mode = THEME_MODES.find((m) => m.id === id) || THEME_MODES[0];
    THEME_MODES.forEach((m) => { if (m.cls) root.classList.toggle(m.cls, m.id === mode.id); });
    const btn = header.querySelector("#mrnext-theme-mode");
    if (btn) {
      btn.textContent = mode.label;
      btn.classList.toggle("btn-primary", mode.id !== "default");
      btn.style.boxShadow = mode.id === "flow" ? "0 0 12px rgba(0,200,255,.6)"
        : mode.id === "fire" ? "0 0 12px rgba(255,122,24,.6)" : "";
    }
    // 主题自带配色；回到「默认」时恢复用户自己的主题色（不残留上一个主题的颜色）
    if (mode.id === "default") _applyThemeColor(store.get().userThemeColor || "#4f9fe8", false);
    else _applyThemeColor(mode.color, false);
    return mode;
  };
  const _cycleThemeMode = () => {
    const cur = store.get().themeMode || "default";
    const i = THEME_MODES.findIndex((m) => m.id === cur);
    const next = THEME_MODES[(i + 1) % THEME_MODES.length];
    store.set({ themeMode: next.id, themeFlow: next.id === "flow" });
    _applyThemeMode(next.id);
    toast(`已切换主题：${next.label}`);
  };
  _applyThemeColor(store.get().themeColor || "#4f9fe8");
  // 兼容老状态：只有 themeFlow=true 的旧数据 → 视为蓝色流光
  _applyThemeMode(store.get().themeMode || (store.get().themeFlow ? "flow" : "default"));

  function activate(name) {
    const meta = PANELS.find((x) => x.name === name);
    [...nav.children].forEach((c) =>
      c.classList.toggle("active", c.dataset.name === name)
    );
    clear(content);
    // 优先用用户选的主题色，否则降级到面板默认色
    const accent = store.get().themeColor || meta.accent;
    content.style.setProperty("--accent", accent);
    content.style.setProperty("--accent-soft", accent + "26");
    content.dataset.panel = name; // 供 CSS 做面板级布局（timeline 撑满可用高度）
    content.appendChild(
      h(
        "div",
        { class: "mx-panel-head" },
        h("div", { class: "picon" }, meta.icon),
        h("div", { class: "ptitle" }, meta.label),
        h("div", { class: "psub" }, meta.sub),
        h("div", { class: "pspacer" })
      )
    );
    let p = panelCache[name];
    if (!p) {
      // ③ 单个面板抛错：渲错误条 + 该面板降级显示，其它 9 个面板照常工作
      try {
        p = meta.make(ctx);
        panelCache[name] = p;
      } catch (e) {
        console.error("[MRBoardNext] panel " + name + " failed", e);
        const errEl = h("div", {
          style: "padding:18px;background:#1a0e10;color:#ffb5b5;border-radius:8px;border:1px solid #5a2020;margin:12px;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;",
        });
        const stack = String(e && (e.stack || e.message || e) || "(unknown)");
        errEl.textContent = "⚠ 「" + meta.label + "」面板初始化失败：\n\n" + stack
          + "\n\n提示：去 DevTools Console 过滤 MRBoardNext 看其它堆栈；"
          + "多数情况是 JS 字符串里嵌中文双引号。";
        content.appendChild(errEl);
        current = name;
        return;
      }
    }
    content.appendChild(p.el);
    if (typeof p.update === "function") {
      try {
        p.update();
      } catch (_) {}
    }
    current = name;
  }

  for (const p of PANELS) {
    const item = h(
      "button",
      {
        class: "mx-nav-item" + (p.name === "script" ? " active" : ""),
        dataset: { name: p.name },
        onclick: () => activate(p.name),
      },
      h("span", { class: "nicon" }, p.icon),
      p.label
    );
    item.style.setProperty("--accent", store.get().themeColor || p.accent);
    item.style.setProperty("--accent-soft", (store.get().themeColor || p.accent) + "26");
    nav.appendChild(item);
  }

  // ---------- 左侧圆形按钮 + 向左滑出抽屉（剧本·分镜 协作台）----------
  // 复用两个面板实例（与主面板共用同一 store，自动双向同步），
  // 两栏并排：剧本（编辑/拆分/抽取）· 分镜（格子/时长/匹配引用）
  const drawerBody = h("div", { class: "mx-drawer-body" });
  const drawer = h("div", { class: "mx-drawer tri-layout" },
    h("div", { class: "mx-drawer-head" },
      h("div", { class: "mx-drawer-title" }, "剧本 · 分镜 协作台"),
      h("div", { class: "mx-spacer" }),
      h("span", { class: "mx-drawer-hint" }, "两面板共用同一剧本/分镜/收藏库"),
      h("button", { class: "mx-drawer-close", title: "收起", onclick: () => toggleDrawer(false) }, "✕")),
    drawerBody);
  const fab = h("button", {
    class: "mx-fab", title: "展开「剧本·分镜 协作台」（点击向左滑出）",
    onclick: () => toggleDrawer(),
  }, "📑");
  const drawerScript = createScriptPanel(ctx);
  const drawerShots = createShotsPanel(ctx);
  // 两个 sec 容器，各自有独立的 header（dsub）+ 可滚动 body
  const secScript = h("div", { class: "mx-drawer-sec" });
  const secShots = h("div", { class: "mx-drawer-sec" });
  secScript.appendChild(h("div", { class: "mx-dsub" },
    h("span", { class: "mx-dsub-dot" }, "📜"), "剧本",
    h("div", { class: "mx-spacer" }),
    h("span", { class: "muted", style: { fontSize: 10 } }, "输入/拆分/抽前缀")));
  secScript.appendChild(h("div", { class: "mx-drawer-sec-body" }, drawerScript.el));
  secShots.appendChild(h("div", { class: "mx-dsub" },
    h("span", { class: "mx-dsub-dot" }, "🎞️"), "分镜",
    h("div", { class: "mx-spacer" }),
    h("span", { class: "muted", style: { fontSize: 10 } }, "格子/时长/匹配引用")));
  secShots.appendChild(h("div", { class: "mx-drawer-sec-body" }, drawerShots.el));
  drawerBody.append(secScript, secShots);
  let drawerOpen = false;
  let origNodeSize = null; // 打开协作台前的节点尺寸（关闭时恢复）
  let origCanvasZoom = null; // 打开协作台前的画布缩放（关闭时恢复）
  // 强制画布缩放为指定值（让节点/DOM widget 按 1:1 显示，不被画布缩放压小内部 UI）
  function setCanvasZoom(z) {
    try {
      const a = (typeof app !== "undefined") ? app : window.app;
      const c = a && a.canvas;
      if (c && c.ds) { c.ds.scale = z; if (typeof c.change === "function") c.change(); }
    } catch (_) {}
  }
  function toggleDrawer(force) {
    drawerOpen = force == null ? !drawerOpen : !!force;
    drawer.classList.toggle("open", drawerOpen);
    fab.classList.toggle("active", drawerOpen);
    fab.textContent = drawerOpen ? "◧" : "📑";
    if (drawerOpen) {
      // 展开为「两个节点大小」：节点宽度尽量翻倍（drawer 与 .mx-body 在 .mx-main-area 各占 50% = 原节点宽），
      // 但限制为不超出 ComfyUI 画布 viewport（避免节点右边凸出画布外）。
      if (!origNodeSize && node && node.size) {
        origNodeSize = [Number(node.size[0]) || 1100, Number(node.size[1]) || 860];
        let targetW = origNodeSize[0] * 2;
        try {
          const a = (typeof app !== "undefined") ? app : window.app;
          const canvasW = a && a.canvas && a.canvas.canvas && a.canvas.canvas.clientWidth;
          if (canvasW && canvasW > 0) {
            targetW = Math.min(targetW, canvasW - 20); // 不超画布 viewport（留 20px 边距）
          } else {
            targetW = Math.min(targetW, (window.innerWidth || 1920) - 40);
          }
        } catch (_) {}
        targetW = Math.max(origNodeSize[0], targetW); // 至少保持原宽
        try { node.setSize([targetW, origNodeSize[1]]); } catch (_) {}
      }
      // 协作台展开时把画布缩放强制为 1，让 drawer 内部 UI 按真实 CSS 像素 1:1 清晰显示
      // （否则 ComfyUI 画布会自动 fit 节点导致整体缩小，drawer 内部按钮/字体视觉上变小）
      if (origCanvasZoom == null) {
        try {
          const a = (typeof app !== "undefined") ? app : window.app;
          const c = a && a.canvas;
          if (c && c.ds) origCanvasZoom = c.ds.scale;
        } catch (_) { origCanvasZoom = null; }
      }
      setCanvasZoom(1);
    } else {
      // 关闭：恢复节点原大小 + 画布原缩放
      if (origNodeSize && node) {
        try { node.setSize(origNodeSize); } catch (_) {}
        origNodeSize = null;
      }
      if (origCanvasZoom != null) { setCanvasZoom(origCanvasZoom); origCanvasZoom = null; }
    }
  }

  // 主区域：drawer（左，折叠时宽度0） + nav+content（右）
  const mainArea = h("div", { class: "mx-main-area" }, drawer, h("div", { class: "mx-body" }, nav, content));
  root.append(header, mainArea, fab);
  activate("script");
}
