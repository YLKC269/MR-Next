"""h3prompt.py — MiniMax H3 官方提示词结构组装器（治「说话乱说 / 语音乱码」）。

问题根因（官方 H3 Prompt Writing Guide + 社区实测）：
    H3 是「音视频联合生成」模型。只给画面描述、不给声音字段时，模型会自己"补"
    人声与音效 —— 表现就是「张嘴说胡话」「两个人同时说话」「背景杂音乱入」。
    官方 Base Prompt 要求三段式，缺一段就会跑偏：

        integrated_multimodal_description:
        [Shot 1] <镜头/动作>…  <说话人> (S1) says: [Chinese] 台词

        overall_soundscape:
        <环境音 1-4 句，不含对白>

        non_diegetic_music:
        <画外配乐 1-3 句，或 N/A>

三条硬约束（写错必翻车）：
    1. 台词写成 `[语言] 台词`（如 `[Chinese] 你怎么也来了？`）。**不能**用双引号 ——
       双引号在 H3 里是"画面上可见的字"（招牌/字幕），会被渲染成字幕而非台词。
    2. 说话人用 (S1)/(S2)… 同一角色全程同号，否则音色/台词会在镜头间串台。
    3. 没有台词时必须**显式**写 `No dialogue`，否则模型照样会安排人说胡话。

本模块只做「结构化包装」，不翻译、不改写字面内容（用户原文一律保留）。
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------- 常量
DEFAULT_LANG = "Chinese"

# 无环境音时的保守兜底：只留底噪，明确禁止额外人声（防"乱说话"）。
# 有台词 / 无台词两套文案必须分开 —— 有台词时写 "No speech" 会跟上面的台词自相矛盾。
FALLBACK_AMBIENCE_MUTE = (
    "Natural, subtle ambience consistent with the scene. "
    "No speech, no dialogue, no overlapping voices, no unintended vocalization."
)
FALLBACK_AMBIENCE_SPEECH = (
    "Natural, subtle ambience consistent with the scene. "
    "Only the dialogue written above is spoken; no extra speech, "
    "no overlapping voices, no unintended vocalization."
)
# —— 中文精简兜底 ——
# 关键教训：官方 Prompt Guide 是给英文剧写的。中文短句（一行 30 字）配一整段
# 英文指令时，指令 token 数会超过画面描述本身 → 模型注意力被"不要说话"抢走
# → 画面不按提示词走。所以中文剧必须用同语言的短句兜底，把提示词主体还给画面。
FALLBACK_AMBIENCE_MUTE_CN = "贴合场景的自然环境音；无人声、无对话"
FALLBACK_AMBIENCE_SPEECH_CN = "贴合场景的自然环境音；除上述台词外无其他人声"

RE_CJK = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff]")


def is_cjk(text):
    """画面描述是否含中日韩文字 —— 决定兜底文案用哪种语言（跟随用户）。"""
    return bool(RE_CJK.search(str(text or "")))


EN, CN = "en", "cn"


def script_lang(text):
    """对外暴露的语言判定：给一句脚本 → 'cn' / 'en'。"""
    return CN if is_cjk(text) else EN


NO_MUSIC = "N/A"
NO_MUSIC_CN = "无配乐"

NO_DIALOGUE_MARK = "No dialogue. No speech, no vocalization of any kind."
NO_DIALOGUE_MARK_CN = "无台词，无人声"
# 内心独白：显式声明"嘴巴不动"，否则模型会让人物开口（口型假）
INNER_MONOLOGUE = "inner monologue (mouth closed, no lip movement, expression only)"
INNER_MONOLOGUE_CN = "内心独白（嘴巴紧闭、零嘴部动作，只用眼神与眉毛演戏）"

FALLBACK_AMBIENCE_SILENT = (
    "Quiet, natural room tone consistent with the scene. No speech at all."
)
FALLBACK_AMBIENCE_SILENT_CN = "安静的场景底噪；完全无人声"

# ---------------------------------------------------------------- 前缀角色名
RE_ROLE_LINE = re.compile(
    r"^\s*角色\s*(\d+)?\s*[-－—–:：]?\s*(?:(.+?)\s*[:：]\s*(.*)|(.+?))\s*$"
)
RE_SUBJECT_NAME = re.compile(r"^\s*<\s*Subject\s*\d+\s*>\s*([^：:\n]{1,24})")
RE_PICTURE_NAME = re.compile(r"^\s*<\s*Picture\s*\d+\s*>\s*([^：:\n]{1,24})")

# ---------------------------------------------------------------- 对白识别
# 形式 A：名字（惰性）+ 可选「低声/笑着…说/道/问/答」+ 冒号 + 台词
# sp 用惰性匹配，才能把「顾言之低声：…」正确切成 sp=顾言之 / verb=低声
RE_DIALOG_LINE = re.compile(
    r"^\s*(?P<sp>[^\s，。；、！？!?\n「」“”\"'『』:：]{1,16}?)"
    r"(?P<verb>(?:(?:低声|轻声|冷冷|笑着|喃喃|嘀咕|平静|缓缓|又|继续|转头|抬头|低头|回头|突然|微微|淡淡|急切)+"
    r"(?:说|道|喊|问|答|开口|回应|念|读|叹息|呢喃|吼)?)|"
    r"(?:说|道|喊|问|答|开口|回应|念|读|叹息|呢喃|吼))?"
    r"\s*[：:]\s*"
    r"(?P<dl>.{1,300}?)\s*$"
)
# 引号块（「」『』“”""''）—— 台词剔除 / 无主台词提取
RE_QUOTED_BLOCK = re.compile(r"[「『“\"']([^」』”\"'\n]{1,300}?)[」』”\"']")

# 明显是"镜头/风格/画面"说明而非对白的行，直接跳过
NON_SPEAKER_WORDS = (
    "镜头", "画面", "风格", "场景", "光线", "色调", "构图", "机位", "运镜", "时长",
    "备注", "说明", "动作", "音效", "配乐", "背景", "时间", "地点", "字幕", "转场",
)


def extract_role_names(prefix):
    """从公共前缀里抽出角色名（按出现顺序）。用于给 (S1)/(S2) 编号，保证跨镜头一致。

    支持四种写法：
        角色 1 - 林晚：…
        角色 2 - 顾言之
        <Subject 1> 林晚：…
        <Picture 1> 是林晚（S1）的角色参考图：…   ← 古风模板单行格式（场景参考图不算角色）
    """
    names, seen = [], set()
    for nm in prefix_role_names(prefix):     # 先抽单行格式（只认「角色参考图」）
        if nm not in seen:
            seen.add(nm)
            names.append(nm)
    for line in str(prefix or "").splitlines():
        line = line.strip()
        if not line:
            continue
        nm = ""
        m = RE_SUBJECT_NAME.match(line)
        if m:
            nm = (m.group(1) or "").strip()
        else:
            m = RE_ROLE_LINE.match(line)
            if m:
                nm = ((m.group(2) or m.group(4) or "").strip())
        # 名字里可能混着描述，取冒号前、去首尾标点
        if nm:
            nm = re.split(r"[（(]", nm)[0].strip(" ：:·-－—")
        if nm and 1 < len(nm) <= 16 and nm not in seen:
            seen.add(nm)
            names.append(nm)
    return names


def _is_dialogue(sp, verb, dl, role_set):
    """判定一行是不是对白（宁漏勿错：误判会把镜头说明变成台词，更糟）。"""
    sp = (sp or "").strip()
    dl = (dl or "").strip()
    if not sp or not dl:
        return False
    if sp in NON_SPEAKER_WORDS:
        return False
    if sp in role_set:          # 前缀里定义过的角色
        return True
    if verb:                    # 明确写了「说/道/问/答…」
        return True
    if RE_QUOTED_BLOCK.search(dl):  # 台词带引号
        return True
    return False


def split_dialogue(text, role_names=None, tag_roles=None, tag_sids=None):
    """把镜头文本拆成 (画面描述, 对白列表[{speaker, text, audio}])。

    对白行整行从画面描述里移除；行内剩余的引号内容也会被剔除（避免重复念）。
    """
    role_set = set(role_names or [])
    tag_roles = dict(tag_roles or {})
    tag_sids = dict(tag_sids or {})
    visual_lines, dialogs = [], []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        # 优先：行内「音色参考 <Audio N>：台词」（没写 <d> 的用户写法；一行可有多句）
        vline, vdlgs = split_inline_voice_line(line, tag_roles, tag_sids)
        if vdlgs:
            dialogs.extend(vdlgs)
            line = vline.strip()
            if not line:
                continue
        m = RE_DIALOG_LINE.match(line)
        if m and _is_dialogue(m.group("sp"), m.group("verb"), m.group("dl"), role_set):
            sp = (m.group("sp") or "").strip()
            dl = (m.group("dl") or "").strip()
            # 音色参考「… 音色参考 <Audio 1>：台词」→ 绑到这条台词（标记不能留在画面里当空壳）
            head2, an = split_voice_ref(line[:m.start("dl")])
            if an:
                line = (head2 + " " + (m.group("dl") or "")).strip()
            q = RE_QUOTED_BLOCK.search(dl)
            if q:
                dl = q.group(1).strip()
            dl = dl.strip(" 「」『』“”\"'")
            if dl:
                dialogs.append({"speaker": sp or "", "text": dl, "audio": an})
                continue
        visual_lines.append(line)
    visual = "\n".join(visual_lines).strip()
    # 画面描述里残留的引号内容（无主台词）→ 归为无说话人对白
    for q in RE_QUOTED_BLOCK.finditer(visual):
        t = (q.group(1) or "").strip()
        if 1 < len(t) <= 300:
            # 引号前若紧贴音色参考标记，一并绑上
            _head, an = split_voice_ref(visual[max(0, q.start() - 40):q.start()])
            dialogs.append({"speaker": "", "text": t, "audio": an})
    if dialogs:
        visual = RE_QUOTED_BLOCK.sub("", visual)
        # 已被搬进台词行的音色标记 → 画面里残留的空壳清掉
        visual = re.sub(RE_VOICE_REF_TAIL, "", visual)
        visual = strip_dangling_voice_label(visual)
        visual = re.sub(r"[ \t]{2,}", " ", visual)
        visual = re.sub(r"\n{3,}", "\n\n", visual).strip()
    return visual, dialogs


def assign_speakers(dialogs, role_names=None, explicit=None):
    """给对白分配稳定的 (S1)/(S2)… 编号。

    编号来源优先级：
      ① **模板自带的 (S1)/(S3)**（生产模板里 `云妙衣（S1）` 这种写法）—— 作者指定，最权威
      ② 前缀角色名顺序（角色 1 → S1，角色 2 → S2）—— 跨镜头天然一致
      ③ 新出现的名字：取当前没被占用的最小编号
    全程无状态，任何镜头单跑/乱序跑都得到同一组编号。
    """
    mapping, used = {}, set()
    for nm, sid in (explicit or {}).items():
        nm, sid = (nm or "").strip(), (sid or "").strip()
        if nm and sid:
            mapping[nm] = sid
            used.add(sid)

    def _free():
        k = 1
        while ("S%d" % k) in used:
            k += 1
        used.add("S%d" % k)
        return "S%d" % k

    for nm in (role_names or []):
        if nm and nm not in mapping:
            mapping[nm] = _free()
    # 台词自带的 S 编号（模板/前缀里作者指定，或按 <Picture N> 前缀表推出来的）
    for d in dialogs or []:
        sp = (d.get("speaker") or "").strip()
        sid = (d.get("sid") or "").strip()
        if sp and sid and sp not in mapping:
            mapping[sp] = sid
            used.add(sid)
    for d in dialogs or []:
        sp = (d.get("speaker") or "").strip()
        if sp and sp not in mapping:
            mapping[sp] = _free()
    return mapping


def _pick_lang(visual, style, dialogue):
    """判断本镜脚本语言 → 兜底文案跟随用户，避免英文指令压过中文画面描述。"""
    blob = "\n".join(
        [str(visual or ""), str(style or "")]
        + [str((d or {}).get("text") or "") for d in (dialogue or [])]
    )
    return CN if is_cjk(blob) else EN


# ---------------------------------------------------------------- 生产模板（结构化分镜）
# 内置 skills / 短剧生产模板的写法（对齐 0715 古风宫廷喜剧等）：
#   **详细描述：** 无字幕、无画面底部文字。3D CG，皮克斯卡通渲染…
#   【镜头 1】
#   [时长 8 秒]
#   **【本镜出场角色】**
#   <Picture 1> 云妙衣（S1）：高盘发垂长发，白淡粉汉服配薄荷绿镶边…
#   **【本镜站位】**
#   <Picture 1> 云妙衣：画面中央梨花木书案后…
#   [场景：公主房间 — 梨花木书案区域] [2 人说话：S1、S3，均开口说话] 中景。<Picture 1> 趴在书案上…：<d>[Chinese] 台词</d>
#   【本镜音效】
#   卡通特效音：拍桌子哐当
#   环境音：房间安静、烛火噼啪
RE_CAST_HEAD = re.compile(r"^\s*\**\s*[【\[]\s*本\s*镜\s*出场\s*角色\s*[】\]]\s*\**\s*$")
RE_POS_HEAD = re.compile(r"^\s*\**\s*[【\[]\s*本\s*镜\s*站位\s*[】\]]\s*\**\s*$")
RE_SFX_HEAD = re.compile(r"^\s*\**\s*[【\[]\s*本\s*镜\s*音效\s*[】\]]\s*\**\s*$")
# `<Picture 1> 云妙衣（S1）：外观描述` / `<Picture 1> 云妙衣：站位描述`
RE_CAST_LINE = re.compile(
    r"^\s*<\s*(Picture|Video|Audio|Subject)\s*(\d+)\s*>\s*([^：:\n]{1,24}?)\s*"
    r"(?:[（(]\s*(S\s*\d+)\s*[）)])?\s*[:：]\s*(.+)$", re.IGNORECASE)
RE_DUR_LABEL = re.compile(r"^\s*[\[（(]?\s*时长\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)\s*秒?\s*[\]）)]?\s*$")
RE_SFX_LABEL = re.compile(
    r"^\s*(卡通特效音|特效音|角色动作音|动作音|道具音|"
    r"液体\s*[/／]\s*分泌物音|液体音|环境音|人声拟音|配乐|背景音乐|音乐)\s*[:：]\s*(.*)$")
RE_D_TAG = re.compile(r"<\s*d\s*>(.*?)<\s*/\s*d\s*>", re.S | re.IGNORECASE)
RE_ANY_TAG = re.compile(r"<\s*(Picture|Video|Audio|Subject)\s*(\d+)\s*>", re.IGNORECASE)
# 行首时间码（00:08.000，）—— 生产模板里每镜标开始时刻，不是画面内容
RE_TC_LINE_PREFIX = re.compile(r"^\s*\d{1,2}\s*[:：]\s*\d{1,2}(?:\s*\.\s*\d{1,3})?\s*[，,、]?\s*")
# 结构化标记行（[场景：…] / 【镜头 N】 / 【分镜 N】 / [时长 …]）—— 出现即结束当前块
RE_MARK_LINE = re.compile(r"^\s*\**\s*[\[【]\s*(?:场景|镜头|分镜|时长|第\s*\d+\s*镜|[Ss]hot)\s*")
# 独白提示（嘴巴零动作）—— 生产模板规则：内心独白不张嘴
RE_INNER = re.compile(r"内心\s*独白|心里\s*想|心声|嘴巴\s*(?:紧闭|不动|零动作)|不\s*张嘴")

# ---------------------------------------------------------------- 音色参考（voice reference）
# 官方契约：独立参考音频按 <Audio j> 编号 → `ref_audios.ref_audio_{j-1}`
# （vendor/lib/ref_audios.py：reference_audio_prompt_tag(i) = "<Audio i+1>"）。
# 模板/用户写法是「…（音色参考）<Audio 1>：<d>台词</d>」。
#
# ⚠ 踩坑（用户实报「标记了音色参考却一直不被参考」）：
#   旧实现把这句 `<Audio 1>` 留在**画面描述**里，把 `<d>台词</d>` 抽到独立的
#   `(S1) says:` 行 → 组装后画面里剩下一句悬空的「音色参考 <Audio 1>：」，
#   台词却在不带任何标记的另一行。参考音频与"它要给谁配音"的绑定被切断，
#   模型自然不去用它。下面把 <Audio N> 搬进它配的那句台词行（官方 presentation
#   顺序 images → videos → standalone audio 不变，只是把标记写在同一句里）。
RE_VOICE_REF_TAIL = re.compile(
    r"(?:音\s*色|配\s*音|声\s*音|语\s*音|说\s*话\s*声|voice|timbre|tone)\s*"
    r"(?:参\s*考|参\s*照|来\s*源|取自|来自|用)?\s*[：:]?\s*"
    r"<\s*Audio\s*(\d+)\s*>\s*[：:]?\s*$", re.IGNORECASE)
RE_AUDIO_TAIL = re.compile(r"<\s*Audio\s*(\d+)\s*>\s*[：:]?\s*$", re.IGNORECASE)
# 关键词锚定的音色标记（不要求标记在行尾）：`音色参考 <Audio 1>，嘴巴零动作：`
RE_VOICE_KEY = re.compile(
    r"(?:音\s*色|配\s*音|说\s*话\s*声|语\s*音|voice|timbre|tone)\s*"
    r"(?:参\s*考|参\s*照|来\s*源|取自|来自|用)?\s*[：:]?\s*"
    r"<\s*Audio\s*(\d+)\s*>", re.IGNORECASE)
# 行内写法「音色参考 <Audio 1>：台词…」（没有 <d> 包裹时）；要求标记后紧跟分隔符，
# 否则 `环境音参考 <Audio 3> 是风声` 这种会被误当台词
RE_VOICE_REF_MID = re.compile(
    r"(?:音\s*色|配\s*音|说\s*话\s*声|语\s*音|voice|timbre|tone)\s*"
    r"(?:参\s*考|参\s*照|来\s*源|取自|来自|用)?\s*[：:]?\s*"
    r"<\s*Audio\s*(\d+)\s*>\s*[：:，,、]\s*", re.IGNORECASE)
# 台词终点：下一个说话人标记（<Picture/Subject/Video N>）
RE_SPEAKER_TAG = re.compile(r"<\s*(Picture|Subject|Video)\s*\d+\s*>", re.IGNORECASE)


def split_inline_voice_line(line, tag_roles=None, tag_sids=None):
    """一行里可能有**多句**「…<Picture N> 动作，音色参考 <Audio N>：台词」→ 逐句切开。

    返回 (画面文本, [对白项…])。说话人 = 该音色标记之前最近的 <Picture/Subject N>；
    台词终点 = 下一个说话人标记（或行尾），中间的动作描述留给画面。
    """
    marks = list(RE_VOICE_REF_MID.finditer(str(line or "")))
    if not marks:
        return str(line or ""), []
    tag_roles = dict(tag_roles or {})
    tag_sids = dict(tag_sids or {})
    visual_parts, dialogs = [], []
    cursor = 0
    for i, m in enumerate(marks):
        head = line[cursor:m.start()]
        refs = [r for r in RE_ANY_TAG.finditer(head)
                if (r.group(1) or "").lower() != "audio"]
        key = _tag_key(refs[-1].group(0)) if refs else ""
        end_limit = marks[i + 1].start() if i + 1 < len(marks) else len(line)
        nt = RE_SPEAKER_TAG.search(line, m.end(), end_limit)
        end = nt.start() if nt else end_limit
        visual_parts.append(head)
        dl = line[m.end():end].strip().strip(" 「」『』“”\"'")
        dl = re.sub(r"^\s*[\[【]\s*(?:[A-Za-z]+|中文|Chinese|English)\s*[\]】]\s*", "", dl).strip()
        if dl:
            dialogs.append({"speaker": tag_roles.get(key, ""), "text": dl,
                            "audio": int(m.group(1)), "sid": tag_sids.get(key, "")})
        cursor = end
    visual_parts.append(line[cursor:])
    return "".join(visual_parts), dialogs
# 悬空的音色标签（标记已被搬进台词行 → 画面里只剩「音色参考：」这种空壳，必须清掉）
RE_VOICE_LABEL = re.compile(
    r"(?:音\s*色|配\s*音|声\s*音|语\s*音)\s*(?:参\s*考|参\s*照|来\s*源)?\s*[：:]", re.IGNORECASE)
# 镜头行里「[2 人说话：S1、S3，均开口说话]」这类作者指定的说话人编号
RE_SPEAKER_HINT = re.compile(r"[\[【][^\]】]{0,24}?(?:人\s*说话|说话人)[^\]】]{0,24}?[\]】]")

# 前缀里的 `<Picture N>` / `<Subject N>` → 角色名（还有 S 编号）
#   形式 A1：`<Picture 1> 是云妙衣（S1）的角色参考图：高盘发…`（古风模板单行格式）
#   形式 A2：`<Picture 1> 云妙衣（S1）：高盘发…`
#   形式 B ：`角色 1 - 云妙衣：<Picture 1> 高盘发…`
# ⚠ 必须把「角色参考图」和「场景参考图」分开：`<Picture 4> 是公主府库房门口场景参考图：…`
#    里的 <Picture 4> 是**场景**参考图，误当角色会让台词挂到"公主府库房门口"这个说话人上。
RE_PREFIX_TAG_IS_ROLE = re.compile(
    r"^\s*[-*•]?\s*<\s*(Picture|Subject)\s*(\d+)\s*>\s*(?:是|为|即)?\s*"
    r"([^：:\n（(的]{1,20}?)\s*(?:[（(]\s*(S\s*\d+)\s*[）)])?\s*的?\s*"
    r"(?:角色|人物)\s*(?:参考图|参考)?\s*[：:]")
RE_PREFIX_TAG_FIRST = re.compile(
    r"^\s*[-*•]?\s*<\s*(Picture|Subject)\s*(\d+)\s*>\s*([^：:\n（(的]{1,20}?)\s*"
    r"(?:[（(]\s*(S\s*\d+)\s*[）)])?\s*[：:]")
RE_PREFIX_ROLE_LINE = re.compile(
    r"^\s*[-*•]?\s*(?:角色|人物|主角|配角)\s*\d*\s*[-－—–:：]?\s*([^：:\n]{1,20}?)\s*[：:]\s*(.+)$")
RE_PREFIX_SID = re.compile(r"[（(]\s*(S\s*\d+)\s*[）)]")
# 非角色的行首词（场景/道具/音效…里也会出现 <Picture N>，那是参考图不是说话人）
NON_ROLE_HEADS = ("场景", "地点", "时间", "道具", "音效", "配乐", "音乐", "画面", "风格", "光线")


def prefix_role_names(prefix):
    """前缀里「<Picture N> 是 名字（Sx）的角色参考图：…」这种单行格式 → 角色名（按顺序）。"""
    names = []
    for raw in str(prefix or "").splitlines():
        m = RE_PREFIX_TAG_IS_ROLE.match(raw.strip())
        if not m:
            continue
        nm = (m.group(3) or "").strip(" ：:·-－—")
        if nm and 1 < len(nm) <= 16 and nm not in names:
            names.append(nm)
    return names


def prefix_tag_roles(prefix, names=None):
    """从前缀里解析「<Picture N>/<Subject N> → 角色名（+ 作者指定 S 编号）」。

    模板只在前缀声明角色（`角色 1 - 云妙衣：<Picture 1> …`），镜头正文里则写
    `<Picture 1> …台词…`。没有这张映射表时，正文里 `<d>` 的说话人只能落到
    "上一个说话人" → 多角色镜头全部归到 S1（音色全串到一个人身上）。
    """
    tag_roles, tag_sids = {}, {}
    name_set = set(names or [])
    for raw in str(prefix or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        # 形式 A1：`<Picture 1> 是云妙衣（S1）的角色参考图：…`（明确写了"角色参考图"才算角色）
        m = RE_PREFIX_TAG_IS_ROLE.match(line)
        if m:
            nm = (m.group(3) or "").strip(" ：:·-－—")
            sid = re.sub(r"\s+", "", (m.group(4) or "")).upper()
            if nm and 1 < len(nm) <= 16:
                key = _tag_key("<%s %s>" % (m.group(1), m.group(2)))
                if key:
                    tag_roles[key] = nm
                    if sid:
                        tag_sids[key] = sid
            continue
        # 形式 A2：`<Picture 1> 云妙衣（S1）：…` —— 必须带作者指定 (Sx) 或名字在前缀角色表里，
        # 否则会把 `<Picture 4> 是公主府库房门口…` 这种场景行当角色
        m = RE_PREFIX_TAG_FIRST.match(line)
        if m:
            nm = (m.group(3) or "").strip(" ：:·-－—")
            sid = re.sub(r"\s+", "", (m.group(4) or "")).upper()
            if nm and 1 < len(nm) <= 16 and (sid or nm in name_set):
                key = _tag_key("<%s %s>" % (m.group(1), m.group(2)))
                if key:
                    tag_roles[key] = nm
                    if sid:
                        tag_sids[key] = sid
            continue
        m = RE_PREFIX_ROLE_LINE.match(line)
        if m:
            nm = (m.group(1) or "").strip(" ：:·-－—")
            nm = re.split(r"[（(]", nm)[0].strip()
            if not nm or not (1 < len(nm) <= 16):
                continue
            if any(nm.startswith(h) for h in NON_ROLE_HEADS):
                continue
            rest = m.group(2) or ""
            t = RE_ANY_TAG.search(rest)
            if not t:
                continue
            key = _tag_key(t.group(0))
            if key and key not in tag_roles:
                tag_roles[key] = nm
                sid = RE_PREFIX_SID.search(nm + rest)
                if sid:
                    tag_sids[key] = re.sub(r"\s+", "", sid.group(1)).upper()
    return tag_roles, tag_sids


def extract_speaker_hint(text):
    """镜头行里的「[2 人说话：S1、S3，均开口说话]」→ ['S1','S3']（作者指定编号）。"""
    m = RE_SPEAKER_HINT.search(str(text or ""))
    if not m:
        return []
    return ["S" + d for d in re.findall(r"[Ss]\s*(\d+)", m.group(0))]


def split_voice_ref(seg):
    """切出 seg 里的「音色参考 <Audio N>」→ (清理后的 seg, N or 0)。

    三种写法都要认（古风/短剧模板各不一样）：
      ① `音色参考 <Audio 1>：` 紧贴台词（标记在 seg 末尾）
      ② `音色参考 <Audio 1>，嘴巴零动作：`（关键词锚定，标记后面还有别的内容）
      ③ `<Audio 1>：` 紧贴台词（用户省略「音色参考」四字）
    判据必须**带音色关键词或紧贴台词**：`环境音参考 <Audio 3> 是风声…` 这种非配音用途
    的音频参考绝不能被搬进台词（否则音色串到环境音上）。
    """
    s = str(seg or "")
    m = RE_VOICE_REF_TAIL.search(s)
    if m:
        return s[:m.start()].rstrip(), int(m.group(1))
    m = RE_VOICE_KEY.search(s)
    if m:
        # 只摘掉标记与它前面的关键词标签，后面的画面/状态描述保留
        out = (s[:m.start()] + s[m.end():])
        out = re.sub(r"[，,、]\s*[，,、]", "，", out)
        out = re.sub(r"[ \t]{2,}", " ", out)
        return out.rstrip(" ，,、：:"), int(m.group(1))
    m = RE_AUDIO_TAIL.search(s)
    if m:
        return s[:m.start()].rstrip(), int(m.group(1))
    return s, 0


def strip_dangling_voice_label(text):
    """清掉已被搬走标记后剩下的空壳「音色参考：」（同一行里已无 <Audio 才清）。"""
    out = []
    for ln in str(text or "").splitlines():
        if "<Audio" not in ln and "<audio" not in ln:
            ln = RE_VOICE_LABEL.sub("", ln)
            ln = re.sub(r"[，。；、]?\s*[，。；、]", "，", ln)
            ln = re.sub(r"[ \t]{2,}", " ", ln).strip(" ，。；、")
            if ln.endswith("：") or ln.endswith(":"):
                ln = ln[:-1].rstrip()
        out.append(ln)
    return "\n".join(out)


def _tag_key(tag):
    """<' Picture ' 1 '> → '<Picture 1>'（统一大小写与空格）。"""
    m = RE_ANY_TAG.match(str(tag or ""))
    if not m:
        return ""
    kind = m.group(1).capitalize()
    return "<%s %s>" % (kind, int(m.group(2)))


