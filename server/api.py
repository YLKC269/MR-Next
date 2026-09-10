"""MRBoard_Next 路由处理器（核心闭环）。

职责分明的处理函数，全部挂在 /mrnext/* 下：
  studio : 资产浏览 / 上传 / 导入 / 剧本拆分 / 定义抽取 / 计划落盘
  assetgen: 模型列举 / 生成
  editor  : 成片列举 / 拼接
每个函数短小、单一职责，无 7800 行巨石。
"""

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

import folder_paths
from aiohttp import web

from . import favorites as favmod
from . import h3prompt as h3pmod
from . import h3shot as h3mod
from . import longdoc as longdocmod
from . import native as nativepick
from . import sanitize as sanitizemod
from . import skills as skillmod
from .generation import (
    generate_placeholder,
    krea2_defaults,
    krea2_model_list,
    list_loras,
    run_krea2_generate,
    run_krea2_t2i,
    run_enhance_image,
    seedvr2_models,
)

# ---------- 小工具 ----------

_KIND_EXTS = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"},
    "audio": {".wav", ".mp3", ".flac", ".ogg", ".m4a"},
    "video": {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"},
}

_TAG_RE = re.compile(r"<(Picture|Video|Audio|Subject)\s+(\d+)\s*>")


# ---- 虚拟引用 token 净化（与前端 core/purify.js 同名同语义）----
# ComfyUI 前端在文本域粘贴图片时会写入 `@image#N:文件名.png` 引用标记（不是磁盘真实文件）。
# 残留危害：① 混进 prompt → 出片被污染（用户实报"文生视频还是被污染"）；
#           ② 被当素材名 → 素材列表出现"数字素材"、被绑定后继续污染出片。
# 后端守最后一道：任何进构图 / 进素材列表的 rel 与文本都必须过这一层。
_VIRTUAL_REF_RE = re.compile(
    r"""@\s*image\s*#\s*\d+\s*[:：]\s*[^@\s，,。;；、"'）)\]】]*?\.(?:png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v|wav|mp3|m4a|flac|ogg)""",
    re.IGNORECASE,
)
# 残缺形态：无扩展名 / 被截断时也吃掉冒号后紧跟的 ASCII 文件名段（中文不吃，避免误删正文）
_VIRTUAL_REF_ANY_RE = re.compile(
    r"""@\s*(?:image|video|audio|mask|lora)\s*#\s*\d+\s*[:：]?\s*[A-Za-z0-9_.\-]*""", re.IGNORECASE)


def _strip_virtual_refs(text):
    s = str(text if text is not None else "")
    if not s:
        return ""
    s = _VIRTUAL_REF_RE.sub("", s)
    s = _VIRTUAL_REF_ANY_RE.sub("", s)
    # 剥离后可能留下「空格 + 标点」的空洞（如 "镜头 ，然后推近"），收一下
    s = re.sub(r"[ \t]+([，。；、！？,.;!?])", r"\1", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _is_virtual_ref(s):
    t = str(s or "")
    if not t:
        return False
    return bool(_VIRTUAL_REF_RE.search(t)) or bool(_VIRTUAL_REF_ANY_RE.search(t))


def _usable_rel(rel):
    """rel 是否可作为真实素材参与构图（非空 / 非虚拟引用 / 非 @ 开头）。"""
    r = str(rel or "").strip()
    if not r:
        return False
    if _is_virtual_ref(r) or r.startswith("@"):
        return False
    return True


def _input_base():
    return folder_paths.get_input_directory()


def _safe_join(base, rel):
    """把相对路径安全拼到 base 内，禁止越界。"""
    rel = (rel or "").strip().strip("/\\").replace("\\", "/")
    target = os.path.normpath(os.path.join(base, rel))
    if target != base and not target.startswith(base + os.sep):
        raise ValueError("路径越界")
    return target


def _kind_of(name):
    ext = os.path.splitext(name)[1].lower()
    for kind, exts in _KIND_EXTS.items():
        if ext in exts:
            return kind
    return "file"


def _list_files(folder, kind="all"):
    """列举资产文件夹里的媒体文件，按 kind 自动分类，同 kind 内按文件名字母序排序。
    每条记录携带 1-based `index`（同 kind 内，从 1 开始分配）——
    文本框里 `<Picture N>` / `<Audio N>` / `<Video N>` 用此 index 命中素材。
    排序：先看文件名末尾是否带数字（精确 N），再按字母序分配 N。
    这样：
      A. 老剧本里 `<Picture 3>` 引用 `image3.png`（末尾 3）—— 仍然精确命中。
      B. 没数字结尾的素材（如 `云妙衣.png`）按字母序拿到 N=1,2,3...，素材库导入顺序变化不会乱。
    """
    base = _input_base()
    root = _safe_join(base, folder) if folder else base
    out = []
    if not os.path.isdir(root):
        return out
    # 第一遍：按 kind 分组收集文件名（含末尾数字的优先抽 N）
    pools = {"image": [], "audio": [], "video": []}
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        if not os.path.isfile(full):
            continue
        k = _kind_of(name)
        if k not in pools:
            continue
        if kind != "all" and k != kind:
            continue
        pools[k].append(name)

    # 第二遍：每个 kind 内统一编号。无重复前提下优先保留文件名末尾数字，否则按字母序递增分配。
    for k, names in pools.items():
        # 先尝试用末尾数字 N
        used_n = set()  # 已分配的 N（防止 image1/image2/name3.png 撞号）
        explicit = {}  # name -> N（来自末尾数字）
        fallback = []  # 没法配 N 的，按字母序补位
        for nm in names:
            stem = os.path.splitext(nm)[0]
            m = re.search(r"(\d+)\s*$", stem)
            if m:
                n = int(m.group(1))
                if n >= 1 and n not in used_n:
                    explicit[nm] = n
                    used_n.add(n)
                    continue
            fallback.append(nm)
        # 给 fallback 按字母序分配未占用的 N（保持确定性，从 1 起）
        fb_cursor = 1
        for nm in fallback:
            while fb_cursor in used_n:
                fb_cursor += 1
            explicit[nm] = fb_cursor
            used_n.add(fb_cursor)

        # 输出：按 N 升序拍平
        ordered = sorted(explicit.items(), key=lambda x: (x[1], x[0]))
        for name, n in ordered:
            full = os.path.join(root, name)
            out.append({
                "name": name,
                "kind": k,
                "size": os.path.getsize(full),
                "mtime": int(os.path.getmtime(full)),
                "index": n,                 # 1-based, 同 kind 内唯一
            })
    return out


def _json(data, status=200):
    return web.json_response(data, status=status)


# ---------- studio ----------

async def studio_files(req):
    folder = (req.query.get("folder") or "").strip()
    kind = (req.query.get("kind") or "all").strip()
    return _json({"folder": folder, "kind": kind, "files": _list_files(folder, kind)})


async def studio_browse(req):
    """目录导航：列出 path 下子目录与普通文件。"""
    path = (req.query.get("path") or "").strip()
    base = _input_base()
    root = path if path else base
    root = os.path.normpath(root)
    dirs, files = [], []
    try:
        for name in sorted(os.listdir(root)):
            full = os.path.join(root, name)
            if os.path.isdir(full):
                dirs.append(name)
            else:
                files.append({"name": name, "kind": _kind_of(name),
                              "size": os.path.getsize(full)})
    except Exception as exc:  # noqa: BLE001
        return _json({"path": root, "dirs": [], "files": [], "error": str(exc)})
    return _json({"path": root, "dirs": dirs, "files": files})


async def studio_upload(req):
    """上传文件到资产文件夹。"""
    reader = await req.multipart()
    folder = ""
    dest_name = None
    tmp = None
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "folder":
            folder = (await part.text()).strip()
        elif part.name == "file":
            dest_name = part.filename
            base = _input_base()
            root = _safe_join(base, folder) if folder else base
            os.makedirs(root, exist_ok=True)
            tmp = os.path.join(root, os.path.basename(dest_name))
            with open(tmp, "wb") as fh:
                while True:
                    chunk = await part.read_chunk(1024 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
    if not tmp:
        return _json({"ok": False, "error": "无文件"}, status=400)
    return _json({"ok": True, "name": os.path.basename(tmp),
                  "kind": _kind_of(tmp), "folder": folder})


async def studio_import(req):
    """服务端把本地选中文件复制到资产文件夹（ComfyUI 本地运行可用）。"""
    body = await req.json()
    paths = body.get("paths") or []
    folder = (body.get("folder") or "").strip()
    base = _input_base()
    root = _safe_join(base, folder) if folder else base
    os.makedirs(root, exist_ok=True)
    copied = []
    for p in paths:
        if not os.path.isfile(p):
            continue
        dst = os.path.join(root, os.path.basename(p))
        shutil.copyfile(p, dst)
        copied.append(os.path.basename(dst))
    return _json({"ok": True, "copied": copied, "folder": folder})


def _safe_asset_name(name, fallback="asset"):
    """把剧本里的名字洗成合法文件名（保留中文/字母/数字，去 Windows 非法字符）。

    设定图生成后落盘是机器名（如 1788948454574_mrnext_ab12_00001_.png），
    在素材库里显示成一长串"数字素材"——改名成角色名/场景名后一眼可认。
    """
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', "", str(name or "").strip())
    s = re.sub(r"\s+", " ", s).strip(" .")  # Windows 文件名不能以点/空格结尾
    s = s[:60]
    return s or fallback


async def studio_rename(req):
    """POST /mrnext/studio/rename —— 把素材重命名为「剧本名字」，返回新 rel。

    body: {rel: "mrboard_next/1788948454574_xxx.png", name: "林晚"}
    - 保留原扩展名，只改主名；
    - 目标名清洗成合法文件名（去 Windows 非法字符）；
    - 已存在同名文件则自动加 _2 / _3，绝不覆盖既有素材；
    - 源/目标都强制限制在 input 目录内（防目录穿越）。
    """
    body = await req.json()
    rel = str(body.get("rel") or "").strip().replace("\\", "/")
    name = str(body.get("name") or "").strip()
    if not rel:
        return _json({"error": "缺少 rel"}, status=400)
    base = _input_base()
    try:
        src = _safe_join(base, rel)
    except (ValueError, OSError) as exc:
        return _json({"error": f"路径不合法: {exc}"}, status=400)
    if not os.path.isfile(src):
        return _json({"error": "文件不存在: " + rel}, status=404)
    if not name:
        return _json({"error": "缺少目标名字 name"}, status=400)
    ext = os.path.splitext(src)[1].lower() or ".png"
    folder = os.path.dirname(rel)
    stem = _safe_asset_name(name)
    # 幂等短路：文件已经是目标名字（重跑流水线/重复点生成）→ 直接返回原名，
    # 否则会被判成"重名"再加 _2/_3 后缀，把好好的「林晚.png」改成「林晚_3.png」。
    cur_stem = os.path.splitext(os.path.basename(src))[0]
    if cur_stem == stem:
        return _json({"ok": True, "rel": rel, "filename": os.path.basename(src),
                      "name": cur_stem, "renamed": False})

    def _uniq(stem0):
        cand, i = stem0, 1
        while True:
            dst_rel = (folder + "/" + cand + ext) if folder else (cand + ext)
            try:
                exists = os.path.isfile(_safe_join(base, dst_rel))
            except (ValueError, OSError):
                exists = True
            if not exists:
                return cand, dst_rel
            i += 1
            cand = f"{stem0}_{i}"

    cand, dst_rel = _uniq(stem)
    try:
        dst = _safe_join(base, dst_rel)
        if os.path.abspath(src) == os.path.abspath(dst):
            return _json({"ok": True, "rel": rel, "filename": os.path.basename(src),
                          "name": cand, "renamed": False})
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.rename(src, dst)
    except Exception as exc:  # noqa: BLE001
        return _json({"error": f"改名失败: {exc}"}, status=500)
    return _json({"ok": True, "rel": dst_rel, "filename": os.path.basename(dst),
                  "name": cand, "renamed": True, "from": rel})


async def studio_split(req):
    """把剧本按分镜切分，返回完整结构（对齐旧包 _studio_split 的契约）。

    body: {script, prefix?, mode?, strip?, durationSec?, folder?, durations?{i:sec}}
    返回:
      shots:            每镜 {index, text, prompt, sec, refs}（sec=行内"5s/5秒"自动提取）
      bodies:           每镜正文（剥净时长+序号的纯描述，导演台 prompt 用）
      keptPrefixes:     每镜对应裁剪后的公共前缀（trimPrefix 时填，否则空串）
      perShot:          每镜的素材引用（按 <Picture/Audio/Video N> 扫文件夹匹配，
                        含 refs/audios/videos 三个数组，每项 {kind,index,rel,fileName,type,subfolder}）
      missingImages/Audios/Videos:  本次扫描中标记了但文件夹里没找到的素材清单
      durationSec:      全局默认秒（durationSec 输入回显）
      durationPerShot:  每镜时长数组（已 strip 的标记时长 + 输入 durations 覆盖 + 全局 fallback）
      frameCount:       durationSec * 24 对齐帧数（旧包契约：fc % 17 == 5）
    """
    body = await req.json()
    # 源头净化：剧本/公共前缀里若混入虚拟引用 token（@image#N:xxx.png），
    # 必须在这里就剥掉 —— 否则它会随 shots[i].text 一路流到导演台/出片（用户实报的"污染"）。
    script = _strip_virtual_refs(body.get("script"))
    prefix = _strip_virtual_refs((body.get("prefix") or "")).strip()
    strip = bool(body.get("strip", True))
    folder = (body.get("folder") or "").strip()

    try:
        default_sec = float(body.get("durationSec") or 5.0)
    except (TypeError, ValueError):
        default_sec = 5.0
    default_sec = max(0.5, min(120.0, default_sec))

    durations = body.get("durations") or {}
    if not isinstance(durations, dict):
        durations = {}

    # 切分 + header merge
    bodies, kept_prefixes, header, marker_durs = _split_script(script, prefix=prefix if prefix is not None else "", strip=strip)
    if not bodies:
        return _json({"error": "剧本为空或未切出分镜"}, status=400)

    # 若 prefix 未传但 header 被并入：保留 header 给前端（一次返回，UI 自己决定要不要再写回 prefix）
    # 若 prefix 已传：把 header 拼到 prefix（自动抽公共前缀逻辑）
    merged_prefix = ((header + "\n" + prefix).strip() if header else prefix) if prefix is not None else prefix

    # 每镜时长：优先输入 durations[i] > 标记行时长（S05 / 5s）> body 残留时长 > 全局默认
    duration_per_shot = []
    for i in range(len(bodies)):
        sec_in = None
        try:
            v = durations.get(str(i), durations.get(i))
            if v is not None and float(v) > 0:
                sec_in = float(v)
        except (TypeError, ValueError):
            sec_in = None
        if sec_in is None and i < len(marker_durs) and marker_durs[i] is not None:
            sec_in = marker_durs[i]  # H3 标记行时长（S05 / 5s）
        if sec_in is None:
            sec_in = _extract_dur(bodies[i])  # body 内残留的 5s/5秒
        if sec_in is None:
            sec_in = default_sec
        sec_in = max(0.5, min(120.0, round(sec_in * 2) / 2))
        duration_per_shot.append(sec_in)

    # 每镜素材引用：按 bodies 里 <Tag N> 手动绑定 + 角色名自动匹配
    tag_bindings_in = body.get("tagBindings") or {}
    role_images_in = body.get("roleImages") or {}
    per_shot, missing = _scan_per_shot_refs(
        bodies, folder,
        tagBindings=tag_bindings_in,
        roleImages=role_images_in,
        prefix=prefix or "",
    )

    # 拼装 shots（前端 shots.js / shots 卡片用）：保留 sec（行内自动时长），
    # 前端按钮会再覆盖写入 store.shots[i].sec
    shots = []
    for i, b in enumerate(bodies):
        # shots.refs 给前端 shots 面板的标记回显用：列出 body 里出现的全部 <Tag N>（含未绑定的）
        refs_in_body = _scan_refs_in_text(b)
        shots.append({
            "index": i + 1,
            "text": b,
            "prompt": b,
            "sec": duration_per_shot[i],  # 前端用此自动填 store.shots[i].sec
            "refs": refs_in_body,
            "missingCount": per_shot[i].get("_missing", 0) if i < len(per_shot) else 0,
        })

    # frameCount：按 fps=24 + 「fc % 17 == 5」对齐（旧包契约）
    fc = max(5, int(round(default_sec * 24.0)))
    while fc % 17 != 5:
        fc += 1

    # 缺素材命名规整
    flat_missing = {
        "image": [m["ref"] for m in missing["image"]],
        "audio": [m["ref"] for m in missing["audio"]],
        "video": [m["ref"] for m in missing["video"]],
    }
    # per_shot 清掉内部 _missing 字段，只返对前端有用的 refs/audios/videos
    # per_shot 平面化：与 /studio/analyze 的 perShot 格式严格一致（前端 shots/timeline
    # 面板按 refMap[i] = [{name,rel,kind,category},...] 平面数组消费，
    # 此前返回 {refs,audios,videos} 对象 → 前端 matched.map 抛 TypeError → 分镜格子全空白）
    def _flat(ps):
        out = []
        for it in ps.get("refs", []):
            out.append({"name": it.get("fileName", ""), "rel": it.get("rel", ""),
                        "kind": "image", "category": "asset", "index": it.get("index", 0)})
        for it in ps.get("audios", []):
            out.append({"name": it.get("fileName", ""), "rel": it.get("rel", ""),
                        "kind": "audio", "category": "audio", "index": it.get("index", 0)})
        for it in ps.get("videos", []):
            out.append({"name": it.get("fileName", ""), "rel": it.get("rel", ""),
                        "kind": "video", "category": "asset", "index": it.get("index", 0)})
        return out

    clean_per_shot = [_flat(ps) for ps in per_shot]

    return _json({
        "shots": shots,
        "bodies": bodies,
        "keptPrefixes": kept_prefixes,
        "header": header,                   # 自动识别的「定义头」，前端可决定是否写入 prefix
        "mergedPrefix": merged_prefix,      # 把 header 拼进 prefix 的建议结果（不直接落盘）
        "perShot": clean_per_shot,
        "missingImages": flat_missing["image"],
        "missingAudios": flat_missing["audio"],
        "missingVideos": flat_missing["video"],
        "durationSec": round(default_sec, 2),
        "durationPerShot": [round(v, 2) for v in duration_per_shot],
        "frameCount": fc,
        "ruleInfo": {"sources": ["mrnext"], "autoCount": sum(len(ps["refs"]) + len(ps["audios"]) + len(ps["videos"]) for ps in per_shot)},
    })


async def studio_extract_defs(req):
    """从剧本自动抽取公共前缀定义（对齐旧包 _studio_split header merge 行为）。

    body: {script, prefix?}
    返回 {header, suggestedPrefix, found:[行首标签]}。
    不会落盘 prefix —— 由前端决定是否写回 store.prefix。
    """
    body = await req.json()
    script = (body.get("script") or "").strip()
    prefix = (body.get("prefix") or "").strip()
    if not script:
        return _json({"error": "剧本为空"}, status=400)
    # _split_script(prefix="" if prefix else None, strip=True)：让 header merge 一定发生
    bodies, kept, header, _md = _split_script(script, prefix="" if not prefix else None, strip=True)
    if not header:
        return _json({"header": "", "suggestedPrefix": prefix, "found": [],
                       "message": "未识别到「定义头」（剧本首段需要不含任何分镜标记）"})
    # 解析 header 里的 <Subject N>/<Picture N>/<Style 全局>
    found = []
    for ln in header.splitlines():
        if re.search(r"<\s*Subject", ln, re.IGNORECASE): found.append("Subject")
        if re.search(r"<\s*Picture", ln, re.IGNORECASE): found.append("Picture")
        if re.search(r"<\s*Style", ln, re.IGNORECASE):   found.append("Style")
        if re.search(r"<\s*Audio", ln, re.IGNORECASE):   found.append("Audio")
        if re.search(r"<\s*Video", ln, re.IGNORECASE):   found.append("Video")
    if prefix:
        suggested = (header + "\n" + prefix).strip()
    else:
        suggested = header
    return _json({"header": header, "suggestedPrefix": suggested,
                   "found": list(dict.fromkeys(found)), "bodies": bodies})


async def studio_asset_plan(req):
    """从剧本/前缀抽取角色与场景定义（通用提取器，支持 <Picture N>/<Subject N>/<Style 全局>/旧包格式）。
    返回 roles / scenes / style（全局风格，供生图提示词追加）。

    关键：只扫描「定义段」——即把剧本做一次 split 拿 header（首段不含分镜标记的那块），
    喂给 _parse_assets_text = prefix + header。避免每个分镜正文里 "<Picture N> 名字：..."
    形式的角色引述被错当成「新增角色」。"""
    body = await req.json()
    script = body.get("script") or ""
    prefix = body.get("prefix") or ""
    # 先 split 拿 header（剧本首段不含分镜标记的那段）。prefix is None 时强制做 header merge。
    header = ""
    if script.strip():
        _bs, _kp, header, _md = _split_script(script, prefix="" if not prefix else None, strip=True)
    src = (prefix + "\n" + header).strip() if (prefix or header) else ""
    # 先尝试通用提取器（覆盖 0715 参考图 / Subject 锁定 / Style 全局）
    if src:
        roles, scenes, style = _parse_assets_text(src)
    else:
        roles, scenes, style = [], [], ""
    if not roles and not scenes:
        # 回退旧解析（剧本正文里「角色：… / 场景：…」）
        roles, scenes = _extract_defs(script + "\n" + prefix)
    return _json({"roles": roles, "scenes": scenes, "style": style})


async def studio_save_plan(req):
    """把分镜计划落盘到资产文件夹（节点 execute 时回读）。"""
    body = await req.json()
    folder = (body.get("folder") or "").strip()
    shots = body.get("shots") or []
    base = _input_base()
    root = _safe_join(base, folder) if folder else base
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, "_plan.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"shots": shots}, fh, ensure_ascii=False, indent=2)
    return _json({"ok": True, "path": path})


_SEG_RE = re.compile(
    r"^\s*(?:"
    r"S\d+(?:\s*/\s*N\d+)?\s*[:：]?|"            # 0715 S05 或 S05/N3
    r"【\s*分镜\s*\d+\s*】|"
    r"【\s*镜头\s*\d+\s*】|"                     # 【镜头N】— 「剧本/制片」模板风格（古风宫廷喜剧等）
    r"分镜\s*\d+\s*[:：]?|"                       # 分镜N
    r"第\s*\d+\s*镜\s*[:：]?|"                     # 第N镜
    r"镜\s*头\s*\d+\s*[:：]?|"                    # 镜头N（旧包"镜头N"）
    r"Shot\s*\d+\s*[:：]?|"                        # Shot N
    r"【\s*\d+\s*】|"
    r"[\[【]\s*\d+\s*[\]】]|"
    r"\d+\s*[.、)]"
    r")\s*",
    re.MULTILINE | re.IGNORECASE,
)

# ---- MiniMax H3 官方 skills 模板 / Markdown 标准镜头信息表 支持（移植旧包 script_split.py）----
# H3 官方模板的分镜边界：
#   【分镜N】/ 分镜N：/ 第N镜 / 镜头N / Shot N / S05（含「S05 / 5s」时长标注行）
#   Markdown 标准镜头信息表的表格行：| **S02 / 6s** | ...（竖线 + 粗体包裹）
_H3_SPLIT_RE = re.compile(
    r"(?=^\s*(?:\|?\s*\*{0,2})?[【\[]?\s*(?:分镜|镜头|[Ss](?:hot)?)\s*\d+\s*[】\]]?"
    r"|^\s*第\s*\d+\s*镜\b)", re.M)
_H3_STRIP_RE = re.compile(
    r"^\s*(?:\|?\s*\*{0,2})?[【\[]?\s*(?:分镜|镜头|[Ss](?:hot)?)\s*\d+\s*[】\]]?"
    r"(?:\s*\*{0,2})?"
    r"(?:\s*[/／]\s*\d+(?:\.\d+)?\s*[sS秒]\s*\*{0,2})?"
    r"(?:\s*\|)?\s*[:：、.．]?\s*"
    r"|^\s*第\s*\d+\s*镜\s*[:：]?\s*")
_H3_LINE_RE = re.compile(
    r"^\s*(?:\|?\s*\*{0,2})?[【\[]?\s*(?:分镜|镜头|[Ss](?:shot)?)\s*\d+\s*[】\]]?"
    r"|^\s*第\s*\d+\s*镜\b")
_H3_DUR_RE = re.compile(
    r"^\s*(?:\|?\s*\*{0,2})?[【\[]?\s*(?:分镜|镜头|[Ss](?:shot)?)\s*\d+\s*[】\]]?"
    r"\s*\*{0,2}\s*[/／]\s*(\d+(?:\.\d+)?)\s*[sS秒]", re.M)
_H3_TABLE_DIVIDER_RE = re.compile(r"^[\s|:\-*]+$")
_H3_TABLE_TITLE_RE = re.compile(
    r"^[^\n]*(?:标准镜头信息表|Standard\s+Shot\s+Table)[^\n]*$", re.M | re.I)


def _h3_cut_after_table_title(text):
    """剧本含「标准镜头信息表」标题时：标题前内容（角色/场景定义）保留为 header 候选，
    标题后内容（表格行）参与切分。返回 (after_title, before_title)。"""
    m = _H3_TABLE_TITLE_RE.search(text or "")
    if m:
        return text[m.end():], text[:m.start()].strip()
    return text, ""


def _h3_strip_table_noise(seg):
    """Markdown 标准镜头信息表：只保留镜头行本身，其余（表头/分隔行/无标记表格行）剔除。"""
    lines = (seg or "").splitlines()
    if not any(ln.lstrip().startswith("|") for ln in lines):
        return seg
    out, seen_shot = [], False
    for ln in lines:
        s = ln.strip()
        if _H3_LINE_RE.search(s):
            seen_shot = True
            out.append(ln)
            continue
        if s.startswith("|"):
            continue  # 表头 / 分隔行 / 无标记表格行 → 丢弃
        if seen_shot and s:
            break  # 镜行后的普通文本行（表格外尾文）→ 截断丢弃
        if not seen_shot or not s:
            out.append(ln)
    return "\n".join(out)


def _h3_parse_marker_durations(bodies):
    """解析每镜标记行里的时长标注（「S05 / 5s」→ 5.0 秒），返回与 bodies 等长列表。"""
    out = []
    for b in bodies or ():
        m = _H3_DUR_RE.search((b or "")[:200])
        try:
            out.append(float(m.group(1)) if m else None)
        except ValueError:
            out.append(None)
    return out

# 行内分镜标记（非行首，用于单行退化剧本）。
# ⚠️ 必须排除 <Picture N> / <Subject N> 等素材标记内的数字 ——
# 用占位符先把 <...> 块抹掉，切完再还原。
# ⚠️ 关键：把 "【分镜N】" 和 "分镜N" 拆成两个分支，避免 ] 可选导致 5 被 S\d+ 误吞。
#    用 non-consuming lookahead 验证后面是时长（秒/s），确保标记确实跟着时长才切。
_SEG_INLINE_RE = re.compile(
    r"(?<!\w)"                         # 非单词前（确保不切 "小白兔1" 的 1）
    r"(?:"
    r"S\d+(?:\s*/\s*N\d+)?"            # 0715 S05/N3
    r"|【\s*分镜\s*\d+\s*】"            # 完整【分镜N】（括号必须成对）
    r"|【\s*镜头\s*\d+\s*】"           # 完整【镜头N】
    r"|分镜\s*\d+"                     # 无括号 分镜N
    r"|第\s*\d+\s*镜"                  # 第N镜
    r"|镜\s*头\s*\d+"                  # 镜头N
    r"|Shot\s*\d+"                     # Shot N
    r"|【\s*\d+\s*】"                 # 完整【N】
    r"|\[\s*\d+\s*\]"                # [N]
    r")"
    r"(?=\s*(?:[0-9](?:\.\d+)?\s*(?:s(?:ec(?:onds?)?)?|秒)|\d+\s*秒))"
    ,
    re.IGNORECASE,
)
# 素材标记占位（切分时先把 <...> 抹掉避免误切）
_TAG_PLACEHOLDER_RE = re.compile(r"<[^>]+>")


def _inline_split(raw):
    """行内切分（单行退化模式）：先抹 <...>，切分后还原。"""
    tags = []
    tagged = _TAG_PLACEHOLDER_RE.sub(lambda m: (tags.append(m.group()) or f"__TAG_{len(tags) - 1}__"), raw)
    blocks = [b.strip() for b in _SEG_INLINE_RE.split(tagged) if b.strip()]
    if tags:
        out = []
        for b in blocks:
            for i, t in enumerate(tags):
                b = b.replace(f"__TAG_{i}__", t)
            out.append(b)
        return out
    return blocks

# 时长：行内 5s / 5秒 / (5秒) / (5s)（首条匹配即剥净，避免脏 prompt；中英文 s/秒 都支持；\b 防止 5s5 误匹配）
_DUR_RE = re.compile(r"(?:\(\s*)?(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds?)?)?|秒)\)?", re.IGNORECASE)
# 截取每镜末尾最近一次出现的时长（自动识别时长按钮用）
_DUR_GLOBAL_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds?)?)?|秒)", re.IGNORECASE)


