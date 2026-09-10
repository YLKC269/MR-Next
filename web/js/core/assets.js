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

// 可选：绑定全局 store（app.js 挂载时调用一次）。绑定后改名会自动重映射
// store.refMap 里每镜素材的 rel/name —— 否则素材改名后，时间线里那一镜的
// 参考图标记还指着旧路径（缩略图裂掉、出片时取不到图）。
let _store = null;
export function bindAssetStore(store) { _store = store; }

// 把 store.refMap[i] = [{name, rel, kind, category}] 里的旧 rel/name 换成新的
function remapStoreRefMap(oldRel, newRel, oldName, newName) {
  if (!_store) return 0;
  let st = null;
  try { st = _store.get(); } catch (_) { return 0; }
  const rm = st && st.refMap;
  if (!Array.isArray(rm)) return 0;
  let changed = 0;
  const next = rm.map((arr) => {
    if (!Array.isArray(arr)) return arr;
    return arr.map((it) => {
      if (!it || typeof it !== "object") return it;
      let o = it;
      if (oldRel && newRel && it.rel === oldRel) { o = { ...o, rel: newRel }; changed++; }
      if (oldName && newName && it.name === oldName) { o = { ...o, name: newName }; changed++; }
      return o;
    });
  });
  if (changed) { try { _store.set({ refMap: next }); } catch (_) {} }
  return changed;
}

// 把"作为素材名出现"的旧名替换成新名。
// 关键：先保护「包含旧名的其它素材名」（如旧名「林晚」、另有素材「林晚B」）——
// 不保护的话 林晚 → 林晚A 会把「林晚B」改成「林晚AB」。
function replaceAssetName(text, oldName, newName, guardNames) {
  let t = String(text == null ? "" : text);
  if (!t || !oldName || !newName || oldName === newName) return t;
  const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  const guards = [];
  for (const n of (guardNames || [])) {
    if (!n || n === oldName || !String(n).includes(oldName)) continue;
    const key = "\u0001MXG" + guards.length + "\u0001";
    t = t.replace(rx(n), key);
    guards.push([key, n]);
  }
  t = t.replace(rx(oldName), newName);
  for (const [k, n] of guards) t = t.split(k).join(n);   // 还原被保护的其它名字
  return t;
}

// store 里的正文（剧本 / 公共前缀 / 每镜正文）同步把旧名改成新名 ——
// 否则改名后正文里的"标记"会因为找不到同名素材而直接消失（用户会以为功能坏了）。
function remapStoreNames(oldName, newName) {
  if (!_store || !oldName || !newName || oldName === newName) return 0;
  let st = null;
  try { st = _store.get(); } catch (_) { return 0; }
  const guard = [];
  for (const f of (favs || [])) if (f && f.name && f.name !== oldName) guard.push(f.name);
  for (const f of (files || [])) {
    const s = String((f && f.name) || "").replace(/\.[^.]+$/, "");
    if (s && s !== oldName) guard.push(s);
  }
  let hits = 0;
  const fix = (v) => {
    const out = replaceAssetName(v, oldName, newName, guard);
    if (out !== (v == null ? "" : v)) hits++;
    return out;
  };
  const patch = {};
  const s1 = fix(st.script || "");
  if (s1 !== (st.script || "")) patch.script = s1;
  const p1 = fix(st.prefix || "");
  if (p1 !== (st.prefix || "")) patch.prefix = p1;
  if (Array.isArray(st.shots)) {
    let ch = false;
    const shots = st.shots.map((sh) => {
      if (!sh || typeof sh !== "object") return sh;
      let o = sh;
      const t2 = fix(sh.text || "");
      if (t2 !== (sh.text || "")) { o = { ...o, text: t2 }; ch = true; }
      const p2 = fix(o.prompt || "");
      if (p2 !== (o.prompt || "")) { o = { ...o, prompt: p2 }; ch = true; }
      return o;
    });
    if (ch) patch.shots = shots;
  }
  if (Object.keys(patch).length) { try { _store.set(patch); } catch (_) {} }
  return hits;
}

// 素材库自定义顺序（拖拽换位）—— 与 assets.js 共用同一份 localStorage 约定
const ORDER_LS_PREFIX = "mrnext.assets.order.v1."; // + `${folder}::${kind}`

// 改名后：把 localStorage 里保存的自定义顺序里的旧文件名替换成新文件名
// （不替换的话，重命名过的素材会掉到列表末尾，用户会觉得"顺序乱了"）
function remapOrderNames(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return 0;
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.indexOf(ORDER_LS_PREFIX) !== 0) continue;
      let arr = [];
      try { arr = JSON.parse(localStorage.getItem(k) || "[]"); } catch (_) { continue; }
      if (!Array.isArray(arr) || arr.indexOf(oldName) < 0) continue;
      const next = arr.map((x) => (x === oldName ? newName : x));
      localStorage.setItem(k, JSON.stringify(next));
      n++;
    }
  } catch (_) {}
  return n;
}

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
  // ---- 改名后的全局重映射（改名面板调用一次，所有面板的标记/预览随之刷新）----
  //   ① refs / tagBindings 里指向旧 rel 的绑定改到新 rel（否则 token 会取不到图）
  //   ② localStorage 自定义顺序里的旧文件名改到新文件名
  //   ③ 通知所有订阅者（各面板 mention editor 重渲染 token、网格重扫）
  remapAssets({ oldRel, newRel, oldName, newName } = {}) {
    const oR = String(oldRel || "").trim();
    const nR = String(newRel || "").trim();
    const oN = String(oldName || "").trim();
    const nN = String(newName || "").trim();
    let touched = 0;
    // ① 引用绑定 / 标签绑定里指向旧 rel 的改到新 rel（token 才能取到新文件）
    if (oR && nR && oR !== nR) {
      for (const k of Object.keys(refs)) {
        if (refs[k] === oR) { refs[k] = nR; touched++; }
      }
      for (const k of Object.keys(tagBindings)) {
        if (tagBindings[k] === oR) { tagBindings[k] = nR; touched++; }
      }
    }
    // ② 引用绑定的 key 换名（正文已被改写成新名，就得以新名为键才能命中）
    if (oN && nN && oN !== nN && refs[oN] != null) {
      refs[nN] = refs[oN];
      delete refs[oN];
      touched++;
    }
    // ③ localStorage 自定义顺序里的旧文件名换新（否则素材会掉到列表末尾）
    touched += remapOrderNames(oN, nN);
    // ④ store.refMap（每镜素材引用）换 rel/name
    touched += remapStoreRefMap(oR, nR, oN, nN);
    // ⑤ store 正文（剧本 / 公共前缀 / 每镜正文）里的旧名换新名 → 标记继续显示、缩略图跟着换
    touched += remapStoreNames(oN, nN);
    if (touched) subs.forEach((fn) => { try { fn(); } catch (_) {} });
    return touched;
  },
  // 改名/收藏/删除后统一走这一条：重读后端最新资产 → 广播给所有订阅面板
  async broadcastChange(f) {
    return refresh(f);
  },
  refresh,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
};
