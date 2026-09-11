// main.js — 扩展入口（唯一有副作用的文件）。
// 仅对 MRBoardStudio 节点挂一个 DOM widget，并把 Shadow DOM 根交给 app.mountApp。
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { mountApp } from "./app.js";

const MRNEXT_VERSION = "1.11.10"; // 改这个就能让你 Ctrl+F5 后用右键"检查"看 widget header 是不是新版本
console.log("[MRBoardNext] extension loaded · v" + MRNEXT_VERSION);

app.registerExtension({
  name: "ComfyUI.MRBoardNext",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const cls = (nodeType && nodeType.comfyClass) || (nodeData && nodeData.name) || "";
    if (cls !== "MRBoardStudio") return;
    if (nodeType.prototype._mrnextPatched) return;
    nodeType.prototype._mrnextPatched = true;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated && onCreated.apply(this, arguments);
      const node = this;
      setTimeout(() => mountStudioNode(node), 0);
      return r;
    };
  },
});

function mountStudioNode(node) {
  if (node._mrnextMounted) return;
  node._mrnextMounted = true;

  // 锁定节点尺寸，避免 ComfyUI 自动缩放把面板挤变形
  const W = 1100;
  const H = 860;
  try {
    Object.defineProperty(node, "size", {
      value: [W, H],
      writable: true,
      configurable: true,
    });
  } catch (_) {}
  if (node.setSize) {
    try {
      node.setSize([W, H]);
    } catch (_) {}
  }

  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;";

  let shadow;
  try {
    shadow = host.attachShadow({ mode: "open" });
  } catch (_) {
    shadow = host; // 极端环境兜底
  }

  try {
    node.addDOMWidget("mrnext_ui", "mrnext.studio", host, {
      serialize: false,
      hideOnZoom: false,
    });
  } catch (e) {
    console.error("[MRBoardNext] addDOMWidget failed", e);
    renderBootError(shadow, "addDOMWidget 失败", e);
    return;
  }

  try {
    mountApp(shadow, node);
    // ① 标记版本号到 widget host 上，开发者工具(F12) 看 host 属性就能判断是否新版本
    host.setAttribute("data-mrnext-version", MRNEXT_VERSION);
    host.setAttribute("data-mrnext-mounted-at", new Date().toISOString());
    console.log("[MRBoardNext] mounted OK · v" + MRNEXT_VERSION);
  } catch (e) {
    console.error("[MRBoardNext] mount failed", e);
    // ② mountApp 抛错 → host 内显示红字错误条（不再空白）
    renderBootError(shadow, "面板初始化失败（" + MRNEXT_VERSION + "）", e);
    return;
  }

  // ③ 干掉 ComfyUI 给本节点加的原生预览（画布上那张大图 + "W × H" 尺寸标签）
  //    用户要的实时预览只在时间线面板提示词框右侧那个定死方框里，画布上不允许再出现预览，
  //    否则节点会被撑高、面板被挤变形。
  installNoNativePreview(node);
}

/**
 * 本节点是 OUTPUT_NODE 且带 VIDEO 输出 —— ComfyUI 执行完会在画布上就地画一张预览大图
 * （并把节点撑高）。这里把「原生预览」彻底摘掉：
 *   - 清 node.imgs / node.videos / imageIndex（画布预览的数据源）
 *   - 摘掉 type 为 preview/video/image 的 widget（保留我们自己的 DOM widget）
 *   - 废掉 setSizeForImage（它是节点被撑高的直接原因）
 *   - 每次 executed 后复查一次（ComfyUI 会重新塞回来）
 */
function installNoNativePreview(node) {
  const W = 1100;
  const H = 860;

  const strip = () => {
    try {
      if (node.imgs) node.imgs = null;
      if (node.videos) node.videos = null;
      if (node.imageIndex != null) node.imageIndex = 0;
      if (Array.isArray(node.widgets)) {
        const kept = node.widgets.filter((w) => {
          const n = String((w && w.name) || "").toLowerCase();
          const t = String((w && w.type) || "").toLowerCase();
          if (n === "mrnext_ui") return true; // 我们自己的面板，保留
          if (t === "preview" || t === "video" || t === "image") return false;
          if (n === "video" || n === "image" || n === "images" || n.includes("preview")) return false;
          return true;
        });
        if (kept.length !== node.widgets.length) node.widgets = kept;
      }
    } catch (_) {}
  };

  const fixSize = () => {
    try {
      const s = node.size || [W, H];
      // 只压回"被预览撑高"的情况，不动用户手动改宽的意图
      if (s[1] > H + 4 || s[0] > W + 4) node.setSize([Math.max(s[0], 0) > W ? s[0] : W, H]);
    } catch (_) {}
  };

  const fixAll = () => { strip(); fixSize(); };

  try {
    node.setSizeForImage = function () { /* 禁用：不许因预览撑高节点 */ };
  } catch (_) {}

  const origExec = node.onExecuted;
  node.onExecuted = function () {
    let r;
    try {
      r = origExec && origExec.apply(this, arguments);
    } catch (e) {
      console.error("[MRBoardNext] onExecuted error", e);
    }
    setTimeout(fixAll, 0);
    return r;
  };

  try {
    api.addEventListener("executed", (e) => {
      const d = e && e.detail;
      const id = d && (d.node != null ? d.node : d.display_node);
      if (id != null && String(id) === String(node.id)) setTimeout(fixAll, 0);
    });
  } catch (_) {}

  fixAll();
}

