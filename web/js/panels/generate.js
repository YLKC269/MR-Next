// panels/generate.js — Krea2 四模式生图面板（参考旧包 mrboard_assetgen.js）
// ✨ 文生图 t2i / 🖼 图生图 i2i / 🧩 参考生图 ref（1-3 张参考） / ✏️ 编辑图 edit（Krea2 edit LoRA）
import { h, clear } from "../core/dom.js";
import { relToViewUrl } from "../core/api.js";
import { PROMPT_PRESETS } from "../core/assetgen_presets.js";
import { lightbox } from "../core/ui.js";
import { SIZES, DEFAULT_SIZE_INDEX, CUSTOM_SIZE_INDEX, resolveSize } from "../core/sizes.js";
import { createLoraControls } from "./lora_controls.js";
import { createLoraPicker } from "./lora_picker.js";

const MODES = [
  { key: "t2i",  label: "✨ 文生图",   hint: "文字直接生图" },
  { key: "i2i",  label: "🖼 图生图",   hint: "以一张原图为基础重绘（可调重绘幅度）" },
  { key: "ref",  label: "🧩 参考生图", hint: "用 1-3 张收藏图作为角色/风格/场景参考" },
  { key: "edit", label: "✏️ 编辑图",   hint: "按指令编辑原图（自动加载 Krea2 编辑 LoRA）" },
];

const PLACEHOLDER = {
  t2i: "描述要生成的资产：角色 / 场景 / 道具…（越具体越好：外观、材质、颜色、光线、构图）",
  i2i: "描述改动方向（重绘幅度越大越自由）…",
  ref: "描述要生成的画面（可结合参考图的风格 / 角色 / 场景要素）…",
  edit: "写编辑指令，例如：把背景改成夜晚的城市街道，保持人物不变",
};

const PRESET_LS_KEY = "mrnext.assetgen_prompts.v1";

