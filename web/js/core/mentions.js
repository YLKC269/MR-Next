// core/mentions.js — 素材提及编辑器（点 token 弹宫格 · 收藏库 + 素材库）。
// 把文本里出现的收藏名 / 显式引用标记 <Picture N> / <Audio N> / <Video N>
// 渲染成可点击 token：点 token 弹小菜单/宫格，按素材库预览图切换引用。
// 记录 chosen: name→rel（素材名）+ 显式标记的 N 替换（直接改 box.innerText）。
import { h, clear } from "./dom.js";
import { relToViewUrl } from "./api.js";
import { assetRegistry } from "./assets.js";
import { cleanAssets, isUsableRel, sanitizeText } from "./purify.js";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 把 tag 字符串 ("Picture"/"Audio"/"Video"/"Subject") 翻译成 kind ("image"/"audio"/"video")，
// 兼容大小写（正则用 i 标志，可能捕获到 <video 1> / <audio 1> / <subject 1> 小写）。
// <Subject N> 视为图片引用（H3 官方格式：<Subject 1>：名字 - 描述），前/后端统一走 image kind。
const TAG_TO_KIND = {
  Picture: "image", Audio: "audio", Video: "video", Subject: "image",
  picture: "image", audio: "audio", video: "video", subject: "image",
};
const KIND_TO_TAG = { image: "Picture", audio: "Audio", video: "Video" };
const TAG_GLYPH = { Picture: "▣", Audio: "♪", Video: "▶", Subject: "◉" };
const KIND_GLYPH = { image: "▣", audio: "♪", video: "▶" };
const KIND_LABEL = { image: "图", audio: "音", video: "视" };
const KIND_NAME_CN = { image: "图片", audio: "音频", video: "视频" };
function normTag(tag) { const s = String(tag || "Picture"); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

// 跨面板同步钩子：公共前缀 / 剧本修改后通知所有 panel 的 mention editor 刷新
const _onFavsChange = [];
export function onFavsChange(fn) { _onFavsChange.push(fn); }
export function notifyFavsChange() {
  const subs = [..._onFavsChange];
  for (const fn of subs) try { fn(); } catch (_) {}
}

let _gstyle = false;
function ensureGlobalStyle() {
  if (_gstyle || typeof document === "undefined") return;
  _gstyle = true;
  const s = document.createElement("style");
  s.textContent = `
/* ---- @ 弹出的候选菜单（缩略图 44×44，参考旧包 bd-mention-menu 间距）---- */
.mm-pop{position:fixed;z-index:2147483600;width:280px;max-width:340px;max-height:340px;overflow:auto;background:linear-gradient(180deg,#1a2742,#0e1830);border:1px solid #3a4f78;border-radius:10px;padding:4px 0;box-shadow:0 12px 30px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.06);}
.mm-pop .mmg-title{padding:7px 12px 5px;font-size:12px;color:#9fb8dd;letter-spacing:.3px;user-select:none;border-bottom:1px solid rgba(120,170,255,.16);margin-bottom:4px;}
.mm-item{display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;color:#dbe6f4;font-size:13px;border-radius:0;transition:background .12s;}
.mm-item:hover,.mm-item.active{background:rgba(58,86,138,.32);color:#fff;}
.mm-item img,.mm-item .mm-ph{width:44px;height:44px;object-fit:cover;border-radius:7px;background:#0c1426;border:1px solid #2a3a58;box-sizing:border-box;flex-shrink:0;}
.mm-item .mm-ph{display:inline-flex;align-items:center;justify-content:center;font-size:18px;line-height:1;color:#9ad;background:#1a2a48;border-color:#3a568a;}
.mm-item .mm-ph.mm-ph-video{color:#7db7ff;background:#152030;border-color:#2a4a6a;}
.mm-item .mm-ph.mm-ph-audio{color:#e0b06a;background:#2a2010;border-color:#5a4530;}
.mm-item .mm-ph.mm-ph-image{color:#9ad;background:#1a2a48;border-color:#3a568a;}
.mm-item .mm-lb{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;}
.mm-item .mm-lb b{color:#ffe9a8;font-weight:600;}
.mm-item .mm-tag{font-size:11px;color:#9fb0c6;font-family:ui-monospace,Consolas,monospace;background:rgba(0,0,0,.32);padding:1px 6px;border-radius:4px;flex:0 0 auto;}
.mm-item-empty{padding:14px 16px;font-size:12px;color:#9fb8dd;text-align:center;line-height:1.6;}

/* ---- 宫格预览（点 <Picture N> / <Audio N> / <Video N> / <Subject N> token 时弹出）---- */
.mm-gallery{position:fixed;z-index:2147483600;background:linear-gradient(180deg,#16213a,#0e1626);border:1px solid #4a6b9a;border-radius:13px;
  padding:14px;box-shadow:0 20px 60px rgba(0,0,0,.75),inset 0 1px 0 rgba(255,255,255,.08);display:flex;flex-direction:column;gap:10px;max-width:92vw;max-height:90vh;min-width:520px;}
.mm-gallery .mmg-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;color:#ffcf6b;font-size:13px;font-weight:700;padding-bottom:8px;border-bottom:1px solid rgba(120,170,255,.18);}
.mm-gallery .mmg-hd .mmg-sub{color:#9fb0c6;font-size:11.5px;font-weight:400;}
.mm-gallery .mmg-close{cursor:pointer;padding:3px 10px;border:1px solid #3a568a;border-radius:7px;color:#9fb0c6;font-size:12px;transition:all .12s;}
.mm-gallery .mmg-close:hover{background:#20304a;color:#fff;border-color:#ffd98f;}
.mm-gallery .mmg-grp{display:flex;flex-direction:column;gap:8px;}
.mm-gallery .mmg-grp-hd{color:#9fb0c6;font-size:11.5px;font-weight:600;letter-spacing:.5px;display:flex;align-items:center;gap:6px;text-transform:uppercase;}
.mm-gallery .mmg-grp-hd .mmg-cnt{color:#ffcf6b;font-weight:700;}
.mm-gallery .mmg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;overflow:auto;max-height:62vh;padding:2px;}
.mm-gallery .mmg-card{position:relative;display:flex;flex-direction:column;border:1.5px solid #2a3a58;border-radius:10px;
  padding:6px;background:linear-gradient(180deg,#101a2a,#0a1322);cursor:pointer;transition:all .14s;overflow:hidden;}
.mm-gallery .mmg-card:hover{border-color:#ffd98f;transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.5);}
.mm-gallery .mmg-card.mmg-current{border-color:#8ff0c0;box-shadow:0 0 0 2px rgba(143,240,192,.25),0 4px 12px rgba(143,240,192,.15);}
.mm-gallery .mmg-card img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:7px;background:#000;display:block;}
.mm-gallery .mmg-card .mmg-noimg{width:100%;aspect-ratio:1/1;border-radius:7px;background:linear-gradient(180deg,#1a2540,#101828);display:flex;align-items:center;justify-content:center;color:#9fb0c6;font-size:32px;border:1px dashed #2a3a58;}
.mm-gallery .mmg-card .mmg-cap{font-size:11.5px;color:#dbe6f4;margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;}
.mm-gallery .mmg-card .mmg-tag{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.78);color:#ffd98f;font-size:10.5px;
  font-weight:700;padding:2px 7px;border-radius:5px;border:1px solid rgba(255,209,102,.45);font-family:ui-monospace,Consolas,monospace;}
.mm-gallery .mmg-empty{color:#9fb0c6;font-size:11.5px;padding:12px 6px;line-height:1.6;text-align:center;}
`;
  (document.head || document.documentElement).appendChild(s);
}

export function createMentionEditor(ctx, { initial = "", favorites = [], assets = [], chosen = {}, onCommit, onChoose, getAssets, authoritative = false } = {}) {
  const box = h("div", { class: "mention-ed", contenteditable: "true", spellcheck: "false" });
  // 解析素材：函数 > 数组 > 全局注册表（assetRegistry 实时缓存收藏库+素材库）。
  // 这样所有面板的 token 都实时从最新资产解析名字/缩略图，且公共前缀的权威绑定能同步到其它面板。
  let _favs = () => (favorites && favorites.length) ? favorites : assetRegistry.favs;
  let _getAssets = () => {
    if (typeof getAssets === "function") {
      try { const a = getAssets(); if (a && a.length) return a; } catch (_) {}
    }
    if (assets && assets.length) return assets;
    return assetRegistry.files;
  };
  box.getFavs = () => _favs();
  box.setFavs = (arr) => { _favs = () => (arr || []); box.rerender && box.rerender(); };
  box.getAssets = _getAssets;
  box.setAssets = (getter) => { if (typeof getter === "function") { _getAssets = getter; box.rerender && box.rerender(); } };
  box.addEventListener("paste", (e) => {
    e.preventDefault();
    e.stopPropagation(); // 防止 ComfyUI 画布把粘贴当 workflow，避免多出节点
    const cd = e.clipboardData || window.clipboardData;
    // 剪贴板里带图片文件时，ComfyUI 新版前端的富文本层会插入「虚拟引用 token」
    // （@image#1:xxx.png）。它不是磁盘文件，混进提示词就是"污染"。这里直接不放行图片，
    // 只接收纯文本，并且把文本里可能已存在的虚拟引用 token 一并剥掉。
    const t = sanitizeText(cd.getData("text/plain") || "");
    if (!t) return;
    document.execCommand("insertText", false, t);
  });
  // 拖放图片同理：一律不放行（避免浏览器把图片塞成 token/HTML），只允许拖入纯文本
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const t = sanitizeText((e.dataTransfer && e.dataTransfer.getData("text/plain")) || "");
    if (t) document.execCommand("insertText", false, t);
  });
  // 排序候选：按名长度降序（长名优先），只保留非空（每次 render 读取最新）
  function names() { return _favs().map((f) => f.name).filter(Boolean); }
  function unique() {
    const arr = names();
    return [...new Set(arr)].sort((a, b) => b.length - a.length);
  }

  function relOf(name) {
    const key = name;
    if (chosen[key] != null) return chosen[key];
    return assetRegistry.relOf(name); // 优先公共前缀权威绑定，其次收藏库
  }
  // 机器文件名检测（ComfyUI 输出名如 1788963615883_82a78583_00001_.png）→ 显示层美化用
  function isMachineName(n) {
    const stem = String(n || "").replace(/\.[^.]+$/, "").trim();
    const segs = stem.split("_").filter(Boolean);
    if (!segs.length) return false;
    return segs.every((s) => /^\d+$/.test(s) || /^[0-9a-fA-F]{6,}$/.test(s));
  }
  function tokenHTML(name, rel) {
    const url = rel ? relToViewUrl(rel) : "";
    const kind = assetRegistry.kindOf(name); // 收藏库/素材库实时解析 kind
    const glyph = KIND_GLYPH[kind] || "▣";
    // 缩略图加载失败（素材被删 / 虚拟引用脏项）→ 隐藏破图 + 降级为类型图标，绝不留裂图占位
    const img = url
      ? `<img class="mtdot" src="${esc(url)}" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<span class=&quot;mtglyph&quot;>${glyph}</span>')">`
      : `<span class="mtglyph">${glyph}</span>`;
    // 机器文件名 → 显示去扩展名的短名（title 保留原名），避免正文里一长串数字
    const shown = isMachineName(name) ? (String(name).replace(/\.[^.]+$/, "").slice(0, 18) + "…") : name;
    return `<span class="mtok mtok-${esc(kind)}" data-name="${esc(name)}" title="${esc(name)}">${img}<span class="mtxt">${esc(shown)}</span></span>`;
  }
  // 显式引用标记 <Picture N> / <Audio N> / <Video N> / <Subject N> → 突出引用 token。
  // 解析优先级：
  //   ① 手动绑定 tagBindings["<Audio N>"]（用户在宫格里明确选了哪个文件）—— **所有 tag 都认**，
  //      不能只认 Subject，否则「点了宫格选了 A，chip 还显示素材库第 N 个 B」（用户实报不会变）。
  //   ② 素材库第 N 个（fileByIndex）：官方参考槽按编号，这是默认语义。
  //   ③ 都没有 → 抽象 glyph + 「音N」。
  function tagTokenHTML(tag, n) {
    const t = normTag(tag); // 规范化（<video 1> → Video，<subject 1> → Subject）
    const kind = TAG_TO_KIND[t] || "image";
    const glyph = TAG_GLYPH[t] || KIND_GLYPH[kind] || "▣";
    const label = KIND_LABEL[kind];
    let f = null;
    // ① 手动绑定优先（宫格里选过就按绑定显示）
    const boundRel = assetRegistry.relOfTag(`<${t} ${n}>`);
    if (boundRel) {
      const fromFav = assetRegistry.favs.find((x) => x.rel === boundRel);
      const fromFile = assetRegistry.files.find((x) => x.rel === boundRel);
      const nm = (fromFav && fromFav.name) || (fromFile && fromFile.name) || boundRel.split("/").pop();
      f = { kind, index: n, rel: boundRel, fileName: nm, name: nm };
    }
    // ② 回退：素材库第 N 个
    if (!f) f = assetRegistry.fileByIndex(kind, n);
    if (f && f.rel) {
      // image 显示缩略图；audio/video 显示图标（避免 img 加载非图片文件 broken）
      const showImg = kind === "image";
      const url = showImg ? relToViewUrl(f.rel) : "";
      const img = (showImg && url) ? `<img class="mtdot" src="${esc(url)}">` : `<span class="mtglyph">${glyph}</span>`;
      return `<span class="mtok mtok-${kind}" data-tag="${t}" data-n="${n}"><span class="mtdotwrap">${img}</span><span class="mtxt">${esc(f.name || (label + n))}</span></span>`;
    }
    return `<span class="mtok mtok-${kind}" data-tag="${t}" data-n="${n}"><span class="mtglyph">${glyph}</span><span class="mtxt">${label}${n}</span></span>`;
  }

  // force=true：**程序化**改文本后强制重渲染。
  // 为什么需要它：点 chip 时 box 会拿到焦点 → activeElement === box →
  // 下面的「编辑中不重渲染」守卫会把 render() 直接 return 掉，
  // 于是 replaceFirstTag/box.set 改了 lastPlain、toast 也报了成功，
  // 但 DOM 里的 chip 还是旧素材名（用户实报「点击标记替换配音标记不会变」）。
  // 守卫的本意只是「别打断用户正在打字」，不该拦「我们自己刚改完、必须刷新」的场景。
  function render(force) {
    if (!force && document.activeElement === box) {
      // 正在编辑时保留输入，不重渲染
      return;
    }
    // 渲染源：优先用 lastPlain（真相，包含 <Picture N> 原始尖括号），render 后 innerText 会被
    // mtok 改造（丢尖括号），那再读取就只能拿"图N"。所以 commit()/replaceFirstTag 都用 lastPlain。
    const src = (typeof lastPlain === "string" && lastPlain) || (box.innerText != null ? box.innerText : initial);
    let html = esc(src);
    // \n → <br>：innerHTML 里的字面 \n 只是 HTML 空白（white-space:normal 下折叠），
    // 读回 innerText 时换行全丢 → 后端行首分镜标记 ^【分镜N】全部失配 → 0 分镜。
    // 显式转 <br> 让 DOM 永远保有换行结构，innerText 读回必然带 \n（不依赖 CSS pre-wrap）。
    html = html.replace(/\n/g, "<br>");
    // ⚠ 渲染必须「先占位、最后统一还原」，不能边扫边插 HTML：
    //   ① 显式标记那趟会把 <Picture 1> 换成带 mtxt 的 chip HTML；
    //   ② 素材名那趟接着扫全文，就会在**刚生成的 chip 文本里**再包一层 token
    //   → 两层 chip 叠在一起（用户实报："标记容易叠一起看不清"）。
    //   两个素材名互为子串（"云妙衣" vs "云妙衣三视图"）同理。占位符可彻底避免。
    const holders = [];
    const hold = (hstr) => { holders.push(hstr); return "\u0001H" + (holders.length - 1) + "\u0001"; };
    // ① 显式引用标记：<Picture N> / <Audio N> / <Video N> / <Subject N>（esc 后 < 变 &lt;）
    html = html.replace(/&lt;(Picture|Audio|Video|Subject)\s+(\d+)\s*&gt;/gi, (m, tag, n) => hold(tagTokenHTML(tag, n)));
    // ② 素材名自动命中：文本里出现收藏名/素材名 → 突出引用标记（长名优先，短的不会吃掉长名的一段）
    const _names = unique().filter(Boolean).sort((a, b) => b.length - a.length);
    for (const name of _names) {
      const re = new RegExp(esc(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      html = html.replace(re, () => hold(tokenHTML(name, relOf(name))));
    }
    // ③ 统一还原占位符（这一步之后才允许写进 DOM）
    html = html.replace(/\u0001H(\d+)\u0001/g, (m, i) => holders[Number(i)] || "");
    box.innerHTML = html || "";
  }
  // 纯文本真相：commit/replaceFirstTag/box.value 都用它（render 会把 <Picture N> 转成 mtok，innerText 丢尖括号）。
  let lastPlain = initial || "";
  function commit() {
    const text = lastPlain || box.innerText || "";
    if (typeof onCommit === "function") onCommit(text);
  }
  // 重新渲染外部调用（如切换收藏后）
  box.rerender = render;
  box.value = () => lastPlain || box.innerText || "";
  // set() 也触发 commit：程序化写入 = 完整更新（含 store 回写）。
  // 此前只改 DOM 不 commit → store.script 仍为旧值 → 任何 store.set 触发
  // script.js 的 subscribe → ta.set(st.script) 把刚粘贴的剧本清空（n0=0 血案）。
  box.set = (t) => { lastPlain = t || ""; box.innerText = lastPlain; render(true); commit(); };

  // blur 必须 commit lastPlain（防止用户在框里改完没触发任何 store 监听）
  box.addEventListener("blur", commit);
  box.addEventListener("click", (ev) => {
    const tok = ev.target && ev.target.closest ? ev.target.closest(".mtok") : null;
    if (!tok) return;
    const name = tok.dataset.name;
    const tag = tok.dataset.tag;
    if (tag) openTagPicker(tok, tag, parseInt(tok.dataset.n, 10) || 1, { authoritative });
    else openPicker(tok, name);
  });
  // 键入同步 lastPlain（render 改造后 innerText 会丢 <Picture N> 的尖括号，
  // 故 lastPlain 是唯一真相）。注意：activeElement === box 时 render 跳过，
  // 此时 box.innerText 仍含 <Picture N> 字面字符串 → 直接同步即可。
  box.addEventListener("input", () => { lastPlain = box.innerText || ""; });

  // ---- @ 输入补全：输入 @ 后弹候选（素材名 / 显式标记），选中插入 ----
  let mentionMenu = null;
  const closeMentionMenu = () => { if (mentionMenu) { mentionMenu.remove(); mentionMenu = null; } };
  const showMentionMenu = (filter) => {
    ensureGlobalStyle();
    closeMentionMenu();
    const kw = (filter || "").toLowerCase();
    // 候选 = 收藏库 + 素材库（去扩展名 + 去重 + 长名优先），实时缩略图/图标
    // 净化：剔除虚拟引用脏项（@image#1:xxx.png 之类不是磁盘真实文件），
    // 否则 @ 菜单里会冒出莫名其妙的"数字素材"，点了还会把脏 rel 写进正文。
    const favItems = cleanAssets(_favs() || []).filter((f) => f.name && f.rel);
    const fileItems = cleanAssets(assetRegistry.files || []).filter((f) => f && f.name && f.rel);
    const favCands = favItems.map((f) => {
        const k = f.kind || assetRegistry.kindOf(f.name) || "image";
        const u = relToViewUrl(f.rel);
        return { name: f.name, kind: k, rel: f.rel, from: "fav", thumb: (k === "image" && u) ? u : "" };
      }).sort((a, b) => b.name.length - a.name.length);
    const favSet = new Set(favItems.map((f) => f.name));
    const fileCands = fileItems.map((f) => {
        const stem = (f.name || "").replace(/\.[^.]+$/, "");
        const k = f.kind || "image";
        const u = relToViewUrl(f.rel);
        return { name: stem || f.name, kind: k, rel: f.rel, from: "files", thumb: (k === "image" && u) ? u : "", original: f.name };
      })
      .filter((c) => !favSet.has(c.name) && !favSet.has(c.original))
      .sort((a, b) => b.name.length - a.name.length);
    const tagCands = [
      ["图", "Picture"], ["音", "Audio"], ["视", "Video"], ["主体", "Subject"],
    ].filter(([lb]) => !kw || lb.includes(kw) || lb.toLowerCase().includes(kw));
    const allCands = [...favCands, ...fileCands];
    const filtAll = allCands.filter((c) => !kw || c.name.toLowerCase().includes(kw));
    if (!filtAll.length && !tagCands.length) return;
    mentionMenu = h("div", { class: "mm-pop" });
    // 顶部标题
    mentionMenu.appendChild(h("div", { class: "mmg-title" }, "📦 素材库 / 收藏库 · 点选插入引用"));
    // 显式引用标记候选（独立分组）
    for (const [lb, tag] of tagCands) {
      const tagKind = TAG_TO_KIND[tag] || "image";
      const it = h("div", { class: "mm-item", onclick: () => {
        insertMention(`<${tag} 1>`);
        closeMentionMenu();
      } },
        h("span", { class: `mm-ph mm-ph-${tagKind}` }, TAG_GLYPH[tag] || KIND_GLYPH[tagKind] || "▣"),
        h("div", { class: "mm-lb" }, h("b", {}, lb), ` 插入 <${tag} 1>`),
        h("span", { class: "mm-tag" }, `<${tag} 1>`));
      mentionMenu.appendChild(it);
    }
    if (!filtAll.length) {
      mentionMenu.appendChild(h("div", { class: "mm-item-empty" }, "没有匹配的素材（先去「素材库」导入或「收藏库」收藏）"));
    } else {
      const favFilt = filtAll.filter((c) => c.from === "fav");
      const fileFilt = filtAll.filter((c) => c.from === "files");
      if (favFilt.length) {
        mentionMenu.appendChild(h("div", { class: "mmg-title", style: "padding:8px 12px 4px;font-size:11px;text-transform:uppercase;color:#9fb0c6;border-bottom:0;" }, `⭐ 收藏库 · ${favFilt.length}`));
        for (const c of favFilt) mentionMenu.appendChild(makeMentionItem(c));
      }
      if (fileFilt.length) {
        mentionMenu.appendChild(h("div", { class: "mmg-title", style: "padding:8px 12px 4px;font-size:11px;text-transform:uppercase;color:#9fb0c6;border-bottom:0;" }, `🗂 素材库 · ${fileFilt.length}`));
        for (const c of fileFilt) mentionMenu.appendChild(makeMentionItem(c));
      }
    }
    document.body.appendChild(mentionMenu);
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const mw = mentionMenu.offsetWidth || 280;
      let left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);
      let top = r.bottom + 4;
      if (top + (mentionMenu.offsetHeight || 260) > window.innerHeight - 8) top = Math.max(8, r.top - (mentionMenu.offsetHeight || 260) - 4);
      mentionMenu.style.left = left + "px";
      mentionMenu.style.top = top + "px";
    }
  };
  // 单条候选行：缩略图 + 名称 + 类型标签
  function makeMentionItem(c) {
    const isImg = c.kind === "image" && !!c.thumb;
    const thumb = isImg
      // 缩略图加载失败 → 隐藏（不留破图裂图占位）
      ? h("img", { src: c.thumb, alt: c.name, loading: "lazy", onerror: "this.style.display='none'" })
      : h("span", { class: `mm-ph mm-ph-${c.kind || "image"}` }, KIND_GLYPH[c.kind] || "▣");
    const tag = c.kind === "video" ? "Video" : c.kind === "audio" ? "Audio" : "Picture";
    const tagLabel = `<${tag} 1>`;
    return h("div", { class: "mm-item", onclick: () => {
        // 素材库条目（机器文件名）→ 插显式标记 <Picture N>（按素材库序号解析，正文不再被塞数字串）
        // 收藏库条目（友好名）→ 插名字（切分匹配按名命中）
        if (c.from === "files" && c.index) insertMention(`<${tag} ${c.index}>`);
        else insertMention(c.name);
        closeMentionMenu();
      } },
      thumb,
      h("div", { class: "mm-lb" }, h("b", {}, c.name)),
      h("span", { class: "mm-tag" }, tagLabel));
  }
  // 把 @过滤词 替换为选中项（光标前最近的 @ 起）
  function insertMention(text) {
    box.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) { box.innerText += text; render(); commit(); return; }
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset;
    if (node && node.nodeType === 3) {
      const before = node.textContent.slice(0, offset);
      const at = before.lastIndexOf("@");
      if (at >= 0) {
        range.setStart(node, at);
        range.setEnd(node, offset);
        range.deleteContents();
      }
    }
    document.execCommand("insertText", false, text);
    commit();
    render();
  }
  box.addEventListener("input", () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) { closeMentionMenu(); return; }
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node && node.nodeType === 3) {
      const m = node.textContent.slice(0, range.startOffset).match(/@([^@\s]*)$/);
      if (m) showMentionMenu(m[1]);
      else closeMentionMenu();
    } else closeMentionMenu();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMentionMenu();
  });
  box.addEventListener("blur", () => setTimeout(closeMentionMenu, 150));

  // ---- 普通素材名 token：紧凑下拉（保留旧包行为）----
  function openPicker(anchor, name) {
    ensureGlobalStyle();
    const same = _favs().filter((f) => f.name === name && f.rel);
    const others = _favs().filter((f) => f.name !== name && f.rel && name.includes(f.name.split("（")[0].split("(")[0]) && f.name.length > 1);
    const list = same.length ? same : others.slice(0, 12);
    if (!list.length) { ctx.toast("收藏库无同名素材：先在「素材库」收藏", true); return; }
    const menu = h("div", { class: "mm-pop" });
    menu.appendChild(h("div", { class: "mmg-title" }, `🔁 把「${name}」切到哪个素材？`));
    for (const f of list) {
      const u = relToViewUrl(f.rel);
      const it = h("div", { class: "mm-item", title: f.rel, onclick: () => {
        chosen[name] = f.rel;
        if (authoritative) assetRegistry.setRef(name, f.rel); // 公共前缀权威：写入全局绑定 → 全面板同步
        if (typeof onChoose === "function") onChoose(name, f.rel);
        ctx.toast(`已把「${name}」引用切到 ${f.name}`);
        box.rerender(true);   // 程序化切换：box 有焦点也要刷新 chip 显示
        menu.remove();
      } },
        u ? h("img", { src: u, alt: f.name, loading: "lazy" }) : h("span", { class: "mm-ph mm-ph-" + (f.kind || "image") }, KIND_GLYPH[f.kind] || "▣"),
        h("div", { class: "mm-lb" }, h("b", {}, f.name)),
        h("span", { class: "mm-tag" }, f.rel.split("/").pop()));
      menu.appendChild(it);
    }
    document.body.appendChild(menu);
    const pad = 8;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 220;
    const mh = menu.offsetHeight || 180;
    let left = Math.min(Math.max(pad, r.left), window.innerWidth - mw - pad);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - pad) top = Math.max(pad, r.top - mh - 4);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    const outside = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", outside); } };
    setTimeout(() => document.addEventListener("pointerdown", outside), 0);
  }

  // ---- 显式引用标记 token：弹宫格预览（仿旧包）----
  // 把当前 box 文本中第一个匹配的 <Tag N> 替换为 newTag newN
  function replaceFirstTag(tag, oldN, newTag, newN) {
    // 用 lastPlain（真相）做正则替换；box.innerText 已被 render 丢尖括号，不能用
    const text = lastPlain || box.innerText || "";
    const re = new RegExp(`<\\s*${tag}\\s+${oldN}\\s*>`, "i");
    if (!re.test(text)) return false;
    lastPlain = text.replace(re, `<${newTag} ${newN}>`);
    box.innerText = lastPlain;
    render(true);   // 程序化替换：即使 box 有焦点也必须重渲染（否则 chip 不变）
    commit();
    return true;
  }
  async function openTagPicker(anchor, tag, currentN, opts = {}) {
    const isAuth = !!opts.authoritative;
    ensureGlobalStyle();
    await assetRegistry.refresh(); // 打开宫格时实时刷新素材库 + 收藏库
    const kind = TAG_TO_KIND[tag] || "image";
    // 宫格显示素材库 / 收藏库的「全部」素材（图片/音频/视频混合），不按 kind 过滤
    // 净化：剔除虚拟引用脏项（@image#1:xxx.png 之类不是磁盘真实文件）。
    // 这些项显示出来就是用户看到的"数字素材"，点一下还会把脏 rel 绑到 <Tag N> 上，
    // 后续出片就被污染（t2v 也会莫名带上图片）。这里从列表层直接掐掉。
    const assetList = cleanAssets(_getAssets() || []).filter((a) => a && (a.index || a.index === 0));
    const favList = cleanAssets(_favs() || []).filter((f) => f && f.rel);
    const wrap = h("div", { class: "mm-gallery" });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { wrap.remove(); } catch (_) {}
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", outside, true);
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const outside = (e) => {
      const t = e.target;
      if (!wrap.contains(t)) close();
    };
    // 同步挂上（close guard 已防误触）；之前用 setTimeout 0 是为了让 click 先完成，
    // 但现在加了 closed 守卫可以直接挂
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey);

    const hd = h("div", { class: "mmg-hd" },
      h("span", {}, `替换「${tag} ${currentN}」→ 选新素材`),
      h("span", { class: "mmg-sub" }, `素材库 ${assetList.length} · 收藏库 ${favList.length}`),
      h("span", { class: "mmg-close", onclick: close }, "✕ 关闭"));
    wrap.appendChild(hd);

    // 素材库宫格：显示「全部」素材（图片/音频/视频混合），按素材自身 kind 显示缩略图/图标 + <Tag N> 标签
    const assetsGrp = h("div", { class: "mmg-grp" });
    assetsGrp.appendChild(h("div", { class: "mmg-grp-hd" },
      h("span", {}, "素材库"),
      h("span", { class: "mmg-cnt" }, `${assetList.length} 项`)));
    if (!assetList.length) {
      assetsGrp.appendChild(h("div", { class: "mmg-empty" }, "（空）先去「素材库」导入或生成"));
    } else {
      const grid = h("div", { class: "mmg-grid" });
      for (const a of assetList) {
        const akind = a.kind || "image";
        const cardTag = KIND_TO_TAG[akind] || "Picture";
        const u = relToViewUrl(a.rel);
        const isCurrent = akind === kind && a.index === currentN;
        const showImg = akind === "image" && !!u;
        const card = h("div", { class: "mmg-card" + (isCurrent ? " mmg-current" : ""),
          title: a.rel || a.name,
          onclick: () => {
              if (isAuth) {
                // 权威面板（公共前缀）：把 <Tag N> 绑到指定素材（不替换文本 → 切分时按绑定查表）
                const tagKey = `<${tag} ${currentN}>`;
                // 绑定前再验一次：脏 rel 直接拒绝并提示（双保险，列表层已过滤过一次）
                if (!isUsableRel(a.rel)) {
                  ctx.toast("该素材不是有效文件（虚拟引用），已拒绝绑定", true);
                  close();
                  return;
                }
                assetRegistry.setTagBinding(tagKey, a.rel);
                if (tag !== cardTag) {
                  // 跨 kind（如 Audio→Video）则同时改 kind 标记（保留 N 序号）
                  replaceFirstTag(tag, currentN, cardTag, currentN);
                }
                ctx.toast(`已绑定 ${tagKey} → ${a.name}`);
                box.rerender && box.rerender(true);   // 程序化绑定：box 有焦点也要刷新 chip 显示
              } else if (replaceFirstTag(tag, currentN, cardTag, a.index)) {
                // 导演台（非权威）：文本里写的是 <Tag N> 这种"位置号"。素材库一旦拖拽换序，
                // 位置号会静默漂移 → chip 显示/送进模型的音色/参考图就不是刚点的那个了
                // （用户实报：toast 说 <Audio 3>春桃配音，chip 却显示沈砚之配音）。
                // 这里补一条按 rel 的身份绑定：tagTokenHTML 会优先按 rel 解析，彻底免疫重排。
                if (isUsableRel(a.rel)) {
                  assetRegistry.setTagBinding(`<${cardTag} ${a.index}>`, a.rel);
                }
                ctx.toast(`已替换为 <${cardTag} ${a.index}>（${a.name}）`);
              }
              close();
            } },
          isCurrent ? h("div", { class: "mmg-tag", style: { background: "rgba(143,240,192,.85)", color: "#0e1524", borderColor: "rgba(143,240,192,.6)" } }, "当前") : h("div", { class: "mmg-tag" }, `<${cardTag} ${a.index}>`),
          // 缩略图加载失败 → 降级为类型图标，不留破图
          showImg ? h("img", { src: u, alt: a.name, loading: "lazy",
            onerror: "this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','<div class=\"mmg-noimg\">▣</div>')" })
            : h("div", { class: "mmg-noimg" }, KIND_GLYPH[akind] || "▣"),
          h("div", { class: "mmg-cap" }, a.name || a.rel || `#${a.index}`));
        grid.appendChild(card);
      }
      assetsGrp.appendChild(grid);
    }
    wrap.appendChild(assetsGrp);

    // 收藏库宫格（只显示素材库未收录的）—— 让用户看到该候选「未导入素材库，不可作为引用」并提示导入
    // 已收录判定：rel 精确相等，或文件名相同（防止 rel 前缀 folder 不同导致同图误判「未导入」）
    const _fname = (rel) => String(rel || "").split("/").pop().toLowerCase();
    const favOnly = favList.filter((f) => !assetList.some((a) =>
      a.rel === f.rel || (_fname(a.rel) && _fname(a.rel) === _fname(f.rel))));
    const favGrp = h("div", { class: "mmg-grp" });
    favGrp.appendChild(h("div", { class: "mmg-grp-hd" },
      h("span", {}, "收藏库（仅显示未在素材库的）"),
      h("span", { class: "mmg-cnt" }, `${favOnly.length} 项`)));
    if (!favOnly.length) {
      favGrp.appendChild(h("div", { class: "mmg-empty" }, "（空 / 全部已收录到素材库）"));
    } else {
      const grid = h("div", { class: "mmg-grid" });
      for (const f of favOnly) {
        const fkind = f.kind || "image";
        const u = relToViewUrl(f.rel);
        const showImg = fkind === "image" && !!u;
        const card = h("div", { class: "mmg-card", title: (f.rel || "") + "\n（未导入素材库，需先导入）" },
          h("div", { class: "mmg-tag", style: { background: "rgba(255,180,180,.8)", color: "#1a0d0d", borderColor: "rgba(255,180,180,.6)" } }, "未导入"),
          showImg ? h("img", { src: u, alt: f.name, loading: "lazy" })
            : h("div", { class: "mmg-noimg" }, KIND_GLYPH[fkind] || "▣"),
          h("div", { class: "mmg-cap" }, f.name || f.rel || ""));
        card.onclick = () => {
          ctx.toast(`「${f.name}」未在素材库：先去「素材库」导入同名文件，再回这里选`, true);
        };
        grid.appendChild(card);
      }
      favGrp.appendChild(grid);
    }
    wrap.appendChild(favGrp);

    document.body.appendChild(wrap);
    // 定位：默认居中 + 顶部对齐 anchor；超出屏幕再夹紧
    const pad = 12;
    const r = anchor.getBoundingClientRect();
    const ww = wrap.offsetWidth;
    const wh = wrap.offsetHeight;
    let left = Math.min(Math.max(pad, r.left + r.width / 2 - ww / 2), window.innerWidth - ww - pad);
    let top = Math.min(Math.max(pad, r.bottom + 6), window.innerHeight - wh - pad);
    if (top === pad) top = Math.max(pad, r.top - wh - 6);
    wrap.style.left = left + "px";
    wrap.style.top = top + "px";
  }

  box.innerText = initial;
  render();
  return box;
}