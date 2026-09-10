// panels/script.js — 剧本输入 / 拆分 / 定义抽取 / 长文档适配 / 设定图生成
import { h, clear } from "../core/dom.js";
import { createMentionEditor, notifyFavsChange } from "../core/mentions.js";
import { assetRegistry } from "../core/assets.js";
import { SCRIPT_TEMPLATES } from "../core/script_templates.js";
import { SIZES, DEFAULT_SIZE_INDEX, CUSTOM_SIZE_INDEX, resolveSize } from "../core/sizes.js";
import { parsePrefixDef, planDefinitionJobs } from "../core/prefix_parser.js";
import { createLoraControls } from "./lora_controls.js";
import { createLoraPicker } from "./lora_picker.js";
import { pickAssetFolder } from "../core/ui.js";

export function createScriptPanel(ctx) {
  const s = ctx.store;

  const folderIn = h("input", {
    class: "input",
    value: s.get().folder || "mrboard_next",
    placeholder: "资产文件夹（input 下相对路径）",
  });
  folderIn.oninput = () => s.patch("folder", folderIn.value.trim());

  // 收藏库素材名（供 @ 引用 + 自动识别高亮）—— 统一走全局资产注册表（实时）
  let favs = [];
  const loadFavs = async () => { await assetRegistry.refresh(s.get().folder || "mrboard_next"); favs = assetRegistry.favs; return favs; };
  loadFavs();
  // 素材库（点 <Picture N> / <Audio N> / <Video N> token 弹宫格预览）
  let assets = [];
  const loadAssets = async () => {
    const folder = s.get().folder || "mrboard_next";
    await assetRegistry.refresh(folder);
    assets = assetRegistry.files; // 已含 rel（registry.refresh 内补齐）
    return assets;
  };
  loadAssets();

  // 文件夹切换时刷新素材库（与 timeline / shots 同款策略：1.5s 轮询）
  let _lastFolder = s.get().folder || "mrboard_next";
  setInterval(async () => {
    const f = s.get().folder || "mrboard_next";
    if (f !== _lastFolder) { _lastFolder = f; await loadAssets(); if (ta.rerender) ta.rerender(); if (prefixTa.rerender) prefixTa.rerender(); }
  }, 1500);

  // 剧本 + 公共前缀：用 mention editor（支持 @ 引用 / <Picture N> 标记 / 素材名自动高亮 / 点标记弹宫格）
  // 用 getAssets 函数闭包（每次弹宫格实时取最新 assets，避免异步加载后闭包过期）
  const ta = createMentionEditor(ctx, {
    initial: s.get().script || "",
    favorites: favs,
    getAssets: () => assets,
    chosen: {},
    onCommit: (text) => s.patch("script", text),
  });
  ta.style.minHeight = "300px";
  ta.style.maxHeight = "420px";
  ta.style.overflowY = "auto";
  ta.style.fontFamily = "inherit";

  const prefixTa = createMentionEditor(ctx, {
    initial: s.get().prefix || "",
    favorites: favs,
    getAssets: () => assets,
    chosen: {},
    onCommit: (text) => s.patch("prefix", text),
    authoritative: true, // 公共前缀是资产引用的权威源：这里改引用 → 全面板同步
  });
  prefixTa.style.minHeight = "120px";
  prefixTa.style.maxHeight = "220px";
  prefixTa.style.overflowY = "auto";
  prefixTa.style.fontFamily = "inherit";

  // 资产引用变化（公共前缀权威绑定 / 收藏库 / 素材库刷新）→ 重渲染本面板 token 实时显示
  assetRegistry.subscribe(() => { ta.rerender && ta.rerender(); prefixTa.rerender && prefixTa.rerender(); });
  // 首次加载完成后再重渲染一次（refresh 可能早于 subscribe 完成，此时数据已就绪但错过了通知）
  loadAssets().then(() => { ta.rerender && ta.rerender(); prefixTa.rerender && prefixTa.rerender(); });

  // 资产文件夹切换时刷新素材库
  folderIn.addEventListener("change", () => { loadAssets().then((a) => { ta.rerender && ta.rerender(); prefixTa.rerender && prefixTa.rerender(); }); });

  // 拆分逻辑抽成 doSplit：拆分按钮 + 「🎯 对齐引用」（对齐后自动重拆）共用
  const doSplit = async () => {
    try {
          // 收集显性标签手动绑定（<Picture N>/<Subject N>/<Audio N>/<Video N> → rel）
          const tagBindings = Object.assign({}, assetRegistry.tagBindings || {});
          // 收集角色名→rel（自动注入用）：直接复用公共前缀解析器（与「生成设定图」同源，
          // 保证「<Subject 1> 林晚，28岁女性」「角色1：林晚，…」「【角色】- 林晚：…」都能拿到名字）
          const roleImages = {};
          const pref = prefixTa.value() || "";
          try {
            const pp = parsePrefixDef(pref);
            for (const b of [...pp.roleBlocks, ...pp.sceneBlocks]) {
              const name = String(b.name || "").trim();
              if (!name || roleImages[name]) continue;
              const rel = assetRegistry.relOf(name);
              if (rel) roleImages[name] = rel;
            }
          } catch (_) {}
          const res = await ctx.api.split({
            script: ta.value(),
            prefix: prefixTa.value() || "",
            folder: s.get().folder || "mrboard_next",
            durationSec: s.get().defaultSec || 5,
            tagBindings,
            roleImages,
          });
          const arr = res.shots || [];
          // 把后端抽出的 header（首段定义头）一次性写回 store.prefix
          // splitStamp：告诉时间线"分镜方案换了" → 它会丢掉旧的每镜缓存，重新从 refMap 自动导入素材
          const stamp = Date.now();
          const patch = { shots: arr, splitStamp: stamp };
          if (res.header && res.header.trim() && !prefixTa.value().trim()) {
            patch.prefix = res.header;
            // 同步回 prefixTa DOM
            setTimeout(() => prefixTa.set(res.header), 0);
          }
          s.set(patch);
          // 持久化 perShot → store.refMap（每镜的素材引用 list）
          if (Array.isArray(res.perShot)) s.set({ refMap: res.perShot, splitStamp: stamp });
          const withSec = arr.filter((x) => x.sec != null).length;
          const missingTotal = (res.missingImages || []).length + (res.missingAudios || []).length + (res.missingVideos || []).length;
          let msg = `已拆分 ${arr.length} 镜${withSec ? ` · 自动时长 ${withSec} 镜` : ""}`;
          if (res.header && !prefixTa.value().trim()) msg += ` · 已自动填入公共前缀`;
          if (missingTotal) msg += ` · ⚠ ${missingTotal} 个素材缺失`;
          ctx.toast(msg);
          ctx.switchTo("shots");
    } catch (e) {
      ctx.toast("拆分失败: " + e.message, true);
    }
  };
  const splitBtn = h(
    "button",
    {
      class: "btn btn-primary",
      title: "拆分剧本为分镜 + 自动匹配时长 + 切分到导演台素材引用",
      onclick: () => doSplit(),
    },
    "拆分分镜 → 自动时长 → 切分到导演台"
  );

  /* 🎯 对齐引用：把剧本/前缀里的 <Picture N> 改成素材库里的**真实序号**（不改磁盘文件）
     素材库序号 = 按 kind 编号 + 你拖拽排序后的顺序，所以"改文件名去凑序号"会和自定义排序打架；
     改引用最简单也最稳：对完再自动重拆一次，格子里的图立刻对上。 */
  const alignBtn = h("button", {
    class: "btn",
    title: "把剧本与公共前缀里的 <Picture N> 改成素材库里的真实序号（自动重拆；不改磁盘文件）",
    onclick: async () => {
      try {
        await loadAssets().catch(() => {});     // 先刷新素材库（序号要最新）
        const script = ta.value() || "";
        const prefix = prefixTa.value() || "";
        const text = script + "\n" + prefix;
        // ① 期望名字：<Picture N> 名字（S1）：…（生产模板）/ 角色 N - 名字：<Picture K> …（定义头）
        const expect = {};
        const put = (tag, nm) => { nm = String(nm || "").trim(); if (nm && !expect[tag]) expect[tag] = nm; };
        for (const m of text.matchAll(/<\s*Picture\s*(\d+)\s*>\s*([^：:\n（(【\[]{1,24})/g)) put(`<Picture ${m[1]}>`, m[2]);
        for (const m of text.matchAll(/(?:角色|场景)\s*\d*\s*[-－—–:：]\s*([^：:\n<]{1,24})\s*[:：]\s*<\s*Picture\s*(\d+)\s*>/g)) put(`<Picture ${m[2]}>`, m[1]);
        const tags = Object.keys(expect);
        if (!tags.length) {
          ctx.toast("没找到 <Picture N> 引用（写「本镜出场角色」块，或前缀里写「角色 1 - 名字：<Picture K>」）", true);
          return;
        }
        const remap = {}, miss = [];
        // 找角色对应的素材（按序号口径 → 素材库真实 index）：
        //   ① 权威绑定 / 收藏库 / 同名文件（去扩展名）
        //   ② 文件名**包含**角色名（用户文件常叫「01_云妙衣.png」「云妙衣_三视图.png」）
        //   ③ 收藏库名字包含
        const findAsset = (nm) => {
          const rel = assetRegistry.relOf(nm);
          const f0 = rel ? (assets || []).find((x) => x.rel === rel) : null;
          if (f0 && f0.index) return f0;
          const hit = (assets || []).filter((x) => x.kind === "image"
            && String(x.name || "").replace(/\.[^.]+$/, "").includes(nm));
          if (hit.length) return hit[0];
          const fav = (favs || []).find((x) => String(x.name || "").includes(nm));
          if (fav && fav.rel) return (assets || []).find((x) => x.rel === fav.rel) || null;
          return null;
        };
        for (const tag of tags) {
          const nm = expect[tag];
          const f = findAsset(nm);
          const oldN = Number((tag.match(/\d+/) || [0])[0]);
          if (!f || !f.index) { miss.push(nm); continue; }
          if (f.index !== oldN) remap[oldN] = f.index;
        }
        const changed = Object.keys(remap).length;
        if (!changed) {
          ctx.toast(`引用已经全部对上${miss.length ? `；${miss.length} 个还没素材（${miss.join("、")}），生成/收藏后再点一次` : ""}`);
          return;
        }
        // ② 两段式替换：避免 1↔3 互换时相互覆盖
        const apply = (txt) => {
          let out = String(txt || ""), i = 0;
          const undo = {};
          for (const [o, n] of Object.entries(remap)) {
            const token = `\u0001PIC${i++}\u0001`;
            undo[token] = n;
            out = out.split(`<Picture ${o}>`).join(token);
          }
          for (const [tk, n] of Object.entries(undo)) out = out.split(tk).join(`<Picture ${n}>`);
          return out;
        };
        const nScript = apply(script), nPrefix = apply(prefix);
        ta.set(nScript);
        prefixTa.set(nPrefix);
        s.set({ script: nScript, prefix: nPrefix });
        const done = Object.entries(remap).map(([o, n]) => `<Picture ${o}>→${n}`).join("、");
        ctx.toast(`已对齐 ${changed} 处引用（${done}）${miss.length ? ` · ${miss.length} 个缺素材` : ""}，正在重新拆分…`);
        await doSplit();
      } catch (e) {
        ctx.toast("对齐失败: " + e.message, true);
      }
    },
  }, "🎯 对齐引用");

  /* 📦 自动从剧本头部抽公共前缀（不对齐旧包：哪怕 prefix 已填也覆盖——用户明确点了按钮） */
  const extractBtn = h(
    "button",
    {
      class: "btn",
      title: "剧本首段若无分镜标记，自动识别为角色/场景定义，写入公共前缀",
      onclick: async () => {
        if (!ta.value().trim()) { ctx.toast("请先粘贴剧本", true); return; }
        extractBtn.disabled = true;
        extractBtn.textContent = "抽取中…";
        try {
          const r = await ctx.api.extractDefs(ta.value(), prefixTa.value() || "");
          if (!r.header || !r.header.trim()) {
            ctx.toast(r.message || "剧本首段没有可抽取的定义头（必须不含任何分镜标记）", true);
            return;
          }
          prefixTa.set(r.suggestedPrefix || r.header);
          s.set({ prefix: r.suggestedPrefix || r.header });
          ctx.toast(`已抽取到公共前缀：${(r.found || []).join("、") || "(无标签)"}`);
        } catch (e) {
          ctx.toast("抽取失败: " + e.message, true);
        } finally {
          extractBtn.disabled = false;
          extractBtn.textContent = "📦 自动抽公共前缀";
        }
      },
    },
    "📦 自动抽公共前缀"
  );

  const planBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        try {
          const res = await ctx.api.assetPlan(ta.value(), prefixTa.value());
          s.set({ roles: res.roles, scenes: res.scenes });
          ctx.toast(`角色 ${res.roles.length} · 场景 ${res.scenes.length}`);
        } catch (e) {
          ctx.toast("抽取失败: " + e.message, true);
        }
      },
    },
    "抽取角色/场景"
  );

  /* 长文档适配：0715 风格长文档 → 角色/场景前缀 + 逐镜正文 */
  const adaptBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        if (!ta.value().trim()) {
          ctx.toast("请先粘贴长文档", true);
          return;
        }
        adaptBtn.disabled = true;
        adaptBtn.textContent = "适配中…";
        try {
          const r = await ctx.api.adaptLongdoc(ta.value());
          if (!r.detected) {
            ctx.toast(r.message || "未识别到镜头结构", true);
            return;
          }
          s.set({ script: r.script || "", prefix: r.prefix || "" });
          ctx.toast(
            (r.title ? `《${r.title}》` : "") + `已适配：${r.shots ? r.shots.length : 0} 镜 · 角色/场景已入前缀`
          );
        } catch (e) {
          ctx.toast("适配失败: " + e.message, true);
        } finally {
          adaptBtn.disabled = false;
          adaptBtn.textContent = "📄 长文档适配";
        }
      },
    },
    "📄 长文档适配"
  );

  // ---- 📂 从本地磁盘导入剧本文件（.txt / .md） ----
  // 补回 v1.5.0 重构时漏搬的按钮（line 641 模板按钮旁引用）
  const importBtn = h(
    "button",
    {
      class: "btn",
      style: { padding: "3px 9px", fontSize: 11.5 },
      title: "从本地选择 .txt/.md 剧本文件，自动填入剧本框（不覆盖公共前缀）",
      onclick: async () => {
        importBtn.disabled = true;
        importBtn.textContent = "选择中…";
        try {
          const pick = await ctx.api.nativePick({
            kind: "file",
            title: "选择剧本文件（.txt / .md）",
            filetypes: [".txt", ".md"],
            multiple: false,
          });
          if (pick.cancel || !(pick.paths || []).length) return;
          const path = pick.paths[0];
          const r = await ctx.api.readLocalText(path);
          if (!r.ok) { ctx.toast("导入失败: " + r.error, true); return; }
          ta.set(r.text);
          ctx.toast(`已导入剧本「${r.name}」（${r.text.length} 字）`);
        } catch (e) { ctx.toast("导入失败: " + e.message, true); }
        finally { importBtn.disabled = false; importBtn.textContent = "📂 导入剧本"; }
      },
    },
    "📂 导入剧本"
  );

  // ---- 剧本模板（基于本节点流水线，对齐旧包所有分镜标记）----
  function openScriptTemplateModal() {
    const overlay = h("div", { style: "position:fixed;inset:0;z-index:2147483000;background:rgba(2,4,9,.82);display:flex;align-items:center;justify-content:center;" });
    const panel = h("div", { style: "width:680px;max-width:94vw;max-height:82vh;background:linear-gradient(180deg,#16213a,#101a30);border:1px solid #31446a;border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6);" });
    panel.appendChild(h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:12px;" },
      h("b", { style: { fontSize: 14, color: "#ffcf6b" } }, "📄 剧本模板"),
      h("span", { class: "muted", style: { fontSize: 11 } }, "点「使用」填入剧本 + 公共前缀（覆盖旧包所有分镜标记）"),
      h("div", { class: "mx-spacer" }),
      h("button", { class: "btn", style: { padding: "4px 10px" }, onclick: () => overlay.remove() }, "✕")));
    const list = h("div", { style: "overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px;" });
    SCRIPT_TEMPLATES.forEach((tpl) => {
      const row = h("div", { style: "padding:10px 12px;background:#131e36;border:1px solid #2a3a5e;border-radius:10px;" },
        h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:4px;" },
          h("b", { style: { fontSize: 12.5, color: "#9fd0ff" } }, tpl.name),
          h("div", { class: "mx-spacer" }),
          h("button", { class: "btn btn-primary", style: { padding: "4px 12px" }, onclick: () => {
            prefixTa.set(tpl.prefix || "");
            ta.set(tpl.script || "");
            ctx.toast("已使用模板「" + tpl.name + "」");
            overlay.remove();
          } }, "使用")),
        h("div", { class: "muted", style: { fontSize: 11, marginBottom: 6 } }, tpl.desc),
        h("pre", { style: "margin:0;font-family:inherit;white-space:pre-wrap;font-size:11px;color:#a8bbd0;max-height:140px;overflow:auto;background:#0c1428;padding:8px;border-radius:6px;" }, (tpl.prefix || "") + (tpl.prefix && tpl.script ? "\n\n—— 剧本 ——\n" : "") + (tpl.script || "")));
      list.appendChild(row);
    });
    panel.appendChild(list);
    overlay.appendChild(panel);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }

  /* ---------- 角色/场景设定图：批量生成 + 自动入收藏库 ---------- */
  // 完全重写：以前依赖 store.roles / store.scenes（后端抽取结果），会与 prefix 文本脱钩、
  //           数量/顺序/描述与用户写在 prefix 里的不一致。
  // 现在：前端直接按 prefix 行序解析 → 跨段引用 <Subject N> / <Picture N> / <Style 全局> 自动展开
  //        → 生成按 prefix 行序的 jobs（同角色/场景共享同一份"全局风格 + 通用头部"模板）
  const genLog = h("div", { class: "muted", style: { whiteSpace: "pre-wrap" } },
    "按公共前缀的分段生成：每行「角色 N - 名字：描述」/「场景 N - 名字：描述」对应 1 张设定图（顺序与 prefix 一致）。");
  const defModelSel = h("select", { class: "select", style: { width: "auto" } });
  const defCount = h("span", { class: "muted" });
  const previewBtn = h("button", { class: "btn", style: { padding: "4px 11px", fontSize: 11.5 }, onclick: () => previewJobs() }, "👁 预览");
  const skipCollectedCk = h("input", { type: "checkbox", checked: true, style: { accentColor: "#f5ca57" } });

  const _fillDefModels = async () => {
    try {
      const r = await ctx.api.models();
      const list = r.diffusion || [];
      clear(defModelSel);
      defModelSel.appendChild(h("option", { value: "" }, "（占位图/测试）"));
      for (const m of list) defModelSel.appendChild(h("option", { value: m }, m));
      if (list.length) defModelSel.value = (r.defaults && r.defaults.model) || list[0];
    } catch (_) {}
  };
  _fillDefModels();

  // 生图尺寸选择（与「生图」/「流水线」面板联动 store.genSize / genW / genH —— 显示在 genDefSection 里）
  const sizeSel = h("select", { class: "select", style: { width: "auto" } },
    ...SIZES.map(([label], i) => h("option", { value: String(i) }, label)));
  const defWIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 74, display: "none" }, value: 768 });
  const defHIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 74, display: "none" }, value: 1344 });
  const syncCustomVisible = () => {
    const isCustom = Number(sizeSel.value) === CUSTOM_SIZE_INDEX;
    defWIn.style.display = isCustom ? "" : "none";
    defHIn.style.display = isCustom ? "" : "none";
  };
  sizeSel.value = String(ctx.store.get().genSize ?? DEFAULT_SIZE_INDEX);
  defWIn.value = ctx.store.get().genW || 768;
  defHIn.value = ctx.store.get().genH || 1344;
  sizeSel.onchange = () => { ctx.store.set({ genSize: Number(sizeSel.value) || 0 }); syncCustomVisible(); };
  defWIn.oninput = () => { ctx.store.set({ genW: Number(defWIn.value) || 0 }); };
  defHIn.oninput = () => { ctx.store.set({ genH: Number(defHIn.value) || 0 }); };
  ctx.store.subscribe((st) => {
    if (st.genSize != null && String(st.genSize) !== sizeSel.value) sizeSel.value = String(st.genSize);
    if (st.genW != null && Number(defWIn.value) !== Number(st.genW)) defWIn.value = st.genW;
    if (st.genH != null && Number(defHIn.value) !== Number(st.genH)) defHIn.value = st.genH;
    syncCustomVisible();
  });
  syncCustomVisible();

  function getJobs() {
    const prefixText = (prefixTa.value && typeof prefixTa.value === "function" ? prefixTa.value() : "") || "";
    const parsed = parsePrefixDef(prefixText);
    const [gw, gh] = resolveSize(sizeSel.value, ctx.store.get().genW, ctx.store.get().genH);
    return { jobs: planDefinitionJobs(parsed, { width: gw, height: gh }), parsed };
  }

  function previewJobs() {
    const { jobs, parsed } = getJobs();
    if (!jobs.length) {
      ctx.toast("未在公共前缀里识别到「角色 N - 名字：描述」或「场景 N - 名字：描述」段落", true);
      return;
    }
    const overlay = h("div", {
      style: "position:fixed;inset:0;z-index:2147483600;background:rgba(2,4,9,.86);display:flex;align-items:center;justify-content:center;padding:18px;",
      onclick: (e) => { if (e.target === overlay) overlay.remove(); },
    });
    const panel = h("div", {
      style: "width:760px;max-width:94vw;max-height:86vh;background:#101a2a;border:1px solid #31446a;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;box-shadow:0 22px 60px rgba(0,0,0,.7);",
    });
    panel.appendChild(h("div", { style: "display:flex;align-items:center;gap:8px;" },
      h("b", { style: { fontSize: 13, color: "#ffcf6b" } }, `👁 即将批量生成 ${jobs.length} 张（按公共前缀行序）`),
      h("div", { class: "mx-spacer" }),
      h("button", { class: "btn", style: { padding: "3px 9px", fontSize: 11.5 }, onclick: () => overlay.remove() }, "✕ 关闭"),
    ));
    if (parsed.style) {
      panel.appendChild(h("div", {
        style: "font-size:11.5px;color:#ffd98f;background:#1a1408;border:1px solid #5e3e10;border-radius:6px;padding:6px 9px;",
      }, "🎨 全局基调（来自 <Style 全局>）：" + parsed.style));
    }
    if (parsed.warnings.length) {
      const w = h("div", { style: "font-size:11px;color:#ffb37a;background:#1d0f08;border:1px solid #5a3010;border-radius:6px;padding:5px 9px;max-height:80px;overflow:auto;" });
      w.textContent = "⚠ 解析提示：\n" + parsed.warnings.join("\n");
      panel.appendChild(w);
    }
    const list = h("div", { style: "overflow-y:auto;flex:1 1 auto;display:flex;flex-direction:column;gap:7px;padding:2px;" });
    jobs.forEach((job, i) => {
      const card = h("div", { style: "background:#0c1428;border:1px solid #24344e;border-radius:8px;padding:8px 10px;" });
      const tag = job.kind === "role" ? "👤 角色" : "🏞 场景";
      const tagColor = job.kind === "role" ? "#ffcf6b" : "#7dd3fc";
      card.appendChild(h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:4px;" },
        h("span", { style: { color: tagColor, fontWeight: 700, fontSize: 12 } }, `[${i + 1}/${jobs.length}] ${tag}`),
        h("b", { style: { color: "#dbe6f4", fontSize: 12.5 } }, job.name),
        h("span", { class: "muted", style: { fontSize: 11 } }, `· ${job.w}×${job.h}`),
      ));
      const p = h("pre", {
        style: "margin:0;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#a8c0e0;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;background:#081020;padding:6px 8px;border-radius:5px;",
      }, job.prompt);
      card.appendChild(p);
      list.appendChild(card);
    });
    panel.appendChild(list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  const genDefBtn = h(
    "button",
    {
      class: "btn btn-primary",
      title: "按公共前缀分段批量生成设定图，并入收藏库（顺序 = prefix 行序；同种共享全局基调）",
      onclick: async () => {
        const prefixText = (prefixTa.value && typeof prefixTa.value === "function" ? prefixTa.value() : "") || "";
        if (!prefixText.trim()) {
          ctx.toast("先在「公共前缀」面板里写好角色/场景定义", true);
          return;
        }
        const { jobs, parsed } = getJobs();
        if (!jobs.length) {
          const hint = parsed.warnings.length ? `（有 ${parsed.warnings.length} 行没认出来，见下方解析提示）` : "";
          ctx.toast("公共前缀里没识别到「角色 / 场景」定义" + hint, true);
          return;
        }
        const fav = await ctx.api.favorites().catch(() => ({ items: [] }));
        const have = new Set((fav.items || []).map((i) => i.name + "|" + i.category));
        let todoJobs = jobs;
        let skippedCount = 0;
        if (skipCollectedCk.checked) {
          todoJobs = jobs.filter((j) => !have.has(j.name + "|" + j.kind));
          skippedCount = jobs.length - todoJobs.length;
        }
        if (!todoJobs.length) {
          ctx.toast("所有要生成的项都已收藏（可取消勾选「跳过已收藏」强制重生成）", true);
          return;
        }
        // 先选本次设定图的保存文件夹（Windows 原生对话框，定位到 ComfyUI/input），取消则中止
        const pickRes = await pickAssetFolder(ctx, "选择设定图保存文件夹（在 ComfyUI input 下选择或新建）");
        if (pickRes.cancel) { ctx.toast("已取消（未选保存文件夹）"); return; }
        if (pickRes.error) { ctx.toast(pickRes.error, true); return; }
        ctx.store.set({ folder: pickRes.folder });
        genLog.textContent =
          `📁 保存文件夹：input/${pickRes.folder || "（根目录）"}\n` +
          `📋 共识别 ${jobs.length} 条（${parsed.roleBlocks.length} 个角色 / ${parsed.sceneBlocks.length} 个场景）· ` +
          `跳过 ${skippedCount} · 即将生成 ${todoJobs.length} 张\n`;
        if (parsed.warnings.length) {
          genLog.textContent += "⚠ " + parsed.warnings.join("\n⚠ ") + "\n";
        }
        genDefBtn.disabled = true;
        let ok = 0;
        for (let i = 0; i < todoJobs.length; i++) {
          const job = todoJobs[i];
          genLog.textContent += `[${i + 1}/${todoJobs.length}] (${job.kind}) ${job.name}…\n`;
          try {
            const res = await ctx.api.generate({
              prompt: job.prompt,
              folder: ctx.store.get().folder ?? "mrboard_next",
              // 「生图」面板选过模型/步数 → 优先用（参数同步），否则用本面板下拉/默认
              model: ctx.store.get().genModel || defModelSel.value,
              seed: i,
              width: job.w,
              height: job.h,
              steps: Number(ctx.store.get().genSteps) || 8,
              ...({ loras: (ctx.store.get().loras || []), lora_folder: (ctx.store.get().loraFolder || "") }),
            });
            if (res.ok) {
              // 自动改名：把机器名（1788948454574_xxx.png）改成剧本写的名字（如「林晚.png」），
              // 再自动导入素材库 —— 素材库里不再是"数字素材"，一眼能认出是誰。
              let rel = res.rel;
              let renamed = false;
              try {
                const rr = await ctx.api.rename(res.rel, job.name);
                if (rr && rr.ok && rr.rel) { rel = rr.rel; renamed = !!rr.renamed; }
                else if (rr && rr.error) genLog.textContent += `    ⚠ 改名失败（用原名入库）：${rr.error}\n`;
              } catch (e) {
                genLog.textContent += `    ⚠ 改名失败（用原名入库）：${e.message}\n`;
              }
              await ctx.api.favoriteAdd([{ name: job.name, rel, kind: "image", category: job.kind }]);
              ok += 1;
              genLog.textContent += `    ✓ ${renamed ? `已改名「${job.name}」→ ` : ""}已导入素材库 + 收藏（${job.kind}）\n`;
            } else {
              genLog.textContent += `    ✗ ${res.error || "失败"}\n`;
            }
          } catch (e) {
            genLog.textContent += `    ✗ ${e.message}\n`;
          }
        }
        // 刷新素材库：改名后的文件立刻出现在素材库里（可直接作为 <Picture N> 引用）
        try { await assetRegistry.refresh(); genLog.textContent += "✓ 已刷新素材库（改名后的设定图可直接引用）\n"; } catch (_) {}
        genLog.textContent += `完成：新收藏 ${ok} 个（prefix 行序 · 全局基调"${parsed.style || "默认"}"）。`;
        ctx.toast(`设定图完成，新收藏 ${ok} / ${todoJobs.length} 个（已改名并导入素材库）`);
        if (ok) ctx.switchTo("favorites");
        genDefBtn.disabled = false;
      },
    },
    "⚡ 生成设定图并入收藏"
  );

  // 实时维护可见计数（prefix 文本变化时刷：识别到的角色/场景 + 未识别行数）
  function refreshCount() {
    try {
      const { jobs, parsed } = getJobs();
      if (!jobs.length) {
        defCount.textContent = "  未识别到角色/场景定义";
        defCount.title = "支持：<Subject N> 林晚：描述 ／ 角色1：林晚，描述 ／ 场景 1 - 破庙：描述 ／ 【角色】- 林晚：描述 ／ 林晚：描述（裸写法）／ <Style 全局> 冷色调";
        return;
      }
      const warn = parsed.warnings.length ? ` · ⚠ ${parsed.warnings.length} 行未识别` : "";
      defCount.textContent = `  识别到 ${parsed.roleBlocks.length} 角色 / ${parsed.sceneBlocks.length} 场景${warn}`;
      defCount.title =
        (parsed.roleBlocks.length ? "角色：" + parsed.roleBlocks.map((r) => r.name).join("、") + "\n" : "") +
        (parsed.sceneBlocks.length ? "场景：" + parsed.sceneBlocks.map((s) => s.name).join("、") + "\n" : "") +
        (parsed.style ? "全局风格：" + parsed.style + "\n" : "") +
        (parsed.warnings.length ? "未识别行：\n" + parsed.warnings.join("\n") : "");
    } catch (_) { defCount.textContent = ""; }
  }
  refreshCount();
  if (prefixTa && typeof prefixTa === "object" && prefixTa.set && !prefixTa.__countWatchInstalled) {
    let last = "";
    const tick = () => {
      try {
        const cur = prefixTa.value && prefixTa.value();
        if (cur !== last) { last = cur; refreshCount(); }
      } catch (_) {}
    };
    setTimeout(tick, 0);
    setInterval(tick, 600);
    prefixTa.__countWatchInstalled = true;
  }

  // LoRA 控件（与生图面板 / 流水线面板 共享 store.useLora + loraFolder）
  const loraCtl = createLoraControls(ctx, { inline: true, onChange: () => { /* 文件夹/开关变化由 picker 自己刷新 */ } });
  // 🎚 点击弹出 LoRA 列表 → 设定图/角色图也吃 LoRA（后端对所有模式生效）
  const loraPicker = createLoraPicker(ctx, {});

  // 「角色/场景设定图」面板
  const genDefSection = h(
    "div",
    { class: "card" },
    h("h3", { style: { margin: "0 0 8px", fontSize: 13, color: "#9fd0ff" } }, "角色/场景设定图（生成 + 自动收藏）"),
    h("div", { class: "row" },
      defModelSel,
      previewBtn,
      genDefBtn,
      h("label", { class: "row", style: { gap: 4, fontSize: 11, color: "#a8bbd0", cursor: "pointer" } }, skipCollectedCk, "跳过已收藏"),
      defCount),
    h("div", { class: "row", style: { marginTop: 6 } },
      h("span", { class: "muted", style: { fontSize: 11 } }, "尺寸"),
      sizeSel, defWIn, h("span", { class: "muted", style: { fontSize: 11 } }, "×"), defHIn,
    ),
    h("div", { style: { marginTop: 4, fontSize: 11, color: "#a8bbd0" } }, loraCtl.row, loraPicker.row),
    genLog
  );


  /* ---------- 大文本修改弹窗（参考旧包：双 tab 模式 = 纯文本 / 带标记）---------- */
  // kind: 'script' | 'prefix'
  // targetEl: 主页里的 ta 或 prefixTa（弹窗保存后用 set() 同步回主页）
  function openTextEditorModal({ title, kind, targetEl, sourceKey, currentText }) {
    const overlay = h("div", {
      style: "position:fixed;inset:0;z-index:2147483500;background:rgba(2,4,9,.86);display:flex;align-items:center;justify-content:center;padding:24px;",
    });
    const panel = h("div", {
      style: "width:min(900px,94vw);max-height:88vh;background:linear-gradient(180deg,#16213a,#101a30);border:1px solid #31446a;border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.65);",
    });

    // 头部：标题 + 关闭
    const head = h("div", { style: "display:flex;align-items:center;gap:10px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #2a3a5e;" },
      h("b", { style: { fontSize: 14, color: "#ffcf6b" } }, title),
      h("span", { class: "muted", style: { fontSize: 11 } }, "纯文本便于编辑 · 带标记实时高亮 token"),
      h("div", { class: "mx-spacer" }),
      h("button", { class: "btn", style: { padding: "4px 10px" }, onclick: () => overlay.remove() }, "✕"),
    );
    panel.appendChild(head);

    // Tab 栏
    let activeTab = "text"; // 'text' | 'markup'
    const tabText = h("button", { class: "ptab on", onclick: () => switchTab("text") }, "📝 纯文本");
    const tabMarkup = h("button", { class: "ptab", onclick: () => switchTab("markup") }, "🏷 带标记");
    const tabBar = h("div", { class: "pstrip", style: { marginBottom: 8 } }, tabText, tabMarkup);
    panel.appendChild(tabBar);

    // 编辑器容器
    const editorBox = h("div", {
      style: "flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border:1px solid #2a3a5e;border-radius:10px;background:#0c1428;padding:8px;",
    });
    panel.appendChild(editorBox);

    // 状态行
    const stat = h("div", { class: "muted", style: { fontSize: 11, marginTop: 6, textAlign: "right" } }, "");
    panel.appendChild(stat);

    // 文本域（纯文本模式）—— 永远存在以便在两种模式间无丢失地切换
    const plainTa = h("textarea", {
      class: "textarea",
      style: "flex:1 1 auto;min-height:420px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.6;",
      spellcheck: "false",
      placeholder: "在这里直接编辑文字……（HTML 标签 <Picture 1> 会作为普通字符显示）",
    });
    plainTa.value = currentText || "";

    // 标记模式的 mention editor
    let markupEl = null;

    function syncStat() {
      const v = activeTab === "text" ? plainTa.value : (markupEl ? (markupEl.value ? markupEl.value() : "") : "");
      const lines = v ? v.split(/\n/).length : 0;
      const chars = v.length;
      stat.textContent = `${chars} 字 · ${lines} 行 · ${activeTab === "text" ? "纯文本" : "带标记"}`;
    }

    function refreshMarkup() {
      if (!markupEl) return;
      const v = plainTa.value;
      if (markupEl.value && markupEl.value() !== v) markupEl.set(v);
    }

    function switchTab(t) {
      if (t === activeTab) return;
      // 切换前先把当前模式的内容同步到 plainTa
      if (activeTab === "markup" && markupEl) {
        plainTa.value = markupEl.value ? markupEl.value() : "";
      }
      activeTab = t;
      tabText.classList.toggle("on", t === "text");
      tabMarkup.classList.toggle("on", t === "markup");
      clear(editorBox);
      if (t === "text") {
        editorBox.appendChild(plainTa);
      } else {
        if (!markupEl) {
          markupEl = createMentionEditor(ctx, {
            initial: plainTa.value,
            favorites: favs,
            getAssets: () => assets,
            chosen: {},
            authoritative: kind === "prefix", // 公共前缀 = 资产引用权威源
            onCommit: (text) => { /* 实时回写到纯文本域，保证切换 tab 不丢内容 */ plainTa.value = text; syncStat(); },
          });
          markupEl.style.flex = "1 1 auto";
          markupEl.style.minHeight = "420px";
          markupEl.style.maxHeight = "none";
          markupEl.style.overflowY = "auto";
          markupEl.style.fontFamily = "ui-monospace, Consolas, monospace";
          markupEl.style.fontSize = "13px";
          markupEl.style.lineHeight = "1.6";
        }
        editorBox.appendChild(markupEl);
      }
      syncStat();
    }

    // 初始化：纯文本模式
    switchTab("text");
    plainTa.addEventListener("input", syncStat);
    syncStat();

    // 底部按钮
    const apply = () => {
      const v = activeTab === "text" ? plainTa.value : (markupEl ? (markupEl.value ? markupEl.value() : "") : "");
      if (targetEl && typeof targetEl.set === "function") targetEl.set(v);
      s.set({ [sourceKey]: v });
      ctx.toast(`${title}已保存（${v.length} 字）`);
      overlay.remove();
    };
    const cancel = () => overlay.remove();
    const footer = h("div", { style: "display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid #2a3a5e;" },
      h("div", { class: "mx-spacer" }),
      h("button", { class: "btn", onclick: cancel }, "取消"),
      h("button", { class: "btn btn-primary", onclick: apply }, "✓ 应用修改"),
    );
    panel.appendChild(footer);
    overlay.appendChild(panel);
    overlay.onclick = (e) => { if (e.target === overlay) cancel(); };
    // Esc 键关闭
    const onKey = (e) => { if (e.key === "Escape") cancel(); };
    document.addEventListener("keydown", onKey);
    const _origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { document.removeEventListener("keydown", onKey); _origRemove(); };
    document.body.appendChild(overlay);
    // 自动聚焦
    setTimeout(() => plainTa.focus(), 0);
  }

  // 打开剧本编辑弹窗
  const editScriptBtn = h(
    "button",
    {
      class: "btn",
      style: { padding: "3px 9px", fontSize: 11.5 },
      title: "弹出大窗口编辑剧本（纯文本 / 带标记 双模式）",
      onclick: () => openTextEditorModal({
        title: "📝 修改剧本",
        kind: "script",
        targetEl: ta,
        sourceKey: "script",
        currentText: ta.value(),
      }),
    },
    "📝 修改剧本"
  );
  // 打开公共前缀编辑弹窗
  const editPrefixBtn = h(
    "button",
    {
      class: "btn",
      style: { padding: "3px 9px", fontSize: 11.5 },
      title: "弹出大窗口编辑公共前缀（角色/场景/Subject 定义，纯文本 / 带标记 双模式）",
      onclick: () => openTextEditorModal({
        title: "📝 修改公共前缀",
        kind: "prefix",
        targetEl: prefixTa,
        sourceKey: "prefix",
        currentText: prefixTa.value(),
      }),
    },
    "📝 修改前缀"
  );

  const el = h(
    "div",
    { class: "col", style: { maxWidth: 980, width: "100%" } },
    h("div", { class: "card" },
      h("div", { class: "row", style: { marginBottom: 6 } }, h("div", { class: "label", style: { margin: 0 } }, "资产文件夹"), folderIn,
        h("div", { class: "mx-spacer" }), h("span", { class: "muted", style: { fontSize: 11 } }, "素材将保存到 input/ 下该文件夹")),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } },
        h("div", { class: "col" },
          h("div", { class: "row", style: { marginBottom: 4 } },
            h("span", { class: "label", style: { margin: 0 } }, "剧本 / 长文档"),
            h("div", { class: "mx-spacer" }),
            h("button", { class: "btn", style: { padding: "3px 9px", fontSize: 11.5 }, title: "基于本节点流水线的剧本模板（覆盖旧包所有分镜标记）", onclick: () => openScriptTemplateModal() }, "📄 剧本模板"),
            importBtn,
            editScriptBtn,
            h("button", { class: "btn", style: { padding: "3px 9px", fontSize: 11.5 }, onclick: () => { ta.focus(); try { document.execCommand("selectAll"); } catch (_) {} } }, "⊞ 全选"),
            h("button", { class: "btn", style: { padding: "3px 9px", fontSize: 11.5, borderColor: "#a33" }, onclick: () => { if (!ta.value() && !prefixTa.value()) return; if (!confirm("清空剧本与公共前缀？")) return; ta.set(""); prefixTa.set(""); s.set({ script: "", prefix: "" }); } }, "🗑 清空")),
          ta,
          h("div", { class: "row", style: { marginTop: 8 } }, splitBtn, alignBtn, extractBtn, planBtn, adaptBtn)),
        h("div", { class: "col" },
          h("div", { class: "row", style: { marginBottom: 4 } },
            h("span", { class: "label", style: { margin: 0 } }, "公共前缀（角色/场景定义，可空）"),
            h("div", { class: "mx-spacer" }),
            editPrefixBtn),
          prefixTa,
          h("div", { style: { marginTop: 8 } }, genDefSection)))));
  /* 外部（Skill 面板「结果 → 剧本」/ 长文档适配）改 store.script/prefix 时同步回文本框 */
  ctx.store.subscribe((st) => {
    if (document.activeElement !== ta && ta.value() !== (st.script || "")) {
      ta.set(st.script || "");
    }
    if (document.activeElement !== prefixTa && prefixTa.value() !== (st.prefix || "")) {
      prefixTa.set(st.prefix || "");
    }
    const n = (st.roles || []).length + (st.scenes || []).length;
    defCount.textContent = n ? `待生成：角色 ${(st.roles || []).length} · 场景 ${(st.scenes || []).length}` : "";
  });

  return { el };
}
