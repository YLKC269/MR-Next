// panels/style_picker.js — Krea2 风格扩展开关（3946 种）。
//
// 数据来自后端 /mrnext/assetgen/styles（读 ComfyUI-Easy-Use/styles 里的 47 个 JSON，
// 与 Easy-Use 的「风格选择器」节点同源 —— 同一种风格两边得到的提示词完全一致）。
//
// 关键点：
//   · 选择结果存在共享 store.genStyles = [{id, label}]，生图面板 + 流水线/剧本设定图通用；
//   · 后端 /mrnext/assetgen/generate 的 styles 参数**对 4 种模式都生效**（t2i/i2i/ref/edit）；
//   · 风格 prompt 里含 `{prompt}` 占位符 → 后端按 Easy-Use 语义把用户提示词嵌进去，
//     面板里的「提示词预览」用同样的规则本地算一遍，所见即所得；
//   · 3946 条不能一次全渲染（几十万 DOM 节点必卡），所以：
//       默认只展开「当前选中分类」+ 虚拟上限（首屏 120 条），搜索时跨全库但同样限流；
//   · 缩略图走后端 /mrnext/assetgen/style_thumb（自己也做了长缓存），不在 styles 内的
//     远端 URL 后端已过滤为空 → 前端用纯色兜底块 + 风格首字，不出现破图。
//
// 用法：
//   const picker = createStylePicker(ctx, { onChange: (arr) => {...} });
//   parent.appendChild(picker.row);
//   picker.get()          // → [{id, label}]
//   picker.ids()          // → ["分类::名字", ...]
//   picker.preview(text)  // → 套用后的提示词（用于回显）

import { h, clear } from "../core/dom.js";

// 首屏/搜索结果上限：3946 条全渲染会卡死面板，限流后滚动到底自动续载
const PAGE = 120;

let _openClose = null; // 同一时刻只允许一个浮层打开

// 缩略图 URL（走后端代理，避开 custom_nodes 不在 /view 三个根里的问题）
function thumbUrl(thumb) {
  if (!thumb) return "";
  return "/mrnext/assetgen/style_thumb?p=" + encodeURIComponent(thumb);
}

// 与后端 server/styles.py::apply_styles 完全同规则的前端复算（仅用于预览回显）
export function applyStylesLocal(prompt, styleObjs, negative = "") {
  const base = String(prompt || "").trim();
  let posOut = "";
  let hasPrompt = false;
  let neg = String(negative || "").trim();
  // 容错：接口异常时可能拿到 null / 非数组 / 数组里混 null（历史上后端字段缺失踩过）
  const list = Array.isArray(styleObjs) ? styleObjs : [];
  for (const st of list) {
    if (!st || typeof st !== "object") continue;
    const p = String(st.prompt || "");
    if (!p) continue;
    if (p.includes("{prompt}")) {
      if (!hasPrompt) {
        posOut = p.replace("{prompt}", base);
        hasPrompt = true;
      } else {
        posOut += ", " + p.replace(", {prompt}", "").replace("{prompt}", "").trim().replace(/^,|,$/g, "");
      }
    } else {
      posOut = posOut === "" ? p : posOut + ", " + p;
    }
    const n = String(st.negative_prompt || "").trim();
    if (n) neg = neg ? neg + ", " + n : n;
  }
  if (!hasPrompt && base) posOut = posOut ? base + ", " + posOut : base;
  return { positive: posOut.trim(), negative: neg.trim() };
}

