"""MiniMax H3 Director — guaranteed-fresh VIDEO saver.

The standard ``SaveVideo`` node uses ComfyUI's ``get_save_image_path`` counter
incremented by the existing-file count under ``output/<prefix>/``. In practice
on the Director workflow we observed two real problems:

1. ``MiniMaxH3Director``'s ``images``/``audio`` outputs are ``OUTPUT_IS_LIST``
   (per-segment lists). If anything in the chain ever falls back to per-segment
   execution (e.g. a stray wired node that is not ``is_input_list=True``),
   ``SaveVideo`` runs once per segment, and every call uses the same filename
   prefix — so only the LAST shot's video survives on disk while the front-end
   shows whichever file the LAST invocation wrote.
2. The ComfyUI front-end caches the ``<video>`` element's ``src=`` URL when the
   filename matches what it has already loaded, so even after a fresh run the
   preview panel keeps replaying an older file.

To kill both bugs at once, this node:

* ignores the upstream counter and writes to a deterministic, **fresh** path
  of the form ``MiniMaxH3_Director_<UTC YYYYMMDD-HHMMSS>_<6-hex-char-hash>.mp4``
  (the hash is a per-call salt of ``time.time_ns()`` + ``random.getrandbits``,
  so collisions across concurrent runs are vanishingly improbable);
* always picks the highest-quality available codec (h264 when supported,
  otherwise webm/av1 auto) and writes to ``output/video/``;
* bumps ``filename_prefix`` into the ``ui.PreviewVideo`` payload so the
  front-end refreshes the ``<video>`` element's ``src`` to the new path on
  every run (no stale cache);
* returns the same VIDEO downstream so users can chain a ``PreviewVideo``
  / inspector node without changes.

Designed to sit directly after ``MiniMaxH3DirectorConcat`` in the workflow.
"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import time
from typing import Optional

from comfy_api.latest import io as IO
from comfy_api.latest import ui

try:
    from comfy_api.latest._input_impl.video_types import (
        Types as _VideoTypes,  # noqa: F401  (kept for forward-compat)
    )
except Exception:  # pragma: no cover
    _VideoTypes = None  # type: ignore

import folder_paths

_log = logging.getLogger("ComfyUI-MiniMaxH3-Director")

_CATEGORY = "MiniMaxH3"
_OUTPUT_SUBDIR = "video"
_PREFIX = "MiniMaxH3_Director"


def _utc_stamp() -> str:
    t = time.gmtime()
    return time.strftime("%Y%m%d-%H%M%S", t)


def _fresh_hash() -> str:
    """6 hex chars (24-bit) derived from a per-call salt — fine for filename
    collision avoidance within one user run; not a security primitive."""
    salt = f"{time.time_ns():x}-{os.getpid()}-{random.getrandbits(64):x}"
    return hashlib.sha256(salt.encode("utf-8")).hexdigest()[:6]


def _pick_container_and_codec() -> tuple[str, str]:
    """Pick the best codec/container pair that this ComfyUI build supports."""
    if _VideoTypes is not None:
        try:
            supported_containers = {c.value for c in _VideoTypes.VideoContainer}
            supported_codecs = {c.value for c in _VideoTypes.VideoCodec}
        except Exception:
            supported_containers = {"mp4", "webm", "mkv"}
            supported_codecs = {"auto", "h264", "av1", "vp9"}
    else:
        supported_containers = {"mp4", "webm", "mkv"}
        supported_codecs = {"auto", "h264", "av1", "vp9"}

    # Prefer h264/mp4 (broadest playback) → fall back to av1/webm → mp4 auto.
    if "mp4" in supported_containers and "h264" in supported_codecs:
        return "mp4", "h264"
    if "webm" in supported_containers and "av1" in supported_codecs:
        return "webm", "av1"
    if "mp4" in supported_containers:
        return "mp4", "auto"
    return ("mp4" if "mp4" in supported_containers else next(iter(supported_containers))), "auto"


class MiniMaxH3DirectorSave(IO.ComfyNode):
    """Save the concatenated Director video to a guaranteed-fresh file path.

    Replaces ``SaveVideo`` for the Director workflow: every run writes a
    unique filename so the front-end never replays a cached ``<video>`` src
    and no per-segment re-execution can stomp the final file.
    """

    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="MiniMaxH3DirectorSave",
            search_aliases=[
                "director save",
                "fresh save video",
                "save director video",
                "时间戳保存视频",
            ],
            display_name="MiniMax H3 Director Save (fresh)",
            category=_CATEGORY,
            description=(
                "Save the MiniMaxH3DirectorConcat VIDEO to "
                "output/video/MiniMaxH3_Director_<UTC-stamp>_<hash>.mp4. "
                "Each run writes a unique filename so the front-end never "
                "replays a cached <video> element. Drop-in replacement for "
                "SaveVideo on the Director workflow."
            ),
            is_output_node=True,
            inputs=[
                IO.Video.Input(
                    "video",
                    tooltip="MiniMaxH3DirectorConcat.outputs (single VIDEO).",
                ),
                IO.String.Input(
                    "prefix",
                    default=_PREFIX,
                    tooltip="File prefix; a UTC timestamp + 6-hex hash is always appended.",
                ),
            ],
            hidden=[IO.Hidden.prompt, IO.Hidden.extra_pnginfo],
            outputs=[IO.Video.Output()],
        )

    @classmethod
    def execute(
        cls,
        video,
        prefix: str = _PREFIX,
    ) -> IO.NodeOutput:
        # 1) Choose a fresh, fully-unique file name. ``time.time_ns`` +
        # ``random.getrandbits`` + ``os.getpid`` salted into sha256 makes
        # collisions across concurrent runs effectively impossible.
        safe_prefix = (prefix or _PREFIX).strip().strip("/\\") or _PREFIX
        stamp = _utc_stamp()
        digest = _fresh_hash()
        file_base = f"{safe_prefix}_{stamp}_{digest}"

        # 2) Pick the best codec/container that this ComfyUI build supports.
        container_name, codec_name = _pick_container_and_codec()
        ext = _guess_extension(container_name)
        file_name = f"{file_base}.{ext}"

        # 3) Resolve the output directory under ComfyUI/output/<sub>/.
        out_root = folder_paths.get_output_directory()
        full_dir = os.path.join(out_root, _OUTPUT_SUBDIR)
        os.makedirs(full_dir, exist_ok=True)
        full_path = os.path.join(full_dir, file_name)

        # 4) Actually write the file. ``Video.save_to`` accepts either an
        # ``enum`` value or a string for ``format``/``codec`` depending on
        # ComfyUI version — try both, fall back gracefully.
        try:
            video.save_to(full_path, format=container_name, codec=codec_name)
        except TypeError:
            # Some builds require enum values, others only accept strings.
            try:
                video.save_to(
                    full_path,
                    format=_enum_or_str(_VideoTypes, "VideoContainer", container_name),
                    codec=_enum_or_str(_VideoTypes, "VideoCodec", codec_name),
                )
            except Exception as exc:
                _log.warning(
                    "MiniMaxH3DirectorSave: enum-typed save_to failed (%s); "
                    "retrying without codec hint.",
                    exc,
                )
                video.save_to(full_path, format=container_name)
        except Exception as exc:
            _log.error("MiniMaxH3DirectorSave: save_to failed: %s", exc)
            raise

        # 5) Confirm the file actually landed on disk. If not, raise —
        # we don't want the front-end to keep showing a stale video.
        if not os.path.isfile(full_path):
            raise RuntimeError(
                f"MiniMaxH3DirectorSave: file was not written to {full_path}"
            )

        _log.info(
            "MiniMaxH3DirectorSave: wrote %s (%.1f KB, container=%s, codec=%s)",
            full_path,
            os.path.getsize(full_path) / 1024.0,
            container_name,
            codec_name,
        )

        return IO.NodeOutput(
            video,
            ui=ui.PreviewVideo([
                ui.SavedResult(file_name, _OUTPUT_SUBDIR, IO.FolderType.output),
            ]),
        )


def _guess_extension(container: str) -> str:
    return {
        "mp4": "mp4",
        "webm": "webm",
        "mkv": "mkv",
        "gif": "gif",
        "mov": "mov",
    }.get(container, "mp4")


def _enum_or_str(types_module, enum_name: str, value: str):
    """Best-effort: return the enum member for ``value`` if the module exposes
    it, else fall back to the raw string. ComfyUI's ``save_to`` accepts both
    in different builds, but we don't want a hard dep on enum membership."""
    if types_module is None:
        return value
    enum_cls = getattr(types_module, enum_name, None)
    if enum_cls is None:
        return value
    try:
        # ``Enum.value`` lookup (strEnum-style).
        return enum_cls(value)
    except Exception:
        pass
    try:
        return enum_cls[value.upper()]
    except Exception:
        pass
    return value


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3DirectorSave": MiniMaxH3DirectorSave,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3DirectorSave": "MiniMax H3 Director Save (fresh)",
}