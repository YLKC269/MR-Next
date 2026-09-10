// panels/assets.js — 素材库（浏览 / 上传 / 收藏入库 / 拖拽换位 / 收藏悬浮面板）
// v1.2 UI：kind tab + 缩略卡（hover 收藏按钮/删除勾选 + 拖拽换位）+ 灯箱预览 + 右上角悬浮「收藏入库」面板
import { h, clear } from "../core/dom.js";
import { viewUrl, relToViewUrl } from "../core/api.js";
import { lightbox, inlineRename, contextMenu, closeContextMenu } from "../core/ui.js";
import { assetRegistry } from "../core/assets.js";
import { assetDirRow, saveAssetHere, revealRel, startAssetWatch, CAT_CN } from "../core/asset_io.js";

const ORDER_LS_PREFIX = "mrnext.assets.order.v1."; // + `${folder}::${kind}`

function loadOrder(folder, kind) {
  try {
    const raw = localStorage.getItem(ORDER_LS_PREFIX + folder + "::" + kind);
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
function saveOrder(folder, kind, names) {
  try { localStorage.setItem(ORDER_LS_PREFIX + folder + "::" + kind, JSON.stringify(names || [])); } catch (_) {}
}
function applyCustomOrder(files, folder, kind) {
  if (!files || !files.length) return files;
  const custom = loadOrder(folder, kind);
  if (!custom.length) return files;
  const byName = new Map(files.map((f) => [f.name, f]));
  const out = [];
  for (const n of custom) { if (byName.has(n)) { out.push(byName.get(n)); byName.delete(n); } }
  for (const f of files) if (byName.has(f.name)) out.push(f);
  return out;
}
// 拖拽换位 → 立即把当前 visual 顺序存进 LS
function persistOrderFromFiles(files, folder, kind) {
  saveOrder(folder, kind, files.map((f) => f.name));
}

export function createAssetsPanel(ctx) {
  const toolbar = h("div", { class: "pstrip" });
  const grid = h("div", { class: "grid cols-auto", style: { gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))" } });
  const statusLbl = h("span", { class: "muted" });
  const folderIn = h("input", { class: "input", value: ctx.store.get().folder || "mrboard_next", placeholder: "资产文件夹", style: { width: 190, padding: "6px 10px" } });
  // 「📁 保存路径」一行：选本地导出目录 + 一键把该目录里的素材导回（导入即可被引用）
  const dirRow = assetDirRow(ctx, {
    onChanged: () => renderToolbar(),
    onImported: () => { refresh(); renderToolbar(); },
  });
  let curKind = "all";
  let files = [];
  // 勾选集合：同时服务于「批量删除」和「批量收藏」
  const selSet = new Set();

  // 收藏（选中）状态 — 右上角「⭐ 收藏到收藏库」按钮（toolbar 内）+ 弹出浮层（角色/场景/素材/音频四分类）
  // 浮层挂到 document.body（shadow 外拿不到 shadow CSS），所以全用内联样式 + position:fixed
  const CAT_OPTS = [
    { key: "role", label: "角色", icon: "🧑" },
    { key: "scene", label: "场景", icon: "🏞️" },
    { key: "asset", label: "素材", icon: "🗂️" },
    { key: "audio", label: "音频", icon: "🎵" },
  ];
  const favSel = h("div", {
    class: "as-favsel",
    style: {
      position: "fixed", zIndex: 120, width: 340, display: "none",
      background: "linear-gradient(160deg,rgba(34,52,88,.97),rgba(15,26,48,.99))",
      border: "1px solid rgba(245,202,87,.4)", borderRadius: 13, padding: 12,
      boxShadow: "0 12px 36px rgba(0,0,0,.55), 0 0 18px rgba(245,202,87,.18)",
    },
  });
  let favOpen = false;
  let curCat = "role";
  let curPick = null; // 点素材卡（非勾选）选中的单个素材
  const favBtn = h("button", { class: "btn", style: { padding: "6px 12px", fontWeight: 700 }, onclick: () => { renderFavBar(); toggleFav(); } }, "⭐ 收藏到收藏库");

  function mountFavPanel() {
    document.body.appendChild(favSel);
  }
  // 把浮层定位到「收藏到收藏库」按钮正下方、右对齐
  function positionFavSel() {
    const r = favBtn.getBoundingClientRect();
    if (!r || !r.width) return; // 按钮不可见（面板未激活）→ 下次点击时再定位
    favSel.style.top = (r.bottom + 6) + "px";
    favSel.style.right = (window.innerWidth - r.right) + "px";
  }
  // 当前要收藏的素材集合：优先「勾选集合」，否则「点卡片选中的单个」
  function selectedItems() {
    const folder = folderIn.value.trim();
    if (selSet.size) {
      return files.filter((f) => selSet.has(f.name)).map((f) => ({ name: f.name, rel: (folder ? folder + "/" : "") + f.name, kind: f.kind }));
    }
    return curPick ? [curPick] : [];
  }
  const renderFavBar = () => {
    clear(favSel);
    const items = selectedItems();
    const batch = items.length > 1;
    if (!batch && items.length === 1 && items[0].kind === "audio") curCat = "audio"; // 单个音频默认归「音频」类
    let nameIn = null;
    if (!batch) {
      nameIn = h("input", {
        placeholder: "收藏名称",
        value: items.length ? items[0].name.replace(/\.[^.]+$/, "") : "",
        style: { display: "block", width: "100%", boxSizing: "border-box", padding: "7px 10px", borderRadius: 8, border: "1px solid #3a4a66", background: "#0b1526", color: "#e9effa", fontSize: 12.5, marginBottom: 8 },
      });
    }
    const catRow = h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 } });
    for (const c of CAT_OPTS) {
      const on = curCat === c.key;
      catRow.appendChild(h("button", {
        onclick: () => { curCat = c.key; renderFavBar(); },
        style: {
          padding: "6px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: on ? 800 : 600,
          border: on ? "1px solid #f5ca57" : "1px solid #3a4a66",
          background: on ? "linear-gradient(180deg,#ffe9a8,#e0a83a)" : "rgba(255,255,255,.05)",
          color: on ? "#3a2503" : "#cdd8ea",
        },
      }, c.icon + " " + c.label));
    }
    const summary = batch
      ? `已选 ${items.length} 个素材，将以文件名作为收藏名`
      : (items.length ? `已选：${items[0].rel}` : "先勾选素材（或点素材卡）→ 选分类 → 加入收藏");
    const hint = h("div", { style: { fontSize: 11, color: "#7d92b4", marginTop: 8 } }, summary);
    const go = h("button", {
      onclick: async () => {
        const its = selectedItems();
        if (!its.length) { ctx.toast("先勾选素材或点素材卡选中", true); return; }
        const isBatch = its.length > 1;
        if (!isBatch && !(nameIn && nameIn.value.trim())) { ctx.toast("请填写收藏名称", true); return; }
        try {
          const catLabel = (CAT_OPTS.find((c) => c.key === curCat) || {}).label || curCat;
          // 机器文件名检测：纯数字/十六进制段组成（ComfyUI 原始输出名）——收藏了也无法按名匹配正文
          const _isMachine = (n) => {
            const stem = n.replace(/\.[^.]+$/, "").trim();
            const segs = stem.split("_").filter(Boolean);
            if (!segs.length) return true;
            return segs.every((s) => /^\d+$/.test(s) || /^[0-9a-fA-F]{6,}$/.test(s));
          };
          let ok = 0, skipped = 0;
          for (const it of its) {
            const rawName = isBatch ? it.name.replace(/\.[^.]+$/, "") : nameIn.value.trim();
            if (_isMachine(rawName)) { skipped++; continue; }
            await ctx.api.favoriteAdd([{ name: rawName, rel: it.rel, kind: it.kind, category: curCat }]);
            ok++;
          }
          ctx.toast(skipped ? `已收藏 ${ok} 个 → ${catLabel}（跳过 ${skipped} 个机器文件名，请手动命名）` : `已收藏 ${ok} 个 → ${catLabel}`);
          selSet.clear();
          curPick = null;
          toggleFav(false); // 收藏完成后自动关闭弹窗
          await refresh();  // 重建卡片，同步取消勾选态
          await assetRegistry.refresh(folderIn.value.trim()); // 收藏库已变 → 通知全面板 token 实时更新
          renderToolbar();
        } catch (e) { ctx.toast("收藏失败: " + e.message, true); }
      },
      style: { display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "8px 14px", borderRadius: 9, cursor: "pointer", fontSize: 12.5, fontWeight: 800, border: "1px solid rgba(216,174,66,.5)", background: "linear-gradient(180deg,#ffe9a8,#e0a83a)", color: "#3a2503" },
    }, batch ? `⭐ 加入收藏（${items.length}）` : "⭐ 加入收藏");
    const closeBtn = h("button", { title: "关闭", onclick: () => toggleFav(false), style: { background: "transparent", border: 0, color: "#a4b6d0", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0 } }, "×");
    const head = h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } },
      h("span", { style: { fontWeight: 800, fontSize: 12.5, color: "#ffcf6b" } }, batch ? `收藏到收藏库（${items.length}）` : "收藏到收藏库"),
      closeBtn);
    favSel.appendChild(head);
    if (nameIn) favSel.appendChild(nameIn);
    favSel.appendChild(catRow);
    favSel.appendChild(go);
    favSel.appendChild(hint);
  };
  renderFavBar();
  const toggleFav = (force) => {
    favOpen = (force == null) ? !favOpen : !!force;
    if (favOpen) { positionFavSel(); favSel.style.display = "block"; }
    else favSel.style.display = "none";
  };

  const refresh = async () => {
    clear(grid);
    const folder = folderIn.value.trim();
    ctx.store.patch("folder", folder);
    try {
      const res = await ctx.api.files(folder, curKind);
      // 服务端按文件名字母序分配 index；用 localStorage 里的自定义顺序覆盖，再按视觉位置重算 index
      // （这样 <Picture N> 之类的索引会跟着拖拽换位变化，对齐到用户实际想要的引用顺序）
      const allRaw = res.files || [];
      files = applyCustomOrder(allRaw, folder, curKind);
      const prefixMap = { image: "Picture", audio: "Audio", video: "Video" };
      // 同 kind 内：1-based 顺序索引
      const kindCounters = { image: 0, audio: 0, video: 0 };
      files.forEach((f) => { if (f && f.kind && prefixMap[f.kind] != null) { kindCounters[f.kind] += 1; f.index = kindCounters[f.kind]; } });
      statusLbl.textContent = `${files.length} 个文件${curKind !== "all" ? `（${curKind}）` : ""} · ${folder || "input 根"}`;
      if (!files.length) {
        grid.appendChild(h("div", { class: "empty" }, "该分类暂无素材 —— 上传 / 原生导入 或切换分类"));
        return;
      }
      for (const f of files) {
        const rel = (folder ? folder + "/" : "") + f.name;
        const url = viewUrl({ filename: f.name, subfolder: folder, type: "input" });
        const card = h("div", { class: "mcard" + (f.kind === "image" ? "" : f.kind === "audio" ? " audio" : ""), dataset: { rel, name: f.name, kind: f.kind, idx: String(f.index || 0) } });
        // 缩略图加载失败（源文件被删 / 脏引用）→ 隐藏破图，不留裂图占位
        if (f.kind === "image") card.appendChild(h("div", { class: "th" }, h("img", { src: url, alt: f.name, loading: "lazy", onerror: "this.style.display='none'" })));
        else if (f.kind === "video") card.appendChild(h("div", { class: "th" }, h("video", { src: url, muted: true, playsinline: true, preload: "metadata" })));
        else card.appendChild(h("div", { class: "th", style: { display: "flex", alignItems: "center", justifyContent: "center" } }, h("span", { style: { fontSize: 30 } }, "🎵")));
        card.appendChild(h("div", { class: "veil" }));
        card.appendChild(h("div", { class: "kd" }, f.kind));
        // 引用编号徽章：按 kind 前缀（Picture/Audio/Video），让用户一眼看到「这张图就是剧本里 <Picture N> 引用的那张」
        // 每个 kind 在分类内 1-based 编号（重排后客户端重算，确保拖拽换位后引用关系一致）
        if (f.index && prefixMap[f.kind]) {
          card.appendChild(h("div", {
            class: "ix",
            title: `剧本里可用 <${prefixMap[f.kind]} ${f.index}> 引用此素材`,
            style: { position: "absolute", top: 4, right: 4, padding: "2px 6px", borderRadius: 8, background: "rgba(2,4,9,.75)", color: "#ffcf6b", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, zIndex: 2, pointerEvents: "none" },
          }, `<${prefixMap[f.kind]} ${f.index}>`));
        }
        card.appendChild(h("div", { class: "mn", title: f.name }, f.name));
        const chk = h("input", { type: "checkbox", class: "ck", title: "勾选（可批量删除 / 批量收藏）", style: { position: "absolute", zIndex: 2 } });
        chk.checked = selSet.has(f.name);
        chk.onclick = (e) => { e.stopPropagation(); };
        chk.onchange = (e) => { e.stopPropagation(); if (chk.checked) selSet.add(f.name); else selSet.delete(f.name); card.classList.toggle("chk", chk.checked); statusLbl.textContent = selSet.size ? `已选 ${selSet.size} 个 · ${files.length} 个文件` : `${files.length} 个文件`; if (favOpen) renderFavBar(); };
        card.appendChild(chk);
        const favB = h("button", { class: "abtn", title: "收藏此素材", onclick: (e) => {
          e.stopPropagation();
          curPick = { name: f.name, rel, kind: f.kind };
          renderFavBar();
          if (!favOpen) toggleFav(true);
        } }, "★");
        // ✎ 就地改名（改磁盘文件名）→ 同步收藏库 + 全画面板标记/预览
        const renameB = h("button", { class: "abtn ren", title: "重命名这个素材（改磁盘文件名，收藏库与所有面板会同步刷新）", onclick: (e) => {
          e.stopPropagation();
          const nameEl = card.querySelector(".mn");
          inlineRename(nameEl, f.name.replace(/\.[^.]+$/, ""), (newStem) => doRenameFile(f, rel, newStem));
        } }, "✎");
        card.appendChild(h("div", { class: "act" }, favB, renameB));
        // 提示拖拽
        card.title = `${f.name}\n（拖拽可换位 · 勾选可批量删除/收藏 · 右键可保存到本地文件夹）`;
        card.onclick = () => { curPick = { name: f.name, rel, kind: f.kind }; renderFavBar(); if (f.kind !== "audio") lightbox(url, f.kind); };
        // 右键菜单：保存到本地文件夹（按分类）/ 在文件夹中显示 / 重命名 / 收藏 / 删除
        card.oncontextmenu = (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const fav = (assetRegistry.favs || []).find((x) => x.rel === rel);
          const cat = (fav && fav.category) || (f.kind === "audio" ? "audio" : "asset");
          contextMenu(ev.clientX, ev.clientY, [
            { icon: "⬇", label: "保存到本地文件夹（自动分类）", hint: CAT_CN[cat] || "素材",
              onClick: () => saveAssetHere(ctx, rel, "") },
            { icon: "📂", label: "在文件夹中显示", onClick: () => revealRel(ctx, rel) },
            { divider: true },
            { icon: "✎", label: "重命名文件", onClick: () => {
              const nameEl = card.querySelector(".mn");
              if (nameEl) nameEl.classList.add("editing");
              inlineRename(nameEl, f.name.replace(/\.[^.]+$/, ""), (v) => doRenameFile(f, rel, v));
            } },
            { icon: "★", label: fav ? "已在收藏库（改分类/名称）" : "收藏此素材", hint: fav ? (CAT_CN[fav.category] || fav.category) : "",
              onClick: () => { curPick = { name: f.name, rel, kind: f.kind }; renderFavBar(); if (!favOpen) toggleFav(true); } },
            { divider: true },
            { icon: "🗑", label: "删除这个文件", danger: true, onClick: async () => {
              if (!confirm(`删除素材文件「${f.name}」？（不可恢复）`)) return;
              try { const r = await ctx.api.deleteFiles(folderIn.value.trim(), [f.name]); ctx.toast(`已删除 ${r.count} 个`); selSet.delete(f.name); await assetRegistry.refresh(); refresh(); renderToolbar(); }
              catch (e) { ctx.toast("删除失败: " + e.message, true); }
            } },
          ]);
        };
        // 拖拽换位（pointer 模式，见 skill §2）：动 >6px 触发；排除 .abtn / .ck / input
        attachDragReorder(card, f);
        grid.appendChild(card);
      }
    } catch (e) { ctx.toast("列举失败: " + e.message, true); }
  };

  // ✎ 重命名素材文件（磁盘改名）→ 收藏库同步 + 全局注册表重映射 + 广播所有面板刷新标记/预览
  const doRenameFile = async (f, rel, newStem) => {
    const folder = folderIn.value.trim();
    const oldName = f.name;
    const ext = (oldName.match(/\.[^.]+$/) || [""])[0];
    try {
      const res = await ctx.api.rename(rel, newStem);
      if (!res || res.error || !res.ok) {
        ctx.toast("改名失败：" + ((res && res.error) || "未知错误"), true);
        await refresh();
        return;
      }
      const newName = res.filename || (String(res.name || newStem) + ext);
      if (res.renamed) {
        // 勾选集合 / 当前选中项按名字换键，避免改名后选中态与收藏弹窗内容对不上
        if (selSet.delete(oldName)) selSet.add(newName);
        if (curPick && curPick.name === oldName) curPick = { ...curPick, name: newName, rel: res.rel };
        // ① 参考绑定 rel 换新（<Picture N> / 公共前缀权威绑定不会失效）
        // ② localStorage 自定义顺序里的旧名换新（不会被甩到列表末尾）
        assetRegistry.remapAssets({ oldRel: rel, newRel: res.rel, oldName, newName });
        ctx.toast(`已重命名为「${res.name}」· 收藏库与全画面板已同步`);
      } else {
        ctx.toast("文件名没有变化");
      }
      await assetRegistry.broadcastChange(folder);   // 广播：所有面板 token / 素材区实时刷新
      await refresh();                               // 本面板重排（顺序与 <Picture N> 编号同步）
      if (favOpen) renderFavBar();
    } catch (e) {
      ctx.toast("改名失败: " + e.message, true);
      await refresh();
    }
  };

  // 指针拖拽换位：mcard 自身 pointerdown 起步，shadow root 阶段监听 move/up
  // 单次拖拽只跟一个 mcard；落点 mcard 命中就 array splice 换位 + 持久化到 LS
  let _drag = null; // { fromName, fromIdx, pid, started, ghost, overIdx }
  function attachDragReorder(card, f) {
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // 排除交互元素：.abtn(收藏)/.ck(删除勾)/input
      if (e.target && e.target.closest && e.target.closest(".abtn, .ck, input, button")) return;
      if (!files || !files.length) return;
      const fromIdx = files.indexOf(f);
      if (fromIdx < 0) return;
      // 阻止浏览器对 img/video 的原生 drag（默认 img 是 draggable 的，
      // 会让后续 pointermove 被画布层透明覆盖层截胡）
      if (e.target && (e.target.tagName === "IMG" || e.target.tagName === "VIDEO")) {
        try { e.target.setAttribute("draggable", "false"); } catch (_) {}
      }
      // 注意：不要 setPointerCapture —— ComfyUI 画布层有 `.h-full.w-full` 透明覆盖层，
      // setPointerCapture 会让所有 pointer 事件被它截走，elementFromPoint 也被它盖住 → 拖拽目标丢失
      // 改为：依赖 shadow root 上的 capture 阶段监听，所有 pointer 事件自然冒泡到那里
      _drag = { fromName: f.name, fromIdx, pid: e.pointerId, started: false, ghost: null, overIdx: -1, startX: e.clientX, startY: e.clientY };
      e.preventDefault();
    });
  }
  function _onDragMove(e) {
    if (!_drag) return;
    if (!_drag.started) {
      const dx = Math.abs(e.clientX - _drag.startX);
      const dy = Math.abs(e.clientY - _drag.startY);
      if (dx + dy < 6) return; // 未越过阈值
      _drag.started = true;
      // 生成 ghost 拖影
      const ghost = h("div", { class: "as-drag-ghost" }, _drag.fromName);
      document.body.appendChild(ghost);
      _drag.ghost = ghost;
      // 标记源
      const src = grid.querySelector(`.mcard[data-name="${CSS.escape(_drag.fromName)}"]`);
      if (src) src.classList.add("as-drag-src");
      // 全局光标 + 拦截 click
      document.body.style.cursor = "grabbing";
    }
    if (_drag.ghost) {
      _drag.ghost.style.left = (e.clientX + 12) + "px";
      _drag.ghost.style.top = (e.clientY + 12) + "px";
    }
    // 高亮目标：不能用 e.target（画布层透明覆盖或 mousedown capture 让 e.target 卡在源），
    // 也不能用 document.elementFromPoint（被画布覆盖层截胡）。
    // 改用 grid 自身 hit-test：遍历 mcard 的 bounding rect 看哪个被命中
    _drag.overIdx = -1;
    const mx = e.clientX, my = e.clientY;
    if (grid) {
      const mc = grid.querySelectorAll(".mcard");
      for (let i = 0; i < mc.length; i++) {
        const c = mc[i];
        if (!c.dataset || !c.dataset.name || c.dataset.name === _drag.fromName) continue;
        const r = c.getBoundingClientRect();
        if (mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) {
          const idx = files.findIndex((x) => x.name === c.dataset.name);
          if (idx >= 0) { _drag.overIdx = idx; break; }
        }
      }
    }
    grid.querySelectorAll(".mcard.as-drag-over").forEach((n) => n.classList.remove("as-drag-over"));
    if (_drag.overIdx >= 0) {
      const t = grid.querySelector(`.mcard[data-name="${CSS.escape(files[_drag.overIdx].name)}"]`);
      if (t) t.classList.add("as-drag-over");
    }
  }
  function _onDragUp(_e) {
    if (!_drag) return;
    const drag = _drag;
    _drag = null;
    document.body.style.cursor = "";
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    grid.querySelectorAll(".mcard.as-drag-src, .mcard.as-drag-over").forEach((n) => n.classList.remove("as-drag-src", "as-drag-over"));
    if (!drag.started) return; // 没真起拖 → 当作普通 click，不动顺序
    if (drag.overIdx < 0) return;
    // 换位（swap）：把源元素和 overIdx 处的元素互换位置
    const arr = files;
    const fromIdx = arr.findIndex((x) => x.name === drag.fromName);
    const targetName = files[drag.overIdx] && files[drag.overIdx].name;
    if (fromIdx < 0 || !targetName || fromIdx === drag.overIdx) return;
    const overIdx = arr.findIndex((x) => x.name === targetName);
    if (overIdx < 0) return;
    // 直接交换两个位置的内容
    const tmp = arr[fromIdx];
    arr[fromIdx] = arr[overIdx];
    arr[overIdx] = tmp;
    persistOrderFromFiles(arr, folderIn.value.trim(), curKind);
    // 同步全局资产注册表顺序（让 token 的 <Picture N> 引用预览与素材库面板顺序实时对齐）
    assetRegistry.refresh(folderIn.value.trim());
    // 抑制紧随的 click（避免触发 lightbox）
    const stopClick = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    grid.addEventListener("click", stopClick, true);
    setTimeout(() => { grid.removeEventListener("click", stopClick, true); }, 260);
    // 重新渲染（确保 index 徽章按视觉位置刷新）
    const toName = arr[overIdx] ? arr[overIdx].name : "?";
    renderToolbar();
    refresh();
    ctx.toast(`已换位：${drag.fromName} ↔ ${toName}`);
  }
  // 用 capture 阶段挂到 shadow root（或 window）—— Shadow DOM 内事件不逃出，要在同一 root 内监听
  // 工具栏 tabs + 动作
  const renderToolbar = () => {
    clear(toolbar);
    toolbar.append(
      folderIn,
      h("button", { class: "btn", style: { padding: "6px 10px", fontSize: 12 }, onclick: () => uploadIn.click() }, "⬆ 上传"),
      h("span", { class: "muted" }, "|"));
    for (const [k, lb] of [["all", "全部"], ["image", "图片"], ["video", "视频"], ["audio", "音频"]]) {
      const n = k === "all" ? files.length : files.filter((f) => f.kind === k).length;
      toolbar.appendChild(h("button", { class: "ptab" + (curKind === k ? " on" : ""), onclick: () => { curKind = k; renderToolbar(); refresh(); } }, lb, h("span", { class: "pc" }, String(n))));
    }
    toolbar.appendChild(h("div", { class: "mx-spacer" }));
    const delB = h("button", { class: "btn", style: { padding: "6px 10px", borderColor: "#a33", fontSize: 12 }, onclick: async () => {
      if (!selSet.size) { ctx.toast("先勾选要删除的素材", true); return; }
      if (!confirm(`确定删除素材文件夹中的 ${selSet.size} 个文件？（不可恢复）`)) return;
      try { const r = await ctx.api.deleteFiles(folderIn.value.trim(), [...selSet]); selSet.clear(); ctx.toast(`已删除 ${r.count} 个`); refresh(); renderToolbar(); }
      catch (e) { ctx.toast("删除失败: " + e.message, true); }
    } }, `🗑 删除${selSet.size ? `(${selSet.size})` : ""}`);
    toolbar.appendChild(delB);
    const selAllB = h("button", { class: "btn", style: { padding: "6px 10px", fontSize: 12 }, onclick: () => {
      const names = files.map((f) => f.name);
      if (selSet.size && names.every((n) => selSet.has(n))) { selSet.clear(); } else { names.forEach((n) => selSet.add(n)); }
      refresh(); renderToolbar();
    } }, "☑ 全选/取消");
    toolbar.appendChild(selAllB);
    const clearB = h("button", { class: "btn", style: { padding: "6px 10px", borderColor: "#a33", fontSize: 12 }, onclick: async () => {
      if (!files.length) { ctx.toast("素材库已空", true); return; }
      if (!confirm(`清空素材文件夹「${folderIn.value.trim()}」的全部媒体文件（图片+视频+音频）？（不可恢复）`)) return;
      try { const r = await ctx.api.clearFolder(folderIn.value.trim()); selSet.clear(); ctx.toast(`已清空 ${r.count} 个素材`); refresh(); renderToolbar(); }
      catch (e) { ctx.toast("清空失败: " + e.message, true); }
    } }, "🧹 清空");
    toolbar.appendChild(clearB);
    toolbar.appendChild(h("button", { class: "btn", style: { padding: "6px 10px", fontSize: 12 }, onclick: () => ctx.switchTo("favorites") }, "⭐ 收藏库"));
    toolbar.appendChild(favBtn);
    toolbar.appendChild(statusLbl);
  };

  const uploadIn = h("input", { type: "file", multiple: true, style: { display: "none" } });
  uploadIn.onchange = async () => {
    const folder = folderIn.value.trim();
    for (const f of uploadIn.files) { try { await ctx.api.upload(folder, f); } catch (e) { ctx.toast("上传失败: " + e.message, true); } }
    uploadIn.value = ""; refresh(); renderToolbar();
  };
  folderIn.oninput = refresh;
  folderIn.onchange = () => { renderToolbar(); refresh(); };

  // 把收藏浮层挂载到 body（脱离滚动容器），每次点击按钮时重新定位
  mountFavPanel();

  const el = h("div", { class: "col as-panel" }, toolbar, dirRow, grid);
  // 把 pointermove/up 监听挂到承载 grid 的 shadow root（事件不逃出 shadow，要就地监听）
  // 注意：面板可能被多次创建（如切走/切回），先移除旧 listener 防重入
  const _root = el.getRootNode();
  const _LISTEN_TARGET = (_root && _root !== document && _root.host) ? _root : window;
  _LISTEN_TARGET.addEventListener("pointermove", _onDragMove, true);
  _LISTEN_TARGET.addEventListener("pointerup", _onDragUp, true);
  _LISTEN_TARGET.addEventListener("pointercancel", _onDragUp, true);
  refresh(); renderToolbar();
  // 其它面板改过素材（收藏库改名 / 剪辑删素材 / 时间线出片）→ 本面板实时重扫，不切走也能看到
  assetRegistry.subscribe(() => { if (el.isConnected) refresh(); });
  // 本地删除/新增实时检测：定时重读（消失的素材会从列表里掉出去，缩略图缓存也被清）
  const stopWatch = startAssetWatch(ctx, () => { refresh(); renderToolbar(); }, { active: () => el.isConnected });
  return {
    el,
    update: () => { if (favOpen) positionFavSel(); dirRow.refreshDir && dirRow.refreshDir(); refresh(); renderToolbar(); },
    stop: () => { try { stopWatch(); } catch (_) {} closeContextMenu(); },
  };
}
