// panels/lora_controls.js — 共用 LoRA 控件（启用 toggle + LoRA 文件夹路径 + 📂 选择）
// 生图 / 公共前缀 / 流水线 三处都用；共享 store.useLora + loraFolder
//
// 用法：
//   const { row, reloadLoras, isEnabled, getFolder } = createLoraControls(ctx, { onChange });
//   parent.appendChild(row);
//   await reloadLoras();  // 拉后端列表（注入到面板内已有的 <select id="lorasel">）
//
// ctx.store  : createStore — 含 useLora / loraFolder 字段
// ctx.api    : StudioAPI（fetch .assetgenConfig(enabled, extra) / .editorOptions(enabled, extra)）
// ctx.toast  : (msg, err?) => void
// opts:
//   inline      : boolean — true 排在一行（默认 false：换行两行）
//   onChange    : (state) => void — useLora 或 loraFolder 变了 → 父重刷 LoRA 列表
//   selectIds   : string[] — 面板内需要同步 LoRA 列表的 <select> id 列表
//
// 返回值：
//   row          : DOM 容器（reactive，颜色随开启/关闭切换）
//   reloadLoras  : () => Promise<void>  — 拉后端 LoRA 列表并 inject 到 selectIds 下的 <select>
//   isEnabled    : () => boolean
//   getFolder    : () => string
//
// 弹出的"文件夹选择"复用了 studio_browse 接口（ComfyUI input/model dir 浏览）。

import { h, clear } from "../core/dom.js";