export function createGeneratePanel(ctx) {
  /* ---------- 状态 ---------- */
  const state = {
    mode: "t2i",
    srcRel: "",        // i2i/edit 原图（input 相对路径）
    srcName: "",
    refRels: [],       // ref 1-3 张
    strength: 0.6,     // i2i 重绘幅度
    editLora: "",      // edit 编辑 LoRA
    running: false,
  };

  /* ---------- 4 模式 Tab ---------- */
  const tabBar = h("div", { class: "row", style: { gap: 0, marginBottom: 6, flexWrap: "nowrap" } });
  const tabEls = {};
  for (const m of MODES) {
    const b = h("button", {
      class: "btn",
      style: { flex: "1 1 0", minWidth: 0, padding: "6px 2px", fontSize: 12, fontWeight: 600 },
      title: m.hint,
      onclick: () => { state.mode = m.key; renderMode(); },
    }, m.label);
    tabEls[m.key] = b;
    tabBar.appendChild(b);
  }

  /* ---------- 提示词 / 模型 / 参数 ---------- */
  const promptTa = h("textarea", { class: "textarea", placeholder: PLACEHOLDER.t2i });
  promptTa.style.minHeight = "150px";

  const modelSel = h("select", { class: "select" });
  const teSel = h("select", { class: "select" });
  const vaeSel = h("select", { class: "select" });
  // 隐藏保留：lora_controls 会往这个 id 注入列表（不再直接给用户看，用户走下面的「选择 LoRA」浮层）
  const editLoraSel = h("select", { class: "select", id: "mrnext-gen-lorasel", style: { display: "none" } });
  // 🎚 点击弹出 LoRA 列表（点一项即用，可多选 + 调强度）——对所有生图模式生效
  const loraPicker = createLoraPicker(ctx, { onChange: () => { try { loadConfig(); } catch (_) {} } });
  const sizeSel = h("select", { class: "select", style: { width: "auto" } },
    ...SIZES.map(([label], i) => h("option", { value: String(i) }, label)));
  // 自定义宽高输入（选「自定义」档位时显示）
  const wIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 74, display: "none" }, value: 768 });
  const hIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 74, display: "none" }, value: 1344 });
  const syncCustomVisible = () => {
    const isCustom = Number(sizeSel.value) === CUSTOM_SIZE_INDEX;
    wIn.style.display = isCustom ? "" : "none";
    hIn.style.display = isCustom ? "" : "none";
  };
  // 尺寸与公共前缀面板「生成设定图」尺寸联动（共享 store.genSize / genW / genH）
  sizeSel.value = String(ctx.store.get().genSize ?? DEFAULT_SIZE_INDEX);
  wIn.value = ctx.store.get().genW || 768;
  hIn.value = ctx.store.get().genH || 1344;
  sizeSel.onchange = () => {
    ctx.store.set({ genSize: Number(sizeSel.value) || 0 });
    syncCustomVisible();
  };
  wIn.oninput = () => { ctx.store.set({ genW: Number(wIn.value) || 0 }); };
  hIn.oninput = () => { ctx.store.set({ genH: Number(hIn.value) || 0 }); };
  ctx.store.subscribe((st) => {
    if (st.genSize != null && String(st.genSize) !== sizeSel.value) sizeSel.value = String(st.genSize);
    if (st.genW != null && Number(wIn.value) !== Number(st.genW)) wIn.value = st.genW;
    if (st.genH != null && Number(hIn.value) !== Number(st.genH)) hIn.value = st.genH;
    syncCustomVisible();
  });
  syncCustomVisible();
  // 步数：初始值从 store 恢复（与流水线/设定图生成联动），变化时写回
  const stepsIn = h("input", { class: "input", type: "number", min: 2, max: 20, value: ctx.store.get().genSteps || 8, style: { width: 64 }, title: "采样步数（与「流水线」/「剧本」设定图联动）" });
  stepsIn.oninput = () => { ctx.store.set({ genSteps: Number(stepsIn.value) || 8 }); };
  const seedIn = h("input", { class: "input", type: "number", value: -1, style: { width: 88 }, title: "-1 = 每次随机" });
  const qtySel = h("select", { class: "select", style: { width: "auto" } },
    ...[1, 2, 3, 4].map((n) => h("option", { value: String(n) }, n + " 张")));
  const note = h("div", { class: "muted" }, "加载模型…");
  const grid = h("div", { class: "grid cols-auto", style: { gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))" } });
  const selSet = new Set();
  const lastRels = [];

  /* ---------- 画质增强（仅 t2i / ref 生效） ---------- */
  const enhanceCk = h("input", { type: "checkbox", style: { accentColor: "#f5ca57", width: 16, height: 16, cursor: "pointer" } });
  const enhanceLbl = h("label", { class: "row", style: { gap: 5, cursor: "pointer", padding: "4px 6px" } },
    enhanceCk,
    h("span", { style: { fontSize: 12, color: "#ffd98f", fontWeight: 600 }, title: "首采后画质增强：内置精修（1.5x latent 放大 + 二次采样）或 SeedVR2 一步修复超分" }, "✨ 画质增强"));
  const engSel = h("select", { class: "select", style: { width: "auto", padding: "3px 7px", fontSize: 11.5 } },
    h("option", { value: "builtin" }, "内置精修（hires-fix）"),
    h("option", { value: "seedvr2" }, "SeedVR2 修复超分"),
    h("option", { value: "vosr2" }, "⚡ VOSR2 一步超分（快、省显存）"));
  // 放大倍率（所有引擎通用：内置精修 scale_by / SeedVR2 目标短边 / VOSR2 upscale）
  const enhScaleIn = h("input", { class: "input", type: "number", min: 1, max: 4, step: 0.5, value: 2,
    style: { width: 56, padding: "3px 6px", fontSize: 11.5 },
    title: "放大倍率：内置精修=latent 放大倍数；SeedVR2=目标短边=原短边×倍率；VOSR2=整数放大倍数（1–4）" });
  const engHint = h("span", { class: "muted", style: { fontSize: 10.5 } }, "");

  /* ---------- 实时预览框（生图过程中按 pid 轮询采样预览图，完成后显示成品大图）---------- */
  const previewImg = h("img", { style: { width: "100%", height: "100%", objectFit: "contain", display: "none" } });
  const previewPh = h("div", { class: "muted", style: { fontSize: 12, textAlign: "center", whiteSpace: "pre-line" } }, "生图时\n这里实时预览");
  const previewBox = h("div", { class: "card", style: { flex: "0 1 400px", minWidth: 300, display: "flex", flexDirection: "column", gap: 8, alignSelf: "stretch" } },
    h("b", { style: { fontSize: 12.5, color: "#7ee2a0" } }, "实时预览"),
    h("div", { class: "gen-preview" }, previewPh, previewImg));

  let previewTimer = null;
  const stopPreview = () => { if (previewTimer) { clearInterval(previewTimer); previewTimer = null; } };
  const showPreviewImg = (url) => { previewImg.src = url; previewImg.style.display = "block"; previewPh.style.display = "none"; };
  const startPreviewPolling = (pid) => {
    stopPreview();
    previewImg.style.display = "none";
    previewPh.textContent = "生成中…";
    previewPh.style.display = "flex";
    const tick = () => {
      const url = ctx.api.previewLatestUrl(pid);
      const probe = new Image();
      probe.onload = () => showPreviewImg(url);
      probe.onerror = () => {};
      probe.src = url;
    };
    tick();
    previewTimer = setInterval(tick, 1200);
  };

  /* ---------- 模式专属 UI ---------- */

  // 原图行（i2i / edit）
  const srcThumb = h("img", { style: { width: 48, height: 48, objectFit: "cover", borderRadius: 6, border: "1px solid #31446a", display: "none", background: "#111" } });
  const srcInfo = h("span", { class: "muted", style: { fontSize: 11, flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "未选原图（必选）");
  const pickSrcBtn = h("button", { class: "btn", style: { padding: "4px 10px", fontSize: 11.5 } }, "📂 选原图");
  const strengthInp = h("input", { class: "input", type: "number", min: "0.05", max: "0.95", step: "0.05", value: "0.6", style: { width: 70 }, title: "i2i 重绘幅度（denoise）：越大越自由" });
  const srcRow = h("div", { class: "row", style: { display: "none", marginTop: 6, gap: 8, flexWrap: "wrap" } },
    srcThumb, srcInfo, pickSrcBtn,
    h("span", { class: "row", style: { gap: 4, display: "none" } },
      h("span", { class: "muted", style: { fontSize: 11 } }, "重绘"), strengthInp),
  );
  const strengthWrap = srcRow.children[3];

  // 参考图行（ref）
  const refThumbs = h("div", { class: "row", style: { gap: 6, flexWrap: "wrap" } });
  const refHint = h("span", { class: "muted", style: { fontSize: 11 } });
  const addRefBtn = h("button", { class: "btn", style: { padding: "4px 10px", fontSize: 11.5 } }, "➕ 添加参考（收藏库）");
  const clearRefBtn = h("button", { class: "btn", style: { padding: "4px 10px", fontSize: 11.5 } }, "清空");
  const refRow = h("div", { class: "row", style: { display: "none", marginTop: 6, gap: 8, alignItems: "flex-start", flexWrap: "wrap" } },
    h("div", { class: "col", style: { flex: "1 1 auto", minWidth: 0, gap: 4 } },
      h("div", { class: "row", style: { gap: 6, alignItems: "center" } },
        refHint, h("div", { class: "mx-spacer" }), addRefBtn, clearRefBtn),
      refThumbs),
  );

  // 编辑 LoRA 行（edit）
  // 旧的行内单选已由「🎚 选择 LoRA」浮层取代（保留元素隐藏，避免破坏注入逻辑）

  function setSrcRel(rel, name) {
    state.srcRel = String(rel || "").trim();
    state.srcName = name || (state.srcRel.split("/").pop() || state.srcRel);
    if (state.srcRel) {
      srcThumb.style.display = "";
      srcThumb.src = relToViewUrl(state.srcRel);
      srcInfo.textContent = state.srcName;
      srcInfo.classList.remove("muted");
      srcInfo.style.color = "#dbe6f4";
    } else {
      srcThumb.style.display = "none";
      srcThumb.src = "";
      srcInfo.textContent = "未选原图（必选）";
      srcInfo.style.color = "";
      srcInfo.classList.add("muted");
    }
  }

  function renderRefs() {
    clear(refThumbs);
    refHint.textContent = `参考图 ${state.refRels.length}/3（来自收藏库）`;
    if (!state.refRels.length) {
      refThumbs.appendChild(h("span", { class: "muted", style: { fontSize: 11 } }, "尚未添加参考图"));
    } else {
      for (const rel of state.refRels) {
        const nm = rel.split("/").pop() || rel;
        const box = h("div", { class: "row", style: { position: "relative", gap: 4, alignItems: "center" } });
        const img = h("img", { src: relToViewUrl(rel), onerror: "this.style.display='none'", style: { width: 44, height: 44, objectFit: "cover", borderRadius: 5, border: "1px solid #31446a" } });
        const rm = h("button", { class: "btn", style: { padding: "1px 6px", fontSize: 10 }, onclick: (ev) => {
          ev.stopPropagation();
          state.refRels = state.refRels.filter((r) => r !== rel);
          renderRefs();
        } }, "✕");
        box.append(img, rm);
        refThumbs.appendChild(box);
      }
    }
  }

  /* ---------- 收藏库选择弹层（i2i/edit 选原图 + ref 添加参考） ---------- */
  function openFavPicker(opts) {
    // opts: { multi, onPick(rel,name) }
    const overlay = h("div", {
      style: "position:fixed;inset:0;z-index:2147483600;background:rgba(2,4,9,.82);display:flex;align-items:center;justify-content:center;",
      onclick: (e) => { if (e.target === overlay) overlay.remove(); },
    });
    const panel = h("div", { style: "width:560px;max-width:92vw;max-height:80vh;background:#0e1a2c;border:1px solid #31446a;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px;box-shadow:0 20px 60px rgba(0,0,0,.7);" });
    panel.appendChild(h("div", { class: "row" },
      h("b", { style: { fontSize: 13, color: "#ffcf6b" } }, opts.multi ? "🧩 选择参考图（收藏库 · 可多选）" : "📁 选择原图（收藏库）"),
      h("div", { class: "mx-spacer" }),
      h("button", { class: "btn", style: { padding: "3px 9px", fontSize: 11.5 }, onclick: () => overlay.remove() }, "✕ 关闭"),
    ));
    const list = h("div", { style: "overflow-y:auto;flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;padding:4px;" });
    panel.appendChild(list);
    const status = h("div", { class: "muted", style: { fontSize: 11, minHeight: 16 } });
    panel.appendChild(status);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    (async () => {
      try {
        const r = await ctx.api.favorites();
        const all = (r.items || []).filter((i) => i.kind === "image" && i.rel);
        if (!all.length) {
          status.textContent = "收藏库还没有图片素材（去「素材」或「素材预览」点 ★ 收藏）";
          return;
        }
        const picked = new Set(opts.multi ? state.refRels : (state.srcRel ? [state.srcRel] : []));
        for (const f of all) {
          const card = h("div", {
            style: { cursor: "pointer", borderRadius: 8, overflow: "hidden", border: "2px solid transparent", position: "relative", background: "#101d33" },
            onclick: () => {
              if (opts.multi) {
                if (picked.has(f.rel)) picked.delete(f.rel);
                else if (picked.size >= 3) { ctx.toast("参考图最多 3 张", true); return; }
                else picked.add(f.rel);
                if (picked.has(f.rel)) card.style.borderColor = "#ffd166";
                else card.style.borderColor = "transparent";
              } else {
                opts.onPick(f.rel, f.name || f.rel);
                overlay.remove();
              }
            },
          });
          if (picked.has(f.rel)) card.style.borderColor = "#ffd166";
          const im = h("img", { src: relToViewUrl(f.rel), loading: "lazy", onerror: "this.style.display='none'", style: { width: "100%", aspectRatio: "1/1", objectFit: "cover", display: "block" } });
          card.appendChild(im);
          const cap = h("div", { style: "font-size:11px;color:#dbe6f4;padding:4px 6px;background:rgba(0,0,0,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" }, f.name || f.rel.split("/").pop());
          card.appendChild(cap);
          list.appendChild(card);
        }
        if (opts.multi) {
          const actions = h("div", { class: "row" },
            h("div", { class: "mx-spacer" }),
            h("span", { class: "muted", style: { fontSize: 11 } }, () => `已选 ${picked.size}/3`),
            h("button", { class: "btn btn-primary", style: { padding: "4px 12px" }, onclick: () => {
              const rels = [...picked];
              state.refRels = rels;
              renderRefs();
              overlay.remove();
              ctx.toast(`已选 ${rels.length} 张参考图`);
            } }, "确定使用"),
          );
          panel.appendChild(actions);
        }
      } catch (e) {
        status.textContent = "读取收藏库失败: " + e.message;
      }
    })();
  }

  pickSrcBtn.onclick = (e) => { e.stopPropagation(); openFavPicker({ onPick: (rel, name) => { setSrcRel(rel, name); ctx.toast("已选原图：" + name); } }); };
  addRefBtn.onclick = (e) => { e.stopPropagation(); openFavPicker({ multi: true }); };
  clearRefBtn.onclick = () => { state.refRels = []; renderRefs(); };
  strengthInp.onchange = () => {
    const v = Math.max(0.05, Math.min(0.95, parseFloat(strengthInp.value) || 0.6));
    strengthInp.value = String(v);
    state.strength = v;
  };

  /* ---------- 模式渲染 ---------- */
  function renderMode() {
    for (const m of MODES) {
      const b = tabEls[m.key];
      const active = state.mode === m.key;
      b.style.background = active ? "linear-gradient(180deg,#ffd166,#ff9f1a)" : "rgba(20,32,52,.6)";
      b.style.color = active ? "#3a2200" : "#c9d6ec";
      b.style.boxShadow = active ? "0 0 10px rgba(255,176,32,.3)" : "none";
    }
    srcRow.style.display = (state.mode === "i2i" || state.mode === "edit") ? "flex" : "none";
    strengthWrap.style.display = state.mode === "i2i" ? "flex" : "none";
    refRow.style.display = state.mode === "ref" ? "flex" : "none";
    // 增强仅对 t2i / ref 有意义（i2i/edit 输出尺寸=原图，避免放大越界）
    const canEnhance = state.mode === "t2i" || state.mode === "ref";
    enhanceLbl.style.display = canEnhance ? "flex" : "none";
    engSel.style.display = canEnhance ? "" : "none";
    engHint.style.display = canEnhance ? "" : "none";
    if (canEnhance && !enhanceCk.checked) enhanceCk.checked = true;
    if (!canEnhance) enhanceCk.checked = false;
    // 尺寸仅 t2i / ref 有意义（i2i/edit 输出尺寸=原图）
    sizeSel.parentElement && (sizeSel.style.display = canEnhance || state.mode === "t2i" || state.mode === "ref" ? "" : "none");
    // i2i/edit 隐藏张数（输出尺寸已定，不批量同尺寸重绘没意义）
    qtySel.parentElement && (qtySel.style.display = canEnhance ? "" : "none");
    promptTa.placeholder = PLACEHOLDER[state.mode] || PLACEHOLDER.t2i;
  }

  /* ---------- 加载模型配置（diffusion / text_encoder / vae / loras） ---------- */
  const fillSelect = (sel, list, cur) => {
    clear(sel);
    for (const n of list || []) {
      if (!n) continue;
      const o = h("option", { value: n }, n);
      if (n === cur) o.selected = true;
      sel.appendChild(o);
    }
  };
  const loadConfig = async () => {
    try {
      // LoRA 列表走 LoRA 控件（共享 store.useLora + loraFolder）
      const useLora = !!ctx.store.get().useLora;
      const extra = (ctx.store.get().loraFolder || "").trim();
      const r = await ctx.api.assetgenConfig(useLora, extra);
      const d = r.defaults || {};
      fillSelect(modelSel, r.diffusion || [], d.model);
      // 恢复用户上次在生图面板选的模型（store.genModel，流水线/设定图同款联动）
      const gm = ctx.store.get().genModel;
      if (gm && r.diffusion && r.diffusion.includes(gm)) modelSel.value = gm;
      fillSelect(teSel, r.text_encoders || [], d.text_encoder);
      fillSelect(vaeSel, r.vaes || [], d.vae);
      const loras = r.loras || [];
      clear(editLoraSel);
      editLoraSel.appendChild(h("option", { value: "" }, useLora ? "（自动选取）" : "（未启用 LoRA）"));
      for (const n of loras) {
        const o = h("option", { value: n }, n);
        if (n === d.edit_lora && useLora) o.selected = true;
        editLoraSel.appendChild(o);
      }
      const picked = loraPicker.get();
      state.editLora = picked.length ? picked[0].name : ((d.edit_lora && useLora) ? d.edit_lora : "");
      const m = modelSel.value || d.model || "";
      const te = teSel.value || d.text_encoder || "-";
      const va = vaeSel.value || d.vae || "-";
      note.textContent = m
        ? `就绪 · 模型 ${m} · TE ${te} · VAE ${va} · LoRA ${useLora ? (extra || "默认") + `(${loras.length})` : "关"}`
        : "未在 models/diffusion_models 找到 Krea2 模型，将使用占位图";
    } catch (e) {
      note.textContent = "模型配置加载失败: " + e.message;
    }
  };
  // LoRA 控件（与公共前缀 / 流水线面板 共享 useLora/loraFolder + 自动 reload）
  const loraCtl = createLoraControls(ctx, {
    inline: true,
    selectIds: ["mrnext-gen-lorasel"],
    onChange: () => loadConfig(),
  });
  // 启动时按 store 当前值加载 LoRA 列表
  setTimeout(() => loadConfig(), 0);
  // 监听 useLora / loraFolder 变化 → 重新拉模型配置
  ctx.store.subscribe((st) => {
    if ("useLora" in st || "loraFolder" in st) loadConfig();
  });
  modelSel.onchange = () => {
    ctx.store.set({ genModel: modelSel.value }); // 与「流水线」/「剧本」设定图联动
    note.textContent = "就绪 · " + modelSel.value;
  };
  editLoraSel.onchange = () => { state.editLora = editLoraSel.value; };

  (async () => {
    try {
      const st = await ctx.api.seedvr2Status();
      if (st.available) engHint.textContent = "SeedVR2 可用";
      else {
        const o = [...engSel.options].find((x) => x.value === "seedvr2");
        if (o) { o.textContent += "（模型缺失）"; o.disabled = true; }
        engHint.textContent = "SeedVR2 模型缺失，用内置精修";
      }
    } catch (_) { engHint.textContent = ""; }
    // VOSR2 就绪探测：模型/节点缺失时把选项标灰并说明原因
    try {
      const v = await ctx.api.vosr2Status();
      if (!v.ok) {
        const o = [...engSel.options].find((x) => x.value === "vosr2");
        if (o) { o.textContent = "VOSR2（模型/节点缺失）"; o.disabled = true; }
        if (!engHint.textContent) engHint.textContent = String(v.why || "").slice(0, 70);
      }
    } catch (_) { /* 探测失败不影响其它引擎 */ }
  })();

  /* ---------- 提示词预设 ---------- */
  const loadCustom = () => { try { return JSON.parse(localStorage.getItem(PRESET_LS_KEY) || "[]"); } catch (_) { return []; } };
  const presetBtn = h("button", { class: "btn", style: { padding: "3px 9px", fontSize: 11.5 }, title: "打开角色三视图等提示词预设，点「使用」填入", onclick: () => openPresetModal() }, "📋 提示词预设");

  function openPresetModal() {
    const all = [...PROMPT_PRESETS, ...loadCustom().map((p) => ({ ...p, custom: true }))];
    const overlay = h("div", { style: "position:fixed;inset:0;z-index:2147483000;background:rgba(2,4,9,.82);display:flex;align-items:center;justify-content:center;" });
    const panel = h("div", { style: "width:640px;max-width:92vw;max-height:80vh;background:#101a2a;border:1px solid #31446a;border-radius:14px;padding:16px;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6);" });
    const head = h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:10px;" },
      h("b", { style: { fontSize: 14, color: "#ffcf6b" } }, "📋 提示词预设"),
      h("span", { class: "muted", style: { fontSize: 11 } }, "内置 14 条（角色三视图 + 分镜九宫格故事板）· 点「使用」填入"),
      h("div", { class: "mx-spacer" }),
      h("button", { class: "btn", style: { padding: "4px 10px" }, onclick: () => { const name = prompt("预设名称："); if (!name) return; const txt = promptTa.value; if (!txt) { ctx.toast("先写好提示词再存", true); return; } const list = loadCustom(); list.push({ name, prompt: txt }); localStorage.setItem(PRESET_LS_KEY, JSON.stringify(list.slice(0, 100))); ctx.toast("已保存预设「" + name + "」"); } }, "＋ 存当前为预设"),
      h("button", { class: "btn", style: { padding: "4px 10px" }, onclick: () => overlay.remove() }, "✕"));
    const list = h("div", { style: "overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:6px;" });
    for (const p of all) {
      const row = h("div", { style: "display:flex;align-items:center;gap:8px;padding:8px;background:#121c2d;border:1px solid #24344e;border-radius:9px;" },
        h("div", { style: "flex:1;min-width:0;" }, h("div", { style: "font-size:12.5px;color:#dbe6f4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" }, p.name),
          h("div", { class: "muted", style: { fontSize: 10.5 } }, (p.prompt || "").slice(0, 60) + "…")),
        p.custom ? h("button", { class: "btn", style: { padding: "3px 8px", fontSize: 11, borderColor: "#a33" }, onclick: () => { const list2 = loadCustom().filter((x) => x.name !== p.name); localStorage.setItem(PRESET_LS_KEY, JSON.stringify(list2)); ctx.toast("已删除"); overlay.remove(); openPresetModal(); } }, "✕") : null,
        h("button", { class: "btn btn-primary", style: { padding: "4px 10px" }, onclick: () => {
          promptTa.value = p.prompt;
          // 预设可自带出图尺寸（如分镜九宫格：竖屏 9:16 1152×2048）→ 一并套用，避免用户忘了改尺寸
          if (p.w && p.h) {
            ctx.store.set({ genSize: CUSTOM_SIZE_INDEX, genW: Number(p.w), genH: Number(p.h) });
            wIn.value = p.w; hIn.value = p.h; sizeSel.value = String(CUSTOM_SIZE_INDEX);
            ctx.toast(`已填入「${p.name}」并套用尺寸 ${p.w}×${p.h}`);
          } else {
            ctx.toast("已填入预设「" + p.name + "」，请替换【角色描述】");
          }
          overlay.remove();
        } }, "使用"));
      list.appendChild(row);
    }
    panel.append(head, list);
    overlay.appendChild(panel);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }

  /* ---------- 生成按钮 ---------- */
  const genBtn = h(
    "button",
    {
      class: "btn btn-primary",
      onclick: async () => {
        if (!promptTa.value.trim()) { ctx.toast("请填写提示词", true); return; }
        const mode = state.mode;
        if ((mode === "i2i" || mode === "edit") && !state.srcRel) {
          ctx.toast("请先选原图", true);
          return;
        }
        if (mode === "ref" && state.refRels.length < 1) {
          ctx.toast("请至少添加 1 张参考图", true);
          return;
        }
        const [width, height] = resolveSize(sizeSel.value, ctx.store.get().genW, ctx.store.get().genH);
        const myPid = "gen_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        startPreviewPolling(myPid);
        genBtn.disabled = true; genBtn.textContent = "生成中…（可能数十秒）";
        try {
          const payload = {
            mode,
            prompt: promptTa.value,
            folder: ctx.store.get().folder || "mrboard_next",
            model: modelSel.value,
            seed: Number(seedIn.value) || -1,
            width, height,
            steps: Number(stepsIn.value) || 8,
            batch: Number(qtySel.value) || 1,
            enhance: enhanceCk.checked ? engSel.value : "off",
            enhance_scale: Number(enhScaleIn.value) || 2,
            pid: myPid,
          };
          // LoRA：所有模式统一带上（后端已把 LoRA 链接到 t2i/i2i/ref/edit 的公共路径）
          const loraSel = loraPicker.get();
          if (loraSel.length) {
            payload.loras = loraSel;
            payload.lora_folder = (ctx.store.get().loraFolder || "").trim();
          }
          if (mode === "i2i" || mode === "edit") {
            payload.src_rel = state.srcRel;
            if (mode === "i2i") payload.strength = state.strength;
            if (mode === "edit") payload.edit_lora = state.editLora || "";
          }
          if (mode === "ref") {
            payload.ref_rels = state.refRels.slice();
          }
          if (teSel.value) payload.text_encoder = teSel.value;
          if (vaeSel.value) payload.vae = vaeSel.value;
          const res = await ctx.api.generate(payload);
          note.textContent = res.note || `完成 ${res.count || 1} 张`;
          if (res.loras_dropped && res.loras_dropped.length) {
            const un = res.loras_unloadable || [];
            ctx.toast(un.length
              ? `这些 LoRA 无法加载、已被忽略：${un.join("、")}。请放进 models/loras/ 或在 extra_model_paths.yaml 登记其文件夹后重启`
              : `这些 LoRA 没找到、已被忽略：${res.loras_dropped.join("、")}`, true);
          }
          lastRels.length = 0;
          lastRels.push(...(res.rels || (res.rel ? [res.rel] : [])));
          selSet.clear();
          renderResults(lastRels);
          if (lastRels.length) showPreviewImg(relToViewUrl(lastRels[0]));
          else { previewPh.textContent = "暂无预览"; previewPh.style.display = "flex"; previewImg.style.display = "none"; }
          ctx.toast(`已生成 ${res.count || 1} 张（${mode}）`, false);
        } catch (e) {
          previewPh.textContent = "生成失败"; previewPh.style.display = "flex"; previewImg.style.display = "none";
          ctx.toast("生成失败: " + e.message, true);
        }
        finally { stopPreview(); genBtn.disabled = false; genBtn.textContent = "🎨 生图"; }
      },
    },
    "🎨 生图"
  );

  /* ---------- 结果网格 ---------- */
  const renderResults = (rels) => {
    clear(grid);
    for (const rel of rels) {
      const card = h("div", { class: "mcard" + (selSet.has(rel) ? " chk" : ""), title: rel });
      card.appendChild(h("div", { class: "th" }, h("img", { src: relToViewUrl(rel), loading: "lazy", alt: rel, onerror: "this.style.display='none'" })));
      card.appendChild(h("div", { class: "veil" }));
      card.appendChild(h("div", { class: "mn", title: rel }, rel.split("/").pop()));
      const favB = h("button", { class: "abtn", title: "收藏到收藏库", onclick: async (e) => {
        e.stopPropagation();
        const nm = prompt("收藏名称（角色/场景名）：", rel.split("/").pop().replace(/\.[^.]+$/, ""));
        if (!nm) return;
        try { await ctx.api.favoriteAdd([{ name: nm, rel, kind: "image", category: "role" }]); ctx.toast("已收藏「" + nm + "」"); }
        catch (err) { ctx.toast("收藏失败: " + err.message, true); }
      } }, "★");
      card.appendChild(h("div", { class: "act" }, favB));
      const ck = h("input", { type: "checkbox", style: { position: "absolute", bottom: 6, right: 6, width: 16, height: 16, cursor: "pointer", zIndex: 2 } });
      ck.checked = selSet.has(rel);
      ck.onclick = (e) => { e.stopPropagation(); };
      ck.onchange = (e) => { e.stopPropagation(); if (ck.checked) selSet.add(rel); else selSet.delete(rel); card.classList.toggle("chk", ck.checked); enhanceSelBtn.textContent = selSet.size ? `✨ 再次增强(${selSet.size})` : "✨ 再次增强"; };
      card.appendChild(ck);
      card.onclick = (ev) => {
        ev.stopPropagation();
        const idx = rels.indexOf(rel);
        const urls = rels.map((r) => relToViewUrl(r));
        lightbox(urls[Math.max(0, idx)], "image", { gallery: urls, index: Math.max(0, idx) });
      };
      grid.appendChild(card);
    }
  };

  /* ---------- 二次画质增强（对勾选结果图） ---------- */
  const enhanceSelBtn = h("button", {
    class: "btn", style: { padding: "4px 10px", fontSize: 11.5 },
    title: "对勾选的结果图做二次画质增强（引擎见「画质增强」下拉）",
    onclick: async () => {
      if (!selSet.size) { ctx.toast("先勾选要增强的结果图", true); return; }
      const engine = engSel.value || "builtin";
      if (engine === "builtin" && !modelSel.value) { ctx.toast("未选 Krea2 模型，无法增强（SeedVR2 引擎无需模型）", true); return; }
      enhanceSelBtn.disabled = true; enhanceSelBtn.textContent = "增强中…";
      try {
        const res = await ctx.api.enhanceImage({
          rels: [...selSet],
          folder: ctx.store.get().folder || "mrboard_next",
          model: modelSel.value,
          seed: Number(seedIn.value) || -1,
          steps: Number(stepsIn.value) || 8,
          engine,
          scale: Number(enhScaleIn.value) || 2,
        });
        note.textContent = res.note || `二次增强 ${res.count || 0} 张`;
        ctx.toast(`已增强 ${res.count || 0} 张`);
        selSet.clear();
        renderResults(res.rels || []);
      } catch (e) { ctx.toast("增强失败: " + e.message, true); }
      finally { enhanceSelBtn.disabled = false; enhanceSelBtn.textContent = "✨ 再次增强"; }
    },
  }, "✨ 再次增强");

  /* ---------- 拼装（左右：左=操作+结果，右=实时预览） ---------- */
  // 左右分栏（强制不换行）：左=提示词/参数/结果图片区，右=实时预览大正方形
  const el = h("div", { class: "row", style: { alignItems: "stretch", flexWrap: "nowrap", gap: 12, maxWidth: "1180px" } },
    h("div", { class: "col", style: { flex: "1 1 auto", minWidth: 0 } },
      h("div", { class: "card" },
        tabBar,
        h("div", { class: "row", style: { marginBottom: 6 } },
          h("b", { style: { fontSize: 13, color: "#c9a6ff" } }, "🎨 生图"),
          h("div", { class: "mx-spacer" }),
          presetBtn,
          h("span", { class: "muted", style: { fontSize: 11 } }, "Krea2 真实扩散 · 失败自动占位"),
        ),
        promptTa,
        srcRow, refRow,
        h("div", { class: "row", style: { marginTop: 6, flexWrap: "wrap", gap: 4, padding: "6px 8px", background: "rgba(255,207,107,.06)", border: "1px solid #5e3e10", borderRadius: 7 } },
          h("span", { style: { fontSize: 11, color: "#ffcf6b", fontWeight: 700 } }, "⚡ LoRA"),
          loraCtl.row,
          loraPicker.row,
        ),
        h("div", { class: "row", style: { marginTop: 8, flexWrap: "wrap" } },
          h("span", { class: "muted" }, "模型"), modelSel,
          h("span", { class: "muted" }, "尺寸"), sizeSel, wIn, h("span", { class: "muted", style: { fontSize: 11 } }, "×"), hIn,
          h("span", { class: "muted" }, "步数"), stepsIn,
          h("span", { class: "muted" }, "种子"), seedIn,
          h("span", { class: "muted" }, "张数"), qtySel,
          enhanceLbl, engSel, h("span", { class: "muted", style: { fontSize: 11 } }, "倍率"), enhScaleIn, engHint,
          h("div", { class: "mx-spacer" }),
          genBtn, h("button", { class: "btn", onclick: loadConfig }, "刷新模型")),
        note),
      h("div", { class: "card" },
        h("div", { class: "row", style: { marginBottom: 4 } },
          h("b", { style: { fontSize: 12.5, color: "#7ee2a0" } }, "生图结果"),
          h("span", { class: "muted", style: { fontSize: 11 } }, "勾选后可二次增强"),
          h("div", { class: "mx-spacer" }),
          enhanceSelBtn),
        h("div", { style: { marginTop: 8 } }, grid))),
    previewBox);
  // loadConfig 已在 LoRA 控件定义后 setTimeout 启动
  renderMode();
  renderRefs();
  return { el };
}
