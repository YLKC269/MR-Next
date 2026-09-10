"""favorites.py — 后端收藏库（语义资产注册表：名字 → 文件）。

用途：把常用素材（角色图 / 场景图 / 参考）按 category 记住，
供 分镜分析/引用匹配 按「名字」找到对应文件。
持久化：user/mrboard_favorites_next.json（与旧包文件分开，互不干扰）。
条目：{id, name, rel, kind, category, addedAt}；同 rel+category 去重。
"""

import json
import os
import time

import folder_paths

_FAV_JSON = "mrboard_favorites_next.json"

_KIND_BY_EXT = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
    ".wav": "audio", ".mp3": "audio", ".flac": "audio", ".ogg": "audio", ".m4a": "audio",
    ".mp4": "video", ".m4v": "video", ".mov": "video", ".webm": "video", ".mkv": "video",
}


def _store_path():
    try:
        base = folder_paths.get_user_directory()
    except Exception:  # noqa: BLE001
        base = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "user")
    try:
        os.makedirs(base, exist_ok=True)
    except Exception:  # noqa: BLE001
        pass
    return os.path.join(base, _FAV_JSON)


def _load():
    p = _store_path()
    if not os.path.isfile(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:  # noqa: BLE001
        return []
    return data if isinstance(data, list) else []


def _save(items):
    try:
        with open(_store_path(), "w", encoding="utf-8") as fh:
            json.dump(items, fh, ensure_ascii=False, indent=1)
        return True
    except Exception:  # noqa: BLE001
        return False


def _norm(e):
    rel = str(e.get("rel") or "").strip().replace("\\", "/")
    ext = os.path.splitext(rel)[1].lower()
    kind = str(e.get("kind") or "").strip().lower() or _KIND_BY_EXT.get(ext, "image")
    return {
        "id": str(e.get("id") or ("fav_%d" % int(time.time() * 1000))),
        "name": str(e.get("name") or os.path.splitext(os.path.basename(rel))[0]).strip(),
        "rel": rel,
        "kind": kind,
        "category": str(e.get("category") or "asset").strip().lower(),
        "addedAt": int(e.get("addedAt") or time.time()),
    }


def list_items():
    return _load()


def add_items(raw):
    """raw 为条目列表；同 rel+category 视为同一条，不重复入库。"""
    incoming = [_norm(x) for x in raw if isinstance(x, dict) and (x.get("rel") or x.get("name"))]
    if not incoming:
        return {"added": [], "total": len(_load())}
    items = _load()
    exist = {(str(i.get("rel") or ""), str(i.get("category") or "")) for i in items}
    added = []
    for it in incoming:
        key = (it["rel"], it["category"])
        if key in exist:
            continue
        exist.add(key)
        items.append(it)
        added.append(it)
    if added and not _save(items):
        raise RuntimeError("收藏库持久化失败")
    return {"added": added, "total": len(items)}


def remove_items(ids=None, keys=None):
    """ids: 按条目 id 删除；keys: [(rel, category)] 删除。"""
    items = _load()
    id_set = {str(x) for x in (ids or []) if x}
    key_set = {(str(x[0] or ""), str(x[1] or "")) for x in (keys or [])}
    keep = [
        i for i in items
        if str(i.get("id") or "") not in id_set
        and (str(i.get("rel") or ""), str(i.get("category") or "")) not in key_set
    ]
    removed = len(items) - len(keep)
    if removed and not _save(keep):
        raise RuntimeError("收藏库持久化失败")
    return {"removed": removed, "total": len(keep)}
