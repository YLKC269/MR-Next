// panels/tools.js — 工具：原生导入 / 读本地文本 / 导出分镜 txt / 工作流消毒
import { h, clear } from "../core/dom.js";
import { downloadText } from "../core/api.js";

const F_TEXT = [
  ["文本", "*.txt *.md *.markdown"],
  ["全部", "*.*"],
];
const F_MEDIA = [
  ["图片", "*.png *.jpg *.jpeg *.webp *.gif"],
  ["视频", "*.mp4 *.mov *.webm *.mkv *.m4v"],
  ["音频", "*.wav *.mp3 *.flac *.ogg *.m4a"],
  ["全部", "*.*"],
];

export function createToolsPanel(ctx) {
  const s = ctx.store;

  const targetIn = h("input", {
    class: "input",
    value: s.get().folder || "mrboard_next",
    placeholder: "目标资产文件夹（input 下相对路径）",
  });
  targetIn.oninput = () => s.patch("folder", targetIn.value.trim());

  const importLog = h("div", { class: "muted" });

  const doNativePick = async (kind, opts) => {
    const r = await ctx.api.nativePick({ kind, title: opts.title, filetypes: opts.filetypes || [], multiple: !!opts.multiple });
    if (r.cancel) {
      ctx.toast("已取消");
      return null;
    }
    if (!r.ok || !r.paths || !r.paths.length) {
      ctx.toast("未选择或失败: " + (r.error || ""), true);
      return null;
    }
    return r.paths;
  };

  const pickFilesBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        const paths = await doNativePick("file", { title: "选择素材文件（可多选）", filetypes: F_MEDIA, multiple: true });
        if (!paths) return;
        try {
          const r = await ctx.api.importFiles(targetIn.value.trim(), paths);
          importLog.textContent = `已导入 ${r.copied.length} 个文件到 input/${targetIn.value.trim()}`;
          ctx.toast(`已导入 ${r.copied.length} 个文件`);
        } catch (e) {
          ctx.toast("导入失败: " + e.message, true);
        }
      },
    },
    "选文件导入"
  );

  const pickFolderBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        const paths = await doNativePick("folder", { title: "选择文件夹（递归导入素材）" });
        if (!paths) return;
        try {
          const r = await ctx.api.importFolder(paths[0], targetIn.value.trim());
          importLog.textContent = `已导入 ${r.copied} 个（跳过 ${r.skipped} 个同名）→ input/${targetIn.value.trim()}`;
          ctx.toast(`已导入 ${r.copied} 个素材`);
        } catch (e) {
          ctx.toast("导入失败: " + e.message, true);
        }
      },
    },
    "选文件夹导入"
  );

  // 读取本地文本 → 剧本
  const textPreview = h("textarea", {
    class: "textarea",
    readonly: true,
    style: { minHeight: "80px", fontSize: "11.5px", color: "#9aa6b3" },
    placeholder: "本地 .md/.txt 内容预览…",
  });
  let lastText = "";
  const loadTextBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        const paths = await doNativePick("file", { title: "选择本地剧本文本", filetypes: F_TEXT });
        if (!paths) return;
        try {
          const r = await ctx.api.readLocalText(paths[0]);
          if (!r.ok) {
            ctx.toast(r.error || "读取失败", true);
            return;
          }
          lastText = r.text || "";
          textPreview.value = lastText.slice(0, 600) + (lastText.length > 600 ? "\n…" : "");
          importLog.textContent = `已读取：${r.name}（${lastText.length} 字）`;
        } catch (e) {
          ctx.toast("读取失败: " + e.message, true);
        }
      },
    },
    "读本地 .md/.txt"
  );
  const toScriptBtn = h(
    "button",
    {
      class: "btn btn-primary",
      onclick: () => {
        if (!lastText) {
          ctx.toast("请先读取本地文本", true);
          return;
        }
        s.set({ script: lastText });
        ctx.switchTo("script");
      },
    },
    "载入剧本"
  );

  // 导出分镜 txt
  const exportBtn = h(
    "button",
    {
      class: "btn btn-primary",
      onclick: async () => {
        const script = (s.get().script || "").trim();
        const prefix = s.get().prefix || "";
        if (!script) {
          ctx.toast("剧本为空", true);
          return;
        }
        try {
          const text = await ctx.api.exportStoryboard(script, prefix);
          downloadText("storyboard_export_" + Date.now() + ".txt", text);
          ctx.toast("已导出分镜提示词 .txt");
        } catch (e) {
          ctx.toast("导出失败: " + e.message, true);
        }
      },
    },
    "导出分镜 .txt"
  );

  // 工作流消毒
  const wfIn = h("textarea", {
    class: "textarea",
    style: { minHeight: "120px" },
    placeholder: "粘贴 ComfyUI workflow JSON（含 nodes/links 对象）…",
  });
  const wfOut = h("textarea", {
    class: "textarea",
    readonly: true,
    style: { minHeight: "120px", fontSize: "11.5px", color: "#9aa6b3" },
    placeholder: "消毒结果…",
  });
  const wfLog = h("div", { class: "muted" });

  const sanitizeBtn = h(
    "button",
    {
      class: "btn btn-primary",
      onclick: async () => {
        let g;
        try {
          g = JSON.parse(wfIn.value);
        } catch (e) {
          ctx.toast("JSON 解析失败: " + e.message, true);
          return;
        }
        try {
          const r = await ctx.api.sanitizeWorkflow(g);
          wfOut.value = JSON.stringify(r.graph, null, 1);
          wfLog.textContent = `重编号 ${r.count} 个重复节点 → 结果可覆盖回工作流存档`;
          ctx.toast(`已消毒（重编号 ${r.count} 个节点）`);
        } catch (e) {
          ctx.toast("消毒失败: " + e.message, true);
        }
      },
    },
    "消毒工作流"
  );
  const wfUseBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        if (!wfOut.value) {
          ctx.toast("请先执行消毒", true);
          return;
        }
        try {
          await navigator.clipboard.writeText(wfOut.value);
          ctx.toast("已复制消毒结果（覆盖进原工作流 JSON 存档即可）");
        } catch (e) {
          ctx.toast("复制失败: " + e.message, true);
        }
      },
    },
    "复制结果"
  );

  const el = h(
    "div",
    { class: "col", style: { maxWidth: "820px" } },
    h(
      "div",
      { class: "section" },
      h("h3", {}, "① 原生导入（Windows 资源管理器）"),
      h("div", { class: "row" }, targetIn, pickFilesBtn, pickFolderBtn),
      importLog
    ),
    h(
      "div",
      { class: "section" },
      h("h3", {}, "② 读取本地剧本文本"),
      h("div", { class: "row" }, loadTextBtn, toScriptBtn),
      textPreview
    ),
    h(
      "div",
      { class: "section" },
      h("h3", {}, "③ 导出分镜提示词 .txt"),
      h("div", { class: "row" }, exportBtn),
      h("div", { class: "muted" }, "按当前「剧本」面板内容导出（含公共前缀，按【镜头N】分段）")
    ),
    h(
      "div",
      { class: "section" },
      h("h3", {}, "④ 工作流消毒（治 funky links / 重复节点）"),
      wfIn,
      h("div", { class: "row" }, sanitizeBtn, wfUseBtn),
      wfLog,
      wfOut
    )
  );
  return { el };
}
