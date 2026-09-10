// core/prefix_parser.js — 公共前缀分段解析器（纯前端）
//
// 目标：从公共前缀里按行序抽出"角色"、"场景"、"全局风格"三类条目，并建立
//       `<Subject N>` / `<Picture N>` / `<Style 全局>` 之间的引用关系。
//       这样"角色 1 - 张老汉：<Subject 1>"等占位会自动展开为 Subject 1 的真实描述。
//
// 输出 schema：
//   {
//     style: string,                       // `<Style 全局>` 内容
//     subjects: [{ n, name, raw, desc }],  // 按出现顺序
//     pictures: [{ n, name, raw, desc }],
//     roleBlocks: [{ index, name, raw, desc, resolved }],   // resolved = 替换 <Subject N> 后的描述
//     sceneBlocks: [{ index, name, raw, desc, resolved }],  // resolved = 替换 <Picture N> 后的描述
//     warnings: [...],                     // 行号 / 解析失败提示
//   }

const RE_STYLE      = /^\s*<\s*Style\s*全局\s*>\s*(.+?)\s*$/i;
const RE_SUBJECT    = /^\s*<\s*Subject\s+(\d+)\s*>\s*(.+?)\s*$/i;
const RE_PICTURE    = /^\s*<\s*Picture\s+(\d+)\s*>\s*(.+?)\s*$/i;
// 角色/场景行：分支 regex — 有冒号 vs 无冒号
//   分支 A：「角色 N - 名字: 描述」→ group(2)=名字, group(3)=描述
//   分支 B：「角色 N - 名字」       → group(4)=整段名字
const RE_ROLE_LINE  = /^\s*角色\s*(\d+)?\s*[-－—–:]?\s*(?:(.+?)\s*[:：]\s*(.*)|(.+))$/;
const RE_SCENE_LINE = /^\s*场景\s*(\d+)?\s*[-－—–:]?\s*(?:(.+?)\s*[:：]\s*(.*)|(.+))$/;

/**
 * 主入口：解析 prefix 文本。
 * 接受多行字符串；按换行分段（兼容 \r\n / \n / \r）；
 * 忽略空行；保留原始段序。
 */
export function parsePrefixDef(prefix) {
  const out = {
    style: "",
    subjects: [],
    pictures: [],
    roleBlocks: [],
    sceneBlocks: [],
    warnings: [],
  };
  const text = String(prefix || "");
  if (!text.trim()) return out;

const lines = text.split(/\r?\n/);
    let seqCounter = 0; // 全局 push 序号（role + scene 一起计）—— 用于 planDefinitionJobs 保序
    for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (!line.trim()) continue;

    // 1) 全局风格
    let m = RE_STYLE.exec(line);
    if (m) {
      const v = m[1].trim();
      // 多个 <Style 全局> 行时，合并（用全角逗号分隔）
      out.style = out.style ? (out.style + "，" + v) : v;
      continue;
    }

    // 2) Subject（角色定义）
    m = RE_SUBJECT.exec(line);
    if (m) {
      const n = parseInt(m[1], 10) || (out.subjects.length + 1);
      const rest = m[2];
      const { name, desc } = splitNameDesc(rest);
      out.subjects.push({ n, name, raw: rest, desc });
      continue;
    }

    // 3) Picture（场景定义）
    m = RE_PICTURE.exec(line);
    if (m) {
      const n = parseInt(m[1], 10) || (out.pictures.length + 1);
      const rest = m[2];
      const { name, desc } = splitNameDesc(rest);
      out.pictures.push({ n, name, raw: rest, desc });
      continue;
    }

    // 4) 角色 N - 名字：描述
    m = RE_ROLE_LINE.exec(line);
    if (m && /^\s*角色/.test(line)) {
      const name = ((m[2] || m[4] || "")).trim();
      const descRaw = (m[3] || "").trim();
      if (!name) {
        out.warnings.push(`第 ${lineNo} 行：角色定义缺少名字（"角色 N - 名字：描述"）`);
        continue;
      }
      out.roleBlocks.push({
        index: out.roleBlocks.length + 1,
        name,
        raw: line.trim(),
        desc: descRaw,
        resolved: descRaw, // 后面做跨段引用展开再覆盖
        order: out.roleBlocks.length, // push 顺序（从 0 起），用于跨类排序
        seq: seqCounter++,
      });
      continue;
    }

    // 5) 场景 N - 名字：描述
    m = RE_SCENE_LINE.exec(line);
    if (m && /^\s*场景/.test(line)) {
      const name = ((m[2] || m[4] || "")).trim();
      const descRaw = (m[3] || "").trim();
      if (!name) {
        out.warnings.push(`第 ${lineNo} 行：场景定义缺少名字（"场景 N - 名字：描述"）`);
        continue;
      }
      out.sceneBlocks.push({
        index: out.sceneBlocks.length + 1,
        name,
        raw: line.trim(),
        desc: descRaw,
        resolved: descRaw,
        order: out.sceneBlocks.length,
        seq: seqCounter++,
      });
      continue;
    }

    // 6) 自由行（含 `<Subject N>` 引用等）—— 也算作"角色定义"，尝试用首字段作名字
    if (line.trim().length > 0) {
      // 默认按"自由行"算，仅当 prefix 里已有 Subject / Picture 但未填角色行时，
      // 这里不主动入队，避免污染；改用 warnings 提示用户检查。
      out.warnings.push(`第 ${lineNo} 行未被识别（将忽略）：` + line.trim().slice(0, 60));
    }
  }

  // 跨段引用展开（按最常见命名风格）
  const subjMap = new Map(out.subjects.map((s) => [`<Subject ${s.n}>`, s.desc || s.raw]));
  const picMap  = new Map(out.pictures.map((p) => [`<Picture ${p.n}>`, p.desc || p.raw]));

  for (const rb of out.roleBlocks) {
    // 例："角色 1 - 张老汉：<Subject 1>"：把 <Subject 1> 替换为 Subject 1 的完整描述；
    //     角色行还可能自有额外描述：保留并接在主描述后
    const refs = collectTagNums(rb.desc || "", /<\s*Subject\s+(\d+)\s*>/);
    const subjDesc = refs.map((n) => subjMap.get(`<Subject ${n}>`) || "").filter(Boolean).join("；");
    rb.resolved = joinDesc(subjDesc, stripTagRefs(rb.desc || "", "Subject"));
    rb.subjectRefs = refs;
  }

  for (const sb of out.sceneBlocks) {
    const refs = collectTagNums(sb.desc || "", /<\s*Picture\s+(\d+)\s*>/);
    const picDesc = refs.map((n) => picMap.get(`<Picture ${n}>`) || "").filter(Boolean).join("；");
    sb.resolved = joinDesc(picDesc, stripTagRefs(sb.desc || "", "Picture"));
    sb.pictureRefs = refs;
  }

  return out;
}

