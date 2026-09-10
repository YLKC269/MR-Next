"""ComfyUI_MRBoard_Next 后端路由注册。

所有路由挂在 /mrnext/* 下，与旧包 /mr_board/* 完全隔离。
"""

import logging
import os

log = logging.getLogger("ComfyUI_MRBoard_Next")

try:
    from server import PromptServer
except Exception:  # noqa: BLE001
    PromptServer = None


def _add_route(routes, method, path, handler):
    """兼容不同 aiohttp 版本的注册写法（与旧包 _register_route 同构）。"""
    if hasattr(routes, "add_route"):
        routes.add_route(method, path, handler)
    elif method == "POST" and hasattr(routes, "post"):
        routes.post(path)(handler)
    elif method == "GET" and hasattr(routes, "get"):
        routes.get(path)(handler)
    else:
        raise AttributeError("Unsupported ComfyUI route table API")


def register_routes():
    """把 api.ROUTES 挂到 PromptServer 的 aiohttp routes 上。

    注意：本环境 PromptServer 是单例实例，引用其路由表用
    `PromptServer.instance.routes`（instance 是实例自引用属性，不要加括号调用）。
    """
    if PromptServer is None:
        return False
    try:
        server = PromptServer.instance
        routes = server.routes
    except Exception as exc:  # noqa: BLE001
        log.warning("PromptServer 未就绪：%s", exc)
        return False

    from .api import ROUTES

    ok = 0
    for method, path, handler in ROUTES:
        try:
            _add_route(routes, method, path, handler)
            ok += 1
        except Exception as exc:  # noqa: BLE001
            # 重复注册等忽略，保证其余路由可用
            log.warning("路由注册失败 %s %s: %s", method, path, exc)
    log.info("MRBoard_Next 路由已注册（%d/%d 条）", ok, len(ROUTES))
    return ok > 0
