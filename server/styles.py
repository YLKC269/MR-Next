"""Krea2 风格扩展（397 种 → 兼容 3946 种）读取与缩略图服务。

数据来源：ComfyUI-Easy-Use 的 `styles/` 目录（与 Easy-Use 的「风格选择器」节点共用同一批
JSON，保证两边选同一种风格得到同一段提示词）。每个 JSON 是一个数组，元素形如：

    {"name": "Anime Style", "name_cn": "动漫风格",
     "prompt": "Style: ... Subject:{prompt}", "negative_prompt": "",
     "thumbnail": "./samples/动漫__Anime Style.jpg"}

设计要点（踩过的坑，别改回去）：
  1. `styles/` 下同时存在两类文件：
       krea2_397styles-*.json  —— 精修的 397 种（10 个大类）
       Krea2_moodboard_*.json  —— moodboard 扩展（3549 张缩略图，合计 3946 条）
     两者都加载，用户看到的是「全量」。
  2. `thumbnail` 字段有三种形态，必须都兜住，否则前端破图：
       "./samples/xxx.jpg"                        → styles/samples/xxx.jpg
       "./samples/moodboard/xxx.webp"             → styles/samples/moodboard/xxx.webp
       "https://...krea.ai/..."                   → 远端 URL（离线环境会 404，需前端兜底）
       "./3D渲染__xxx.jpg"（相对 styles 根，文件其实在 samples/ 下）→ 回退按 basename 在 samples 找
  3. 分类：优先取文件名里 `_` 之间/末尾的中文段（`krea2_397styles-anime_动漫` → `动漫`），
     否则用 moodboard 的英文分类键（`2D_动漫卡通` → `2D 动漫卡通`）。
  4. `{prompt}` 占位符语义与 Easy-Use 完全一致（见 py/nodes/prompt.py::stylesPromptSelector.execute）：
     第一条带 `{prompt}` 的风格把 `{prompt}` 替换成用户提示词，后续风格追加时去掉 `{prompt}`。
"""

import json
import logging
import os

log = logging.getLogger("ComfyUI-MRBoard.styles")

# 缓存：{mtime_key: payload}，避免每次打开面板都重读 46 个 JSON（合计 ~1.5MB）
_CACHE = {"key": None, "data": None}

_IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


def _comfy_root():
    """ComfyUI 根目录（本文件在 <root>/custom_nodes/ComfyUI_MRBoard_Next/server/ 下）。"""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def styles_dirs():
    """按优先级返回候选 styles 目录列表（第一个存在的即为生效目录）。

    1) ComfyUI-Easy-Use/styles  —— 官方风格扩展目录（本包默认只读这里）
    2) 本包自带 styles          —— 用户没装 Easy-Use 时的兜底（可自行放 JSON）
    """
    root = _comfy_root()
    cands = [
        os.path.join(root, "custom_nodes", "ComfyUI-Easy-Use", "styles"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "styles"),
    ]
    out = []
    for p in cands:
        p = os.path.normpath(p)
        if os.path.isdir(p) and p not in out:
            out.append(p)
    return out


def styles_dir():
    dirs = styles_dirs()
    return dirs[0] if dirs else ""


def _basename_index(samples_root):
    """samples（含 moodboard 子目录）里 basename(小写) → 绝对路径。

    用于兜住 `thumbnail` 写成相对 styles 根、但文件实际在 samples 下的脏数据。
    """
    idx = {}
    if not samples_root or not os.path.isdir(samples_root):
        return idx
    for dirpath, _dirnames, filenames in os.walk(samples_root):
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in _IMG_EXTS:
                idx.setdefault(fn.lower(), os.path.join(dirpath, fn))
    return idx


def _resolve_thumb(sdir, thumb, basename_idx):
    """把 JSON 里的 thumbnail 字段解析成绝对路径；解析不到返回 ""（前端走兜底样式）。"""
    t = str(thumb or "").strip()
    if not t:
        return ""
    low = t.lower()
    if low.startswith("http://") or low.startswith("https://") or low.startswith("data:"):
        # 远端 URL 不代理（离线环境拿不到），交给前端 onerror 兜底
        return ""
    p = t.replace("\\", "/")
    if p.startswith("./"):
        p = p[2:]
    cand = os.path.normpath(os.path.join(sdir, p))
    # 越界保护
    if not cand.startswith(os.path.normpath(sdir) + os.sep) and cand != os.path.normpath(sdir):
        return ""
    if os.path.isfile(cand):
        return cand
    # 回退 1：文件在 samples/ 下，JSON 少写了 samples 前缀
    b = os.path.basename(p).lower()
    if b in basename_idx:
        return basename_idx[b]
    # 回退 2：samples 下同名不同分隔的空格/下划线差异（如 "The_Mitchells vs_The_Machines"）
    alt = b.replace("_", " ").replace("  ", " ")
    for k, v in basename_idx.items():
        if k.replace("_", " ").replace("  ", " ") == alt:
            return v
    return ""


