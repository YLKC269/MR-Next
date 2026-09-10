"""MiniMax H3 Director — list→single VIDEO bridge.

The Director's `images` / `audio` outputs are OUTPUT_IS_LIST (per-segment batches).
CreateVideo / SaveVideo expect a single batch + a single audio dict, so a List→Single
adapter is required on the save chain. This node:

  * torch.cat the per-segment image batches into one (B, H, W, C) tensor;
  * for audio: walk the per-segment list, dropping None and resampling to the
    first non-None sample rate, then torch.cat along the time axis (with channel
    alignment across segments);
  * emit a single VIDEO object via VideoFromComponents so the standard
    SaveVideo (output_node=True) writes `output/<filename>.mp4` correctly.

Both "全部运行" and "选择运行" go through the same path — the placeholder frames
from unrun segments stay as-is in the concatenated image batch.
"""

from __future__ import annotations

import logging
from fractions import Fraction
from typing import Optional

import torch

try:
    from comfy_api.latest import io as IO
    from comfy_api.latest._input_impl.video_types import VideoFromComponents
    from comfy_api.latest._util import VideoComponents
except Exception:  # pragma: no cover - older API fallback
    from comfy_api.input_impl import VideoFromComponents  # type: ignore
    from comfy_api.input import VideoComponents  # type: ignore
    from comfy_extras.nodes_io import io as IO  # type: ignore  # noqa: F401


_CATEGORY = "MiniMaxH3"
_log = logging.getLogger("ComfyUI-MiniMaxH3-Director")


def _first(value):
    """Unwrap a single-element list (is_input_list=True wraps scalar widgets)."""
    if isinstance(value, (list, tuple)):
        return value[0] if len(value) else None
    return value


class MiniMaxH3DirectorConcat(IO.ComfyNode):
    """Bridge between MiniMaxH3Director (list output) and SaveVideo (single VIDEO)."""

    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="MiniMaxH3DirectorConcat",
            search_aliases=["director concat", "list to video", "合并分镜视频"],
            display_name="MiniMaxH3 Director Concat (list→VIDEO)",
            category=_CATEGORY,
            description=(
                "Concat MiniMaxH3Director's per-segment image batches + per-segment audio "
                "into a single VIDEO that SaveVideo can persist. Insert between "
                "MiniMaxH3Director.outputs and SaveVideo.video."
            ),
            # Director's images/audio are OUTPUT_IS_LIST, so every input arrives as
            # a list (scalars too). We handle the whole list in one execute() call.
            is_input_list=True,
            inputs=[
                IO.Image.Input(
                    "images",
                    tooltip="Director.images list (per-segment 4D tensors).",
                ),
                IO.Audio.Input(
                    "audio",
                    tooltip="Director.audio list (per-segment audio dicts). Optional.",
                    optional=True,
                ),
                IO.Float.Input(
                    "fps",
                    default=24.0,
                    min=1.0,
                    max=240.0,
                    step=0.01,
                    tooltip="Director.fps (single float); used to set the output VIDEO frame rate.",
                ),
                IO.Int.Input(
                    "bit_depth",
                    default=8,
                    min=8,
                    max=10,
                    step=2,
                    tooltip="Output video bit depth (8 for sRGB, 10 for HDR).",
                ),
                IO.Combo.Input(
                    "color_space",
                    options=["sRGB", "HDR", "HDR PQ"],
                    default="sRGB",
                    tooltip="Output video color space.",
                ),
            ],
            outputs=[
                IO.Video.Output(),
            ],
        )

    @classmethod
    def execute(
        cls,
        images: list[torch.Tensor],
        audio: Optional[list[dict]] = None,
        fps: float = 24.0,
        bit_depth: int = 8,
        color_space: str = "sRGB",
    ) -> IO.NodeOutput:
        # is_input_list=True wraps every param in a single-element list.
        fps = float(_first(fps) or 24.0)
        bit_depth = int(_first(bit_depth) or 8)
        color_space = str(_first(color_space) or "sRGB")

        merged = _concat_images(images)
        merged_audio = _concat_audio(audio)
        return IO.NodeOutput(
            VideoFromComponents(
                components=VideoComponents(
                    images=merged,
                    audio=merged_audio,
                    frame_rate=Fraction(fps),
                ),
                bit_depth=bit_depth,
                color_space=color_space,
            )
        )


