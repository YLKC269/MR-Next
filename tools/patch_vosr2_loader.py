# -*- coding: utf-8 -*-
"""给 ComfyUI-VOSR2 打「离线/扁平布局/镜像下载」补丁（幂等，重复执行安全）。

背景：ComfyUI-VOSR2 的 loader.py 只在 `models/vosr2/VOSR2/` 里找模型，找不到就
去 huggingface.co 下载；国内网络 / 失效代理下会卡住 60 秒然后报 ProxyError。

补丁做了三件事：
  1. 额外接受扁平布局 —— 文件直接放在 `models/vosr2/` 下也能识别（手动下载的情况）；
  2. 文件齐全时完全不联网；
  3. 确实要下载时改用 hf-mirror.com，并临时摘掉代理环境变量（用完恢复）。

用法（改完/重装 ComfyUI-VOSR2 后跑一次，然后重启 ComfyUI）：
    python patch_vosr2_loader.py
    python patch_vosr2_loader.py --root X:/.../ComfyUI/custom_nodes
"""
import argparse
import os
import re
import sys

MARKER = "_MRNEXT_PATCH"

IMPORT_OLD = "import json\nimport logging\nimport re\nfrom pathlib import Path"
IMPORT_NEW = ("import contextlib\nimport json\nimport logging\nimport os\nimport re\n"
              "import time\nfrom pathlib import Path")

HELPERS_ANCHOR = '_DINOV2_HF_FILE = "torch_cache/checkpoints/dinov2_vitl14_pretrain.pth"'

HELPERS = HELPERS_ANCHOR + '''
_DINOV2_PTH_NAME = "dinov2_vitl14_pretrain.pth"

# --- MRBoard_Next patch: layout tolerance + network resilience ---------------
# 1) Layout: the bundle may sit directly in ``models/vosr2/`` (flat layout --
#    what you get when the files are downloaded by hand) instead of
#    ``models/vosr2/<bundle>/``. Both are accepted; nothing is downloaded when
#    either one is complete.
# 2) Network: ``huggingface.co`` is unreachable behind some proxies, so the
#    download falls back to a mirror and bypasses the broken proxy env vars for
#    these requests only (env vars are restored afterwards).
_MRNEXT_PATCH = True  # 幂等标记：tools/patch_vosr2_loader.py 重复执行时据此跳过
_HF_MIRRORS = ("https://hf-mirror.com", "https://huggingface.co")
_NO_PROXY = {"http": None, "https": None}
_PROXY_ENV_KEYS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
)


def _bundle_dirs(model_name: str) -> list:
    """Existing bundle dirs for `model_name`, including the flat layout."""
    dirs = []
    named = _VOSR2_ROOT / model_name
    if (named / "args.json").is_file() or _find_dit_weight(named) is not None:
        dirs.append(named)
    if named != _VOSR2_ROOT and (
        (_VOSR2_ROOT / "args.json").is_file() or _find_dit_weight(_VOSR2_ROOT) is not None
    ):
        dirs.append(_VOSR2_ROOT)
    return dirs


@contextlib.contextmanager
def _no_proxy():
    """Temporarily drop proxy env vars (a dead proxy kills HF downloads)."""
    saved = {k: os.environ.pop(k) for k in _PROXY_ENV_KEYS if k in os.environ}
    try:
        yield
    finally:
        os.environ.update(saved)


def _endpoints() -> list:
    eps = []
    env = (os.environ.get("HF_ENDPOINT") or "").strip().rstrip("/")
    if env:
        eps.append(env)
    for m in _HF_MIRRORS:
        if m not in eps:
            eps.append(m)
    return eps


def _hf_get(filename: str, local_dir=None, retries: int = 2):
    """``hf_hub_download`` that survives a dead proxy by trying mirrors."""
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as exc:  # pragma: no cover - message mirrors the caller's
        raise VOSR2LoadError("huggingface_hub 不可用，无法下载 VOSR2 模型文件。") from exc
    last = None
    for ep in _endpoints():
        for attempt in range(retries):
            try:
                with _no_proxy():
                    return hf_hub_download(
                        HF_REPO_ID, filename,
                        local_dir=str(local_dir) if local_dir else None,
                        endpoint=ep, proxies=_NO_PROXY, etag_timeout=30,
                    )
            except Exception as exc:  # noqa: BLE001 - report the last failure
                last = exc
                logging.warning("[VOSR2] 下载 %s（%s）失败: %s", filename, ep, exc)
                time.sleep(2 * (attempt + 1))
    raise VOSR2LoadError(
        f"无法下载 VOSR2 模型文件 {filename}（已尝试: {', '.join(_endpoints())}）。"
        f"最后错误: {last}"
    )
# --- end MRBoard_Next patch -------------------------------------------------'''