def _cat_from_filename(fname):
    """从文件名推分类中文名。

    krea2_397styles-anime_动漫.json            → 动漫
    Krea2_moodboard_2D_动漫卡通1.json         → 2D 动漫卡通   （无中文段时回退英文键）
    Krea2_moodboard_Photo-FX-Cool_摄影特效冷1 → 摄影特效冷
    Krea2_moodboard_3D_3D渲染.json            → 3D渲染（与 397styles 的 3D渲染 合并同名）
    """
    stem = os.path.splitext(fname)[0]
    if stem == "fooocus_styles":
        return "Fooocus"
    # 统一去掉前缀，只留分类部分
    s = stem
    for pre in ("krea2_397styles-", "Krea2_397styles-", "krea2_397styles_", "Krea2_397styles_"):
        if s.startswith(pre):
            s = s[len(pre):]
            break
    else:
        for pre in ("Krea2_moodboard_", "krea2_moodboard_"):
            if s.startswith(pre):
                s = s[len(pre):]
                break
    # 397styles 的英文键自带下划线（cover_art / digital_painting / 3d_render），
    # moodboard 是 EN_CN。中文段永远在**最后一段**，所以取 rpartition 而不是 partition。
    _head, _sep, tail = s.rpartition("_")
    cand = tail if (_sep and tail) else s
    # 去掉末尾序号（"摄影特效冷1" → "摄影特效冷"）
    cat = cand.rstrip("0123456789").strip()
    cat = cat.replace("-", " ").replace("_", " ").strip()
    if not cat:
        return "其他"
    # 纯英文分类（如 moodboard 的 "2D" / "Cinema-Tone" / "Other"）→ 保留但规整
    if not _is_cn(cat):
        fix = {"other": "其他", "2d": "2D 动漫卡通", "cinema tone": "电影色调"}
        return fix.get(cat.lower(), cat)
    return cat


def _is_cn(s):
    return any("\u4e00" <= ch <= "\u9fff" for ch in str(s or ""))


def load_styles(force=False):
    """读取全部风格条目。

    返回 {"dir": <生效目录>, "categories": [{key,label,count}], "styles": [item...]}
    item: {id, name, name_cn, label, category, prompt, negative_prompt, thumb}
      - label    = name_cn 优先（中文界面友好），没有才用 name
      - category = 分组键（也是排序键）
    结果按 (category, name) 稳定排序，id 用 `分类::name` 保证唯一可引用。
    """
    dirs = styles_dirs()
    if not dirs:
        return {"dir": "", "categories": [], "styles": [], "error": "未找到 styles 目录"}
    sdir = dirs[0]
    try:
        mtimes = []
        files = []
        for fn in sorted(os.listdir(sdir)):
            full = os.path.join(sdir, fn)
            if not (os.path.isfile(full) and fn.lower().endswith(".json")):
                continue
            if fn == "your_styles.json.example":
                continue
            files.append(fn)
            mtimes.append(f"{fn}:{os.path.getmtime(full):.0f}")
        key = f"{sdir}|" + ",".join(mtimes)
    except Exception as exc:  # noqa: BLE001
        return {"dir": sdir, "categories": [], "styles": [], "error": f"扫描 styles 目录失败: {exc}"}
    if not force and _CACHE["key"] == key and _CACHE["data"] is not None:
        return _CACHE["data"]

    samples_root = os.path.join(sdir, "samples")
    bidx = _basename_index(samples_root)
    styles = []
    seen = set()
    errors = 0
    for fn in files:
        full = os.path.join(sdir, fn)
        cat = _cat_from_filename(fn)
        try:
            with open(full, "r", encoding="utf-8") as f:
                arr = json.load(f)
        except Exception as exc:  # noqa: BLE001
            errors += 1
            log.warning("风格 JSON 解析失败 %s: %s", fn, exc)
            continue
        if not isinstance(arr, list):
            continue
        for i, it in enumerate(arr):
            if not isinstance(it, dict):
                continue
            name = str(it.get("name") or "").strip()
            prompt = str(it.get("prompt") or it.get("prompt_text") or "").strip()
            if not name or not prompt:
                continue
            sid = f"{cat}::{name}"
            if sid in seen:
                # 重名（实测 "Playful Retro Pop" 在 moodboard 里出现两次）→ 加后缀保唯一
                k = 2
                while f"{sid}#{k}" in seen:
                    k += 1
                sid = f"{sid}#{k}"
            seen.add(sid)
            name_cn = str(it.get("name_cn") or "").strip()
            styles.append({
                "id": sid,
                "name": name,
                "name_cn": name_cn,
                "label": name_cn or name,
                "category": cat,
                "prompt": prompt,
                "negative_prompt": str(it.get("negative_prompt") or "").strip(),
                "thumb": _resolve_thumb(sdir, it.get("thumbnail"), bidx),
            })

    styles.sort(key=lambda x: (x["category"], x["name"].lower()))
    cats = {}
    for s in styles:
        c = cats.setdefault(s["category"], 0)
        cats[s["category"]] = c + 1
    categories = [{"key": k, "label": k, "count": v} for k, v in sorted(cats.items())]
    data = {"dir": sdir, "categories": categories, "styles": styles, "count": len(styles),
            "errors": errors}
    _CACHE["key"] = key
    _CACHE["data"] = data
    log.info("Krea2 风格库已加载：%d 种 / %d 类（%s）", len(styles), len(categories), sdir)
    return data