def is_production_shot(text):
    """是不是「生产模板」式分镜（有本镜出场角色/站位/音效 或 <d> 台词）。"""
    t = str(text or "")
    if not t:
        return False
    return bool(RE_CAST_HEAD.search(t) or RE_POS_HEAD.search(t) or RE_SFX_HEAD.search(t)
                or RE_D_TAG.search(t))


def parse_shot_blocks(text, role_names=None, tag_roles=None, tag_sids=None):
    """把「生产模板」式镜头文本拆成结构化字段。不是该格式 → 返回 None（交回原逻辑）。

    tag_roles / tag_sids：前缀里解析出的「<Picture N> → 角色名 / S 编号」（见
    prefix_tag_roles）。模板只在前缀声明角色，正文用 `<Picture N>` 指代 → 没有这张
    表时正文 `<d>` 的说话人只能沿用上一位，多角色镜头会全归到 S1（音色全串台）。

    返回 {
      cast:  {"<Picture 1>": {name, sid, desc}},
      visual: str,                    # 画面描述（角色外观 + 站位 + 动作；已把 <Picture N> 换成人名）
      dialogue: [{speaker, sid, text, inner, audio}],   # audio = <Audio N> 的 N（0=无）
      ambience: str,                  # 【本镜音效】整理成 overall_soundscape 文案
      music: str,                     # 音效块里的「配乐」
    }
    """
    raw = str(text or "")
    if not is_production_shot(raw):
        return None
    tag_roles = dict(tag_roles or {})
    tag_sids = dict(tag_sids or {})

    cast, positions, sfx_items, music_items = {}, [], [], []
    section = None
    body_lines = []
    for raw_ln in raw.splitlines():
        ln = raw_ln.strip()
        if not ln:
            continue
        # ① 块头：任意位置都能识别
        if RE_CAST_HEAD.match(ln):
            section = "cast"
            continue
        if RE_POS_HEAD.match(ln):
            section = "pos"
            continue
        if RE_SFX_HEAD.match(ln):
            section = "sfx"
            continue
        if RE_DUR_LABEL.match(ln):
            section = None
            continue                       # [时长 8 秒] → 后端 marker_durs 负责
        # ② 结构化正文行（[场景：…] / 【镜头 N】 / 时间码+[场景…]）→ 结束当前块
        #    以前这里直接 continue，把镜头正文整行吞掉了（台词就没了）
        ln2 = RE_TC_LINE_PREFIX.sub("", ln)
        if RE_MARK_LINE.match(ln2) or RE_MARK_LINE.match(ln):
            section = None
        # ③ 按当前块分流（内容不匹配 → 结束块，落到正文，不丢行）
        if section == "cast":
            m = RE_CAST_LINE.match(ln)
            if m:
                key = _tag_key("<%s %s>" % (m.group(1), m.group(2)))
                cast[key] = {
                    "name": (m.group(3) or "").strip(),
                    "sid": re.sub(r"\s+", "", (m.group(4) or "")).upper(),
                    "desc": (m.group(5) or "").strip(),
                }
                continue
            section = None
        if section == "pos":
            m = RE_CAST_LINE.match(ln)
            if m:
                positions.append("%s：%s" % ((m.group(3) or "").strip(), (m.group(5) or "").strip()))
                continue
            section = None
        if section == "sfx":
            m = RE_SFX_LABEL.match(ln)
            if m:
                label, val = m.group(1), (m.group(2) or "").strip()
                if re.search(r"配乐|音乐", label):
                    if val:
                        music_items.append(val)
                elif val:
                    sfx_items.append("%s：%s" % (re.sub(r"\s+", "", label), val))
                continue
            section = None
        body_lines.append(ln2)

    # 台词：正文里的 <d>…</d>，说话人取"该 <d> 之前最近的 <Picture N>"对应的角色
    # 音色：正文里紧贴台词的「音色参考 <Audio N>：」→ 绑到这一条台词上（见 RE_VOICE_REF_TAIL 注释）
    dialogue, visual_lines = [], []
    last_who = ""
    hint_sids = extract_speaker_hint(raw)   # [2 人说话：S1、S3] → ['S1','S3']
    hint_turn = 0
    for ln in body_lines:
        out, pos = [], 0
        for m in RE_D_TAG.finditer(ln):
            seg = ln[pos:m.start()]
            who, audio_n = "", 0
            # 说话人判定：最近的 <Picture/Subject/Video N>（<Audio N> 只是音色参考，
            # 不能当说话人，否则台词会全部归到 S1）→ 其次段落里出现过的角色名 → 再其次沿用上一位
            refers = list(RE_ANY_TAG.finditer(seg))
            pick = [r for r in refers if (r.group(1) or "").lower() != "audio"]
            if not pick:
                pick = refers
            if pick:
                who = _tag_key(pick[-1].group(0))
            # 正文里的 <Picture N> 前缀里有声明 → 补一条 cast（模板正文常用这类指代）
            if who and who not in cast and tag_roles.get(who):
                cast[who] = {"name": tag_roles[who], "sid": tag_sids.get(who, ""), "desc": ""}
            if not who or not cast.get(who, {}).get("name"):
                named = [v["name"] for v in cast.values()
                         if v.get("name") and v["name"] in seg]
                if not named:
                    for _k, _nm in tag_roles.items():
                        if _nm and _nm in seg:
                            named.append(_nm)
                if named:
                    who = named[-1]
                    who = next((k for k, v in cast.items() if v["name"] == who), who)
                    if who not in cast:
                        cast[who] = {"name": named[-1], "sid": "", "desc": ""}
            if not who or not cast.get(who, {}).get("name"):
                who = last_who
            last_who = who
            # 音色参考：只认紧贴台词的写法
            seg, audio_n = split_voice_ref(seg)
            out.append(seg)
            entry = cast.get(who) or {}
            txt = (m.group(1) or "").strip()
            txt = txt.strip(" 「」『』“”\"'")
            txt = re.sub(r"^\s*[\[【]\s*(?:[A-Za-z]+|中文|Chinese|English)\s*[\]】]\s*", "", txt).strip()
            if txt:
                sid = (entry.get("sid") or "").strip() or tag_sids.get(who, "")
                if not sid and hint_sids:
                    sid = hint_sids[min(hint_turn, len(hint_sids) - 1)]
                    hint_turn += 1
                dialogue.append({"speaker": entry.get("name", ""), "sid": sid,
                                 "text": txt, "inner": bool(RE_INNER.search(seg)),
                                 "audio": audio_n})
            pos = m.end()
        out.append(ln[pos:])
        visual_lines.append("".join(out))

    # 画面：角色外观（保证跨镜一致）+ 站位 + 动作
    parts = []
    if cast:
        bits = []
        for v in cast.values():
            nm = (v.get("name") or "").strip()
            if not nm:
                continue
            _sid = (v.get("sid") or "").strip()
            _d = (v.get("desc") or "").strip().rstrip("。.")
            if _sid and _d:
                bits.append("%s（%s）%s" % (nm, _sid, _d))
            elif _sid:
                bits.append("%s（%s）" % (nm, _sid))
            elif _d:
                bits.append("%s：%s" % (nm, _d))
            else:
                bits.append(nm)
        if bits:
            parts.append("本镜角色：" + "；".join(bits))
    if positions:
        parts.append("本镜站位：" + "；".join(positions))
    body = "\n".join(x for x in visual_lines if x.strip()).strip()
    # 音色标记已被搬进台词行 → 画面里只剩「音色参考：」空壳，清掉（否则模型看到悬空指令）
    body = strip_dangling_voice_label(body)
    body = _clean_visual_text(body)
    if body:
        parts.append(body)

    return {
        "cast": cast,
        "visual": "\n".join(parts).strip(),
        "dialogue": dialogue,
        "ambience": "；".join(sfx_items),
        "music": "；".join(music_items),
    }


