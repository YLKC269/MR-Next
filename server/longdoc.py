"""longdoc.py — 长文档剧本适配。

把 0715 风格的长文档（项目简报 / 角色卡 / 场景卡 / Sxx-Ns 镜头表 / 单文本分镜）
转成节点可跑格式：抽「角色 / 场景 / 道具」定义 → 公共前缀；把每镜每秒面板
压成逐镜正文。

返回：{detected, title, prefix, script, shots}
  - detected=False → 未识别到镜头结构，原样不可适配。
"""

import re

_RE = re

_SHOT_HEAD_RE = _RE.compile(
    r"^(#{1,3}\s*S(\d+)\s*/\s*(\d+)s(?:\s*[—-]?\s*(.*?))?\s*$)"
)
_PANEL_RE = _RE.compile(r"^#{1,5}\s*(\d+)\s*[—\-–~至到]+\s*(\d+)\s*s", _RE.I)
_ROLE_RE = _RE.compile(r"(?:主角|配角|角色)\s*([\w\u4e00-\u9fa5-]+)\s*\(([^)]+)\)")
_SCENE_RE = _RE.compile(r"scene:([\w\u4e00-\u9fa5-]+)")
_PROP_RE = _RE.compile(r"prop:([\w\u4e00-\u9fa5-]+)")


def adapt(raw):
    if not raw:
        return {"detected": False}

    if not (_RE.search(r"#{1,3}\s*S\d+\s*/\s*(\d+)s", raw)
            or _RE.search(r"\*\*S\d+\s*/\s*(\d+)s", raw)):
        return {"detected": False}

    lines = raw.splitlines()
    title = ""
    m = _RE.search(r"项目[：:]\s*《([^》]+)》", raw)
    if m:
        title = m.group(1)

    # 1) 公共前缀：角色 / 场景 / 道具 定义（尽力而为）
    roles = {}
    scenes = {}
    props = {}
    for i, ln in enumerate(lines):
        cm = _ROLE_RE.search(ln)
        if cm:
            name = cm.group(1)
            if name not in roles:
                roles[name] = {"kind": cm.group(2), "desc": []}
            for j in range(i + 1, min(i + 12, len(lines))):
                l2 = lines[j].strip()
                if _RE.match(r"^\s*[-*]\s*(造型|材质|特征|标签)", l2):
                    roles[name]["desc"].append(l2.lstrip("-* ").strip())
                elif _RE.match(r"^\s*\d+\.", l2) or (not l2 and j - i > 2):
                    break
        sm = _SCENE_RE.search(ln)
        if sm:
            scenes.setdefault(sm.group(1).rstrip("-"), "")
        pm = _PROP_RE.search(ln)
        if pm:
            props.setdefault(pm.group(1).rstrip("-"), "")
        m2 = _RE.search(r"\*\*主环境总览\*\*[：:]\s*(.+)", ln)
        if m2 and scenes:
            last = next(iter(scenes))
            scenes[last] = m2.group(1).strip()
        m3 = _RE.search(r"^\s*[-*]\s*\*\*关键光态\*\*[：:]\s*(.+)", ln)
        if m3 and scenes:
            last = next(iter(scenes))
            scenes[last] = (scenes[last] + " " + m3.group(1).strip()).strip()

    prefix = []
    if roles:
        prefix.append("角色定义：")
        for name, d in roles.items():
            head = f"- 角色 {name}（{d['kind']}）："
            if d["desc"]:
                head += "\n      - " + "\n      - ".join(d["desc"])
            prefix.append(head)
    if scenes:
        prefix.append("场景定义：")
        for nm, desc in scenes.items():
            prefix.append("- 场景 " + nm + (f"：{desc}" if desc else ""))
    if props:
        prefix.append("道具定义：")
        for nm, desc in props.items():
            prefix.append("- 道具 " + nm + (f"：{desc}" if desc else ""))
    prefix_text = "\n".join(prefix)

    # 2) 抽镜头 Sxx / Ns → 逐镜正文
    shots = []
    cur = None
    for ln in lines:
        bm = _SHOT_HEAD_RE.match(ln.strip())
        if bm:
            if cur:
                shots.append(cur)
            cur = {"no": bm.group(2), "sec": int(bm.group(3)),
                   "title": (bm.group(4) or "").strip(), "lines": []}
            continue
        if cur is not None:
            if _RE.match(r"^#+\s*STEP|^-{3,}\s*$", ln.strip()):
                continue
            cur["lines"].append(ln)
    if cur:
        shots.append(cur)

    # 每镜：面板区间行 + 字段行 → 一句面板行（｜ 连接）
    chunks = []
    for s in shots:
        txts = []
        panel = None
        for ln in s["lines"]:
            pm = _PANEL_RE.match(ln.strip())
            if pm:
                panel = f"{pm.group(1)}-{pm.group(2)}s"
                txts.append(panel)
                continue
            t = ln.strip().lstrip("-* ")
            if not t:
                continue
            if panel is not None and t.split("：")[0] in (
                    "姿态", "镜头", "音频", "表演备注", "交接"):
                if txts and txts[-1].startswith(panel):
                    txts[-1] += "｜" + t
            elif panel is None:
                txts.append(t)
        title_part = f"[S{s['no']} {s['sec']}s" + (f" {s['title']}]" if s["title"] else "]")
        chunks.append("【镜头%d】%s %s" % (len(chunks) + 1, title_part, "；".join(txts)))

    return {
        "detected": True,
        "title": title,
        "prefix": prefix_text,
        "script": "\n\n".join(chunks),
        "shots": shots,
    }