def apply_styles(prompt, style_ids, negative=""):
    """把选中的风格套到用户提示词上。

    语义与 Easy-Use 的 `easy stylesSelector` 节点逐条对齐（保证同一风格两边结果一致）：
      · 第一条**带 `{prompt}`** 的风格 → `{prompt}` 替换成用户提示词（has_prompt=True）
      · 之后带 `{prompt}` 的风格       → 追加时**去掉** `, {prompt}` / `{prompt}` 再拼
      · 不带 `{prompt}` 的风格         → 直接 `, ` 拼接
      · 全部风格都不带 `{prompt}` 且用户有词 → 用户词 + ", " + 风格串
    返回 (positive, negative, used_names)
    """
    data = load_styles()
    by_id = {s["id"]: s for s in data.get("styles") or []}
    by_name = {}
    for s in data.get("styles") or []:
        by_name.setdefault(s["name"], s)
    base = str(prompt or "").strip()
    neg = str(negative or "").strip()
    pos_out = ""
    has_prompt = False
    used = []
    for sid in (style_ids or []):
        sid = str(sid or "").strip()
        if not sid:
            continue
        st = by_id.get(sid) or by_name.get(sid)
        if not st:
            continue
        used.append(st["label"])
        p = st.get("prompt") or ""
        if "{prompt}" in p:
            if not has_prompt:
                pos_out = p.replace("{prompt}", base)
                has_prompt = True
            else:
                pos_out += ", " + p.replace(", {prompt}", "").replace("{prompt}", "").strip().strip(",")
        else:
            pos_out = p if pos_out == "" else pos_out + ", " + p
        n = st.get("negative_prompt") or ""
        if n:
            neg = (neg + ", " + n) if neg else n
    if not has_prompt and base:
        pos_out = (base + ", " + pos_out) if pos_out else base
    return pos_out.strip(), neg.strip(), used


def thumb_path(dir_rel):
    """把 `分类/文件名.jpg` 解析成 styles 目录内的安全绝对路径（供 /mrnext/assetgen/style_thumb）。"""
    sdir = styles_dir()
    if not sdir:
        return ""
    rel = str(dir_rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel:
        return ""
    full = os.path.normpath(os.path.join(sdir, rel))
    root = os.path.normpath(sdir)
    if not (full == root or full.startswith(root + os.sep)):
        return ""
    if not os.path.isfile(full):
        return ""
    if os.path.splitext(full)[1].lower() not in _IMG_EXTS:
        return ""
    return full


def thumb_rel(abs_path):
    """绝对路径 → `相对 styles 目录` 的 URL 片段（绝对路径不在 styles 内时返回 ""）。"""
    sdir = styles_dir()
    if not sdir or not abs_path:
        return ""
    try:
        return os.path.relpath(abs_path, sdir).replace(os.sep, "/")
    except Exception:  # noqa: BLE001
        return ""
