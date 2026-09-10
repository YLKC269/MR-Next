// core/prefix_parser.js — 公共前缀分段解析器（纯前端）
//
// 目标：从公共前缀里按行序抽出"角色"、"场景"、"全局风格"三类条目，并建立
//       `<Subject N>` / `<Picture N>` / `<Style 全局>` 之间的引用关系。
//       这样"角色 1 - 张老汉：<Subject 1>"等占位会自动展开为 Subject 1 的真实描述。
//
// 输出 schema：
//   {
//     style: string,                       // `<Style 全局>` / `风格：…` 内容
//     subjects: [{ n, name, raw, desc }],  // 按出现顺序
//     pictures: [{ n, name, raw, desc }],
//     roleBlocks: [{ index, name, raw, desc, resolved }],   // resolved = 替换 <Subject N> 后的描述
//     sceneBlocks: [{ index, name, raw, desc, resolved }],  // resolved = 替换 <Picture N> 后的描述
//     warnings: [...],                     // 行号 / 解析失败提示
//   }
//
// 容错覆盖（都是真实用户写法，v1.9.6 起全部支持）：
//   ① `<Subject 1> 林晚：28岁女性，及肩黑发`（标签 + 名字 + 描述同行）
//   ② `<Subject 1>` 独占一行 → `林晚` / `名称：林晚` / `描述：…` 写在后续行
//   ③ `【角色】/【角色设定】/## 一、人物/角色：` 小标题 + `- 林晚：描述` / `1. 林晚：描述` 列表
//   ④ `角色1：林晚，28岁女性`（序号 + 冒号 + 名字、逗号分隔描述 —— 不会把整串当名字）
//   ⑤ `角色 1 - 张老汉：满脸皱纹` / `场景 1 - 破庙：残破的庙宇`
//   ⑥ 裸 `林晚：28岁女性`（无小标题）→ 默认角色；名字像地点自动判为场景
//   ⑦ `<Style 全局> 冷色调` / `<Style 全局>` 换行 / `风格：冷色调`
//   ⑧ Markdown 噪声：`- `、`**粗体**`、`## 标题`、`` ` ` `` 自动剥离

// ---------------- 正则 ----------------
const RE_STYLE_TAG = /^\s*<\s*Style\s*(?:全局|全局风格|global)?\s*>\s*[:：]?\s*(.*?)\s*$/i;
const RE_STYLE_KV = /^\s*(?:全局\s*)?(?:风格|画风|样式|基调|视觉风格|style)\s*[:：]\s*(.+)$/i;
const RE_TAG = /^\s*<\s*(Subject|Picture)\s*[_\-]?\s*(\d+)\s*>\s*(.*?)\s*$/i;

// 小标题：「【角色】」「**场景设定**」「## 一、人物」「场景：」……独立成行 → 决定后续条目归属
const SEC_ROLE_WORDS = ["角色设定", "角色定义", "角色列表", "角色介绍", "出场人物", "人物设定", "人物介绍", "人设", "角色", "人物", "主角", "配角"];
const SEC_SCENE_WORDS = ["场景设定", "场景定义", "场景列表", "场景介绍", "场景描述", "场景表", "环境设定", "环境描述", "场景", "环境", "地点", "场所", "置景"];
const RE_SECTION = new RegExp(
  "^\\s*(?:[#>\\-*•·○●–—=_]\\s*)*" +
  "(?:(?:\\d{1,2}|[一二三四五六七八九十]{1,3})\\s*[.、)）]\\s*)?" +
  "[<【\\[「《(（]?\\s*(" + [...SEC_ROLE_WORDS, ...SEC_SCENE_WORDS].join("|") + ")\\s*[>】\\]」》)）]*\\s*[*_]*\\s*[:：]?\\s*$"
);
const SEC_ROLE_TEST = new RegExp("^(?:" + SEC_ROLE_WORDS.join("|") + ")");

