"""H3 注意力加速：官方 Block-Sparse-Attention / SageAttention 后端选择与探测。

设计三条铁律（沿用 T8 双时钟踩坑教训）：
1. **默认关闭**：`off` 是默认；加速是可选分支，永不影响出片。
2. **失败必回退**：任何后端不可用 / 调用抛错 → 静默回退官方 `optimized_attention`，
   只打一条告警，**绝不中断采样**。
3. **真探测，不猜**：`probe()` 用真实的 import + kernel 符号 + 一次小张量冒烟，
   而不是只看模块名在不在。

后端说明
--------
* ``block_sparse`` —— 官方 mit-han-lab **Block-Sparse-Attention**（`block_sparse_attn_func`），
  FlashVSR / SpargeAttn 系同源。kernel 支持 **sm_80 – sm_100**，1<<seqlen 用 128×128 块掩码。
  ⚠ 需要本地编译（PyPI 无包、release 无预编译轮子），且 nvcc 主版本必须与 torch 一致。
* ``sage`` —— SageAttention（已装且 sm_89 kernel 可用）。零新依赖，H3 上就是官方
  「加速版」工作流用的 `MiniMaxH3MemoryEfficientSageAttentionPatch` 同款路径。
* ``off`` —— 官方 `optimized_attention`（最稳，默认）。

Block-Sparse 的掩码语义：H3 是**联合音视频 packed 序列**，跨模态必须全attend（音频要给
画面对口型）。所以这里用「块内全 1」的掩码 —— 等价于把完整 attention 拆成 128×128 块，
让 kernel 走稀疏路径（省显存、走 TensorCore int8），**不改变数值语义**。
要真正丢块（牺牲精度换速度）可下调 `sparsity`。
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.attention_accel")

# 加速模式
ACCEL_OFF = "off"
ACCEL_SAGE = "sage"
ACCEL_BLOCK_SPARSE = "block_sparse"

ACCEL_MODES = (ACCEL_OFF, ACCEL_SAGE, ACCEL_BLOCK_SPARSE)

# 人类可读标签（前端下拉用；顺序即优先级展示）
ACCEL_LABELS = {
    ACCEL_OFF: "关闭（官方 attention）",
    ACCEL_SAGE: "SageAttention（int8，已装可用）",
    ACCEL_BLOCK_SPARSE: "官方 Block-Sparse-Attention",
}

# Block-Sparse kernel 的块大小（官方固定 128×128）
BLOCK_M = 128
BLOCK_N = 128

# 序列短于该值时稀疏无意义（kernel 还会更慢），直接走原生
MIN_SPARSE_SEQ = 3000

_probe_cache: dict | None = None


def _triton_ok() -> bool:
    try:
        import triton  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def _cuda_cc() -> tuple[int, int] | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        return tuple(int(x) for x in torch.cuda.get_device_capability(0))  # type: ignore[return-value]
    except Exception:  # noqa: BLE001
        return None


def _sm_tag() -> str:
    cc = _cuda_cc()
    return f"sm_{cc[0]}{cc[1]}" if cc else "unknown"


def _probe_block_sparse() -> tuple[bool, str]:
    """能不能真跑 block_sparse_attn_func。"""
    try:
        from block_sparse_attn import block_sparse_attn_func  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "DLL load failed" in msg or "not found" in msg.lower():
            return False, "已安装但动态库加载失败（多为 CUDA 主版本与 torch 不一致）"
        return False, "未安装 block_sparse_attn（需本地编译，见 README）"

    cc = _cuda_cc()
    if cc is None:
        return False, "无可用 CUDA 设备"
    # 官方 kernel 支持 sm_80 – sm_100；sm_110+（Thor）与 sm_75 不支持
    if not (8, 0) <= cc <= (10, 0):
        return False, f"GPU {_sm_tag()} 不在 kernel 支持范围（sm_80–sm_100）"
    if not _triton_ok():
        return False, "缺少 triton"

    if os.environ.get("MRNEXT_ACCEL_SMOKE", "1") == "0":
        return True, f"可用（{_sm_tag()}，未做张量冒烟）"

    # 真实冒烟：小张量跑一次，确认 kernel 真能执行（而不只是 import 成功）
    try:
        import torch

        dev = torch.device("cuda")
        seqlen, heads, dim = 256, 2, 64
        q = torch.randn(seqlen, heads, dim, dtype=torch.float16, device=dev)
        k = torch.randn(seqlen, heads, dim, dtype=torch.float16, device=dev)
        v = torch.randn(seqlen, heads, dim, dtype=torch.float16, device=dev)
        cu = torch.tensor([0, seqlen], dtype=torch.int32, device=dev)

        import math

        nblk = (seqlen + BLOCK_M - 1) // BLOCK_M
        mask = torch.ones((1, heads, nblk, nblk), dtype=torch.bool, device=dev)
        out = block_sparse_attn_func(
            q.unsqueeze(0), k.unsqueeze(0), v.unsqueeze(0),
            cu, cu,
            torch.tensor([1] * heads, dtype=torch.int32, device=dev),
            None,
            mask,
            seqlen, seqlen,
            0.0,
            softmax_scale=1.0 / math.sqrt(dim),
            is_causal=False,
        )
        if out is None or not torch.isfinite(out).all():
            return False, "冒烟输出非法（NaN/Inf）"
    except Exception as exc:  # noqa: BLE001
        return False, f"冒烟失败：{type(exc).__name__}: {str(exc)[:160]}"

    return True, f"可用（{_sm_tag()}, 块 {BLOCK_M}×{BLOCK_N}）"


def _probe_sage() -> tuple[bool, str]:
    try:
        from sageattention import sageattn  # noqa: F401
    except Exception:  # noqa: BLE001
        return False, "未安装 sageattention"

    cc = _cuda_cc()
    if cc is None:
        return False, "无可用 CUDA 设备"
    if cc[0] < 8 and cc != (7, 5):
        return False, f"GPU {_sm_tag()} 不受支持（需 sm_75 或 sm_80+）"

    if os.environ.get("MRNEXT_ACCEL_SMOKE", "1") == "0":
        return True, f"可用（{_sm_tag()}，未做张量冒烟）"

    try:
        import torch

        dev = torch.device("cuda")
        q = torch.randn(1, 2, 256, 64, dtype=torch.float16, device=dev)
        out = sageattn(q, q, q, tensor_layout="NHD", is_causal=False)
        if out is None or not torch.isfinite(out).all():
            return False, "冒烟输出非法（NaN/Inf）"
    except Exception as exc:  # noqa: BLE001
        return False, f"冒烟失败：{type(exc).__name__}: {str(exc)[:160]}"

    return True, f"可用（{_sm_tag()}）"


def probe(force: bool = False) -> dict:
    """探测各加速后端可用性（结果缓存；force=True 重探）。"""
    global _probe_cache
    if _probe_cache is not None and not force:
        return _probe_cache

    bs_ok, bs_note = _probe_block_sparse()
    sage_ok, sage_note = _probe_sage()
    _probe_cache = {
        "block_sparse": {"available": bs_ok, "note": bs_note, "label": ACCEL_LABELS[ACCEL_BLOCK_SPARSE]},
        "sage": {"available": sage_ok, "note": sage_note, "label": ACCEL_LABELS[ACCEL_SAGE]},
        "off": {"available": True, "note": "始终可用", "label": ACCEL_LABELS[ACCEL_OFF]},
        "sm": _sm_tag(),
        "triton": _triton_ok(),
    }
    return _probe_cache


def resolve_mode(requested: str | None) -> tuple[str, str]:
    """把用户请求的模式解析成**实际可用**的模式。

    返回 ``(实际模式, 告警文本)``；告警为空表示原样生效。
    ``off`` 永远安全；请求的后端不可用则降级到 ``sage``（若可用）→ 否则 ``off``。
    """
    mode = str(requested or ACCEL_OFF).strip().lower()
    if mode not in ACCEL_MODES:
        mode = ACCEL_OFF
    if mode == ACCEL_OFF:
        return ACCEL_OFF, ""

    info = probe()
    if info.get(mode, {}).get("available"):
        return mode, ""

    note = info.get(mode, {}).get("note", "不可用")
    # 降级链：block_sparse → sage → off
    if mode == ACCEL_BLOCK_SPARSE and info["sage"]["available"]:
        return ACCEL_SAGE, f"Block-Sparse 不可用（{note}）→ 已降级到 SageAttention"
    return ACCEL_OFF, f"{ACCEL_LABELS.get(mode, mode)} 不可用（{note}）→ 已关闭加速"


def mode_items() -> list[tuple[str, str]]:
    """给前端/INPUT_TYPES 的下拉项：``[(key, label), ...]``。"""
    return [(k, ACCEL_LABELS[k]) for k in ACCEL_MODES]


def availability_report() -> str:
    """一行中文可用性摘要（写进运行报告 / dry dump）。"""
    info = probe()
    parts = []
    for k in (ACCEL_BLOCK_SPARSE, ACCEL_SAGE):
        d = info[k]
        parts.append(f"{ACCEL_LABELS[k]}={'✓' if d['available'] else '✗'}（{d['note']}）")
    return f"GPU {info['sm']}｜" + "｜".join(parts)


# ────────────────────────── 采样期补丁 ──────────────────────────


def _block_mask_all_ones(seqlen: int, heads: int, device) -> "object":
    """块内全 1 的 128×128 掩码（等价完整 attention，只走稀疏 kernel 路径）。"""
    import torch

    nblk = (seqlen + BLOCK_M - 1) // BLOCK_M
    return torch.ones((1, heads, nblk, nblk), dtype=torch.bool, device=device)


def _apply_block_sparse(q, k, v, heads: int, sparsity: float = 0.0, **kwargs):
    """走官方 block_sparse_attn_func。

    输入/输出均为 **HND** 布局 ``[B, H, S, D]``（H3 的 ``Attention.forward`` 就是
    这么传的：``q.transpose(0,1).unsqueeze(0)`` 且 ``skip_reshape=True``）。

    ``sparsity`` 在 [0,1)：0 = 完整 attention；>0 时按块丢弃远端块（加速但降质量）。
    """
    import math

    import torch
    from block_sparse_attn import block_sparse_attn_func

    b, h, s, d = q.shape
    # kernel 要 [(B*S), H, D] + cu_seqlens
    qf = q.transpose(1, 2).reshape(b * s, h, d).contiguous()
    kf = k.transpose(1, 2).reshape(b * s, h, d).contiguous()
    vf = v.transpose(1, 2).reshape(b * s, h, d).contiguous()

    dev = q.device
    cu = torch.tensor([0, b * s], dtype=torch.int32, device=dev)
    head_mask_type = torch.tensor([1] * h, dtype=torch.int32, device=dev)

    mask = _block_mask_all_ones(b * s, h, dev)
    if sparsity and float(sparsity) > 0.0:
        nblk = mask.shape[-1]
        idx = torch.arange(nblk, device=dev)
        dist = (idx.view(1, -1) - idx.view(-1, 1)).abs()
        keep = max(1, int(round(nblk * (1.0 - float(sparsity)))))
        mask = (dist <= keep // 2).unsqueeze(0).unsqueeze(0).expand(1, h, nblk, nblk).contiguous()

    out = block_sparse_attn_func(
        qf.unsqueeze(0), kf.unsqueeze(0), vf.unsqueeze(0),
        cu, cu,
        head_mask_type,
        None,
        mask,
        b * s, b * s,
        0.0,
        softmax_scale=1.0 / math.sqrt(d),
        is_causal=False,
    )
    # [1, B*S, H, D] -> [B, H, S, D]
    return out.squeeze(0).reshape(b, s, h, d).transpose(1, 2).contiguous()


def _apply_sage(q, k, v, heads: int, **kwargs):
    """走 SageAttention（HND 布局，int8 TensorCore）。

    H3 传进来就是 HND（``skip_reshape=True``），sageattn 原生支持 HND，
    所以**不需要**转置 —— 白白转两趟只会多占显存。
    """
    from sageattention import sageattn

    # 只透传 sage 认识的标量，其余（transformer_options 等）必须剥掉
    call_kw = {k: v for k, v in kwargs.items() if k in ("scale", "sm_scale")}
    if "scale" in call_kw:
        call_kw["sm_scale"] = call_kw.pop("scale")
    return sageattn(
        q, k, v,
        tensor_layout="HND",
        is_causal=False,
        smooth_k=False,
        **call_kw,
    )


def _split_container_kwargs(kwargs: dict) -> dict:
    """kernel 只认 q/k/v/heads；其余（transformer_options 等）剥掉再传。"""
    return {k: v for k, v in kwargs.items() if k in ("scale",)}


def _to_hnd(raw, ref):
    """把原生回退的输出规整成 HND ``[B, H, S, D]``（与 q 同形）。

    H3 的 ``Attention.forward`` 是 ``q.transpose(0,1).unsqueeze(0)`` 传进来的
    （HND），最后 ``out.squeeze(0)``；所以 override 必须还它 **4D HND**。
    但原生分支在 ``skip_output_reshape=False`` 时出 ``[B, S, H*D]``（3D）——
    这里按形状判定并转置，只有确实错位才动，已经是对的就不动（零拷贝）。
    """
    try:
        if raw is None or not hasattr(raw, "shape"):
            return raw
        if tuple(raw.shape) == tuple(ref.shape):
            return raw  # 已经是对的
        b, h, s, d = (int(x) for x in ref.shape)
        # 3D [B, S, H*D] → 4D HND
        if raw.dim() == 3 and raw.shape[0] == b and raw.shape[1] == s and raw.shape[2] == h * d:
            return raw.reshape(b, s, h, d).transpose(1, 2).contiguous()
        # 4D 但 H/S 错位 → 转置回来
        if raw.dim() == 4 and raw.shape[1] == s and raw.shape[2] == h:
            return raw.transpose(1, 2).contiguous()
    except Exception:  # noqa: BLE001 - 规整失败也别影响出片
        return raw
    return raw


def _restore_output_layout(t, ref, kwargs):
    """把加速后的输出**还原成调用方契约要求的形状**（镜像 ComfyUI 原生实现）。

    ComfyUI 的原生容器实现 ``_attention_comfy_kitchen_int8_containers`` 末尾是：

        if not skip_output_reshape:
            out = out.transpose(1, 2).reshape(b, -1, heads * dim_head)
        return out

    也就是说 ``skip_output_reshape`` 默认 False → **返回 3D ``[B, S, H*D]``**，
    只有显式 ``True`` 才返回 HND ``[B, H, S, D]``。

    H3 的 ``Attention.forward`` 正是这种调用方：它把返回值直接交给
    ``self.out_proj(out.squeeze(0))``，而 ``out_proj = Linear(heads*head_dim, hidden)``
    —— 必须拿到 ``[S, H*D]``。

    ⚠ 本模块以前**无条件**返回 HND（见 ``_to_hnd`` 的老注释），于是 ``out_proj``
    收到的 k 是 head_dim 而不是 heads*head_dim → comfy_kitchen int8 后端断言
    ``Input and weight inner dimensions must match``（现象：H3 采样第一步就崩，
    且报错信息完全不提 attention）。这是「开 sage 加速就采样失败」的真凶。
    """
    try:
        if t is None or not hasattr(t, "dim"):
            return t
        if kwargs.get("skip_output_reshape", False):
            return t                      # 调用方明确要 HND → 原样返回
        b, h, s, d = (int(x) for x in ref.shape)   # ref 是 HND [B,H,S,D]
        if t.dim() == 4 and int(t.shape[0]) == b and int(t.shape[2]) == s:
            return t.transpose(1, 2).reshape(b, s, h * d)
        if t.dim() == 3 and int(t.shape[1]) == s and int(t.shape[2]) == h * d:
            return t                      # 已经是 [B, S, H*D]
    except Exception:  # noqa: BLE001 - 布局还原失败也绝不阻断出片
        return t
    return t


def _call_native(func, q, k, v, heads, kwargs):
    """回退官方 attention。

    ⚠ ``optimized_attention`` / 传进来的 ``func`` **本身都被 ``@wrap_attn`` 装饰**，
    它们默认 ``skip_reshape=False``，而 H3 给的是 ``[B, H, S, D]`` 的 HND 张量
    → 不显式声明 ``skip_reshape=True`` 会按 ``[B, S, H*D]`` 解包而报
    ``too many values to unpack (expected 3)``。
    """
    call_kw = dict(kwargs)
    call_kw.setdefault("skip_reshape", True)
    if func is not None:
        return func(q, k, v, heads, **call_kw)
    from comfy.ldm.modules.attention import optimized_attention

    return optimized_attention(q, k, v, heads, **call_kw)


def build_attention_override(mode: str, *, sparsity: float = 0.0, min_seq: int = MIN_SPARSE_SEQ):
    """给 ``transformer_options["optimized_attention_override"]`` 用的可调用对象。

    ComfyUI 的调用契约（见 ``comfy/ldm/modules/attention.py: wrap_attn``）：

        override(func, q, k, v, heads, **kwargs)   # func = 被选中的 attention（回退用）

    另有 ``container_function`` 通道：当 q/k/v 还是 ``AttentionTensorContainer``
    （H3 的 ``Attention.forward`` 正是这么传的）时优先走它，由我们来 ``take()``。
    两条都挂上，保证各种调用姿势都能命中。

    ⚠ **回退一律给裸张量 + 显式 ``skip_reshape=True``**：``optimized_attention``
    自己就是 ``@wrap_attn`` 装饰的，再喂容器会被解包两次；且它默认按
    ``[B, S, H*D]`` 解包，而 H3 给的是 HND → 必须显式声明。

    短序列 / 后端抛错 → 回退原生，只告警一次。
    容器已 ``take()`` 过 → 回退时**直接复用它**（把张量塞回新容器即可），
    避免重复计算，也避免 ``peek()`` 在已消费时报错。
    """

    _warned: set[str] = set()

    def _note_fallback(exc: Exception) -> None:
        key = type(exc).__name__
        if key not in _warned:
            _warned.add(key)
            log.warning(
                "H3 注意力加速（%s）失败，已回退官方 attention：%s: %s",
                mode, type(exc).__name__, str(exc)[:200],
            )

    def _run(q, k, v, heads, **kwargs):
        """真实计算；返回 None 表示「该回退」。"""
        seq = int(q.shape[-2]) if hasattr(q, "shape") and q.dim() >= 2 else 0
        if seq < int(min_seq):
            return None
        call_kw = _split_container_kwargs(kwargs)
        try:
            if mode == ACCEL_BLOCK_SPARSE:
                return _apply_block_sparse(q, k, v, heads, sparsity=sparsity, **call_kw)
            if mode == ACCEL_SAGE:
                return _apply_sage(q, k, v, heads, **call_kw)
        except Exception as exc:  # noqa: BLE001 - 加速绝不能中断采样
            _note_fallback(exc)
        return None

    def _override(func, q, k, v, heads, **kwargs):
        out = _run(q, k, v, int(heads), **kwargs)
        if out is not None:
            # sage / block_sparse 出 HND → 按调用方契约还原（默认要 [B, S, H*D]）
            return _restore_output_layout(_to_hnd(out, q), q, kwargs)
        return _call_native(func, q, k, v, heads, kwargs)

    def _override_containers(q, k, v, heads, **kwargs):
        """容器通道：先 take() 出真实张量；回退时给裸张量（容器已消费）。

        ⚠ `wrap_attn` 对 container_function 通道是**原样转发**，不像默认通道那样
        会 `take()` 后再调 —— 所以这里返回什么形状，调用方就拿到什么形状。

        布局契约（必须与 ComfyUI 原生 ``_attention_comfy_kitchen_int8_containers``
        一致）：内部按 HND 计算，返回前交给 ``_restore_output_layout`` 还原 ——
        ``skip_output_reshape=False``（H3 的用法）→ ``[B, S, H*D]``；显式 True → HND。
        """
        from comfy.ldm.modules.attention import AttentionTensorContainer

        try:
            qq, kk, vv = q.take(), k.take(), v.take()
        except Exception as exc:  # noqa: BLE001
            # 容器已被消费（同一 override 被调两次）→ 只能重新包回去交给原生
            _note_fallback(exc)
            return _call_native(
                None,
                AttentionTensorContainer(q.peek()),
                AttentionTensorContainer(k.peek()),
                AttentionTensorContainer(v.peek()),
                heads,
                kwargs,
            )
        out = _run(qq, kk, vv, int(heads), **kwargs)
        if out is not None:
            return out
        try:
            raw = _call_native(None, qq, kk, vv, heads, kwargs)
        except Exception as exc:  # noqa: BLE001
            # 直接喂裸 HND 不被接受 → 重新包成容器（容器是新造的，未消费）
            _note_fallback(exc)
            raw = _call_native(
                None,
                AttentionTensorContainer(qq),
                AttentionTensorContainer(kk),
                AttentionTensorContainer(vv),
                heads,
                kwargs,
            )
        return _restore_output_layout(_to_hnd(raw, qq), qq, kwargs)

    _override.__name__ = f"mrnext_h3_accel_{mode}"
    _override._mrnext_accel_mode = mode  # type: ignore[attr-defined]
    _override.container_function = _override_containers  # type: ignore[attr-defined]
    return _override


def patch_model(model, mode: str, *, sparsity: float = 0.0, min_seq: int = MIN_SPARSE_SEQ):
    """把加速补丁打到 model 上（返回**新** model；mode=off 原样返回）。

    走 `model_options["transformer_options"]["optimized_attention_override"]` ——
    这条通道 ComfyUI 原生支持，且 H3 的 ``Attention.forward`` 已经把
    ``transformer_options`` 透传给了 ``optimized_attention``，所以不需要
    逐 block 改 forward（比 KJNodes 的 per-block patch 更轻、更不容易和别的补丁打架）。
    """
    if mode == ACCEL_OFF:
        return model
    try:
        model_clone = model.clone()
        override = build_attention_override(mode, sparsity=sparsity, min_seq=min_seq)
        opts = model_clone.model_options.setdefault("transformer_options", {})
        prev = opts.get("optimized_attention_override")
        if prev is not None and getattr(prev, "__name__", "").startswith("mrnext_h3_accel_"):
            log.info("H3 注意力加速：覆盖已有的 MRNext 加速补丁 → %s", mode)
        opts["optimized_attention_override"] = override
        return model_clone
    except Exception as exc:  # noqa: BLE001
        log.warning("H3 注意力加速补丁失败，按原样使用模型：%s", exc)
        return model


__all__ = [
    "ACCEL_OFF",
    "ACCEL_SAGE",
    "ACCEL_BLOCK_SPARSE",
    "ACCEL_MODES",
    "ACCEL_LABELS",
    "probe",
    "resolve_mode",
    "mode_items",
    "availability_report",
    "build_attention_override",
    "patch_model",
]
