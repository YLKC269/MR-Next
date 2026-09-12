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
    attention_accel: str = "off",
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

    # ── 注意力加速（可选，默认 off）──
    # Block-Sparse-Attention / SageAttention 补丁在采样前打到 model 上。
    # 走 `optimized_attention_override` 通道，失败一律静默回退官方 attention
    # （见 attention_accel.patch_model 的 fail-open 契约），绝不阻断出片。
    _accel_note = ""
    try:
        from .attention_accel import ACCEL_OFF, patch_model, resolve_mode

        want = str(attention_accel or ACCEL_OFF).strip().lower()
        if want and want != ACCEL_OFF:
            actual, _accel_note = resolve_mode(want)
            if _accel_note:
                log.warning("H3 注意力加速：%s", _accel_note)
            if actual != ACCEL_OFF:
                model_use = patch_model(model_use, actual)
                log.info("H3 注意力加速已启用：%s", actual)
    except Exception as exc:  # noqa: BLE001 - 加速绝不能阻断出片
        log.warning("H3 注意力加速装配失败，按官方 attention 运行：%s", exc)

    # ── 采样路径：官方单时钟（唯一路径）──
    # T8 双时钟方案已整体移除（实验分支，跑不出片的代价远大于收益）。
    # `dual_clock` / `steps_audio` 形参**保留但一律忽略**：Director 节点的这两个 widget
    # 槽位还在（ComfyUI 的 widgets_values 是按下标序列化的，抽掉会让所有已保存工作流的
    # 后续参数整体错位），传进来的值不再有任何效果。
    if apply_shift:
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3SigmaShift

        # 注意：用 model_use（已打注意力加速补丁）而不是 model ——
        # SigmaShift 会 clone model，clone 保留 model_options，补丁得以透传。
        shifted = MiniMaxH3SigmaShift.execute(
            model_use, float(shift_video), float(shift_audio)
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
