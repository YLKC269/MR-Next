"""T8 双时钟采样（Dual-Clock Sampler）——内置实现，保持音频完整性。

为什么要它
----------
H3 不是单一模型，而是一个**联合音视频 Transformer**：画面跑 24fps，音频跑自己的
~40Hz 时钟。官方 ``ModelSamplingAV`` 的做法是：把音频 latent **按 audio_scale
缩放后骑在视频时钟上**（``audio_scale = shift_video / shift_audio``，12/3 = 4×），
audio 的 sigma 由视频 sigma 经 ``time_shift_sigma`` 反推。

这在 20 步慢速渲染下没问题，但切到 4/8 步极速（Turbo 蒸馏 LoRA）时，
**音频要在同样极少的步数里跨过 4 倍的 sigma 跨度** → 最后一步被迫拉到异常值
→ 输出刺耳白噪声 / 爆音。这就是社区反馈的「H3 四步出片音频报废」。

T8 的解法（本模块移植其算法）
----------------------------
让音频**在自己的时钟上推进**，与视频步数解耦：
- video：``sigma_v`` 直接走 sigmas 序列，更新量 ``video_delta = sigma_v_next - sigma_v``；
- audio：``sigma_a = time_shift_sigma(sigma_v, shift_v, shift_a)``，
  更新量 ``audio_delta = sigma_a_next - sigma_a``（**不是** video_delta）。

每步把 packed latent 拆成两段各自更新：
``x = cat(x_v + d_v * video_delta, x_a + d_a * audio_delta)``。

与官方的等价性
--------------
在 ``sigma_v == sigma_a``（即 shift_v == shift_a，或 sigma=1 起点的整步）时，
两种写法给出相同结果；差异只在音频确实需要"自己的时钟"时才显现。
本实现返回 ``audio_scale = 1.0``（音频不再被缩放骑到视频时钟上），
否则会把变换做两遍（官方 model.py 的 forward 会用 audio_scale 再反解一次）。

参考：github.com/T8mars/comfyui-minimax-h3-audio-T8 的 h3_t8/sampling.py，
按本节点需要精简移植（去掉 multirate/二次采样等无关分支），语义保持一致。
"""

from __future__ import annotations

import logging
import math
from typing import Any, Callable

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.dual_clock_sampling")

# T8 的默认采样器/调度器名（其原生双时钟路径）
DUAL_CLOCK_SAMPLER = "dual_clock_euler"
NATIVE_FLOW_SCHEDULER = "native_flow"
BETA57_SCHEDULER = "beta57"
BETA57_ALPHA = 0.5
BETA57_BETA = 0.7

# H3 AV latent 的通道约定（官方 MiniMaxH3AVDecode / MiniMaxH3ReferenceToVideo 同款）
VIDEO_CHANNELS = 24
AUDIO_CHANNELS = 32


def shift_sigma(base_sigma, shift: float):
    """把 base 网格上的 sigma 按给定 shift 重排。"""
    return shift * base_sigma / (1.0 + (shift - 1.0) * base_sigma)


def time_shift_sigma(sigma, from_shift: float, to_shift: float):
    """视频时钟的 sigma → 音频时钟的 sigma（官方 model.py 同款公式）。

    先反解回 base 网格，再套另一个 shift。等价于 comfy.ldm.minimax.model.time_shift_sigma。
    """
    base_sigma = sigma / (from_shift + sigma * (1.0 - from_shift))
    return shift_sigma(base_sigma, to_shift)


def time_shift_slope(sigma, from_shift: float, to_shift: float):
    """d(sigma_audio) / d(sigma_video)——老版 ComfyUI 的音频速度乘过这个数。"""
    base_sigma = sigma / (from_shift + sigma * (1.0 - from_shift))
    numerator = to_shift * (1.0 + (from_shift - 1.0) * base_sigma) ** 2
    denominator = from_shift * (1.0 + (to_shift - 1.0) * base_sigma) ** 2
    return numerator / denominator


def native_flow_sigmas(steps: int, shift_video: float):
    """shifted uniform：base 上等距 → 套 video shift。官方 H3 flow 的原生调度。"""
    import torch

    base_sigmas = torch.linspace(1.0, 0.0, int(steps) + 1, dtype=torch.float32)
    return shift_sigma(base_sigmas, float(shift_video))