def _split_script(script, prefix=None, strip=True):
    """把剧本切成分镜，并剥净序号标记。

    支持的分镜行首标记（对齐旧包 + 0715 长文档 + MiniMax H3 官方 skills 模板）：
      旧包官方：【分镜N】 / 分镜N：/ 第N镜 / 镜头N / Shot N / S05（含「S05 / 5s」时长标注行）
      H3 官方模板：Markdown 标准镜头信息表 `| **S02 / 6s** | ...`（竖线+粗体包裹）
      0715 紧凑：S05 / S05/N3
      新包基础：【N】 / [N] / N. / N、 / N)
    时长：标记行「S05 / 5s」→ marker_durs[i]（返回），行内 (5s)/5s/5秒 → _extract_dur。

    prefix：可选传入现有公共前缀。若 prefix 为空且切分后第一段不含分镜标记，
    则自动把它当作「定义头」并入前缀（header merge）。
    返回 (bodies, kept_prefixes, header, marker_durs) 四元组（marker_durs 为每镜标记行时长）。
    """
    raw = (script or "").strip()
    if not raw:
        return [], [], "", []

    # H3 官方模板：含「标准镜头信息表」标题时，标题前内容保留为 header 候选（角色/场景定义）
    raw, _before_title = _h3_cut_after_table_title(raw)

    # 切分：H3 官方格式（含 Markdown 表格行，lookahead 保留标记行）优先；回退 _SEG_RE
    blocks = [b.strip() for b in _H3_SPLIT_RE.split(raw) if b.strip()]
    if len(blocks) <= 1:
        blocks = [b.strip() for b in _SEG_RE.split(raw) if b.strip()]
    # 表格噪声清理（表头 / 分隔行 / 无标记表格行剔除）
    blocks = [_h3_strip_table_noise(b) for b in blocks]
    blocks = [b for b in blocks if b.strip()]

    # 若没切出多个块且剧本含行内分镜标记 → 行内退化模式
    if len(blocks) <= 1 and _SEG_INLINE_RE.search(raw):
        inline_blocks = [b.strip() for b in _SEG_INLINE_RE.split(raw) if b.strip()]
        if inline_blocks:
            blocks = inline_blocks

    if (not _SEG_RE.search(raw) and not _SEG_INLINE_RE.search(raw)
            and not _H3_LINE_RE.search(raw) and len(blocks) <= 1):
        # 啥都没找到，按双换行或段落切分兜底
        blocks = [b.strip() for b in re.split(r"\n\s*\n", raw) if b.strip()]
        if len(blocks) <= 1:
            blocks = [raw]

    # 标记行时长（strip 前解析，与 blocks 对齐）
    marker_durs = _h3_parse_marker_durations(blocks)

    # 自动识别「定义头」：优先标题前的角色/场景定义；否则第一段不含分镜标记 → 并入前缀
    header = ""
    if prefix is not None:
        if _before_title:
            header = _before_title  # H3 表格标题前的角色/场景定义
        elif (blocks
                and not _H3_LINE_RE.search(blocks[0])
                and not _SEG_RE.match(blocks[0])
                and not _SEG_INLINE_RE.search(blocks[0])):
            header = blocks.pop(0)
            if marker_durs:
                marker_durs.pop(0)

    bodies, kept_prefixes = [], []
    for b in blocks:
        body_text = b
        if strip:
            # 剥标记（含 H3 表格行 + 时长标注行）；SEG 切分时标记已被消费，此处 sub 无害
            body_text = _H3_STRIP_RE.sub("", b, count=1)
            body_text = re.sub(r"\|\s*$", "", body_text.strip())
        bodies.append(body_text.strip())
        kept_prefixes.append("")  # 占位（trim 模式下填实际裁剪后的前缀）
    return bodies, kept_prefixes, header, marker_durs


def _extract_dur(text):
    """从一段文字里抽时长（取最后一次出现的 N秒/5s/5秒，返回 float 或 None）。
    用作前端「⏱ 自动匹配时长」按钮的 fallback：后端也能算出。"""
    if not text:
        return None
    last = None
    for m in _DUR_GLOBAL_RE.finditer(text):
        try:
            v = float(m.group(1))
            if v > 0:
                last = v
        except (TypeError, ValueError):
            pass
    return last


def _scan_refs_in_text(text):
    """扫描每段文字里的 <Picture N> / <Audio N> / <Video N> 标记，返回 [(kind, index)]。
    同一标记多次出现只算一次；N 必须 ≥1。"""
    out = []
    seen = set()
    for tm in _TAG_RE.finditer(text or ""):
        kind = tm.group(1).lower()
        idx = int(tm.group(2))
        if idx < 1:
            continue
        key = (kind, idx)
        if key in seen:
            continue
        seen.add(key)
        out.append({"kind": kind, "index": idx})
    return out


def _assets_dir_for(folder):
    """把资产文件夹路径解析为 (sub, base, in_input) 三元组，供后续 _asset_exists 等共用。
    sub = input/ 之下的子目录（含末尾 /），base = 绝对路径，in_input = 是否在 input/ 内。"""
    folder = (folder or "").strip().strip("/\\").replace("\\", "/")
    base = _input_base()
    if not folder or folder == ".":
        return "", base, True
    sub = folder if folder.endswith("/") else folder + "/"
    return sub, os.path.join(base, folder), True


def _asset_exists(rel):
    """判定 rel 指向的文件是否真实存在（用于 perShot 缺图统计）。"""
    if not rel:
        return False
    try:
        return folder_paths.exists_annotated_filepath(rel)
    except Exception:
        return False


