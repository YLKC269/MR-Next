// panels/shots.js — 分镜格子：旧包风格"自动裁切分镜头成格子+匹配时长+切分到导演台"。
// 每张卡片：序号 + 删镜 + 正文编辑（含 @/素材标记高亮 + N秒标注提示）+ 时长输入
//         + 引用 chip（缩略图：image/audio/video）+ 缺图警告 + ⧉ 复制本镜
// 顶部工具栏：⏱ 自动匹配时长（按 5s/5秒/S05 标注重写 store.shots[i].sec）
//             ⏱ 设全镜统一时长 · 匹配引用 · → 切分到导演台 · 保存/清空
import { h, clear } from "../core/dom.js";
import { relToViewUrl } from "../core/api.js";
import { createMentionEditor, notifyFavsChange } from "../core/mentions.js";
import { assetRegistry } from "../core/assets.js";

// 时长标注：5s / 5秒 / (5秒)。⚠️ 不能用 \b —— JS 的 \w 不含中文，"8秒"的秒后
// 跟空格时 \b（word/non-word 边界）永不成立 → 0 匹配。用 (?![a-z0-9]) 替代 s 后的
// \b 语义（防 "5s5" 误吞），秒后不做断言（旧包 RE_DUR 同款行为）。
const DUR_RE = /(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds?)?)?(?![a-z0-9])|秒)/gi;