def _clean_visual_text(text):
    """只做空白/标点清理，**保留** <Picture N>/<Audio N> 标记。

    ⚠ 不能把这些标记换成角色名：它们是 H3 官方绑定参考槽的指针 ——
    `ref_image_k` 的 tooltip 原文就是 "Reference image for <Picture {k+1}>"，
    `<Audio N>` 对应 `ref_audios.ref_audio_{N-1}`。替换成人名 = 参考图/音色失去绑定
    （用户实报：音频参考不起作用）。
    """
    out = str(text or "")
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"：\s*：", "：", out)
    out = re.sub(r"\s+([：:，。；、])", r"\1", out)      # 「音色参考 ：」→「音色参考：」
    out = re.sub(r"([，。；、])\s*([，。；、])", r"\1", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _clean_prefix(prefix):
    """前缀送进提示词前只做空白清理（**保留** <Picture N> 等参考槽指针，见 _clean_visual_text）。"""
    out = str(prefix or "")
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\s+([：:，。；、])", r"\1", out)
    return "\n".join(ln.strip() for ln in out.splitlines() if ln.strip()).strip()


def build_av_prompt(*, visual="", dialogue=None, speaker_map=None,
                    ambience="", music="", no_speech=False,
                    lang=DEFAULT_LANG, style="", shot_no=1, seconds=0.0,
                    enabled=True):
    """组装 H3 官方三段式提示词。enabled=False 时原样返回 visual（不做任何包装）。"""
    visual = (visual or "").strip()
    if not enabled:
        return visual

    lang = (lang or DEFAULT_LANG).strip() or DEFAULT_LANG
    l = _pick_lang(visual, style, dialogue)

    if no_speech:
        dialogue = []
    dialogue = [d for d in (dialogue or [])]

    head = "[Shot %d]" % max(1, int(shot_no or 1))
    # 注意：不要把时长写成 "(5.0s)" —— 时长已由 total_frames / frame_rate 决定，
    # 写进提示词只会稀释注意力（尤其 cfg=1.0 无引导的 H3）。
    parts = []
    if style:
        parts.append(str(style).strip())
    if visual:
        parts.append(visual)
    descs = [" ".join([head] + parts).strip()]

    speaker_map = speaker_map or {}
    # 未知说话人的兜底顺序：按前缀角色顺序（S1、S2…）依次取，避免多角色镜头全归到 S1
    fallback_sids = [v for _k, v in sorted(speaker_map.items(), key=lambda kv: str(kv[1]))]
    fb = 0
    spoken = 0
    for d in dialogue:
        txt = (d.get("text") or "").strip()
        if not txt:
            continue
        sp = (d.get("speaker") or "").strip()
        sid = (d.get("sid") or "").strip() or speaker_map.get(sp, "")
        if not sid:
            sid = fallback_sids[min(fb, len(fallback_sids) - 1)] if fallback_sids else "S1"
            fb += 1
        who = ("%s (%s)" % (sp, sid)) if sp else ("(%s)" % sid)
        # 音色参考（官方 <Audio j> → ref_audios.ref_audio_{j-1}）：
        # **必须写在这一句台词上**，否则参考音频不知道要给谁配音（用户实报「音色不被参考」）。
        an = int(d.get("audio") or 0)
        vref = (" (voice reference <Audio %d>)" % an) if an > 0 else ""
        # 台词必须用 [语言] … ；绝不能用双引号（会被当成画面字幕）
        # 台词必须用官方的 <d>…</d> 包裹：<d> / </d> 在模型侧是**真实特殊 token**
        #   （comfy\text_encoders\minimax.py 里 id 151669/151670），官方 Prompt Guide 规定
        #   「<d> 内只放语言标签 + 原话，身份/编号/语气/音色参考写在 <d> 外」。
        #   不包 <d> 时模型只当成普通文本 → 口型与音色对齐都变差（本项为对齐官方导演台）。
        if d.get("inner"):
            # 生产模板规则「内心独白时嘴巴紧闭零动作」：写成独白并显式声明不张嘴，
            # 否则 H3 会让人物开口说话（口型对不上，观众一眼看出假）
            descs.append("%s%s %s: <d>[%s] %s</d>" % (who, vref, INNER_MONOLOGUE_CN if l == CN else INNER_MONOLOGUE, lang, txt))
        else:
            descs.append("%s says%s: <d>[%s] %s</d>" % (who, vref, lang, txt))
        spoken += 1
    # 关键：一句台词都没有时必须显式声明"不要人声"，否则 H3 会自己安排人说胡话。
    # 用跟脚本同语言的最短写法：中剧写「无台词，无人声」而非一整段英文。
    if not spoken:
        descs.append(NO_DIALOGUE_MARK_CN if l == CN else NO_DIALOGUE_MARK)

    amb = (ambience or "").strip()
    if not amb:
        if no_speech:
            amb = FALLBACK_AMBIENCE_SILENT_CN if l == CN else FALLBACK_AMBIENCE_SILENT
        elif spoken:
            amb = FALLBACK_AMBIENCE_SPEECH_CN if l == CN else FALLBACK_AMBIENCE_SPEECH
        else:
            amb = FALLBACK_AMBIENCE_MUTE_CN if l == CN else FALLBACK_AMBIENCE_MUTE
    mus = (music or "").strip() or (NO_MUSIC_CN if l == CN else NO_MUSIC)

    return (
        "integrated_multimodal_description:\n"
        + "\n".join(descs).strip()
        + "\n\noverall_soundscape:\n" + amb
        + "\n\nnon_diegetic_music:\n" + mus
    )


def apply_audio_guard(opts, default_min_steps=8):
    """低步数音频护栏：把 steps 抬到安全线，返回 (新 opts 拷贝, 提示文案)。

    社区实测（Kijai / Comfy-Org）：ComfyUI **稳定版** 在 H3 上跑低于 8 步时，
    画面正常但音轨失真/变噪音 —— 根因是主仓 bug（修复 commit bdcb886，仅在
    nightly）。本护栏不改模型、不改采样器，只把步数兜到安全线，保证出片音轨可用。

    例外：T8 双时钟分离采样（dual_clock）开启且音频独立步数已达安全线时，
    音轨在自己的时钟推进、不受视频低步数拖累 —— 不抬步数（否则预览档的
    6 步提速会被强行抬回 8+，白丢社区方案的收益）。
    """
    o = dict(opts or {})
    g = o.get("audio_guard", True)
    if g in (False, "false", "False", "0", 0, "off", "no", ""):
        return o, ""
    try:
        min_steps = int(o.get("audio_min_steps") or default_min_steps)
    except (TypeError, ValueError):
        min_steps = default_min_steps
    min_steps = max(4, min(32, min_steps))
    if o.get("dual_clock"):
        try:
            sa = int(o.get("steps_audio") or 0)
        except (TypeError, ValueError):
            sa = 0
        if sa >= min_steps:
            return o, ""
    cur = o.get("steps")
    try:
        cur_i = int(cur) if cur not in (None, "") else None
    except (TypeError, ValueError):
        cur_i = None
    if cur_i is None or cur_i <= 0 or cur_i >= min_steps:
        return o, ""
    o["steps"] = min_steps
    note = (
        "步数 %d < %d：低步数下 ComfyUI 稳定版有音频失真缺陷"
        "（官方修复 commit bdcb886，需升级 nightly）。已自动抬到 %d 步以保证音轨正常。"
        % (cur_i, min_steps, min_steps))
    return o, note


def assemble(*, text="", prefix="", role_names=None, opts=None, shot_no=1, seconds=0.0):
    """一站式：镜头原文 + 公共前缀 + opts → H3 官方结构提示词。

    opts 字段（全部可选）：
        av_structure   bool  是否启用官方三段式（默认 True）
        av_lang        str   台词语言标签（默认 Chinese）
        av_ambience    str   环境音描述（留空=自动保守兜底）
        av_music       str   配乐描述（留空=N/A）
        av_no_speech   bool  静音模式：完全不要人声
    """
    o = opts or {}
    enabled = o.get("av_structure", True)
    if enabled in (None, ""):
        enabled = True
    enabled = bool(enabled) and enabled not in ("false", "False", "off", "0")

    text = str(text or "").strip()
    prefix = str(prefix or "").strip()
    if not text:
        return "", []
    if not enabled:
        return ((prefix + "\n\n" + text).strip() if prefix else text), []

    names = list(role_names or extract_role_names(prefix))
    # 前缀 → 「<Picture N> = 哪个角色 / 作者给的 S 编号」：模板正文只写 <Picture N>，
    # 没有这张表就无法判断"这句台词是谁说的"（多角色镜头会全归 S1 → 音色全串一个人）
    tag_roles, tag_sids = prefix_tag_roles(prefix, names)
    blk = parse_shot_blocks(text, names, tag_roles, tag_sids)
    blk_amb, blk_mus = "", ""
    if blk:
        # 生产模板（本镜出场角色/站位/音效 + <d> 台词）：结构化拆分，
        # 音效块 → overall_soundscape；<d> → 台词；<Picture N> → 角色名
        visual = blk.get("visual") or text
        dialogs = blk.get("dialogue") or []
        blk_amb, blk_mus = blk.get("ambience") or "", blk.get("music") or ""
        explicit = {}
        # 前缀里作者指定的 S 编号（`角色 1 - 云妙衣（S1）：<Picture 1> …`）
        for _tag, _sid in tag_sids.items():
            _nm = tag_roles.get(_tag, "")
            if _nm and _sid:
                explicit.setdefault(_nm, _sid)
        for v in (blk.get("cast") or {}).values():
            if v.get("name") and v.get("sid"):
                explicit[v["name"]] = v["sid"]
        smap = assign_speakers(dialogs, names, explicit)
    else:
        visual, dialogs = split_dialogue(text, names, tag_roles, tag_sids)
        if not visual and not dialogs:
            visual = text
        smap = assign_speakers(dialogs, names)
    # 公共前缀作为"全局风格 + 角色/场景定义"放在画面描述之前（不进声音字段，
    # 避免角色外貌描述被当成环境音/配乐念出来）。
    # 前缀里可能带 <Picture N>/<Subject N> 等"素材引用"标记（如「角色 1 - 云妙衣：<Picture 1> 高盘发…」），
    # 这些是给素材匹配用的，写进提示词只会稀释注意力 → 组装前清掉（保留角色名与描述）
    prefix_clean = _clean_prefix(prefix)
    style_bits = [prefix_clean] if prefix_clean else []
    prompt = build_av_prompt(
        visual=visual,
        dialogue=dialogs,
        speaker_map=smap,
        ambience=o.get("av_ambience") or blk_amb,
        music=o.get("av_music") or blk_mus,
        no_speech=bool(o.get("av_no_speech")),
        lang=o.get("av_lang") or DEFAULT_LANG,
        style="",
        shot_no=shot_no,
        seconds=seconds,
        enabled=True,
    )
    if prefix_clean:
        prompt = prefix_clean + "\n\n" + prompt
    return prompt, dialogs
