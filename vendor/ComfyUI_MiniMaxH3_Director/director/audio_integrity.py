"""音频完整性审计（Audio Integrity Audit）——音轨的输出端保险。

（注：T8 双时钟采样方案已整体移除，采样固定走官方单时钟；本模块只负责
**输出阶段**的音频完整性。）

本模块解决的问题
----------------
音轨解码 + 裁剪 + 拼接之后，长度/采样率是否与画面严格对齐，
是否出现爆音/直流跳变/尾接头等异常。

为什么需要它
------------
音频要经过「VAE 解码 → 去掉 motion-context 前缀 → 裁到导出长度 → 多段拼接」
四道工序，每一步都可能让样本数与 ``frames / fps * sr`` 差几十个采样点。
差一点点在音画同步上听不出来，但：
- 拼接多段时误差会**累加**；
- 差得多了就是"音频提前/延后结束"，用户实报过。

所以要**如实测量并告警**，而不是静默。

设计原则（对齐 T8 `audio_integrity_advanced.py`）
------------------------------------------------
1. **只报告、不改动**（report_only=True / audio_mutated=False）——避免审计本身引入失真；
2. **阈值保守**——宁可 ABSTAIN 让人去听，也不要误改好音频；
3. **信号启发式不当作结论**——输出里带 ``limitations``，明确说明"疑似"不是"确诊"。

阈值取值（与 T8 同源）
----------------------
- 音画边界偏差 > 21ms（约半帧 @24fps）→ 告警；
- 开头相邻样本跳变 ≥ 0.15 且是后段 p99.5 的 4 倍以上 → 疑似爆音；
- 10ms 块 DC 均值跳变 ≥ 0.02 → 疑似直流跳变；
- 头尾 250ms 相关系数 ≥ 0.985 且相对 RMSE ≤ 0.25 → 疑似尾接头；
- 削波样本占比 > 0.1% → 告警。

**两级严重度（本节点与 T8 的关键差异）**
----------------------------------------
T8 的审计是一个独立节点，ABSTAIN 就是它的产出，误报成本低。本模块是**出片流程里的
旁路审计**，如果把"疑似"当"确证"来告警，每跑一次都会刷屏，反而让真正的告警被淹没。

所以把 finding 分成两级：

- ``severity="hard"`` —— 客观可量化的**事实**（时长对不上、NaN、削波）或
  高置信度的**损伤**（爆音、直流跳变）。这些驱动 ``ABSTAIN`` → 写进报告告警。
- ``severity="advisory"`` —— **纯启发式**（尾接头）。周期性配乐、环境底噪、
  刻意的循环都会触发，``纯音 2.0s`` 都能命中。只记录进 report，
  不驱动 ABSTAIN、不进告警行。

这样"保持音频完整性"的告警才有信噪比。
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any, Mapping

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.director.audio_integrity")

AUDIO_INTEGRITY_SCHEMA = "minimax_h3_director_audio_integrity_v1"

# 音画边界允许偏差（毫秒）。半帧 @24fps ≈ 20.8ms，取 21 对齐 T8。
MAX_AV_DELTA_MS = 21.0
# 开头爆音判定
POP_JUMP_THRESHOLD = 0.15
POP_RATIO_THRESHOLD = 4.0
# 直流跳变判定
DC_JUMP_THRESHOLD = 0.02
# 尾接头判定
WRAP_CORRELATION_THRESHOLD = 0.985
WRAP_RELATIVE_RMSE_THRESHOLD = 0.25
# 削波判定
CLIPPING_RATIO_THRESHOLD = 0.001

# finding 两级严重度：hard 驱动 ABSTAIN/告警；advisory 只进报告
SEVERITY_HARD = "hard"
SEVERITY_ADVISORY = "advisory"


def _dbfs(value: float) -> float:
    return 20.0 * math.log10(max(float(value), 1e-12))


def _json(value: Mapping) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _waveform_of(audio: Any):
    """从 AUDIO dict 取出 [B, C, T] float32 CPU 张量；不可用返回 None。"""
    import torch

    if not isinstance(audio, dict):
        return None, 0
    wave = audio.get("waveform")
    if not isinstance(wave, torch.Tensor) or int(wave.numel()) <= 0:
        return None, 0
    sr = int(audio.get("sample_rate") or 0)
    if sr <= 0:
        return None, 0
    if wave.ndim == 1:
        wave = wave.reshape(1, 1, -1)
    elif wave.ndim == 2:
        wave = wave.reshape(1, *wave.shape)
    if wave.ndim != 3:
        return None, sr
    return wave.detach().to(device="cpu", dtype=torch.float32), sr


def analyze_audio_integrity(
    audio: Any,
    *,
    video_frame_count: int = 0,
    fps: float = 24.0,
    label: str = "",
    opening_window_ms: float = 40.0,
    comparison_window_ms: float = 250.0,
) -> tuple[bool, str, dict]:
    """审计单条音轨，返回 ``(ok, decision, report)``。

    ``ok`` 为 False 表示**有 finding**（需要人工听一遍），不是"音频被改坏了"。
    任何异常都不会抛出——审计失败本身返回 ok=True + skipped 报告，
    绝不让一个诊断模块把出片流程带崩。
    """
    try:
        return _analyze(
            audio,
            video_frame_count=video_frame_count,
            fps=fps,
            label=label,
            opening_window_ms=opening_window_ms,
            comparison_window_ms=comparison_window_ms,
        )
    except Exception as exc:  # noqa: BLE001 - 审计绝不阻断出片
        log.warning("音频完整性审计跳过（%s）", exc)
        return True, "SKIPPED", {
            "schema": AUDIO_INTEGRITY_SCHEMA,
            "decision": "SKIPPED",
            "report_only": True,
            "label": str(label or ""),
            "reason": f"{type(exc).__name__}: {exc}",
        }


def _analyze(
    audio: Any,
    *,
    video_frame_count: int,
    fps: float,
    label: str,
    opening_window_ms: float,
    comparison_window_ms: float,
) -> tuple[bool, str, dict]:
    import torch

    wave, sample_rate = _waveform_of(audio)
    if wave is None:
        return True, "SKIPPED", {
            "schema": AUDIO_INTEGRITY_SCHEMA,
            "decision": "SKIPPED",
            "report_only": True,
            "label": str(label or ""),
            "reason": "no_audio_waveform",
        }

    raw = wave
    canonical = torch.nan_to_num(raw)
    sample_count = int(canonical.shape[-1])
    duration_seconds = sample_count / float(sample_rate)
    fps = float(fps or 24.0)
    if fps <= 0.0:
        fps = 24.0
    frame_count = max(0, int(video_frame_count or 0))

    findings: list[dict] = []
    checks: dict[str, Any] = {}

    # ── ① 非有限样本（NaN / Inf）────────────────────────────────
    nonfinite = bool(not torch.isfinite(raw).all())
    if nonfinite:
        findings.append({
            "code": "nonfinite_samples",
            "severity": SEVERITY_HARD,
            "message": "音轨含 NaN 或 Inf 样本。",
        })

    # ── ② 开头爆音 ───────────────────────────────────────────────
    opening_samples = max(2, int(round(opening_window_ms * sample_rate / 1000.0)))
    comparison_samples = max(8, int(round(comparison_window_ms * sample_rate / 1000.0)))
    derivative = (canonical[..., 1:] - canonical[..., :-1]).abs()
    deriv_len = int(derivative.shape[-1])
    opening_count = min(opening_samples, deriv_len)
    opening_derivative = derivative[..., :opening_count]
    baseline_start = min(opening_count, deriv_len)
    baseline_end = min(deriv_len, baseline_start + max(comparison_samples, opening_count))
    baseline_derivative = derivative[..., baseline_start:baseline_end]
    opening_max_jump = float(opening_derivative.amax()) if opening_derivative.numel() else 0.0
    baseline_p995 = (
        float(torch.quantile(baseline_derivative.flatten(), 0.995))
        if baseline_derivative.numel()
        else 0.0
    )
    opening_jump_ratio = opening_max_jump / max(baseline_p995, 1e-8)
    first_sample_abs = float(canonical[..., 0].abs().amax()) if sample_count else 0.0
    opening_flag = bool(
        (opening_max_jump >= POP_JUMP_THRESHOLD and opening_jump_ratio >= POP_RATIO_THRESHOLD)
        or first_sample_abs >= max(0.25, POP_JUMP_THRESHOLD * 2.0)
    )
    checks["opening_transient"] = {
        "evaluated": bool(opening_derivative.numel() and baseline_derivative.numel()),
        "window_ms": float(opening_window_ms),
        "maximum_adjacent_sample_jump": opening_max_jump,
        "later_p995_adjacent_sample_jump": baseline_p995,
        "opening_to_later_jump_ratio": opening_jump_ratio,
        "first_sample_absolute_amplitude": first_sample_abs,
        "threshold": float(POP_JUMP_THRESHOLD),
        "suspected": opening_flag,
    }
    if opening_flag:
        findings.append({
            "code": "suspected_opening_pop_or_cut",
            "severity": SEVERITY_HARD,
            "message": (
                "开头有异常大的不连续（疑似爆音/断点）。这是信号启发式，"
                "不等于确认模型产生了爆音——建议人工听一遍。"
            ),
        })

    # ── ③ 直流跳变（持续均值突变）───────────────────────────────
    block_samples = max(1, int(round(sample_rate * 0.010)))
    block_count = sample_count // block_samples
    dc_context_blocks = max(3, int(round(0.100 * sample_rate / block_samples)))
    if block_count >= dc_context_blocks * 2:
        blocks = canonical[..., : block_count * block_samples].reshape(
            *canonical.shape[:-1], block_count, block_samples
        )
        block_dc = blocks.mean(dim=-1)
        context_means = block_dc.unfold(-1, dc_context_blocks, 1).mean(dim=-1)
        comparison_count = block_count - 2 * dc_context_blocks + 1
        before = context_means[..., :comparison_count]
        after = context_means[..., dc_context_blocks : dc_context_blocks + comparison_count]
        dc_steps = (after - before).abs()
        max_dc_jump = float(dc_steps.amax())
        max_dc_flat = int(dc_steps.reshape(-1).argmax())
        time_axis_index = max_dc_flat % int(dc_steps.shape[-1])
        max_dc_time = (
            time_axis_index + dc_context_blocks
        ) * block_samples / float(sample_rate)
        dc_flag = max_dc_jump >= DC_JUMP_THRESHOLD
    else:
        max_dc_jump = 0.0
        max_dc_time = 0.0
        dc_flag = False
    checks["dc_discontinuity"] = {
        "evaluated": block_count >= dc_context_blocks * 2,
        "block_ms": 10.0,
        "context_ms_per_side": dc_context_blocks * block_samples * 1000.0 / sample_rate,
        "maximum_persistent_context_mean_jump": max_dc_jump,
        "maximum_jump_time_seconds": max_dc_time,
        "threshold": float(DC_JUMP_THRESHOLD),
        "suspected": dc_flag,
    }
    if dc_flag:
        findings.append({
            "code": "suspected_dc_jump",
            "severity": SEVERITY_HARD,
            "message": "疑似直流跳变：某处前后持续均值突变超过阈值。",
        })

    # ── ④ 尾接头（结尾与开头高度相似 = 疑似接回开头）────────────
    compare_count = min(comparison_samples, sample_count // 2)
    wrap_evaluated = compare_count >= max(32, int(round(sample_rate * 0.025)))
    correlation = 0.0
    relative_rmse = float("inf")
    head_rms_dbfs = -240.0
    tail_rms_dbfs = -240.0
    if wrap_evaluated:
        head = canonical[..., :compare_count].flatten().float()
        tail = canonical[..., -compare_count:].flatten().float()
        head_rms_dbfs = _dbfs(float(head.square().mean().sqrt()))
        tail_rms_dbfs = _dbfs(float(tail.square().mean().sqrt()))
        head_centered = head - head.mean()
        tail_centered = tail - tail.mean()
        denominator = float(head_centered.norm() * tail_centered.norm())
        if denominator > 1e-10:
            correlation = float(torch.dot(head_centered, tail_centered) / denominator)
        reference_rms = max(float(head.square().mean().sqrt()), 1e-8)
        relative_rmse = float((head - tail).square().mean().sqrt()) / reference_rms
    wrap_flag = bool(
        wrap_evaluated
        and min(head_rms_dbfs, tail_rms_dbfs) > -50.0
        and correlation >= WRAP_CORRELATION_THRESHOLD
        and relative_rmse <= WRAP_RELATIVE_RMSE_THRESHOLD
    )
    checks["tail_to_head_similarity"] = {
        "evaluated": wrap_evaluated,
        "window_ms": compare_count * 1000.0 / sample_rate if sample_rate else 0.0,
        "normalized_correlation": correlation,
        "relative_rmse": relative_rmse if math.isfinite(relative_rmse) else None,
        "head_rms_dbfs": head_rms_dbfs,
        "tail_rms_dbfs": tail_rms_dbfs,
        "correlation_threshold": float(WRAP_CORRELATION_THRESHOLD),
        "suspected": wrap_flag,
    }
    if wrap_flag:
        findings.append({
            "code": "suspected_tail_wrapped_to_head",
            "severity": SEVERITY_ADVISORY,
            "message": (
                "结尾与开头异常相似（疑似接回开头）。周期性配乐、环境底噪、"
                "纯音都会命中，仅供参考——需要人工听辨，不参与告警。"
            ),
        })

    # ── ⑤ 削波 ───────────────────────────────────────────────────
    clipping_ratio = float((canonical.abs() >= 0.999).float().mean())
    clipping_flag = clipping_ratio > CLIPPING_RATIO_THRESHOLD
    checks["clipping"] = {
        "sample_ratio": clipping_ratio,
        "threshold": float(CLIPPING_RATIO_THRESHOLD),
        "suspected": clipping_flag,
    }
    if clipping_flag:
        findings.append({
            "code": "clipping_ratio_exceeded",
            "severity": SEVERITY_HARD,
            "message": "削波样本占比超过阈值。",
        })

    # ── ⑥ 音画边界（本模块的主检项）─────────────────────────────
    av_delta_ms = 0.0
    if frame_count > 0:
        expected_samples = int(round(frame_count * sample_rate / float(fps)))
        delta_samples = sample_count - expected_samples
        av_delta_ms = delta_samples * 1000.0 / float(sample_rate)
        av_flag = abs(av_delta_ms) > MAX_AV_DELTA_MS
        checks["audio_video_boundary"] = {
            "evaluated": True,
            "video_frame_count": int(frame_count),
            "fps": float(fps),
            "expected_audio_samples": int(expected_samples),
            "actual_audio_samples": sample_count,
            "delta_samples": int(delta_samples),
            "delta_ms": av_delta_ms,
            "maximum_absolute_delta_ms": float(MAX_AV_DELTA_MS),
            "suspected": av_flag,
        }
        if av_flag:
            findings.append({
                "code": "audio_video_boundary_mismatch",
                "severity": SEVERITY_HARD,
                "message": (
                    f"音轨时长与画面不一致：{duration_seconds:.4f}s vs "
                    f"{frame_count / float(fps):.4f}s（{frame_count} 帧 @{fps:g}fps），"
                    f"偏差 {av_delta_ms:+.1f}ms。"
                ),
            })
    else:
        checks["audio_video_boundary"] = {
            "evaluated": False,
            "reason": "video_frame_count_is_zero",
            "actual_audio_samples": sample_count,
        }

    # 只有 hard finding 才算"不合格"——advisory 纯启发式，噪声太大不进告警。
    hard_findings = [f for f in findings if f.get("severity") == SEVERITY_HARD]
    decision = "ABSTAIN" if hard_findings else "PASS"
    report = {
        "schema": AUDIO_INTEGRITY_SCHEMA,
        "decision": decision,
        "report_only": True,
        "audio_mutated": False,
        "label": str(label or ""),
        "sample_rate": int(sample_rate),
        "sample_count": sample_count,
        "duration_seconds": duration_seconds,
        "channels": int(canonical.shape[1]),
        "checks": checks,
        "findings": findings,
        "hard_finding_codes": [f.get("code") for f in hard_findings],
        "advisory_finding_codes": [
            f.get("code") for f in findings if f.get("severity") == SEVERITY_ADVISORY
        ],
        "limitations": [
            "信号启发式不能证明模型层面的说话人串台或因果。",
            "尾接头（advisory）可能是刻意的循环或周期性配乐；先听再判断。",
            "PASS 只代表没有触发 hard 启发式，不等于听觉认证。",
        ],
    }
    return (not hard_findings), decision, report


def check_export_audio_integrity(
    audio_out: list,
    *,
    frame_counts: list[int] | None = None,
    fps: float = 24.0,
    audio_mode: str = "generate",
    muted: bool = False,
) -> tuple[bool, list[str], dict]:
    """审计一次出片的全部 AUDIO 输出（与 ``images_out`` 1:1 对齐）。

    返回 ``(all_ok, report_lines, summary)``。
    ``report_lines`` 是给节点日志/report 字符串用的中文告警行（仅在有问题时非空）。
    """
    lines: list[str] = []
    entries: list[dict] = []
    if muted or not audio_out:
        return True, lines, {
            "schema": AUDIO_INTEGRITY_SCHEMA,
            "checked": 0,
            "skipped_reason": "muted_or_no_audio",
        }

    all_ok = True
    for i, audio in enumerate(audio_out):
        n_frames = 0
        if frame_counts is not None and i < len(frame_counts):
            n_frames = int(frame_counts[i] or 0)
        ok, decision, report = analyze_audio_integrity(
            audio,
            video_frame_count=n_frames,
            fps=fps,
            label=f"segment_{i + 1}" if len(audio_out) > 1 else "timeline",
        )
        if decision == "SKIPPED":
            continue
        boundary = (report.get("checks") or {}).get("audio_video_boundary") or {}
        entries.append({
            "index": i,
            "decision": decision,
            "sample_rate": report.get("sample_rate"),
            "sample_count": report.get("sample_count"),
            "duration_seconds": report.get("duration_seconds"),
            "delta_ms": boundary.get("delta_ms"),
            "hard_findings": report.get("hard_finding_codes") or [],
            "advisory_findings": report.get("advisory_finding_codes") or [],
        })
        if not ok:
            all_ok = False
            codes = ", ".join(report.get("hard_finding_codes") or ["?"])
            delta = boundary.get("delta_ms")
            where = f"#{i + 1} " if len(audio_out) > 1 else ""
            detail = f"（音画偏差 {delta:+.1f}ms）" if isinstance(delta, (int, float)) else ""
            sr = report.get("sample_rate")
            lines.append(
                f"音频完整性告警：{where}{codes}{detail}"
                f"｜{report.get('sample_count')} 样本 @{sr}Hz"
                f"｜建议人工听辨（未自动改动音频）"
            )
        # 单条音轨级别的细节写进 debug，便于排查
        log.debug("audio integrity %s: %s", report.get("label"), _json(report))

    summary = {
        "schema": AUDIO_INTEGRITY_SCHEMA,
        "checked": len(entries),
        "fps": float(fps),
        "audio_mode": str(audio_mode),
        "entries": entries,
        "passed": all_ok,
        "advisory_segments": [
            e["index"] + 1 for e in entries if e.get("advisory_findings")
        ],
    }
    return all_ok, lines, summary


def align_samples_to_frames(sample_count: int, frame_count: int, fps: float, sample_rate: int) -> dict:
    """算出一段音轨相对画面的采样点偏差（诊断/断言用）。"""
    expected = int(round(max(0, int(frame_count)) * int(sample_rate) / float(fps or 24.0)))
    return {
        "expected_samples": expected,
        "actual_samples": int(sample_count),
        "delta_samples": int(sample_count) - expected,
        "delta_ms": (int(sample_count) - expected) * 1000.0 / float(sample_rate or 1),
        "within_tolerance": abs((int(sample_count) - expected) * 1000.0 / float(sample_rate or 1))
        <= MAX_AV_DELTA_MS,
    }