def _scan_per_shot_refs(bodies, folder, tagBindings=None, roleImages=None, prefix=""):
    """按 bodies 顺序扫每段 <Picture/Audio/Video/Subject N> 标记 + 角色名，返回 perShot + missing。

    命中规则（v2：显性标记需手动绑定，角色名全自动）：
      <Picture N> / <Audio N> / <Video N> / <Subject N> 在分镜正文里出现 →
        若 tagBindings["<Tag N>"] 有手动绑定 → 用该 rel 注入；
        否则跳过（不自动注入，避免误命中）。
      角色名（来自 prefix 中"角色 N - 名字"或"<Subject N> 名字"声明）出现 →
        若 roleImages[name] 有图 → 自动注入。
      N = 1-based。
    """
    sub, base, _in_input = _assets_dir_for(folder)

    def _scan_kind(kind):
        out = {}
        if not os.path.isdir(base):
            return out
        for f in _list_files(folder, kind):
            out[f["index"]] = {
                "kind": kind,
                "index": f["index"] - 1,             # 0-based 给前端消费
                "rel": (sub + f["name"]).lstrip("/"),
                "fileName": f["name"],
                "type": "input",
                "subfolder": sub.rstrip("/") if sub else "",
            }
        return out

    images = {k: {**v, "kind": "image"} for k, v in _scan_kind("image").items()}
    audios = {k: {**v, "kind": "audio"} for k, v in _scan_kind("audio").items()}
    videos = {k: {**v, "kind": "video"} for k, v in _scan_kind("video").items()}

    LIMITS = {"image": 9, "audio": 3, "video": 3}
    REF_TO_KIND = {"picture": "image", "video": "video", "audio": "audio", "subject": "image"}
    LIST_KEY = {"picture": "refs", "video": "videos", "audio": "audios", "subject": "refs"}
    POOLS = {"image": images, "audio": audios, "video": videos}

    # 收集"角色名 → 期望 rel"（来自 prefix 解析 + 前端 roleImages 覆盖）
    name_to_rel = {}
    # prefix 中的"角色 N - 名字" → 名字
    for m in re.finditer(r"角色\s*\d+\s*[-—]\s*([^\s：:\n\r]+)", prefix or ""):
        nm = (m.group(1) or "").strip()
        if nm and nm not in name_to_rel:
            name_to_rel[nm] = None  # 后存在存在
    # prefix 中的"<Subject N> 名字：描述" → 名字
    for m in re.finditer(r"<Subject\s+(\d+)>\s*[:：]?\s*([^：:\n\r]+)", prefix or "", re.IGNORECASE):
        nm = (m.group(2) or "").strip().split()[0] if m.group(2) else ""
        if nm and nm not in name_to_rel:
            name_to_rel[nm] = None
    # 前端送来的 roleImages 直接覆盖
    if isinstance(roleImages, dict):
        for nm, rl in roleImages.items():
            # 虚拟引用（@image#1:xxx.png）不是真实文件，拒绝作为角色图注入
            if nm and rl and _usable_rel(rl):
                name_to_rel[nm] = rl

    # 只保留合法 rel：虚拟引用（@image#1:xxx.png）/ 空值一律丢弃，
    # 否则「点过一次脏素材」就会把脏 rel 永久写进绑定，之后每镜都被污染。
    tag_bindings = ({k: v for k, v in (tagBindings or {}).items() if _usable_rel(v)}
                    if isinstance(tagBindings, dict) else {})

    per_shot = []
    missing = {"image": [], "audio": [], "video": []}
    for b in bodies:
        ps = {"refs": [], "audios": [], "videos": [], "_missing": 0}
        used_rels = set()  # 去重
        # ① 显性标记：<Tag N> 必须有手动绑定才注入
        for tm in _TAG_RE.finditer(b or ""):
            tname = tm.group(1).lower()  # picture/audio/video
            n = int(tm.group(2))
            tag_str = f"<{tname.capitalize()} {n}>"
            # Subject 标签：正则没匹配到，手动补一次扫描
            rel = tag_bindings.get(tag_str) or ""
            if not rel:
                # Subject 不在 _TAG_RE 内（只匹配 Picture/Audio/Video），单独处理
                continue
            pool_kind = REF_TO_KIND.get(tname)
            if pool_kind is None:
                continue
            if rel in used_rels:
                continue
            used_rels.add(rel)
            list_key = LIST_KEY[tname]
            if len(ps[list_key]) >= LIMITS[pool_kind]:
                continue
            file_name = rel.split("/")[-1] if rel else ""
            it = {"kind": pool_kind, "index": 0, "rel": rel,
                  "fileName": file_name, "type": "input", "subfolder": sub.rstrip("/") if sub else ""}
            ps[list_key].append(it)
        # ①b Subject 标签（独立扫描，因为 _TAG_RE 不包含 Subject）
        for tm in re.finditer(r"<Subject\s+(\d+)>", b or "", re.IGNORECASE):
            n = int(tm.group(1))
            tag_str = f"<Subject {n}>"
            rel = tag_bindings.get(tag_str) or ""
            if not rel:
                continue
            if rel in used_rels:
                continue
            used_rels.add(rel)
            if len(ps["refs"]) >= LIMITS["image"]:
                continue
            file_name = rel.split("/")[-1] if rel else ""
            ps["refs"].append({"kind": "image", "index": 0, "rel": rel,
                               "fileName": file_name, "type": "input", "subfolder": sub.rstrip("/") if sub else ""})
        # ② 角色名全自动：扫描 prefix 声明的名字在 body 里出现 → 注入对应 rel
        for name, rel in name_to_rel.items():
            if not rel or not name or len(name) < 1:
                continue
            if name in used_rels:
                continue
            # 用前后非字符边界判断（避免"张三"匹配"张三丰"）
            pat = re.compile(r"(?<![一-鿿A-Za-z0-9])" + re.escape(name) + r"(?![一-鿿A-Za-z0-9])")
            if not pat.search(b or ""):
                continue
            used_rels.add(rel)
            if len(ps["refs"]) >= LIMITS["image"]:
                continue
            file_name = rel.split("/")[-1] if rel else ""
            ps["refs"].append({"kind": "image", "index": 0, "rel": rel,
                               "fileName": file_name, "type": "input", "subfolder": sub.rstrip("/") if sub else ""})
        per_shot.append(ps)
    return per_shot, missing


# H3 官方 skills 模板：角色/场景/画风 段落头（## 角色设定 / 【场景设定】 / **画风**： 等）
_DEF_SECTION_HEADERS = {
    "角色设定": "role", "人物设定": "role", "角色": "role", "人物": "role", "主要角色": "role",
    "场景设定": "scene", "场景": "scene", "场景描述": "scene", "主要场景": "scene",
}
_DEF_HEADER_LEAD_RE = re.compile(r"^(?:#{1,6}\s*)?(?:[\[【]\s*)?(?:\*\*\s*)?")
_DEF_HEADER_TAIL_RE = re.compile(r"(?:\s*[\]】])?(?:\s*\*\*)?\s*[:：]?\s*$")


def _extract_defs(text):
    """从剧本/前缀抽取角色与场景定义。

    支持两类格式：
      行内：角色：名字 / 场景：名字（旧包格式）
      H3 官方段落：## 角色设定 / 【场景设定】 段内「名字：描述」行
    返回 [{name, desc}]；desc 为空时 name 即全句。
    """
    roles, scenes = [], []
    cur_section = None
    for line in (text or "").splitlines():
        line = line.strip().lstrip("·-•").strip()
        if not line:
            continue
        # 段落头（H3 官方模板）
        core = _DEF_HEADER_TAIL_RE.sub("", _DEF_HEADER_LEAD_RE.sub("", line)).strip()
        if core in _DEF_SECTION_HEADERS:
            cur_section = _DEF_SECTION_HEADERS[core]
            continue
        m = re.match(r"(?:角色|人物|role)\s*[:：]?\s*(.+)", line, re.IGNORECASE)
        if m and m.group(1).strip():
            roles.append(_parse_def(m.group(1).strip()))
            continue
        m = re.match(r"(?:场景|scene|地点|环境)\s*[:：]?\s*(.+)", line, re.IGNORECASE)
        if m and m.group(1).strip():
            scenes.extend(_split_multi_defs(m.group(1).strip()))
            continue
        # 段落内「名字：描述」行
        if cur_section:
            m = re.match(r"^(.+?)\s*[:：]\s*(.+)$", line)
            if m:
                name, desc = m.group(1).strip(), m.group(2).strip()
                if name:
                    # 清理名字：去掉方括号和数字后缀（如 "【段头 1】" → "段头"）
                    name = re.sub(r'[【\[].+?[】\]]', '', name)  # 去掉【...】
                    name = re.sub(r'\s*\d+\s*$', '', name)  # 去掉末尾数字
                    name = name.strip()
                    d = {"name": name, "desc": desc, "full": (name + "，" + desc) if desc else name}
                    (roles if cur_section == "role" else scenes).append(d)
                    continue
            (roles if cur_section == "role" else scenes).append({"name": line, "desc": "", "full": line})
    return roles, scenes


def _parse_assets_text(text):
    """通用资产提取器：从公共前缀 / skill 优化输出里解析角色、场景、全局风格。

    两遍扫描避免重复（用户脚本常把 <Picture N> 写在 <Subject N> 前，若顺序解析会让老鼠/猫各生成两份）：
      Pass1 先定 <Subject N>（干净角色名 + 特征描述）与 <Style 全局>
      Pass2 再处理 <Picture N>：主体含「幕布/背景板/环境/场景」→ 场景；
            否则仅当未被 Subject 覆盖时才补为角色（避免重复）
      Pass3 都没有时回退旧包格式（角色 N - 名字：描述 / 场景 N - 名字：描述）
    """
    lines = (text or "").split("\n")
    roles, scenes, style_parts = [], [], []

    def _subject_at(idx):
        """解析 lines[idx] 的 <Subject N>（兼容 Markdown `* **<Subject N> 名字**` 前缀），
        返回 (role_dict, next_idx) 或 None。
        同时支持单行格式：`<Subject 1> 小白兔 描述：雪白绒毛`。"""
        line = lines[idx].strip()
        m = re.search(r"<\s*Subject\s*(\d+)\s*>\s*(.*)", line, re.IGNORECASE)
        if not m:
            return None
        raw = m.group(2) or ""
        # 单行格式：名字后紧跟「描述：」或「特征描述」等关键词 → 同行提取描述
        dm = re.search(r"\*{0,2}(?:特征描述|描述|外观)\*{0,2}\s*[:：]\s*(.+)", raw, re.IGNORECASE)
        if dm:
            nm = raw[:dm.start()].strip()
            desc = dm.group(1).replace("`", "").replace("*", "").strip().rstrip("。.")
            return {"name": nm, "desc": desc, "full": (nm + "，" + desc) if desc else nm}, idx + 1
        # 单行格式（无关键词）：名字 + 描述用空格分隔（如 `<Subject 1> 小白兔 雪白绒毛`）
        # 取第一个空格前的部分为名字，剩余为描述（若描述含标点/长度>0）
        space_idx = raw.find(" ")
        if space_idx > 0:
            candidate_name = raw[:space_idx].strip()
            candidate_desc = raw[space_idx + 1:].strip()
            # 名字必须非空且不含描述关键词残留，描述非空才拆分
            if candidate_name and candidate_desc and len(candidate_name) <= 20:
                return {"name": candidate_name, "desc": candidate_desc,
                        "full": (candidate_name + "，" + candidate_desc) if candidate_desc else candidate_name}, idx + 1
        # 多行格式：名字在标签后，描述在后续行
        # 去英文括号 + Markdown 粗体/反引号/列表符残留
        nm = re.sub(r"\s*[（(][^）)]*[）)]", "", raw)
        nm = nm.replace("`", "").replace("*", "").strip(" -－:：")
        desc = ""
        j = idx + 1
        while j < len(lines):
            nxt = lines[j].strip()
            dm2 = re.search(r"\*{0,2}(?:特征描述|描述|外观)\*{0,2}\s*[:：]?\s*(.+)", nxt, re.IGNORECASE)
            if dm2:
                desc = dm2.group(1).replace("`", "").replace("*", "").strip().rstrip("。.")
                j += 1
                break
            if re.search(r"<\s*(?:Subject|Picture|Style)", nxt, re.IGNORECASE):
                break
            j += 1
        return {"name": nm, "desc": desc, "full": (nm + "，" + desc) if desc else nm}, j

    # ---- Pass 1：<Subject N> + <Style 全局> ----
    for idx in range(len(lines)):
        line = lines[idx].strip()
        if re.search(r"<\s*Style", line, re.IGNORECASE) or re.match(r"(?:全局风格|风格)\s*[:：]", line, re.IGNORECASE):
            # 先取「<Style 全局> 值 / 风格：值」同行里的值（此前只扫后续行，丢失同行值）
            sm0 = re.search(r"<\s*Style[^>]*>\s*[:：]?\s*(.+)", line, re.IGNORECASE)
            val0 = ""
            if sm0 and (sm0.group(1) or "").strip():
                val0 = sm0.group(1).replace("`", "").replace("*", "").strip().rstrip("。.")
            elif re.match(r"(?:全局风格|风格)\s*[:：]", line, re.IGNORECASE):
                _v = re.split(r"[:：]", line, 1)[1].strip() if re.search(r"[:：]", line) else ""
                val0 = _v.replace("`", "").replace("*", "").strip().rstrip("。.")
            if val0:
                style_parts.append(val0)
            j = idx + 1
            while j < len(lines):
                nxt = lines[j].strip()
                if re.search(r"<\s*(?:Picture|Subject|Style)", nxt, re.IGNORECASE):
                    break
                if not nxt:
                    j += 1
                    continue
                if nxt.startswith(("|", "#", "---")):
                    break
                sm = re.search(r"\*{0,2}(?:材质|光影|背景|色彩|风格|色调)\*{0,2}\s*[:：]?\s*(.+)", nxt, re.IGNORECASE)
                val = ((sm.group(1) if sm else nxt.lstrip("-*· ")) or "").replace("`", "").replace("*", "").strip().rstrip("。.")
                if val:
                    style_parts.append(val)
                j += 1
            continue
        r = _subject_at(idx)
        if r:
            roles.append(r[0])

    # ---- Pass 2：<Picture N>（兼容 Markdown `` * `<Picture 0>`：描述 `` 反引号包裹）----
    # 兼容「剧本模板」风格的单行格式：
    #   <Picture 1> 是云妙衣（S1）的角色参考图：高盘发垂长发...
    #   <Picture 4> 是公主府库房门口场景参考图：石廊通向巨型铁包橡木大门...
    #   <Picture N> 直接：xxx（无"是"也无参考图前缀）
    # 先用 _parse_picture_template 做一行预处理（拿干净 name + 完整 desc + 判定 role/scene），
    # 再走主流程追加。
    for idx in range(len(lines)):
        m = re.search(r"`?\s*<\s*Picture\s*(\d+)\s*>\s*`?\s*[:：]?\s*(.+)", lines[idx].strip(), re.IGNORECASE)
        if not m:
            continue
        raw_tail = (m.group(2) or "").replace("`", "").replace("*", "").strip().rstrip("。.")
        if not raw_tail:
            continue
        nm, desc, kind = _parse_picture_template(raw_tail)
        if not desc:
            continue
        if kind == "scene" and nm:
            # 场景：用模板解析出的干净名字（如「公主府库房门口」）作 name，
            # desc 是原模板后的描述。把 nm + 描述合并存 desc，便于引用 & 生成图。
            scenes.append({"name": nm, "desc": desc, "full": nm + "，" + desc})
        elif kind == "role" and nm:
            dup = any(r.get("name") and r["name"] == nm for r in roles)
            if not dup:
                roles.append({"name": nm, "desc": desc, "full": nm + "，" + desc})
        else:
            # 兜底：按 desc 头关键词判别
            head = re.split(r"[，,]", desc)[0] if desc else ""
            if re.search(r"幕布|背景板|环境|plate|背景|scene|场景", head, re.IGNORECASE):
                clean = re.sub(r"(幕布|背景板|环境|背景|场景|plate|scene|背景图|设定)\s*$", "", desc, flags=re.IGNORECASE).strip()
                scenes.append(_parse_def(clean if clean else desc))
            else:
                dup = any(r.get("name") and r["name"] in head for r in roles)
                if not dup:
                    roles.append(_parse_def(desc))

    # ---- Pass 3：回退旧包格式 ----
    if not roles and not scenes:
        for line in lines:
            line = line.strip()
            m = re.match(r"(?:角色|人物|role)\s*\d*\s*[-－:：]?\s*(.+)", line, re.IGNORECASE)
            if m and m.group(1).strip():
                roles.append(_parse_def(m.group(1).strip().lstrip("-－:： ").strip()))
                continue
            m = re.match(r"(?:场景|scene|地点|环境)\s*\d*\s*[-－:：]?\s*(.+)", line, re.IGNORECASE)
            if m and m.group(1).strip():
                scenes.extend(_split_multi_defs(m.group(1).strip().lstrip("-－:： ").strip()))

    style = "，".join([p for p in style_parts if p])
    return roles, scenes, style


def _parse_def(s):
    """把「林晚，黑长直发，红风衣」拆成 name=林晚 + desc=黑长直发，红风衣。"""
    s = s.strip().rstrip("。.")
    # 优先括号前名字
    name = s
    desc = ""
    for sep in ("（", "(", "【"):
        if sep in s:
            name = s.split(sep)[0].strip()
            desc = s[len(name):].strip("（）()【】").strip()
            break
    if not desc:
        for sep in ("，", ",", "、", "："):
            if sep in name:
                head, _, tail = name.partition(sep)
                if head.strip() and tail.strip():
                    name = head.strip()
                    desc = tail.strip()
                    break
    return {"name": name, "desc": desc, "full": s}


