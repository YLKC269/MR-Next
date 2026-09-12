// core/editor_io.js — 「出片结果 → 剪辑面板」的单一实现（时间线 + 一键流水线共用）。
//
// 为什么要有这个模块：
//   以前时间线面板自己写了半套（拼完只 refreshPanel("editor")，既不切面板也不入轨），
//   而一键流水线**一套都没写**、日志里却写着"✅ 全部视频已自动导入到「剪辑」面板素材库"
//   → 用户看到的就是「全部导出没有生效」。两处行为必须一致，所以抽到这里。
//
// 语义（用户明确的两种导出方式，**都按分镜顺序**）：
//   · exportMode === "all"      全部导出 → 把所有分镜视频拼成**一整条**，只把这一条送进剪辑面板
//   · exportMode === "segments" 分段导出 → 每镜一条，**按分镜顺序逐段**送进剪辑面板
//
// 入轨通道：写 store.pendingEditorVideos（有序数组）→ 切到剪辑面板 →
//   剪辑面板 refreshMaterials 一次消费完、按数组顺序 addToTrack(v1)。
//   ⚠ 必须"一次写一整批"：逐条写单个 pendingEditorVideo 会各触发一次异步 refresh，
//     多段并发时入轨顺序不可控 → 成片顺序乱。

/**
 * @param {object} ctx  面板上下文（需要 ctx.api.composeEditor / ctx.store / ctx.switchTo / ctx.toast）
 * @param {object} o
 * @param {string[]} o.rels        已出片的视频 rel，**必须已按分镜顺序**排好
 * @param {string}  o.exportMode   "all" | "segments"
 * @param {string}  o.folder       资产文件夹（拼接产物落在 <folder>/video/）
 * @param {function} [o.log]       (text, color) => void 日志行
 * @returns {Promise<{mode:string, rels:string[], composed?:string}>}
 */
export async function exportVideosToEditor(ctx, o) {
  const rels = (o && o.rels ? o.rels : []).map((r) => String(r || "").trim()).filter(Boolean);
  const exportMode = (o && o.exportMode) === "segments" ? "segments" : "all";
  const folder = (o && o.folder) || "";
  const log = (o && typeof o.log === "function") ? o.log : () => {};

  if (!rels.length) {
    log("⚠ 没有可导出的视频（这些镜还没出片，或视频路径为空）", "#ffd98f");
    return { mode: exportMode, rels: [] };
  }

  // 一次性入队 → 切到剪辑面板（剪辑面板的 update() 就是 refreshMaterials，会消费这个队列）
  const queue = (arr, note) => {
    ctx.store.set({ pendingEditorVideos: arr, pendingEditorVideo: null });
    try { ctx.switchTo("editor"); } catch (_) { /* 切面板失败也得留队列，下次刷新会消费 */ }
    if (note) { try { ctx.toast(note); } catch (_) {} }
  };

  // ---- 分段导出：逐段按顺序入轨 ----
  if (exportMode !== "all") {
    log(`📦 分段导出：${rels.length} 段按分镜顺序送入剪辑面板`, "#9fd0ff");
    queue(rels, `已按分镜顺序导入 ${rels.length} 段到剪辑面板`);
    return { mode: "segments", rels };
  }

  // ---- 全部导出：不足 2 段没得拼 → 退化为逐段入轨并**明确说明**（不让用户以为"没生效"）----
  if (rels.length < 2) {
    log(`⚠ 全部导出需要 ≥2 段才能拼成一整条，本次只成功 ${rels.length} 段 → 按分段导入`, "#ffd98f");
    queue(rels, `只成功 ${rels.length} 段，已直接导入剪辑面板`);
    return { mode: "all-single", rels };
  }

  log(`🎬 全部导出：正在把 ${rels.length} 段按分镜顺序拼成一整条…`, "#ffd98f");
  try {
    const r = await ctx.api.composeEditor(folder, rels.map((rel) => ({ rel, in_: 0, out_: 0 })));
    if (r && r.ok && r.rel) {
      log(`✓ 已拼成一整条 → ${r.rel}${r.filename ? `（${r.filename}）` : ""}`, "#8ff0c0");
      queue([r.rel], `整条拼接完成（${rels.length} 段）→ 已导入剪辑面板`);
      return { mode: "all", rels: [r.rel], composed: r.rel };
    }
    log(`✗ 拼接失败：${(r && r.error) || "未知错误"} → 改为按分段导入`, "#ffb4b4");
    queue(rels, "拼接失败，已改为按分段导入");
    return { mode: "all-fallback", rels };
  } catch (e) {
    log(`✗ 拼接异常：${e.message} → 改为按分段导入`, "#ffb4b4");
    queue(rels, "拼接异常，已改为按分段导入");
    return { mode: "all-fallback", rels };
  }
}

/**
 * 单段视频直接送进剪辑面板（右键「✂️ 去剪辑」/ 灯箱 / 单镜出片）。
 * 与批量走同一条队列，避免维护两套通道。
 */
export function sendVideosToEditor(ctx, rels, note) {
  const list = (rels || []).map((r) => String(r || "").trim()).filter(Boolean);
  if (!list.length) return false;
  ctx.store.set({ pendingEditorVideos: list, pendingEditorVideo: null });
  try { ctx.switchTo("editor"); } catch (_) { /* 同上 */ }
  if (note) { try { ctx.toast(note); } catch (_) {} }
  return true;
}