export function createLoraControls(ctx, opts = {}) {
  const { inline = false, onChange = () => {}, selectIds = [] } = opts;
  const store = ctx.store;
  const toast = ctx.toast;
  const api = ctx.api;

  /* ---------- toggle 按钮 ---------- */
  const tog = h("button", {
    class: "btn",
    type: "button",
    title: "开启后使用 Krea2 编辑 LoRA；关闭则不加载任何 LoRA（联动三个面板）",
    onclick: () => {
      const next = !store.get().useLora;
      store.set({ useLora: next });
      syncStyle();
      onChange({ useLora: next, loraFolder: store.get().loraFolder || "" });
    },
  });
  function syncStyle() {
    const on = !!store.get().useLora;
    tog.textContent = on ? "✅ 使用 LoRA" : "⬜ 使用 LoRA";
    tog.style.borderColor = on ? "#ffcf6b" : "#31446a";
    tog.style.color = on ? "#ffcf6b" : "#a8bbd0";
    tog.style.background = on ? "linear-gradient(180deg,#3a2c14,#1a1408)" : "rgba(20,32,52,.6)";
    tog.style.fontWeight = "700";
  }
  tog.style.padding = "4px 11px";
  tog.style.fontSize = "12px";
  syncStyle();

  /* ---------- 文件夹路径输入 ---------- */
  const folderInp = h("input", {
    class: "input",
    type: "text",
    placeholder: "（默认 = models/loras/）",
    title: "自定义 LoRA 扫描目录，留空走后端默认 loras/",
    style: { width: 200, fontSize: 11.5, fontFamily: "ui-monospace,Consolas,monospace" },
  });
  folderInp.value = store.get().loraFolder || "";
  folderInp.oninput = () => {
    store.set({ loraFolder: folderInp.value.trim() });
  };
  folderInp.onblur = () => {
    if (folderInp.value !== (store.get().loraFolder || "")) {
      onChange({ useLora: store.get().useLora, loraFolder: folderInp.value.trim() });
    }
  };

  /* ---------- 📂 浏览按钮：弹原生式路径导航 ---------- */
  const browseBtn = h("button", {
    class: "btn",
    type: "button",
    title: "浏览本机目录，选一个 LoRA 文件夹（会扫描所有 .safetensors/.pt/.bin/.ckpt）",
    style: { padding: "3px 9px", fontSize: 11.5 },
    onclick: () => openFolderBrowser(folderInp, () => onChange({ useLora: store.get().useLora, loraFolder: folderInp.value.trim() })),
  }, "📂 选…");
  const clearBtn = h("button", {
    class: "btn",
    type: "button",
    title: "清空回默认 loras/",
    style: { padding: "3px 7px", fontSize: 11 },
    onclick: () => {
      folderInp.value = "";
      store.set({ loraFolder: "" });
      onChange({ useLora: store.get().useLora, loraFolder: "" });
    },
  }, "✕");

  /* ---------- 标签 ---------- */
  const lbl = h("span", { class: "muted", style: { fontSize: 11 } }, "LoRA 文件夹");

  /* ---------- 拼装 ---------- */
  const rowStyle = inline
    ? { display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }
    : { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 4 };
  const group = h("div", {
    class: "mrnext-lora-row",
    style: rowStyle,
  }, tog, lbl, folderInp, browseBtn, clearBtn);

  /* ---------- store 订阅：跨面板联动 ---------- */
  store.subscribe((st) => {
    // 把 useLora / loraFolder 同步到本控件（其它面板改了 → 这边跟着变）
    if (st.useLora != null && (tog.textContent.startsWith("✅") ? false : true) !== !!st.useLora) syncStyle();
    else syncStyle();
    if ((st.loraFolder || "") !== folderInp.value && document.activeElement !== folderInp) {
      folderInp.value = st.loraFolder || "";
    }
  });

  /* ---------- 让父面板用同一份 LoRA 列表 ---------- */
  async function reloadLoras() {
    const on = !!store.get().useLora;
    const extra = (store.get().loraFolder || "").trim();
    // 两个端点都拿一次：assetgen_config 主给生图面板，editor_options 给时间线（如果它有 LoRA 选择器）
    const [agc, eo] = await Promise.all([
      api.assetgenConfig ? safeFetch(() => api.assetgenConfig(on, extra)) : Promise.resolve(null),
      api.editorOptions  ? safeFetch(() => api.editorOptions(on, extra)) : Promise.resolve(null),
    ]);
    const loras = (agc && agc.loras) || (eo && eo.loras) || [];
    for (const id of selectIds) {
      const sel = document.getElementById(id);
      if (!sel) continue;
      const prev = sel.value;
      clear(sel);
      sel.appendChild(h("option", { value: "" }, on ? "（自动选取）" : "（未启用 LoRA）"));
      for (const n of loras) {
        const o = h("option", { value: n }, n);
        if (n === prev) o.selected = true;
        sel.appendChild(o);
      }
    }
    return loras;
  }

  return {
    row: group,
    reloadLoras,
    isEnabled: () => !!store.get().useLora,
    getFolder: () => (store.get().loraFolder || "").trim(),
  };
}

/* ---------- helpers ---------- */

async function safeFetch(fn) {
  try { return await fn(); } catch { return null; }
}

