// panels/favorites.js — 收藏库（语义资产注册表：名字 → 文件）
// v1.1 UI：分类计数 tab + 1:1 缩略卡（分类色边/渐变遮罩）+ hover 操作 + 灯箱预览
import { h, clear } from "../core/dom.js";
import { relToViewUrl } from "../core/api.js";
import { lightbox, inlineRename } from "../core/ui.js";
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
      // ✎ 改收藏名（收藏名 = 剧本里引用的名字）。文件名与收藏名一致时会连磁盘文件一起改，
      //    改名后广播给全局注册表 → 所有面板的 <Picture N>/名字 token 与缩略图实时刷新。
      const renB = h("button", { class: "abtn ren", title: "改收藏名（收藏名就是剧本里引用的名字；文件名与它一致时会一并改磁盘文件）", onclick: (e) => {
        e.stopPropagation();
        const nameEl = card.querySelector(".mn");
        if (nameEl) nameEl.classList.add("editing");
        inlineRename(nameEl, it.name, (newName) => doRename(it, newName));
      } }, "✎");
      card.appendChild(h("div", { class: "act" }, delB, renB));
      card.onclick = () => { if (url && it.kind !== "audio") lightbox(url, it.kind); else ctx.toast("音频素材：请到剪辑面板试听", true); };
      grid.appendChild(card);
    }
  };

  const load = async (opts = {}) => {
    try {
      // 订阅回调里不要再触发 refresh（否则 refresh→notify→load→refresh 死循环）
      if (opts.refreshRegistry !== false) {
        await assetRegistry.refresh(); // 收藏库/素材库变化 → 全局注册表 → 全面板 token 实时更新
      }
      items = assetRegistry.favs;
      headLbl.textContent = `共 ${items.length} 条收藏（名字 → 文件映射，供分镜按名称引用）`;
      renderTabs(); renderGrid();
    } catch (e) { ctx.toast("加载收藏失败: " + e.message, true); }
  };

  // ✎ 改收藏名：同步磁盘文件（必要时）+ 全局重映射 + 广播所有面板
  const doRename = async (it, newName) => {
    // 收藏名 == 文件名主名时（生成设定图/流水线自动命名的常见情形），问一句要不要连磁盘一起改；
    // 两者本来就不同名 → 只改"语义名"，磁盘文件保持不动（避免误改用户的原始素材名）。
    const stem = String(it.rel || "").split("/").pop().replace(/\.[^.]+$/, "");
    const same = !!stem && stem === it.name;
    const renameFile = same
      ? confirm(`「${it.name}」的收藏名与文件名一致。\n\n确定 = 同时重命名磁盘文件（${stem} → ${newName}），保持一致\n取消 = 只改收藏里的名字，磁盘文件不动`)
      : false;
    try {
      const res = await ctx.api.favoriteRename({ id: it.id, rel: it.rel, name: newName, rename_file: renameFile });
      if (!res || !res.ok) {
        ctx.toast("改名失败：" + ((res && res.error) || "未知错误"), true);
        await load();
        return;
      }
      if (res.rel && res.rel !== it.rel) {
        // 文件也改名了：把指向旧 rel 的引用绑定 / 标签绑定 / store.refMap / 素材顺序一起换到新 rel / 新名
        assetRegistry.remapAssets({
          oldRel: it.rel, newRel: res.rel,
          oldName: it.name, newName: res.name,
        });
      }
      ctx.toast(res.renamedFile
        ? `已改名为「${res.name}」并同步磁盘文件（${res.updated || 1} 条收藏）`
        : `已改名为「${res.name}」（${res.updated || 1} 条收藏；磁盘文件未动）`);
      await assetRegistry.broadcastChange();          // 广播：全画面板标记/预览实时刷新
      await load({ refreshRegistry: false });         // 本面板重建（缩略图 URL 已变）
    } catch (e) {
      ctx.toast("改名失败: " + e.message, true);
      await load();
    }
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
  // 其它面板改过资产（素材库重命名 / 剪辑删素材）→ 本面板实时重扫（不再触发 registry 刷新，防死循环）
  assetRegistry.subscribe(() => { if (el.isConnected) load({ refreshRegistry: false }); });
  return { el, update: () => load() };
}

function CAT_LABEL_CLS(c) {
  return c === "role" ? "role" : c === "scene" ? "scene" : c === "asset" ? "asset" : c === "audio" ? "audio" : "";
}