def make_scheduler_sigmas(model_sampling, scheduler: str, steps: int, shift_video: float):
    """按调度器名算 sigmas 序列（native_flow / beta57 / 原生 comfy 调度器）。"""
    if scheduler == NATIVE_FLOW_SCHEDULER:
        return native_flow_sigmas(steps, shift_video)
    if scheduler == BETA57_SCHEDULER:
        import comfy.samplers

        beta_scheduler = getattr(comfy.samplers, "beta_scheduler", None)
        if beta_scheduler is None:
            raise RuntimeError(
                "beta57 需要较新的 ComfyUI（内置 beta scheduler）；请更新 ComfyUI 后重启"
            )
        return beta_scheduler(
            model_sampling, int(steps), alpha=BETA57_ALPHA, beta=BETA57_BETA
        ).cpu()
    import comfy.samplers

    if scheduler not in comfy.samplers.SCHEDULER_NAMES:
        raise ValueError(
            f"未知调度器 {scheduler!r}；可用：{NATIVE_FLOW_SCHEDULER}、"
            f"{BETA57_SCHEDULER}、以及 comfy 原生 {len(comfy.samplers.SCHEDULER_NAMES)} 个"
        )
    return comfy.samplers.calculate_sigmas(model_sampling, scheduler, int(steps)).cpu()


def audio_steps_to_sigmas(steps_audio: int, shift_video: float, shift_audio: float):
    """音频独立步数 → 音频时钟上的 sigma 序列（用于"音频多跑几步"）。

    做法：在视频 sigmas 上等距采 ``steps_audio + 1`` 个点，再换算到音频时钟。
    这样音频每一步跨的 sigma 更小 → 音频在低步数下也能平滑收敛（这正是
    "保持音频完整性" 的机制：不让音频跟着视频的粗步长被拉爆）。
    """
    import torch

    video_sigmas = native_flow_sigmas(steps_audio, shift_video)
    return time_shift_sigma(video_sigmas, float(shift_video), float(shift_audio))


def _to_sigma_1d(sigmas) -> Any:
    import torch

    if torch.is_tensor(sigmas):
        return sigmas.detach().float().cpu().reshape(-1)
    return torch.tensor([float(x) for x in sigmas], dtype=torch.float32)


def _latent_video_values(latent) -> tuple[int, int]:
    """从 packed AV latent 解出 (video_values, packed_values)。

    官方把 video 与 audio 拼在最后一维；nested 形式则 unbind 成两段。
    video 通道 24 / audio 通道 32 且 audio 的 t 维为 2（官方约定）。
    """
    import torch

    if hasattr(latent, "is_nested") and latent.is_nested:
        streams = latent.unbind()
        if len(streams) < 2:
            raise ValueError(f"H3 AV latent 的 nested 流少于 2 段：{len(streams)}")
        video_values = math.prod(streams[0].shape[1:])
        packed_values = video_values + math.prod(streams[1].shape[1:])
        return int(video_values), int(packed_values)

    shape = tuple(latent.shape)
    # packed 形式：[..., C_total]；无法从单形状区分时按通道数推断：24 + 32*2
    if len(shape) >= 2 and int(shape[-1]) in (VIDEO_CHANNELS + AUDIO_CHANNELS * 2,):
        video_values = VIDEO_CHANNELS
        return int(video_values), int(shape[-1])
    # fallback：按 24 + 64 约定
    log.warning("无法从 latent 形状 %s 明确解出音视频切分，按 24 / 24+64 约定", shape)
    return VIDEO_CHANNELS, VIDEO_CHANNELS + AUDIO_CHANNELS * 2


