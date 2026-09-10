// core/api.js — 类型化请求封装。前端只调语义化方法，不碰裸 fetch/URL。
import { api } from "/scripts/api.js";

async function getJson(path) {
  const r = await api.fetchApi(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function postJson(path, body) {
  const r = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    let errMsg = `${path} -> ${r.status}`;
    try {
      const j = JSON.parse(errBody);
      if (j.error) errMsg = j.error;
    } catch (_) {}
    throw new Error(errMsg);
  }
  return r.json();
}

async function rawText(path, body) {
  const r = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.text();
}

export function downloadText(name, text, mime = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 资产/图片的可视化 URL（与 ComfyUI 标准 /view 一致）
export function viewUrl({ filename, subfolder, type }) {
  if (!filename) return "";
  const p = new URLSearchParams();
  p.set("filename", filename);
  p.set("type", type || "input");
  if (subfolder) p.set("subfolder", subfolder);
  return api.apiURL("/view?" + p.toString());
}

export const StudioAPI = {
  files: (folder, kind = "all") =>
    getJson(`/mrnext/studio/files?folder=${encodeURIComponent(folder)}&kind=${encodeURIComponent(kind)}`),
  browse: (path = "") =>
    getJson(`/mrnext/studio/browse?path=${encodeURIComponent(path)}`),
  upload: (folder, file) => {
    const fd = new FormData();
    fd.append("folder", folder);
    fd.append("file", file);
    return api.fetchApi("/mrnext/studio/upload", { method: "POST", body: fd }).then((r) => r.json());
  },
  importFiles: (folder, paths) => postJson("/mrnext/studio/import", { folder, paths }),
  // 把素材重命名为「剧本名字」（去机器名），返回新 rel —— 设定图/流水线生成后自动调用
  rename: (rel, name) => postJson("/mrnext/studio/rename", { rel, name }),
  split: (payload) => postJson("/mrnext/studio/split",
    typeof payload === "string" ? { script: payload } : (payload || {})),
  extractDefs: (script, prefix = "") =>
    postJson("/mrnext/studio/extract_defs", { script, prefix }),
  assetPlan: (script, prefix = "") => postJson("/mrnext/studio/asset_plan", { script, prefix }),
  savePlan: (folder, shots) => postJson("/mrnext/studio/save_plan", { folder, shots }),
  models: () => getJson("/mrnext/assetgen/models"),
  assetgenConfig: (useLora, loraFolder) => {
    const q = new URLSearchParams();
    if (useLora != null) q.set("enabled", useLora ? "1" : "0");
    if (loraFolder) q.set("extra", loraFolder);
    const s = q.toString();
    return getJson(`/mrnext/assetgen/config${s ? "?" + s : ""}`);
  },
  generate: (payload) => postJson("/mrnext/assetgen/generate", payload),
  enhanceImage: (payload) => postJson("/mrnext/assetgen/enhance", payload),
  seedvr2Status: () => getJson("/mrnext/assetgen/seedvr2_status"),
  vosr2Status: () => getJson("/mrnext/assetgen/vosr2_status"),
  // 时间线「清空」顺带清缓存：预览图 / 缩略图 / 旧分镜计划（避免旧缓存影响后续生成）
  timelineClearCache: (folder) => postJson("/mrnext/timeline/clear_cache", { folder }),
  videos: (folder = "") => getJson(`/mrnext/editor/videos?folder=${encodeURIComponent(folder)}`),
  probeEditor: (rel) => getJson(`/mrnext/editor/probe?rel=${encodeURIComponent(rel)}`),
  editorOptions: (useLora, loraFolder) => {
    const q = new URLSearchParams();
    if (useLora != null) q.set("enabled", useLora ? "1" : "0");
    if (loraFolder) q.set("extra", loraFolder);
    const s = q.toString();
    return getJson(`/mrnext/editor/options${s ? "?" + s : ""}`);
  },
  composeEditor: (folder, segments, music = "", audios = []) =>
    postJson("/mrnext/editor/compose", { folder, segments, music, audios }),
  scanSkills: (folder = "") =>
    getJson(`/mrnext/skills/scan${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`),
  readSkill: (folder, id) =>
    getJson(`/mrnext/skills/read?folder=${encodeURIComponent(folder)}&id=${encodeURIComponent(id)}`),
  skillsStatus: () => getJson("/mrnext/skills/status"),
  skillsModels: (folder = "") => getJson(`/mrnext/skills/models?folder=${encodeURIComponent(folder)}`),
  skillsRecommend: (model, folder = "") =>
    getJson(`/mrnext/skills/recommend?model=${encodeURIComponent(model)}&folder=${encodeURIComponent(folder)}`),
  loadSkillModel: (payload) => postJson("/mrnext/skills/load_model", payload),
  unloadSkillModel: () => postJson("/mrnext/skills/unload", {}),
  optimizePrompt: (payload) => postJson("/mrnext/skills/optimize", payload),
  favorites: () => getJson("/mrnext/favorites"),
  favoriteAdd: (items) => postJson("/mrnext/favorites/add", { items }),
  favoriteRemove: (x) => postJson("/mrnext/favorites/remove", Array.isArray(x) ? { items: x } : x),
  // 改收藏名（可选连磁盘文件一起改名）。body: {rel|id, name, rename_file?}
  favoriteRename: (payload) => postJson("/mrnext/favorites/rename", payload),
  adaptLongdoc: (text) => postJson("/mrnext/studio/adapt_longdoc", { text }),
  sanitizeWorkflow: (graph) => postJson("/mrnext/studio/sanitize_workflow", { graph }),
  exportStoryboard: (script, prefix = "") => rawText("/mrnext/studio/export", { script, prefix }),
  nativePick: (p) => postJson("/mrnext/studio/native_pick", p),
  paths: () => fetch("/mrnext/studio/paths").then((r) => r.json()),
  readLocalText: (path) => postJson("/mrnext/studio/read_text_file", { path }),
  importFolder: (folder, target) => postJson("/mrnext/studio/import_folder", { folder, target }),
  // 资产另存到用户选的本地文件夹（后端按分类建子目录：角色/场景/素材/音频）
  saveAsset: (payload) => postJson("/mrnext/studio/save_asset", payload),
  // 在系统文件管理器里定位文件（rel 或绝对 path）
  reveal: (payload) => postJson("/mrnext/studio/reveal", payload),
  // 本地文件被删/改名后，清掉它对应的缩略图缓存
  purgeThumbs: (rels) => postJson("/mrnext/media/purge_thumbs", { rels }),
  deleteFiles: (folder, names) => postJson("/mrnext/studio/delete_files", { folder, names }),
  clearFolder: (folder) => postJson("/mrnext/studio/clear_folder", { folder }),
  clearMaterials: (folder) => postJson("/mrnext/editor/clear_materials", { folder }),
  dedupeMaterials: (folder) => postJson("/mrnext/editor/dedupe", { folder }),
  deleteMaterials: (rels) => postJson("/mrnext/editor/delete_materials", { rels }),
  analyze: (texts, candidates) => postJson("/mrnext/studio/analyze", { texts, candidates }),
  mediaExists: (rels) => postJson("/mrnext/media/exists", { rels }),
  h3Shot: (payload) => postJson("/mrnext/h3/shot", payload),
  // 不出片，只回显 H3 官方三段式组装后的提示词（确认台词识别是否正确）
  h3PromptPreview: (payload) => postJson("/mrnext/h3/prompt_preview", payload),
  // 扫描工作流图里的「外部模型节点 / 第三方加速节点」（外接加速 → 内置加速自动失效）
  externalNodes: (graph) => postJson("/mrnext/h3/external_nodes", { graph }),
  h3FreeVram: () => postJson("/mrnext/h3/free_vram", {}),
  h3Upscale: (rel, engine, opts) => postJson("/mrnext/h3/upscale_video", { rel, engine, ...(opts || {}) }),
  h3UpscaleStatus: (taskId) => getJson(`/mrnext/h3/upscale_status?task_id=${encodeURIComponent(taskId)}`),
  // since：本次出片开始时间（epoch 秒）。带上它，服务端只返回"本次生成之后"写的预览图，
  // 彻底避免把上一轮（甚至别的模式/别的镜）留下的预览图当成"本次的实时预览"显示出来。
  previewLatestUrl: (pid, since) => api.apiURL(
    "/mrnext/h3/preview_latest?t=" + Date.now()
    + (pid ? "&pid=" + encodeURIComponent(pid) : "")
    + (since ? "&since=" + encodeURIComponent(since) : "")),
};

// 视频缩略图 URL（GET 返回图片）
export function editorThumbUrl(rel) {
  return api.apiURL("/mrnext/editor/thumb?rel=" + encodeURIComponent(rel));
}

// 把 rel（如 "mrboard_next/云妙衣.png" 或 "OUTPUT:video/xxx.mp4"）转成可展示 URL
export function relToViewUrl(rel) {
  if (!rel) return "";
  const r = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (r.startsWith("OUTPUT:")) {
    const p = r.slice("OUTPUT:".length);
    const idx = p.lastIndexOf("/");
    const filename = idx >= 0 ? p.slice(idx + 1) : p;
    const subfolder = idx > 0 ? p.slice(0, idx) : "";
    return viewUrl({ filename, subfolder, type: "output" });
  }
  const idx = r.lastIndexOf("/");
  const filename = idx >= 0 ? r.slice(idx + 1) : r;
  const subfolder = idx > 0 ? r.slice(0, idx) : "";
  return viewUrl({ filename, subfolder, type: "input" });
}