// 显式「角色 N …」/「场景 N …」（N 可为阿拉伯/中文数字，分隔符可为 -—–：、.）
const RE_ROLE_LINE = /^\s*角色\s*(?:(\d{1,2}|[一二三四五六七八九十]{1,3})\s*)?[-－—–:：、.．)）]?\s*(.+?)\s*$/;
const RE_SCENE_LINE = /^\s*场景\s*(?:(\d{1,2}|[一二三四五六七八九十]{1,3})\s*)?[-－—–:：、.．)）]?\s*(.+?)\s*$/;
// 标签后是否紧接数字/分隔符（区分「角色 1 - 名字」和散文「角色之间的关系」）
const RE_HAS_SEP = /^\s*(?:角色|场景)\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})?\s*[-－—–:：、.．)）]/;

// 键值行：「- 名字：描述」「1. 名字：描述」「名字：描述」（名字长度设限，避免把整句当名字）
const RE_KV = /^\s*[-*•·○●–—]?\s*(?:\d{1,2}\s*[.、)）]\s*)?([^:：\n]{1,24})\s*[:：]\s*(.+)$/;
const RE_NAME_ONLY = /^\s*(?:名称|名字|姓名|角色名|场景名)\s*[:：]\s*(.+)$/;
const RE_DESC_ONLY = /^\s*(?:描述|外观|外貌|设定|简介|说明|特征|形象|造型|长相|服装|服饰)\s*[:：]\s*(.+)$/;
const RE_BULLET = /^\s*(?:[-*•·○●–—]|\d{1,2}\s*[.、)）])\s*/;

// 这些词开头的"名字"不是角色/场景，避免误判（风格：xxx 被当成角色）
const NOT_A_NAME = /^(风格|样式|画风|基调|描述|名称|名字|姓名|时间|镜头|景别|时长|秒|音效|配乐|音乐|参考|负面|画面|备注|尺寸|比例|注意|要求|全局|输出|格式|语言|台词|人物关系|其它|其他|镜头号|序号|编号|场景名|角色名|说明|定妆|造型)/;
// 名字里含这些词 → 多半是"关系/属性说明行"，不是具体角色/场景（如「角色之间的关系：…」）
const NAME_BAD_WORD = /(之间|关系|设定|列表|介绍|说明|描述|定义|特点|性格|背景|命运|作用|态度|感情|心理|动机|要求|注意|参考|服装|服饰|外貌|外观|长相|形象|年龄|身高|体型|声音)/;

// 名字像"地点"→ 自动判为场景（只在明确的场所词上生效，避免误伤人名）
const SCENE_NAME_HINT = /(街头|街道|小巷|巷子|路口|客厅|卧室|厨房|卫生间|浴室|书房|餐厅|酒吧|咖啡馆|茶馆|办公室|会议室|教室|走廊|楼道|楼梯|天台|阳台|庭院|院子|花园|公园|广场|大厅|大堂|车站|地铁|机场|码头|港口|医院|学校|大学|超市|商场|市场|仓库|车库|地下室|电梯|教堂|寺庙|宫殿|城堡|村庄|小镇|城市|森林|树林|沙漠|海滩|海边|湖边|河边|山谷|山顶|雪原|废墟|战场|营房|飞船|驾驶舱|太空|星际|雨夜|清晨|黄昏|夜晚|室内|室外|店内|房内|楼顶|桥上|车里|车内)$/;

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

