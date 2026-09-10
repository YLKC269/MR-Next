// panels/favorites.js — 收藏库（语义资产注册表：名字 → 文件）
// v1.1 UI：分类计数 tab + 1:1 缩略卡（分类色边/渐变遮罩）+ hover 操作 + 灯箱预览
import { h, clear } from "../core/dom.js";
import { relToViewUrl } from "../core/api.js";
import { lightbox } from "../core/ui.js";
import { assetRegistry } from "../core/assets.js";

export function createFavoritesPanel(ctx) {
  const tabs = h("div", { class: "pstrip" });
  const grid = h("div", { class: "grid cols-auto", style: { gridTemplateColumns: "repeat(auto-fill,minmax(132px,1fr))" } });
  const headLbl = h("div", { class: "muted" });
  let items = [];
  let curCat = "all";
  let search = "";
  const delIds = new Set();

  const CATS = [
    { key: "all", label: "★ 全部" },
    { key: "role", label: "角色" },
    { key: "scene", label: "场景" },
    { key: "asset", label: "素材" },
    { key: "audio", label: "音频" },
  ];

  const renderTabs = () => {
    clear(tabs);
    const count = (k) => (k === "all" ? items.length : items.filter((i) => i.category === k).length);
    for (const c of CATS) {
      tabs.appendChild(h("button", {
        class: "ptab" + (curCat === c.key ? " on" : ""),
        onclick: () => { curCat = c.key; renderTabs(); renderGrid(); },
      }, c.label, h("span", { class: "pc" }, String(count(c.key)))));
    }
  };

  const renderGrid = () => {
    clear(grid);
    const q = search.trim().toLowerCase();
    const shown = items.filter((i) =>
      (curCat === "all" || i.category === curCat) &&
      (!q || i.name.toLowerCase().includes(q) || (i.rel || "").toLowerCase().includes(q)));
    if (!shown.length) {
      grid.appendChild(h("div", { class: "empty" }, items.length
        ? "没有匹配的收藏（换关键词 / 分类）"
        : "收藏库为空 —— 去「素材库」点素材卡收藏，或分镜里 @名 收藏"));
      return;
    }
    for (const it of shown) {
      const cls = "mcard " + (CAT_LABEL_CLS(it.category));
      const card = h("div", { class: cls, dataset: { id: it.id, rel: it.rel }, title: it.rel });
      const url = relToViewUrl(it.rel);
      if (it.kind === "image" && url) {
        // 缩略图加载失败（源文件被删 / 脏引用）→ 隐藏破图，不留裂图占位
        card.appendChild(h("div", { class: "th" }, h("img", { src: url, alt: it.name, loading: "lazy", decoding: "async", onerror: "this.style.display='none'" })));
      } else if (it.kind === "video" && url) {
        card.appendChild(h("div", { class: "th" }, h("video", { src: url, muted: true, playsinline: true, preload: "metadata" })));
      } else {
        card.appendChild(h("div", { class: "th", style: { display: "flex", alignItems: "center", justifyContent: "center" } }, h("span", { style: { fontSize: 30 } }, it.kind === "audio" ? "🎵" : "🗂")));
      }
      card.appendChild(h("div", { class: "veil" }));
      card.appendChild(h("div", { class: "kd" }, it.kind === "image" ? "图片" : it.kind === "video" ? "视频" : "音频"));
      card.appendChild(h("div", { class: "mn" }, it.name));
      const chk = h("input", { type: "checkbox", class: "ck", style: { position: "absolute", zIndex: 2 } });
      chk.checked = delIds.has(it.id);
      chk.onclick = (e) => { e.stopPropagation(); };
      chk.onchange = (e) => { e.stopPropagation(); if (chk.checked) delIds.add(it.id); else delIds.delete(it.id); card.classList.toggle("chk", chk.checked); delLbl.textContent = `已选 ${delIds.size}`; };
      card.appendChild(chk);
      const delB = h("button", { class: "abtn del", title: "移出收藏", onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`移出收藏「${it.name}」？`)) return;
        try { await ctx.api.favoriteRemove([{ rel: it.rel, category: it.category }]); ctx.toast("已移出收藏"); await load(); } catch (err) { ctx.toast("移除失败: " + err.message, true); }
      } }, "🗑");
      card.appendChild(h("div", { class: "act" }, delB));
      card.onclick = () => { if (url && it.kind !== "audio") lightbox(url, it.kind); else ctx.toast("音频素材：请到剪辑面板试听", true); };
      grid.appendChild(card);
    }
  };

  const load = async () => {
    try {
      await assetRegistry.refresh(); // 收藏库/素材库变化 → 全局注册表 → 全面板 token 实时更新
      items = assetRegistry.favs;
      headLbl.textContent = `共 ${items.length} 条收藏（名字 → 文件映射，供分镜按名称引用）`;
      renderTabs(); renderGrid();
    } catch (e) { ctx.toast("加载收藏失败: " + e.message, true); }
  };

  const delLbl = h("span", { class: "muted" });
  const selDelBtn = h("button", { class: "btn", style: { borderColor: "#a33" }, onclick: async () => {
    if (!delIds.size) { ctx.toast("先勾选要删除的收藏", true); return; }
    if (!confirm(`删除 ${delIds.size} 条收藏？`)) return;
    try { await ctx.api.favoriteRemove({ ids: [...delIds] }); delIds.clear(); delLbl.textContent = ""; ctx.toast("已删除选中收藏"); await load(); }
    catch (e) { ctx.toast("删除失败: " + e.message, true); }
  } }, "🗑 删除选中");
  const clearBtn = h("button", { class: "btn", style: { borderColor: "#a33" }, onclick: async () => {
    if (!items.length) { ctx.toast("收藏库已空", true); return; }
    if (!confirm(`清空全部 ${items.length} 条收藏？（不可恢复）`)) return;
    try { await ctx.api.favoriteRemove({ ids: items.map((i) => i.id) }); delIds.clear(); delLbl.textContent = ""; ctx.toast("已清空收藏库"); await load(); }
    catch (e) { ctx.toast("清空失败: " + e.message, true); }
  } }, "🧹 清空");

  const searchI = h("input", { class: "input", placeholder: "搜索收藏名 / 路径…", style: { width: 220, padding: "6px 10px" } });
  searchI.oninput = () => { search = searchI.value; renderGrid(); };
  const delAll = h("button", { class: "btn", style: { padding: "6px 12px" }, onclick: () => {
    const vis = [...grid.querySelectorAll(".mcard[data-id]")].map((el) => el.dataset.id);
    if (delIds.size && [...delIds].every((d) => vis.includes(d))) { delIds.clear(); } else { vis.forEach((d) => delIds.add(d)); }
    [...grid.querySelectorAll("input[type=checkbox]")].forEach((c) => { c.checked = delIds.has(c.closest(".mcard").dataset.id); c.closest(".mcard").classList.toggle("chk", c.checked); });
    delLbl.textContent = `已选 ${delIds.size}`;
  } }, "☑ 全选/取消");

  const el = h("div", { class: "col" },
    h("div", { class: "card", style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } }, tabs, h("div", { class: "mx-spacer" }), searchI),
    h("div", { class: "row" }, headLbl, h("div", { class: "mx-spacer" }), delAll, selDelBtn, clearBtn, delLbl,
      h("button", { class: "btn", style: { padding: "6px 12px" }, onclick: () => ctx.switchTo("assets") }, "去素材库添加")),
    grid);
  load();
  return { el, update: () => load() };
}

function CAT_LABEL_CLS(c) {
  return c === "role" ? "role" : c === "scene" ? "scene" : c === "asset" ? "asset" : c === "audio" ? "audio" : "";
}