def _concat_images(images: list[torch.Tensor]) -> torch.Tensor:
    """Concat per-segment batches into a single (B, H, W, C) tensor.

    Empty / None entries are dropped. Each entry must be a 4D image tensor.
    Defensively unwraps a possible [[t1, t2, ...]] nesting.
    """
    if images is None:
        raise ValueError("MiniMaxH3DirectorConcat: `images` is empty — nothing to encode.")
    # is_input_list on an already-list output should not double-wrap, but be safe.
    if isinstance(images, (list, tuple)) and len(images) == 1 and isinstance(images[0], (list, tuple)):
        images = list(images[0])
    if not isinstance(images, (list, tuple)):
        images = [images]
    cleaned: list[torch.Tensor] = []
    for i, img in enumerate(images):
        if img is None:
            continue
        if not isinstance(img, torch.Tensor):
            raise ValueError(f"MiniMaxH3DirectorConcat: images[{i}] is not a tensor (got {type(img).__name__})")
        if img.ndim == 3:
            img = img.unsqueeze(0)
        if img.ndim != 4:
            raise ValueError(f"MiniMaxH3DirectorConcat: images[{i}] must be 4D [B,H,W,C], got shape {tuple(img.shape)}")
        if int(img.shape[0]) <= 0:
            continue
        cleaned.append(img)
    if not cleaned:
        raise ValueError("MiniMaxH3DirectorConcat: all segments produced 0 frames.")
    if len(cleaned) == 1:
        return cleaned[0].cpu().float()
    return torch.cat(cleaned, dim=0).cpu().float()


def _concat_audio(audio_list: Optional[list[Optional[dict]]]) -> Optional[dict]:
    """Concatenate per-segment audio dicts along the time axis.

    Handles:
      * None / empty list  → None (silent video).
      * Mixed-None list    → gaps are dropped (segments without audio are skipped).
      * Different sample rates → resample to the first non-None rate (lightweight).
      * Mixed channel counts   → up-mix mono to the max channel count across segments.
    The output dict shape is {"waveform": Tensor[B, C, T], "sample_rate": int}.
    """
    if not audio_list:
        return None
    # Defensive unwrap of a possible [[a1, a2, ...]] nesting.
    if isinstance(audio_list, (list, tuple)) and len(audio_list) == 1 and isinstance(audio_list[0], (list, tuple)):
        audio_list = list(audio_list[0])
    if not isinstance(audio_list, (list, tuple)):
        return None
    cleaned = [a for a in audio_list if isinstance(a, dict) and "waveform" in a]
    if not cleaned:
        return None
    if len(cleaned) == 1:
        a = cleaned[0]
        return {"waveform": a["waveform"].cpu().float(), "sample_rate": int(a["sample_rate"])}

    target_sr = int(cleaned[0]["sample_rate"])
    waves = [cleaned[0]["waveform"]]
    for i in range(1, len(cleaned)):
        wave = cleaned[i]["waveform"]
        sr = int(cleaned[i]["sample_rate"])
        if not isinstance(wave, torch.Tensor) or wave.numel() <= 0:
            continue
        if sr != target_sr:
            try:
                import torchaudio  # local optional
                wave = torchaudio.functional.resample(wave, sr, target_sr)
            except Exception as exc:
                _log.warning(
                    "MiniMaxH3DirectorConcat: skipping resample %d→%d Hz (%s); "
                    "skipping audio segment %d to keep sample rate consistent.",
                    sr, target_sr, exc, i,
                )
                continue
        waves.append(wave)
    if not waves:
        return None
    # Normalize channel count: up-mix mono to stereo if mixed.
    max_ch = max(int(w.shape[1]) for w in waves if w.ndim == 3) if any(w.ndim == 3 for w in waves) else 1
    aligned = []
    for w in waves:
        if w.ndim == 2:
            w = w.unsqueeze(0)
        if w.ndim != 3:
            continue
        if int(w.shape[1]) < max_ch:
            w = w.expand(-1, max_ch, -1).contiguous()
        aligned.append(w)
    if not aligned:
        return None
    merged = torch.cat(aligned, dim=2).cpu().float()
    return {"waveform": merged, "sample_rate": target_sr}


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3DirectorConcat": MiniMaxH3DirectorConcat,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3DirectorConcat": "MiniMax H3 Director Concat",
}