// 收集 text 里某个 tag 的所有编号（返回 number[]）
function collectTagNums(text, re) {
  const g = new RegExp(re.source, re.flags + "g");
  const out = [];
  for (const m of text.matchAll(g)) out.push(parseInt(m[1], 10));
  return out;
}

// 把所有 <Tag N> 引用从 text 中剥离，返回剩下的"原生描述"
function stripTagRefs(text, tag) {
  return text.replace(new RegExp("<\\s*" + tag + "\\s+\\d+\\s*>", "g"), "").trim();
}

// 拼接主描述 + 角色/场景自身附加描述（中间"；"分隔）
function joinDesc(main, extra) {
  const m = (main || "").trim();
  const e = (extra || "").trim();
  if (m && e) return m + "；" + e;
  return m || e;
}

/** "名字：描述" / "名字 - 描述" 兼容切分 */
function splitNameDesc(s) {
  s = String(s || "");
  // 优先匹配"名字：描述"
  let m = /^(.+?)\s*[:：]\s*(.*)$/.exec(s);
  if (m) return { name: m[1].trim(), desc: (m[2] || "").trim() };
  // 否则按空格或全角空格断句：前半是名字（≤6字），后半是描述
  m = /^(.{1,12}?)[\s　]+(.+)$/.exec(s);
  if (m) return { name: m[1].trim(), desc: (m[2] || "").trim() };
  return { name: s.trim(), desc: "" };
}

/**
 * 给定一次"角色/场景设定图"任务的统一 prompt 模板。
 * - globalTone：从 <Style 全局> / 全部角色+场景共享基调 派生
 * - 同一种 kind 内：所有 prompt 用同一份 wrap，保证"高度一致"
 */
export function buildDefinitionPrompt(kind, entry, ctx) {
  const { name = "", resolved = "", raw = "" } = entry || {};
  const tone = (ctx && ctx.style ? String(ctx.style).trim() : "") || "电影级光影，超高清细腻";
  if (kind === "role") {
    return (
      `${tone}。` +
      `角色三视图设定卡：${name || "角色"}。` +
      (resolved ? `外观描述：${resolved}。` : "") +
      `同一角色正面 / 侧面 / 背面三视角并排显示，全身完整（包括脚），` +
      `脸型 · 发型 · 服饰 · 配色在三个视角间严格一致，电影级构图，超高清。`
    );
  }
  if (kind === "scene") {
    return (
      `${tone}。` +
      `场景概念设定图：${name || "场景"}。` +
      (resolved ? `环境描述：${resolved}。` : "") +
      `无人物，远景/全景构图，自然光为主，环境氛围与 ${tone} 一致，干净无杂物，超高清。`
    );
  }
  // fallthrough：用整行原文当 desc
  return `${tone}。${name || raw || ""}。统一的高清细节，电影感。`;
}

/**
 * 把 parsePrefixDef 结果 → 生成 jobs（每条 { kind, name, prompt, w, h }）
 * 严格保持 prefix 中出现的顺序：
 *   - 每个 role/scene block 有一个 seq（prefix 文本中"按行扫描"的全局序号，从 0 起）
 *   - 把 role + scene 合并按 seq 升序排，得到 prefix 原始顺序
 *   - 同一条 prefix 里出现"角色 N + 场景 N 混排"，按行序出 jobs
 */
export function planDefinitionJobs(parsed, { width = 768, height = 1344 } = {}) {
  const all = [];
  for (const rb of parsed.roleBlocks) {
    all.push({
      kind: "role",
      index: rb.index,
      seq: rb.seq,
      name: rb.name,
      prompt: buildDefinitionPrompt("role", rb, { style: parsed.style }),
      w: width, h: height,
    });
  }
  for (const sb of parsed.sceneBlocks) {
    all.push({
      kind: "scene",
      index: sb.index,
      seq: sb.seq,
      name: sb.name,
      prompt: buildDefinitionPrompt("scene", sb, { style: parsed.style }),
      w: width, h: height,
    });
  }
  all.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return all;
}