# Picture 单行模板识别器。
#   输入：`<Picture N>` 后面那行除数字外的内容（如「是云妙衣（S1）的角色参考图：高盘发垂长发...」）
#   输出：(name, desc, kind) 三元组：
#     name —— 干净名字（如「云妙衣」「公主府库房门口」），用于跨镜引用/导出 CSV
#     desc —— 完整描述文本，可与 name 合并传给生成图模型
#     kind —— "role" / "scene" / None
#   支持的模板（顺序匹配，第一个命中即返回）：
#     场景类：含「场景/背景/环境」关键词 + 「参考图/设定」后缀 + 冒号 → scene
#     角色类：含「角色/人」关键词 + 「参考图/设定」后缀 + 冒号 → role
#     简单类：「名字：描述」→ 按描述里是否含场景词判别
#     兜底：返回 ("", tail, None)，由主流程按 Pass2 head 关键词判别
def _parse_picture_template(tail):
    """识别 <Picture N> 后跟的行内模板，返回 (name, desc, kind)。
    返回的 name 永远是干净名字（不含"是"/"角色参考图"/"场景参考图"等模板词）；desc 是可读描述。"""
    if not tail:
        return "", "", None
    s = tail.strip()
    # 去前导 "是"
    if s.startswith("是"):
        s = s[1:].strip()

    scene_kw = r"场景|背景|环境|scene|plate|setting"
    scene_suffix = r"参考图|设定|参考|图"
    role_kw = r"角色|人物|人物参考|角色参考"
    role_suffix = r"参考图|设定|参考|图"

    # 模板 1：场景名 + [的] + 场景关键词 + 后缀 + 冒号 + 描述
    m = re.match(
        r"^(?P<name>[^，,：（(:：\s]{1,30}?)"
        r"(?:\s*之?的?)?\s*"                   # 可选"的"
        r"(?:" + scene_kw + r")"
        r"(?:" + scene_suffix + r")?"
        r"\s*[：:]\s*"
        r"(?P<desc>.+)$",
        s,
    )
    if m:
        nm = m.group("name").strip().rstrip("，,。")
        desc = m.group("desc").strip()
        return nm, desc, "scene"
    # 模板 2：角色名 + [的] + 角色关键词 + 后缀 + 冒号 + 描述
    m = re.match(
        r"^(?P<name>[^，,：（(:：\s]{1,20}?)"
        r"(?:[（(]\s*S?\d+\s*[）)])?"           # 可选 (S1)/(Sx) ID
        r"(?:\s*之?的?)?\s*"
        r"(?:" + role_kw + r")"
        r"(?:" + role_suffix + r")?"
        r"\s*[：:]\s*"
        r"(?P<desc>.+)$",
        s,
    )
    if m:
        nm = m.group("name").strip().rstrip("，,。")
        desc = m.group("desc").strip()
        return nm, desc, "role"
    # 模板 3：简单「名字：描述」—— 按描述里是否含场景词判别
    m = re.match(r"^(?P<name>[^：:\n]{1,20}?)\s*[：:]\s*(?P<desc>.+)$", s)
    if m:
        nm = m.group("name").strip()
        desc = m.group("desc").strip()
        kind = "scene" if re.search(r"幕布|背景|环境|场景|plate|scene|setting|石室|石廊|库房|大街|街道|室外|室内|庭院|殿堂|房间|门口|门外|厅|院|宫|殿|府|山路|山道", desc, re.IGNORECASE) else "role"
        return nm, desc, kind
    # 模板 4：fallback
    return "", s, None


def _split_multi_defs(value):
    """把「S01 雨夜天台 / S02 城市街道」拆成多个定义；返回 [dict, ...]。
    按 / ；; 换行 分割（保留单个含描述时 _parse_def 内部再拆名字）。"""
    parts = re.split(r"\s*[/／;；]\s*|\n+", (value or "").strip())
    out = []
    for p in parts:
        p = p.strip().lstrip("-－:： ").strip()
        if p:
            out.append(_parse_def(p))
    return out


# ---------- assetgen ----------

async def assetgen_models(req):
    """列举 Krea2 文生图可用模型与默认值（UI 首次挂载拉取一次）。"""
    lists = krea2_model_list()
    defaults = {
        "model": krea2_defaults()[0],
        "text_encoder": krea2_defaults()[1],
        "vae": krea2_defaults()[2],
    }
    return _json({**lists, "defaults": defaults})


async def assetgen_config(req):
    """GET /mrnext/assetgen/config —— 4 模式（t2i/i2i/ref/edit）所需全部模型组件。
    包含 diffusion / text_encoders / vaes / loras + 默认值（含 edit_lora 自动选取）。
    Query:
      enabled=1/0  —— 1 时返回 LoRA 列表（默认）；0 时 loras 为 []
      extra=<path> —— 额外 LoRA 文件夹（绝对/相对 models），与默认合并去重
    """
    enabled = (req.query.get("enabled") or "1").strip() not in ("0", "false", "")
    extra   = (req.query.get("extra")   or "").strip()
    lists = krea2_model_list()
    loras = list_loras(extra_path=extra) if enabled else []
    model, te, vae = krea2_defaults()
    # 优先 identity_edit / 编辑类 Krea2 LoRA
    edit_lora = ""
    for n in loras:
        low = str(n).lower()
        if "identity_edit" in low or ("编辑" in n) or ("krea2" in low and ("edit" in low or "identity" in low)):
            edit_lora = str(n)
            if "identity_edit" in low:
                break
    # 可加载判定：ComfyUI 能通过 LoraLoaderModelOnly 加载的名字（规范名比较）
    try:
        _canon = {str(x).replace("\\", "/").lower() for x in folder_paths.get_filename_list("loras")}
    except Exception:  # noqa: BLE001
        _canon = set()
    loras_loadable = [n for n in loras if str(n).replace("\\", "/").lower() in _canon]
    return _json({
        **lists,
        "loras_loadable": loras_loadable,
        "loras": loras,
        "loraEnabled": enabled,
        "loraExtra": extra,
        "defaults": {
            "model": model,
            "text_encoder": te,
            "vae": vae,
            "edit_lora": edit_lora,
        },
    })


async def assetgen_generate(req):
    """生成图（4 模式：t2i/i2i/ref/edit），落盘到资产文件夹。
    mode: t2i(文生图) | i2i(图生图) | ref(参考生图) | edit(编辑图)
    未传 mode 时默认 t2i（向后兼容）。
    选了模型 → 走 Krea2 真实扩散（队列生成，可能耗时数十秒）；
    未选模型或执行失败 → 回退占位图，保证面板永远有反馈。
    """
    body = await req.json()
    prompt = (body.get("prompt") or "").strip()
    folder = (body.get("folder") or "").strip()
    model = (body.get("model") or "").strip()
    seed = int(body.get("seed") or 0)
    width = int(body.get("width") or 1024)
    height = int(body.get("height") or 1024)
    steps = int(body.get("steps") or 8)
    batch = max(1, min(int(body.get("batch") or 1), 4))
    enhance = body.get("enhance") or "off"
    mode = (body.get("mode") or "t2i").strip().lower()
    if mode not in ("t2i", "i2i", "ref", "edit"):
        mode = "t2i"
    src_rel = (body.get("src_rel") or "").strip() if isinstance(body.get("src_rel"), str) else ""
    ref_rels = [str(x).strip() for x in (body.get("ref_rels") or []) if str(x).strip()]
    try:
        strength = float(body.get("strength") or 0.6)
    except Exception:  # noqa: BLE001
        strength = 0.6
    strength = max(0.05, min(0.95, strength))
    edit_lora = (body.get("edit_lora") or "").strip()
    # ---- LoRA：所有生图模式通用（此前只有 edit 模式生效，用户实报"选了没用"）----
    lora_folder = (body.get("lora_folder") or body.get("extra") or "").strip()
    _want = []
    for _it in (body.get("loras") or []):
        if isinstance(_it, dict):
            _nm = str(_it.get("name") or "").strip()
            _st = _it.get("strength", None)
        else:
            _nm = str(_it or "").strip()
            _st = None
        if _nm:
            _want.append((_nm, _st))
    loras_used, loras_dropped, loras_unloadable = [], [], []
    if _want:
        # 必须用 ComfyUI 自己的权威清单校验：只有它能加载的名字才能通过 validate_prompt。
        # 我们面板的自定义「LoRA 文件夹」能"看到"文件，但若该目录不在 ComfyUI 的 loras 搜索路径
        # （models/loras 或 extra_model_paths.yaml 登记过的目录）里，LoraLoaderModelOnly 的
        # lora_name 会枚举不中 → prompt_outputs_failed_validation（用户实报）。
        _canon = {}
        try:
            for _x in folder_paths.get_filename_list("loras"):
                _canon[str(_x).replace("\\", "/").lower()] = str(_x)
        except Exception as _e:  # noqa: BLE001
            logging.getLogger("ComfyUI-MRBoard.assetgen").warning("读取 loras 清单失败：%s", _e)
        for _nm, _st in _want[:4]:
            _key = str(_nm).replace("\\", "/").lower()
            if _key in _canon:
                loras_used.append({"name": _canon[_key], "strength": _st})   # 用规范名（原样大小写/分隔符）
            else:
                loras_dropped.append(_nm)
                loras_unloadable.append(_nm)
        if loras_dropped:
            logging.getLogger("ComfyUI-MRBoard.assetgen").warning("LoRA 无法加载，已忽略：%s", loras_dropped)
    text_encoder = (body.get("text_encoder") or "").strip()
    vae = (body.get("vae") or "").strip()
    if enhance is True:
        enhance = "builtin"
    if enhance not in ("off", "builtin", "seedvr2", "vosr2"):
        enhance = "off"
    try:
        enhance_scale = float(body.get("enhance_scale") or 0) or None
    except (TypeError, ValueError):
        enhance_scale = None
    if enhance_scale is not None:
        enhance_scale = max(1.0, min(4.0, enhance_scale))
    if enhance == "vosr2":
        _ok, _why = _vosr2_ready()
        if not _ok:
            return _json({"ok": False, "error": _why}, status=500)
    if not prompt:
        return _json({"ok": False, "error": "提示词为空"}, status=400)
    if mode in ("i2i", "edit") and not src_rel:
        return _json({"ok": False, "error": ("i2i" if mode == "i2i" else "edit") + " 模式需提供 src_rel（原图 input 相对路径）"}, status=400)
    if mode == "ref" and not ref_rels:
        return _json({"ok": False, "error": "ref 模式需提供至少 1 张 ref_rels（参考图 input 相对路径列表）"}, status=400)

    base = _input_base()
    root = _safe_join(base, folder) if folder else _safe_join(base, "mrboard_next")
    os.makedirs(root, exist_ok=True)
    stamp = int(time.time() * 1000)

    note = ""
    used_real = False
    produced = []
    # 前端可自带 pid（发请求前即知，便于立即轮询实时预览），否则后端生成
    gen_pid = (body.get("pid") or "").strip() or str(uuid.uuid4())
    try:
        if model:
            produced = await run_krea2_generate(
                mode, prompt, model, root,
                seed=seed, width=width, height=height, steps=steps, batch=batch,
                text_encoder=text_encoder or None, vae=vae or None,
                enhance=enhance, prompt_id=gen_pid, enhance_scale=enhance_scale,
                loras=loras_used or None,
                src_rel=src_rel, ref_rels=ref_rels, strength=strength, edit_lora=edit_lora,
            )
            used_real = True
            enh_txt = {"builtin": " · 内置精修", "seedvr2": " · SeedVR2 超分",
                       "vosr2": " · VOSR2 超分 ×%d" % int(round(enhance_scale or 2))}.get(enhance, "")
            if loras_used:
                enh_txt += " · LoRA " + "+".join(
                    "%s%s" % (x["name"].split("/")[-1], ("×%g" % float(x["strength"])) if x.get("strength") not in (None, "") else "")
                    for x in loras_used)
            note = "Krea2 " + mode + " 真实生成" + enh_txt
        else:
            # 占位仅适用于 t2i（无 src）；其它模式无模型直接报错
            if mode != "t2i":
                return _json({"ok": False, "error": "未选模型，无法跑 " + mode + " 模式"}, status=400)
            produced = [generate_placeholder(prompt, os.path.join(root, f"gen_{stamp}.png"), seed,
                                             width, height)]
            note = "占位图（未选模型）"
    except Exception as exc:  # noqa: BLE001
        if mode != "t2i":
            return _json({"ok": False, "error": f"真实生成失败: {exc}"}, status=500)
        produced = [generate_placeholder(prompt, os.path.join(root, f"gen_{stamp}.png"), seed,
                                         width, height)]
        note = f"真实生成失败，回退占位：{exc}"

    out_path = produced[0] if produced else os.path.join(root, f"gen_{stamp}.png")
    rel = os.path.relpath(out_path, base).replace(os.sep, "/")
    return _json({
        "ok": True,
        "pid": gen_pid,
        "mode": mode,
        "filename": os.path.basename(out_path),
        "subfolder": os.path.dirname(rel),
        "type": "input",
        "rel": rel,
        "rels": [os.path.relpath(p, base).replace(os.sep, "/") for p in produced],
        "count": len(produced),
        "used_real": used_real,
        "note": note,
        # LoRA 回执：前端据此提示"哪些没找到"，避免用户以为"选了没用"
        "loras_used": [x["name"] for x in loras_used],
        "loras_dropped": loras_dropped,
        "loras_unloadable": loras_unloadable,
        "lora_folder": lora_folder,
    })


async def assetgen_enhance(req):
    """POST /mrnext/assetgen/enhance —— 对已生成结果图二次画质增强。
    body: {rels, folder, model, seed?, steps?, engine?: builtin|seedvr2|vosr2, scale?}
    builtin：Krea2 hires-fix（latent 放大 scale 倍 + 二次精修，需 Krea2 模型）；
    seedvr2：SeedVR2 一步修复超分（目标短边 = 原短边 × scale）；
    vosr2  ：VOSR 2.0 一步扩散超分（整数倍 scale，快且省显存，逐张可用）。"""
    body = await req.json()
    rels = [str(r).strip() for r in (body.get("rels") or []) if str(r).strip()]
    folder = (body.get("folder") or "").strip()
    model = (body.get("model") or "").strip()
    seed = int(body.get("seed") or 0)
    steps = int(body.get("steps") or 8)
    engine = (body.get("engine") or "builtin").strip()
    if engine not in ("builtin", "seedvr2", "vosr2"):
        engine = "builtin"
    try:
        scale = float(body.get("scale") or 0) or None
    except (TypeError, ValueError):
        scale = None
    if scale is not None:
        scale = max(1.0, min(4.0, scale))
    if not rels:
        return _json({"ok": False, "error": "未选择要增强的图片"}, status=400)
    if engine == "builtin" and not model:
        return _json({"ok": False, "error": "未选择 Krea2 模型"}, status=400)
    if engine == "vosr2":
        _ok, _why = _vosr2_ready()
        if not _ok:
            return _json({"ok": False, "error": _why}, status=500)

    base = _input_base()
    root = _safe_join(base, folder) if folder else _safe_join(base, "mrboard_next")
    os.makedirs(root, exist_ok=True)

    # 校验 rel 都在 input 内且文件存在（LoadImage 按 input 相对名加载）
    for rel in rels:
        if rel.startswith("OUTPUT:"):
            return _json({"ok": False, "error": "二次增强仅支持 input 目录图片"}, status=400)
        try:
            full = _safe_join(base, rel)
        except ValueError:
            return _json({"ok": False, "error": "路径越界: " + rel}, status=400)
        if not os.path.isfile(full):
            return _json({"ok": False, "error": "图片不存在: " + rel}, status=404)

    try:
        produced = await run_enhance_image(rels, model, root, seed=seed, steps=steps,
                                           engine=engine, scale=scale)
    except Exception as exc:  # noqa: BLE001
        return _json({"ok": False, "error": "二次增强失败: " + str(exc)[:400]}, status=500)

    return _json({
        "ok": True,
        "rels": [os.path.relpath(p, base).replace(os.sep, "/") for p in produced],
        "count": len(produced),
        "note": "二次画质增强完成" + {"seedvr2": "（SeedVR2 修复超分）",
                                     "vosr2": "（VOSR2 一步超分 ×%d）" % int(round(scale or 2))}.get(engine, ""),
    })


async def assetgen_vosr2_status(req):
    """GET /mrnext/assetgen/vosr2_status —— 检测 VOSR2 是否可用（模型 + 节点），供生图面板提示/禁用。"""
    ok, why = _vosr2_ready()
    return _json({"ok": bool(ok), "why": why})


async def assetgen_seedvr2_status(req):
    """GET /mrnext/assetgen/seedvr2_status —— 检测 SeedVR2 模型是否可用（供前端显示/禁用引擎）。"""
    dit, vae = seedvr2_models()
    return _json({"ok": True, "available": bool(dit and vae), "dit": dit, "vae": vae})


# ---------- editor（剪辑：序列合成 / 裁剪 / 背景音乐 / 探测） ----------

def _ffprobe_exe():
    try:
        import shutil
        p = shutil.which("ffprobe")
        if p:
            return p
    except Exception:  # noqa: BLE001
        pass
    # 便携整合包常把 ffprobe 放在 portable 根/ffprobe/
    cwd = os.getcwd()
    for cand in (os.path.join(os.path.dirname(cwd), "ffprobe", "ffprobe.exe"),
                 os.path.join(os.path.dirname(cwd), "ffprobe.exe")):
        if os.path.isfile(cand):
            return cand
    return ""


def _ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        import shutil
        return shutil.which("ffmpeg") or ""


