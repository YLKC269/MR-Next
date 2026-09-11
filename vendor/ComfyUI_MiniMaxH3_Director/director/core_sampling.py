"""Single-stage sampling via official MiniMax H3 custom-sampler nodes.

Matches ``video_minimax_h3_r2v.json``:
MiniMaxH3SigmaShift → BasicScheduler → BasicGuider (or CFGGuider) →
KSamplerSelect → RandomNoise → SamplerCustomAdvanced.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.core_sampling")

# H3 AV latent 的通道约定（与 dual_clock_sampling 保持一致）：
# video 24 通道；audio 32 通道且立体声 t 维为 2 → 只在「最后一维就是通道数」时用于回退切分。
VIDEO_CHANNELS = 24
AUDIO_CHANNELS = 32

# T8 双时钟（实验分支）解不出 AV 切分时的行为：
# False = 记录告警并**回退官方单时钟**（保证一定出片）；True = 抛 ValueError。
# 双时钟只是可选实验路径，任何情况下都不允许它阻断出片。
DUAL_CLOCK_STRICT = False

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


def _stream_values(shape) -> int:
    """一个流的元素数 = prod(shape[1:])（丢掉 batch 维）。"""
    n = 1
    for d in tuple(shape)[1:]:
        n *= int(d)
    return int(n)


def _shapes_to_dual_clock(latent_shapes) -> tuple[int, int] | None:
    """由 ComfyUI 的 ``latent_shapes``（每流的原始形状）算 (video_values, packed_values)。

    ``comfy.utils.pack_latents`` 把每个流 reshape 成 ``[B, 1, prod(shape[1:])]`` 再
    沿最后一维 cat 起来 —— 所以 packed 总长是各流元素数**相加**，不是相乘。
    """
    if not latent_shapes or len(latent_shapes) < 2:
        return None
    video_values = _stream_values(latent_shapes[0])
    packed_values = sum(_stream_values(s) for s in latent_shapes)
    return video_values, packed_values


def _dual_clock_latent_shape(latent, model=None) -> tuple[int, int] | None:
    """从 AV latent 解出 (video_values, packed_values)——双时钟要用它切音视频段。

    三种来源，按可靠性排序：
    1. 模型自报的 ``latent_shapes``（官方 ``inner_sample`` 在采样前设置，
       ``[video_shape, audio_shape, ...]``）—— 唯一权威来源；
    2. latent 是 **nested**（``NestedTensor``）→ 直接 unbind 逐流算元素数再相加；
    3. latent 是 **packed** ``[B, 1, C_total]`` 单张量 —— 无法从形状反推切分点，
       只有 video/audio 各占一段时可按 H3 通道约定回退（video 24 通道 / audio 32×2）。

    **解不出时返回 None（不抛错）**：双时钟是可选实验分支，绝不允许它阻断出片；
    调用方见到 None 就回退官方单时钟路径。
    """
    # ① 权威：模型在采样前塞进来的 per-stream 形状
    shapes = None
    for holder in (model, getattr(model, "inner_model", None)):
        if holder is None:
            continue
        cand = getattr(holder, "latent_shapes", None)
        if cand:
            shapes = cand
            break
    resolved = _shapes_to_dual_clock(shapes)
    if resolved is not None:
        return resolved

    # ② nested：unbind 出 [video, audio, ...]，逐流算元素数再相加
    if hasattr(latent, "is_nested") and latent.is_nested:
        try:
            streams = latent.unbind()
        except Exception as exc:  # noqa: BLE001 - 解不出就回退原生
            log.warning("双时钟：nested latent 解包失败（%s）→ 回退官方单时钟", exc)
            return None
        if len(streams) < 2:
            log.warning("双时钟：nested latent 流少于 2 段（%d）→ 回退官方单时钟", len(streams))
            return None
        video_values = _stream_values(streams[0].shape)
        packed_values = sum(_stream_values(s.shape) for s in streams)
        return int(video_values), int(packed_values)

    # ③ packed 单张量回退：按 H3 通道约定（video 24 / audio 32 且立体声 2）
    shape = tuple(getattr(latent, "shape", ()))
    if len(shape) >= 2:
        total = int(shape[-1])
        # 形如 [B, N, C] 且最后一维就是通道数时才敢按通道切
        if total == VIDEO_CHANNELS + AUDIO_CHANNELS * 2:
            return int(VIDEO_CHANNELS), int(total)
    log.warning(
        "双时钟：无法从 AV latent 解出切分（latent 形状=%s、latent_shapes=%r）"
        "→ 回退官方单时钟采样（不影响出片）",
        shape,
        shapes,
    )
    if DUAL_CLOCK_STRICT:
        raise ValueError(
            f"无法从 AV latent 解出双时钟切分：latent 形状={shape}、"
            f"latent_shapes={shapes!r}；请确认使用的是 H3 原生 AV latent"
            "（EmptyMiniMaxH3LatentAV），或从模型传入 latent_shapes。"
        )
    return None


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

    # ── 采样路径分流 ──
    # **默认走官方单时钟**（`MiniMaxH3SigmaShift` → BasicScheduler → …），这是唯一
    # 被验证能稳定出片的路径。T8 双时钟（音频走自己的时钟 `audio_delta=σ_a_next−σ_a`、
    # `audio_scale=1.0`，低步数 Turbo 更稳）只是**可选实验分支**：
    #   * 必须显式 dual_clock=True 才尝试；
    #   * 一旦无法解出 AV 切分（非 nested 且模型没给 latent_shapes），
    #     **立刻回退官方单时钟并告警 —— 绝不抛错阻断出片**。
    sampler_obj = None
    if bool(dual_clock):
        from .dual_clock_sampling import (
            NATIVE_FLOW_SCHEDULER,
            build_dual_clock_sampler,
            install_dual_clock_model_sampling,
            make_scheduler_sigmas,
            model_uses_raw_audio_velocity,
        )

        split = _dual_clock_latent_shape(latent, model)
        if split is None:
            log.warning("T8 双时钟不可用 → 本次采样回退官方单时钟（不影响出片）")
        else:
            video_values, packed_values = split
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

            sampler_obj = build_dual_clock_sampler(
                video_values=video_values,
                packed_values=packed_values,
                shift_video=float(shift_video),
                shift_audio=float(shift_audio),
                audio_step_sigmas=audio_sigmas,
                audio_velocity_is_raw=model_uses_raw_audio_velocity(model),
            )

    if sampler_obj is None:
        # ── 官方单时钟（默认 / 双时钟不可用时的回退）──
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
