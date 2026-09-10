"""剧本工作台（原「分镜一体机」）HTTP 路由，已从 ComfyUI_XiantuH3Storyboard 迁入。

这些路由被导演台侧边抽屉（📖 剧本工作台）调用：
  GET  /xiantu/studio/files     列出资产文件夹内图片/音频/视频
  GET  /xiantu/studio/browse    目录导航（盘符 / 子目录 / 父目录）
  POST /xiantu/studio/upload    上传素材到资产文件夹
  POST /xiantu/studio/export    导出分镜提示词 txt
  POST /xiantu/studio/split     切分剧本 + 严格按 <Picture/Video/Audio N> 匹配素材
  POST /xiantu/studio/analyze   按文件名关键词分析每个分镜应插入的引用标记

路径与旧版保持一致，前端无需改动。所有配置（剧本/前缀/资产文件夹/引用）
现在由导演台节点的「剧本工作台」widget 承载，不再是独立节点。
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import string

import folder_paths
from aiohttp import web
from server import PromptServer

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.studio")

_ROUTES_REGISTERED = False


# ---------------- 剧本切分 / 引用解析 ----------------

def split_script(script, prefix, mode, strip_marker):
    """按选定方式把整集剧本切分为每镜文本，公共前缀拼在开头。"""
    text = (script or "").replace("\r\n", "\n").strip()
    if not text:
        return []
    if mode == "【镜头N】标记":
        parts = re.split(r"(?=【\s*镜头\s*\d+\s*】)", text)
        parts = [p for p in parts if p.strip()]
        out = []
        for p in parts:
            if strip_marker:
                p = re.sub(r"^【\s*镜头\s*\d+\s*】\s*", "", p)
            out.append(p.strip())
    elif mode == "---分隔线":
        out = [p.strip() for p in re.split(r"^\s*-{3,}\s*$", text, flags=re.M) if p.strip()]
        if strip_marker:
            out = [re.sub(r"^\[?\s*镜头\s*\d+\s*\]?\s*", "", p) for p in out]
    else:  # 空行分段
        out = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        if strip_marker:
            out = [re.sub(r"^\[?\s*镜头\s*\d+\s*\]?\s*", "", p) for p in out]
    if prefix.strip():
        out = [prefix.strip() + "\n" + p for p in out]
    return out


def parse_ref_mapping(text, files):
    """解析 'N=文件名' 行；无序号的行按出现顺序自动编号（从 1 开始）。"""
    mapping = {}
    auto = 0
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            try:
                idx = int(k.strip())
            except ValueError:
                continue
            name = v.strip()
        else:
            auto += 1
            idx = auto
            name = line
        if name and idx >= 1:
            mapping[idx] = name
    return mapping


# ---------------- 资产文件夹解析 ----------------

def _resolve_base(folder):
    """把资产文件夹解析成绝对目录：相对路径（含 '.'）→ input 子目录；绝对路径 → 原样。"""
    root = folder_paths.get_input_directory()
    f = (folder or ".").strip().strip('"').strip("'")
    if not f or f == ".":
        return root
    f = f.replace("/", os.sep).replace("\\", os.sep)
    if os.path.isabs(f):
        return os.path.normpath(f)
    return os.path.normpath(os.path.join(root, f))


def _asset_sub_and_base(folder):
    """返回 (sub, base, in_input)。sub 为相对 input 的目录（带尾部 /，空串=根）；
    in_input=False 时 sub='.xiantu_import/'（切分时会自动导入外部素材）。"""
    input_dir = folder_paths.get_input_directory()
    base = _resolve_base(folder)
    if folder_paths.is_within_directory(input_dir, base):
        sub = os.path.relpath(base, input_dir).replace("\\", "/")
        if sub == ".":
            sub = ""
        else:
            sub = sub.rstrip("/") + "/"
        return sub, base, True
    return ".xiantu_import/", base, False


def _import_external(base, name):
    """把 input 之外目录的素材幂等复制到 input/.xiantu_import/（同名同大小跳过）。
    返回相对 input 的路径 '.xiantu_import/<name>'；源文件不存在返回 None。"""
    src = os.path.join(base, name)
    if not os.path.isfile(src):
        return None
    dest_dir = os.path.join(folder_paths.get_input_directory(), ".xiantu_import")
    os.makedirs(dest_dir, exist_ok=True)
    base_name = os.path.basename(name)
    dst = os.path.join(dest_dir, base_name)
    if os.path.isfile(dst) and os.path.getsize(dst) == os.path.getsize(src):
        return ".xiantu_import/" + base_name
    shutil.copy2(src, dst)
    return ".xiantu_import/" + base_name


# ---------------- 分析辅助（按文件名关键词匹配） ----------------

_MARKER_RE = re.compile(r"^(【\s*镜头\s*\d+\s*】)\s*(.*)$", re.DOTALL)
_EXISTING_TAG_RE = re.compile(r"<(?:Picture|Video|Audio)\s+\d+\s*>")
_TAG = {
    "image": re.compile(r"<Picture\s+(\d+)\s*>"),
    "audio": re.compile(r"<Audio\s+(\d+)\s*>"),
    "video": re.compile(r"<Video\s+(\d+)\s*>"),
}
LIMITS = {"image": 9, "audio": 3, "video": 3}


def _search_key(name):
    """从素材文件名提取搜索关键词：去后缀、去常见修饰词。"""
    base = os.path.splitext(os.path.basename(name))[0]
    for sfx in ("配音", "三视图", "角色卡", "场景概念图", "概念图", "场景图", "场景"):
        if sfx in base:
            base = base.replace(sfx, "")
    return base.strip()


def _build_cands(text, sub, in_input, base):
    """把 'N=文件名' 解析成 [(num, keyword, fileName, relPath), ...]，按 num 排序。"""
    def _rel(name):
        if in_input:
            return sub + name if sub else name
        return os.path.join(base, name)

    return [
        (num, _search_key(name), name, _rel(name))
        for num, name in sorted(parse_ref_mapping(text, None).items())
    ]


def _asset_exists(rel, in_input):
    if in_input:
        return folder_paths.exists_annotated_filepath(rel)
    return os.path.isfile(rel)


def _analyze_one_shot(body, cands_by_kind, in_input):
    """为单个分镜匹配素材：跳过已存在的标签、跳过已达上限的。"""
    existing = set(_EXISTING_TAG_RE.findall(body))
    new_tags = []
    counts = {"image": 0, "audio": 0, "video": 0}
    matched = set()
    for kind in ("image", "audio", "video"):
        for num, key, name, rel in cands_by_kind[kind]:
            tag = {"image": "<Picture {}>", "audio": "<Audio {}>", "video": "<Video {}>"}[kind].format(num)
            if tag in existing:
                matched.add((kind, num))
                continue
            if counts[kind] >= LIMITS[kind]:
                continue
            if not key:
                continue
            if not _asset_exists(rel, in_input):
                continue
            if key in body:
                new_tags.append({
                    "kind": kind, "index": num - 1, "fileName": name,
                    "keyword": key, "tag": tag,
                })
                counts[kind] += 1
                existing.add(tag)
                matched.add((kind, num))
    return new_tags, matched


# ---------------- 路由处理器 ----------------

async def _studio_files(request):
    folder = request.query.get("folder", ".")
    sub, base, in_input = _asset_sub_and_base(folder)
    files = []
    if os.path.isdir(base):
        for f in sorted(os.listdir(base)):
            fp = os.path.join(base, f)
            if not os.path.isfile(fp):
                continue
            ext = f.rsplit(".", 1)[-1].lower()
            if in_input:
                rel = (sub + f) if sub else f
            else:
                rel = ".xiantu_import/" + f
            if ext in ("png", "jpg", "jpeg", "webp", "bmp"):
                if not in_input:
                    rel = _import_external(base, f) or rel
                files.append(["image", f, rel])
            elif ext in ("wav", "mp3", "flac", "ogg", "m4a"):
                files.append(["audio", f, rel])
            elif ext in ("mp4", "mov", "webm", "mkv", "avi", "m4v"):
                files.append(["video", f, rel])
    return web.json_response({
        "sub": sub.rstrip("/") if sub else "",
        "inInput": in_input,
        "files": files,
    })


async def _studio_browse(request):
    path = (request.query.get("path", "") or "").strip().strip('"')
    dirs, drives, parent = [], [], None
    if path and os.path.isdir(path):
        try:
            norm = os.path.normpath(path)
            dirs = [
                d for d in sorted(os.listdir(norm))
                if os.path.isdir(os.path.join(norm, d)) and not d.startswith(".")
            ]
            p = os.path.dirname(norm)
            parent = p if p != norm else None
        except OSError:
            dirs = []
    else:
        drives = [f"{c}:\\" for c in string.ascii_uppercase if os.path.isdir(f"{c}:\\")]
    return web.json_response({"path": path, "dirs": dirs, "drives": drives, "parent": parent})


async def _studio_upload(request):
    post = await request.post()
    folder = request.query.get("folder", ".")
    base = _resolve_base(folder)
    saved = []
    for field in post.getall("files", []):
        name = os.path.basename(field.filename)
        if not name:
            continue
        with open(os.path.join(base, name), "wb") as f:
            f.write(field.file.read())
        saved.append(name)
    return web.json_response({"saved": saved})


async def _studio_export(request):
    body = await request.json()
    shots = split_script(
        body.get("script", ""),
        body.get("prefix", ""),
        body.get("mode", "【镜头N】标记"),
        bool(body.get("strip", True)),
    )
    lines = [f"【镜头{i + 1}】\n{s}" for i, s in enumerate(shots)]
    text = "\n\n".join(lines) if lines else "（剧本为空，未切分出分镜）"
    return web.Response(
        text=text,
        content_type="text/plain",
        headers={"Content-Disposition": 'attachment; filename="storyboard_export.txt"'},
    )


async def _studio_split(request):
    """切分剧本 + 严格按每个分镜实际引用的素材（<Picture/Video/Audio N> 标记）。

    H3 限制：图片≤9 / 音频≤3 / 视频≤3。
    仅按 N 标记精确匹配；不做"按文件名关键词兜底"，避免把别的分镜或全局素材串进来。
    """
    body = await request.json()
    mode = body.get("mode", "【镜头N】标记")
    strip = bool(body.get("strip", True))
    prefix = (body.get("prefix") or "").strip()

    script = body.get("script", "")
    bodies = split_script(script, "", mode, strip)
    if len(bodies) > 1:
        raw_bodies = split_script(script, "", mode, False)
        if raw_bodies and not re.search(r"[\[【]\s*镜头\s*\d+", raw_bodies[0]):
            header = bodies.pop(0).strip()
            prefix = (header + "\n" + prefix).strip() if prefix else header
    if not bodies:
        return web.json_response({"error": "剧本为空或切分结果为空"}, status=400)

    folder = (body.get("folder") or ".").strip()
    sub, base, in_input = _asset_sub_and_base(folder)
    try:
        sec = float(body.get("durationSec") or 10.0)
    except (TypeError, ValueError):
        sec = 10.0
    fps = 24.0
    fc = max(5, int(round(sec * fps)))
    while fc % 17 != 5:
        fc += 1

    per_shot_durations = body.get("durations") or {}
    if not isinstance(per_shot_durations, dict):
        per_shot_durations = {}

    _KEY = {"image": "imageFile", "audio": "audioFile", "video": "videoFile"}
    _SRC = {"image": "imgRef", "audio": "audRef", "video": "vidRef"}

    items_by_kind = {}
    missing = {"image": [], "audio": [], "video": []}

    for kind in ("image", "audio", "video"):
        items = {}
        for num, name in parse_ref_mapping(body.get(_SRC[kind], ""), None).items():
            if num < 1:
                continue
            if in_input:
                rel = sub + name if sub else name
                if not folder_paths.exists_annotated_filepath(rel):
                    missing[kind].append(rel)
                    continue
            else:
                rel = _import_external(base, name)
                if rel is None:
                    missing[kind].append(name)
                    continue
            item = {
                "index": num - 1,
                "fileName": os.path.basename(name),
                "type": "input",
                "subfolder": sub.rstrip("/\\") if sub else "",
            }
            item[_KEY[kind]] = rel
            items[num] = item
        items_by_kind[kind] = items

    def _match_shot(shot_text):
        out = {"refs": [], "audios": [], "videos": []}
        for kind, list_key in (("image", "refs"), ("audio", "audios"), ("video", "videos")):
            items = items_by_kind[kind]
            added = []
            for m in _TAG[kind].finditer(shot_text):
                num = int(m.group(1))
                if num in items and num not in added:
                    added.append(num)
                    if len(added) >= LIMITS[kind]:
                        break
            out[list_key] = [items[num] for num in added]
        return out

    per_shot = [_match_shot(b) for b in bodies]

    per_shot_secs = []
    for i in range(len(bodies)):
        try:
            v = float(per_shot_durations.get(str(i), per_shot_durations.get(i, sec)))
            if v > 0:
                per_shot_secs.append(v)
                continue
        except (TypeError, ValueError):
            pass
        per_shot_secs.append(sec)

    shots = [prefix + "\n" + b if prefix else b for b in bodies]

    return web.json_response({
        "shots": shots,
        "perShot": per_shot,
        "missingImages": missing["image"],
        "missingAudios": missing["audio"],
        "missingVideos": missing["video"],
        "frameCount": fc,
        "durationSec": round(sec, 2),
        "durationPerShot": [round(v, 2) for v in per_shot_secs],
    })


async def _studio_analyze(request):
    """分析剧本：把每个分镜里出现的角色/场景/音效关键词与上传素材文件名匹配。"""
    body = await request.json()
    script = (body.get("script") or "").replace("\r\n", "\n").strip()
    mode = body.get("mode", "【镜头N】标记")
    if not script:
        return web.json_response({"error": "剧本为空"}, status=400)

    folder = (body.get("folder") or ".").strip()
    sub, base, in_input = _asset_sub_and_base(folder)

    cands_by_kind = {
        "image": _build_cands(body.get("imgRef", ""), sub, in_input, base),
        "audio": _build_cands(body.get("audRef", ""), sub, in_input, base),
        "video": _build_cands(body.get("vidRef", ""), sub, in_input, base),
    }

    chunks = []
    if mode == "【镜头N】标记":
        parts = re.split(r"(?=【\s*镜头\s*\d+\s*】)", script)
        parts = [p for p in parts if p.strip()]
        for p in parts:
            m = _MARKER_RE.match(p)
            marker = m.group(1) if m else ""
            body_text = (m.group(2) if m else p).strip()
            chunks.append((marker, body_text))
    elif mode == "---分隔线":
        parts = [p.strip() for p in re.split(r"^\s*-{3,}\s*$", script, flags=re.M) if p.strip()]
        chunks = [("", p) for p in parts]
    else:
        parts = [p.strip() for p in re.split(r"\n\s*\n", script) if p.strip()]
        chunks = [("", p) for p in parts]

    if not chunks:
        return web.json_response({"error": "剧本为空或切分结果为空"}, status=400)

    per_shot = []
    modified_chunks = []
    all_matched = set()
    for marker, body_text in chunks:
        new_tags, matched = _analyze_one_shot(body_text, cands_by_kind, in_input)
        per_shot.append(new_tags)
        all_matched.update(matched)
        insertions = []
        for t in new_tags:
            pos = body_text.find(t["keyword"])
            if pos >= 0:
                insertions.append((pos + len(t["keyword"]), t["tag"]))
        modified = body_text
        for ins_pos, tag in sorted(insertions, key=lambda x: -x[0]):
            modified = modified[:ins_pos] + tag + " " + modified[ins_pos:]
        if marker:
            modified_chunks.append(f"{marker}\n{modified}")
        else:
            modified_chunks.append(modified)

    all_unmatched = []
    for kind in ("image", "audio", "video"):
        for num, key, name, rel in cands_by_kind[kind]:
            if (kind, num) in all_matched:
                continue
            if not key:
                all_unmatched.append({"kind": kind, "fileName": name, "reason": "关键词为空"})
            elif not _asset_exists(rel, in_input):
                all_unmatched.append({"kind": kind, "fileName": name, "reason": "文件不存在"})
            else:
                all_unmatched.append({
                    "kind": kind, "fileName": name, "keyword": key,
                    "reason": "未在任何分镜中找到匹配",
                })

    if mode == "【镜头N】标记":
        modifiedScript = "".join(modified_chunks)
    elif mode == "---分隔线":
        modifiedScript = "\n\n---\n\n".join(modified_chunks)
    else:
        modifiedScript = "\n\n".join(modified_chunks)

    return web.json_response({
        "shots": [c[1] for c in chunks],
        "perShot": per_shot,
        "modifiedScript": modifiedScript,
        "unmatched": all_unmatched,
        "limits": LIMITS,
    })


# ---------------- 注册 ----------------

def _register_route(routes, method, path, handler):
    if hasattr(routes, "add_route"):
        routes.add_route(method, path, handler)
    elif method == "POST" and hasattr(routes, "post"):
        routes.post(path)(handler)
    elif method == "GET" and hasattr(routes, "get"):
        routes.get(path)(handler)
    else:
        raise AttributeError("Unsupported ComfyUI route table API")


def register_routes() -> bool:
    """注册剧本工作台路由。与 director/http_routes.py 一样在 __init__ 里调用。"""
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return True

    server = PromptServer.instance
    if server is None:
        log.warning("MiniMax H3 Director: PromptServer not ready, studio routes not registered")
        return False

    routes = server.routes
    _register_route(routes, "GET", "/xiantu/studio/files", _studio_files)
    _register_route(routes, "GET", "/xiantu/studio/browse", _studio_browse)
    _register_route(routes, "POST", "/xiantu/studio/upload", _studio_upload)
    _register_route(routes, "POST", "/xiantu/studio/export", _studio_export)
    _register_route(routes, "POST", "/xiantu/studio/split", _studio_split)
    _register_route(routes, "POST", "/xiantu/studio/analyze", _studio_analyze)
    _ROUTES_REGISTERED = True
    log.info("MiniMax H3 Director studio routes registered")
    return True