def sample_dual_clock_euler(
    model,
    x,
    sigmas,
    *,
    video_values: int,
    packed_values: int,
    shift_video: float,
    shift_audio: float,
    extra_args: dict | None = None,
    callback: Callable | None = None,
    disable=None,
    audio_step_sigmas=None,
    audio_velocity_is_raw: bool = True,
):
    """双时钟 Euler 采样：视频走 sigmas，音频走它自己的时钟。

    参数
    ----
    video_values / packed_values : packed latent 里 video 段与总长（最后一维）。
    audio_step_sigmas            : 若给出，音频用自己的 sigma 序列（多步）独立推进；
                                   否则音频按视频 sigmas 换算到音频时钟跟随推进。
    audio_velocity_is_raw        : 新版 ComfyUI H3 直接给原始音频速度（audio_scale=1）。

    返回与输入同形的采样结果。
    """
    import torch
    import comfy.utils
    from comfy.k_diffusion.sampling import to_d

    extra_args = {} if extra_args is None else dict(extra_args)
    if int(x.shape[-1]) != int(packed_values):
        raise ValueError(
            "H3 packed latent 在采样器建立后发生改变："
            f"期望 {packed_values} 个值，实际 {int(x.shape[-1])}"
        )

    denoise_mask = extra_args.get("denoise_mask")
    audio_mask = None
    if denoise_mask is not None:
        if int(denoise_mask.shape[-1]) != int(packed_values):
            raise ValueError("H3 denoise mask 与 packed AV latent 不匹配")
        audio_mask = denoise_mask[..., int(video_values):]

    sigma_seq = _to_sigma_1d(sigmas)
    audio_seq = (
        _to_sigma_1d(audio_step_sigmas) if audio_step_sigmas is not None else None
    )

    s_in = x.new_ones([x.shape[0]])
    n_steps = len(sigma_seq) - 1
    # 循环次数 = 视频步数：H3 是**联合**音视频模型（深层 attention 跨模态交互），
    # 视频与音频必须在同一次前向里一起更新。音频"走自己的时钟"体现在
    # **更新量**用 Δσ_a 而非 Δσ_v，而不是另开一条独立循环。
    total = n_steps
    n_audio = (len(audio_seq) - 1) if audio_seq is not None else n_steps

    for step in comfy.utils.model_trange(total, disable=disable):
        # ── 视频：直接在当前 sigmas 上推进 ──
        sigma_v = sigma_seq[step]
        sigma_v_next = sigma_seq[step + 1]
        video_delta = sigma_v_next - sigma_v

        # ── 音频：在自己的时钟上推进 ──
        if audio_seq is not None:
            # 音频步数可能与视频不同：把当前进度按比例映射到音频序列的对应区间，
            # 保证音频始终覆盖它自己的 σ_a: 1→0 全程（不会被视频步数截断）。
            if n_audio >= n_steps:
                a_start = int(round(step * n_audio / n_steps))
                a_end = int(round((step + 1) * n_audio / n_steps))
            else:
                a_start = min(step, n_audio - 1)
                a_end = min(step + 1, n_audio)
            a_start = max(0, min(a_start, len(audio_seq) - 2))
            a_end = max(a_start + 1, min(a_end, len(audio_seq) - 1))
            sigma_a = audio_seq[a_start]
            sigma_a_next = audio_seq[a_end]
            audio_delta = sigma_a_next - sigma_a
        else:
            sigma_a = time_shift_sigma(sigma_v, shift_video, shift_audio)
            sigma_a_next = time_shift_sigma(sigma_v_next, shift_video, shift_audio)
            audio_delta = sigma_a_next - sigma_a
            if not audio_velocity_is_raw:
                # 老版 ComfyUI 的音频速度乘过 d(sigma_a)/d(sigma_v)，更新量要取逆
                slope_audio = time_shift_slope(sigma_v, shift_video, shift_audio)
                audio_delta = audio_delta / slope_audio

        if audio_mask is not None:
            # 被遮罩的行（如锁定音频）跟随视频更新量，保持原样
            audio_delta = video_delta + audio_mask * (audio_delta - video_delta)

        # 模型前向：视频用视频 sigma（H3 的 forward 会自行从视频 sigma 反推音频时钟）
        denoised = model(x, sigma_v * s_in, **extra_args)
        derivative = to_d(x, sigma_v, denoised)

        if callback is not None:
            callback({
                "x": x,
                "i": step,
                "sigma": sigma_v,
                "sigma_hat": sigma_v,
                "denoised": denoised,
            })

        x = torch.cat((
            x[..., :int(video_values)] + derivative[..., :int(video_values)] * video_delta,
            x[..., int(video_values):] + derivative[..., int(video_values):] * audio_delta,
        ), dim=-1)

    return x


