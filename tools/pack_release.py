#!/usr/bin/env python3
"""打包本节点为可安装 zip（一键重打）。

用法：
    python tools/pack_release.py            # 输出到 本包的上一级目录
    python tools/pack_release.py <输出目录>

产物：ComfyUI_MRBoard_Next_v<版本>.zip
  - 顶层目录固定为 ComfyUI_MRBoard_Next/，解压到 custom_nodes/ 即为正确结构
  - 版本号取自 web/js/main.js 的 MRNEXT_VERSION（唯一可信来源，别手写）
  - 自动排除 __pycache__ / *.pyc / 各类缓存与临时文件
  - 附带「安装说明.txt」（放在包外，解压时不会混进包目录）
"""
from __future__ import annotations

import datetime
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                 # 包根目录（含 __init__.py）
PKG = os.path.basename(SRC)
# 默认输出目录：包在 custom_nodes/<pkg> 时输出到 custom_nodes 的**上一级**
# （避免 zip 落在 custom_nodes 里跟节点混在一起）；其它位置则输出到包的上一级。
_PARENT = os.path.dirname(SRC)
# 包在 custom_nodes/<pkg> 时，默认输出到 custom_nodes 的**上一级**（即 ComfyUI 根目录下），
# 不放 custom_nodes 里跟节点混在一起；想放别处请显式传输出目录。
_DEFAULT_OUT = (os.path.dirname(_PARENT)
                if os.path.basename(_PARENT).lower() == "custom_nodes" else _PARENT)
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else _DEFAULT_OUT

SKIP_DIRS = {"__pycache__", ".git", ".idea", ".vscode", ".pytest_cache",
             ".mypy_cache", "node_modules", ".mmx_tests"}
SKIP_EXT = {".pyc", ".pyo", ".zip", ".7z", ".rar", ".log"}
SKIP_NAMES = {".DS_Store", "Thumbs.db"}


def read_version() -> str:
    p = os.path.join(SRC, "web", "js", "main.js")
    try:
        m = re.search(r'MRNEXT_VERSION\s*=\s*"([^"]+)"', open(p, encoding="utf-8").read())
        return m.group(1) if m else "0.0.0"
    except OSError:
        return "0.0.0"


INSTALL_NOTE = """MRBoard_Next v{ver} —— 安装说明
=====================================

1. 解压本压缩包，把 {pkg} 整个文件夹放到：
     <你的ComfyUI>/custom_nodes/{pkg}
   （即让 {pkg}/__init__.py 直接位于 custom_nodes/{pkg}/ 下）

2. 重启 ComfyUI。启动日志应出现：
     MRBoard_Next vendored H3 引擎已加载：8 个节点类
     MRBoard_Next 路由已注册

3. 浏览器 Ctrl+Shift+R 硬刷新；节点属性里的 data-mrnext-version 应为 {ver}。

模型目录（本包不自带模型，需自备）
  models/diffusion_models/  minimax_h3_*（fl2va / ref2va / hybrid 任一）
  models/text_encoders/     qwen3vl_32b_minimax_h3_*
  models/vae/               minimax_h3_video_vae_* + minimax_h3_audio_vae_fp32
  models/loras/             可选（蒸馏 / 风格 LoRA）

升级：直接覆盖 custom_nodes/{pkg} 后重启（素材与成片在 input/ output/ 下，不受影响）。
打包时间：{ts}
"""


def main() -> int:
    ver = read_version()
    out = os.path.join(OUT_DIR, f"{PKG}_v{ver}.zip")
    files = []
    for root, dirs, fs in os.walk(SRC):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for f in sorted(fs):
            if f in SKIP_NAMES or os.path.splitext(f)[1].lower() in SKIP_EXT:
                continue
            files.append(os.path.join(root, f))

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            rel = os.path.relpath(p, SRC).replace("\\", "/")
            z.write(p, f"{PKG}/{rel}")
        z.writestr("安装说明.txt", INSTALL_NOTE.format(
            ver=ver, pkg=PKG, ts=datetime.datetime.now().strftime("%Y-%m-%d %H:%M")))

    size = os.path.getsize(out) / 1024 / 1024
    print(f"OK  {out}")
    print(f"    {len(files)} 个文件 · {size:.2f} MB · 版本 v{ver}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
