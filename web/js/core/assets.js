// core/assets.js — 全局资产注册表（收藏库 + 素材库 + 引用绑定），实时缓存 + 订阅。
// 解决「素材引用标记实时显示名字/缩略图」与「公共前缀单向同步」的核心数据源：
//   - favs:  收藏库（name→rel/kind/category）
//   - files: 素材库（name→rel/kind/index）—— 顺序与「素材库」面板一致（含自定义拖拽顺序）
//   - refs:  引用绑定（name→rel），公共前缀面板（authoritative）写入，其余面板只读 → 单向同步
// 所有面板共用这一份，数据变化时 notify 订阅者重渲染 token。

import { StudioAPI } from "./api.js";
import { cleanAssets, isUsableRel } from "./purify.js";

let folder = "mrboard_next";
let favs = [];
let files = [];
let refs = {}; // name -> rel（公共前缀权威绑定）
let tagBindings = {}; // "<Picture N>" / "<Subject N>" / "<Audio N>" / "<Video N>" → rel（公共前缀手动指定图片绑定）
const subs = new Set();

// ---- 素材库自定义顺序（拖拽换位）—— 与 assets.js 共用同一份 localStorage 约定 ----
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
function persistOrderFromFiles(files, folder, kind) {
  saveOrder(folder, kind, files.map((f) => f.name));
}

// 按 kind 重算 1-based index（image/audio/video 各自独立编号），与素材库面板 <Picture N> 徽章一致
function reindexByKind(arr) {
  const prefixMap = { image: "Picture", audio: "Audio", video: "Video" };
  const counters = { image: 0, audio: 0, video: 0 };
  for (const f of arr) {
    if (f && f.kind && prefixMap[f.kind] != null) { counters[f.kind] += 1; f.index = counters[f.kind]; }
  }
  return arr;
}

async function refresh(f) {
  // 无参时优先读 store.folder（用户可能换过保存文件夹），避免素材库停留在旧 folder 的过期列表
  let f0 = f;
  if (!f0) {
    try { f0 = JSON.parse(localStorage.getItem("mrnext.store.v1") || "{}").folder || folder; }
    catch (_) { f0 = folder; }
  }
  folder = f0;
  try {
    const [fr, rr] = await Promise.all([
      StudioAPI.favorites(),
      StudioAPI.files(f0, "all"),
    ]);
    // 净化：剔除虚拟引用脏项（@image#1:xxx.png 之类，非磁盘真实文件）。
    // 不过滤的话它会被当成一个"素材"显示/绑定，用户看到的就是"莫名其妙的数字素材"。
    const rawFavs = (fr.items || []).filter((i) => i.name && i.rel);
    const droppedFavs = rawFavs.length - cleanAssets(rawFavs).length;
    favs = cleanAssets(rawFavs);
    // 素材库顺序：后端字母序 → 应用自定义拖拽顺序 → 按 kind 重算 index
    // 这样 token 的 <Picture N> 与「素材库」面板显示的徽章完全对齐
    const raw = (rr.files || rr.items || []).map((a) => ({ ...a, rel: a.rel || (f0 + "/" + a.name) }));
    const droppedFiles = raw.length - cleanAssets(raw).length;
    files = reindexByKind(applyCustomOrder(cleanAssets(raw), f0, "all"));
    if (droppedFavs || droppedFiles) {
      console.warn(`[MRBoardNext] 已过滤 ${droppedFiles} 个脏素材 / ${droppedFavs} 个脏收藏（虚拟引用 token）`);
    }
  } catch (e) { console.warn("[MRBoardNext] asset refresh failed, keep stale:", e); /* 保留旧值 */ }
  subs.forEach((fn) => { try { fn(); } catch (_) {} });
  return { favs, files };
}

export const assetRegistry = {
  get folder() { return folder; },
  get favs() { return favs; },
  get files() { return files; },
  get refs() { return refs; },
  get tagBindings() { return tagBindings; },
  favByName(name) { return favs.find((f) => f.name === name); },
  fileByIndex(kind, n) { const nn = Number(n); return files.find((f) => f.kind === kind && Number(f.index) === nn); },
  // 通过 tag 字符串（如 "<Picture 1>"）取绑定 rel（仅返回手动绑定，不回退到素材库）
  relOfTag(tagStr) {
    if (!tagStr) return "";
    return tagBindings[tagStr] || "";
  },
  // name 的最终 rel：优先公共前缀权威绑定，其次收藏库，最后素材库文件（按名去扩展名匹配）
  relOf(name) {
    if (refs[name] != null) return refs[name];
    const f = favs.find((x) => x.name === name && x.rel);
    if (f) return f.rel;
    const stem = (name || "").replace(/\.[^.]+$/, "");
    const a = files.find((x) => x && x.rel && (x.name === name || (x.name || "").replace(/\.[^.]+$/, "") === stem));
    return a ? a.rel : "";
  },
  // name 对应的 kind（收藏库优先，其次素材库文件）
  kindOf(name) {
    const f = favs.find((x) => x.name === name);
    if (f) return f.kind || "image";
    const stem = (name || "").replace(/\.[^.]+$/, "");
    const a = files.find((x) => x && (x.name === name || (x.name || "").replace(/\.[^.]+$/, "") === stem));
    return a ? (a.kind || "image") : "image";
  },
  // 写入引用绑定（仅公共前缀面板调用），并通知全面板重渲染
  setRef(name, rel) {
    if (!name) return false;
    // 拒收脏 rel（虚拟引用 token 不是真实文件，写进去只会污染后续出片）
    if (rel != null && !isUsableRel(rel)) {
      console.warn("[MRBoardNext] 已拒绝写入脏引用绑定:", rel);
      return false;
    }
    if (rel == null) delete refs[name]; else refs[name] = rel;
    subs.forEach((fn) => { try { fn(); } catch (_) {} });
    return true;
  },
  // 写入显性标签绑定（<Picture N>/<Subject N>/<Audio N>/<Video N> → rel），仅公共前缀面板调用
  setTagBinding(tagStr, rel) {
    if (!tagStr) return false;
    // 同上：虚拟引用 token 一律拒收（用户反馈「文生视频被 @image#1:xxx.png 污染」的根因之一）
    if (rel != null && !isUsableRel(rel)) {
      console.warn("[MRBoardNext] 已拒绝写入脏标签绑定:", tagStr, rel);
      return false;
    }
    if (rel == null) delete tagBindings[tagStr]; else tagBindings[tagStr] = rel;
    subs.forEach((fn) => { try { fn(); } catch (_) {} });
    return true;
  },
  clearTagBindings() {
    tagBindings = {};
    subs.forEach((fn) => { try { fn(); } catch (_) {} });
  },
  // 素材库自定义顺序（供 assets.js 拖拽换位复用同一套逻辑）
  applyCustomOrder,
  persistOrderFromFiles,
  refresh,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
};