def build_dual_clock_sampler(
    *,
    video_values: int,
    packed_values: int,
    shift_video: float,
    shift_audio: float,
    audio_step_sigmas=None,
    audio_velocity_is_raw: bool = True,
):
    """构造 shape-bound 的 T8 双时钟 KSAMPLER（给 SamplerCustomAdvanced 用）。"""
    import comfy.samplers

    def sampler_function(model_wrap, x, sigmas, extra_args=None, callback=None, disable=None):
        return sample_dual_clock_euler(
            model_wrap,
            x,
            sigmas,
            video_values=video_values,
            packed_values=packed_values,
            shift_video=shift_video,
            shift_audio=shift_audio,
            extra_args=extra_args,
            callback=callback,
            disable=disable,
            audio_step_sigmas=audio_step_sigmas,
            audio_velocity_is_raw=audio_velocity_is_raw,
        )

    sampler_function.__name__ = "sample_dual_clock_euler"
    sampler_function._h3_dual_clock = True
    sampler_function._h3_video_values = int(video_values)
    sampler_function._h3_packed_values = int(packed_values)
    sampler_function._h3_shift_video = float(shift_video)
    sampler_function._h3_shift_audio = float(shift_audio)
    sampler_function._h3_audio_velocity_is_raw = bool(audio_velocity_is_raw)

    return comfy.samplers.KSAMPLER(sampler_function)


def model_uses_raw_audio_velocity(model) -> bool:
    """检测新版 ComfyUI H3 采样协议（base_model 暴露 audio_scale 即视为新版）。"""
    base_model = getattr(model, "model", None)
    return callable(getattr(base_model, "audio_scale", None))


class _DualClockModelSampling:
    """占位说明：双时钟路径需要 model_sampling.audio_scale == 1.0。

    这里不直接构造类，而是在 setup 里动态派生，避免 import 期依赖 comfy 版本差异。
    """


def install_dual_clock_model_sampling(model, shift_video: float, shift_audio: float):
    """给 model 装上「音频不被缩放骑到视频时钟」的 sampling 对象。

    与官方 ``MiniMaxH3SigmaShift`` 的区别只有一处：``audio_scale`` 返回 1.0。
    官方路径把音频按 12/3=4× 缩放后骑在视频时钟上；双时钟路径音频走自己的时钟，
    所以不能再缩放（否则 model.py 的 forward 会把它反解回去 → 变换做两遍）。
    """
    import comfy.model_sampling

    patched = model.clone()
    av_cls = getattr(comfy.model_sampling, "ModelSamplingAV", None)
    if av_cls is None:
        raise RuntimeError(
            "本 ComfyUI 缺少 ModelSamplingAV，无法使用双时钟采样；请更新 ComfyUI"
        )

    class MiniMaxH3DualClockSampling(av_cls, comfy.model_sampling.CONST):
        @property
        def audio_scale(self):
            # 双时钟：音频在自己的时钟上推进，采样器不再把它缩放骑到视频时钟。
            return 1.0

    original = model.get_model_object("model_sampling")
    model_sampling = MiniMaxH3DualClockSampling(model.model.model_config)
    model_sampling.set_parameters(shift=float(shift_video), audio_shift=float(shift_audio))
    if hasattr(original, "noise_scale"):
        model_sampling.set_noise_scale(original.noise_scale)
    patched.add_object_patch("model_sampling", model_sampling)

    to = patched.model_options.get("transformer_options", {}).copy()
    to["minimax_h3_sigma_shift_video"] = float(shift_video)
    to["minimax_h3_sigma_shift_audio"] = float(shift_audio)
    patched.model_options["transformer_options"] = to
    return patched


def dump_schedule(
    steps: int,
    steps_audio: int,
    shift_video: float,
    shift_audio: float,
) -> list[dict]:
    """诊断用：列出每步 video/audio 的 sigma 与更新量，验证两个时钟确实解耦。"""
    import torch

    v = native_flow_sigmas(steps, shift_video)
    if steps_audio and int(steps_audio) != int(steps):
        a = audio_steps_to_sigmas(int(steps_audio), shift_video, shift_audio)
    else:
        a = time_shift_sigma(v, shift_video, shift_audio)
    rows = []
    for i in range(len(v) - 1):
        sv, svn = float(v[i]), float(v[i + 1])
        ai = min(i, len(a) - 2)
        sa, san = float(a[ai]), float(a[ai + 1])
        rows.append({
            "step": i,
            "sigma_video": sv,
            "sigma_video_next": svn,
            "video_delta": svn - sv,
            "sigma_audio": sa,
            "sigma_audio_next": san,
            "audio_delta": san - sa,
        })
    return rows
