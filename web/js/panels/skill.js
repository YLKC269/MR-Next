// panels/skill.js — Skill 提示词优化（本地 Qwen）+ 旧包对齐：优化指令预设（H3 官方 task 模板）
import { h, clear } from "../core/dom.js";

// 优化指令预设（对齐旧包 prompt_enhancer 的官方 task 模板方向，覆盖 5 种出片模式）
const INSTRUCTION_PRESETS = [
  { v: "", label: "通用优化（按 Skill 规范）", hint: "" },
  { v: "按 MiniMax H3 官方文生视频模板扩写：先一句话概括画面主体与整体风格；再按时间线分段描述镜头（每段含景别、主体动作、运镜、光影）；结尾补充音效与配乐描述。全程电影级写实，无文字、无 logo、无水印。", label: "T2V 文生视频（H3 官方模板）" },
  { v: "按 MiniMax H3 官方首帧生视频模板扩写：明确「首帧图即画面起始帧」，先描述首帧已有的主体、构图与风格；再写镜头如何从该静态帧自然动起来（运镜、主体动作、光影变化、环境运动），保证首帧与后续画面主体/风格严格一致。", label: "I2V 首帧生视频（首帧图→视频）" },
  { v: "按 MiniMax H3 官方首尾帧生视频模板扩写：分别描述「首帧 = 画面起点」「尾帧 = 画面终点」两帧的主体、构图与状态；再写中间过渡如何自然演进（动作、运镜、转场），首尾帧主体与风格必须一致，中间画面不突兀。", label: "FL2V 首尾帧生视频（首+尾→视频）" },
  { v: "按 MiniMax H3 官方尾帧生视频模板扩写：明确「尾帧图即画面终点帧」，先描述尾帧的主体、构图与风格；再反推整段视频如何演进到该定格帧（运镜、动作、光影收束），尾帧与全片主体/风格严格一致。", label: "L2V 尾帧生视频（尾帧图→视频）" },
  { v: "按 MiniMax H3 官方参考生视频模板扩写：用「<Picture N> 是…」定义每张参考图身份；用「<Subject N> 锁定为…」描述主体关键特征；再写摘要、保留分析与详细分镜。强调参考图与生成画面主体/风格严格一致。", label: "R2V 参考生视频（主体+参考图）" },
  { v: "扩写为角色三视图设定：明确年龄、脸型、五官、发型发色、肤色、服装、配饰；强调同一角色正面/侧面/背面三视角严格一致（脸型、身材、服饰、发色不漂移）；纯色背景、均匀柔光、无文字无水印。", label: "角色三视图（跨视角一致）" },
  { v: "拆成带时间点的分镜脚本：每镜标注 [起-止秒] + 景别 + 镜头运动 + 画面内容 + 角色动作；保持角色外貌、场景、光影跨镜连贯一致；镜头之间衔接自然。", label: "分镜脚本（时间线分段）" },
];

