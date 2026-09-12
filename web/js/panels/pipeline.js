// panels/pipeline.js — 一键流水线（编排现有能力：拆分→抽取→设定图→匹配→存计划）
import { h } from "../core/dom.js";
import {
  SIZES, DEFAULT_SIZE_INDEX, CUSTOM_SIZE_INDEX, resolveSize,
  VIDEO_SIZES, DEFAULT_VID_SIZE_INDEX, CUSTOM_VID_SIZE_INDEX, resolveVidSize, mpToWH,
} from "../core/sizes.js";
import { parsePrefixDef, planDefinitionJobs } from "../core/prefix_parser.js";
import { createLoraControls } from "./lora_controls.js";
import { pickAssetFolder } from "../core/ui.js";
import { stripVirtualRefs, isUsableRel } from "../core/purify.js";
import { assetRegistry } from "../core/assets.js";
// 出片结果 → 剪辑面板的**统一实现**（与「时间线」导演台共用；语义见 core/editor_io.js）
import { exportVideosToEditor } from "../core/editor_io.js";

export function createPipelinePanel(ctx) {
  const s = ctx.store;
  const log = h("div", {
    class: "card",
    style: { minHeight: 220, maxHeight: 420, overflow: "auto", fontFamily: "monospace",
             fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap", color: "#c8d3de", background: "#0a0e13" },
  });
  const modelSel = h("select", { class: "select", style: { width: "auto" } });
  const h3Sel = h(
    "select",
    { class: "select", style: { width: "auto" } },
    h("option", { value: "off" }, "不开 H3 出片"),
    h("option", { value: "t2v" }, "T2VA 文生"),
    h("option", { value: "i2v" }, "I2VA 首帧"),
    h("option", { value: "fl2v" }, "FL2VA 首尾帧"),
    h("option", { value: "fl2v_tail" }, "L2VA 仅尾帧"),
    h("option", { value: "r2v" }, "Ref2VA 多参考")
  );
  const secIn = h("input", { class: "input", type: "number", min: 1, max: 20, step: 1, value: 5, style: { width: 80 }, title: "每镜秒数" });
  const note = h("div", { class: "muted" }, "一键跑：拆分 → 抽角色/场景 → 生成设定图入收藏 → 引用匹配 → 保存计划 →（可选）H3 逐镜连跑出片（选中模式并喂到素材即生效）。");

  let running = false;
  let cancelled = false;

  // ---- 读取「时间线」导演台的持久化参数（模型/LoRA/加速/分辨率/采样）→ H3 出片 opts ----
  // 时间线参数存在 localStorage mrnext.timeline.params.v1（与导演台 P 同源），这里复刻 collectOpts 组装。
  // 用户在导演台设好的模型/加速/分辨率自动对流水线 H3 出片生效，不再用引擎默认（慢）。
  const readTimelineOpts = () => {
    let P = {};
    try { P = JSON.parse(localStorage.getItem("mrnext.timeline.params.v1") || "{}"); } catch (_) {}
    const model = P.model || {}, output = P.output || {}, speed = P.speed || {}, audio = P.audio || {};
    const o = {
      unet_name: model.unet || undefined, clip_name: model.clip || undefined,
      video_vae_name: model.vvae || undefined, audio_vae_name: model.avae || undefined,
      lora_name: model.lora && model.lora !== "(无)" ? model.lora : undefined,
      lora_strength: model.loraS,
      width: output.width, height: output.height,
      ref_max_size: output.ref_size, frame_rate: output.fps, steps: output.steps,
      cfg: output.cfg, shift_video: output.shift_video, shift_audio: output.shift_audio,
      sampler: output.sampler || undefined, scheduler: output.scheduler || undefined,
      clear_vram_between_segments: output.clear_vram || undefined,
      // H3 官方输出三开关 + 百万像素（与导演台「⚙ 采样设置 / 🎙️ 声音」页同源，写进 timeline_data.output）
      megapixels: output.megapixels || undefined,                                    // 0.1–2，>0 时后端按比例换算宽高
      export_mode: output.exportMode === "segments" ? "segments" : "all",            // 整条拼接 / 分段独立
      audio_mode: audio.no_speech ? "mute" : "generate",                             // 完全无人声 / 正常生成
      continuity: output.continuity ? true : undefined,                              // continuityEnabled：段间重叠帧衔接
      continuity_overlap: output.continuity ? (Number(output.continuity_overlap) || 9) : undefined,
      speed_lora: speed.lora && speed.lora !== "(无)" ? speed.lora : undefined,
      speed_lora_strength: speed.loraS,
      sage_attention: speed.sage && speed.sage !== "disabled" ? speed.sage : undefined,
      // 内置注意力加速：导演台单镜出片会下发它，流水线以前漏了 → 两边行为不一致（对齐官方/导演台）
      attention_accel: (speed.accel && speed.accel !== "off") ? speed.accel : "off",
      // 公共提示词（官方 common prompt）—— 与导演台「🌐 公共提示词」页同源
      common_prompt: (P.common && P.common.text) ? P.common.text : undefined,
      common_enabled: (P.common && P.common.enabled !== false) ? true : undefined,
      // 声音 / 台词（H3 官方三段式 + 低步数音频护栏）—— 与导演台「🎙️ 声音」页同源
      av_structure: audio.structure === false ? false : true,
      av_lang: audio.lang || "Chinese",
      av_ambience: audio.ambience || undefined,
      av_music: audio.music || undefined,
      av_no_speech: audio.no_speech ? true : undefined,
      audio_guard: audio.guard === false ? false : true,
      audio_min_steps: audio.min_steps || undefined,
      video_audio_ref: audio.video_audio_ref ? true : undefined,
    };
    Object.keys(o).forEach((k) => { if (o[k] === undefined || o[k] === "" || o[k] === null) delete o[k]; });
    return o;
  };
  // 同步摘要（打日志用）：让用户看见流水线继承了导演台的哪些参数
  const timelineOptsSummary = () => {
    const o = readTimelineOpts();
    const parts = [];
    if (o.unet_name) parts.push("模型:" + String(o.unet_name).split("/").pop().slice(0, 24));
    if (o.lora_name) parts.push("LoRA:" + String(o.lora_name).split("/").pop().slice(0, 18));
    if (o.width && o.height) parts.push(o.width + "×" + o.height);
    if (o.steps) parts.push(o.steps + "步");
    return parts.join(" · ") || "（导演台无自定义参数，用引擎默认）";
  };

  const println = (t, cls = "") => {
    const line = h("div", {}, t);
    if (cls) line.style.color = cls;
    log.appendChild(line);
    // 行数上限：长时间连跑防止 DOM 无限增长把面板拖崩（保留最新 600 行）
    while (log.children.length > 600) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  };

  const wait1 = () => new Promise((r) => setTimeout(r, 60));
  const isCancelled = () => {
    if (cancelled) {
      println("⏹ 已停止", "#ffb4b4");
      return true;
    }
    return false;
  };

  const runBtn = h(
    "button",
    {
      class: "btn btn-primary",
      onclick: async () => {
        if (running) {
          cancelled = true;
          runBtn.textContent = "停止中…";
          return;
        }
        cancelled = false;
        running = true;
        runBtn.textContent = "⏹ 停止";
        log.textContent = "";
        println("▶ 一键流水线启动");
        // ⓪ 先选本次产物的保存文件夹（Windows 原生对话框，定位到 ComfyUI/input）
        const pickRes = await pickAssetFolder(ctx, "选择本次流水线的保存文件夹（在 ComfyUI input 下选择或新建）");
        if (pickRes.cancel) {
          println("⏹ 已取消（未选保存文件夹）", "#ffd98f");
          running = false; runBtn.textContent = "▶ 一键流水线";
          return;
        }
        if (pickRes.error) {
          println("✗ " + pickRes.error, "#ffb4b4");
          ctx.toast(pickRes.error, true);
          running = false; runBtn.textContent = "▶ 一键流水线";
          return;
        }
        s.set({ folder: pickRes.folder });
        println(`📁 保存文件夹：input/${pickRes.folder || "（根目录）"}`, "#ffcf6b");
        const stats = { shots: 0, roles: 0, scenes: 0, generated: 0, favorited: 0, matched: 0, h3: 0 };
        try {
          // ① 拆分
          const st0 = s.get();
          const script = (st0.script || "").trim();
          const prefix = (st0.prefix || "").trim();
          const folder = (st0.folder ?? "mrboard_next").trim();
          if (!script) {
            println("✗ 剧本为空，请先在「剧本」粘贴内容", "#ffb4b4");
            return;
          }
          println("① 拆分分镜…");
          const sp = await ctx.api.split({
            script, prefix, folder,
            durationSec: Number(secIn.value) || 5,
          });
          if (isCancelled()) return;
          s.set({ shots: sp.shots, refMap: sp.perShot || [], splitStamp: Date.now() });
          // header 自动并入 prefix
          if (sp.header && !prefix) {
            s.set({ prefix: sp.header });
            println(`    ✓ 已自动抽取公共前缀（${(sp.header || "").split("\n").length} 行）`, "#8ff0c0");
          }
          stats.shots = (sp.shots || []).length;
          println(`    ✓ 共 ${stats.shots} 镜${sp.durationPerShot ? ` · 自动时长 ${(sp.durationPerShot || []).filter((v) => v).length} 镜` : ""}`, "#8ff0c0");

          // ② 抽取角色/场景 + ③ 设定图：直接用 prefix 文本做前端解析（不再 round-trip 后端）
          //    与「剧本」面板「生成设定图」走同一条路径 → 数量/顺序/描述始终一致
          println("② 用前缀解析出角色/场景（直读 prefix 文本）…");
          const parsed = parsePrefixDef(prefix);
          const [defaultW, defaultH] = resolveSize(imgSizeSel.value, ctx.store.get().genW, ctx.store.get().genH);
          const defJobs = planDefinitionJobs(parsed, { width: defaultW, height: defaultH });
          const jobs = defJobs.map((j) => ({ ...j, w: j.w || defaultW, h: j.h || defaultH }));
          stats.roles = parsed.roleBlocks.length;
          stats.scenes = parsed.sceneBlocks.length;
          println(`    ✓ 角色 ${stats.roles} · 场景 ${stats.scenes}（prefix 行序 · 全局基调${parsed.style ? "《" + parsed.style + "》" : "默认"}）`, "#8ff0c0");
          if (parsed.warnings.length) {
            for (const w of parsed.warnings) println(`    ⚠ ${w}`, "#ffb37a");
          }
          if (!jobs.length) {
            println("    - 无角色/场景需出图（可跳过）", "#ffd98f");
          } else {
            println(`③ 生成设定图（${jobs.length} 项，已收藏自动跳过）…`);
            const fav = await ctx.api.favorites();
            const have = new Set((fav.items || []).map((i) => i.name + "|" + i.category));
            for (let i = 0; i < jobs.length; i++) {
              if (isCancelled()) return;
              const job = jobs[i];
              if (have.has(job.name + "|" + job.kind)) {
                println(`    [${i + 1}/${jobs.length}] 跳过（已收藏）：${job.name}`, "#ffd98f");
                continue;
              }
              println(`    [${i + 1}/${jobs.length}] 生成 ${job.name}…（${job.kind}）`);
              runBtn.textContent = `⏹ 停止（${i + 1}/${jobs.length}）`;
              try {
                const res = await ctx.api.generate({
                  prompt: job.prompt, folder, model: s.get().genModel || modelSel.value, seed: i,
                  width: job.w, height: job.h, steps: Number(s.get().genSteps) || 8,
                  loras: (ctx.store.get().loras || []), lora_folder: (ctx.store.get().loraFolder || ""),
                });
                if (res.ok) {
                  stats.generated += 1;
                  if (res.rel) {
                    // 自动改名成剧本写的名字（去机器名）→ 自动导入素材库
                    let rel = res.rel;
                    let renamed = false;
                    try {
                      const rr = await ctx.api.rename(res.rel, job.name);
                      if (rr && rr.ok && rr.rel) { rel = rr.rel; renamed = !!rr.renamed; }
                    } catch (_) { /* 改名失败不阻断 */ }
                    await ctx.api.favoriteAdd([{ name: job.name, rel, kind: "image", category: job.kind }]);
                    stats.favorited += 1;
                    println(`    ✓ ${renamed ? `已改名「${job.name}」→ 导入素材库` : "已导入素材库"}${res.note ? `（${res.note}）` : ""}`, "#8ff0c0");
                  } else {
                    println(`    ✓ ${res.note || "完成"}`, "#8ff0c0");
                  }
                } else {
                  println(`    ✗ ${res.error || "生成失败"}`, "#ffb4b4");
                }
              } catch (e) {
                println(`    ✗ ${e.message}`, "#ffb4b4");
              }
              have.add(job.name + "|" + job.kind);
              await wait1();
            }
          }

          // 刷新素材库：改名后的设定图立即可见（<Picture N> 编号按新文件名重排）
          if (stats.generated) {
            try { await assetRegistry.refresh(); println("    ✓ 已刷新素材库（改名后的设定图可直接引用）", "#8ff0c0"); } catch (_) {}
          }

          // ④ 分镜引用匹配
          println("④ 分镜引用匹配…");
          const fav2 = await ctx.api.favorites();
          const cands = (fav2.items || []).filter((i) => i.name && i.rel);
          if (!cands.length) {
            println("    - 收藏库为空，跳过匹配（先去素材库收藏角色/场景）", "#ffd98f");
          } else {
            const an = await ctx.api.analyze((sp.shots || []).map((x) => x.text || ""), cands);
            if (isCancelled()) return;
            s.set({ refMap: an.perShot || [] });
            stats.matched = (an.used || []).length;
            println(`    ✓ 命中 ${stats.matched} 个素材`, "#8ff0c0");
          }

          // ⑤ 保存计划
          println("⑤ 保存分镜计划…");
          await ctx.api.savePlan(folder, s.get().shots || []);
          println("    ✓ 已落盘 _plan.json", "#8ff0c0");

          // ⑥ H3 逐镜连跑出片（可选）
          const h3mode = h3Sel.value;
          // 上下文引导 checkbox 引用（在 if 外声明，供后续日志和实际执行使用）
          const linkAllCk = document.getElementById("pipeline-link-all");
          // 逐镜出片结果（**按分镜顺序**收集）——在 if 外声明，跑完交给 exportVideosToEditor
          // 决定"拼成一整条"还是"逐段"送进剪辑面板
          const h3Rels = [];
          if (h3mode !== "off") {
            if (linkAllCk && linkAllCk.checked) {
              const shots = sp.shots || [];
              for (let k = 0; k < shots.length - 1; k++) {
                shots[k].linkNext = true;
              }
              // 同步回 store（否则时间线面板看不到衔接状态）
              s.set({ shots });
              println(`    ✓ 已开启上下文引导：所有分镜将注入上一镜描述`, "#ffd98f");
            }
            println(`⑥ H3 逐镜连跑（${h3mode} · ${secIn.value}s/镜 · 首镜含模型加载${linkAllCk && linkAllCk.checked ? " · 上下文引导已开启" : " · 无上下文引导"}）`);
            println(`    ↳ 参数同步自「时间线」导演台：${timelineOptsSummary()}`, "#7fd0ff");
            const tlOpts = readTimelineOpts();
            const refMap = s.get().refMap || [];
            for (let i = 0; i < (sp.shots || []).length; i++) {
              if (isCancelled()) return;
              const sh = sp.shots[i];
              // 上下文引导：注入上一镜的描述（与时间线面板「衔接下镜」逻辑一致）
              // 提示词净化：剥掉 @image#N:xxx.png 虚拟引用 token（粘贴图片残留 → 污染生成）
              let prompt = stripVirtualRefs(sh.text || "");
              if (i > 0 && sh.linkNext && sp.shots[i - 1]) {
                const prevText = stripVirtualRefs(sp.shots[i - 1].text || "").trim();
                if (prevText) {
                  prompt = `（承接上一镜画面——${prevText.slice(0, 90)}${prevText.length > 90 ? "…" : ""}；保持角色/场景/镜头一致，自然衔接）\n${prompt}`;
                }
              }
              // t2v（文生视频）是纯文字模式：完全不取图，保证 payload 里没有任何 refs/帧图
              // 脏 rel 过滤：虚拟引用 token（@image#1:xxx.png）不是真实文件，绝不能进 payload
              let imgs = (h3mode === "t2v") ? [] : ((refMap[i] || []).filter((m) => m.rel && m.kind === "image")).map((m) => m.rel).filter((x) => isUsableRel(x));
              // 剔除已被清理的幽灵素材（源文件不存在），避免旧参考图污染本次生成
              if (imgs.length) {
                try {
                  const ex = await ctx.api.mediaExists(imgs);
                  const miss = (ex && ex.missing) || [];
                  if (miss.length) {
                    imgs = imgs.filter((x) => !miss.includes(x));
                    println(`    ⚠ 第 ${sh.index} 镜剔除 ${miss.length} 个失效素材：${miss.slice(0, 3).join(" · ")}`, "#ffd98f");
                  }
                } catch (_) { /* 校验失败不阻断 */ }
              }
              const payload = {
                mode: h3mode,
                prompt,
                prefix: stripVirtualRefs(s.get().prefix || ""),
                folder,
                seed: (i + 1) * 137 + Math.floor(Date.now() % 1000),
                seconds: Number(secIn.value) || 5,
                index: sh.index || (i + 1),   // H3 官方结构的 [Shot N] 编号
                opts: tlOpts, // 同步导演台的模型/LoRA/加速/分辨率/采样/声音参数
              };
              if (h3mode === "i2v") payload.first_frame = imgs[0] || "";
              else if (h3mode === "fl2v") { payload.first_frame = imgs[0] || ""; payload.last_frame = imgs[1] || ""; }
              else if (h3mode === "fl2v_tail") payload.last_frame = imgs[0] || "";
              else if (h3mode === "r2v") payload.refs = imgs;
              if (imgs.length) println(`    ↳ 第 ${sh.index} 镜素材：${imgs.join(" · ")}`, "#9fd0ff");
              runBtn.textContent = `⏹ 停止（H3 ${i + 1}/${sp.shots.length}）`;
              try {
                const r = await ctx.api.h3Shot(payload);
                if (r.ok) {
                  stats.h3 += 1;
                  if (r.audio_note) println(`    ⚠ ${r.audio_note}`, "#ffb35c");
                  if (r.prompt_final) {
                    const pf = String(r.prompt_final).replace(/\s+/g, " ").trim();
                    println(`    📝 送模型：${pf.slice(0, 160)}${pf.length > 160 ? "…" : ""}`, "#9fb6d0");
                  }
                  if (r.dialogues && r.dialogues.length) {
                    const d = r.dialogues.map((x) => `${x.speaker || "?"}：${x.text}`).join(" / ");
                    println(`    🎙 台词 ${r.dialogues.length} 句：${d.slice(0, 120)}${d.length > 120 ? "…" : ""}`, "#c9b6ff");
                  }
                  println(`    ✓ 第 ${sh.index} 镜 → input/${r.rel}（${h3mode} · 构图 ${r.graph_kind || "-"}）`, "#8ff0c0");
                  if (r.rel) h3Rels.push(r.rel);   // 顺序 = 分镜顺序
                } else {
                  println(`    ✗ 第 ${sh.index} 镜：${r.error}`, "#ffb4b4");
                }
              } catch (e) {
                println(`    ✗ 第 ${sh.index} 镜：${e.message}`, "#ffb4b4");
              }
            }
          }

          println(`\n✔ 完成：${stats.shots} 镜 · 角色 ${stats.roles} · 场景 ${stats.scenes} · 新出图 ${stats.generated} · 新收藏 ${stats.favorited} · 命中引用 ${stats.matched}` +
            (h3mode !== "off" ? ` · H3 出片 ${stats.h3}` : "") +
            (linkAllCk && linkAllCk.checked ? " · 上下文引导已开启" : ""), "#8ff0c0");
          println(h3mode === "off"
            ? "（未开 H3 出片；去「时间线」逐镜或连跑即可）"
            : (s.get().exportMode === "segments"
              ? "✅ 每镜一段视频将按分镜顺序自动加入「剪辑」面板 V1 轨…"
              : "✅ 将自动拼成一整条视频并加入「剪辑」面板 V1 轨…"));

          // ⑦ 按「导出方式」把出片结果送进剪辑面板（与时间线导演台同一个实现）。
          //    · 全部导出 → 拼成一整条，只把这一条入 V1 轨
          //    · 分段导出 → 每镜一条，按分镜顺序逐段入 V1 轨
          //    以前这里**什么都不做**，日志却写着"全部视频已自动导入" → 用户以为导出失效。
          //    ⚠ 必须放在上面**打印完总结之后**：这一步会切到「剪辑」面板，
          //      先打印才能让用户看到"完成：N 镜…"这行（面板实例是缓存的，切回来日志还在）。
          if (h3mode !== "off" && h3Rels.length) {
            try {
              await exportVideosToEditor(ctx, {
                rels: h3Rels,
                exportMode: s.get().exportMode,
                folder,
                log: println,
              });
            } catch (e) {
              println(`    ✗ 导出到剪辑面板失败：${e.message}`, "#ffb4b4");
            }
          }
        } catch (e) {
          println("✗ 流水线异常：" + e.message, "#ffb4b4");
        } finally {
          running = false;
          runBtn.textContent = "▶ 一键流水线";
        }
      },
    },
    "▶ 一键流水线"
  );

  const gotoRow = h(
    "div",
    { class: "row" },
    h("button", { class: "btn", onclick: () => ctx.switchTo("shots") }, "查看分镜"),
    h("button", { class: "btn", onclick: () => ctx.switchTo("favorites") }, "查看收藏"),
    h("button", { class: "btn", onclick: () => ctx.switchTo("assets") }, "查看素材"),
    h("button", { class: "btn", onclick: () => ctx.switchTo("script") }, "回剧本")
  );

  const loadModels = async () => {
    try {
      const r = await ctx.api.models();
      const list = r.diffusion || [];
      for (const m of list) modelSel.appendChild(h("option", { value: m }, m));
      if (list.length) modelSel.value = (r.defaults && r.defaults.model) || list[0];
      // 「生图」面板选过模型 → 优先用它（参数同步）
      const gm = s.get().genModel;
      if (gm && list.includes(gm)) modelSel.value = gm;
    } catch (_) {}
  };
  loadModels();

  // ---- 生图分辨率（与「剧本」面板「角色/场景设定图」、「生图」面板共用 store.genSize/genW/genH）----
  const imgSizeSel = h("select", { class: "select", style: { width: "auto" } },
    ...SIZES.map(([label], i) => h("option", { value: String(i) }, label)));
  const imgWIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 74, display: "none" }, value: 768 });
  const imgHIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 74, display: "none" }, value: 1344 });
  const syncImgCustomVisible = () => {
    const isCustom = Number(imgSizeSel.value) === CUSTOM_SIZE_INDEX;
    imgWIn.style.display = isCustom ? "" : "none";
    imgHIn.style.display = isCustom ? "" : "none";
  };
  imgSizeSel.value = String(ctx.store.get().genSize ?? DEFAULT_SIZE_INDEX);
  imgWIn.value = ctx.store.get().genW || 768;
  imgHIn.value = ctx.store.get().genH || 1344;
  syncImgCustomVisible();
  imgSizeSel.onchange = () => { ctx.store.set({ genSize: Number(imgSizeSel.value) || 0 }); syncImgCustomVisible(); };
  imgWIn.oninput = () => { ctx.store.set({ genW: Number(imgWIn.value) || 0 }); };
  imgHIn.oninput = () => { ctx.store.set({ genH: Number(imgHIn.value) || 0 }); };
  ctx.store.subscribe((st) => {
    if (st.genSize != null && String(st.genSize) !== imgSizeSel.value) imgSizeSel.value = String(st.genSize);
    if (st.genW != null && Number(imgWIn.value) !== Number(st.genW)) imgWIn.value = st.genW;
    if (st.genH != null && Number(imgHIn.value) !== Number(st.genH)) imgHIn.value = st.genH;
    syncImgCustomVisible();
  });

  // ---- 视频分辨率（与「时间线」导演台共享 store.vidSize/vidW/vidH）----
  const vidSizeSel = h("select", { class: "select", style: { width: "auto" } },
    ...VIDEO_SIZES.map(([label], i) => h("option", { value: String(i) }, label)));
  const vidWIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 74, display: "none" }, value: 720 });
  const vidHIn = h("input", { class: "input", type: "number", min: 64, step: 32, style: { width: 74, display: "none" }, value: 1280 });
  const syncVidCustomVisible = () => {
    const isCustom = Number(vidSizeSel.value) === CUSTOM_VID_SIZE_INDEX;
    vidWIn.style.display = isCustom ? "" : "none";
    vidHIn.style.display = isCustom ? "" : "none";
  };
  vidSizeSel.value = String(ctx.store.get().vidSize ?? DEFAULT_VID_SIZE_INDEX);
  vidWIn.value = ctx.store.get().vidW || 720;
  vidHIn.value = ctx.store.get().vidH || 1280;
  // ---- H3 官方 output 三开关（导出模式 / 音频模式 / 段间连续性），与「时间线」导演台共享 store ----
  const expSel = h("select", { class: "select", style: { width: "auto" },
    title: "官方 exportMode：all=整条自动拼接成一条视频；segments=每镜独立导出" },
    h("option", { value: "all" }, "🎬 全部导出（拼接）"),
    h("option", { value: "segments" }, "📦 分段导出（独立）"));
  const amodeSel = h("select", { class: "select", style: { width: "auto" },
    title: "官方 audioMode：generate=正常生成人声；mute=完全无人声（纯环境音/配乐）" },
    h("option", { value: "generate" }, "🔊 生成人声"),
    h("option", { value: "mute" }, "🤐 完全静音"));
  const contCk = h("input", { type: "checkbox", style: { accentColor: "#ffd166" },
    title: "官方 continuityEnabled：段与段之间用重叠帧衔接（与提示词级「衔接下镜」不同）" });
  const contOvSel = h("select", { class: "select", style: { width: "auto" }, title: "官方 continuityOverlapFrames" },
    ...[5, 9, 22, 39, 56].map((n) => h("option", { value: String(n) }, String(n) + " 帧")));
  const syncOutFlags = () => {
    const st = ctx.store.get();
    if (expSel.value !== (st.exportMode === "segments" ? "segments" : "all")) expSel.value = (st.exportMode === "segments" ? "segments" : "all");
    if (amodeSel.value !== (st.audioMute ? "mute" : "generate")) amodeSel.value = st.audioMute ? "mute" : "generate";
    contCk.checked = !!st.continuity;
    contOvSel.value = String(Number(st.continuityOverlap) || 9);
    contOvSel.disabled = !st.continuity;
  };
  expSel.onchange = () => { ctx.store.set({ exportMode: expSel.value === "segments" ? "segments" : "all" }); syncOutFlags(); };
  amodeSel.onchange = () => { ctx.store.set({ audioMute: amodeSel.value === "mute" }); syncOutFlags(); };
  contCk.onchange = () => { ctx.store.set({ continuity: !!contCk.checked }); syncOutFlags(); };
  contOvSel.onchange = () => { ctx.store.set({ continuityOverlap: Number(contOvSel.value) || 9 }); syncOutFlags(); };
  syncOutFlags();
  syncVidCustomVisible();
  // H3 官方百万像素直填（0.1–2）：与「时间线」工具栏那个 MP 共用 store.vidMP，填了就按当前比例算宽高
  const vidMPIn = h("input", {
    class: "input", type: "number", min: 0.1, max: 2, step: 0.1, placeholder: "MP",
    style: { width: 58, display: "none" },
    title: "MiniMax H3 官方百万像素（0.1–2）：填了就按当前比例算出宽高，并写进工作流（留空=用上面的宽高）",
  });
  const syncVidMPVisible = () => {
    const mpOn = Number(ctx.store.get().vidMP || 0) > 0;
    vidMPIn.style.display = (Number(vidSizeSel.value) === CUSTOM_VID_SIZE_INDEX || mpOn) ? "" : "none";
    vidMPIn.value = mpOn ? String(ctx.store.get().vidMP) : "";
  };
  vidMPIn.onchange = () => {
    const raw = Number(vidMPIn.value);
    if (!raw || raw <= 0) { ctx.store.set({ vidMP: 0 }); syncVidMPVisible(); return; }
    const mp = Math.max(0.1, Math.min(2, Math.round(raw * 100) / 100));
    const [w, hh] = mpToWH(mp, ctx.store.get().vidW || 720, ctx.store.get().vidH || 1280);
    ctx.store.set({ vidMP: mp, vidW: w, vidH: hh, vidSize: CUSTOM_VID_SIZE_INDEX });
    syncVidMPVisible();
  };
  vidSizeSel.onchange = () => { ctx.store.set({ vidSize: Number(vidSizeSel.value) || 0, vidMP: 0 }); syncVidCustomVisible(); syncVidMPVisible(); };
  vidWIn.oninput = () => { ctx.store.set({ vidW: Number(vidWIn.value) || 0, vidMP: 0 }); syncVidMPVisible(); };
  vidHIn.oninput = () => { ctx.store.set({ vidH: Number(vidHIn.value) || 0, vidMP: 0 }); syncVidMPVisible(); };
  ctx.store.subscribe((st) => {
    if (st.vidSize != null && String(st.vidSize) !== vidSizeSel.value) vidSizeSel.value = String(st.vidSize);
    if (st.vidW != null && Number(vidWIn.value) !== Number(st.vidW)) vidWIn.value = st.vidW;
    if (st.vidH != null && Number(vidHIn.value) !== Number(st.vidH)) vidHIn.value = st.vidH;
    syncVidCustomVisible();
    syncVidMPVisible();
  });
  syncVidMPVisible();

  const el = h(
    "div",
    { class: "col", style: { maxWidth: "860px" } },
    h("div", { class: "row" }, runBtn, h("span", { class: "muted" }, "设定图模型："), modelSel),
    // 生图分辨率（与「生图」/「剧本」面板联动）
    h("div", { class: "row" },
      h("span", { class: "muted", style: { fontSize: 11.5 } }, "设定图分辨率:"),
      imgSizeSel, imgWIn, h("span", { class: "muted", style: { fontSize: 11 } }, "×"), imgHIn,
      h("div", { class: "mx-spacer" }),
      h("span", { class: "muted", style: { fontSize: 10.5, opacity: 0.7 } }, "↔ 与「生图」/「剧本」面板")),
    // LoRA 控件（与「生图」/「剧本」面板共享 store.useLora + loraFolder）
    h("div", { class: "row", style: { flexWrap: "wrap", gap: 4, padding: "6px 8px", background: "rgba(255,207,107,.06)", border: "1px solid #5e3e10", borderRadius: 7 } },
      h("span", { style: { fontSize: 11, color: "#ffcf6b", fontWeight: 700 } }, "⚡ LoRA"),
      createLoraControls(ctx, { inline: true, onChange: () => { /* 流水线生图走 Krea2 内部默认，可忽略 */ } }).row,
    ),
    h("div", { class: "row" }, h("span", { class: "muted" }, "H3 出片模式："), h3Sel, h("span", { class: "muted" }, "秒/镜:"), secIn),
    // 上下文引导：勾选后所有分镜自动开启「衔接下镜」，让每镜注入上一镜画面描述，保证镜头连贯性
    h("div", { class: "row", style: { flexWrap: "wrap", gap: 4, alignItems: "center" } },
      h("span", { class: "muted", style: { fontSize: 11.5 } }, "上下文引导："),
      h("label", { class: "row", style: { gap: 5, cursor: "pointer", fontSize: 11.5, color: "#d0e0f0" } },
        h("input", { type: "checkbox", id: "pipeline-link-all", checked: false, style: { accentColor: "#ffd166" } }),
        "自动开启（推荐，保持镜头连贯）"),
      h("span", { class: "muted", style: { fontSize: 10.5, opacity: 0.7 } }, "↔ 联动时间线面板「⇄ 全部衔接」")),
    // 视频分辨率（与「时间线」导演台共享 store.vidSize/vidW/vidH，双向联动）
      h("div", { class: "row", style: { flexWrap: "wrap", gap: 4, alignItems: "center" } },
      h("span", { class: "muted", style: { fontSize: 11.5 } }, "视频分辨率:"),
      vidSizeSel, vidWIn, h("span", { class: "muted", style: { fontSize: 11 } }, "×"), vidHIn,
      h("span", { class: "muted", style: { fontSize: 11.5, marginLeft: 6 } }, "MP:"), vidMPIn,
      h("div", { class: "mx-spacer" }),
      h("span", { class: "muted", style: { fontSize: 10.5, opacity: 0.7 } }, "↔ 与「时间线」导演台")),
    // H3 官方 output 三开关（导出模式 / 音频模式 / 段间连续性）——与导演台「⚙ 采样设置 / 🎙️ 声音」页联动
    h("div", { class: "row", style: { flexWrap: "wrap", gap: 4, alignItems: "center", padding: "6px 8px",
      background: "rgba(127,208,255,.06)", border: "1px solid #24486b", borderRadius: 7 } },
      h("span", { style: { fontSize: 11, color: "#7fd0ff", fontWeight: 700, marginRight: 4 } }, "🎞 H3 输出"),
      expSel,
      h("span", { class: "muted", style: { fontSize: 11.5, marginLeft: 2 } }, "音频:"), amodeSel,
      h("label", { class: "row", style: { gap: 5, cursor: "pointer", fontSize: 11.5, color: "#d0e0f0", marginLeft: 4 } },
        contCk, "段间连续性"), contOvSel,
      h("div", { class: "mx-spacer" }),
      h("span", { class: "muted", style: { fontSize: 10.5, opacity: 0.7 } }, "↔ 与「时间线」导演台")),
    note,
    log,
    gotoRow
  );
  return { el };
}