// ---------------- 主入口 ----------------
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
  let seqCounter = 0;      // 全局 push 序号（role + scene 一起计）—— 用于 planDefinitionJobs 保序
  let section = null;      // 'role' | 'scene' | null（由小标题决定）
  let pending = null;      // 等待后续行的标签：{kind, n, tag, rawHeader, name, desc, lineNo}
  let lastBlock = null;    // 上一行刚生成的块（只活一行：供紧邻的「描述：…」续写）

  // 新建一个角色/场景块（统一入口：编号、seq、subjects/pictures 表都在这里维护）
  const addBlock = (kind, name, desc, rawLine, n, tag) => {
    const nm = cleanName(name);
    if (!nm) return null;
    const de = String(desc || "").trim();
    const list = kind === "role" ? out.roleBlocks : out.sceneBlocks;
    const blk = {
      index: list.length + 1,
      name: nm,
      raw: rawLine || (nm + (de ? "：" + de : "")),
      desc: de,
      resolved: de,
      order: list.length,
      seq: seqCounter++,
    };
    if (tag) blk.tag = tag;
    list.push(blk);
    if (tag) {
      const tl = tag === "Subject" ? out.subjects : out.pictures;
      const num = n || tl.length + 1;
      if (!tl.some((s) => s.n === num)) tl.push({ n: num, name: nm, raw: rawLine || nm, desc: de });
    }
    lastBlock = blk;
    return blk;
  };

  const pushRole = (name, desc, rawLine, lineNo) => {
    const nm = cleanName(name);
    if (!nm) { out.warnings.push(`第 ${lineNo} 行：角色定义缺少名字（如「角色 1 - 名字：描述」）`); return; }
    if (!isValidName(nm)) { out.warnings.push(`第 ${lineNo} 行：不像角色定义（已忽略）：` + String(rawLine || "").slice(0, 40)); return; }
    addBlock("role", nm, desc, rawLine, 0, "");
  };
  const pushScene = (name, desc, rawLine, lineNo) => {
    const nm = cleanName(name);
    if (!nm) { out.warnings.push(`第 ${lineNo} 行：场景定义缺少名字（如「场景 1 - 名字：描述」）`); return; }
    if (!isValidName(nm)) { out.warnings.push(`第 ${lineNo} 行：不像场景定义（已忽略）：` + String(rawLine || "").slice(0, 40)); return; }
    addBlock("scene", nm, desc, rawLine, 0, "");
  };

  // 把 pending（标签独占一行时攒的）落成一个块
  const flushPending = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    const nm = (p.name || "").trim();
    const de = (p.desc || "").trim();
    if (!nm && !de) return;                      // 没抓到任何内容 → 丢弃
    const fallback = p.kind === "role" ? `角色${out.roleBlocks.length + 1}` : `场景${out.sceneBlocks.length + 1}`;
    addBlock(p.kind, nm || fallback, de, p.rawHeader, p.n, p.tag);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (!line.trim()) continue;
    // 纯分隔线（--- / === / ___ / *** / ···）→ 静默跳过：它本来就没内容，
    // 不算"未识别"（时间码格式剧本常在定义头与分镜之间放一条 ---）
    if (/^\s*[-=_*~·]{3,}\s*$/.test(line.trim())) continue;
    // 去掉 markdown / 子弹噪声后的"干净行"（`- `、`**`、`#`、反引号）——所有语义正则都用它
    const clean = stripMd(line);

    const prevBlock = lastBlock;   // 只允许"紧邻的下一行"续写
    lastBlock = null;

    // 1) 全局风格
    let m = RE_STYLE_TAG.exec(clean);
    if (m) {
      const v = (m[1] || "").trim();
      if (v) { out.style = out.style ? (out.style + "，" + v) : v; continue; }
      for (let j = i + 1; j < lines.length; j++) {      // 内容留空 → 取下一非空行
        if (lines[j].trim()) { const t = stripMd(lines[j]); out.style = out.style ? (out.style + "，" + t) : t; i = j; break; }
      }
      continue;
    }
    m = RE_STYLE_KV.exec(clean);
    if (m) {
      flushPending();
      const v = (m[1] || "").trim();
      if (v) out.style = out.style ? (out.style + "，" + v) : v;
      continue;
    }

    // 2) 小标题（【角色】/【场景】/人物/场景设定…）→ 决定后续条目归属；先收尾 pending
    m = RE_SECTION.exec(clean);
    if (m) {
      flushPending();
      section = SEC_ROLE_TEST.test(m[1]) ? "role" : "scene";
      continue;
    }

    // 3) <Subject N> / <Picture N>
    m = RE_TAG.exec(clean);
    if (m) {
      flushPending();
      const tag = /^subject$/i.test(m[1]) ? "Subject" : "Picture";
      const kind = tag === "Subject" ? "role" : "scene";
      const n = parseInt(m[2], 10) || 0;
      const rest = (m[3] || "").replace(/^[:：]\s*/, "").trim();
      let name = "", desc = "";
      if (rest) ({ name, desc } = splitNameDesc(rest));
      pending = { kind, n, tag, rawHeader: line.trim(), name, desc, lineNo };
      continue;   // 名字/描述若写在下一行，会在 pending 分支里被接住
    }

    // 4) 「角色 N …」/「场景 N …」
    if (/^\s*角色/.test(clean)) {
      m = RE_ROLE_LINE.exec(clean);
      if (m && !isProseDefLine(clean, m)) {
        flushPending();
        const { name, desc } = splitNameDesc(m[2] || "");
        pushRole(name, desc, line.trim(), lineNo);
        continue;
      }
    }
    if (/^\s*场景/.test(clean)) {
      m = RE_SCENE_LINE.exec(clean);
      if (m && !isProseDefLine(clean, m)) {
        flushPending();
        const { name, desc } = splitNameDesc(m[2] || "");
        pushScene(name, desc, line.trim(), lineNo);
        continue;
      }
    }

    // 5) 正在等后续行的标签：吃「名称：X」「描述：Y」/ 列表项 / 裸文本
    if (pending) {
      let mm = RE_NAME_ONLY.exec(clean);
      if (mm) { pending.name = (mm[1] || "").trim(); continue; }
      mm = RE_DESC_ONLY.exec(clean);
      if (mm) {
        pending.desc = [pending.desc, (mm[1] || "").trim()].filter(Boolean).join("；");
        continue;
      }
      if (RE_BULLET.test(line)) {
        if (pending.name) { flushPending(); i--; continue; }   // 已有名字 → 这是新条目，收尾后重扫
        const { name, desc } = splitNameDesc(clean.replace(RE_BULLET, "").trim());
        if (name) pending.name = name;
        if (desc) pending.desc = [pending.desc, desc].filter(Boolean).join("；");
        continue;
      }
      if (/^\s*(?:<|【|\[|「|《|#)/.test(clean)) { flushPending(); i--; continue; }
      if (!pending.name) {
        // 裸文本也可能是「名字：描述」→ 用同一套切分规则，别把整串当名字
        const sd = splitNameDesc(clean);
        pending.name = sd.name;
        if (sd.desc) pending.desc = [pending.desc, sd.desc].filter(Boolean).join("；");
      } else {
        pending.desc = [pending.desc, clean].filter(Boolean).join("；");
      }
      continue;
    }

    // 6) 续写上一行的块：紧邻的「描述：…」→ 追加到上一个角色/场景
    m = RE_DESC_ONLY.exec(clean);
    if (m && prevBlock) {
      const v = (m[1] || "").trim();
      prevBlock.desc = [prevBlock.desc, v].filter(Boolean).join("；");
      prevBlock.resolved = prevBlock.desc;
      const tl = prevBlock.tag === "Subject" ? out.subjects : prevBlock.tag === "Picture" ? out.pictures : null;
      if (tl) { const e = tl.find((s) => s.n && s.name === prevBlock.name); if (e) e.desc = prevBlock.desc; }
      lastBlock = prevBlock;
      continue;
    }

    // 7) 裸条目 → 默认角色；【场景】下或名字像地点 → 场景
    //    7a「名字：描述」（含 - 列表 / 1. 列表）
    //    7b 无冒号的列表项 / 小标题下的裸行（如「- 林晚（28岁女性）」「雨夜街头 霓虹倒影」）
    m = RE_KV.exec(clean);
    let nm = "", de = "";
    if (m) { nm = cleanName(m[1]); de = (m[2] || "").trim(); }
    if (!isValidName(nm) && (RE_BULLET.test(line) || section)) {
      const sd = splitNameDesc(clean.replace(RE_BULLET, "").trim());
      nm = sd.name; de = sd.desc;
    }
    if (isValidName(nm)) {
      const asScene = section === "scene" || (section !== "role" && looksLikeScene(nm));
      if (asScene) pushScene(nm, de, line.trim(), lineNo);
      else pushRole(nm, de, line.trim(), lineNo);
      continue;
    }

    // 8) 自由行
    out.warnings.push(`第 ${lineNo} 行未被识别（将忽略）：` + line.trim().slice(0, 60));
  }
  flushPending();

  // 跨段引用展开（按最常见命名风格）
  const subjMap = new Map(out.subjects.map((s) => [`<Subject ${s.n}>`, s.desc || s.raw]));
  const picMap = new Map(out.pictures.map((p) => [`<Picture ${p.n}>`, p.desc || p.raw]));

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

// ---------------- 辅助 ----------------
// 去掉 markdown / 子弹 / 引用噪声，得到"干净行"
export function stripMd(s) {
  let t = String(s || "");
  t = t.replace(/^\s*(?:[#>*_•·○●–—=]+\s*)+/, "");   // 行首标题符 / 子弹 / 引用符
  t = t.replace(/\*\*/g, "").replace(/`/g, "").replace(/^\s*__|__\s*$/g, "");
  return t.trim();
}

// 清理名字：剥括号 / 「角色 N」前缀 / 首尾标点
export function cleanName(n) {
  let s = String(n || "").trim();
  s = s.replace(/\*\*/g, "").replace(/`/g, "").trim();
  s = s.replace(/^[<【\[「《(（]\s*/, "");
  s = s.replace(/^(?:角色|人物|场景|地点|环境|主角|配角|人设)\s*\d{0,2}\s*[>】\]」》)）]?\s*[-－—–:：、.．]?\s*/, "");
  s = s.replace(/\s*[>】\]」》)）]$/, "");
  s = s.replace(/^[-－—–*•·○●\s]+/, "");
  s = s.replace(/[\s\-－—–*:：、.．]+$/, "");
  return s.trim();
}

// 名字像"地点"→ 算场景
function looksLikeScene(name) {
  return SCENE_NAME_HINT.test(cleanName(name));
}

// 名字是否像一个具体的角色/场景名（挡掉「角色之间的关系」「服装：…」这类属性行）
function isValidName(nm) {
  const s = cleanName(nm);
  if (!s) return false;
  if (s.length > 24) return false;
  if (NOT_A_NAME.test(s)) return false;
  if (NAME_BAD_WORD.test(s)) return false;
  return true;
}

// 「角色之间的关系：复杂」这种散文行不该被当作定义（无序号、无分隔符、正文过长且含冒号/句号）
function isProseDefLine(clean, m) {
  const hasNum = !!m[1];
  const hasSep = RE_HAS_SEP.test(clean);
  if (hasNum || hasSep) return false;
  const body = (m[2] || "").trim();
  return body.length > 18 && /[：:，,。；;]/.test(body);
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

/** "名字：描述" / "名字，描述" / "名字（说明）" / "名字 描述" 兼容切分 */
export function splitNameDesc(s) {
  let t = String(s || "").trim();
  if (!t) return { name: "", desc: "" };
  t = t.replace(/^\*\*\s*/, "").replace(/\s*\*\*$/, "").replace(/`/g, "").trim();
  // A) 「名字：描述」—— 冒号前 ≤24 字才算名字（避免把整句当名字）
  let m = /^(.{1,24}?)\s*[:：]\s*(.+)$/.exec(t);
  if (m) return { name: cleanName(m[1]), desc: m[2].trim() };
  // B) 「名字：」（冒号结尾，没写描述）
  m = /^(.{1,24}?)\s*[:：]\s*$/.exec(t);
  if (m) return { name: cleanName(m[1]), desc: "" };
  // C) 「名字（括号说明）」→ 名字 + 括号内容当描述（先于逗号切分，避免「林晚（28岁，女性）」被切碎）
  m = /^([^（(]{1,16}?)\s*[（(]\s*(.+?)\s*[）)]$/.exec(t);
  if (m) return { name: cleanName(m[1]), desc: m[2].trim() };
  // C2) 无冒号 → 用第一个逗号/顿号/分号断开：「林晚，28岁女性…」
  m = /^([^，,、;；]{1,16})\s*[，,、;；]\s*(.+)$/.exec(t);
  if (m) return { name: cleanName(m[1]), desc: m[2].trim() };
  // D) 用空格断开：「林晚 28岁女性」
  m = /^(.{1,12}?)[\s　]+(.+)$/.exec(t);
  if (m) return { name: cleanName(m[1]), desc: m[2].trim() };
  return { name: cleanName(t), desc: "" };
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

// 中文数字 → number（保留给后续扩展：角色一 / 场景二）
export function cnNumToInt(s) {
  const t = String(s || "").trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (t.length === 1 && CN_NUM[t]) return CN_NUM[t];
  const m = /^十([一二三四五六七八九])?$/.exec(t);
  if (m) return 10 + (m[1] ? CN_NUM[m[1]] : 0);
  return 0;
}