export function createShotsPanel(ctx) {
  const s = ctx.store;
  const wrap = h("div", { class: "grid cols-2" });
  const stat = h("div", { class: "muted" });
  let favs = [];
  const chosenMaps = {}; // shotIndex -> { name: rel }
  // 素材库（点 <Picture N> 等标记弹宫格用）
  let assets = [];
  let assetsFolder = "";

  const loadFavs = async () => {
    await assetRegistry.refresh(s.get().folder || "mrboard_next");
    favs = assetRegistry.favs;
    return favs;
  };
  loadFavs();
  const loadAssets = async (folder) => {
    const f = folder || s.get().folder || "mrboard_next";
    if (f === assetsFolder) return assets;
    assetsFolder = f;
    await assetRegistry.refresh(f);
    assets = assetRegistry.files; // 已含 rel
    return assets;
  };
  loadAssets();
  // 首屏：loadAssets 完成后若已有数据则触发 render，确保宫格预览用最新 assets
  loadAssets().then(() => { if (assets && assets.length) render(); });
  // 资产引用变化（公共前缀权威绑定 / 收藏库 / 素材库刷新）→ 重渲染本面板 token/chip 实时显示
  assetRegistry.subscribe(() => render());
  // 文件夹切换时刷新素材库（与 timeline 同款策略：1.5s 轮询）
  let _lastFolder = s.get().folder || "mrboard_next";
  setInterval(async () => {
    const f = s.get().folder || "mrboard_next";
    if (f !== _lastFolder) { _lastFolder = f; await loadAssets(f); render(); }
  }, 1500);

  /* 自动时长：从每镜 text 里抽最后一次"5秒/Ns/S05"标注，写入 store.shots[i].sec。
     旧包 autoDurBtn 同款：未标注的镜保持原值。 */
  const autoDurBtn = h("button", {
    class: "btn btn-primary",
    title: "识别每镜文案里的「N秒/5s/S05」标注并自动设定该镜时长（未标注的镜保持原值）",
    onclick: () => {
      const shots = (s.get().shots || []).slice();
      if (!shots.length) { ctx.toast("先拆分分镜", true); return; }
      const durAll = h("input", { class: "input", type: "number", step: 0.5, value: 5, min: 0.5, style: { width: 70, padding: "4px 8px", marginRight: 6 } });
      const apply = (defaultSec) => {
        let hit = 0, miss = 0;
        const found = [];
        shots.forEach((sh, i) => {
          let v = null;
          DUR_RE.lastIndex = 0;
          let m;
          while ((m = DUR_RE.exec(String(sh.text || "")))) {
            const num = parseFloat(m[1]);
            if (Number.isFinite(num) && num > 0) v = num;
          }
          if (v != null) {
            v = Math.min(120, Math.max(0.5, Math.round(v * 2) / 2));
            shots[i] = { ...sh, sec: v };
            found.push(`镜${i + 1}=${v}s`);
            hit++;
          } else {
            if (!Number.isFinite(shots[i].sec)) shots[i] = { ...sh, sec: Number(defaultSec) || 5 };
            miss++;
          }
        });
        s.set({ shots });
        if (hit) ctx.toast(`已按脚本设定 ${hit} 镜时长：${found.join("、")}${miss ? `（${miss} 镜未标注，保持原值）` : ""}`);
        else ctx.toast("分镜文案里没有找到「N秒」标注", true);
      };
      // 弹小对话框问「未标注的镜用几秒兜底」，默认 5（与旧包顶部"默认秒/镜"一致）
      const dlg = h("div", { style: "position:fixed;inset:0;z-index:2147483001;background:rgba(2,4,9,.82);display:flex;align-items:center;justify-content:center;" });
      const box = h("div", { style: "background:linear-gradient(180deg,#16213a,#101a30);border:1px solid #31446a;border-radius:12px;padding:18px 22px;display:flex;flex-direction:column;gap:12px;min-width:320px;box-shadow:0 16px 50px rgba(0,0,0,.6);" });
      box.appendChild(h("div", { style: { fontSize: 14, color: "#ffcf6b", fontWeight: 700 } }, "⏱ 自动识别每镜时长"));
      box.appendChild(h("div", { style: { fontSize: 11.5, color: "#9fb0c6" } }, "脚本里没标 N秒 的镜 → 用下值兜底"));
      const row = h("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, h("span", { style: { fontSize: 12, color: "#9fb0c6" } }, "兜底秒数"), durAll, h("span", { style: { fontSize: 11, color: "#9fb0c6" } }, "秒"));
      box.appendChild(row);
      const btns = h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
        h("button", { class: "btn", onclick: () => dlg.remove() }, "取消"),
        h("button", { class: "btn btn-primary", onclick: () => { dlg.remove(); apply(Number(durAll.value) || 5); } }, "识别"));
      box.appendChild(btns);
      dlg.appendChild(box);
      dlg.onclick = (e) => { if (e.target === dlg) dlg.remove(); };
      document.body.appendChild(dlg);
      durAll.focus();
    },
  }, "⏱ 自动匹配时长");

  /* 把 store.shots 全镜时长统一设成默认秒 */
  const unifyDurBtn = h("button", {
    class: "btn",
    title: "把当前所有分镜时长设为同一个秒数（覆盖）",
    onclick: () => {
      const shots = (s.get().shots || []).slice();
      if (!shots.length) { ctx.toast("先拆分分镜", true); return; }
      const secAll = h("input", { class: "input", type: "number", step: 0.5, value: 5, min: 0.5, style: { width: 70, padding: "4px 8px", marginRight: 6 } });
      const dlg = h("div", { style: "position:fixed;inset:0;z-index:2147483001;background:rgba(2,4,9,.82);display:flex;align-items:center;justify-content:center;" });
      const box = h("div", { style: "background:linear-gradient(180deg,#16213a,#101a30);border:1px solid #31446a;border-radius:12px;padding:18px 22px;display:flex;flex-direction:column;gap:12px;min-width:320px;box-shadow:0 16px 50px rgba(0,0,0,.6);" });
      box.appendChild(h("div", { style: { fontSize: 14, color: "#ffcf6b", fontWeight: 700 } }, "⏱ 设全镜统一时长"));
      box.appendChild(h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        h("span", { style: { fontSize: 12, color: "#9fb0c6" } }, "每镜秒数"), secAll, h("span", { style: { fontSize: 11, color: "#9fb0c6" } }, "秒")));
      const btns = h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
        h("button", { class: "btn", onclick: () => dlg.remove() }, "取消"),
        h("button", { class: "btn btn-primary", onclick: () => {
          const v = Math.min(120, Math.max(0.5, Math.round((Number(secAll.value) || 5) * 2) / 2));
          shots.forEach((sh, i) => { shots[i] = { ...sh, sec: v }; });
          s.set({ shots });
          dlg.remove();
          ctx.toast(`已设全部 ${shots.length} 镜为 ${v}s`);
        } }, "设全镜"));
      box.appendChild(btns);
      dlg.appendChild(box);
      dlg.onclick = (e) => { if (e.target === dlg) dlg.remove(); };
      document.body.appendChild(dlg);
      secAll.focus();
    },
  }, "⏱ 设全镜统一");

  /* 复制本镜：旧包 duplicateShot 同款——把整张卡的 text/refs/sec/复制成新分镜 */
  const duplicateShot = (i) => {
    const shots = (s.get().shots || []).slice();
    const src = shots[i];
    if (!src) { ctx.toast("没有可复制的分镜", true); return; }
    const newIdx = shots.length + 1;
    const copy = { ...src, index: newIdx, text: src.text || "", prompt: src.text || "" };
    shots.splice(i + 1, 0, copy);
    shots.forEach((sh, k) => { sh.index = k + 1; });
    // refMap 同步复制
    const rm = (s.get().refMap || []).slice();
    const srcRef = rm[i];
    rm.splice(i + 1, 0, srcRef ? [...srcRef] : []);
    rm.forEach((arr, k) => { if (arr && arr.length) arr.forEach((r) => { r._origIdx = k; }); });
    s.set({ shots, refMap: rm });
    ctx.toast(`已复制第${i + 1}镜 → 第${i + 2}镜`);
  };

  /* 切分到导演台：把当前 store.shots + store.refMap 落盘到 _plan.json，
     时间线面板会自动接管（store.subscribe → renderAll）。
     旧包 applySplitToDirector 同款语义。 */
  const applyBtn = h("button", {
    class: "btn btn-primary",
    title: "把当前分镜 + 素材引用写入时间线（落盘 _plan.json，可逐镜出片）",
    onclick: async () => {
      const shots = s.get().shots || [];
      if (!shots.length) { ctx.toast("先拆分分镜", true); return; }
      applyBtn.disabled = true; applyBtn.textContent = "写入中…";
      try {
        // 确保每镜 sec 都有值（默认 5s）
        const normalized = shots.map((sh) => ({ ...sh, sec: Number.isFinite(sh.sec) && sh.sec > 0 ? sh.sec : 5 }));
        // splitStamp：时间线收到后会丢掉旧的每镜缓存 → 按 store.refMap 重新自动导入本镜素材
        s.set({ shots: normalized, splitStamp: Date.now() });
        await ctx.api.savePlan(s.get().folder || "mrboard_next", normalized);
        ctx.toast(`✓ 已切分 ${normalized.length} 镜到导演台（落盘 _plan.json）`);
        ctx.switchTo("timeline");
      } catch (e) {
        ctx.toast("切分到导演台失败: " + e.message, true);
      } finally {
        applyBtn.disabled = false; applyBtn.textContent = "→ 切分到导演台";
      }
    },
  }, "→ 切分到导演台");

  const patchText = (i, text) => {
    const shots = (s.get().shots || []).slice();
    if (shots[i]) {
      shots[i] = { ...shots[i], text, prompt: text };
      s.set({ shots });
    }
  };

  const patchSec = (i, sec) => {
    const shots = (s.get().shots || []).slice();
    if (shots[i]) {
      shots[i] = { ...shots[i], sec: sec > 0 ? sec : undefined };
      s.set({ shots });
    }
  };

  const render = () => {
    clear(wrap);
    const st = s.get();
    const shots = st.shots || [];
    const refMap = st.refMap || [];
    if (!shots.length) {
      wrap.appendChild(h("div", { class: "empty" }, "先用「剧本」面板拆分分镜，或点「匹配引用」自动按收藏/文件名匹配"));
      stat.textContent = "";
      return;
    }
    const matchedTotal = refMap.reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
    const withSec = shots.filter((x) => x.sec != null).length;
    stat.textContent = `共 ${shots.length} 镜 · ${withSec} 镜已设时长 · 已命中 ${matchedTotal} 个素材引用`;

    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i];
      // 防御：refMap[i] 必须是数组（后端 split/analyze 均返回平面数组；
      // 若是对象（旧包 {refs,audios,videos} 格式）则安全降级为空）
      if (!Array.isArray(refMap[i])) refMap[i] = [];
      const ta = createMentionEditor(ctx, {
        initial: sh.text || "",
        favorites: favs,
        getAssets: () => assets,
        chosen: (chosenMaps[i] = chosenMaps[i] || {}),
        onCommit: (text) => patchText(i, text),
        onChoose: (name, rel) => {
          const refMap = (s.get().refMap || []).slice();
          const arr = (refMap[i] = refMap[i] || []).filter((x) => x.name !== name);
          const f = favs.find((x) => x.name === name && x.rel === rel);
          arr.push({ name, rel, kind: (f && f.kind) || "image", category: (f && f.category) || "asset" });
          refMap[i] = arr;
          s.set({ refMap });
        },
      });
      ta.style.minHeight = "78px";
      ta.style.fontSize = "12px";

      // 每镜时长输入（实时写回 store.shots[i].sec）
      const secI = h("input", {
        class: "input", type: "number", min: 0.5, max: 120, step: 0.5,
        value: sh.sec ?? "",
        placeholder: "秒", style: { width: 64, padding: "3px 8px" },
        oninput: (e) => { const v = parseFloat(e.target.value); patchSec(i, Number.isFinite(v) && v > 0 ? v : 0); },
      });
      const secBox = h("span", { class: "row", style: { gap: 4 } }, h("span", { class: "muted", style: { fontSize: 11 } }, "时长"), secI, h("span", { class: "muted", style: { fontSize: 11 } }, "秒"));

      const matched = refMap[i] || [];
      // 引用 chip：image 显示缩略图，video/audio 显示图标
      const chips = matched.map((m) => {
        const url = m.rel ? relToViewUrl(m.rel) : "";
        let inner;
        if (url && m.kind === "image") {
          // 缩略图加载失败 → 隐藏破图
          inner = h("img", { src: url, style: { width: 26, height: 26, objectFit: "cover", borderRadius: 4 }, alt: m.name, loading: "lazy", onerror: "this.style.display='none'" });
        } else if (m.kind === "video") {
          inner = h("span", { style: { fontSize: 14, color: "#a78bfa", width: 26, textAlign: "center" } }, "▶");
        } else if (m.kind === "audio") {
          inner = h("span", { style: { fontSize: 14, color: "#f0937a", width: 26, textAlign: "center" } }, "♪");
        } else {
          inner = h("span", { style: { fontSize: 11 } }, "?");
        }
        return h(
          "span",
          {
            class: "tag " + (m.category === "role" ? "image" : m.category === "scene" ? "video" : m.category === "audio" ? "audio" : "asset"),
            style: { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px" },
            title: (m.rel || "") + (m.category ? " · " + m.category : ""),
          },
          inner, m.name
        );
      });

      // 缺图警告（仅在该镜存在 <Picture/Audio/Video N> 但 N 不在文件夹时显示——目前前端不知道哪些缺，由 store 注入缺失计数）
      const missingForShot = sh.missingCount || 0;
      const missingTag = missingForShot > 0
        ? h("span", { style: { fontSize: 10.5, color: "#ffb4b4", padding: "1px 6px", border: "1px solid #a33", borderRadius: 4 } }, `⚠ 缺素材 ${missingForShot}`)
        : null;
      // 字数统计（旧包 shotCnt 同款）
      const cntLbl = h("span", { class: "muted", style: { fontSize: 10.5 } }, `${(sh.text || "").length}字`);

      // ✏️ 放大编辑器（旧包 openBigEditor 同款）：全屏大文本域改本镜文案，
      // 保存后写回并重渲染（token 高亮随 mention editor 重建）
      const bigEditBtn = h("button", {
        class: "abtn", style: { position: "static", width: 22, height: 22 },
        title: "打开放大编辑器：改这一镜文案",
        onclick: (e) => {
          e.stopPropagation();
          const overlay = h("div", { style: "position:fixed;inset:0;z-index:2147483002;background:rgba(2,4,9,.86);display:flex;align-items:center;justify-content:center;" });
          const box = h("div", { style: "width:860px;max-width:94vw;height:72vh;background:linear-gradient(180deg,#16213a,#101a30);border:1px solid #31446a;border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.6);" });
          box.appendChild(h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("b", { style: { fontSize: 14, color: "#ffcf6b" } }, `✏️ 镜头 ${sh.index} · 文案编辑`),
            h("span", { class: "muted", style: { fontSize: 11 } }, "支持 <Picture/Audio/Video N> 标记与 N秒 时长标注，输入 @ 可插入素材名"),
            h("div", { class: "mx-spacer" }),
            cntLbl.cloneNode(true)));
          const bigMention = createMentionEditor(ctx, {
            initial: sh.text || "",
            favorites: favs,
            getAssets: () => assets,
            chosen: {},
            onCommit: (text) => { /* overlay 内不自动 commit，由保存按钮显式处理 */ },
          });
          bigMention.style.flex = "1 1 auto";
          bigMention.style.fontSize = "13.5px";
          bigMention.style.lineHeight = "1.8";
          bigMention.style.fontFamily = "inherit";
          bigMention.style.overflowY = "auto";
          box.appendChild(bigMention);
          box.appendChild(h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
            h("button", { class: "btn", onclick: () => overlay.remove() }, "取消"),
            h("button", { class: "btn btn-primary", onclick: () => {
              const text = bigMention.value();
              patchText(i, text);
              // 放大编辑器里改了「N秒」标注 → 同步本镜时长（旧包 autoDurBtn 行为）
              let last = null;
              DUR_RE.lastIndex = 0;
              let m;
              while ((m = DUR_RE.exec(text))) {
                const v = parseFloat(m[1]);
                if (Number.isFinite(v) && v > 0) last = v;
              }
              if (last != null) patchSec(i, Math.min(120, Math.max(0.5, Math.round(last * 2) / 2)));
              overlay.remove();
              render();
              ctx.toast(`镜头 ${sh.index} 已更新${last != null ? ` · 时长 ${last}s` : ""}`);
            } }, "保存")));
          overlay.appendChild(box);
          overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };
          document.body.appendChild(overlay);
          bigMention.focus();
        },
      }, "✏️");

      wrap.appendChild(
        h("div", { class: "scard" },
          h("div", { class: "hd" },
            h("span", { class: "no" }, sh.index),
            h("span", { style: { fontSize: 12, fontWeight: 600, color: "#bcd3ea" } }, `第 ${sh.index} 镜`),
            cntLbl,
            h("span", { class: "muted", style: { fontSize: 11 } }, matched.length ? `已命中 ${matched.length}` : "未匹配"),
            missingTag,
            secBox,
            h("div", { class: "mx-spacer" }),
            bigEditBtn,
            h("button", { class: "abtn", style: { position: "static", width: 22, height: 22 }, title: "复制本镜（→ 新分镜）", onclick: (e) => { e.stopPropagation(); duplicateShot(i); render(); } }, "⧉"),
            h("button", { class: "abtn del", style: { position: "static", width: 22, height: 22 }, title: "删除本镜", onclick: (e) => {
              e.stopPropagation();
              const arr = (s.get().shots || []).slice();
              arr.splice(i, 1);
              arr.forEach((x, k) => { x.index = k + 1; });
              const rm = (s.get().refMap || []).slice();
              rm.splice(i, 1);
              Object.keys(chosenMaps).forEach((k) => delete chosenMaps[k]);
              s.set({ shots: arr, refMap: rm });
              render();
            } }, "✕")),
          h("div", { class: "bd" }, ta),
          h("div", { class: "ft" },
            chips.length ? chips : h("span", { class: "muted", style: { fontSize: 11 } }, "未命中引用 —— 点「匹配引用」自动按收藏/文件名匹配"))));
    }
  };

  /* 🎯 匹配素材并引用（旧包「匹配引用」同款）
     旧包语义：候选 = 「N=文件名」引用表 → 素材库/收藏；关键词 = 文件名去后缀；
     在正文命中的关键词**后面**插入 <Picture N>/<Audio N>/<Video N>；写回正文。
     本包增强：候选也吃素材库索引（含 video/audio 子目录），并按素材自身 kind 归类。 */
  const matchBtn = h(
    "button",
    {
      class: "btn",
      title: "按素材文件名关键词匹配每镜并插入 <Picture/Audio/Video N>（旧包「匹配引用」同款，会写回正文）",
      onclick: async () => {
        const shots = s.get().shots || [];
        if (!shots.length) { ctx.toast("请先拆分分镜", true); return; }
        matchBtn.disabled = true;
        matchBtn.textContent = "匹配中…";
        try {
          const cands = await loadFavs();
          const res = await ctx.api.assetMatch({
            texts: shots.map((sh) => sh.text || ""),
            markers: shots.map((sh) => sh.marker || ""),
            folder: s.get().folder || "mrboard_next",
            imgRef: s.get().imgRef || "",
            audRef: s.get().audRef || "",
            vidRef: s.get().vidRef || "",
            candidates: cands || [],
            apply: true,
          });
          const mods = res.modifiedTexts || [];
          if (!mods.length) { ctx.toast("没有可匹配的素材", true); return; }
          // 写回正文（保留 marker/sec/linkNext 等其它字段）
          const next = shots.map((sh, i) => (
            typeof mods[i] === "string" && mods[i] !== (sh.text || "")
              ? { ...sh, text: mods[i], prompt: mods[i] }
              : sh
          ));
          const inserted = (res.stats && res.stats.inserted) || 0;
          const un = res.unmatched || [];
          // refMap 也要跟着重算（时间线按 refMap 自动导入素材；标记插完后必须同步）
          const rm = (s.get().refMap || []).slice();
          (res.perShot || []).forEach((arr, i) => { rm[i] = Array.isArray(arr) ? arr : []; });
          s.set({ shots: next, refMap: rm, splitStamp: Date.now() });
          const miss = un.length ? `；未匹配 ${un.length}：${un.slice(0, 4).map((u) => `${u.fileName}（${u.reason}）`).join("、")}${un.length > 4 ? "…" : ""}` : "";
          ctx.toast(`✓ 已插入 ${inserted} 个引用标记${miss}`, un.length > 0 && inserted === 0);
          render();
        } catch (e) {
          ctx.toast("匹配失败: " + e.message, true);
        } finally {
          matchBtn.disabled = false;
          matchBtn.textContent = "🎯 匹配素材并引用";
        }
      },
    },
    "🎯 匹配素材并引用"
  );

  /* 🔍 语义匹配（按收藏名匹配，只算命中不插入标记）—— 保留给「角色名已在正文里」的场景 */
  const analyzeBtn = h(
    "button",
    {
      class: "btn",
      title: "按收藏库名字匹配每镜（语义匹配，只算命中不插入标记）",
      onclick: async () => {
        const shots = s.get().shots || [];
        if (!shots.length) { ctx.toast("请先拆分分镜", true); return; }
        analyzeBtn.disabled = true;
        analyzeBtn.textContent = "匹配中…";
        try {
          const cands = await loadFavs();
          if (!cands.length) { ctx.toast("收藏库为空 —— 先在「素材库」收藏角色/场景素材", true); return; }
          const res = await ctx.api.analyze(
            shots.map((sh) => sh.text || ""),
            cands
          );
          // 重新匹配了引用 → 也属于"分镜方案变了"，时间线要按新 refMap 重新自动导入素材
          s.set({ refMap: res.perShot || [], splitStamp: Date.now() });
          ctx.toast(`匹配完成：命中 ${(res.used || []).length} 个素材（${(res.perShot || []).length} 镜）`);
          render();
        } catch (e) {
          ctx.toast("匹配失败: " + e.message, true);
        } finally {
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = "🔍 语义匹配";
        }
      },
    },
    "🔍 语义匹配"
  );

  const saveBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        try {
          await ctx.api.savePlan(ctx.store.get().folder || "mrboard_next", ctx.store.get().shots || []);
          ctx.toast("分镜计划已落盘 _plan.json");
        } catch (e) {
          ctx.toast("保存失败: " + e.message, true);
        }
      },
    },
    "💾 保存计划"
  );
  const clearShots = () => {
    if (!(ctx.store.get().shots || []).length) return;
    if (!confirm("清空所有分镜？")) return;
    ctx.store.set({ shots: [], refMap: [] });
    Object.keys(chosenMaps).forEach((k) => delete chosenMaps[k]);
  };
  const clearBtn = h("button", { class: "btn", style: { borderColor: "#a33" }, onclick: clearShots }, "🗑 清空");

  const el = h("div", { class: "col" },
    h("div", { class: "card", style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } },
      autoDurBtn, unifyDurBtn, applyBtn, matchBtn, analyzeBtn, saveBtn, clearBtn,
      h("div", { class: "mx-spacer" }),
      stat),
    wrap);
  stat.style.color = "#ffcf6b";

  /* 用户正在编辑时不重排（保焦点）；在别的面板改动后 / 切回本面板时重渲染 */
  ctx.store.subscribe(() => {
    if (wrap.contains(document.activeElement)) return;
    render();
  });
  render();
  return { el, update: render };
}