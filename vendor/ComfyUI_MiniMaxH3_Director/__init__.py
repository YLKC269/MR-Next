"""ComfyUI MiniMax H3 Director — timeline plugin for MiniMax-H3 AV generation.

Based on ComfyUI official MiniMax H3 support (PR #15224 / #15228).
Licensed under the Apache License, Version 2.0. See LICENSE.
"""

from .nodes.conditioning import (
    MiniMaxH3DirectorConditioning,
    MiniMaxH3DirectorPlannerConditioning,
)
from .nodes.director import MiniMaxH3Director
from .nodes.director_refine import MiniMaxH3DirectorRefine
from .nodes.director_groups import (
    MiniMaxH3DirectorGroupImageToVideo,
    MiniMaxH3DirectorGroupReferenceToVideo,
    MiniMaxH3DirectorGroupsCombine,
)

NODE_CLASS_MAPPINGS = {
    "MiniMaxH3Director": MiniMaxH3Director,
    "MiniMaxH3DirectorRefine": MiniMaxH3DirectorRefine,
    # Legacy type id kept so older workflows still load.
    "ComfyMiniMaxH3Director": MiniMaxH3Director,
    "MiniMaxH3DirectorConditioning": MiniMaxH3DirectorConditioning,
    "MiniMaxH3DirectorPlannerConditioning": MiniMaxH3DirectorPlannerConditioning,
    "MiniMaxH3DirectorGroupImageToVideo": MiniMaxH3DirectorGroupImageToVideo,
    "MiniMaxH3DirectorGroupReferenceToVideo": MiniMaxH3DirectorGroupReferenceToVideo,
    # Must stay in NODE_CLASS_MAPPINGS: ComfyUI skips comfy_entrypoint when
    # NODE_CLASS_MAPPINGS is present (if/elif in load_custom_node).
    "MiniMaxH3DirectorGroupsCombine": MiniMaxH3DirectorGroupsCombine,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3Director": "MiniMaxH3Director",
    "MiniMaxH3DirectorRefine": "MiniMax H3 Director Refine",
    "ComfyMiniMaxH3Director": "MiniMaxH3Director",
    "MiniMaxH3DirectorConditioning": "MiniMax H3 Director Conditioning",
    "MiniMaxH3DirectorPlannerConditioning": "MiniMax H3 Director Planner Conditioning",
    "MiniMaxH3DirectorGroupImageToVideo": "MiniMax H3 Director Group (Image to Video)",
    "MiniMaxH3DirectorGroupReferenceToVideo": "MiniMax H3 Director Group (Reference to Video)",
    "MiniMaxH3DirectorGroupsCombine": "MiniMax H3 Director Groups Combine",
}

# WEB_DIRECTORY 已裁剪：vendored 引擎版不含 web UI（本包自有前端）

import logging

_log = logging.getLogger("ComfyUI-MiniMaxH3-Director")

# HTTP 路由已禁用：vendored 引擎版不注册 /minimax/* 路由（出片走本包 /mrnext/h3/shot，
# 由 h3shot.py 直接构图，不经 director/http_routes.py）。需要旧版独立 UI 时请装官方包。

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