/* 轻量级文件夹浏览器：复用 /mrnext/studio/browse（已支持任意磁盘/模型根目录） */
function openFolderBrowser(folderInp, onPicked) {
  const overlay = h("div", {
    style: "position:fixed;inset:0;z-index:2147483600;background:rgba(2,4,9,.86);display:flex;align-items:center;justify-content:center;padding:18px;",
    onclick: (e) => { if (e.target === overlay) overlay.remove(); },
  });
  const panel = h("div", {
    style: "width:540px;max-width:94vw;max-height:80vh;background:#101a2a;border:1px solid #31446a;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 18px 50px rgba(0,0,0,.65);",
  });
  const cur = { path: folderInp.value || "" };
  const header = h("div", { style: "display:flex;align-items:center;gap:8px;" },
    h("b", { style: { fontSize: 13, color: "#ffcf6b" } }, "📂 选择 LoRA 文件夹"),
    h("div", { class: "mx-spacer" }),
    h("button", { class: "btn", style: { padding: "3px 9px", fontSize: 11.5 }, onclick: () => overlay.remove() }, "✕"),
  );
  const pathLbl = h("div", { style: "font-size:11.5px;color:#9fb0cc;font-family:ui-monospace,Consolas,monospace;background:#0c1428;border:1px solid #24344e;border-radius:6px;padding:5px 8px;word-break:break-all;" }, cur.path || "（空：用默认 loras/）");
  const upBtn = h("button", { class: "btn", style: { padding: "4px 10px", fontSize: 11.5 }, onclick: () => { if (cur.path) { cur.path = parentDir(cur.path); load(); } } }, "⬆ 上级");
  const useBtn = h("button", { class: "btn btn-primary", style: { padding: "4px 12px", fontSize: 11.5 }, onclick: () => {
    folderInp.value = cur.path;
    onPicked && onPicked();
    overlay.remove();
  } }, "✓ 用此文件夹");
  const dirList = h("div", { style: "overflow-y:auto;flex:1 1 220px;min-height:200px;max-height:46vh;background:#0c1428;border:1px solid #24344e;border-radius:8px;padding:4px;display:flex;flex-direction:column;gap:3px;" });
  const actions = h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;" }, upBtn, useBtn);
  const toolbar = h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;" }, actions);

  async function load() {
    pathLbl.textContent = cur.path || "（空：用默认 loras/）";
    clear(dirList);
    const statusLbl = h("div", { class: "muted", style: { fontSize: 11, padding: "8px" } }, "加载…");
    dirList.appendChild(statusLbl);
    try {
      // 直接走 /mrnext/studio/browse —— 该接口接受任意 path（绝对/相对）
      const url = `/mrnext/studio/browse?path=${encodeURIComponent(cur.path || "")}`;
      const r = await fetch(url).then((x) => x.json());
      if (r.error) {
        statusLbl.textContent = "无法进入：" + r.error + "（建议直接粘绝对路径到上方输入框）";
        statusLbl.style.color = "#ff8989";
        return;
      }
      cur.path = r.path || cur.path;
      pathLbl.textContent = cur.path;
      clear(dirList);
      if (!r.dirs || !r.dirs.length) {
        dirList.appendChild(h("div", { class: "muted", style: { fontSize: 11, padding: "8px" } }, "此目录下无子文件夹"));
        return;
      }
      for (const d of r.dirs) {
        const row = h("div", {
          style: "padding:7px 10px;display:flex;align-items:center;gap:8px;border-radius:6px;cursor:pointer;font-size:12.5px;color:#dbe6f4;border:1px solid transparent;",
          onclick: () => { cur.path = joinPath(cur.path, d); load(); },
          onmouseenter: function () { this.style.background = "#162842"; this.style.borderColor = "#31446a"; },
          onmouseleave: function () { this.style.background = ""; this.style.borderColor = "transparent"; },
        },
          h("span", { style: { color: "#7dd3fc" } }, "📁"),
          h("span", { style: { flex: 1 } }, d),
          h("span", { class: "muted", style: { fontSize: 10.5 } }, "进入 →"),
        );
        dirList.appendChild(row);
      }
    } catch (e) {
      statusLbl.textContent = "加载失败：" + e.message;
      statusLbl.style.color = "#ff8989";
    }
  }
  panel.append(header, pathLbl, toolbar, dirList);
  // 直接路径输入
  const pathInp = h("input", {
    class: "input",
    type: "text",
    placeholder: "或直接粘贴绝对路径，回车确认…",
    style: { width: "100%", fontSize: 11.5, fontFamily: "ui-monospace,Consolas,monospace" },
    value: cur.path,
    onkeydown: (e) => { if (e.key === "Enter") { cur.path = pathInp.value.trim(); load(); } },
  });
  panel.insertBefore(pathInp, toolbar);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  load();
}

function parentDir(p) {
  // 跨平台解析（Windows / POSIX 都给"上一级"）
  if (!p) return "";
  // 去掉尾斜杠
  p = String(p).replace(/[\\/]+$/, "");
  const m = p.match(/^(.*[\\/:])[^\\/:]+[\\/:]?$/);
  return m ? m[1].replace(/[\\/]+$/, "") : p;
}

function joinPath(base, child) {
  if (!base) return child;
  const sep = base.includes("\\") ? "\\" : "/";
  if (base.endsWith("/") || base.endsWith("\\")) return base + child;
  return base + sep + child;
}
