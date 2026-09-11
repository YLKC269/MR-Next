// core/styles.js — 统一主题：磨砂亮面深蓝金属面板 + 黄金色金属按钮 + 流畅动效
// 每面板用 CSS 变量 --accent / --accent-soft 驱动标题/图标/激活态；按钮统一金色金属质感。
// 按钮交互有「能量流动」动画（hover 持续扫描 + active 闪光点击）；下拉框匹配节点主题、文字清晰。

export const CSS = `
:host, .mrnext-root { all: initial; box-sizing: border-box; display: block; width: 100%; height: 100%;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #e9effa; background: var(--blue-deep);
  --ease: cubic-bezier(.22,.68,.32,1);
  --gold-hi: #ffe9a8; --gold: #f5ca57; --gold-mid: #e3aa3d; --gold-deep: #c98a1e;
  --gold-glow: rgba(222,170,60,.38);
  --panel-hi: rgba(255,255,255,.07);
  --panel-line: rgba(120,170,255,.16);
  --blue-hi: #274d7e; --blue: #1a2e52; --blue-deep: #0d1730;
  --mrnext-accent: #4f9fe8;   /* 用户主题色（默认蓝色） */
  --mrnext-accent-soft: rgba(79,158,232,.26);
  /* --accent 和 --accent-soft 是面板级变量，默认等于 --mrnext-accent，激活面板时会被覆盖 */
  --accent: var(--mrnext-accent);
  --accent-soft: var(--mrnext-accent-soft); }
* { box-sizing: border-box; }
.mrnext-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; position: relative; }
/* Skill 优化面板：左右双栏 —— 左「① 技能库 / ② 本地模型」，右「③ 优化」填满右侧空白，
   并随面板高度自适应缩放（两个多行框 flex 拉伸，面板变高就变高，变矮就缩，不溢出）。 */
.mx-content[data-panel="skill"] { display: flex; flex-direction: column; overflow: hidden; }
.mx-content[data-panel="skill"] > .mx-panel-head { flex: 0 0 auto; margin-bottom: 10px; }
.mx-content[data-panel="skill"] > .col { flex: 1 1 auto; min-height: 0; }
.sk-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; overflow-y: auto; }
.sk-col-left, .sk-col-right { flex: 1 1 0; }
.sk-col > .section { margin-bottom: 0; flex: 0 0 auto; }
/* 右栏的 ③ 优化 撑满整列：里面的输入/结果框按剩余空间自动分配高度 */
.sk-col-right > .section { display: flex; flex-direction: column; gap: 7px; flex: 1 1 auto; min-height: 0; }
/* 右下角「④ 推理过程」：与 ③ 优化 上下分栏（③ 占 3、④ 占 2），随面板高度等比伸缩 */
.sk-col-right > .section.sk-reason { flex: 2 1 0; min-height: 120px; }
.sk-col-right > .section.sk-reason > .sk-grow { min-height: 84px; }
.sk-col-right > .section.sk-reason > h3 { flex: 0 0 auto; }
/* 右栏里的按钮行/下拉行保持自身高度，不被两个多行框挤扁 */
.sk-col-right > .section > .row { flex: 0 0 auto; }
.sk-col-right .sk-grow { flex: 1 1 auto; min-height: 96px; resize: vertical; }

::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-track { background: rgba(255,255,255,.02); }
::-webkit-scrollbar-thumb { background: linear-gradient(180deg, #2c4a7a, #1c3358); border-radius: 5px; border: 1px solid rgba(255,255,255,.06); }
::-webkit-scrollbar-thumb:hover { background: linear-gradient(180deg, #3a5f96, #24406a); }

/* ---------- 主题色色盘 ---------- */
.mrnext-swatch { width: 18px; height: 18px; border-radius: 50%; cursor: pointer;
  border: 2px solid transparent; transition: transform .15s, border-color .15s, box-shadow .15s;
  box-shadow: 0 0 6px rgba(0,0,0,.3); }
.mrnext-swatch:hover { transform: scale(1.3); border-color: rgba(255,255,255,.9); }

/* ---------- 顶部 ---------- */
.mx-header { flex: 0 0 auto; display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; background: linear-gradient(180deg, var(--blue-hi) 0%, var(--blue-deep) 100%);
  border-bottom: 1px solid var(--panel-line); box-shadow: 0 2px 12px rgba(0,0,0,.35); }
.mx-title { font-size: 15px; font-weight: 800; letter-spacing: .8px;
  background: linear-gradient(180deg, var(--gold-hi) 0%, var(--gold) 55%, var(--gold-mid) 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 1px 0 rgba(0,0,0,.4)) drop-shadow(0 0 12px var(--gold-glow)); }
.mx-sub { font-size: 11.5px; color: #7d92b4; }
.mx-spacer { flex: 1 1 auto; }
.mx-tag { font-size: 10.5px; color: var(--gold-hi); border: 1px solid #6b551f;
  background: linear-gradient(180deg, #2c2410, #1a150a); padding: 1px 7px; border-radius: 999px; }

/* ---------- 导航 ---------- */
.mx-body { flex: 1 1 auto; display: flex; min-height: 0; }
.mx-nav { flex: 0 0 158px; display: flex; flex-direction: column; gap: 5px;
  padding: 10px 8px; background: linear-gradient(180deg, rgba(13,23,48,.96), rgba(8,15,32,.96));
  border-right: 1px solid var(--panel-line); overflow: auto; }
.mx-nav-item { text-align: left; display: flex; align-items: center; gap: 7px; padding: 9px 10px;
  border-radius: 10px; cursor: pointer; background: rgba(24,38,66,.5); color: #a4b6d0;
  border: 1px solid transparent; font-size: 12.5px; position: relative;
  transition: all .2s var(--ease); overflow: hidden; }
.mx-nav-item::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(120deg, transparent 30%, rgba(245,202,87,.16) 48%, rgba(245,202,87,.32) 50%, rgba(245,202,87,.16) 52%, transparent 70%);
  transform: translateX(-120%); transition: none; }
.mx-nav-item:hover::before { animation: mxEnergyFlow .9s var(--ease) both; }
.mx-nav-item:hover { background: rgba(40,60,95,.55); color: #eaf0fa; transform: translateX(2px);
  box-shadow: inset 0 1px 0 var(--panel-hi); }
.mx-nav-item.active { background: linear-gradient(90deg, var(--accent-soft, #1a3a66) 0%, #14233f 80%);
  color: #fff; border-color: var(--accent, #4f9fe8); box-shadow: inset 0 1px 0 var(--panel-hi), inset 2px 0 0 var(--accent, #4f9fe8), 0 0 16px var(--accent-soft, rgba(79,158,232,.3)); }
.mx-nav-item.active::after { content: ""; position: absolute; right: 8px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent, #4f9fe8); box-shadow: 0 0 9px var(--accent, #4f9fe8); }
.mx-nav-item .nicon { font-size: 14px; flex: 0 0 auto; }

/* ---------- 内容区 ---------- */
.mx-content { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; padding: 14px 16px;
  background:
    radial-gradient(1100px 500px at 16% -10%, rgba(70,120,190,.16), transparent 62%),
    radial-gradient(900px 460px at 100% 0%, rgba(200,160,60,.07), transparent 55%),
    linear-gradient(180deg, #0c1530 0%, #0a1120 100%); }
.mx-panel-head { display: flex; align-items: center; gap: 10px; padding: 9px 14px; margin-bottom: 12px;
  border-radius: 12px; border-left: 3px solid var(--accent, #4f9fe8);
  background: linear-gradient(90deg, var(--accent-soft, #183251) 0%, rgba(16,26,46,.72) 100%);
  border: 1px solid var(--panel-line); border-left-width: 3px;
  box-shadow: 0 4px 16px rgba(0,0,0,.3), inset 0 1px 0 var(--panel-hi);
  animation: mxFadeIn .34s var(--ease) both; }
.mx-panel-head .picon { font-size: 17px; filter: drop-shadow(0 0 6px var(--accent-soft, rgba(79,158,232,.4))); }
.mx-panel-head .ptitle { font-size: 14px; font-weight: 800; color: var(--accent, #9fd4ff); letter-spacing: .4px; }
.mx-panel-head .psub { font-size: 11.5px; color: #8ba0c0; }
.mx-panel-head .pspacer { flex: 1 1 auto; }

@keyframes mxFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

/* 「能量流动」扫描动画：金属高光从左上扫向右下 */
@keyframes mxEnergyFlow {
  0% { transform: translateX(-120%) skewX(-18deg); }
  100% { transform: translateX(160%) skewX(-18deg); }
}
/* 点击瞬间的「能量脉冲」：径向扩散的金色光圈 */
@keyframes mxEnergyPulse {
  0% { transform: scale(.3); opacity: .9; }
  100% { transform: scale(2.4); opacity: 0; }
}

/* 时间线面板独占可用高度 */
.mx-content[data-panel="timeline"] { display: flex; flex-direction: column; overflow: hidden; padding: 10px 12px 12px; }
.mx-content[data-panel="timeline"] > .mx-panel-head { flex: 0 0 auto; margin-bottom: 8px; }
.mx-content[data-panel="timeline"] > .col { flex: 1 1 auto; min-height: 0; }

/* ---------- 左侧圆形按钮 + 协作台侧边栏（与主界面并排）---------- */
.mrnext-root { position: relative; overflow: hidden; }
.mx-fab { position: absolute; left: 12px; bottom: 12px; z-index: 60; width: 46px; height: 46px;
  border-radius: 50%; border: 1px solid rgba(245,202,87,.55); cursor: pointer;
  background: linear-gradient(180deg, var(--gold-hi), var(--gold-mid)); color: var(--gold-contrast, #1a1200); font-size: 19px; line-height: 1;
  display: flex; align-items: center; justify-content: center; box-shadow: 0 6px 18px rgba(222,170,60,.45);
  transition: transform .16s var(--ease), box-shadow .16s, background .16s; }
.mx-fab:hover { transform: scale(1.08); box-shadow: 0 8px 24px rgba(222,170,60,.6); }
.mx-fab.active { background: linear-gradient(180deg, #ff9a9a, #c43838); color: #fff; border-color: #ff7d7d; }
.mx-fab::after { content: "协作台"; position: absolute; top: -22px; left: 50%; transform: translateX(-50%);
  font-size: 10px; color: #ffd98f; background: rgba(0,0,0,.6); border: 1px solid rgba(255,209,102,.3);
  padding: 1px 7px; border-radius: 999px; white-space: nowrap; opacity: 0; transition: opacity .15s; pointer-events: none; }
.mx-fab:hover::after { opacity: 1; }

/* 主区域：nav+content（左） + 协作台侧边栏（右，折叠时宽度为0） */
.mx-main-area { display: flex; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.mx-drawer {
  width: 0; min-width: 0; max-width: 96vw;
  background: linear-gradient(180deg, #0e1a30 0%, #0a1322 100%);
  border-right: 1px solid #2a3a5e;
  display: flex; flex-direction: column; min-height: 0;
  flex: 0 0 auto; /* 不被 .mx-body 压缩，保证 drawer.open width:50% 真正占一半 */
  transition: width .24s var(--ease);
  overflow: hidden;
}
.mx-drawer.open { width: 50%; overflow: hidden; }
.mx-drawer-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 9px 12px;
  background: linear-gradient(180deg, var(--blue-hi), var(--blue-deep)); border-bottom: 1px solid var(--panel-line); }
.mx-drawer-title { font-size: 13px; font-weight: 800; color: #ffcf6b; letter-spacing: .4px; }
.mx-drawer-hint { font-size: 10.5px; color: #7d92b4; }
.mx-drawer-close { margin-left: 4px; width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
  background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); color: #cdd8ea; font-size: 13px; line-height: 1; }
.mx-drawer-close:hover { background: rgba(255,80,80,.25); border-color: #ff7d7d; color: #fff; }
.mx-drawer-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px 14px;
  display: flex; flex-direction: column; gap: 12px; }
.mx-drawer-sec { background: rgba(255,255,255,.02); border: 1px solid #20314f; border-radius: 12px; padding: 8px 10px; }
.mx-dsub { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; color: #9fd0ff;
  margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px dashed rgba(120,170,255,.18); }
.mx-dsub-dot { font-size: 14px; }
/* 抽屉内剧本/分镜面板：去掉外层最大宽度限制，自适应抽屉宽度 */
.mx-drawer .col { max-width: none !important; }

/* ---- 协作台两面板布局（上下：剧本 + 分镜）----
   打开协作台时节点 setSize 扩大到 2× 原宽（drawer 与 .mx-body 在 .mx-main-area 各占 50% = 原节点宽），
   drawer 内 column：上 = 剧本 section（全宽），下 = 分镜 section（全宽）。 */
.mx-drawer.tri-layout .mx-drawer-body {
  flex-direction: column; gap: 0; padding: 0;
  overflow: hidden; min-height: 0; height: 100%;
}
.mx-drawer.tri-layout .mx-drawer-sec {
  flex: 1 1 0; min-width: 0; min-height: 0; margin: 0;
  border: 0; border-radius: 0;
  border-bottom: 1px solid #20314f;
  display: flex; flex-direction: column;
  background: transparent;
  height: 100%;
}
.mx-drawer.tri-layout .mx-drawer-sec:last-child { border-bottom: 0; }
.mx-drawer.tri-layout .mx-dsub {
  flex: 0 0 auto; margin: 0; padding: 8px 12px 6px;
  border-bottom: 1px dashed rgba(120,170,255,.18);
  background: rgba(13,23,48,.6);
}
.mx-drawer.tri-layout .mx-dsub .mx-spacer { min-width: 8px; }
.mx-drawer.tri-layout .mx-drawer-sec-body { flex: 1 1 0; min-height: 0; overflow: auto; padding: 8px; }
.mx-drawer.tri-layout .mx-drawer-sec-body .col { max-width: none !important; }

/* ---- 协作台抽屉内的紧凑布局（窄宽度适配） ---- */
/* 抽屉内所有内联 1fr/1fr 双列布局 → 单列（避免按钮被挤成竖排） */
.mx-drawer.tri-layout .mx-drawer-sec-body div[style*="grid-template-columns: 1fr 1fr"],
.mx-drawer.tri-layout .mx-drawer-sec-body .grid.cols-2 {
  grid-template-columns: minmax(0, 1fr) !important;
}
/* 抽屉内分镜格子：自动适配 → 1 列（卡片占满宽度，不再被挤成竖条） */
.mx-drawer.tri-layout .mx-drawer-sec-body .grid.cols-3 { grid-template-columns: minmax(0, 1fr); }
/* 抽屉内 mention editor：固定最大高度 + 内部滚动（不随文字拉伸）。
   !important 覆盖剧本面板内联的 maxHeight（避免在抽屉里依然撑高） */
.mx-drawer.tri-layout .mx-drawer-sec-body .mention-ed { max-height: 200px !important; overflow-y: auto !important; resize: none !important; }
/* 抽屉内 scard header 允许换行（按钮多时不挤压） */
.mx-drawer.tri-layout .mx-drawer-sec-body .scard > .hd { flex-wrap: wrap; row-gap: 4px; }
/* 抽屉内整体字号与按钮略小（更紧凑） */
.mx-drawer.tri-layout .mx-drawer-sec-body { font-size: 12px; }
.mx-drawer.tri-layout .mx-drawer-sec-body .btn { padding: 5px 9px; font-size: 11.5px; }
/* 抽屉内剧本面板头部行（带 mx-spacer 的标题行）→ 不挤压，按钮可换行保持横向 */
.mx-drawer.tri-layout .mx-drawer-sec-body .row > .label { flex: 0 0 auto; }
.mx-drawer.tri-layout .mx-drawer-sec-body .row > .mx-spacer { flex: 0 1 auto; min-width: 6px; }
.mx-drawer.tri-layout .mx-drawer-sec-body .row > .btn { flex: 0 0 auto; }

/* ---------- 按钮：黄金色金属 + 能量流动 ---------- */
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 13px; border-radius: 9px;
  border: 1px solid rgba(216,174,66,.32);
  background: linear-gradient(180deg, #23324f 0%, #18233c 100%);
  color: #f2dfb0; font-size: 12.5px; cursor: pointer; font-weight: 600;
  box-shadow: inset 0 1px 0 var(--panel-hi), 0 2px 6px rgba(0,0,0,.3);
  transition: all .18s var(--ease); position: relative; overflow: hidden; isolation: isolate; }
.btn::before { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 1;
  background: linear-gradient(120deg, transparent 30%, rgba(245,202,87,.22) 48%, rgba(255,233,168,.42) 50%, rgba(245,202,87,.22) 52%, transparent 70%);
  transform: translateX(-130%) skewX(-18deg); opacity: 0; }
.btn:hover::before { opacity: 1; animation: mxEnergyFlow 1s var(--ease) infinite; }
.btn:hover { border-color: rgba(240,195,80,.7); color: #ffe9a8; transform: translateY(-1px);
  box-shadow: inset 0 1px 0 var(--panel-hi), 0 5px 16px rgba(0,0,0,.4), 0 0 14px rgba(240,195,80,.18); }
.btn:active { transform: translateY(0) scale(.96); box-shadow: inset 0 2px 5px rgba(0,0,0,.35); }
.btn:active::before { animation: mxEnergyFlow .5s var(--ease) both; opacity: 1; }
/* 点击瞬间的金色脉冲（ripple）——由 JS 加 mx-pulse 子元素触发 */
.btn > .mx-pulse { position: absolute; left: 50%; top: 50%; width: 16px; height: 16px;
  border-radius: 50%; background: radial-gradient(circle, rgba(255,233,168,.95) 0%, rgba(245,202,87,.55) 40%, transparent 70%);
  pointer-events: none; transform: translate(-50%, -50%) scale(.3); opacity: 0; z-index: 2;
  animation: mxEnergyPulse .65s var(--ease) forwards; }
.btn-primary { background: linear-gradient(180deg, var(--gold-hi) 0%, var(--gold) 42%, var(--gold-mid) 74%, var(--gold-deep) 100%);
  border-color: var(--gold-mid); color: var(--gold-contrast, #3a2503); font-weight: 800;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.7), inset 0 -2px 4px rgba(140,80,0,.35), 0 3px 12px var(--gold-glow); }
.btn-primary::before { background: linear-gradient(120deg, transparent 30%, rgba(255,255,255,.55) 48%, rgba(255,255,255,.85) 50%, rgba(255,255,255,.55) 52%, transparent 70%); }
.btn-primary:hover { background: linear-gradient(180deg, var(--gold-hi) 0%, var(--gold-hi) 42%, var(--gold) 74%, var(--gold-mid) 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.8), inset 0 -2px 4px rgba(140,80,0,.32), 0 6px 20px rgba(235,185,70,.5); }
.btn:disabled { opacity: .45; cursor: not-allowed; filter: grayscale(.35); transform: none; }
.btn:disabled::before { display: none; }

/* ---------- 下拉框 / 输入框：节点主题（深蓝金属 + 金色高亮 + 文字清晰）---------- */
.input, .textarea, .select { width: 100%; padding: 9px 12px; border-radius: 9px;
  border: 1px solid rgba(120,170,255,.24); background: linear-gradient(180deg, rgba(16,28,52,.95), rgba(10,18,36,.95));
  color: #f0f4fb; font-size: 13px; font-weight: 500; font-family: inherit;
  box-shadow: inset 0 1px 4px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.04);
  transition: border-color .18s var(--ease), box-shadow .18s var(--ease), background .18s var(--ease); }
.input::placeholder, .textarea::placeholder { color: #6b7d96; font-weight: 400; }
.input:hover, .textarea:hover, .select:hover { border-color: rgba(216,174,66,.45);
  box-shadow: inset 0 1px 4px rgba(0,0,0,.4), 0 0 0 1px rgba(245,202,87,.12); }
.input:focus, .textarea:focus, .select:focus { outline: none; border-color: var(--gold, #f5ca57);
  box-shadow: inset 0 1px 4px rgba(0,0,0,.4), 0 0 0 3px rgba(245,202,87,.18), 0 0 14px rgba(245,202,87,.15); background: rgba(18,30,54,.95); }
.textarea { min-height: 150px; resize: vertical; line-height: 1.65; padding: 11px 13px; font-size: 13px; }

/* select 自定义箭头（金色金属 chevron） */
.select { appearance: none; -webkit-appearance: none; -moz-appearance: none;
  padding-right: 32px; cursor: pointer; line-height: 1.4;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--gold) 50%),
    linear-gradient(135deg, var(--gold) 50%, transparent 50%);
  background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat; }
.select::-ms-expand { display: none; }
/* select 当前项（选中态）—— 使用 :checked 样式；展开项的背景由浏览器 native 处理（深色化） */
select.select option { background: linear-gradient(180deg, #15233f, #0e1830); color: #f0f4fb;
  padding: 6px 4px; font-weight: 500; }
select.select option:hover { background: linear-gradient(180deg, #1e3258, #14233f); color: #ffe9a8; }
select.select option:checked { background: linear-gradient(180deg, #3a2c10, #221a08);
  color: #ffe9a8; font-weight: 700;
  box-shadow: inset 0 0 0 999px rgba(245,202,87,.18); }
select.select:focus option:checked { box-shadow: inset 0 0 0 999px rgba(245,202,87,.28); }

.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.col { display: flex; flex-direction: column; gap: 9px; }
.label { font-size: 11.5px; color: #8ba0c0; margin-bottom: 4px; font-weight: 600; }
.section { margin-bottom: 14px; }
.section > h3 { font-size: 12.5px; color: var(--accent, #9fd4ff); margin: 0 0 8px; font-weight: 700;
  display: flex; align-items: center; gap: 6px; }
.section > h3::before { content: ""; width: 3px; height: 12px; border-radius: 2px;
  background: var(--accent, #5a9fe8); box-shadow: 0 0 8px var(--accent, #5a9fe8); }

/* ---------- 磨砂亮面深蓝金属面板 ---------- */
.card { background: linear-gradient(160deg, rgba(34,52,88,.72) 0%, rgba(15,26,48,.86) 100%);
  border: 1px solid var(--panel-line); border-radius: 13px; padding: 13px;
  box-shadow: 0 6px 22px rgba(0,0,0,.35), inset 0 1px 0 var(--panel-hi), inset 0 -1px 0 rgba(0,0,0,.25); }
.grid { display: grid; gap: 10px; }
.grid.cols-2 { grid-template-columns: repeat(2, 1fr); }
.grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
.grid.cols-auto { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }

.shot-card { background: linear-gradient(180deg, #1c2c4c, #121d36); border: 1px solid var(--panel-line);
  border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 7px;
  box-shadow: inset 0 1px 0 var(--panel-hi); transition: all .18s var(--ease); position: relative; overflow: hidden; }
.shot-card::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(120deg, transparent 30%, rgba(245,202,87,.18) 50%, transparent 70%);
  transform: translateX(-130%) skewX(-18deg); opacity: 0; }
.shot-card:hover::before { animation: mxEnergyFlow 1s var(--ease) both; }
.shot-card:hover { border-color: var(--accent, #4f9fe8); transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,.35); }
.shot-idx { font-size: 12px; font-weight: 700; color: var(--accent, #8fd4ff); display: flex; align-items: center; gap: 6px; }
.shot-idx::before { content: "▶"; font-size: 9px; opacity: .7; }
.shot-text { font-size: 12px; color: #cdd9e8; line-height: 1.55; max-height: 96px; overflow: auto; white-space: pre-wrap; }

.tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-right: 4px; }
.tag.image { background: #0f3527; color: #7ff0bf; border: 1px solid #1d6b4b; }
.tag.video { background: #0e2c45; color: #86d4ff; border: 1px solid #1d5f8c; }
.tag.audio { background: #33270e; color: #ffd98f; border: 1px solid #6b5118; }

.asset-item { background: linear-gradient(180deg, #16253f, #0e1830); border: 1px solid var(--panel-line);
  border-radius: 12px; overflow: hidden; cursor: pointer; box-shadow: inset 0 1px 0 var(--panel-hi);
  transition: all .18s var(--ease); position: relative; }
.asset-item:hover { border-color: var(--accent, #4f9fe8); transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,.4); }
.asset-item img, .asset-item video { width: 100%; height: 110px; object-fit: cover; display: block; background: #05070c; }
.asset-name { font-size: 11px; color: #9db0ca; padding: 5px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.asset-item.sel { outline: 2px solid var(--accent, #4f9fe8); }
.asset-item.chk { outline: 2px solid #e04a4a; }

.timeline { display: flex; gap: 9px; overflow-x: auto; padding: 6px 0 10px; }
.tl-shot { flex: 0 0 auto; width: 176px; background: linear-gradient(180deg, #1b2b4a, #111c34);
  border: 1px solid var(--panel-line); border-radius: 11px; padding: 9px;
  box-shadow: inset 0 1px 0 var(--panel-hi); transition: all .18s var(--ease); position: relative; overflow: hidden; }
.tl-shot::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(120deg, transparent 30%, rgba(245,202,87,.16) 50%, transparent 70%);
  transform: translateX(-130%) skewX(-18deg); opacity: 0; }
.tl-shot:hover::before { animation: mxEnergyFlow 1s var(--ease) both; }
.tl-shot:hover { border-color: var(--accent, #4f9fe8); transform: translateY(-1px); }
.tl-shot.active { border-color: var(--accent, #4f9fe8); box-shadow: 0 0 0 1px var(--accent, #4f9fe8), 0 0 14px var(--accent-soft, rgba(79,158,232,.3)); }

.seg-row { display: flex; align-items: center; gap: 8px; padding: 6px 2px; border-bottom: 1px solid rgba(120,170,255,.1); }
.seg-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent, #4f9fe8); }

.toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 999;
  background: linear-gradient(180deg, #1d2c4d, #131e38); border: 1px solid var(--panel-line);
  color: #eef4fb; padding: 10px 16px; border-radius: 11px; font-size: 12.5px;
  box-shadow: 0 12px 34px rgba(0,0,0,.55), inset 0 1px 0 var(--panel-hi);
  animation: mxFadeIn .25s var(--ease) both; }
.toast.err { border-color: #a34444; color: #ffc9c9; }
.muted { color: #8ba0c0; font-size: 12px; }
.empty { color: #66748a; font-size: 13px; padding: 26px; text-align: center; }

/* ---------- 分段 tab ---------- */
.ptab { display: inline-flex; align-items: center; gap: 5px; padding: 5px 13px; border-radius: 999px;
  border: 1px solid rgba(120,170,255,.18); background: rgba(20,32,56,.6); color: #9db0ca;
  font-size: 12px; cursor: pointer; line-height: 1.3; transition: all .18s var(--ease);
  position: relative; overflow: hidden; }
.ptab::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(120deg, transparent 30%, rgba(245,202,87,.22) 50%, transparent 70%);
  transform: translateX(-130%) skewX(-18deg); opacity: 0; }
.ptab:hover::before { animation: mxEnergyFlow .9s var(--ease) both; }
.ptab:hover { color: #eef4fb; border-color: rgba(216,174,66,.4); transform: translateY(-1px); }
.ptab.on { background: var(--accent-soft, #1a3a66); border-color: var(--accent, #4f9fe8); color: #f2f9ff;
  box-shadow: 0 0 12px var(--accent-soft, rgba(79,158,232,.3)), inset 0 1px 0 var(--panel-hi); }
.ptab .pc { font-size: 10px; background: rgba(255,255,255,.1); border-radius: 999px; padding: 0 6px; color: #bcd0e8; }
.ptab.on .pc { background: rgba(255,255,255,.18); color: #fff; }
.pstrip { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

/* ---------- 媒体卡 ---------- */
.mcard { position: relative; border-radius: 12px; overflow: hidden; cursor: pointer;
  background: linear-gradient(180deg, #142138, #0c1526); border: 1.5px solid #29395a;
  aspect-ratio: 1; display: flex; flex-direction: column; box-shadow: inset 0 1px 0 var(--panel-hi);
  transition: all .2s var(--ease); }
.mcard:hover { border-color: var(--accent, #4f9fe8); box-shadow: 0 10px 26px rgba(0,0,0,.5), inset 0 1px 0 var(--panel-hi); transform: translateY(-3px); }
.mcard.role { border-color: rgba(244,114,182,.55); } .mcard.scene { border-color: rgba(94,234,212,.5); }
.mcard.asset { border-color: rgba(201,166,255,.5); } .mcard.audio { border-color: rgba(255,209,102,.5); }
.mcard .th { position: absolute; inset: 0; }
.mcard .th img, .mcard .th video { width: 100%; height: 100%; object-fit: cover; display: block; background: #05070c; }
.mcard .veil { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(5,8,16,0) 42%, rgba(5,8,16,.9) 100%); pointer-events: none; }
.mcard .mn { position: absolute; left: 0; right: 0; bottom: 0; padding: 18px 8px 6px; color: #dbe7f4; font-size: 11.5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; text-shadow: 0 1px 3px #000; }
.mcard .kd { position: absolute; top: 6px; left: 6px; font-size: 10px; padding: 1px 7px; border-radius: 999px;
  background: rgba(0,0,0,.55); color: #9fe0ff; border: 1px solid #2d5f8a; pointer-events: none; }
.mcard .act { position: absolute; top: 5px; right: 5px; display: flex; gap: 4px; opacity: 0; transform: translateY(-3px); transition: all .18s var(--ease); }
.mcard:hover .act { opacity: 1; transform: translateY(0); }
.mcard .abtn { border: 0; background: rgba(0,0,0,.62); color: #ffe9a8; cursor: pointer; width: 24px; height: 24px;
  border-radius: 8px; font-size: 12px; line-height: 1; transition: all .15s var(--ease); position: relative; overflow: hidden; }
.mcard .abtn::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(120deg, transparent 30%, rgba(245,202,87,.5) 50%, transparent 70%);
  transform: translateX(-130%) skewX(-18deg); opacity: 0; }
.mcard .abtn:hover::before { animation: mxEnergyFlow .6s var(--ease) both; }
.mcard .abtn:hover { background: linear-gradient(180deg, #f5ca57, #e0a83a); color: #3a2503; transform: scale(1.08); }
.mcard .abtn.del { color: #ff9d9d; } .mcard .abtn.del:hover { background: #c44; color: #fff; }
.mcard .abtn.ren { color: #b7e4ff; } .mcard .abtn.ren:hover { background: linear-gradient(180deg,#8fd4ff,#3f9ed6); color: #06202f; }
/* 改名中的输入框：占满卡片名字那一行，金色描边提示"正在编辑" */
.mcard .mn input { display: block; }
.mcard .mn.editing { padding: 1px 2px; }
/* 素材/收藏卡：本地文件已丢失（被外部删除）→ 红边 + 角标 */
.mcard.gone { outline: 2px dashed #ff6b6b; opacity: .72; }
.mcard.gone .th::after { content: "文件已丢失"; position: absolute; left: 6px; bottom: 6px; font-size: 10.5px;
  color: #ffd9d9; background: rgba(120,20,20,.85); border: 1px solid #ff8a8a; border-radius: 6px; padding: 1px 6px; }

/* ---- 资产右键菜单（挂 body，fixed 定位）---- */
.mx-ctxmenu { position: fixed; z-index: 2147483500; min-width: 232px; padding: 5px;
  background: linear-gradient(180deg, #16213a, #0d1729); border: 1px solid var(--panel-line, #31446a);
  border-radius: 10px; box-shadow: 0 16px 44px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.06);
  display: flex; flex-direction: column; gap: 2px; }
.mx-ctxmenu-sep { height: 1px; margin: 4px 6px; background: rgba(120,170,255,.16); }
.mx-ctxmenu-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 7px 10px; border: 0; border-radius: 7px; background: transparent; color: #dbe6f4;
  font-size: 12.5px; cursor: pointer; transition: background .12s; }
.mx-ctxmenu-item .ic { width: 16px; text-align: center; flex: 0 0 16px; }
.mx-ctxmenu-item .tx { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mx-ctxmenu-item .hint { flex: 0 0 auto; font-size: 10.5px; color: #8ba0bd; }
.mx-ctxmenu-item:hover:not(:disabled) { background: rgba(58,86,138,.4); color: #fff; }
.mx-ctxmenu-item:disabled { opacity: .45; cursor: not-allowed; }
.mx-ctxmenu-item.danger { color: #ffb1b1; }
.mx-ctxmenu-item.danger:hover:not(:disabled) { background: rgba(180,50,50,.45); color: #fff; }
.mcard .ck { position: absolute; bottom: 5px; right: 5px; width: 15px; height: 15px; cursor: pointer; opacity: 0; transition: opacity .18s var(--ease); }
.mcard:hover .ck { opacity: 1; }
.mcard.chk { outline: 2px solid #ff6b6b; }
.mcard.sel { outline: 2px solid var(--accent, #4f9fe8); }

/* 素材库拖拽换位：源卡半透明 + 目标卡金边高亮 + 跟随光标 ghost */
.mcard.as-drag-src { opacity: .35; transform: scale(.96); transition: opacity .15s var(--ease), transform .15s var(--ease); }
.mcard.as-drag-over { outline: 2px solid var(--gold, #f5ca57); box-shadow: 0 0 16px rgba(245,202,87,.45), inset 0 1px 0 var(--panel-hi); }
.as-drag-ghost { position: fixed; pointer-events: none; z-index: 10000; padding: 6px 12px; border-radius: 8px;
  background: linear-gradient(180deg, var(--gold-hi), var(--gold-mid)); color: var(--gold-contrast, #1a1200); font-size: 12px; font-weight: 700;
  box-shadow: 0 8px 24px rgba(0,0,0,.55), 0 0 16px rgba(245,202,87,.45);
  max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---- 收藏悬浮框：position:fixed，固定在素材库右上角，不随滚动移动 ---- */
.as-favfloat { position: fixed !important; width: 320px; z-index: 100;
  background: linear-gradient(160deg, rgba(34,52,88,.92) 0%, rgba(15,26,48,.96) 100%);
  border: 1px solid rgba(245,202,87,.35); border-radius: 13px; padding: 11px 12px;
  box-shadow: 0 12px 36px rgba(0,0,0,.55), 0 0 18px rgba(245,202,87,.18), inset 0 1px 0 var(--panel-hi);
  animation: mxFadeIn .22s var(--ease) both; }
.as-favfloat .row { gap: 6px; flex-wrap: wrap; }
.as-favfloat .row .input, .as-favfloat .row .select, .as-favfloat .row .btn { font-size: 12px; }
.as-favhd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.as-favclose { background: transparent; border: 0; color: #a4b6d0; cursor: pointer; font-size: 18px; line-height: 1;
  width: 22px; height: 22px; border-radius: 6px; transition: all .15s var(--ease); }
.as-favclose:hover { background: rgba(255,255,255,.08); color: #fff; }
.as-favdock { display: none; position: fixed !important; z-index: 100; align-items: center; gap: 6px;
  padding: 6px 12px 6px 8px; background: linear-gradient(180deg, var(--gold-hi), var(--gold-mid)); color: var(--gold-contrast, #1a1200);
  border-radius: 999px; box-shadow: 0 6px 18px rgba(222,170,60,.45); cursor: pointer;
  font-size: 12px; font-weight: 700; transition: transform .16s var(--ease); }
.as-favdock:hover { transform: scale(1.04); }
.as-favdock-btn { background: transparent; border: 0; color: inherit; font-size: 14px; line-height: 1; padding: 0; cursor: pointer; }
.as-favdock-lbl { font-size: 12px; }

.mlight { position: fixed; inset: 0; z-index: 9999; background: rgba(3,5,10,.86); display: flex;
  align-items: center; justify-content: center; padding: 30px; animation: mxFadeIn .2s var(--ease) both; }
.mlight img, .mlight video { max-width: 90%; max-height: 90%; border-radius: 10px; box-shadow: 0 10px 50px rgba(0,0,0,.6); }
.mlight .mx { position: fixed; top: 14px; right: 18px; color: #fff; cursor: pointer; font-size: 22px; background: rgba(255,255,255,.08);
  width: 36px; height: 36px; border-radius: 50%; border: 0; transition: all .15s var(--ease); }
.mlight .mx:hover { background: rgba(255,255,255,.2); transform: rotate(90deg); }

/* 分镜卡与素材明细 */
.scard { background: linear-gradient(160deg, rgba(34,52,88,.72) 0%, rgba(15,26,48,.86) 100%);
  border: 1px solid var(--panel-line); border-radius: 13px; overflow: hidden;
  box-shadow: 0 6px 22px rgba(0,0,0,.3), inset 0 1px 0 var(--panel-hi); transition: border-color .18s var(--ease); }
.scard:hover { border-color: rgba(120,170,255,.3); }
.scard > .hd { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: linear-gradient(180deg, rgba(28,48,82,.9), rgba(14,26,48,.9));
  border-bottom: 1px solid var(--panel-line); }
.scard > .hd .no { background: var(--accent-soft, #1a3a66); color: #fff; border-radius: 7px; font-weight: 700;
  padding: 1px 8px; font-size: 12px; box-shadow: inset 0 1px 0 var(--panel-hi); }
.scard > .bd { padding: 8px 10px; }
.scard > .ft { padding: 5px 10px 7px; border-top: 1px dashed rgba(120,170,255,.15); display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }

/* 素材提及编辑器（token） */
.mention-ed { min-height: 84px; resize: vertical; line-height: 1.6; padding: 8px 10px;
  border-radius: 9px; border: 1px solid rgba(120,170,255,.2); background: rgba(10,18,36,.8); color: #e9effa; font-size: 12.5px; overflow-wrap: anywhere;
  /* pre-wrap 关键：render() 用 innerHTML 重写后 \n 必须按换行渲染，
     否则 innerText 读回时换行折叠成一行 → 后端行首分镜标记 ^【分镜N】全部失配 → 0 分镜 */
  white-space: pre-wrap;
  box-shadow: inset 0 1px 4px rgba(0,0,0,.35); transition: border-color .18s var(--ease); }
.mention-ed:focus { outline: none; border-color: var(--accent, #5a9fe8); }
.mtok { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; margin: 1px 2px;
  border-radius: 999px; font-size: 12px; cursor: pointer; vertical-align: 1px; user-select: none;
  color: #33200a; font-weight: 700; border: 1px solid #ffe29a; white-space: nowrap;
  background: linear-gradient(180deg,#ffe9a8 0%,#f5ca57 55%,#e0a83a 100%);
  box-shadow: 0 0 14px rgba(235,180,60,.45), inset 0 1px 0 rgba(255,255,255,.7), inset 0 -2px 3px rgba(150,80,0,.3);
  transition: filter .15s var(--ease), transform .15s var(--ease); }
.mtok-video { color: #042933; border-color: #a8f0ff;
  background: linear-gradient(180deg,#aef2ff 0%,#4fd0f0 55%,#1fb2dd 100%);
  box-shadow: 0 0 14px rgba(52,200,230,.5), inset 0 1px 0 rgba(255,255,255,.7), inset 0 -2px 3px rgba(0,90,120,.3); }
.mtok-audio { color: #3d0c26; border-color: #ffb3e4;
  background: linear-gradient(180deg,#ffb9e8 0%,#f778c4 55%,#e3439c 100%);
  box-shadow: 0 0 14px rgba(232,88,168,.5), inset 0 1px 0 rgba(255,255,255,.7), inset 0 -2px 3px rgba(130,20,80,.3); }
.mtok:hover { filter: brightness(1.08) saturate(1.1); transform: translateY(-1px); }
.mtok.is-missing { opacity: .6; border-style: dashed; box-shadow: none; }
.mtdot { width: 15px; height: 15px; object-fit: cover; border-radius: 4px; background: rgba(0,0,0,.25); }
.mtglyph { width: 15px; height: 15px; line-height: 15px; text-align: center; border-radius: 4px;
  background: rgba(0,0,0,.25); font-size: 11px; font-weight: 800; display: inline-block; }
.mtxt { pointer-events: none; }

/* ---- 导演台：素材九宫格 + 提示词左右分栏 ---- */
/* 预览框尺寸（定死）：宽高恒定，任何状态都不变，避免出片/切模式时整行重排崩版 */
.mm-split { display: flex; gap: 10px; align-items: stretch; min-height: 214px; }
.mm-media { flex: 0 0 auto; width: 238px; min-width: 0; display: flex; flex-direction: column; gap: 3px;
  overflow-y: auto; overflow-x: hidden; max-height: 210px; }
.mm-prompt { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.mm-prompt .mention-ed { flex: 1 1 auto; min-height: 84px; max-height: 210px; resize: none; }
/* 实时预览：定死正方形框，钉在提示词文本区右侧 */
.mm-preview { flex: 0 0 210px; width: 210px; min-width: 210px; max-width: 210px;
  height: 210px; min-height: 210px; max-height: 210px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 4px; overflow: hidden;
  padding: 6px; border: 1px solid rgba(120,170,255,.18); border-radius: 10px; background: rgba(8,14,28,.55); }
.mm-preview .mm-pv-title { font-size: 11px; font-weight: 700; color: #7ee2a0; flex: 0 0 auto; line-height: 1.3; }
.mm-pv-body { position: relative; flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.mm-pv-foot { flex: 0 0 auto; display: flex; justify-content: center; }
.mm-pv-empty { font-size: 11px; color: #6d7f96; text-align: center; }
.mm-pv-img { width: 100%; height: 100%; object-fit: contain; border-radius: 8px; background: #000;
  border: 1px solid rgba(120,170,255,.2); box-sizing: border-box; }
.mm-preview video, .mm-preview img { width: 100%; flex: 1 1 auto; min-height: 0; aspect-ratio: 1/1; object-fit: contain; border-radius: 8px; background: #000; border: 1px solid rgba(120,170,255,.2); box-sizing: border-box; }
.mm-preview .mm-pv-img { flex: none; aspect-ratio: auto; }
.mm-pv-vwrap { position: relative; width: 100%; height: 100%; flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; }
.mm-pv-vwrap video { width: 100%; height: 100%; flex: none; aspect-ratio: auto; }
.mm-playbtn { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255,255,255,.4); background: rgba(0,0,0,.55); color: #fff; font-size: 13px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
  transition: background .18s var(--ease), border-color .18s var(--ease), transform .18s var(--ease); }
.mm-playbtn:hover { background: linear-gradient(180deg, #f5ca57, #e0a83a); border-color: #ffe9a8; color: #3a2503; transform: translate(-50%, -50%) scale(1.08); }
/* 宫格尺寸基准：--mm-cell 由容器宽度推导（节点缩放时等比），默认 1.7× 于旧的 44px */
.mm-grid { display: grid; grid-template-columns: repeat(3, var(--mm-cell, 75px));
  grid-auto-rows: var(--mm-cell, 75px); gap: var(--mm-gap, 7px); width: max-content; }
.mm-cell { position: relative; width: var(--mm-cell, 75px); height: var(--mm-cell, 75px); border: 1px dashed rgba(120,170,255,.3); border-radius: 8px;
  background: rgba(10,18,36,.7); overflow: hidden; cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: border-color .15s var(--ease), transform .15s var(--ease); }
.mm-cell:hover { border-color: var(--accent, #4f9fe8); transform: translateY(-1px); }
.mm-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* 视频/音频小格：缩略图容器铺满格子（videoThumb/audioThumb 产出 .th 结构）*/
.mm-cell .th { position: absolute; inset: 0; }
.mm-cell .th img, .mm-cell .th video { width: 100%; height: 100%; object-fit: cover; display: block; background: #05070c; }
.mm-cell .mm-plus { color: #4a5b76; font-size: clamp(14px, 1.5cqw, 22px); line-height: 1; user-select: none; }
/* 空格：全部可点。紧邻的下一格是「直接加」（亮），后面的格子淡一点但同样能点 ——
   悬停时点亮，免得看起来像死格（用户实报：有些格子没用）*/
.mm-cell.mm-empty .mm-plus.dim { opacity: .38; }
.mm-cell.mm-empty:hover .mm-plus.dim { opacity: .95; color: #9fb0c6; }
.mm-cell.mm-empty:hover { border-color: rgba(120,170,255,.55); background: rgba(16,28,52,.85); }
.mm-cell .mm-x { position: absolute; top: 0; right: 0; z-index: 4; width: clamp(14px, 1.5cqw, 22px); height: clamp(14px, 1.5cqw, 22px); border-radius: 0 0 0 6px;
  background: rgba(0, 0, 0, 0.72); color: #ff7b7b; font-size: 9px; line-height: 14px; text-align: center; cursor: pointer; }
.mm-cell .mm-x:hover { background: #7a1f1f; color: #fff; }
.mm-cell .mm-idx { position: absolute; left: 2px; bottom: 1px; font-size: clamp(8px, .85cqw, 11px); color: #ffd166; background: rgba(0,0,0,0.5);
  border-radius: 2px; padding: 0 2px; }
.mm-cap { font-size: 11px; color: #7ee2a0; }
.mm-sub { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.mm-sub .tag { max-width: 76px; font-size: 10px; padding: 0 5px; }
.mm-sub img { display: none; }
.mm-vasub { display: flex; gap: 6px; align-items: flex-start; flex-direction: column; }

/* ---- 导演台：顶部参数切换 ---- */
.tl-tabs { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.tl-tab { padding: 5px 12px; border-radius: 999px; font-size: 12px; border: 1px solid rgba(120,170,255,.18);
  background: rgba(20,32,56,.6); color: #9db0ca; cursor: pointer; line-height: 1.2;
  transition: all .18s var(--ease); position: relative; overflow: hidden; }
.tl-tab::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(120deg, transparent 30%, rgba(245,202,87,.22) 50%, transparent 70%);
  transform: translateX(-130%) skewX(-18deg); opacity: 0; }
.tl-tab:hover::before { animation: mxEnergyFlow .9s var(--ease) both; }
.tl-tab:hover { color: #eaf0fa; border-color: rgba(216,174,66,.4); transform: translateY(-1px); }
.tl-tab.on { background: var(--accent-soft, #1a3a66); border-color: var(--accent, #4f9fe8); color: #eaf6ff;
  box-shadow: 0 0 12px var(--accent-soft, rgba(79,158,232,.3)), inset 0 1px 0 var(--panel-hi); }
.tl-parambox { display: flex; flex-direction: column; gap: 4px; }
.tl-paramrow { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 7px;
  align-items: start; padding: 8px 10px; background: rgba(13,23,44,.8); border: 1px solid var(--panel-line); border-radius: 9px;
  box-shadow: inset 0 1px 0 var(--panel-hi); font-size: 12px; animation: mxFadeIn .24s var(--ease) both; }
.tl-paramrow .select, .tl-paramrow .input { padding: 4px 7px; font-size: 11.5px; width: 100%; }
.tl-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.tl-flabel { font-size: 10.5px; color: #7d9dba; font-weight: 600; letter-spacing: .2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---- 导演台可视轨道 ---- */
.tl-scroll { flex: 0 0 auto; min-height: 0; overflow-x: auto; overflow-y: hidden; border: 1px solid var(--panel-line);
  border-radius: 11px; background: linear-gradient(180deg, rgba(10,18,36,.92), rgba(7,13,27,.92)); padding: 3px 5px 4px;
  display: flex; flex-direction: column; box-shadow: inset 0 2px 8px rgba(0,0,0,.4); }
.tl-ruler { flex: 0 0 auto; display: flex; align-items: flex-end; min-height: 13px; padding: 0 3px; color: #5f7392; font-size: 9px; }
.tl-tick { flex: 0 0 auto; height: 10px; line-height: 10px; padding-left: 2px; border-left: 1px solid rgba(120,170,255,.18); white-space: nowrap; }
.tl-track { flex: 0 0 auto; display: flex; align-items: center; min-height: 0; padding: 1px 3px; }
.tl-block { flex: 0 0 auto; background: linear-gradient(180deg, #1e4070, #12263f); border: 1px solid #2f6ca0;
  border-radius: 7px; padding: 2px 6px 2px 26px; cursor: pointer; color: #cfe4f7; display: flex; flex-direction: column;
  justify-content: center; gap: 0; min-width: 110px; box-shadow: inset 0 1px 0 var(--panel-hi), 0 2px 8px rgba(0,0,0,.3);
  line-height: 1.25; position: relative; transition: all .18s var(--ease); }
.tl-play { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; padding: 0;
  background: linear-gradient(180deg, var(--gold-hi), var(--gold-mid)); color: var(--gold-contrast, #1a1200); border: 0; border-radius: 4px;
  font-size: 10px; line-height: 18px; cursor: pointer; opacity: 1; transform: scale(1); transition: all .18s var(--ease); }
.tl-block:hover .tl-play { filter: brightness(1.15); transform: scale(1.08); }
.tl-block:hover { filter: brightness(1.14); border-color: #4f9fe8; transform: translateY(-1px); }
.tl-block.act { outline: 2px solid #f5ca57; box-shadow: inset 0 1px 0 var(--panel-hi), 0 0 16px var(--gold-glow); }
.tl-block.ctx { border-left: 3px solid #7fdcff; background: linear-gradient(180deg, #1a4a68, #12263f); }
.tl-idx { font-size: 10px; font-weight: 700; color: #ffd166; }
.tl-txt { font-size: 10px; color: #b9cce0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1;
  -webkit-box-orient: vertical; }
.tl-meta { font-size: 9px; color: #7d9dba; }
.tl-gap { flex: 0 0 6px; }
.tl-link { flex: 0 0 auto; width: 16px; height: 16px; border-radius: 5px; cursor: pointer; align-self: center;
  border: 1px solid rgba(120,170,255,.2); background: rgba(16,26,42,.8); color: #5d6f8a; font-size: 10px; line-height: 1;
  display: flex; align-items: center; justify-content: center; margin: 0 2px; user-select: none; transition: all .18s var(--ease); }
.tl-link:hover { border-color: rgba(216,174,66,.5); color: #e9d08a; }
.tl-link.on { border-color: #f5ca57; background: linear-gradient(180deg, #3a2d10, #241b0a); color: #ffe9a8; box-shadow: 0 0 8px var(--gold-glow); }
.tl-link .lk { pointer-events: none; }
.tl-secdim { font-size: 9px; color: #7d9dba; }
.tl-add { align-self: center; margin-left: 4px; flex: 0 0 auto; padding: 3px 8px; font-size: 11px; }
.tl-logbar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 2px 4px;
  background: rgba(10,14,24,.9); border: 1px solid var(--panel-line); border-radius: 8px; color: #9fb0c6; font-size: 11px; }
.tl-logbar .mono { font-family: monospace; font-size: 10.5px; color: #c8d3de; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.tl-logbar .toggle { cursor: pointer; color: #8fd0ff; flex: 0 0 auto; }
.tl-log-open { max-height: 110px; overflow: auto; }

/* ---- 剪辑（剪映式）---- */
.ed-layout { display: flex; flex-direction: column; gap: 10px; max-width: 980px; }
.ed-preview { position: relative; width: 100%; aspect-ratio: 16/9; background: #000;
  border: 1px solid var(--panel-line); border-radius: 13px; overflow: hidden; box-shadow: inset 0 0 40px rgba(0,0,0,.5); }
.ed-preview video { width: 100%; height: 100%; object-fit: contain; }
.ed-preview .ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #44536c; font-size: 13px; }
.ed-matbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ed-mats { display: flex; gap: 8px; overflow-x: auto; padding: 4px 0; }
.ed-mat { flex: 0 0 96px; position: relative; background: linear-gradient(180deg, #16253f, #0e1830);
  border: 1px solid var(--panel-line); border-radius: 9px; overflow: hidden; cursor: pointer; text-align: center;
  box-shadow: inset 0 1px 0 var(--panel-hi); transition: all .18s var(--ease); }
.ed-mat:hover { border-color: rgba(216,174,66,.5); transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,.4); }
.ed-mat img { width: 100%; height: 54px; object-fit: cover; display: block; background: #000; }
.ed-mat .mi { font-size: 10.5px; color: #9db0ca; padding: 3px 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ed-mat.sel { outline: 2px solid var(--accent, #5eead4); }
.ed-mat.chk { outline: 2px solid #ff6b6b; }
.ed-trackwrap { display: flex; flex-direction: column; gap: 4px; }
.ed-track { display: flex; min-height: 40px; background: rgba(12,20,36,.85); border: 1px solid var(--panel-line); border-radius: 10px; padding: 5px; gap: 6px; overflow-x: auto;
  box-shadow: inset 0 1px 4px rgba(0,0,0,.3); }
.ed-track-lbl { flex: 0 0 46px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: var(--accent, #5eead4); border-right: 1px solid var(--panel-line); }
.ed-clip { flex: 0 0 auto; min-width: 74px; padding: 4px 8px; background: linear-gradient(180deg, #1c3a5e, #13263f);
  border: 1px solid #2a5d88; border-radius: 7px; cursor: grab; color: #cfe4f7; font-size: 11px;
  display: flex; flex-direction: column; gap: 2px; box-shadow: inset 0 1px 0 var(--panel-hi); transition: all .18s var(--ease);
  overflow: hidden; }   /* 自适应缩放后片段可能很窄：裁掉溢出的文字，别糊到相邻片段上 */
.ed-clip .cd { font-size: 9.5px; color: #7f9cba; }
.ed-clip:hover { filter: brightness(1.18); transform: translateY(-1px); }
.ed-clip:active { cursor: grabbing; }
.ed-clip.sel { outline: 2px solid #5eead4; }
.ed-clip.drag { opacity: .5; }
.ed-editbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-top: 1px solid rgba(120,170,255,.12); padding-top: 8px; }

/* ---- 丝滑剪辑：拖拽期间只改宽度（0 次全量重绘），关掉过渡动画保证跟手 ---- */
.ed-clip { will-change: width; }
.ed-clip.trimming { transition: none !important; filter: brightness(1.25); z-index: 6;
  box-shadow: 0 0 0 1px var(--gold, #ffcf6b), 0 6px 20px rgba(0,0,0,.55); }
.ed-track.dragging .ed-clip { transition: none !important; }
.ed-track.dragging { cursor: ew-resize; }
.ed-handle { transition: background .12s ease; }
.ed-handle:hover, .ed-handle.hot { background: var(--gold, #ffcf6b) !important; }
.ed-trimtip { position: fixed; z-index: 2147483200; pointer-events: none; padding: 3px 9px; border-radius: 7px;
  background: rgba(8,14,26,.95); border: 1px solid var(--gold, #ffcf6b); color: var(--gold, #ffcf6b);
  font-size: 11px; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums;
  box-shadow: 0 8px 22px rgba(0,0,0,.6); opacity: 0; transition: opacity .1s ease; transform: translate(-50%, -145%); }
.ed-trimtip.on { opacity: 1; }
/* 素材很多时：屏幕外的卡片不参与布局，避免一次性生成上百个缩略图 */
.ed-mat { content-visibility: auto; contain-intrinsic-size: 96px 92px; }
.ed-scrubhint { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,207,107,.5); pointer-events: none; }
.ed-ruler { touch-action: none; }

/* ---- 首帧/尾帧素材槽（i2v / fl2v / fl2v_tail：素材区只有两个框，对齐旧包 .bd-fl2v-slots）---- */
.mm-frames { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.mm-frames.one { grid-template-columns: 1fr; }
.mm-frame { position: relative; min-width: 0; border: 1px dashed #55617a; border-radius: 8px;
  background: #0d1524; overflow: hidden; cursor: pointer; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 3px; transition: border-color .14s, background .14s; }
.mm-frame:hover { border-color: var(--gold, #ffcf6b); background: #131f33; }
.mm-frame.has-img { border-style: solid; border-color: #3a568a; }
.mm-frame img { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
.mm-frame .ph { color: #7d92b4; font-size: 12px; font-weight: 500; pointer-events: none; }
.mm-frame .ph2 { color: #5d6f8c; font-size: 10.5px; text-align: center; padding: 0 6px; line-height: 1.4; pointer-events: none; }
.mm-frame .tag { position: absolute; top: 4px; left: 4px; z-index: 2; padding: 1px 6px; border-radius: 4px;
  font-size: 10px; font-weight: 700; color: #06202f; pointer-events: none; }
.mm-frame .x { position: absolute; top: 3px; right: 3px; z-index: 3; width: 20px; height: 20px;
  border: 0; border-radius: 5px; background: rgba(0,0,0,.8); color: #ff9d9d; font-size: 15px;
  line-height: 1; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.mm-frame .x:hover { background: #c44; color: #fff; }

/* ---- 生图面板：右侧实时预览（大正方形，宽度自适应填满卡片）---- */
.gen-preview { position: relative; width: 100%; aspect-ratio: 1/1; min-width: 0; border-radius: 12px;
  background: #000; border: 1px solid #23314a; overflow: hidden; display: flex;
  align-items: center; justify-content: center;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.07), 0 6px 22px rgba(0,0,0,.35); }
.gen-preview img { width: 100%; height: 100%; object-fit: contain; display: block; }

/* ================= 蓝色流光 · 能量流动主题（.mrnext-theme-flow 挂 root） ================= */
/* 配色：电光青 #7df9ff → 亮蓝 #00c8ff → 深海蓝 #0a1a33；底色近黑深蓝，能量线流过全 UI */
.mrnext-theme-flow {
  --gold-hi: #9beaff; --gold: #00c8ff; --gold-mid: #0088dd; --gold-deep: #005599;
  --gold-glow: rgba(0,200,255,.45);
  --gold-contrast: #02121f;
  --blue-hi: #10233f; --blue: #0a1830; --blue-deep: #050b18;
  --panel-line: rgba(0,200,255,.22);
  --panel-hi: rgba(120,220,255,.08);
  background:
    radial-gradient(1200px 600px at 50% -10%, rgba(0,120,255,.10), transparent 60%),
    linear-gradient(180deg, var(--blue-deep), #03060d);
}
/* 全局能量网格底纹（极淡，不抢内容） */
.mrnext-root.mrnext-theme-flow::before {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background:
    repeating-linear-gradient(0deg, rgba(0,200,255,.035) 0 1px, transparent 1px 44px),
    repeating-linear-gradient(90deg, rgba(0,200,255,.035) 0 1px, transparent 1px 44px);
  mask-image: linear-gradient(180deg, rgba(0,0,0,.9), rgba(0,0,0,.25) 40%, rgba(0,0,0,.7));
}
.mrnext-theme-flow .mx-content, .mrnext-theme-flow .mx-nav, .mrnext-theme-flow .mx-header { position: relative; z-index: 1; }

/* 标题：电光蓝渐变字 + 呼吸光晕 */
.mrnext-theme-flow .mx-title {
  background: linear-gradient(180deg, #c8f7ff 0%, #00c8ff 55%, #0077dd 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 0 6px rgba(0,200,255,.55)) drop-shadow(0 0 18px rgba(0,140,255,.3));
  animation: mrnext-titleBreath 3.2s var(--ease) infinite;
}
@keyframes mrnext-titleBreath {
  0%, 100% { filter: drop-shadow(0 0 5px rgba(0,200,255,.45)) drop-shadow(0 0 14px rgba(0,140,255,.22)); }
  50%      { filter: drop-shadow(0 0 9px rgba(0,220,255,.75)) drop-shadow(0 0 26px rgba(0,160,255,.4)); }
}

/* 面板头：下缘能量线流动 */
.mrnext-theme-flow .mx-panel-head { position: relative; }
.mrnext-theme-flow .mx-panel-head::after {
  content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px;
  background: linear-gradient(90deg, transparent, #00c8ff 22%, #9beaff 50%, #00c8ff 78%, transparent);
  background-size: 220% 100%;
  animation: mrnext-energyLine 2.6s linear infinite;
  opacity: .85; pointer-events: none;
}
@keyframes mrnext-energyLine {
  0% { background-position: 130% 0; } 100% { background-position: -130% 0; }
}

/* 导航激活项：左侧能量条 + 蓝光晕 */
.mrnext-theme-flow .mx-nav-item.active {
  border-color: rgba(0,200,255,.55);
  box-shadow: inset 0 1px 0 var(--panel-hi), inset 2px 0 0 #00c8ff,
    0 0 14px rgba(0,200,255,.3), inset 0 0 18px rgba(0,160,255,.08);
}

/* 按钮：蓝色描边光晕；主按钮 = 能量核心（脉冲呼吸 + 扫描光） */
.mrnext-theme-flow .btn {
  border-color: rgba(0,160,255,.4);
  box-shadow: 0 0 0 1px rgba(0,200,255,.08), 0 2px 10px rgba(0,80,180,.25);
}
.mrnext-theme-flow .btn:hover { border-color: rgba(0,210,255,.75); box-shadow: 0 0 12px rgba(0,200,255,.4); }
.mrnext-theme-flow .btn-primary {
  border-color: rgba(0,220,255,.7);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.35), inset 0 -2px 5px rgba(0,60,140,.4),
    0 0 14px var(--gold-glow), 0 0 3px rgba(0,220,255,.6);
  animation: mrnext-corePulse 2.2s ease-in-out infinite;
}
@keyframes mrnext-corePulse {
  0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,.35), inset 0 -2px 5px rgba(0,60,140,.4),
    0 0 10px rgba(0,200,255,.4), 0 0 2px rgba(0,220,255,.5); }
  50%      { box-shadow: inset 0 1px 0 rgba(255,255,255,.4), inset 0 -2px 5px rgba(0,60,140,.4),
    0 0 20px rgba(0,220,255,.7), 0 0 6px rgba(120,240,255,.8); }
}
.mrnext-theme-flow .btn-primary::before {
  background: linear-gradient(120deg, transparent 30%, rgba(160,240,255,.5) 48%, rgba(255,255,255,.9) 50%, rgba(160,240,255,.5) 52%, transparent 70%);
  animation: mrnext-scan 2.8s linear infinite;
}
@keyframes mrnext-scan { 0% { transform: translateX(-120%); } 100% { transform: translateX(120%); } }

/* 输入/下拉 focus：蓝光聚焦 */
.mrnext-theme-flow .input:focus, .mrnext-theme-flow .textarea:focus, .mrnext-theme-flow .select:focus {
  border-color: #00c8ff; box-shadow: 0 0 0 1px rgba(0,200,255,.5), 0 0 12px rgba(0,200,255,.35);
}

/* 滚动条蓝色能量 */
.mrnext-theme-flow ::-webkit-scrollbar-thumb { background: linear-gradient(180deg, #0a5f9e, #063a68); border-color: rgba(0,200,255,.2); }
.mrnext-theme-flow ::-webkit-scrollbar-thumb:hover { background: linear-gradient(180deg, #0d7ac9, #084a85); }

/* tab 激活：底部能量条 */
.mrnext-theme-flow .tl-tab.on, .mrnext-theme-flow .ptab.on { box-shadow: 0 -2px 0 0 #00c8ff inset, 0 0 10px rgba(0,200,255,.25); }

/* ================= 🔥 火焰流动主题（.mrnext-theme-fire 挂 root） ================= */
/* 配色：余烬金 #ffd7a1 → 熔岩橙 #ff7a18 → 烈焰红 #ff3d00；底色近黑炭，火舌自下而上流动 */
.mrnext-theme-fire {
  --gold-hi: #ffd7a1; --gold: #ff7a18; --gold-mid: #ff3d00; --gold-deep: #a32000;
  --gold-glow: rgba(255,122,24,.48);
  --gold-contrast: #1a0600;
  --blue-hi: #2a1410; --blue: #180a06; --blue-deep: #080302;
  --panel-line: rgba(255,122,24,.24);
  --panel-hi: rgba(255,180,120,.08);
  background:
    radial-gradient(1200px 620px at 50% -12%, rgba(255,90,0,.13), transparent 62%),
    linear-gradient(180deg, var(--blue-deep), #040101);
}
/* 底部火舌（模糊 + 缓慢上下起伏，营造流动感） */
.mrnext-root.mrnext-theme-fire::before {
  content: ""; position: absolute; inset: -18% -12% -4% -12%; pointer-events: none; z-index: 0;
  background:
    radial-gradient(58% 38% at 18% 104%, rgba(255,110,0,.34), transparent 70%),
    radial-gradient(52% 34% at 52% 108%, rgba(255,58,0,.30), transparent 72%),
    radial-gradient(46% 30% at 86% 105%, rgba(255,176,52,.24), transparent 70%);
  filter: blur(16px) saturate(1.25);
  animation: mrnext-fireRise 6.5s ease-in-out infinite alternate;
}
@keyframes mrnext-fireRise {
  0%   { transform: translateY(7%) scaleY(1);     opacity: .72; }
  50%  { transform: translateY(-2%) scaleY(1.09);  opacity: .95; }
  100% { transform: translateY(-8%) scaleY(1.16);  opacity: .80; }
}
/* 飞升火星（多点小亮点自下而上飘散） */
.mrnext-root.mrnext-theme-fire::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background-image:
    radial-gradient(2px 2px at 14% 96%, rgba(255,214,150,.95), transparent 62%),
    radial-gradient(1.6px 1.6px at 29% 88%, rgba(255,150,60,.9), transparent 62%),
    radial-gradient(2.2px 2.2px at 44% 94%, rgba(255,196,110,.85), transparent 62%),
    radial-gradient(1.4px 1.4px at 61% 90%, rgba(255,120,40,.9), transparent 62%),
    radial-gradient(2px 2px at 76% 97%, rgba(255,224,170,.9), transparent 62%),
    radial-gradient(1.5px 1.5px at 91% 89%, rgba(255,140,50,.85), transparent 62%);
  animation: mrnext-embers 9s linear infinite;
  opacity: .85;
}
@keyframes mrnext-embers {
  0%   { transform: translateY(0) scale(1);    opacity: 0; }
  12%  { opacity: .95; }
  100% { transform: translateY(-72%) scale(.75); opacity: 0; }
}
.mrnext-theme-fire .mx-content, .mrnext-theme-fire .mx-nav, .mrnext-theme-fire .mx-header { position: relative; z-index: 1; }

/* 标题：熔金渐变字 + 热浪呼吸 */
.mrnext-theme-fire .mx-title {
  background: linear-gradient(180deg, #fff0d2 0%, #ffb347 38%, #ff5a00 78%, #c81e00 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 0 6px rgba(255,120,20,.55)) drop-shadow(0 0 20px rgba(255,60,0,.32));
  animation: mrnext-fireTitle 3.4s var(--ease) infinite;
}
@keyframes mrnext-fireTitle {
  0%, 100% { filter: drop-shadow(0 0 5px rgba(255,130,30,.45)) drop-shadow(0 0 15px rgba(255,70,0,.24)); }
  50%      { filter: drop-shadow(0 0 10px rgba(255,180,60,.8)) drop-shadow(0 0 28px rgba(255,90,0,.45)); }
}

/* 面板头：下缘火线流动 */
.mrnext-theme-fire .mx-panel-head { position: relative; }
.mrnext-theme-fire .mx-panel-head::after {
  content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px;
  background: linear-gradient(90deg, transparent, #ff3d00 20%, #ffb347 50%, #fff0c0 62%, #ff3d00 82%, transparent);
  background-size: 220% 100%;
  animation: mrnext-fireLine 2.2s linear infinite;
  opacity: .9; pointer-events: none;
}
@keyframes mrnext-fireLine {
  0% { background-position: 135% 0; } 100% { background-position: -135% 0; }
}

/* 导航激活项：左侧火条 + 余烬光晕 */
.mrnext-theme-fire .mx-nav-item.active {
  border-color: rgba(255,122,24,.6);
  box-shadow: inset 0 1px 0 var(--panel-hi), inset 2px 0 0 #ff6a00,
    0 0 16px rgba(255,110,20,.34), inset 0 0 20px rgba(255,80,0,.10);
}

/* 按钮：余烬描边；主按钮 = 熔核（呼吸脉冲 + 扫光） */
.mrnext-theme-fire .btn {
  border-color: rgba(255,122,24,.42);
  box-shadow: 0 0 0 1px rgba(255,140,40,.08), 0 2px 10px rgba(150,40,0,.3);
}
.mrnext-theme-fire .btn:hover { border-color: rgba(255,170,70,.8); box-shadow: 0 0 14px rgba(255,130,30,.45); }
.mrnext-theme-fire .btn-primary {
  border-color: rgba(255,180,80,.72);
  color: #2a0d00;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.4), inset 0 -2px 6px rgba(140,30,0,.45),
    0 0 16px var(--gold-glow), 0 0 4px rgba(255,190,90,.6);
  animation: mrnext-emberPulse 2s ease-in-out infinite;
}
@keyframes mrnext-emberPulse {
  0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,.4), inset 0 -2px 6px rgba(140,30,0,.45),
    0 0 12px rgba(255,122,24,.42), 0 0 3px rgba(255,200,120,.55); }
  50%      { box-shadow: inset 0 1px 0 rgba(255,255,255,.45), inset 0 -2px 6px rgba(140,30,0,.45),
    0 0 24px rgba(255,150,40,.72), 0 0 8px rgba(255,225,160,.85); }
}
.mrnext-theme-fire .btn-primary::before {
  background: linear-gradient(120deg, transparent 30%, rgba(255,220,160,.55) 48%, rgba(255,255,240,.95) 50%, rgba(255,220,160,.55) 52%, transparent 70%);
  animation: mrnext-scan 2.4s linear infinite;
}

/* 输入/下拉 focus：火光聚焦 */
.mrnext-theme-fire .input:focus, .mrnext-theme-fire .textarea:focus, .mrnext-theme-fire .select:focus {
  border-color: #ff8a2b; box-shadow: 0 0 0 1px rgba(255,140,40,.5), 0 0 14px rgba(255,120,20,.38);
}

/* 滚动条余烬 */
.mrnext-theme-fire ::-webkit-scrollbar-thumb { background: linear-gradient(180deg, #a33a06, #6a1c00); border-color: rgba(255,140,40,.22); }
.mrnext-theme-fire ::-webkit-scrollbar-thumb:hover { background: linear-gradient(180deg, #d4550a, #8a2600); }

/* tab 激活：底部火条 */
.mrnext-theme-fire .tl-tab.on, .mrnext-theme-fire .ptab.on { box-shadow: 0 -2px 0 0 #ff6a00 inset, 0 0 12px rgba(255,120,20,.3); }

/* ================= 全局自适应：UI 随节点尺寸等比缩放 =================
   以 .mrnext-root 为尺寸容器，所有面板/按钮/输入框/导航/预览框的尺寸都用 cqw（容器宽度百分比）
   + clamp() 取值 —— 节点放大时整体变大，缩小时整体变小，绝不出现"内容挤爆/留白过大"。
   本节点尺寸由 main.js 锁死（1100×860），所以这是"设计分辨率 + 等比适配"，不是自由缩放。 */
.mrnext-root { container-type: size; container-name: mrpanel;
  /* 素材宫格单格尺寸（旧 44px 的 1.7 倍）：随面板宽度等比，节点缩放同步 */
  /* 实测容器宽 ≈971px（节点 1100 减去 ComfyUI 内边距）→ 7.72cqw ≈ 75px = 旧 44px 的 1.7 倍 */
  --mm-cell: clamp(56px, 7.72cqw, 86px); --mm-gap: clamp(5px, .7cqw, 10px); }
.mx-header { padding: clamp(7px, 0.95cqw, 13px) clamp(9px, 1.25cqw, 17px); }
.mx-title { font-size: clamp(12.5px, 1.42cqw, 16.5px); letter-spacing: clamp(.2px, .04cqw, .6px); }
.mx-sub { font-size: clamp(9.5px, 0.92cqw, 11.5px); }
.mx-nav { flex: 0 0 clamp(116px, 14cqw, 190px); gap: clamp(3px, .45cqw, 6px); }
.mx-nav-item { font-size: clamp(10.5px, 1.02cqw, 13px); padding: clamp(6px, .82cqw, 11px) clamp(7px, .95cqw, 12px);
  border-radius: clamp(7px, .78cqw, 10px); gap: clamp(5px, .6cqw, 8px); }
.mx-nav-item .nicon { font-size: clamp(12px, 1.22cqw, 15px); }
.mx-content { padding: clamp(8px, 1.25cqw, 16px) clamp(9px, 1.4cqw, 18px); }
.mx-panel-head { padding: clamp(6px, .78cqw, 10px) clamp(9px, 1.15cqw, 15px); margin-bottom: clamp(7px, .95cqw, 12px);
  border-radius: clamp(9px, 1cqw, 13px); gap: clamp(7px, .82cqw, 11px); }
.mx-panel-head .ptitle { font-size: clamp(12px, 1.28cqw, 15px); }
.mx-panel-head .psub { font-size: clamp(9.5px, .98cqw, 12px); }
.mx-panel-head .picon { font-size: clamp(14px, 1.55cqw, 18px); }
/* 通用控件 */
.btn { padding: clamp(4px, .5cqw, 7px) clamp(8px, .95cqw, 12px); font-size: clamp(10.5px, 1.02cqw, 12.5px);
  border-radius: clamp(7px, .8cqw, 10px); }
.input, .textarea, .select { font-size: clamp(11px, 1.06cqw, 13px); padding: clamp(6px, .72cqw, 9px) clamp(8px, .95cqw, 12px);
  border-radius: clamp(7px, .8cqw, 10px); }
.textarea { min-height: clamp(92px, 15cqh, 150px); }
.card { padding: clamp(7px, .95cqw, 12px); border-radius: clamp(8px, .95cqw, 13px); gap: clamp(5px, .65cqw, 9px); }
.section { margin-bottom: clamp(8px, 1.05cqw, 15px); }
.section > h3 { font-size: clamp(11px, 1.06cqw, 13px); margin-bottom: clamp(5px, .65cqw, 9px); }
.col { gap: clamp(5px, .72cqw, 10px); }
.row { gap: clamp(5px, .65cqw, 9px); }
/* 时间线：预览框随节点宽度缩放（保持正方形），三栏永不变形 */
/* 编辑区撑满时间线面板剩余高度（消除下方大片空白）；素材宫格紧贴提示词输入框（gap:0 + 分隔线） */
.mm-split { gap: 0; flex: 1 1 auto; min-height: clamp(190px, 26cqh, 300px); align-items: stretch; }
.mm-media { width: calc(var(--mm-cell, 75px) * 3 + var(--mm-gap, 7px) * 2 + 4px);
  max-height: none; padding-right: 10px; border-right: 1px solid rgba(120,170,255,.16); }
.mm-prompt { padding-left: 10px; }
.mm-prompt .mention-ed { max-height: none; }
.mm-preview { flex: 0 0 clamp(140px, 15.5cqw, 216px); width: clamp(140px, 15.5cqw, 216px);
  min-width: clamp(140px, 15.5cqw, 216px); max-width: clamp(140px, 15.5cqw, 216px);
  height: clamp(140px, 15.5cqw, 216px); min-height: clamp(140px, 15.5cqw, 216px); max-height: clamp(140px, 15.5cqw, 216px); }
.mm-preview { margin-left: clamp(7px, .85cqw, 11px); }
.mm-pv-title { font-size: clamp(10px, .95cqw, 11.5px); }
/* 剪辑轨道：随高度自适应，标尺不挤 */
.ed-ruler { height: clamp(17px, 2.2cqh, 24px) !important; }
.ed-track { min-height: clamp(34px, 4.6cqh, 52px); }
/* 参数页签 */
.tl-tab { font-size: clamp(10.5px, 1cqw, 12.5px); padding: clamp(4px, .52cqw, 7px) clamp(8px, .95cqw, 12px); }
/* 主题切换时颜色平滑过渡（只过渡颜色类属性，避免布局抖动/输入卡顿） */
.mrnext-root, .btn, .card, .mx-nav-item, .input, .select, .textarea, .mx-panel-head, .tl-tab {
  transition: background-color .26s var(--ease), border-color .26s var(--ease), color .18s var(--ease),
              box-shadow .26s var(--ease);
}

/* ================= 🔥 火焰流动主题：点击按钮 → 火焰向四周喷发 ================= */
/* 第 1 层：按钮本体火环扩散（贴在按钮上，随圆角） */
.mrnext-theme-fire .btn, .mrnext-theme-fire .tl-tab, .mrnext-theme-fire .ptab,
.mrnext-theme-fire .mx-nav-item, .mrnext-theme-fire .mm-playbtn { position: relative; }
.mx-fire-ring {
  position: absolute; inset: -1px; border-radius: inherit; pointer-events: none; z-index: 2;
  border: 2px solid rgba(255, 165, 55, .9);
  box-shadow: 0 0 16px rgba(255, 130, 30, .65), inset 0 0 14px rgba(255, 110, 20, .5);
  animation: mxFireRing .46s cubic-bezier(.2,.8,.3,1) forwards;
}
@keyframes mxFireRing {
  0%   { transform: scale(.93); opacity: .98; }
  60%  { opacity: .55; }
  100% { transform: scale(1.42); opacity: 0; }
}
/* 第 2 层：火星向四周喷射（层挂在 root，坐标用点击点） */
.mx-fire-layer { position: absolute; inset: 0; pointer-events: none; z-index: 4; overflow: visible; }
.mx-fire-particle {
  position: absolute; border-radius: 50%; pointer-events: none; will-change: transform, opacity;
  background: radial-gradient(circle at 50% 62%, #fff6d8 0%, #ffc061 26%, #ff6a00 56%, rgba(255, 60, 0, 0) 74%);
  box-shadow: 0 0 10px rgba(255, 150, 40, .85), 0 0 22px rgba(255, 90, 0, .45);
  animation: mxFireBurst var(--dur, .62s) cubic-bezier(.22,.9,.36,1) var(--dly, 0s) forwards;
}
@keyframes mxFireBurst {
  0%   { transform: translate(-50%, -50%) scale(.35) rotate(0deg); opacity: 1; }
  30%  { opacity: 1; }
  100% { transform: translate(calc(-50% + var(--dx, 0px)), calc(-50% + var(--dy, 0px)))
                    scale(var(--sc, .18)) rotate(var(--rot, 0deg)); opacity: 0; }
}
/* 点击瞬间按钮本身的炽热反馈 */
.mrnext-theme-fire .btn:active, .mrnext-theme-fire .tl-tab:active, .mrnext-theme-fire .ptab:active,
.mrnext-theme-fire .mx-nav-item:active {
  box-shadow: 0 0 22px rgba(255, 150, 40, .85), inset 0 0 16px rgba(255, 120, 20, .45) !important;
}
`;
