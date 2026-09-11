"""Single-stage sampling via official MiniMax H3 custom-sampler nodes.

Matches ``video_minimax_h3_r2v.json``:
MiniMaxH3SigmaShift → BasicScheduler → BasicGuider (or CFGGuider) →
KSamplerSelect → RandomNoise → SamplerCustomAdvanced.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.core_sampling")

PhaseCallback = Callable[[str, float], None]
StepPreviewCallback = Callable[[int, int, Any], None]


def _unpack_node_output(out):
    if hasattr(out, "args"):
        args = out.args
        if args:
            return args
    if isinstance(out, (tuple, list)):
        return out
    raise RuntimeError(f"Unexpected node output type: {type(out)!r}")


def _use_basic_guider(cfg: float, negative) -> bool:
    """Official r2v template uses BasicGuider (no CFG)."""
    if negative:
        return False
    return abs(float(cfg) - 1.0) < 1e-6


def _dual_clock_latent_shape(latent) -> tuple[int, int]:
    """从 packed AV latent 解出 (video_values, packed_values)——双时钟要用它切音视频段。

    优先读模型自报的 ``latent_shapes``（官方在采样前会设置），其次按 latent 结构推断。
    """
    import torch

    # nested 形式：unbind 出 [video, audio, ...]
    if hasattr(latent, "is_nested") and latent.is_nested:
        streams = latent.unbind()
        if len(streams) >= 2:
            vv = 1
            for d in streams[0].shape[1:]:
                vv *= int(d)
            pv = vv
            for d in streams[1].shape[1:]:
                pv *= int(d)
            return int(vv), int(pv)

    # packed 形式：[..., C_total]
    shape = tuple(getattr(latent, "shape", ()))
    if len(shape) >= 2:
        total = int(shape[-1])
        # H3：video 24 通道；audio 32 通道 × 2（立体声）→ 24 + 64 = 88
        if total == 88:
            return 24, 88
        # 其他形状：无法可靠拆分时按 24 通道 video 处理，音频取剩余
        if total > 24:
            return 24, total
    raise ValueError(
        f"无法从 AV latent 形状解出双时钟切分：shape={shape}；"
        "请确认使用的是 H3 原生 AV latent（EmptyMiniMaxH3LatentAV）"
    )


def sample_single_stage(
    *,
    model,
    positive,
    negative,
    latent,
    seed: int,
    cfg: float,
    steps: int,
    sampler_name: str,
    scheduler: str,
    shift_video: float = 12.0,
    shift_audio: float = 3.0,
    on_phase: PhaseCallback | None = None,
    on_step_preview: StepPreviewCallback | None = None,
    preview_every: int = 1,
    denoise: float = 1.0,
    phase_name: str = "sample",
    sigmas=None,
    apply_shift: bool = True,
    dual_clock: bool = False,
    steps_audio: int = 0,
):
    import torch
    from comfy_extras.nodes_custom_sampler import (
        BasicGuider,
        BasicScheduler,
        CFGGuider,
        KSamplerSelect,
        RandomNoise,
        SamplerCustomAdvanced,
    )

    def notify(phase: str, value: float) -> None:
        if on_phase:
            on_phase(phase, value)

    notify(phase_name, 0)
    model_use = model

    # ── 双时钟（T8）路径 ──
    # 音频走自己的时钟、不再被缩放骑到视频时钟上（audio_scale=1.0），
    # 避免 4/8 步极速采样时音频被拉到异常值 → 爆音/白噪声。
    # 这条路径必须绕开官方 MiniMaxH3SigmaShift（它用的是 audio_scale=12/3 的骑乘语义）。
    use_dual_clock = bool(dual_clock)
    if use_dual_clock:
        from .dual_clock_sampling import (
            DUAL_CLOCK_SAMPLER,
            NATIVE_FLOW_SCHEDULER,
            build_dual_clock_sampler,
            install_dual_clock_model_sampling,
            make_scheduler_sigmas,
            model_uses_raw_audio_velocity,
        )

        model_use = install_dual_clock_model_sampling(model, shift_video, shift_audio)

        # 步数：视频按 steps；音频若显式给了 steps_audio 就用自己的序列，
        # 否则把视频 sigmas 换算到音频时钟跟随（仍比官方骑乘更"自己的时钟"）。
        audio_sigmas = None
        if sigmas is not None:
            # 外部传了显式 sigmas（如二次采样）→ 视频用它；音频按时钟换算。
            sigma_t = sigmas.detach().float().cpu().reshape(-1) if torch.is_tensor(sigmas) \
                else torch.tensor([float(x) for x in sigmas], dtype=torch.float32)
            from .dual_clock_sampling import time_shift_sigma

            audio_sigmas = time_shift_sigma(sigma_t, float(shift_video), float(shift_audio))
        elif int(steps_audio) > 0 and int(steps_audio) != int(steps):
            from .dual_clock_sampling import audio_steps_to_sigmas

            # 音频独立步数：视频 sigmas 仍是 steps 步，音频走自己的 steps_audio 步。
            sigma_out = BasicScheduler.execute(
                model_use, str(scheduler), int(steps), max(0.0, min(1.0, float(denoise)))
            )
            sigma_t = _unpack_node_output(sigma_out)[0]
            audio_sigmas = audio_steps_to_sigmas(int(steps_audio), shift_video, shift_audio)
        else:
            sigma_out = BasicScheduler.execute(
                model_use, str(scheduler), int(steps), max(0.0, min(1.0, float(denoise)))
            )
            sigma_t = _unpack_node_output(sigma_out)[0]

        video_values, packed_values = _dual_clock_latent_shape(latent)
        sampler_obj = build_dual_clock_sampler(
            video_values=video_values,
            packed_values=packed_values,
            shift_video=float(shift_video),
            shift_audio=float(shift_audio),
            audio_step_sigmas=audio_sigmas,
            audio_velocity_is_raw=model_uses_raw_audio_velocity(model),
        )
    else:
        if apply_shift:
            from comfy_extras.nodes_minimax_h3 import MiniMaxH3SigmaShift

            shifted = MiniMaxH3SigmaShift.execute(
                model, float(shift_video), float(shift_audio)
            )
            model_use = _unpack_node_output(shifted)[0]

        if sigmas is not None:
            if torch.is_tensor(sigmas):
                sigma_t = sigmas.detach().float().cpu().reshape(-1)
            else:
                sigma_t = torch.tensor([float(x) for x in sigmas], dtype=torch.float32)
        else:
            denoise_use = float(max(0.0, min(1.0, denoise)))
            sigma_out = BasicScheduler.execute(
                model_use, str(scheduler), int(steps), denoise_use
            )
            sigma_t = _unpack_node_output(sigma_out)[0]

        sampler_obj = _unpack_node_output(KSamplerSelect.execute(str(sampler_name)))[0]

    noise_obj = _unpack_node_output(RandomNoise.execute(int(seed)))[0]

    neg = negative if negative else []
    if _use_basic_guider(cfg, neg):
        guider = _unpack_node_output(BasicGuider.execute(model_use, positive))[0]
    else:
        guider = _unpack_node_output(
            CFGGuider.execute(model_use, positive, neg, float(cfg))
        )[0]

    def _run_official() -> dict:
        sampled = SamplerCustomAdvanced.execute(
            noise_obj, guider, sampler_obj, sigma_t, latent
        )
        return _unpack_node_output(sampled)[0]

    if on_step_preview is None:
        out = _run_official()
    else:
        orig_sample = guider.sample
        every = max(1, int(preview_every))

        def sample_wrapped(noise, latent_image, sampler, sigmas_in, **kwargs):
            inner_cb = kwargs.get("callback")

            def callback(step, x0, x, total_steps):
                try:
                    last = max(0, int(total_steps) - 1)
                    if int(preview_every) < 0:
                        show = step >= last
                    else:
                        show = step % every == 0 or step >= last
                    if show:
                        on_step_preview(int(step), int(total_steps), x0)
                except Exception as exc:
                    log.debug("Step preview callback skipped: %s", exc)
                if inner_cb is not None:
                    inner_cb(step, x0, x, total_steps)

            kwargs["callback"] = callback
            return orig_sample(noise, latent_image, sampler, sigmas_in, **kwargs)

        guider.sample = sample_wrapped
        try:
            out = _run_official()
        finally:
            guider.sample = orig_sample

    notify(phase_name, 1)
    return out