export function createSkillPanel(ctx) {
  const skillsWrap = h("div", { class: "col" });
  const modelStatus = h("div", { class: "muted" }, "检测中…");
  const output = h("textarea", {
    class: "textarea sk-grow",
    readonly: true,
    placeholder: "优化结果将显示在这里",
  });

  let folder = "";
  let skills = [];
  let skillContent = "";
  let modelCurrent = "";

  // ---------- 技能库 ----------
  const skillSel = h("select", { class: "select" });
  const skillPreview = h("textarea", {
    class: "textarea",
    readonly: true,
    style: { minHeight: "90px", fontSize: "11.5px", color: "#9aa6b3" },
    placeholder: "选中技能后预览其规范…",
  });
  skillSel.onchange = async () => {
    const id = skillSel.value;
    if (!id) return;
    try {
      const r = await ctx.api.readSkill(folder, id);
      skillContent = r.content || "";
      skillPreview.value =
        skillContent.slice(0, 320) + (skillContent.length > 320 ? "\n…（完整规范用于优化）" : "");
    } catch (e) {
      ctx.toast("读取技能失败: " + e.message, true);
    }
  };

  const refreshSkills = async (showToast) => {
    try {
      const r = await ctx.api.scanSkills();
      folder = r.folder || "";
      skills = r.skills || [];
      clear(skillSel);
      if (!skills.length) {
        skillSel.appendChild(h("option", { value: "" }, "（该目录无技能）"));
      } else {
        skillSel.appendChild(h("option", { value: "" }, "不套用技能（通用优化）"));
        for (const s of skills) {
          skillSel.appendChild(h("option", { value: s.id }, s.name));
        }
      }
      if (showToast) ctx.toast(`技能库：${skills.length} 个（${folder}）`);
    } catch (e) {
      ctx.toast("技能库扫描失败: " + e.message, true);
    }
  };

  // ---------- 模型 ----------
  const modelSel = h("select", { class: "select", style: { flex: "1 1 200px" } });
  const famSel = h("select", { class: "select", style: { width: "auto" } });
  const mmprojSel = h("select", { class: "select mmproj-sel", style: { width: "auto" } });
  let families = [];
  let modelFolder = "";   // 自定义模型文件夹（空 = 默认 models/LLM）

  // 高级设置参数（模型加载参数 + 采样参数，选模型时自动套最优值，可手动改）
  const adv = { n_ctx: 16384, n_gpu_layers: -1, temperature: 0.7, top_p: 0.9, top_k: 20, max_tokens: 2048, think: false };
  const numIn = (val, w, step, min, max) => h("input", {
    class: "input", type: "number", value: val, step, min, max,
    style: { width: w, padding: "3px 6px", fontSize: 11.5 },
  });
  const ctxIn = numIn(adv.n_ctx, 96, 1024, 2048);
  const gpuIn = numIn(adv.n_gpu_layers, 76, 1, -1);
  const tempIn = numIn(adv.temperature, 76, 0.05, 0);
  const topPIn = numIn(adv.top_p, 76, 0.05, 0);
  const topKIn = numIn(adv.top_k, 76, 1, 0);
  const maxTokIn = numIn(adv.max_tokens, 92, 128, 256);
  const thinkCk = h("input", { type: "checkbox", style: { accentColor: "#ffd166", width: 15, height: 15 } });
  ctxIn.oninput = () => { adv.n_ctx = Number(ctxIn.value) || 16384; };
  gpuIn.oninput = () => { adv.n_gpu_layers = Number(gpuIn.value); };
  tempIn.oninput = () => { adv.temperature = Number(tempIn.value); };
  topPIn.oninput = () => { adv.top_p = Number(topPIn.value); };
  topKIn.oninput = () => { adv.top_k = Number(topKIn.value); };
  maxTokIn.oninput = () => { adv.max_tokens = Number(maxTokIn.value) || 2048; };
  thinkCk.onchange = () => { adv.think = thinkCk.checked; };
  const applyAdv = () => {
    ctxIn.value = adv.n_ctx; gpuIn.value = adv.n_gpu_layers; tempIn.value = adv.temperature;
    topPIn.value = adv.top_p; topKIn.value = adv.top_k; maxTokIn.value = adv.max_tokens; thinkCk.checked = adv.think;
  };
  const advancedBox = h("div", { class: "col", style: { gap: 6, marginTop: 6, padding: "8px 10px", background: "rgba(0,0,0,.18)", border: "1px solid rgba(120,170,255,.14)", borderRadius: 9 } },
    h("div", { class: "row", style: { gap: 10 } },
      h("span", { class: "muted", style: { fontSize: 11 } }, "最大上下文"), ctxIn,
      h("span", { class: "muted", style: { fontSize: 11 } }, "GPU层"), gpuIn,
      h("label", { class: "row", style: { gap: 4, fontSize: 11, cursor: "pointer" } }, thinkCk, "思考模式")),
    h("div", { class: "row", style: { gap: 10 } },
      h("span", { class: "muted", style: { fontSize: 11 } }, "温度"), tempIn,
      h("span", { class: "muted", style: { fontSize: 11 } }, "top_p"), topPIn,
      h("span", { class: "muted", style: { fontSize: 11 } }, "top_k"), topKIn,
      h("span", { class: "muted", style: { fontSize: 11 } }, "最大token"), maxTokIn),
    h("div", { class: "row", style: { gap: 10 } },
      h("span", { class: "muted", style: { fontSize: 11 } }, "mmproj 视觉模型"), mmprojSel,
      h("span", { class: "muted", style: { fontSize: 10.5 } }, "切换 LLM 时自动对应")));

  // 📁 模型文件夹（空 = 默认 models/LLM；右键恢复默认）
  const folderBtn = h("button", {
    class: "btn", style: { padding: "4px 10px", fontSize: 11.5 },
    title: "选择模型文件夹（默认 models/LLM）\n点击：选一个装 GGUF 的文件夹\n右键：恢复默认 models/LLM",
    onclick: async () => {
      try {
        const r = await ctx.api.nativePick({ kind: "folder", title: "选择 LLM 模型文件夹（GGUF）" });
        if (r.cancel || !(r.paths || []).length) return;
        modelFolder = r.paths[0];
        folderBtn.textContent = "📁 " + modelFolder.slice(-24);
        await refreshModels(true);
      } catch (e) { ctx.toast("选择文件夹失败: " + e.message, true); }
    },
  }, "📁 模型文件夹");
  folderBtn.oncontextmenu = async (ev) => {
    ev.preventDefault();
    modelFolder = "";
    folderBtn.textContent = "📁 模型文件夹";
    await refreshModels(true);
    ctx.toast("已恢复默认模型文件夹 models/LLM");
  };

  const refreshModels = async (showToast) => {
    try {
      const r = await ctx.api.skillsModels(modelFolder);
      modelCurrent = r.current || "";
      clear(modelSel);
      if (!r.models.length) {
        modelSel.appendChild(h("option", { value: "" }, modelFolder ? "（该文件夹无模型）" : "（models/LLM 无模型）"));
        modelStatus.textContent = modelFolder ? "所选文件夹下没有 GGUF 模型" : "本地无 Qwen 模型 → 先放 .gguf 到 models/LLM/";
        return;
      }
      for (const m of r.models) modelSel.appendChild(h("option", { value: m }, m));
      modelSel.value = r.models.includes(modelCurrent) ? modelCurrent : r.models[0];
      families = r.families || [];
      clear(famSel);
      for (const f of families) famSel.appendChild(h("option", { value: f }, f));
      // 填充 mmproj 视觉模型列表
      const mmprojList = (r.mmproj && r.mmproj.length) ? r.mmproj : ["无"];
      clear(mmprojSel);
      for (const mp of mmprojList) mmprojSel.appendChild(h("option", { value: mp }, mp));
      modelStatus.textContent = r.loaded
        ? `已加载：${modelCurrent}${modelFolder ? `（${modelFolder}）` : ""}`
        : `可用 ${r.models.length} 个模型 · 未加载`;
      // 选模型即自动套最优参数（最大上下文/采样/mmproj）
      if (modelSel.value) {
        try {
          const rec = await ctx.api.skillsRecommend(modelSel.value, modelFolder);
          const p = rec.params || {};
          adv.n_ctx = p.n_ctx || adv.n_ctx; adv.n_gpu_layers = p.n_gpu_layers ?? adv.n_gpu_layers;
          adv.temperature = p.temperature ?? adv.temperature; adv.top_p = p.top_p ?? adv.top_p;
          adv.top_k = p.top_k ?? adv.top_k; adv.max_tokens = p.max_tokens || adv.max_tokens; adv.think = !!p.think;
          if (p.mmproj != null && [...mmprojSel.options].some((o) => o.value === p.mmproj)) mmprojSel.value = p.mmproj;
          applyAdv();
        } catch (_) { /* 推荐失败保留手动值 */ }
      }
      if (showToast) ctx.toast(`模型列表已刷新${modelFolder ? `（${modelFolder}）` : ""}`);
    } catch (e) {
      modelStatus.textContent = "模型列表失败: " + e.message;
    }
  };
  // 切换模型 → 重新套推荐参数（含 mmproj）并自动加载
  modelSel.onchange = async () => {
    try {
      const rec = await ctx.api.skillsRecommend(modelSel.value, modelFolder);
      const p = rec.params || {};
      adv.n_ctx = p.n_ctx || adv.n_ctx; adv.n_gpu_layers = p.n_gpu_layers ?? adv.n_gpu_layers;
      adv.temperature = p.temperature ?? adv.temperature; adv.top_p = p.top_p ?? adv.top_p;
      adv.top_k = p.top_k ?? adv.top_k; adv.max_tokens = p.max_tokens || adv.max_tokens; adv.think = !!p.think;
      if (p.mmproj != null && [...mmprojSel.options].some((o) => o.value === p.mmproj)) mmprojSel.value = p.mmproj;
      applyAdv();
      ctx.toast(`已套用 ${modelSel.value} 最优参数（上下文 ${adv.n_ctx}${p.mmproj && p.mmproj !== "无" ? ` · mmproj ${p.mmproj}` : ""}）`);
    } catch (_) {}
    if (autoLoadCk.checked) await doLoad();
  };
  const autoLoadCk = h("input", { type: "checkbox", style: { accentColor: "#ffd166", width: 15, height: 15 } });
  autoLoadCk.checked = true;   // 默认选模型即自动加载
  let doLoad = async () => {};

  doLoad = async () => {
    if (!modelSel.value) { ctx.toast("无可加载模型", true); return; }
    loadBtn.disabled = true;
    loadBtn.textContent = "加载中…（首载 1-5 分钟）";
    try {
      // folder 支持自定义模型目录；opts 带高级设置（最大上下文 / GPU 层 / 思考模式等）
      // mmproj：用户选了具体视觉投影模型就用它；选「无」或空 → 后端自动按模型版本匹配
      await ctx.api.loadSkillModel({
        model: modelSel.value,
        family: famSel.value,
        folder: modelFolder,
        mmproj: (mmprojSel.value && mmprojSel.value !== "无") ? mmprojSel.value : "",
        opts: {
          n_ctx: adv.n_ctx,
          n_gpu_layers: adv.n_gpu_layers,
          think: adv.think,
          reasoning_effort: "xhigh",
        },
      });
      modelCurrent = modelSel.value;
      modelStatus.textContent = `已加载：${modelCurrent}（上下文 ${adv.n_ctx}${mmprojSel.value && mmprojSel.value !== "无" ? ` · mmproj ${mmprojSel.value}` : ""}）`;
      ctx.toast("模型加载完成（已套用高级设置）");
    } catch (e) {
      ctx.toast("加载失败: " + e.message, true);
    } finally {
      loadBtn.disabled = false;
      loadBtn.textContent = "加载模型";
    }
  };
  const loadBtn = h("button", { class: "btn btn-primary", onclick: () => doLoad() }, "加载模型");

  const unloadBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        try {
          await ctx.api.unloadSkillModel();
          modelStatus.textContent = "模型已卸载";
          ctx.toast("已卸载");
        } catch (e) {
          ctx.toast("卸载失败: " + e.message, true);
        }
      },
    },
    "卸载"
  );

  // ---------- 推理过程预览（右下角）：显示模型思考内容（思考模式开启时才有） ----------
  const reasonOut = h("textarea", {
    class: "textarea sk-grow",
    readonly: true,
    placeholder: "模型推理过程会显示在这里（需在「② 本地模型 → 思考模式」勾选后才有内容）",
    style: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11.5, lineHeight: 1.6, color: "#bcd3ea" },
  });
  const reasonHint = h("span", { class: "muted", style: { fontSize: 10.5 } }, "思考模式开启时才有内容");

  // ---------- 优化 ----------
  const input = h("textarea", {
    class: "textarea sk-grow",
    placeholder: "待优化的提示词 / 文案…",
  });

  // 接续推理开关：输出被 token 上限截断时自动续写，直到完整（参考旧包）
  const contCk = h("input", { type: "checkbox", style: { accentColor: "#ffd166", width: 15, height: 15 } });
  contCk.checked = true;
  const roundsIn = h("input", { class: "input", type: "number", value: 3, min: 1, max: 6, step: 1,
    style: { width: 62, padding: "3px 6px", fontSize: 11.5 } });

  const optBtn = h(
    "button",
    {
      class: "btn btn-primary",
      onclick: async () => {
        if (!input.value.trim()) {
          ctx.toast("请填写待优化内容", true);
          return;
        }
        optBtn.disabled = true;
        optBtn.textContent = contCk.checked ? "优化中…（接续推理）" : "优化中…";
        output.value = "";
        try {
          const r = await ctx.api.optimizePrompt({
            text: input.value,
            folder,
            skillId: skillSel.value || "",
            skillContent: skillSel.value ? skillContent : "",
            instruction: instrSel.value || "",
            // 采样参数走「高级设置」
            params: {
              temperature: adv.temperature,
              top_p: adv.top_p,
              top_k: adv.top_k,
              max_tokens: adv.max_tokens,
            },
            // 接续推理：截断自动续写直到完整
            continue_: contCk.checked,
            max_rounds: Number(roundsIn.value) || 3,
          });
          output.value = r.text || "";
          // 推理过程预览：有就显示，没有给出可操作的原因提示（避免用户以为是坏了）
          const rsn = (r.reasoning || "").trim();
          if (rsn) {
            reasonOut.value = rsn;
            reasonHint.textContent = `推理过程 ${rsn.length} 字`;
            reasonHint.style.color = "#7ee2a0";
          } else {
            reasonOut.value = "";
            reasonHint.textContent = thinkCk.checked ? "本次模型未返回推理内容" : "未开启「思考模式」→ 勾选后重试可见推理过程";
            reasonHint.style.color = "#ffcf6b";
          }
          ctx.toast(contCk.checked ? "优化完成（已接续到完整）" : "优化完成");
        } catch (e) {
          ctx.toast(e.message || "优化失败", true);
        } finally {
          optBtn.disabled = false;
          optBtn.textContent = "开始优化";
        }
      },
    },
    "开始优化"
  );

  // 优化指令预设（对齐旧包官方 task 模板）
  const instrSel = h("select", { class: "select", style: { width: "auto" } },
    ...INSTRUCTION_PRESETS.map((p) => h("option", { value: p.v }, p.label)));

  const useBtn = h(
    "button",
    {
      class: "btn",
      onclick: () => {
        if (!output.value) {
          ctx.toast("暂无优化结果", true);
          return;
        }
        ctx.store.set({ script: output.value });
        ctx.switchTo("script");
      },
    },
    "结果 → 剧本"
  );

  const copyBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(output.value);
          ctx.toast("已复制");
        } catch (e) {
          ctx.toast("复制失败: " + e.message, true);
        }
      },
    },
    "复制"
  );

  // 从优化结果里识别资产定义（<Picture N>/<Subject N>/<Style 全局>/「角色 N - 名字」），
  // 生成对应角色三视图 / 场景图并入库——每个 skills 模板优化后都能一键产出资产。
  const genAssetBtn = h(
    "button",
    {
      class: "btn btn-primary",
      title: "从优化结果里识别资产定义，生成对应角色三视图/场景图并加入收藏库",
      onclick: async () => {
        const text = (output.value || "").trim();
        if (!text) { ctx.toast("暂无优化结果", true); return; }
        genAssetBtn.disabled = true; genAssetBtn.textContent = "生成中…";
        const log = [];
        try {
          const plan = await ctx.api.assetPlan(text, "");
          const roles = plan.roles || [];
          const scenes = plan.scenes || [];
          const style = (plan.style || "").trim();
          const jobs = [
            ...roles.map((r) => ({ name: (r && (r.name || r.full)) || "", desc: (r && r.desc) || "", category: "role", w: 768, h: 1344, kw: "角色三视图设定卡" })),
            ...scenes.map((s) => ({ name: (s && (s.name || s.full)) || "", desc: (s && s.desc) || "", category: "scene", w: 1344, h: 768, kw: "场景概念设定图" })),
          ].filter((j) => j.name);
          if (!jobs.length) {
            ctx.toast("优化结果里没识别到角色/场景定义（需含 <Picture N>：描述 / <Subject N> 名字 / 「角色 N - 名字：描述」等标记）", true);
            return;
          }
          const ms = await ctx.api.models();
          const model = (ms.defaults && ms.defaults.model) || (ms.diffusion || [])[0] || "";
          const fav = await ctx.api.favorites();
          const have = new Set((fav.items || []).map((i) => i.name + "|" + i.category));
          let ok = 0;
          for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            if (have.has(job.name + "|" + job.category)) { log.push(`跳过（已收藏）· ${job.name}`); continue; }
            const base = `${job.kw}：${job.name}${job.desc ? "，" + job.desc : ""}。`;
            const prompt = job.category === "role"
              ? (style ? `${base}整体风格与背景：${style}。同一角色正面/侧面/背面三视角并排，全身完整，跨视角严格一致，电影级超高清。`
                       : `${base}纯白干净棚拍背景，同一角色正面/侧面/背面三视角并排，全身完整，跨视角严格一致，电影级超高清。`)
              : (style ? `${base}整体风格与背景：${style}。电影级构图，画面干净，无人物，超高清。`
                       : `${base}电影级构图，写实光影，画面干净，无人物，超高清。`);
            try {
              const res = await ctx.api.generate({
                prompt, folder: ctx.store.get().folder || "mrboard_next", model, seed: i,
                width: job.w, height: job.h, steps: 8,
                loras: (ctx.store.get().loras || []), lora_folder: (ctx.store.get().loraFolder || ""),
              });
              if (res.ok) {
                await ctx.api.favoriteAdd([{ name: job.name, rel: res.rel, kind: "image", category: job.category }]);
                ok += 1; log.push(`✓ ${job.name}（${job.category}）`);
              } else log.push(`✗ ${job.name}: ${res.error || "失败"}`);
            } catch (e) { log.push(`✗ ${job.name}: ${e.message}`); }
          }
          ctx.toast(`资产生成完成：${ok}/${jobs.length}`);
          output.value = output.value + "\n\n【资产生成日志】\n" + log.join("\n");
        } catch (e) { ctx.toast("生成资产失败: " + e.message, true); }
        finally { genAssetBtn.disabled = false; genAssetBtn.textContent = "⚡ 生成对应资产"; }
      },
    },
    "⚡ 生成对应资产"
  );

  // 双栏布局：左 = ① 技能库 + ② 本地模型；右 = ③ 优化（吃掉右侧空白，随面板高度自适应缩放）
  const leftCol = h(
    "div",
    { class: "sk-col sk-col-left" },
    h(
      "div",
      { class: "section" },
      h("h3", {}, "① 技能库"),
      h("div", { class: "row" }, skillSel, h("button", { class: "btn", onclick: () => refreshSkills(true) }, "刷新")),
      skillPreview
    ),
    h(
      "div",
      { class: "section" },
      h("h3", {}, "② 本地模型"),
      h("div", { class: "row" }, folderBtn, modelSel, famSel, loadBtn, unloadBtn,
        h("label", { class: "row", style: { gap: 4, fontSize: 11, cursor: "pointer" } }, autoLoadCk, "选模型自动加载")),
      modelStatus,
      h("div", { class: "muted", style: { fontSize: 10.5, marginTop: 4 } }, "⚙ 高级设置（选模型自动套最优参数，可手动改）"),
      advancedBox
    )
  );
  const rightCol = h(
    "div",
    { class: "sk-col sk-col-right" },
    h(
      "div",
      { class: "section" },
      h("h3", {}, "③ 优化"),
      h("div", { class: "row" }, h("span", { class: "muted" }, "优化方向"), instrSel),
      input,
      h("div", { class: "row" }, optBtn,
        h("label", { class: "row", style: { gap: 4, fontSize: 11, cursor: "pointer" } }, contCk, "接续推理直到完整"),
        h("span", { class: "muted", style: { fontSize: 11 } }, "最多轮次"), roundsIn),
      output,
      h("div", { class: "row" }, useBtn, copyBtn, genAssetBtn)
    ),
    // ④ 推理过程预览（右下角）：与 ③ 上下分栏，随面板高度自适应
    h(
      "div",
      { class: "section sk-reason" },
      h("div", { class: "row", style: { gap: 6 } },
        h("h3", { style: { margin: 0 } }, "④ 推理过程"),
        h("div", { class: "mx-spacer" }),
        reasonHint,
        h("button", { class: "btn", style: { padding: "2px 8px", fontSize: 11 },
          onclick: () => { reasonOut.value = ""; reasonHint.textContent = "思考模式开启时才有内容"; reasonHint.style.color = ""; } }, "清空")),
      reasonOut
    )
  );
  const el = h(
    "div",
    { class: "col", style: { flexDirection: "row", gap: 12, alignItems: "stretch", minHeight: 0 } },
    leftCol,
    rightCol
  );

  refreshSkills(false);
  refreshModels(false);
  return { el };
}