def _probe_duration(exe_ffmpeg, path):
    """返回媒体时长秒；失败返回 None（不抛）。"""
    fp = _ffprobe_exe()
    if not fp:
        return None
    try:
        proc = subprocess.run(
            [fp, "-v", "error", "-show_entries", "format=duration",
             "-of", "json", path],
            capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            return None
        import json as _json_mod
        d = _json_mod.loads(proc.stdout).get("format", {}).get("duration")
        return float(d) if d is not None else None
    except Exception:  # noqa: BLE001
        return None


def _has_audio_stream(fp, path):
    if not fp:
        return False
    try:
        proc = subprocess.run(
            [fp, "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=index", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60)
        return bool(proc.stdout and proc.stdout.strip())
    except Exception:  # noqa: BLE001
        return False


async def editor_videos(req):
    """列举剪辑可用视频：input/folder/video（前端出片）+ output/video（节点 Queue 出片）。"""
    folder = (req.query.get("folder") or "").strip()
    rel = (folder + "/video") if folder else "video"
    vids = []
    for f in _list_files(rel, "video"):
        vids.append({**f, "rel": rel + "/" + f["name"]})
    # 节点 Queue 出片（subgraph SaveVideo）落在 output/video，也纳入剪辑素材区
    try:
        out_dir = os.path.join(folder_paths.get_output_directory(), "video")
        if os.path.isdir(out_dir):
            for name in sorted(os.listdir(out_dir)):
                full = os.path.join(out_dir, name)
                if os.path.isfile(full) and _kind_of(name) == "video":
                    vids.append({"name": name, "kind": "video",
                                 "size": os.path.getsize(full), "mtime": int(os.path.getmtime(full)),
                                 "rel": "OUTPUT:video/" + name})
    except Exception:  # noqa: BLE001
        pass
    return _json({"videos": vids})


async def editor_probe(req):
    """GET /mrnext/editor/probe?rel= → {duration}（秒），供序列 UI 设裁剪范围。"""
    rel = (req.query.get("rel") or "").strip()
    if rel.startswith("OUTPUT:"):
        base = folder_paths.get_output_directory()
        sub = rel[len("OUTPUT:"):]
    else:
        base = _input_base()
        sub = rel
    try:
        full = _safe_join(base, sub)
    except ValueError:
        return _json({"rel": rel, "duration": None})
    d = _probe_duration(_ffmpeg_exe(), full) if os.path.isfile(full) else None
    return _json({"rel": rel, "duration": d})


async def editor_compose(req):
    """剪映式序列合成：逐段裁剪（可选 in/out，秒）→ 统一重编码 → 无损拼接 → 可选背景音乐。

    body: {folder, segments:[{rel, in?, out?, speed?, volume?, muted?}], music?,
           audios?:[{rel, in?, out?, volume?, muted?}]}
      - music: 单个背景音乐文件名（folder 下）
      - audios: 音频轨多段（按顺序裁剪+拼接成一条配乐，与视频时长对齐混音）
      - speed: 变速倍数 0.5–2（视频 setpts + 音频 atempo，剪映式变速）
      - volume: 音量 0–3（1=原声）；muted: true 静音（等价 volume=0）
    输出 folder/video/compose_*.mp4
    """
    body = await req.json()
    segments = body.get("segments") or []
    music = (body.get("music") or "").strip()
    audios = body.get("audios") or []
    folder = (body.get("folder") or "").strip()
    if not segments:
        return _json({"ok": False, "error": "无片段"}, status=400)

    base = _input_base()
    exe = _ffmpeg_exe()
    fp = _ffprobe_exe()
    if not exe:
        return _json({"ok": False, "error": "未找到 ffmpeg"}, status=500)

    resolved = []
    for seg in segments:
        rel = (seg.get("rel") or "").strip()
        if not rel:
            continue
        try:
            if rel.startswith("OUTPUT:"):
                full = _safe_join(folder_paths.get_output_directory(), rel[len("OUTPUT:"):])
            else:
                full = _safe_join(base, rel)
        except ValueError:
            continue
        if os.path.isfile(full):
            resolved.append((rel, full, seg))
    if not resolved:
        return _json({"ok": False, "error": "片段路径无效"}, status=400)

    import tempfile

    work = tempfile.mkdtemp(prefix="mrnext_edit_")
    ok, msg = False, "unknown"
    try:
        # 统一参数重编码每段（保证码流一致，后续可 -c copy 拼接）
        audio_any = any(_has_audio_stream(fp, full) for _, full, _ in resolved)
        mids = []
        for i, (rel, full, seg) in enumerate(resolved):
            mid = os.path.join(work, "s%03d.mp4" % i)
            cmd = [exe, "-y", "-i", full]
            try:
                s_in = float(seg.get("in"))
            except (TypeError, ValueError):
                s_in = None
            try:
                s_out = float(seg.get("out"))
            except (TypeError, ValueError):
                s_out = None
            if s_in is not None and s_in > 0:
                cmd += ["-ss", "%.3f" % s_in]
            if s_in is not None and s_out is not None and s_out > s_in:
                cmd += ["-t", "%.3f" % (s_out - s_in)]
            # ---- 剪映式变速 / 音量 ----
            try:
                spd = float(seg.get("speed") or 1.0)
            except (TypeError, ValueError):
                spd = 1.0
            spd = max(0.5, min(2.0, spd))
            vf, af = [], []
            if abs(spd - 1.0) > 1e-6:
                vf.append("setpts=PTS/%.6f" % spd)
                af.append("atempo=%.6f" % spd)
            if seg.get("muted"):
                af.append("volume=0")
            else:
                try:
                    vol = seg.get("volume")
                    vol = None if vol in (None, "") else float(vol)
                except (TypeError, ValueError):
                    vol = None
                if vol is not None and abs(vol - 1.0) > 1e-6:
                    af.append("volume=%.3f" % max(0.0, min(3.0, vol)))
            if vf:
                cmd += ["-vf", ",".join(vf)]
            cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20"]
            if audio_any:
                if af:
                    cmd += ["-af", ",".join(af)]
                cmd += ["-c:a", "aac", "-b:a", "128k"]
            else:
                cmd += ["-an"]
            cmd += ["-movflags", "+faststart", mid]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
            if proc.returncode != 0 or not os.path.isfile(mid):
                return _json({"ok": False, "error": "裁剪失败: " + (proc.stderr or "")[-400:]}, status=500)
            mids.append(mid)

        list_file = os.path.join(work, "list.txt")
        with open(list_file, "w", encoding="utf-8") as fh:
            for m in mids:
                fh.write("file '%s'\n" % m.replace("\\", "/"))
        joined = os.path.join(work, "joined.mp4")
        proc = subprocess.run(
            [exe, "-y", "-f", "concat", "-safe", "0", "-i", list_file,
             "-c", "copy", "-movflags", "+faststart", joined],
            capture_output=True, text=True, timeout=900)
        if proc.returncode != 0 or not os.path.isfile(joined):
            return _json({"ok": False, "error": "拼接失败: " + (proc.stderr or "")[-400:]}, status=500)

        out_dir = _safe_join(base, (folder + "/video") if folder else "video")
        os.makedirs(out_dir, exist_ok=True)
        final = os.path.join(out_dir, "compose_%d.mp4" % int(time.time()))

        # 确定背景音乐源：优先 audios（多段音频轨拼接），否则 music（单个文件）
        music_path = ""
        if audios:
            try:
                a_mids = []
                for i, a in enumerate(audios):
                    arel = str(a.get("rel") or "").strip()
                    if not arel:
                        continue
                    try:
                        if arel.startswith("OUTPUT:"):
                            apath = _safe_join(folder_paths.get_output_directory(), arel[len("OUTPUT:"):])
                        else:
                            apath = _safe_join(base, arel)
                    except ValueError:
                        continue
                    if not os.path.isfile(apath):
                        continue
                    amid = os.path.join(work, "a%03d.m4a" % i)
                    acmd = [exe, "-y", "-i", apath]
                    try:
                        a_in = float(a.get("in"))
                    except (TypeError, ValueError):
                        a_in = None
                    try:
                        a_out = float(a.get("out"))
                    except (TypeError, ValueError):
                        a_out = None
                    if a_in is not None and a_in > 0:
                        acmd += ["-ss", "%.3f" % a_in]
                    if a_in is not None and a_out is not None and a_out > a_in:
                        acmd += ["-t", "%.3f" % (a_out - a_in)]
                    a_af = []
                    if a.get("muted"):
                        a_af.append("volume=0")
                    else:
                        try:
                            avol = a.get("volume")
                            avol = None if avol in (None, "") else float(avol)
                        except (TypeError, ValueError):
                            avol = None
                        if avol is not None and abs(avol - 1.0) > 1e-6:
                            a_af.append("volume=%.3f" % max(0.0, min(3.0, avol)))
                    if a_af:
                        acmd += ["-af", ",".join(a_af)]
                    acmd += ["-vn", "-c:a", "aac", "-b:a", "128k", amid]
                    pr = subprocess.run(acmd, capture_output=True, text=True, timeout=600)
                    if pr.returncode == 0 and os.path.isfile(amid):
                        a_mids.append(amid)
                if a_mids:
                    alist = os.path.join(work, "alist.txt")
                    with open(alist, "w", encoding="utf-8") as fh:
                        for m in a_mids:
                            fh.write("file '%s'\n" % m.replace("\\", "/"))
                    amix = os.path.join(work, "amix.m4a")
                    pr = subprocess.run([exe, "-y", "-f", "concat", "-safe", "0", "-i", alist,
                                         "-c", "copy", amix], capture_output=True, text=True, timeout=600)
                    if pr.returncode == 0 and os.path.isfile(amix):
                        music_path = amix
            except Exception:  # noqa: BLE001
                music_path = ""
        elif music:
            try:
                mrel = (folder + "/" + music) if (folder and music) else music
                music_path = _safe_join(base, mrel)
            except ValueError:
                music_path = ""

        if music_path and os.path.isfile(music_path) and audio_any:
            try:
                out_tmp = os.path.join(work, "final.mp4")
                proc = subprocess.run(
                    [exe, "-y", "-i", joined, "-i", music_path,
                     "-filter_complex", "[1:a]volume=0.55[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]",
                     "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
                     "-movflags", "+faststart", out_tmp],
                    capture_output=True, text=True, timeout=900)
                if proc.returncode == 0 and os.path.isfile(out_tmp):
                    joined = out_tmp
                # 音乐混音失败 → 静默回落为无音乐版本
            except Exception:  # noqa: BLE001
                pass
        shutil.move(joined, final)
        ok, msg = True, ""
        rel = os.path.relpath(final, base).replace(os.sep, "/")
    finally:
        import shutil as _sh
        _sh.rmtree(work, ignore_errors=True)

    if not ok:
        return _json({"ok": False, "error": msg}, status=500)
    return _json({"ok": True, "rel": rel, "filename": os.path.basename(final)})



# ---------- skills（本地 Qwen 提示词优化） ----------

async def skills_scan(req):
    """扫描技能库目录（默认旧包 skills/，可传 folder 指定其它目录）。"""
    base = (req.query.get("folder") or "").strip() or skillmod.default_skills_base()
    return _json({"folder": base, "count": len(skillmod.scan_skills(base)),
                  "skills": skillmod.scan_skills(base)})


async def skills_read(req):
    """读取单个技能正文。"""
    base = (req.query.get("folder") or "").strip() or skillmod.default_skills_base()
    sid = (req.query.get("id") or "").strip()
    try:
        content, fname = skillmod.read_skill(base, sid)
    except Exception as exc:  # noqa: BLE001
        return _json({"error": str(exc)}, status=400)
    return _json({"id": sid, "file": fname, "content": content})


async def skills_status(req):
    return _json(skillmod.status())


async def skills_models(req):
    """GET /mrnext/skills/models?folder= —— 列模型。folder 为空走默认 models/LLM；
    否则扫该自定义目录（旧包「选择模型文件夹」能力）。"""
    folder = (req.query.get("folder") or "").strip()
    st = skillmod.status()
    models, mmproj = skillmod.list_llm_models(folder)
    return _json({
        "models": models,
        "mmproj": mmproj,
        "families": skillmod.families(),
        "current": st.get("model", ""),
        "loaded": bool(st.get("loaded")),
        "folder": folder,
    })


async def skills_recommend(req):
    """GET /mrnext/skills/recommend?model=&folder= —— 按模型版本/体积推荐最优参数
    （最大上下文 n_ctx + 采样参数），供「选模型版本自动套最优参数」使用。"""
    model = (req.query.get("model") or "").strip()
    folder = (req.query.get("folder") or "").strip()
    if not model:
        return _json({"ok": False, "error": "未提供模型名"}, status=400)
    return _json({"ok": True, "model": model, "params": skillmod.recommend_params(model, folder)})


async def skills_load_model(req):
    """加载本地 Qwen（首载分钟级 → 放进线程池，不阻塞事件循环）。"""
    body = await req.json()
    model = (body.get("model") or "").strip()
    if not model:
        return _json({"error": "未选择模型"}, status=400)
    opts = body.get("opts") or {}
    folder = (body.get("folder") or "").strip()
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None, lambda: skillmod.load_model(
                model,
                family=(body.get("family") or "").strip() or None,
                mmproj=(body.get("mmproj") or "").strip() or None,
                opts=opts,
                folder=folder,
            )
        )
    except Exception as exc:  # noqa: BLE001
        return _json({"error": str(exc), "needModel": True}, status=503)
    return _json({"ok": True, **result})


async def skills_unload(req):
    skillmod.unload_model()
    return _json({"ok": True})


async def skills_optimize(req):
    """按 Skill 优化提示词（单轮对话，线程池推理）。"""
    body = await req.json()
    text = (body.get("text") or "").strip()
    if not text:
        return _json({"error": "待优化内容为空"}, status=400)

    skill_content = (body.get("skillContent") or "").strip()
    if not skill_content and body.get("skillId"):
        # 只给技能 id → 服务端按当前技能库读取正文
        base = (body.get("folder") or "").strip() or skillmod.default_skills_base()
        try:
            skill_content, _ = skillmod.read_skill(base, str(body["skillId"]).strip())
        except Exception as exc:  # noqa: BLE001
            return _json({"error": "读取技能失败: " + str(exc)}, status=400)

    instruction = (body.get("instruction") or "").strip()
    params = body.get("params") or {}
    # 接续推理：输出被 max_tokens 截断时自动续写，直到完整或达 max_rounds
    use_continue = bool(body.get("continue") or body.get("continue_"))
    try:
        max_rounds = max(1, min(int(body.get("max_rounds") or 3), 6))
    except Exception:  # noqa: BLE001
        max_rounds = 3
    loop = asyncio.get_running_loop()
    # 推理过程（思考模式的 reasoning / <think> 内容）：收集后随响应回传，供前端「推理过程预览」
    reason_list = []

    def _run():
        if use_continue:
            return skillmod.optimize_continue(text, skill_content, instruction,
                                              params=params, max_rounds=max_rounds,
                                              collect=reason_list)
        return skillmod.optimize(text, skill_content, instruction, params=params,
                                 collect=reason_list)

    try:
        out = await loop.run_in_executor(None, _run)
    except Exception as exc:  # noqa: BLE001
        # 把完整 traceback 打到 ComfyUI 控制台，方便排查 llama.cpp 内部错误
        import logging as _logging
        _logging.getLogger("ComfyUI-MRBoard.skills").exception(
            "skills/optimize failed: %s", exc
        )
        need_model = "尚未加载" in str(exc) or "llama-TE" in str(exc)
        return _json({"error": str(exc), "needModel": need_model}, status=503 if need_model else 500)
    return _json({"ok": True, "text": out,
                  "reasoning": "\n\n".join([x for x in reason_list if x]).strip()})


# ---------- favorites（后端收藏库） / longdoc（长文档适配） ----------

async def favorites_list(req):
    return _json({"items": favmod.list_items()})


async def favorites_add(req):
    body = await req.json()
    raw = body.get("items")
    if not isinstance(raw, list):
        raw = [body["item"]] if isinstance(body.get("item"), dict) else []
    try:
        result = favmod.add_items(raw)
    except Exception as exc:  # noqa: BLE001
        return _json({"error": str(exc)}, status=500)
    return _json({"ok": True, **result})


def _purge_thumb_cache(rels):
    """删除素材后同步清掉 output/mrnext_thumbs/ 里的缩略图缓存（key=md5(rel)[:16]）。"""
    import hashlib as _h
    out_dir = os.path.join(folder_paths.get_output_directory(), "mrnext_thumbs")
    purged = 0
    for rel in rels:
        rel = str(rel or "").strip()
        if not rel:
            continue
        key = _h.md5(rel.encode("utf-8")).hexdigest()[:16]
        p = os.path.join(out_dir, key + ".jpg")
        if os.path.isfile(p):
            try:
                os.remove(p)
                purged += 1
            except Exception:  # noqa: BLE001
                pass
    return purged


async def favorites_remove(req):
    body = await req.json()
    keys = [
        (str(x.get("rel") or ""), str(x.get("category") or ""))
        for x in (body.get("items") or [])
        if isinstance(x, dict)
    ]
    try:
        result = favmod.remove_items(ids=body.get("ids"), keys=keys)
    except Exception as exc:  # noqa: BLE001
        return _json({"error": str(exc)}, status=500)
    # 收藏移除后同步清缩略图缓存（rel 取自 keys + items 里的 rel 字段）
    rels = [k[0] for k in keys if k[0]] + [str(x.get("rel") or "") for x in (body.get("items") or []) if isinstance(x, dict)]
    purged = _purge_thumb_cache(rels)
    return _json({"ok": True, **result, "thumbs_purged": purged})


async def longdoc_adapt(req):
    body = await req.json()
    text = (body.get("text") or "").strip()
    if not text:
        return _json({"error": "text 不能为空"}, status=400)
    result = longdocmod.adapt(text)
    if not result.get("detected"):
        return _json({"detected": False, "message": "未检测到 Sxx/Ns 镜头结构，原样使用"})
    return _json(result)


# ---------- 工具：工作流消毒 / 导出 txt / 原生导入 ----------

async def studio_sanitize(req):
    """消毒工作流：重复 node id 重编号、链接引用同步。"""
    try:
        body = await req.json()
    except Exception:  # noqa: BLE001
        return _json({"error": "JSON 解析失败"}, status=400)
    g = body.get("graph")
    if not isinstance(g, dict):
        return _json({"error": "body.graph 必须是对象"}, status=400)
    g2, idmap, removed = sanitizemod.sanitize_workflow(g)
    return _json({"graph": g2, "renumbered": idmap, "count": removed})


async def studio_export(req):
    """导出分镜提示词 .txt（含可选前缀）。"""
    body = await req.json()
    script = (body.get("script") or "").strip()
    prefix = (body.get("prefix") or "").strip()
    bodies, _, _, _md = _split_script(script, prefix=prefix if prefix else None, strip=True)
    parts = []
    if prefix:
        parts.append(prefix)
    if bodies:
        for i, t in enumerate(bodies):
            parts.append(f"【镜头{i + 1}】\n{t}")
    text = "\n\n".join(parts) if parts else "（剧本为空，未切分出分镜）"
    return web.Response(
        text=text,
        content_type="text/plain",
        charset="utf-8",
        headers={"Content-Disposition": 'attachment; filename="storyboard_export.txt"'},
    )


async def studio_paths(req):
    """GET /mrnext/studio/paths —— 返回 input/output 目录绝对路径（前端把用户所选绝对路径相对化到 input 用）。"""
    return _json({"ok": True,
                  "input_base": folder_paths.get_input_directory(),
                  "output_base": folder_paths.get_output_directory()})


async def studio_native_pick(req):
    """Windows 原生选择框（文件夹 / 文件单选多选）。"""
    body = await req.json()
    kind = (body.get("kind") or "file").strip()
    if kind not in ("file", "folder"):
        kind = "file"
    res = nativepick.pick(
        kind=kind,
        title=(body.get("title") or "选择").strip(),
        filetypes=body.get("filetypes") or [],
        multiple=bool(body.get("multiple")),
        start_path=(body.get("start_path") or "").strip(),
    )
    return _json(res)


async def studio_read_text_file(req):
    """读取本地文本文件（≤5MB，utf-8 容错）。"""
    body = await req.json()
    path = str(body.get("path") or "").strip()
    if not path or not os.path.isfile(path):
        return _json({"error": "文件不存在"}, status=400)
    try:
        size = os.path.getsize(path)
    except Exception:  # noqa: BLE001
        size = 0
    if size > 5 * 1024 * 1024:
        return _json({"error": "文件过大（>5MB）"}, status=400)
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            text = fh.read()
    except Exception as exc:  # noqa: BLE001
        return _json({"error": "读取失败: " + str(exc)}, status=500)
    return _json({"ok": True, "name": os.path.basename(path), "text": text})


async def studio_import_folder(req):
    """递归扫描本地文件夹，把图片/音频/视频拷入资产文件夹（重名同尺寸跳过）。"""
    body = await req.json()
    src = str(body.get("folder") or "").strip()
    target = (body.get("target") or "").strip()
    if not src or not os.path.isdir(src):
        return _json({"error": "文件夹不存在"}, status=400)
    base = _input_base()
    dest = _safe_join(base, target) if target else base
    os.makedirs(dest, exist_ok=True)
    copied, skipped = [], 0
    all_exts = set()
    for exts in _KIND_EXTS.values():
        all_exts |= exts
    try:
        for root, _dirs, files in os.walk(src):
            for name in files:
                ext = os.path.splitext(name)[1].lower()
                if ext not in all_exts:
                    continue
                full = os.path.join(root, name)
                dst = os.path.join(dest, name)
                if os.path.isfile(dst) and os.path.getsize(dst) == os.path.getsize(full):
                    skipped += 1
                    continue
                shutil.copyfile(full, dst)
                copied.append(name)
    except Exception as exc:  # noqa: BLE001
        return _json({"error": "导入失败: " + str(exc)}, status=500)
    return _json({"ok": True, "copied": len(copied), "skipped": skipped,
                  "names": copied[:40]})


async def studio_analyze(req):
    """把分镜正文与候选资产（收藏库/文件名）按「名字」匹配。

    body: {texts:[每个分镜正文], candidates:[{name,rel,kind,category}]}
    name 及其括号前主干（如「林晚（女主角）」→ 林晚）命中正文即算匹配。
    返回 perShot（与 texts 对齐的命中列表）+ used。只做匹配，不改写文本。
    """
    body = await req.json()
    texts = body.get("texts") or []
    cands = body.get("candidates") or []
    if not isinstance(texts, list) or not isinstance(cands, list) or not cands:
        return _json({"error": "texts/candidates 不合法"}, status=400)

    def _aliases(name):
        out = [name]
        for sep in ("（", "(", "【"):
            if sep in name:
                out.append(name.split(sep)[0].strip())
                break
        return [a for a in out if a]

    def _is_machine_name(name):
        """ComfyUI 机器文件名（如 1788948454574_aeb7332f_00001_.png）——不参与正文匹配。
        特征：去扩展名后由 数字/下划线/十六进制哈希段 组成，无任何中文或字母单词。"""
        stem = re.sub(r"\.[^.]+$", "", name).strip()
        if not stem:
            return True
        segs = stem.split("_")
        segs = [s for s in segs if s]
        if not segs:
            return True
        # 全部段都是纯数字或十六进制哈希 → 机器名
        def _machine_seg(s):
            return bool(re.fullmatch(r"\d+", s)) or bool(re.fullmatch(r"[0-9a-fA-F]{6,}", s))
        return all(_machine_seg(s) for s in segs)

    per_shot = []
    used = set()
    carry = []  # 上一镜命中的角色/资产，供「她/他/它」代词回溯继承
    for t in texts:
        low = (t or "").lower()
        matched = []
        for c in cands:
            name = str(c.get("name") or "").strip()
            if not name:
                continue
            if _is_machine_name(name):
                continue  # 机器文件名不是角色/场景名，跳过（修复：数字文件名被识别成引用标记）
            if any(a.lower() in low for a in _aliases(name)):
                matched.append({
                    "name": name,
                    "rel": str(c.get("rel") or "").replace("\\", "/"),
                    "kind": str(c.get("kind") or "image").lower(),
                    "category": str(c.get("category") or "asset").lower(),
                })
                used.add(name)
        # 代词回溯：正文只有「她/他/它/其」且无显式人名时，继承上一镜命中
        if not matched and carry and re.search(r"(^|[^一-龥])(她|他|它|其)", low):
            for m in carry:
                matched.append(dict(m))
        per_shot.append(matched)
        carry = [m for m in matched if m.get("category") in ("role", "asset", "audio")] or matched
    return _json({"perShot": per_shot, "used": sorted(used), "count": len(texts)})


async def h3_shot(req):
    """官方 H3 Director 引擎逐镜成片（媒体感知，Phase B+①）。

    body: {mode: t2v|i2v|fl2v|fl2v_tail|r2v, prompt, folder, seed?, seconds?,
           frameRate?, first_frame?, last_frame?, refs?:[rel]}
    媒体均为 input 目录相对路径；i2v/fl2v 用 first_frame(首帧图)，fl2v_tail 用 last_frame，
    r2v 用 refs(参考图) 自动填 ref_images 槽。产物落 folder/video/。
    """
    body = await req.json()
    mode = (body.get("mode") or "").strip().lower()
    if mode not in ("t2v", "i2v", "fl2v", "fl2v_tail", "r2v"):
        return _json({"ok": False, "error": "未知模式: " + mode}, status=400)
    # 虚拟引用 token 净化：@image#N:xxx.png 是粘贴图片时产生的引用标记（非真实文件），
    # 前端出片前已剥一次，这里再兜一次 —— 旧缓存前端 / 外部脚本直接调 API 时不至于污染出片。
    prompt = _strip_virtual_refs(body.get("prompt"))
    prefix = _strip_virtual_refs(body.get("prefix"))
    folder = (body.get("folder") or "").strip()
    if not prompt:
        return _json({"ok": False, "error": "镜头提示词为空"}, status=400)
    seed = int(body.get("seed") or 0)
    try:
        seconds = float(body.get("seconds") or 5.0)
    except (TypeError, ValueError):
        seconds = 5.0
    seconds = min(max(seconds, 1.0), 20.0)
    try:
        fr = float(body.get("frameRate") or 24.0)
    except (TypeError, ValueError):
        fr = 24.0
    steps = body.get("steps")
    cfg = body.get("cfg")

    # —— H3 官方三段式提示词（治「说话乱说 / 语音乱码」）——
    # H3 是音视频联合生成模型。只给画面描述、不写声音字段时，模型会自行"补"人声与音效，
    # 表现就是「张嘴说胡话」「两人同时说话」「背景杂音乱入」。这里按官方 Prompt Guide
    # 补齐 integrated_multimodal_description / overall_soundscape / non_diegetic_music，
    # 台词改用 [语言] … 包裹（双引号在 H3 里是"画面可见的字"，会变字幕）。
    opts_in = body.get("opts") if isinstance(body.get("opts"), dict) else {}
    try:
        _shot_no = int(body.get("index") or body.get("shot_index") or 1)
    except (TypeError, ValueError):
        _shot_no = 1
    try:
        prompt, _dialogs = h3pmod.assemble(
            text=prompt, prefix=prefix, opts=opts_in,
            shot_no=_shot_no, seconds=seconds)
    except Exception:  # noqa: BLE001 —— 组装失败绝不能阻断出片，退化成原样拼接
        if prefix:
            prompt = (prefix + "\n\n" + prompt).strip()
        _dialogs = []

    # —— 低步数音频护栏 ——
    # 社区实测（Kijai / Comfy-Org）：ComfyUI stable 在低于 8 步时 H3 音轨会失真/变噪音，
    # 根因是主仓 bug（修复 commit bdcb886，只在 nightly）。护栏开启时自动把步数抬到安全线，
    # 并把回执带给前端提示 —— 用户要么升 nightly，要么接受 8 步以上。
    opts_out, audio_note = h3pmod.apply_audio_guard(opts_in)

    base = _input_base()
    out_dir = _safe_join(base, (folder + "/video") if folder else "video")
    os.makedirs(out_dir, exist_ok=True)

    def _rel(v):
        s = str(v or "").strip().replace("\\", "/")
        return s if s else None

    # 素材前置校验：i2v/fl2v/fl2v_tail/r2v 必须有对应素材图，否则构图缺必需输入
    first_frame = _rel(body.get("first_frame"))
    last_frame = _rel(body.get("last_frame"))
    refs = [x for x in ([_rel(r) for r in (body.get("refs") or [])] if body.get("refs") else []) if x]
    # 幽灵素材过滤：素材被清理后，前端/store 缓存里的 rel 可能还在，这里按磁盘实际存在性剔除，
    # 否则已删除的首帧图/参考图会继续参与构图，污染其它模式的适配生成。
    dropped = []

    def _media_exists(rel_):
        try:
            return os.path.isfile(_safe_join(base, str(rel_ or "").strip().replace("\\", "/")))
        except (ValueError, OSError):
            return False

    if first_frame and not _media_exists(first_frame):
        dropped.append(first_frame); first_frame = None
    if last_frame and not _media_exists(last_frame):
        dropped.append(last_frame); last_frame = None
    if refs:
        _keep = [r for r in refs if _media_exists(r)]
        dropped.extend([r for r in refs if r not in _keep])
        refs = _keep

    # 模式与素材强绑定：t2v（文生视频）是纯文字模式，任何图片输入都强制丢弃。
    # 兜底原因：前端若被浏览器缓存住旧版本，可能仍把参考图塞进 payload；后端守住最后一道，
    # 保证 t2v 构图里绝不会出现 LoadImage / ref_images / r2v_groups（用户反馈"t2v 还是多参考"）。
    if mode == "t2v":
        for _x in ([first_frame, last_frame] + list(refs or [])):
            if _x:
                dropped.append(_x)
        first_frame = None
        last_frame = None
        refs = None

    if mode in ("i2v", "fl2v") and not first_frame:
        return _json({"ok": False, "error": f"{mode} 模式需要 first_frame 首帧图（九宫格第1张或分镜匹配命中）"}, status=400)
    if mode in ("fl2v", "fl2v_tail") and not last_frame:
        return _json({"ok": False, "error": f"{mode} 模式需要 last_frame 尾帧图"}, status=400)
    if mode == "r2v" and not refs:
        return _json({"ok": False, "error": "r2v 模式需要至少一张参考图 refs"}, status=400)

    try:
        path = await h3mod.run_shot(
            mode, prompt, out_dir, seed=seed, seconds=seconds, frame_rate=fr,
            first_frame=first_frame,
            last_frame=last_frame,
            refs=refs or None,
            steps=int(steps) if steps not in (None, "") else None,
            cfg=float(cfg) if cfg not in (None, "") else None,
            opts=(opts_out or None),
        )
    except Exception as exc:  # noqa: BLE001
        return _json({"ok": False, "error": str(exc)}, status=500)
    rel = os.path.relpath(path, base).replace(os.sep, "/")
    # graph_kind 回显实际走的构图分支，便于用户/日志确认"有没有串到多参考"
    graph_kind = "t2v_single" if mode not in ("i2v", "fl2v", "fl2v_tail", "r2v") else ("r2v_group" if mode == "r2v" else "i2v_group")
    return _json({"ok": True, "mode": mode, "graph_kind": graph_kind, "rel": rel,
                  "filename": os.path.basename(path),
                  "dropped": dropped,
                  "audio_note": audio_note,
                  "dialogues": [{"speaker": d.get("speaker") or "", "text": d.get("text") or ""}
                                for d in (_dialogs or [])],
                  "prompt_final": prompt[:2000]})


async def h3_prompt_preview(req):
    """POST /mrnext/h3/prompt_preview —— 不出片，只回显 H3 官方三段式组装后的提示词。

    body: {prompt, prefix?, seconds?, index?, opts?{av_structure,av_lang,av_ambience,
          av_music,av_no_speech}}
    用于导演台「预览提示词」按钮：让用户确认台词有没有被正确识别成 [Chinese] … 。
    """
    body = await req.json()
    text = _strip_virtual_refs(body.get("prompt"))
    prefix = _strip_virtual_refs(body.get("prefix"))
    try:
        sec = float(body.get("seconds") or 0)
    except (TypeError, ValueError):
        sec = 0.0
    try:
        idx = int(body.get("index") or body.get("shot_index") or 1)
    except (TypeError, ValueError):
        idx = 1
    o = body.get("opts") if isinstance(body.get("opts"), dict) else {}
    try:
        out, dialogs = h3pmod.assemble(text=text, prefix=prefix, opts=o,
                                       shot_no=idx, seconds=sec)
    except Exception as exc:  # noqa: BLE001
        return _json({"ok": False, "error": str(exc)}, status=500)
    return _json({"ok": True, "prompt": out,
                  "roles": h3pmod.extract_role_names(prefix),
                  "dialogues": [{"speaker": d.get("speaker") or "",
                                 "text": d.get("text") or ""} for d in dialogs]})


async def h3_dry(req):
    """仅构图+校验（不采样），用于构图调试。body 同 /h3/shot，另加 dry=变体名。"""
    import execution
    from server import PromptServer

    body = await req.json()
    mode = (body.get("mode") or "t2v").strip().lower()
    variant = (body.get("dry") or "").strip()
    prompt = (body.get("prompt") or "test prompt").strip()
    ff = (body.get("first_frame") or "").strip()
    lf = (body.get("last_frame") or "").strip()
    refs = body.get("refs") or []
    server = PromptServer.instance
    try:
        graph = h3mod.build_shot_graph(
            mode, prompt, seed=1, seconds=2.0, frame_rate=24.0,
            first_frame=ff or None, last_frame=lf or None,
            refs=[x for x in refs if x] or None,
            _variant=variant or None,
        )
    except Exception as exc:  # noqa: BLE001
        return _json({"ok": False, "build_error": str(exc)}, status=400)
    pid = "dry_" + str(int(time.time() * 1000))
    if variant == "dump":
        return _json(graph)
    try:
        server.node_replace_manager.apply_replacements(graph)
        valid = await execution.validate_prompt(pid, graph, None)
    except Exception as exc:  # noqa: BLE001
        return _json({"ok": False, "validate_exc": str(exc)}, status=400)
    return _json({"ok": bool(valid[0]),
                  "error": (str(valid[1]) if not valid[0] else "")[:400],
                  "node_errors": (valid[3] if len(valid) > 3 else {})})


async def h3_free_vram(req):
    """POST /mrnext/h3/free_vram —— 段间显存清理：soft_empty_cache + 清理无引用模型。
    连续逐镜出片时每隔 N 镜调用一次，避免显存碎片累积 OOM。保留当前已加载模型（不 unload，避免重载慢）。"""
    import comfy.model_management as mm
    try:
        mm.soft_empty_cache(force=True)
        mm.cleanup_models()
        import torch
        info = {}
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            info = {"free_gb": round(free / 1e9, 2), "total_gb": round(total / 1e9, 2)}
        return _json({"ok": True, **info})
    except Exception as exc:  # noqa: BLE001
        return _json({"ok": False, "error": str(exc)}, status=500)


# ---- 二采独立（SeedVR2 视频高清放大）----
_UPSCALE_TASKS = {}


def _resolve_media_path(rel):
    """把 rel（input 相对路径 / OUTPUT: 前缀）解析成绝对路径。"""
    if rel.startswith("OUTPUT:"):
        return _safe_join(folder_paths.get_output_directory(), rel[len("OUTPUT:"):])
    return _safe_join(_input_base(), rel)


def _probe_video_short_side(path):
    """用 ffprobe 读视频宽高，返回短边像素（失败返回 0）。
    用于把「放大倍率」换算成 SeedVR2 需要的目标短边（resolution）。"""
    exe = shutil.which("ffprobe")
    if not exe:
        pkg = os.path.dirname(folder_paths.get_input_directory())   # ComfyUI 根
        cand = os.path.join(os.path.dirname(pkg), "ffprobe", "ffprobe.exe")
        exe = cand if os.path.isfile(cand) else ""
    if not exe:
        return 0
    try:
        out = subprocess.run(
            [exe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
            capture_output=True, text=True, timeout=30).stdout.strip()
        w, h = out.split("x")[:2]
        return min(int(w), int(h))
    except Exception:  # noqa: BLE001
        return 0


def _vosr2_ready():
    """VOSR2 前置自检：(ok, 说明)。

    模型支持两种布局，任一完整即可：
      A. models/vosr2/VOSR2/...      （节点默认，自动下载的位置）
      B. models/vosr2/...            （手动下载时的扁平布局）
    这样在离线/代理故障环境下不会因为节点去连 HuggingFace 而卡住几十秒报错。
    """
    try:
        import folder_paths  # noqa: WPS433
        root = os.path.join(folder_paths.models_dir, "vosr2")
    except Exception:  # noqa: BLE001
        root = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "models", "vosr2")
    core = ["args.json",
            "checkpoints/ema_model.safetensors",
            "Qwen-Image-vae-2d/config.json",
            "Qwen-Image-vae-2d/diffusion_pytorch_model.safetensors"]

    def _complete(base):
        if not all(os.path.isfile(os.path.join(base, f)) for f in core):
            return False
        return any(os.path.isfile(os.path.join(base, n))
                   for n in ("dinov2_vitl14.safetensors", "dinov2_vitl14_pretrain.pth"))

    for base in (os.path.join(root, "VOSR2"), root):
        if _complete(base):
            try:
                from nodes import NODE_CLASS_MAPPINGS as _NCM  # noqa: WPS433
            except Exception:  # noqa: BLE001
                _NCM = {}
            if _NCM and "VOSR2ModelLoader" not in _NCM:
                return False, ("VOSR2 模型已就位，但 ComfyUI-VOSR2 节点未加载，请重启 ComfyUI 后再试。")
            return True, ""
    return False, (
        "VOSR2 模型文件不完整。请放到 {} 或 {} 下，需要：{}；"
        "DINOv2 可以是 dinov2_vitl14.safetensors 或 dinov2_vitl14_pretrain.pth。".format(
            os.path.join(root, "VOSR2"), root, "、".join(core)))


async def h3_upscale_video(req):
    """POST /mrnext/h3/upscale_video —— 二采独立：对已出片视频做高清放大。
    body: {rel, engine?: seedvr2|rtx|flash, resolution?, scale?}
      seedvr2 → 后台 SeedVR2 CLI（高质量慢速），返回 task_id
      rtx     → RTX Video Super Resolution（N 卡硬件，最快），同步返回 ok+rel
      flash   → FlashVSR（需模型，未下载时返回提示）"""
    body = await req.json()
    rel = (body.get("rel") or "").strip()
    engine = (body.get("engine") or body.get("type") or "seedvr2").strip().lower()
    if not rel:
        return _json({"ok": False, "error": "缺少 rel"}, status=400)
    try:
        src = _resolve_media_path(rel)
    except ValueError:
        return _json({"ok": False, "error": "路径越界"}, status=400)
    if not os.path.isfile(src):
        return _json({"ok": False, "error": "视频不存在: " + rel}, status=404)

    if engine == "flash":
        # TE-Speed-FlashVSR 超分（后台队列，同步返回）
        if rel.startswith("OUTPUT:"):
            return _json({"ok": False, "error": "TE-FlashVSR 暂仅支持前端出片(input目录)视频"}, status=400)
        try:
            scale = int(round(float(body.get("scale") or 2)))
        except (TypeError, ValueError):
            scale = 2
        scale = max(1, min(4, scale))
        out_dir = (body.get("out_dir") or "").strip()
        try:
            if not out_dir:
                out_dir = os.path.dirname(src)
            path = await h3mod.run_flash_upscale(rel, out_dir, scale=scale)
        except Exception as exc:  # noqa: BLE001
            return _json({"ok": False, "error": str(exc)}, status=500)
        out_rel = os.path.relpath(path, _input_base()).replace(os.sep, "/")
        return _json({"ok": True, "rel": out_rel, "engine": "flash", "path": path})

    if engine == "vosr2":
        # VOSR 2.0 超分（H3 二采平替，一步扩散，比 SeedVR2 快且省显存；需 ComfyUI-VOSR2 节点）
        if rel.startswith("OUTPUT:"):
            return _json({"ok": False, "error": "VOSR2 暂仅支持前端出片(input目录)视频"}, status=400)
        try:
            scale = int(round(float(body.get("scale") or 2)))  # VOSR2 整数倍（4090 16G 下 4 倍易吃满显存）
        except (TypeError, ValueError):
            scale = 2
        scale = max(1, min(4, scale))
        seed = int(body.get("seed") or 0)
        ok, why = _vosr2_ready()
        if not ok:
            return _json({"ok": False, "error": why}, status=500)
        out_dir = (body.get("out_dir") or "").strip()
        try:
            if not out_dir:
                out_dir = os.path.dirname(src)
            path = await h3mod.run_vosr2_upscale(rel, out_dir, scale=scale, seed=seed)
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            if "VOSR2Upscale" in msg or "VOSR2ModelLoader" in msg:
                msg = "VOSR2 节点未加载（检查 custom_nodes/ComfyUI-VOSR2 是否安装并重启 ComfyUI）: " + msg
            return _json({"ok": False, "error": msg}, status=500)
        out_rel = os.path.relpath(path, _input_base()).replace(os.sep, "/")
        return _json({"ok": True, "rel": out_rel, "engine": "vosr2", "path": path})

    # 输出目录：用户可选（前端弹文件夹选择）；为空则输出到源视频同目录
    out_dir = (body.get("out_dir") or "").strip()
    if out_dir:
        try:
            os.makedirs(out_dir, exist_ok=True)
            out_base_dir = os.path.normpath(out_dir)
        except Exception:  # noqa: BLE001
            return _json({"ok": False, "error": "输出目录无效: " + out_dir}, status=400)
    else:
        out_base_dir = os.path.dirname(src)

    if engine == "rtx":
        # RTX VSR 用独立脚本（nvvfx 直调，绕 DynamicCombo），后台执行 + task_id
        try:
            scale = float(body.get("scale") or 2.0)
        except (TypeError, ValueError):
            scale = 2.0
        scale = max(1.0, min(4.0, scale))
        quality = str(body.get("quality") or "HIGH")
        task_id = str(uuid.uuid4())[:8]
        stem = os.path.splitext(os.path.basename(src))[0]
        out_path = os.path.join(out_base_dir, stem + "_rtx_%dx.mp4" % int(scale))
        _UPSCALE_TASKS[task_id] = {"status": "running", "rel": rel}
        pkg = os.path.dirname(folder_paths.get_input_directory())
        py = os.path.join(os.path.dirname(pkg), "python_embeded", "python.exe")
        if not os.path.isfile(py):
            py = sys.executable
        script = os.path.join(os.path.dirname(pkg), "Temp", "mmx", "rtx_upscale.py")

        def _rtx_run():
            try:
                cmd = [py, script, src, out_path, str(scale), quality]
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
                if proc.returncode != 0 or not os.path.isfile(out_path):
                    _UPSCALE_TASKS[task_id] = {"status": "error",
                                               "error": (proc.stderr or proc.stdout or "无输出")[-400:]}
                    return
                base = _input_base() if not rel.startswith("OUTPUT:") else folder_paths.get_output_directory()
                out_rel = os.path.relpath(out_path, base).replace(os.sep, "/")
                if rel.startswith("OUTPUT:"):
                    out_rel = "OUTPUT:" + out_rel
                _UPSCALE_TASKS[task_id] = {"status": "done", "rel": out_rel, "path": out_path}
            except Exception as exc:  # noqa: BLE001
                _UPSCALE_TASKS[task_id] = {"status": "error", "error": str(exc)[:400]}

        threading.Thread(target=_rtx_run, daemon=True).start()
        return _json({"ok": True, "task_id": task_id})

    # 默认 seedvr2（后台 CLI）
    # 倍率优先：目标短边 = 源视频短边 × 倍率（读不到尺寸时退回 resolution 参数/1080）
    try:
        _sc = float(body.get("scale") or 0)
    except (TypeError, ValueError):
        _sc = 0.0
    _sc = max(1.0, min(4.0, _sc))
    resolution = int(body.get("resolution") or 1080)
    if _sc > 0:
        _short = _probe_video_short_side(src)
        if _short:
            resolution = max(512, min(2560, (int(round(_short * _sc)) // 2) * 2))
    task_id = str(uuid.uuid4())[:8]
    stem = os.path.splitext(os.path.basename(src))[0]
    out_path = os.path.join(out_base_dir, stem + "_seedvr2_%dp.mp4" % resolution)
    _UPSCALE_TASKS[task_id] = {"status": "running", "rel": rel}

    pkg = os.path.dirname(folder_paths.get_input_directory())  # ComfyUI 根
    cli_dir = os.path.join(pkg, "custom_nodes", "ComfyUI-SeedVR2_VideoUpscaler")
    cli = os.path.join(cli_dir, "inference_cli.py")
    py = os.path.join(os.path.dirname(pkg), "python_embeded", "python.exe")  # 便携包解释器
    if not os.path.isfile(py):
        py = sys.executable if hasattr(sys, "executable") else "python"
    model_dir = os.path.join(pkg, "models", "SEEDVR2")

    def _run():
        try:
            cmd = [py, cli, src, "--output", out_path, "--output_format", "mp4",
                   "--model_dir", model_dir, "--resolution", str(resolution),
                   "--color_correction", "lab", "--video_backend", "ffmpeg"]
            proc = subprocess.run(cmd, cwd=cli_dir, capture_output=True, text=True, timeout=3600)
            if proc.returncode != 0 or not os.path.isfile(out_path):
                _UPSCALE_TASKS[task_id] = {"status": "error",
                                           "error": (proc.stderr or proc.stdout or "无输出")[-500:]}
                return
            base = _input_base() if not rel.startswith("OUTPUT:") else folder_paths.get_output_directory()
            out_rel = os.path.relpath(out_path, base).replace(os.sep, "/")
            if rel.startswith("OUTPUT:"):
                out_rel = "OUTPUT:" + out_rel
            _UPSCALE_TASKS[task_id] = {"status": "done", "rel": out_rel, "path": out_path}
        except Exception as exc:  # noqa: BLE001
            _UPSCALE_TASKS[task_id] = {"status": "error", "error": str(exc)[:400]}

    threading.Thread(target=_run, daemon=True).start()
    return _json({"ok": True, "task_id": task_id})


async def h3_upscale_status(req):
    """GET /mrnext/h3/upscale_status?task_id= → 二采进度。"""
    task_id = (req.query.get("task_id") or "").strip()
    t = _UPSCALE_TASKS.get(task_id)
    if not t:
        return _json({"status": "not_found"})
    return _json(t)


async def editor_delete_materials(req):
    """POST /mrnext/editor/delete_materials —— 删除剪辑素材（支持 folder/video/、folder/audio、OUTPUT:video/）。
    body: {rels: ["mrboard_next/video/xxx.mp4", "OUTPUT:video/yyy.mp4", ...]}"""
    body = await req.json()
    rels = [str(x).strip() for x in (body.get("rels") or []) if str(x).strip()]
    if not rels:
        return _json({"error": "未选择素材"}, status=400)
    in_base = _input_base()
    removed = []
    for rel in rels:
        try:
            if rel.startswith("OUTPUT:"):
                full = _safe_join(folder_paths.get_output_directory(), rel[len("OUTPUT:"):])
            else:
                # 输入相对路径（含 video/、audio/ 子目录）
                full = _safe_join(in_base, rel)
        except ValueError:
            continue
        if not os.path.isfile(full):
            continue
        try:
            os.remove(full)
            removed.append(rel)
        except Exception:  # noqa: BLE001
            pass
    _purge_thumb_cache(removed)
    return _json({"removed": removed, "count": len(removed)})


async def timeline_clear_cache(req):
    """POST /mrnext/timeline/clear_cache —— 时间线「🗑 清空」时顺带清掉会影响后续生成的缓存。

    body: {folder}
    清理三类残留（都是纯缓存/派生数据，删掉只影响显示，不影响已产出视频）：
      1) output/mrnext_preview/*.jpg —— 采样实时预览图缓存。残留会让下一次生成在写出首张
         预览前误显示上一轮的旧帧（用户会以为"还在用以前的参考图"）。
      2) input/{folder}/_plan.json → 归档为 _plan.prev.json —— 残留会让 MRBoardStudio.execute()
         认为还有分镜计划，从而重跑旧计划、干扰新的生成。
      3) output/mrnext_thumbs/*.jpg —— 素材缩略图缓存。源文件变了但缓存还在时会显示旧图。
    """
    try:
        body = await req.json()
    except Exception:  # noqa: BLE001
        body = {}
    folder = (body.get("folder") or "").strip().strip("/\\").replace("\\", "/")
    out_dir = folder_paths.get_output_directory()

    # 1) 采样预览图缓存
    previews = 0
    try:
        import glob as _glob
        for f in _glob.glob(os.path.join(out_dir, "mrnext_preview", "*.jpg")):
            try:
                os.remove(f)
                previews += 1
            except Exception:  # noqa: BLE001
                pass
        # 内存里的 pid→预览图映射也清掉（否则仍会按旧 pid 命中已删除文件）
        try:
            h3mod._LATEST_PREVIEW.clear()
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        pass

    # 2) 旧分镜计划：归档而不是删除（万一还要查）
    plan_state = "none"
    if folder:
        try:
            base = _input_base()
            plan = _safe_join(base, folder + "/_plan.json")
            if os.path.isfile(plan):
                prev = _safe_join(base, folder + "/_plan.prev.json")
                try:
                    if os.path.isfile(prev):
                        os.remove(prev)
                    os.replace(plan, prev)
                    plan_state = "archived"
                except Exception:  # noqa: BLE001
                    # 极端情况（文件被占用）退化成清空内容，同样达到"不再触发旧计划"的目的
                    with open(plan, "w", encoding="utf-8") as fh:
                        fh.write('{"shots": []}')
                    plan_state = "emptied"
        except (ValueError, OSError):
            plan_state = "skip"

    # 3) 缩略图缓存（纯派生，按需重建）
    thumbs = 0
    try:
        import glob as _glob2
        for f in _glob2.glob(os.path.join(out_dir, "mrnext_thumbs", "*.jpg")):
            try:
                os.remove(f)
                thumbs += 1
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass

    return _json({"ok": True, "previews": previews, "plan": plan_state, "thumbs": thumbs})


async def h3_preview_latest(req):
    """GET /mrnext/h3/preview_latest —— 返回采样过程中最新 preview 图（生成中实时预览）。

    ?pid=xxx   只取该任务的预览图（生图/出片互不干扰）
    ?since=sec 只认 mtime >= since（epoch 秒）的预览图 —— 前端在出片开始时带上本次时间戳，
               这样上一轮 / 别的模式留在目录里的旧预览图绝不会被当成"本次实时预览"显示。
    """
    import glob as _glob
    try:
        d = os.path.join(folder_paths.get_output_directory(), "mrnext_preview")
        pid = (req.query.get("pid") or "").strip()
        try:
            since = float(req.query.get("since") or 0)
        except (TypeError, ValueError):
            since = 0.0

        def _fresh(p):
            if since <= 0:
                return True
            try:
                return os.path.getmtime(p) >= since
            except OSError:
                return False

        if pid:
            p = os.path.join(d, "latest_%s.jpg" % pid)
            if not os.path.isfile(p) or not _fresh(p):
                return _json({"ok": False, "error": "无预览"}, status=404)
            return web.FileResponse(p, headers={"Cache-Control": "no-store"})
        fs = [f for f in _glob.glob(os.path.join(d, "latest_*.jpg")) if _fresh(f)]
        fs.sort(key=os.path.getmtime)
        if not fs:
            return _json({"ok": False, "error": "无预览"}, status=404)
        return web.FileResponse(fs[-1], headers={"Cache-Control": "no-store"})
    except Exception as exc:  # noqa: BLE001
        return _json({"ok": False, "error": str(exc)}, status=500)


async def media_exists(req):
    """POST /mrnext/media/exists —— 批量校验素材 rel 是否仍存在于磁盘。

    body: {rels: [...]} → {ok, missing: [...]}
    素材被清理后前端缓存（九宫格 / refMap / 视频槽）里可能还留着 rel，生成前用它
    把这些「幽灵素材」剔掉，避免旧图继续参与其它模式的适配生成。
    """
    try:
        body = await req.json()
    except Exception:  # noqa: BLE001
        body = {}
    rels = [str(x or "").strip().replace("\\", "/") for x in (body.get("rels") or [])]
    missing = []
    for r in rels:
        if not r:
            continue
        try:
            full = _resolve_media_path(r)
        except (ValueError, OSError):
            missing.append(r); continue
        if not os.path.isfile(full):
            missing.append(r)
    return _json({"ok": True, "missing": missing})


async def editor_thumb(req):
    """GET /mrnext/editor/thumb?rel= → 视频首帧缩略图（jpg，缓存到 output/mrnext_thumbs/）。
    支持 OUTPUT: 前缀（节点 Queue 出片在 output/video 的视频）。"""
    rel = (req.query.get("rel") or "").strip()
    if rel.startswith("OUTPUT:"):
        base = folder_paths.get_output_directory()
        sub = rel[len("OUTPUT:"):]
    else:
        base = _input_base()
        sub = rel
    try:
        full = _safe_join(base, sub)
    except ValueError:
        return _json({"error": "越界"}, status=400)
    if not os.path.isfile(full):
        # 源视频已被清理：同步删掉它的缩略图缓存，避免旧图继续显示 / 被当素材用
        try:
            import hashlib as _h2
            _d = os.path.join(folder_paths.get_output_directory(), "mrnext_thumbs")
            _p = os.path.join(_d, _h2.md5(rel.encode("utf-8")).hexdigest()[:16] + ".jpg")
            if os.path.isfile(_p):
                os.remove(_p)
        except Exception:  # noqa: BLE001
            pass
        return _json({"error": "文件不存在"}, status=404)
    exe = _ffmpeg_exe()
    if not exe:
        return _json({"error": "无 ffmpeg"}, status=500)
    import hashlib as _hash

    key = _hash.md5(rel.encode("utf-8")).hexdigest()[:16]
    out_dir = os.path.join(folder_paths.get_output_directory(), "mrnext_thumbs")
    os.makedirs(out_dir, exist_ok=True)
    thumb = os.path.join(out_dir, key + ".jpg")
    # 缓存失效：缩略图不存在、视频文件比缩略图新，或超过 24 小时 → 重抽
    # 视频被同名覆盖时 mtime 必然大于旧缩略图 mtime，自动触发重抽，避免「缩略图和视频内容不一致」
    stale = (not os.path.isfile(thumb)
             or os.path.getmtime(full) > os.path.getmtime(thumb)
             or abs(time.time() - os.path.getmtime(thumb)) > 86400)
    if stale:
        try:
            proc = subprocess.run(
                [exe, "-y", "-ss", "0.15", "-i", full, "-frames:v", "1",
                 "-vf", "scale=-2:180", "-q:v", "6", thumb],
                capture_output=True, text=True, timeout=120)
            if proc.returncode != 0 or not os.path.isfile(thumb):
                return _json({"error": "抽帧失败"}, status=500)
        except Exception as exc:  # noqa: BLE001
            return _json({"error": str(exc)}, status=500)
    return web.FileResponse(thumb, headers={"Cache-Control": "public, max-age=3600"})


def _clip_note(name):
    """给 Qwen3-VL 文本编码器一句「看得懂」的选型说明。

    量化越狠，文本语义损失越大 —— H3 是 cfg=1.0（无负引导）模型，提示词全靠这份
    embedding，所以 CLIP 一打折，症状就是「画面不按提示词走」。
    """
    n = str(name or "").lower()
    if "nvfp4" in n or "fp4" in n or "awq" in n:
        return "⚠ 4bit 量化：省内存，但语义会打折 —— 画面容易不按提示词走"
    if "int8" in n or "int4" in n:
        return "✓ int8：保真度最高、最贴合提示词（载入约需 30G 内存，慢一点）"
    if "fp8" in n:
        return "○ fp8：画质/内存折中"
    return ""


async def editor_options(req):
    """GET /mrnext/editor/options —— 导演台编辑器下拉选项（从本机模型目录枚举）。
    Query:
      enabled=1/0 —— 1 返回 LoRA 列表（默认）；0 时 loras 为 []
      extra=<path> —— 额外 LoRA 文件夹（绝对路径/相对 models），与默认合并去重
    """
    enabled = (req.query.get("enabled") or "1").strip() not in ("0", "false", "")
    extra   = (req.query.get("extra")   or "").strip()
    def list1(folder):
        try: return folder_paths.get_filename_list(folder)
        except Exception: return []
    unets = [n for n in list1("diffusion_models") if "krea2" in n.lower() or "fl2va" in n.lower() or "ref2va" in n.lower() or "minimax" in n.lower()]
    if not unets: unets = list1("unet")
    clips  = [n for n in list1("text_encoders") if "minimax" in n.lower() or "qwen" in n.lower()]
    if not clips: clips = list1("clip")
    vvaes  = [n for n in list1("vae") if any(k in n.lower() for k in ("video", "krea2", "minimax"))]
    avaes  = [n for n in list1("vae") if "audio" in n.lower() or "minimax" in n.lower()]
    if not avaes: avaes = [n for n in list1("vae") if "audio" in n.lower()]
    base_loras   = list1("loras")  # 默认 LoRA（ComfyUI 内置 loras 目录）
    custom_loras = list_loras(extra_path=extra) if (enabled and extra) else []
    # 合并去重（默认在前、自定义在后）
    seen = set()
    loras = []
    for n in (base_loras if enabled else []) + custom_loras:
        k = str(n).strip()
        if not k or k in seen: continue
        seen.add(k); loras.append(k)
    def _pick(lst, keys):
        for k in keys:
            for n in lst:
                if k in n.lower():
                    return n
        return lst[0] if lst else ""

    # 推荐默认模型（本机实际存在的官方模板组合，打开即用）
    # CLIP 优先挑 int8：nvfp4/fp4 这类 4bit 量化虽然省内存，但语义会打折，
    # 表现就是「画面不按提示词走」——默认不给它。
    defaults = {
        "unet": _pick(unets, ["fl2va_pruned_int8", "fl2va", "ref2va_pruned_int8", "ref2va"]),
        "clip": _pick(clips, ["qwen3vl_32b_minimax_h3_int8", "qwen3vl_32b_int8", "qwen3vl_32b", "qwen3vl"]),
        "video_vae": _pick(vvaes, ["video_vae_fp16", "video"]),
        "audio_vae": _pick(avaes, ["audio_vae_fp32", "audio"]),
    }
    clip_notes = {n: _clip_note(n) for n in clips}
    return _json({
        "unets": unets[:200], "clips": clips[:200], "videoVaes": vvaes[:200], "audioVaes": avaes[:200],
        "loras": loras[:200], "clipNotes": clip_notes,
        "loraEnabled": enabled,
        "loraExtra": extra,
        "defaults": defaults,
        "aspects": [
            # 官方 MiniMax H3 分辨率档位（短边 768，multiple=32，megapixel 对齐）
            # 16:9 横版（480×270 → 1920×1088）
            {"v": "480:270", "label": "480×270 横版 16:9 · 0.13MP", "w": 480, "h": 270},
            {"v": "736:416", "label": "736×416 横版 16:9 · 0.31MP", "w": 736, "h": 416},
            {"v": "864:480", "label": "864×480 横版 16:9 · 0.4MP", "w": 864, "h": 480},
            {"v": "1056:608", "label": "1056×608 横版 16:9 · 0.6MP", "w": 1056, "h": 608},
            {"v": "1184:672", "label": "1184×672 横版 16:9 · 0.8MP", "w": 1184, "h": 672},
            {"v": "1344:768", "label": "1344×768 横版 16:9 · 0.98MP", "w": 1344, "h": 768},
            {"v": "1376:768", "label": "1376×768 横版 16:9 · 1.0MP", "w": 1376, "h": 768},
            {"v": "1440:816", "label": "1440×816 横版 16:9 · 1.1MP", "w": 1440, "h": 816},
            {"v": "1696:960", "label": "1696×960 横版 16:9 · 1.6MP", "w": 1696, "h": 960},
            {"v": "1920:1088", "label": "1920×1088 横版 16:9 · 2.0MP", "w": 1920, "h": 1088},
            # 9:16 竖版
            {"v": "270:480", "label": "270×480 竖版 9:16 · 0.13MP", "w": 270, "h": 480},
            {"v": "416:736", "label": "416×736 竖版 9:16 · 0.31MP", "w": 416, "h": 736},
            {"v": "480:864", "label": "480×864 竖版 9:16 · 0.4MP", "w": 480, "h": 864},
            {"v": "608:1056", "label": "608×1056 竖版 9:16 · 0.6MP", "w": 608, "h": 1056},
            {"v": "672:1184", "label": "672×1184 竖版 9:16 · 0.8MP", "w": 672, "h": 1184},
            {"v": "768:1344", "label": "768×1344 竖版 9:16 · 0.98MP", "w": 768, "h": 1344},
            {"v": "768:1376", "label": "768×1376 竖版 9:16 · 1.0MP", "w": 768, "h": 1376},
            {"v": "816:1440", "label": "816×1440 竖版 9:16 · 1.2MP", "w": 816, "h": 1440},
            {"v": "928:1664", "label": "928×1664 竖版 9:16 · 1.5MP", "w": 928, "h": 1664},
            {"v": "960:1696", "label": "960×1696 竖版 9:16 · 1.6MP", "w": 960, "h": 1696},
            {"v": "1088:1920", "label": "1088×1920 竖版 9:16 · 2.0MP", "w": 1088, "h": 1920},
            # 1:1 方形
            {"v": "480:480", "label": "480×480 方形 1:1 · 0.23MP", "w": 480, "h": 480},
            {"v": "720:720", "label": "720×720 方形 1:1 · 0.52MP", "w": 720, "h": 720},
            {"v": "768:768", "label": "768×768 方形 1:1 · 0.59MP", "w": 768, "h": 768},
            {"v": "960:960", "label": "960×960 方形 1:1 · 0.92MP", "w": 960, "h": 960},
            {"v": "1280:1280", "label": "1280×1280 方形 1:1 · 1.64MP", "w": 1280, "h": 1280},
            # 4:3 / 3:4
            {"v": "1024:768", "label": "1024×768 横版 4:3 · 0.79MP", "w": 1024, "h": 768},
            {"v": "768:1024", "label": "768×1024 竖版 3:4 · 0.79MP", "w": 768, "h": 1024},
            {"v": "1152:864", "label": "1152×864 横版 4:3 · 1.0MP", "w": 1152, "h": 864},
            # 21:9 超宽
            {"v": "896:384", "label": "896×384 超宽 21:9 · 0.34MP", "w": 896, "h": 384},
            {"v": "1344:576", "label": "1344×576 超宽 21:9 · 0.77MP", "w": 1344, "h": 576},
            {"v": "1920:832", "label": "1920×832 超宽 21:9 · 1.6MP", "w": 1920, "h": 832},
        ],
        "refSizes": [512, 576, 736, 864, 1024],
        "framerates": [24],
        "segLengths": [2, 3, 4, 5, 6, 8, 10, 15],
        "overlapFrames": [5, 9, 22, 39, 56],
        "steps": [8, 12, 15, 20, 25, 30, 40],
        "samplers": ["euler", "res_multistep", "euler_cfg", "uni_pc"],
        "schedulers": ["simple", "normal", "karras", "exponential"],
        "betas": [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 5.0],
        "shiftVideo": [0.0, 1.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 16.0],
        "shiftAudio": [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
    })


async def studio_delete_files(req):
    """删除素材文件夹内选中的文件（仅限目标文件夹内，防止越界）。"""
    body = await req.json()
    folder = (body.get("folder") or "").strip()
    names = [str(x).strip() for x in (body.get("names") or []) if str(x).strip()]
    if not names:
        return _json({"error": "未选择文件"}, status=400)
    base = _input_base()
    root = _safe_join(base, folder) if folder else base
    removed = []
    for name in names:
        if "/" in name or "\\" in name or name in (".", ".."):
            continue
        full = os.path.join(root, name)
        if not os.path.isfile(full):
            continue
        try:
            os.remove(full)
            removed.append(name)
        except Exception as exc:  # noqa: BLE001
            return _json({"error": f"删除 {name} 失败: {exc}"}, status=500)
    # 清掉被删文件的缩略图缓存（rel = folder/name）
    _purge_thumb_cache([(folder + "/" + n) if folder else n for n in removed])
    return _json({"removed": removed, "count": len(removed)})


async def studio_clear_folder(req):
    """POST /mrnext/studio/clear_folder —— 清空素材文件夹所有媒体文件（图片+视频+音频，含 folder/video 子目录）。"""
    body = await req.json()
    folder = (body.get("folder") or "").strip()
    base = _input_base()
    targets = []
    if folder:
        targets.append(_safe_join(base, folder))
        targets.append(_safe_join(base, folder + "/video"))
    removed = 0
    for d in targets:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            full = os.path.join(d, name)
            if os.path.isfile(full) and _kind_of(name) in ("image", "video", "audio"):
                try:
                    os.remove(full)
                    removed += 1
                except Exception:  # noqa: BLE001
                    pass
    # 清空文件夹后，缩略图缓存整体作废 → 直接清空缓存目录
    thumb_dir = os.path.join(folder_paths.get_output_directory(), "mrnext_thumbs")
    if os.path.isdir(thumb_dir):
        for name in os.listdir(thumb_dir):
            if name.endswith(".jpg"):
                try: os.remove(os.path.join(thumb_dir, name))
                except Exception: pass
    return _json({"ok": True, "count": removed})


async def editor_clear_materials(req):
    """清空剪辑素材：folder/video（前端出片视频）+ folder 根目录音频 + output/video（节点出片视频）。
    只删视频/音频，不动图片。"""
    body = await req.json()
    folder = (body.get("folder") or "").strip()
    base = _input_base()
    targets = []
    if folder:
        targets.append(_safe_join(base, folder + "/video"))
        targets.append(_safe_join(base, folder))
    try:
        targets.append(os.path.join(folder_paths.get_output_directory(), "video"))
    except Exception:  # noqa: BLE001
        pass
    removed = 0
    for d in targets:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            full = os.path.join(d, name)
            if not os.path.isfile(full):
                continue
            # folder 根目录只删音频；子目录只删对应类型
            if _kind_of(name) not in ("video", "audio"):
                continue
            try:
                os.remove(full)
                removed += 1
            except Exception:  # noqa: BLE001
                pass
    return _json({"ok": True, "count": removed})


async def editor_dedupe(req):
    """POST /mrnext/editor/dedupe —— 删除剪辑素材区中内容重复的视频/音频（按文件内容 md5）。
    body: {folder} —— 同时扫 input/{folder}/video、input/{folder} 根目录、output/video 三个位置。
    同 md5 保留按文件名排序后的第一个，其余删除。"""
    import hashlib as _hash_mod

    body = await req.json()
    folder = (body.get("folder") or "").strip()
    base = _input_base()
    scan_dirs = []  # [(abs_dir, is_input)]
    if folder:
        try:
            scan_dirs.append((_safe_join(base, folder + "/video"), True))
            scan_dirs.append((_safe_join(base, folder), True))
        except ValueError:
            pass
    try:
        scan_dirs.append((os.path.join(folder_paths.get_output_directory(), "video"), False))
    except Exception:  # noqa: BLE001
        pass

    # 按内容 md5 分组（分块读，友好大文件）
    hash_to_files = {}
    for d, is_input in scan_dirs:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            full = os.path.join(d, name)
            if not os.path.isfile(full):
                continue
            if _kind_of(name) not in ("video", "audio"):
                continue
            try:
                mdh = _hash_mod.md5()
                with open(full, "rb") as f:
                    while True:
                        chunk = f.read(131072)
                        if not chunk:
                            break
                        mdh.update(chunk)
                hex_digest = mdh.hexdigest()
            except Exception:  # noqa: BLE001
                continue
            hash_to_files.setdefault(hex_digest, []).append((full, is_input, name))

    removed = 0
    removed_names = []
    kept_count = 0
    total_scanned = 0
    for files in hash_to_files.values():
        if not files:
            continue
        total_scanned += len(files)
        kept_count += 1
        for full, _is_input, name in files[1:]:
            try:
                os.remove(full)
                removed += 1
                removed_names.append(name)
            except Exception:  # noqa: BLE001
                pass

    return _json({
        "ok": True,
        "scanned": total_scanned,
        "kept": kept_count,
        "removed": removed,
        "removed_names": removed_names,
        "note": f"扫描 {total_scanned} 个 · 保留 {kept_count} · 删除 {removed} 个重复",
    })


# ---------- 路由表 ----------

ROUTES = [
    ("GET", "/mrnext/studio/files", studio_files),
    ("GET", "/mrnext/studio/browse", studio_browse),
    ("POST", "/mrnext/studio/upload", studio_upload),
    ("POST", "/mrnext/studio/import", studio_import),
    ("POST", "/mrnext/studio/rename", studio_rename),
    ("POST", "/mrnext/studio/split", studio_split),
    ("POST", "/mrnext/studio/extract_defs", studio_extract_defs),
    ("POST", "/mrnext/studio/asset_plan", studio_asset_plan),
    ("POST", "/mrnext/studio/save_plan", studio_save_plan),
    ("GET", "/mrnext/assetgen/models", assetgen_models),
    ("GET", "/mrnext/assetgen/config", assetgen_config),
    ("POST", "/mrnext/assetgen/generate", assetgen_generate),
    ("POST", "/mrnext/assetgen/enhance", assetgen_enhance),
    ("GET", "/mrnext/assetgen/seedvr2_status", assetgen_seedvr2_status),
    ("GET", "/mrnext/assetgen/vosr2_status", assetgen_vosr2_status),
    ("GET", "/mrnext/editor/videos", editor_videos),
    ("GET", "/mrnext/editor/probe", editor_probe),
    ("POST", "/mrnext/media/exists", media_exists),
    ("GET", "/mrnext/editor/thumb", editor_thumb),
    ("GET", "/mrnext/editor/options", editor_options),
    ("POST", "/mrnext/editor/compose", editor_compose),
    ("GET", "/mrnext/skills/scan", skills_scan),
    ("GET", "/mrnext/skills/read", skills_read),
    ("GET", "/mrnext/skills/status", skills_status),
    ("GET", "/mrnext/skills/models", skills_models),
    ("GET", "/mrnext/skills/recommend", skills_recommend),
    ("POST", "/mrnext/skills/load_model", skills_load_model),
    ("POST", "/mrnext/skills/unload", skills_unload),
    ("POST", "/mrnext/skills/optimize", skills_optimize),
    ("GET", "/mrnext/favorites", favorites_list),
    ("POST", "/mrnext/favorites/add", favorites_add),
    ("POST", "/mrnext/favorites/remove", favorites_remove),
    ("POST", "/mrnext/studio/adapt_longdoc", longdoc_adapt),
    ("POST", "/mrnext/studio/sanitize_workflow", studio_sanitize),
    ("POST", "/mrnext/studio/export", studio_export),
    ("GET", "/mrnext/studio/paths", studio_paths),
    ("POST", "/mrnext/studio/native_pick", studio_native_pick),
    ("POST", "/mrnext/studio/read_text_file", studio_read_text_file),
    ("POST", "/mrnext/studio/import_folder", studio_import_folder),
    ("POST", "/mrnext/studio/analyze", studio_analyze),
    ("POST", "/mrnext/studio/delete_files", studio_delete_files),
    ("POST", "/mrnext/studio/clear_folder", studio_clear_folder),
    ("POST", "/mrnext/editor/clear_materials", editor_clear_materials),
    ("POST", "/mrnext/editor/dedupe", editor_dedupe),
    ("POST", "/mrnext/editor/delete_materials", editor_delete_materials),
    ("POST", "/mrnext/h3/shot", h3_shot),
    ("POST", "/mrnext/h3/prompt_preview", h3_prompt_preview),
    ("POST", "/mrnext/h3/dry", h3_dry),
    ("POST", "/mrnext/h3/free_vram", h3_free_vram),
    ("POST", "/mrnext/h3/upscale_video", h3_upscale_video),
    ("GET", "/mrnext/h3/upscale_status", h3_upscale_status),
    ("GET", "/mrnext/h3/preview_latest", h3_preview_latest),
    ("POST", "/mrnext/timeline/clear_cache", timeline_clear_cache),
]
