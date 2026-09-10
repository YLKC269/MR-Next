"""ComfyUI_MRBoard_Next — MR分镜助手导演台 · Next（一体化整合包）

设计目标（与旧版彻底切割）：
  - 前端：单一 DOM widget + Shadow DOM 100% 样式隔离；模块化 ES（core/ + panels/）；
    响应式 Store + 声明式 h() 渲染 + 独立 styles.css，彻底告别内联样式 / 7800 行巨石 /
    onDraw 每帧清预览 / DOM 跨 widget 搬运。
  - 后端：server/ 下干净路由层，按职责分文件，零 legacy 包袱。
  - 节点不再输出原生 IMAGE 预览（node.imgs 预览框从源头消失），结果全部走自有面板。

一体化整合（v1.0）：
  - vendor/ComfyUI_MiniMaxH3_Director：官方 H3 出片引擎（纯 Python 部分）内嵌，
    只装本包即可获得 MiniMaxH3Director 全部节点（t2v/i2v/fl2v/r2v 构图由 h3shot.py
    直接读 vendored example_workflows 模板，不再依赖外部安装）。
  - vendor 版已裁掉 web UI（本包自有前端）与 HTTP 路由（避免 /minimax/* 冲突）。
  - 可选外部增强（未装不影响核心功能）：
      ComfyUI-KJNodes          → PathchSageAttentionKJ（Block Sparse Attention 加速）
      TE-speed-minimaxH3       → TESpeedMiniMaxH3（采样步数加速）
      comfyUI-llama-TE         → 本地 LLM 提示词优化（Skill 面板）
      ComfyUI-SeedVR2_VideoUpscaler → SeedVR2 视频超分（二采）
"""

__version__ = "1.9.4"

import logging
import os
import sys

log = logging.getLogger("ComfyUI_MRBoard_Next")

from .nodes.studio_node import MRBoardStudio

# ---- vendored H3 引擎：把节点类并入本包注册表（只装本包即可识别全部 H3 节点）----
_H3 = {}
_H3_NAMES = {}
try:
    import importlib

    _vendor_root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
    if _vendor_root not in sys.path:
        sys.path.insert(0, _vendor_root)
    # vendor 目录名含连字符（ComfyUI_MiniMaxH3_Director）不是合法模块名 →
    # 用 importlib 机制把目录挂成合法包名 mrnext_vendor_h3（相对 import 正常工作）
    import importlib.util as _ilu
    import types as _types

    _vdir = os.path.join(_vendor_root, "ComfyUI_MiniMaxH3_Director")
    _vinit = os.path.join(_vdir, "__init__.py")
    if os.path.isfile(_vinit):
        _spec = _ilu.spec_from_file_location(
            "mrnext_vendor_h3", _vinit,
            submodule_search_locations=[_vdir])
        _mod = _types.ModuleType("mrnext_vendor_h3")
        _mod.__spec__ = _spec
        _mod.__path__ = [_vdir]
        sys.modules["mrnext_vendor_h3"] = _mod
        _spec.loader.exec_module(_mod)  # noqa: PLC2801
        _H3 = dict(getattr(_mod, "NODE_CLASS_MAPPINGS", {}) or {})
        _H3_NAMES = dict(getattr(_mod, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {})
        log.info("MRBoard_Next vendored H3 引擎已加载：%d 个节点类", len(_H3))
except Exception as _exc:  # noqa: BLE001
    log.warning("vendored H3 引擎加载失败（H3 出片不可用）：%s", _exc)

NODE_CLASS_MAPPINGS = {
    "MRBoardStudio": MRBoardStudio,
    **_H3,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MRBoardStudio": "MR分镜助手导演台 · Next",
    **_H3_NAMES,
}

WEB_DIRECTORY = "./web/js"

# 路由注册（/mrnext/*）：PromptServer 就绪后挂到 aiohttp 上
try:
    from .server import register_routes as _register_routes

    if not _register_routes():
        log.warning(
            "MRBoard_Next routes deferred (PromptServer not ready). "
            "Restart ComfyUI if /mrnext/* returns 404."
        )
except Exception as _exc:  # noqa: BLE001
    log.warning("MRBoard_Next routes failed to load: %s", _exc)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]