/**
 * mountApp 任何抛错都会落到这里 → widget host 里直接给用户显示错误信息
 * 用户截图就能看到版本号 + 错误堆栈，不用再去 DevTools Console 翻。
 */
function renderBootError(shadow, summary, err) {
  try {
    // 清空可能的残留（applyError 后 shadow 里可能已有 node）
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);
    const style = document.createElement("style");
    style.textContent = `
      .mx-bootscreen { font-family: ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif;
        padding:18px;color:#ffb5b5;background:#1a0e10;height:100%;box-sizing:border-box; }
      .mx-bootscreen h2 { margin:0 0 8px;font-size:15px;color:#ffcf6b; }
      .mx-bootscreen p  { margin:6px 0;font-size:12.5px;line-height:1.6;color:#dbe6f4; }
      .mx-bootscreen code{ display:block;padding:8px;margin-top:8px;font-size:11px;
        background:#0a0e13;border:1px solid #3a2020;border-radius:6px;white-space:pre-wrap;
        color:#ffb5b5;max-height:60vh;overflow:auto;font-family:ui-monospace,Consolas,monospace; }
      .mx-bootscreen .ver { display:inline-block;padding:2px 7px;border-radius:4px;
        background:#5a3010;color:#ffcf6b;font-size:11px;font-weight:700;letter-spacing:.05em; }
      .mx-bootscreen .hint { margin-top:12px;padding:8px 10px;font-size:11.5px;
        background:#1c2430;border-left:3px solid #ffcf6b;border-radius:0 6px 6px 0;
        color:#9fd0ff; }
    `;
    shadow.appendChild(style);
    const root = document.createElement("div");
    root.className = "mx-bootscreen";
    root.innerHTML = `
      <h2>⚠ ${summary}</h2>
      <p><span class="ver">v${MRNEXT_VERSION}</span></p>
      <p>模块加载错误（可能是上一次改动里某个 import 抛了。绝大多数情况是 JS 字符串里嵌了中文双引号 → parser 把字符串砍成两半 → SyntaxError → 整个 module 加载不上）。</p>
      <code id="mx-boot-err"></code>
      <p class="hint">🔧 排查步骤：<br>
        1) 按 <b>F12</b> 打开 DevTools → 选 <b>Console</b> → 过滤 <code>MRBoardNext</code> 看完整堆栈<br>
        2) 文件里残留的智能引号 <code>" " ' '</code> 替换为 <code>"</code> 或 <code>《》</code><br>
        3) <b>Ctrl+F5</b> / 硬刷新绕开 vite 缓存</p>
    `;
    shadow.appendChild(root);
    // 自救按钮：清掉本节点的 localStorage 持久化状态（store/顺序/参数缓存）后重挂载，
    // 免去「节点卡死必须删除节点文本重新导入」的暴力操作。
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "🧹 重置面板状态并重新加载（清空本节点本地缓存）";
    resetBtn.style.cssText = "margin-top:12px;padding:8px 14px;border-radius:8px;border:1px solid #ffcf6b;background:#5a3010;color:#ffcf6b;font-size:12.5px;font-weight:700;cursor:pointer;";
    resetBtn.onclick = () => {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("mrnext.")) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
        // 参数缓存键（timeline PARAMS_LS_KEY 等以 mrboard 前缀存的也一并清）
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && (k.startsWith("mrboard") || k.startsWith("mrnext_"))) localStorage.removeItem(k);
        }
      } catch (_) {}
      location.reload();
    };
    root.appendChild(resetBtn);
    const code = root.querySelector("#mx-boot-err");
    code.textContent = String(err && (err.stack || err.message || err) || "(unknown)");
  } catch (_) {
    /* 渲染兜底自己也失败就算了，console 已有 */
  }
}
