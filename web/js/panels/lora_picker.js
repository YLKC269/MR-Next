// panels/lora_picker.js — 点击弹出 LoRA 列表（列表来自当前「LoRA 文件夹」），点一项即用。
// 与 lora_controls.js 互补：那个管「开关 + 文件夹 + 浏览」，这个管「从列表里挑 LoRA 并调强度」。
//
// 关键点：
//   · 选择结果存在共享 store.loras = [{name, strength}]，三个面板（生图/剧本设定图/流水线）通用；
//   · 后端 /mrnext/assetgen/generate 的 loras 参数**对所有模式生效**（t2i/i2i/ref/edit）；
//   · 浮层挂到 document.body（fixed 定位 + 动态算位置），避免被节点/Shadow DOM 裁切；
//   · outside-click 关闭带 closed 守卫（pointerdown 可能早于/晚于子元素 click，防止误触）。
//
// 用法：
//   const picker = createLoraPicker(ctx, { onChange: (arr) => {...} });
//   parent.appendChild(picker.row);
//   picker.get()        // → [{name, strength}]
//   await picker.reload()

import { h, clear } from "../core/dom.js";

let _openClose = null; // 同一时刻只允许一个浮层打开（点新的会先关旧的）

export function createLoraPicker(ctx, opts = {}) {
  const store = ctx.store;
  const api = ctx.api;
  const toast = ctx.toast;

  let list = [];        // 后端返回的 LoRA 名称列表
  let loadable = new Set();  // ComfyUI 真能加载的名字（规范化后比较）——不在里面的选了会校验失败
  let loading = false;
  const norm = (x) => String(x || "").replace(/\\/g, "/").toLowerCase();

  const get = () => (store.get().loras || []).map((x) => ({ name: x.name, strength: x.strength }));
  const setSel = (arr) => {
    store.set({ loras: arr, useLora: arr.length ? true : !!store.get().useLora });
    paint();
    if (opts.onChange) { try { opts.onChange(arr); } catch (_) {} }
  };

  /* ---------------- 触发按钮（显示当前选择） ---------------- */
  const chip = h("button", {
    class: "btn", type: "button",
    style: {
      padding: "4px 10px", fontSize: 11.5, maxWidth: 340,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    },
    title: "点击选择 LoRA：列表来自上面的「LoRA 文件夹」，可多选 + 调强度；对所有生图模式生效（t2i/i2i/参考/编辑）",
    onclick: (ev) => { ev.stopPropagation(); openPopup(); },
  });

  function paint() {
    const sel = get();
    if (!sel.length) {
      chip.textContent = "🎚 选择 LoRA（未选）";
      chip.style.borderColor = "#31446a";
      chip.style.color = "#a8bbd0";
      chip.style.background = "rgba(20,32,52,.6)";
      return;
    }
    const short = sel.map((x) => String(x.name).split("/").pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, ""));
    chip.textContent = "🎚 LoRA：" + (short.length > 2 ? short.slice(0, 2).join(" + ") + ` 等 ${short.length} 个` : short.join(" + "));
    chip.style.borderColor = "#ffcf6b";
    chip.style.color = "#ffcf6b";
    chip.style.background = "linear-gradient(180deg,#3a2c14,#1a1408)";
  }

  /* ---------------- 浮层内容 ---------------- */
  let popup = null;
  let listBox = null;
  let searchInp = null;
  let strInp = null;
  let cntLbl = null;

  function closePopup() {
    if (popup) { try { popup.remove(); } catch (_) {} popup = null; }
    if (_openClose === closePopup) _openClose = null;
    document.removeEventListener("pointerdown", onDocDown, true);
    window.removeEventListener("resize", place);
  }

  function onDocDown(ev) {
    if (!popup) return;
    if (popup.contains(ev.target) || chip.contains(ev.target)) return;
    closePopup();
  }

  function place() {
    if (!popup) return;
    const r = chip.getBoundingClientRect();
    const W = 380;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 12));
    let top = r.bottom + 6;
    const maxH = 420;
    if (top + maxH > window.innerHeight - 8) top = Math.max(8, r.top - maxH - 6);
    popup.style.left = left + "px";
    popup.style.top = top + "px";
  }

  function rowFor(name) {
    const sel = get();
    const on = sel.some((x) => x.name === name);
    const short = String(name).split("/").pop();
    const canLoad = loadable.size === 0 || loadable.has(norm(name));
    if (!canLoad) {
      return h("div", {
        title: "这个 LoRA 不在 ComfyUI 的 loras 搜索路径里，加载会失败",
        style: {
          display: "flex", alignItems: "center", gap: 8, padding: "7px 9px",
          borderBottom: "1px solid rgba(120,170,255,.10)", opacity: .55, cursor: "not-allowed",
        },
        onclick: (ev) => {
          ev.stopPropagation();
          toast("这个 LoRA 无法加载：请把它放进 models/loras/（或子目录），"
              + "或在 extra_model_paths.yaml 里登记它所在的文件夹，然后重启 ComfyUI", true);
        },
      },
        h("span", { style: { fontSize: 12, color: "#ff9d9d", width: 14, flex: "0 0 auto" } }, "⚠"),
        h("span", { style: { flex: "1 1 auto", minWidth: 0, fontSize: 11.5, color: "#8b98a8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, short),
        h("span", { style: { fontSize: 10, color: "#ff9d9d", flex: "0 0 auto" } }, "不可加载"));
    }
    const dir = String(name).includes("/") ? String(name).split("/").slice(0, -1).join("/") + "/" : "";
    const row = h("div", {
      title: name,
      style: {
        display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", cursor: "pointer",
        borderBottom: "1px solid rgba(120,170,255,.10)",
        background: on ? "linear-gradient(90deg, rgba(255,207,107,.16), rgba(255,207,107,.04))" : "transparent",
      },
      onclick: (ev) => {
        ev.stopPropagation();
        const cur = get();
        const st = Number(strInp && strInp.value);
        const strength = (!strInp || isNaN(st)) ? 1.0 : Math.max(0, Math.min(2, st));
        if (on) setSel(cur.filter((x) => x.name !== name));
        else {
          if (cur.length >= 4) { toast("最多同时叠 4 个 LoRA（先取消一个）", true); return; }
          setSel(cur.concat([{ name, strength }]));
        }
        renderList();     // 就地刷新选中态（不关浮层，方便连点多个）
        opts.onToggle && opts.onToggle(name, !on);
      },
    },
      h("span", { style: { fontSize: 12, color: on ? "#ffcf6b" : "#93a4b8", width: 14, flex: "0 0 auto" } }, on ? "✓" : "＋"),
      h("span", { style: { flex: "1 1 auto", minWidth: 0, fontSize: 11.5, color: on ? "#ffe0a3" : "#dbe6f4", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, short),
      dir ? h("span", { style: { fontSize: 10, color: "#6d7f96", flex: "0 0 auto" } }, dir) : null);
    return row;
  }

  const listed_loadable_count = () => (loadable.size ? list.filter((n) => loadable.has(norm(n))).length : list.length);

  function renderList() {
    if (!listBox) return;
    clear(listBox);
    const kw = (searchInp && searchInp.value || "").trim().toLowerCase();
    const shown = kw ? list.filter((n) => String(n).toLowerCase().includes(kw)) : list;
    const selN = get().length;
    const bad = Math.max(0, list.length - listed_loadable_count());
    if (cntLbl) {
      cntLbl.textContent = `共 ${list.length} 个 · 可加载 ${listed_loadable_count()}${bad ? ` · ⚠不可加载 ${bad}` : ""} · 已选 ${selN}/4${kw ? ` · 命中 ${shown.length}` : ""}`;
    }
    if (loading) { listBox.appendChild(h("div", { class: "muted", style: { padding: 12, fontSize: 11.5 } }, "加载中…")); return; }
    if (!list.length) {
      listBox.appendChild(h("div", { class: "muted", style: { padding: 12, fontSize: 11.5 } },
        "这个文件夹里没有 LoRA（支持 .safetensors / .pt / .ckpt / .bin）。用左边的 📂 选… 换一个文件夹。"));
      return;
    }
    if (!shown.length) { listBox.appendChild(h("div", { class: "muted", style: { padding: 12, fontSize: 11.5 } }, "没有匹配的 LoRA")); return; }
    for (const n of shown) listBox.appendChild(rowFor(n));
  }

  async function reload() {
    loading = true;
    renderList();
    try {
      const extra = (store.get().loraFolder || "").trim();
      const r = await api.assetgenConfig(true, extra);
      list = (r && r.loras) || [];
      const ld = (r && r.loras_loadable) || null;
      loadable = ld ? new Set(ld.map(norm)) : new Set(list.map(norm));
    } catch (e) {
      list = [];
      toast("LoRA 列表读取失败: " + e.message, true);
    }
    loading = false;
    renderList();
    return list;
  }

  function openPopup() {
    if (popup) { closePopup(); return; }
    if (_openClose) { try { _openClose(); } catch (_) {} }

    const sel = get();
    searchInp = h("input", {
      class: "input", type: "text", placeholder: "搜索 LoRA 名字…",
      style: { flex: "1 1 auto", minWidth: 0, fontSize: 11.5, padding: "4px 8px" },
      oninput: () => renderList(),
    });
    strInp = h("input", {
      class: "input", type: "number", min: 0, max: 2, step: 0.05, value: sel[0] && sel[0].strength != null ? sel[0].strength : 1,
      style: { width: 62, fontSize: 11.5, padding: "4px 6px" },
      title: "新选中项使用的强度（0–2，默认 1）",
    });
    cntLbl = h("span", { class: "muted", style: { fontSize: 10.5 } }, "");

    listBox = h("div", { style: { maxHeight: 300, overflowY: "auto", border: "1px solid rgba(120,170,255,.16)", borderRadius: 8, background: "rgba(6,12,22,.5)" } });

    popup = h("div", {
      style: {
        position: "fixed", zIndex: 2147483000, width: 380, padding: 10,
        background: "#101a2a", border: "1px solid #31446a", borderRadius: 12,
        boxShadow: "0 18px 60px rgba(0,0,0,.65)", display: "flex", flexDirection: "column", gap: 8,
        fontFamily: "ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
      },
      onclick: (ev) => ev.stopPropagation(),
    },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        h("b", { style: { fontSize: 12.5, color: "#ffcf6b" } }, "🎚 选择 LoRA"),
        cntLbl,
        h("div", { style: { flex: "1 1 auto" } }),
        h("button", {
          class: "btn", style: { padding: "3px 8px", fontSize: 11 },
          title: "重新读取「LoRA 文件夹」里的列表",
          onclick: (ev) => { ev.stopPropagation(); reload(); },
        }, "↻ 刷新")),
      h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
        searchInp,
        h("span", { class: "muted", style: { fontSize: 11 } }, "强度"), strInp),
      listBox,
      h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        h("span", { class: "muted", style: { fontSize: 10.5 } },
          "点一项即生效（可多选，最多 4 个）· 对所有生图模式生效"),
        h("div", { style: { flex: "1 1 auto" } }),
        h("button", {
          class: "btn", style: { padding: "3px 8px", fontSize: 11, borderColor: "#a33" },
          onclick: (ev) => { ev.stopPropagation(); setSel([]); renderList(); },
        }, "清空"),
        h("button", {
          class: "btn btn-primary", style: { padding: "3px 10px", fontSize: 11 },
          onclick: (ev) => { ev.stopPropagation(); closePopup(); },
        }, "完成")));

    document.body.appendChild(popup);
    place();
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onDocDown, true);
    _openClose = closePopup;

    // 每次打开都刷新一次列表（文件夹可能在别处改过）
    reload();
  }

  // store 变化 → 按钮文案跟随（别处改了选择也要同步）
  store.subscribe(() => { try { paint(); } catch (_) {} });
  paint();

  return {
    row: chip,
    get,
    set: setSel,
    reload,
    list: () => list.slice(),
  };
}
