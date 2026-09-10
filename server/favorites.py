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


def rename_items(ids=None, rel=None, name="", new_rel=None):
    """改收藏条目的名字（同一个文件的条目一起改）。

    ids：按条目 id 定位；rel：按文件定位（同一 rel 可能被多个分类收藏 → 全改）。
    new_rel：文件已改名时一并把 rel 换掉，避免收藏库指向不存在的旧路径。
    """
    items = _load()
    id_set = {str(x) for x in (ids or []) if x}
    rel0 = str(rel or "").strip().replace("\\", "/")
    nm = str(name or "").strip()
    nr = str(new_rel or "").strip().replace("\\", "/")
    if not id_set and not rel0:
        return {"error": "需要 id 或 rel 才能定位要改名的收藏", "updated": 0}
    hit = 0
    for i in items:
        cur_rel = str(i.get("rel") or "")
        matched = (str(i.get("id") or "") in id_set) if id_set else False
        if not matched and rel0 and cur_rel == rel0:
            matched = True
        if not matched:
            continue
        if nm:
            i["name"] = nm
        if nr:
            i["rel"] = nr
        hit += 1
    if hit and not _save(items):
        raise RuntimeError("收藏库持久化失败")
    return {"updated": hit, "name": nm, "rel": nr or rel0, "total": len(items)}


def replace_all(items):
    """整体覆盖写回（供外部改名流程同步 rel / name 时使用）。"""
    if not _save(list(items or [])):
        raise RuntimeError("收藏库持久化失败")
    return {"total": len(items or [])}


def sync_renamed_file(old_rel, new_rel, new_stem):
    """磁盘文件改名后：把收藏库里指向旧路径的条目改到新路径。

    条目名字原本就等于旧文件名主名时（生成设定图/流水线自动命名的常见情形），
    名字也一起改成新主名，保持「收藏名 = 文件名」的一致。
    """
    items = _load()
    old_rel = str(old_rel or "").strip().replace("\\", "/")
    new_rel = str(new_rel or "").strip().replace("\\", "/")
    if not old_rel or not new_rel or old_rel == new_rel:
        return {"updated": 0}
    old_stem = os.path.splitext(os.path.basename(old_rel))[0]
    hit = 0
    for i in items:
        if str(i.get("rel") or "") != old_rel:
            continue
        i["rel"] = new_rel
        if str(i.get("name") or "") == old_stem:
            i["name"] = str(new_stem or "").strip() or i["name"]
        hit += 1
    if hit and not _save(items):
        raise RuntimeError("收藏库持久化失败")
    return {"updated": hit}

