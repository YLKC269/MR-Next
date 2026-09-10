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

    支持三种写法：
        角色 1 - 林晚：…
        角色 2 - 顾言之
        <Subject 1> 林晚：…
    """
    names, seen = [], set()
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


def split_dialogue(text, role_names=None):
    """把镜头文本拆成 (画面描述, 对白列表[{speaker, text}])。

    对白行整行从画面描述里移除；行内剩余的引号内容也会被剔除（避免重复念）。
    """
    role_set = set(role_names or [])
    visual_lines, dialogs = [], []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = RE_DIALOG_LINE.match(line)
        if m and _is_dialogue(m.group("sp"), m.group("verb"), m.group("dl"), role_set):
            sp = (m.group("sp") or "").strip()
            dl = (m.group("dl") or "").strip()
            q = RE_QUOTED_BLOCK.search(dl)
            if q:
                dl = q.group(1).strip()
            dl = dl.strip(" 「」『』“”\"'")
            if dl:
                dialogs.append({"speaker": sp or "", "text": dl})
                continue
        visual_lines.append(line)
    visual = "\n".join(visual_lines).strip()
    # 画面描述里残留的引号内容（无主台词）→ 归为无说话人对白
    for q in RE_QUOTED_BLOCK.finditer(visual):
        t = (q.group(1) or "").strip()
        if 1 < len(t) <= 300:
            dialogs.append({"speaker": "", "text": t})
    if dialogs:
        visual = RE_QUOTED_BLOCK.sub("", visual)
        visual = re.sub(r"[ \t]{2,}", " ", visual)
        visual = re.sub(r"\n{3,}", "\n\n", visual).strip()
    return visual, dialogs


def assign_speakers(dialogs, role_names=None):
    """给对白分配稳定的 (S1)/(S2)… 编号。

    编号来源优先级：
      ① 前缀角色名顺序（角色 1 → S1，角色 2 → S2）—— 跨镜头天然一致
      ② 新出现的名字：按首现顺序追加（再按名字排序兜底，保证同一名字同号）
    全程无状态，任何镜头单跑/乱序跑都得到同一组编号。
    """
    mapping = {}
    for i, nm in enumerate(role_names or []):
        mapping[nm] = "S%d" % (i + 1)
    nxt = len(mapping) + 1
    for d in dialogs or []:
        sp = (d.get("speaker") or "").strip()
        if not sp or sp in mapping:
            continue
        mapping[sp] = "S%d" % nxt
        nxt += 1
    return mapping


def _pick_lang(visual, style, dialogue):
    """判断本镜脚本语言 → 兜底文案跟随用户，避免英文指令压过中文画面描述。"""
    blob = "\n".join(
        [str(visual or ""), str(style or "")]
        + [str((d or {}).get("text") or "") for d in (dialogue or [])]
    )
    return CN if is_cjk(blob) else EN


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
    spoken = 0
    for d in dialogue:
        txt = (d.get("text") or "").strip()
        if not txt:
            continue
        sp = (d.get("speaker") or "").strip()
        sid = speaker_map.get(sp, "S1")
        who = ("%s (%s)" % (sp, sid)) if sp else ("(%s)" % sid)
        # 台词必须用 [语言] … ；绝不能用双引号（会被当成画面字幕）
        descs.append("%s says: [%s] %s" % (who, lang, txt))
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
    visual, dialogs = split_dialogue(text, names)
    if not visual and not dialogs:
        visual = text
    smap = assign_speakers(dialogs, names)
    # 公共前缀作为"全局风格 + 角色/场景定义"放在画面描述之前（不进声音字段，
    # 避免角色外貌描述被当成环境音/配乐念出来）。
    style_bits = []
    if prefix:
        style_bits.append(prefix)
    prompt = build_av_prompt(
        visual=visual,
        dialogue=dialogs,
        speaker_map=smap,
        ambience=o.get("av_ambience") or "",
        music=o.get("av_music") or "",
        no_speech=bool(o.get("av_no_speech")),
        lang=o.get("av_lang") or DEFAULT_LANG,
        style="",
        shot_no=shot_no,
        seconds=seconds,
        enabled=True,
    )
    if style_bits:
        prompt = prefix.strip() + "\n\n" + prompt
    return prompt, dialogs
