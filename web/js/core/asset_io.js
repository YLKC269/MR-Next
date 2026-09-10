// core/asset_io.js — 资产「保存路径 / 右键导出 / 本地删除检测」的共享实现
// 素材库与收藏库共用这一份，保证两个面板行为、文案、分类规则完全一致。
//
// 三个能力：
//   ① 选择本地保存路径（store.assetDir，跨面板/跨会话记住）
//   ② 把资产另存到该路径，并**按分类自动建子目录**（角色 / 场景 / 素材 / 音频）
//   ③ 本地删除/改名后实时感知：轮询 registry → 消失的 rel 自动清缩略图缓存与列表
import { h } from "./dom.js";
import { assetRegistry } from "./assets.js";

// 分类中文目录名（与后端 _ASSET_CAT_DIR 保持一致）
export const CAT_CN = { role: "角色", scene: "场景", asset: "素材", audio: "音频", image: "素材", video: "素材", other: "素材" };

export function assetDirOf(ctx) {
  try { return String((ctx.store.get() || {}).assetDir || "").trim(); } catch (_) { return ""; }
}

/** 选本地保存路径（系统文件夹对话框）——取消则不改动。 */
export async function pickAssetDir(ctx, { onDone } = {}) {
  try {
    const r = await ctx.api.nativePick({ kind: "folder", title: "选择资产保存文件夹（导出/备份用，可随时更换）" });
    if (r.cancel || !(r.paths || []).length) return "";
    const dir = String(r.paths[0] || "").trim();
    if (!dir) return "";
    ctx.store.set({ assetDir: dir });
    ctx.toast("保存路径已设为：" + dir);
    if (onDone) onDone(dir);
    return dir;
  } catch (e) {
    ctx.toast("选择路径失败: " + e.message, true);
    return "";
  }
}

/** 把某个 rel 的资产另存到保存路径（按分类子目录）。category 缺省时后端会自动判定。 */
export async function saveAssetHere(ctx, rel, category) {
  const dir = assetDirOf(ctx);
  if (!dir) { ctx.toast("先点「📁 保存路径」选一个本地文件夹", true); return null; }
  try {
    const r = await ctx.api.saveAsset({ rel, dir, category: category || "" });
    if (!r || !r.ok || r.error) { ctx.toast("保存失败：" + ((r && r.error) || "未知错误"), true); return null; }
    const cat = CAT_CN[r.category] || r.category || "素材";
    ctx.toast(r.existed ? `已存在（跳过重复保存）：${cat}/${r.path.split(/[\\/]/).pop()}`
                        : `已保存到「${cat}」：${r.path}`);
    return r;
  } catch (e) {
    ctx.toast("保存失败: " + e.message, true);
    return null;
  }
}

/** 在系统文件管理器里定位该文件（被删了就定位它的目录）。 */
export async function revealRel(ctx, rel) {
  if (!rel) return;
  try {
    const r = await ctx.api.reveal(rel.startsWith("OUTPUT:") ? { path: "" } : { rel });
    if (r && r.error) ctx.toast(r.error, true);
  } catch (e) { ctx.toast("打开失败: " + e.message, true); }
}

/** 批量校验收藏 rel 是否还在磁盘上 → 返回失效 rel 的 Set（用于卡片打标/一键清理）。 */
export async function missingOf(ctx, rels) {
  const list = [...new Set((rels || []).filter(Boolean))].slice(0, 400);
  if (!list.length) return new Set();
  try {
    const r = await ctx.api.mediaExists(list);
    return new Set(r && r.missing ? r.missing : []);
  } catch (_) {
    return new Set();
  }
}

/**
 * 顶部「保存路径」一行：📁 选择路径 / 显示当前路径 / ⬆ 从保存路径导入 / （可选）🧹 清理失效收藏。
 * @param opts.onChanged 选择路径后回调（面板重渲染用）
 * @param opts.onImported 导入完成后回调
 * @param opts.extra 额外按钮数组
 */
export function assetDirRow(ctx, opts = {}) {
  const lbl = h("span", { class: "muted", style: { fontSize: 11, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } });
  const sync = () => {
    const d = assetDirOf(ctx);
    lbl.textContent = d ? "→ " + d : "（未设置：右键资产「保存到本地文件夹」前需先选）";
    lbl.title = d || "";
    importB.disabled = !d;
  };
  const pickB = h("button", {
    class: "btn", style: { padding: "6px 11px" },
    title: "选择本机文件夹：右键资产可「保存到本地文件夹」，会自动按 角色/场景/素材/音频 分类建子目录",
    onclick: async () => { await pickAssetDir(ctx, { onDone: () => { sync(); opts.onChanged && opts.onChanged(); } }); },
  }, "📁 保存路径");
  const importB = h("button", {
    class: "btn", style: { padding: "6px 11px" },
    title: "把保存路径里的图片/音频/视频（含子目录）导入到当前资产文件夹，导入后即可被剧本/时间线识别引用",
    onclick: async () => {
      const dir = assetDirOf(ctx);
      if (!dir) { ctx.toast("先选择保存路径", true); return; }
      const folder = (ctx.store.get() || {}).folder || "mrboard_next";
      importB.disabled = true; importB.textContent = "导入中…";
      try {
        const r = await ctx.api.importFolder(dir, folder);
        const n = r.copied || 0;
        ctx.toast(n ? `已从保存路径导入 ${n} 个素材（重名的同大小文件会跳过）` : "没有新素材可导入");
        await assetRegistry.refresh(folder);
        opts.onImported && opts.onImported();
      } catch (e) {
        ctx.toast("导入失败: " + e.message, true);
      } finally {
        importB.disabled = false; importB.textContent = "⬆ 从保存路径导入";
      }
    },
  }, "⬆ 从保存路径导入");
  sync();
  const row = h("div", { class: "row", style: { gap: 6, flexWrap: "wrap" } }, pickB, lbl, importB, ...(opts.extra || []));
  row.refreshDir = sync;
  return row;
}

/**
 * 本地删除/改名实时检测：面板挂载期间定时重读资产列表。
 *   - 文件被外部删掉 → 列表里消失（registry.refresh 会顺带清掉它的缩略图缓存）
 *   - 回调让面板重渲染（缩略图/计数/标记同步更新）
 * document.hidden 时跳过，不打扰（省电/省请求）。
 */
export function startAssetWatch(ctx, onTick, { intervalMs = 4000, active } = {}) {
  let busy = false;
  const tick = async () => {
    if (busy || (typeof document !== "undefined" && document.hidden)) return;
    if (typeof active === "function" && !active()) return;   // 面板没挂载 → 不轮询（省请求）
    busy = true;
    try {
      await assetRegistry.refresh();
      if (onTick) onTick();
    } catch (_) {} finally { busy = false; }
  };
  const timer = setInterval(tick, intervalMs);
  return () => { try { clearInterval(timer); } catch (_) {} };
}