export function createStylePicker(ctx, opts = {}) {
  const store = ctx.store;
  const toast = ctx.toast;

  let all = [];            // 全量风格条目
  let cats = [];           // [{key,label,count}]
  let loaded = false;
  let loading = false;
  let loadErr = "";

  const get = () => (store.get().genStyles || []).map((x) => ({ id: x.id, label: x.label }));
  const ids = () => get().map((x) => x.id);
  const byId = new Map();
  const rebuildIndex = () => { byId.clear(); for (const s of all) byId.set(s.id, s); };

  // 按 id 找回完整条目（预览用）；索引未就绪时返回空对象
  const objs = () => get().map((x) => byId.get(x.id) || { id: x.id, label: x.label, prompt: "", negative_prompt: "" });

  const setSel = (arr) => {
    store.set({ genStyles: arr });
    paint();
    if (opts.onChange) { try { opts.onChange(arr); } catch (_) {} }
  };

  /* ---------------- 触发按钮 ---------------- */
  const chip = h("button", {
    class: "btn", type: "button",
    style: {
      padding: "4px 10px", fontSize: 11.5, maxWidth: 360,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    },
    title: "选择 Krea2 风格（3946 种，来自 ComfyUI-Easy-Use/styles）。可多选，风格提示词会自动套到你的提示词上，对 t2i/i2i/参考/编辑 四种模式都生效",
    onclick: (ev) => { ev.stopPropagation(); openPopup(); },
  });

  function paint() {
    const sel = get();
    if (!sel.length) {
      chip.textContent = "🎨 风格扩展（未选）";
      chip.style.borderColor = "#31446a";
      chip.style.color = "#a8bbd0";
      chip.style.background = "rgba(20,32,52,.6)";
      return;
    }
    const names = sel.map((x) => x.label);
    chip.textContent = "🎨 风格：" + (names.length > 2 ? names.slice(0, 2).join(" + ") + ` 等 ${names.length} 种` : names.join(" + "));
    chip.style.borderColor = "#9ad6ff";
    chip.style.color = "#bfe6ff";
    chip.style.background = "linear-gradient(180deg,#14303a,#08181d)";
  }

  /* ---------------- 浮层 ---------------- */
  let popup = null;
  let catBox = null;      // 左侧分类列
  let listBox = null;     // 右侧风格网格
  let searchInp = null;
  let cntLbl = null;
  let previewBox = null;
  let previewInp = null;
  let curCat = "";        // 当前分类（"" = 全部）
  let shown = 0;          // 已渲染条数（滚动续载）

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
    const W = Math.min(880, window.innerWidth - 24);
    const H = Math.min(560, window.innerHeight - 24);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 12));
    let top = r.bottom + 6;
    if (top + H > window.innerHeight - 8) top = Math.max(8, r.bottom - H - 24 - 6);
    popup.style.left = left + "px";
    popup.style.top = top + "px";
    popup.style.width = W + "px";
    popup.style.height = H + "px";
  }

  // 兜底块：拿不到缩略图时用风格名首字 + 渐变，避免破图
  function fallbackThumb(label) {
    const ch = String(label || "?").trim().charAt(0) || "?";
    return h("div", {
      style: {
        width: "100%", aspectRatio: "1/1", display: "flex", alignItems: "center", justifyContent: "center",
        background: "linear-gradient(135deg,#1d2b44,#0d1626)", color: "#6f86a8",
        fontSize: 22, fontWeight: 700, userSelect: "none",
      },
    }, ch);
  }

  function cardFor(s) {
    const sel = get();
    const on = sel.some((x) => x.id === s.id);
    const card = h("div", {
      title: `${s.name}${s.name_cn ? " · " + s.name_cn : ""}\n分类：${s.category}`,
      style: {
        cursor: "pointer", borderRadius: 9, overflow: "hidden", position: "relative",
        border: on ? "2px solid #9ad6ff" : "1px solid #24344e",
        background: "#101d33", display: "flex", flexDirection: "column",
      },
      onclick: (ev) => {
        ev.stopPropagation();
        const cur = get();
        if (on) setSel(cur.filter((x) => x.id !== s.id));
        else {
          if (cur.length >= 4) { toast("最多同时叠 4 种风格（先取消一种）", true); return; }
          setSel(cur.concat([{ id: s.id, label: s.label }]));
        }
        renderGrid();
        renderCatBox();
        renderPreview();
      },
    });
    const tw = thumbUrl(s.thumb);
    if (tw) {
      const im = h("img", {
        src: tw, loading: "lazy", alt: s.label,
        style: { width: "100%", aspectRatio: "1/1", objectFit: "cover", display: "block" },
      });
      // 图挂了就换成兜底块（远端 URL / 文件被清理都会走这里）
      im.onerror = () => {
        try { im.replaceWith(fallbackThumb(s.label)); } catch (_) {}
      };
      card.appendChild(im);
    } else {
      card.appendChild(fallbackThumb(s.label));
    }
    card.appendChild(h("div", {
      style: {
        fontSize: 10.5, color: on ? "#bfe6ff" : "#dbe6f4", padding: "4px 6px",
        background: "rgba(0,0,0,.55)", whiteSpace: "nowrap", overflow: "hidden",
        textOverflow: "ellipsis", lineHeight: 1.35,
      },
    }, s.label));
    if (on) {
      card.appendChild(h("div", {
        style: {
          position: "absolute", top: 5, right: 5, width: 18, height: 18, borderRadius: 9,
          background: "#9ad6ff", color: "#04202c", fontSize: 12, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
        },
      }, "✓"));
    }
    return card;
  }

  // 当前应显示的条目（搜索跨全库，未搜索时只看当前分类）
  function currentList() {
    const kw = (searchInp && searchInp.value || "").trim().toLowerCase();
    if (kw) {
      return all.filter((s) =>
        String(s.name).toLowerCase().includes(kw)
        || String(s.name_cn || "").toLowerCase().includes(kw)
        || String(s.category).toLowerCase().includes(kw));
    }
    return curCat ? all.filter((s) => s.category === curCat) : all;
  }

  function renderGrid() {
    if (!listBox) return;
    clear(listBox);
    if (loading) { listBox.appendChild(h("div", { class: "muted", style: { padding: 14, fontSize: 11.5 } }, "加载风格库…")); return; }
    if (loadErr) {
      listBox.appendChild(h("div", { class: "muted", style: { padding: 14, fontSize: 11.5, color: "#ff9d9d" } },
        "风格库读取失败：" + loadErr));
      return;
    }
    const list = currentList();
    if (!list.length) {
      listBox.appendChild(h("div", { class: "muted", style: { padding: 14, fontSize: 11.5 } }, "没有匹配的风格"));
      return;
    }
    // 限流：先渲染 PAGE 条，滚到底续载（3946 条全渲染会卡死）
    const n = Math.min(list.length, Math.max(PAGE, shown));
    const grid = h("div", {
      style: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(96px,1fr))", gap: 8, padding: 4 },
    });
    for (let i = 0; i < n; i++) grid.appendChild(cardFor(list[i]));
    listBox.appendChild(grid);
    if (n < list.length) {
      const more = h("div", {
        class: "muted",
        style: { padding: "10px 4px", fontSize: 11, textAlign: "center", cursor: "pointer" },
        onclick: () => { shown += PAGE; renderGrid(); },
      }, `还有 ${list.length - n} 种 · 点这里继续加载（或缩小搜索范围）`);
      listBox.appendChild(more);
    }
    shown = n;
  }

  function renderCatBox() {
    if (!catBox) return;
    clear(catBox);
    const sel = get();
    const selCats = {};
    for (const x of sel) {
      const s = byId.get(x.id);
      if (s) selCats[s.category] = (selCats[s.category] || 0) + 1;
    }
    const mkRow = (key, label, count) => {
      const active = curCat === key;
      return h("div", {
        style: {
          padding: "6px 8px", borderRadius: 7, cursor: "pointer", fontSize: 11.5,
          display: "flex", alignItems: "center", gap: 6,
          background: active ? "linear-gradient(90deg,rgba(154,214,255,.20),rgba(154,214,255,.05))" : "transparent",
          color: active ? "#bfe6ff" : "#c9d6ec",
          border: active ? "1px solid rgba(154,214,255,.35)" : "1px solid transparent",
        },
        onclick: (ev) => {
          ev.stopPropagation();
          curCat = key;
          shown = 0;
          renderCatBox();
          renderGrid();
        },
      },
        h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label),
        selCats[key] ? h("span", { style: { fontSize: 10, color: "#9ad6ff", fontWeight: 700 } }, `✓${selCats[key]}`) : null,
        h("span", { class: "muted", style: { fontSize: 10 } }, String(count)),
      );
    };
    catBox.appendChild(mkRow("", "全部", all.length));
    for (const c of cats) catBox.appendChild(mkRow(c.key, c.label, c.count));
  }

  function renderPreview() {
    if (!previewBox) return;
    clear(previewBox);
    const sel = get();
    if (!sel.length) {
      previewBox.appendChild(h("div", { class: "muted", style: { fontSize: 10.5 } },
        "选一种风格后，这里显示套用后的完整提示词（后端正按这个送进 Krea2）"));
      return;
    }
    const base = (previewInp && previewInp.value || "").trim();
    const r = applyStylesLocal(base, objs());
    previewBox.appendChild(h("div", { class: "muted", style: { fontSize: 10.5, marginBottom: 3 } },
      `套用 ${sel.length} 种 · ${sel.map((x) => x.label).join(" + ")}${base ? "" : "（上面没填词，风格仍会生效）"}`));
    previewBox.appendChild(h("div", {
      style: {
        fontSize: 10.5, color: "#c9d6ec", lineHeight: 1.5, maxHeight: 76, overflowY: "auto",
        background: "rgba(6,12,22,.55)", border: "1px solid rgba(120,170,255,.16)",
        borderRadius: 7, padding: "6px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word",
      },
    }, r.positive || "（空）"));
  }

  async function reload() {
    loading = true;
    loadErr = "";
    renderGrid();
    try {
      const r = await ctx.api.assetgenStyles();
      // 严格校验类型：后端异常时可能回 null / 字符串，直接赋给 all 会让后续 .filter 崩
      // 或残留上一次的数据（实测踩过：styles="oops" 时仍渲染出旧卡片）
      const rawStyles = r && Array.isArray(r.styles) ? r.styles : [];
      all = rawStyles.filter((x) => x && typeof x === "object" && x.id);
      cats = (r && Array.isArray(r.categories)) ? r.categories.filter((c) => c && c.key) : [];
      rebuildIndex();
      loaded = true;
      if (r && r.error) loadErr = r.error;
      if (!curCat && cats.length) curCat = cats[0].key;
    } catch (e) {
      all = [];
      cats = [];
      loadErr = e.message || String(e);
      toast("风格库读取失败: " + loadErr, true);
    }
    loading = false;
    shown = 0;
    renderCatBox();
    renderGrid();
    renderPreview();
    return all.length;
  }

  function openPopup() {
    if (popup) { closePopup(); return; }
    if (_openClose) { try { _openClose(); } catch (_) {} }

    searchInp = h("input", {
      class: "input", type: "text", placeholder: "搜索风格名 / 中文名 / 分类（跨全部 3946 种）…",
      style: { flex: "1 1 auto", minWidth: 0, fontSize: 11.5, padding: "4px 8px" },
      oninput: () => { shown = 0; renderGrid(); },
    });
    cntLbl = h("span", { class: "muted", style: { fontSize: 10.5 } }, loaded ? `共 ${all.length} 种 · ${cats.length} 类` : "加载中…");

    catBox = h("div", {
      style: { width: 132, flex: "0 0 auto", overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, padding: 2 },
    });
    listBox = h("div", {
      style: { flex: "1 1 auto", minWidth: 0, overflowY: "auto", border: "1px solid rgba(120,170,255,.16)", borderRadius: 8, background: "rgba(6,12,22,.5)" },
    });

    previewInp = h("input", {
      class: "input", type: "text", placeholder: "写一句提示词，实时预览风格套用效果…",
      style: { flex: "1 1 auto", minWidth: 0, fontSize: 11.5, padding: "4px 8px" },
      oninput: () => renderPreview(),
    });
    previewBox = h("div", { style: { marginTop: 4 } });

    popup = h("div", {
      style: {
        position: "fixed", zIndex: 2147483000, padding: 10,
        background: "#101a2a", border: "1px solid #31446a", borderRadius: 12,
        boxShadow: "0 18px 60px rgba(0,0,0,.65)", display: "flex", flexDirection: "column", gap: 8,
        fontFamily: "ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
      },
      onclick: (ev) => ev.stopPropagation(),
    },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        h("b", { style: { fontSize: 12.5, color: "#9ad6ff" } }, "🎨 Krea2 风格扩展"),
        cntLbl,
        h("div", { style: { flex: "1 1 auto" } }),
        h("button", {
          class: "btn", style: { padding: "3px 8px", fontSize: 11 },
          title: "重新读取 styles 目录（在 Easy-Use/styles 里加了新 JSON 后点这里）",
          onclick: (ev) => { ev.stopPropagation(); reload(); },
        }, "↻ 刷新")),
      h("div", { style: { display: "flex", alignItems: "center", gap: 6 } }, searchInp),
      h("div", { style: { display: "flex", gap: 8, flex: "1 1 auto", minHeight: 0 } },
        catBox, listBox),
      h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
        h("span", { class: "muted", style: { fontSize: 10.5, flex: "0 0 auto" } }, "预览"), previewInp),
      previewBox,
      h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        h("span", { class: "muted", style: { fontSize: 10.5 } },
          "点一项即生效（可多选，最多 4 种）· 对 t2i/图生图/参考/编辑 四种模式都生效"),
        h("div", { style: { flex: "1 1 auto" } }),
        h("button", {
          class: "btn", style: { padding: "3px 8px", fontSize: 11, borderColor: "#a33" },
          onclick: (ev) => { ev.stopPropagation(); setSel([]); renderGrid(); renderCatBox(); renderPreview(); },
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

    renderCatBox();
    renderGrid();
    renderPreview();
    if (!loaded && !loading) reload();
  }

  // store 变化 → 按钮文案跟随（别处改了选择也要同步）
  store.subscribe(() => { try { paint(); } catch (_) {} });
  paint();

  return {
    row: chip,
    get,
    ids,
    set: setSel,
    reload,
    list: () => all.slice(),
    // 预览：套用当前选中风格后的提示词（前端复算，规则与后端一致）
    preview: (text) => applyStylesLocal(text, objs()),
    // 给「生图日志/回显」用：按 id 取中文名
    labels: () => get().map((x) => x.label),
  };
}