ENSURE_OLD = """    bundle = _VOSR2_ROOT / KNOWN_MODEL
    vae_dir = bundle / _VAE_SUBDIR"""
ENSURE_NEW = """    found = _bundle_dirs(model_name)
    bundle = found[0] if found else (_VOSR2_ROOT / KNOWN_MODEL)
    vae_dir = bundle / _VAE_SUBDIR"""

DIT_OLD = """        for f in _DIT_HF_FILES:
            hf_hub_download(HF_REPO_ID, f, local_dir=str(_VOSR2_ROOT))"""
DIT_NEW = """        for f in _DIT_HF_FILES:
            _hf_get(f, local_dir=_VOSR2_ROOT)"""

VAE_OLD = """        for f in _VAE_HF_FILES:
            hf_hub_download(HF_REPO_ID, f, local_dir=str(bundle))"""
VAE_NEW = """        for f in _VAE_HF_FILES:
            _hf_get(f, local_dir=bundle)"""

DINOV2_OLD = """        src = hf_hub_download(HF_REPO_ID, _DINOV2_HF_FILE)
        _convert_dinov2_pth_to_safetensors(Path(src), bundle / _VISION_FILENAME)"""
DINOV2_NEW = """        local_pth = bundle / _DINOV2_PTH_NAME
        if local_pth.is_file():
            # Already downloaded by hand -- convert locally instead of refetching.
            logging.info("[VOSR2] converting local DINOv2-L checkpoint ...")
            _convert_dinov2_pth_to_safetensors(local_pth, bundle / _VISION_FILENAME)
        else:
            logging.info("[VOSR2] downloading + converting DINOv2-L encoder from %s ...", HF_REPO_ID)
            src = _hf_get(_DINOV2_HF_FILE)
            _convert_dinov2_pth_to_safetensors(Path(src), bundle / _VISION_FILENAME)"""

LOAD_OLD = "    bundle_dir = _safe_child_dir(_VOSR2_ROOT, model_name)"
LOAD_NEW = ("    found = _bundle_dirs(model_name)\n"
            "    bundle_dir = found[0] if found else _safe_child_dir(_VOSR2_ROOT, model_name)")

STEPS = [
    ("imports", IMPORT_OLD, IMPORT_NEW),
    ("helpers", HELPERS_ANCHOR, HELPERS),
    ("ensure.bundle", ENSURE_OLD, ENSURE_NEW),
    ("download.dit", DIT_OLD, DIT_NEW),
    ("download.vae", VAE_OLD, VAE_NEW),
    ("download.dinov2", DINOV2_OLD, DINOV2_NEW),
    ("load.bundle_dir", LOAD_OLD, LOAD_NEW),
]


def find_loader(root):
    for cand in (os.path.join(root, "ComfyUI-VOSR2", "loader.py"),
                 os.path.join(root, "loader.py")):
        if os.path.isfile(cand):
            return cand
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None, help="custom_nodes 目录")
    args = ap.parse_args()

    root = args.root
    if not root:
        here = os.path.dirname(os.path.abspath(__file__))
        root = os.path.dirname(os.path.dirname(os.path.dirname(here)))  # .../custom_nodes
        if not os.path.isdir(os.path.join(root, "ComfyUI-VOSR2")):
            root = os.path.dirname(os.path.dirname(here))
    path = find_loader(root)
    if not path:
        print("未找到 ComfyUI-VOSR2/loader.py（--root 指定 custom_nodes 目录）")
        return 1

    src = open(path, "r", encoding="utf-8").read()
    if MARKER in src:
        print("已打过补丁，跳过:", path)
        return 0

    for name, old, new in STEPS:
        if old not in src:
            print("!! 节点版本不匹配，缺少锚点:", name)
            print("   请手动对照 tools/patch_vosr2_loader.py 修改，或提 issue。")
            return 2
        src = src.replace(old, new, 1)

    bak = path + ".bak_mrnext"
    if not os.path.exists(bak):
        open(bak, "w", encoding="utf-8").write(open(path, "r", encoding="utf-8").read())
    open(path, "w", encoding="utf-8").write(src)
    print("补丁已写入:", path)
    print("原文件备份:", bak)
    print("请重启 ComfyUI 后生效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
