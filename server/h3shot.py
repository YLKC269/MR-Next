"""h3shot.py — 官方 MiniMax H3 Director 引擎 · 逐镜成片（媒体感知，修复版）。

两套构图（官方 example 载荷模板 + 确定性替换）：
  t2v                    → MiniMaxH3Director 单节点（timeline_data 深替换 prompt/帧数）
  i2v / fl2v / fl2v_tail → Group(ImageToVideo) 外部组 → Combine → director.i2v_groups
  r2v                    → Group(ReferenceToVideo) 外部组 → Combine → director.r2v_groups
节点 id 用数字字符串；链接一律 [node_id, slot]。顶层 no_wrap 陷阱：node_id 不得再套层。
"""

import asyncio
import glob
import hashlib
import json
import math
import os
import re
import shutil
import threading
import time
import uuid

import folder_paths

TEMPLATE = {
    "t2v": "minimax_h3_director_t2v.json",
    "fl2v": "minimax_h3_director_fl2v.json",
    "fl2v_tail": "minimax_h3_director_fl2v.json",
    "r2v": "minimax_h3_director_external_groups_r2v.json",
    "i2v": "minimax_h3_director_external_groups_i2v.json",
}
_GROUP_MODES = {"i2v", "fl2v", "fl2v_tail", "r2v"}
_H3_PREFIX = "mrnext_h3shot"

# ---------------------------------------------------------------- 外部节点接口
# 用户可以在画布上自己接「模型节点」和「第三方加速节点」；一旦外接，本节点的内置加速
# 必须整体让路 —— 内置 sage / 加速 LoRA 都会改写模型与噪声调度，与外部加速
# 叠加会变成"双重加速"（调度被改两遍 → 画面发灰、显存反而爆）。
_ACCEL_OPT_KEYS = ("attention_accel", "sage_attention", "sparse_attention", "speed_lora")
_ACCEL_OPT_LABEL = {
    "attention_accel": "内置注意力加速",
    "sage_attention": "BlockSparse/SageAttention",
    "sparse_attention": "BlockSparse/SageAttention",
    "speed_lora": "加速 LoRA（蒸馏）",
}
_ACCEL_KIND_CN = {
    "sage": "SageAttention/BlockSparse", "compile": "torch.compile", "cache": "TeaCache/缓存加速",
    "attention": "FlashAttention/注意力替换", "quant": "量化(Nunchaku/torchao)",
    "memory": "分块显存优化", "other": "第三方加速",
}

# 外部节点的分类规则（模型加载器匹配 role，其余命中加速规则算加速节点）
_EXT_MODEL_RULES = (
    ("unet", re.compile(r"unet|diffusion|gguf|nunchaku|transformer|model_?loader|checkpoint", re.I)),
    ("clip", re.compile(r"clip|text_?encoder|t5|llm", re.I)),
    ("vae", re.compile(r"vae", re.I)),
    ("lora", re.compile(r"lora", re.I)),
)
_EXT_ACCEL_RULES = (
    ("sage", re.compile(r"sage", re.I)),
    ("cache", re.compile(r"teacache|deepcache|magcache|first_?block_?cache|cachedit|block_?cache|wavelet", re.I)),
    ("compile", re.compile(r"compile|inductor", re.I)),
    ("attention", re.compile(r"flash_?attn|flash_?attention|xformers|attention_?patch|sdpa", re.I)),
    ("quant", re.compile(r"nunchaku|torchao|fp8_?quant|quantize", re.I)),
    ("memory", re.compile(r"block_?swap|blockswap|memory_?efficient|tile|offload", re.I)),
)
# 本包自己的节点与内置构件：不算"外部"（否则自己扫自己，直接误判）
_EXT_SELF_RE = re.compile(r"MRBoard|MRNext|MiniMaxH3MemoryEfficientSageAttentionPatch|MiniMaxH3Director", re.I)
# 这两类虽含 sage/accelerate 字样，但属于"我们自己内置链路会用到的官方节点"，单独放行
_EXT_ALLOW_RE = re.compile(r"^(PathchSageAttentionKJ|MiniMaxH3MemoryEfficientSageAttentionPatch)$", re.I)


def scan_external_nodes(graph):
    """扫描工作流图，找出外部「模型节点」与「第三方加速节点」。

    graph 可以是 app.graph.serialize() 的结果（{nodes:[{id,type,widgets_values}...]}），
    也可以是别处导出的工作流 JSON。返回结构化结果 + 建议（是否让内置加速失效）。
    """
    nodes = []
    if isinstance(graph, dict):
        nodes = graph.get("nodes") or []
        if not isinstance(nodes, list):
            nodes = []
    models, accels = [], []
    flat = {}
    for n in nodes:
        if not isinstance(n, dict):
            continue
        typ = str(n.get("type") or n.get("class_type") or "").strip()
        if not typ:
            continue
        if _EXT_SELF_RE.search(typ) and not _EXT_ALLOW_RE.match(typ):
            continue
        nid = str(n.get("id") if n.get("id") is not None else "")
        vals = n.get("widgets_values")
        vals = vals if isinstance(vals, list) else []
        role = ""
        for k, rx in _EXT_MODEL_RULES:
            if rx.search(typ):
                role = k
                break
        if role:
            v0 = str(vals[0]) if vals else ""
            rec = {"id": nid, "type": typ, "role": role,
                   "value": v0, "values": [str(x) for x in vals[:4]],
                   # 文件名看着不像 H3/MiniMax 的 → 前端给个 ⚠ 提示（避免一键采用成 SDXL 之类的模型）
                   "compatible": (not v0) or bool(re.search(r"minimax|h3", v0, re.I))}
            models.append(rec)
            if role == "vae" and vals:
                nm = str(vals[0])
                if "audio" in nm.lower():
                    flat.setdefault("audio_vae", nm)
                else:
                    flat.setdefault("video_vae", nm)
            elif role in ("unet", "clip", "lora") and vals:
                flat.setdefault(role, str(vals[0]))
            continue
        for k, rx in _EXT_ACCEL_RULES:
            if rx.search(typ):
                accels.append({"id": nid, "type": typ, "kind": k})
                break
    kinds = []
    for a in accels:
        if a["kind"] not in kinds:
            kinds.append(a["kind"])
    note = ""
    if accels:
        names = "、".join(_ACCEL_KIND_CN.get(k, k) for k in kinds)
        note = ("检测到 %d 个外部加速节点（%s）→ 本节点内置加速会自动失效，避免双重加速。"
                "若你确实要和内置加速叠加，请在「⚡加速」页勾选「强制启用内置加速」。"
                % (len(accels), names))
    if models:
        note += ("" if not note else " ") + ("同时检测到 %d 个外部模型节点，可一键「采用」它们已选的模型文件。" % len(models))
    return {"models": models, "accels": accels, "kinds": kinds, "flat": flat, "note": note.strip()}


def apply_external_accel_gate(opts):
    """内置加速的"让路"逻辑：外接了加速节点 → 内置加速整体失效。

    返回 (新 opts, note)。note 为 None 表示没有触发让路。
    """
    o = dict(opts or {})
    ext = o.get("external_accel")
    if isinstance(ext, str):
        ext = [x for x in re.split(r"[,;\s]+", ext) if x]
    kinds = [str(x).strip() for x in (ext or []) if str(x).strip()]
    if not kinds:
        return o, None
    cn = "、".join(_ACCEL_KIND_CN.get(k, k) for k in kinds)
    if o.get("force_builtin_accel"):
        return o, "已检测到外部加速节点（%s），但你勾选了「强制启用内置加速」→ 内置加速照常生效（可能双重加速）" % cn
    dropped = []
    for k in _ACCEL_OPT_KEYS:
        v = o.get(k)
        if v is None or v == "" or str(v).lower() in ("off", "disabled", "false", "0", "(无)"):
            continue
        lbl = _ACCEL_OPT_LABEL.get(k, k)
        if lbl not in dropped:
            dropped.append(lbl)
        o.pop(k, None)
    o["_accel_gate"] = kinds
    note = "已检测到外部加速节点（%s）→ 本节点内置加速已自动失效" % cn
    if dropped:
        note += "（原本启用：" + "、".join(dropped) + "）"
    else:
        note += "（内置加速原本就是关闭状态）"
    return o, note


def attention_accel_probe():
    """内置注意力加速的后端可用性探测（给前端下拉做 ⚠/✓ 提示）。

    直接按文件加载 vendor 的 attention_accel 模块 —— 不走包导入，避免在
    HTTP 请求里拉起整个 ComfyUI。返回结构永远完整；任何异常都降级成
    「全部不可用」而不是抛错（前端只是拿它显示提示，不该因此报错）。

    ⚠ **服务进程里必须跳过 GPU 张量冒烟**：此时 ComfyUI 已经持有 CUDA 上下文，
    新起一个进程去跑冒烟会和主进程抢卡（实测直接 hang 住请求）。
    冒烟只在真正的采样进程里跑；这里的 import + 算力范围检查足以判断
    「装没装 / 卡支不支持」—— 真到采样时失败了也会安全回退。
    """
    import importlib.util
    import os

    pkg = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(pkg, "vendor", "ComfyUI_MiniMaxH3_Director", "director", "attention_accel.py")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    spec = importlib.util.spec_from_file_location("mrnext_attention_accel", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    prev = os.environ.get("MRNEXT_ACCEL_SMOKE")
    os.environ["MRNEXT_ACCEL_SMOKE"] = "0"
    try:
        info = mod.probe(force=True)
    finally:
        if prev is None:
            os.environ.pop("MRNEXT_ACCEL_SMOKE", None)
        else:
            os.environ["MRNEXT_ACCEL_SMOKE"] = prev
    return info


def _glob_h3_outputs(pattern):
    """扫 SaveVideo 产物：根目录 + video/ 子目录都查（SaveVideo 无 subfolder 参数时落根目录）。"""
    out_base = folder_paths.get_output_directory()
    fs = glob.glob(os.path.join(out_base, pattern))
    fs += glob.glob(os.path.join(out_base, "video", pattern))
    return fs


# ---- 生成中实时预览：捕获采样 preview 图（低频、小图、覆盖写，不占资源）----
_LATEST_PREVIEW = {}  # prompt_id -> 最新 preview 图绝对路径


def _preview_dir():
    d = os.path.join(folder_paths.get_output_directory(), "mrnext_preview")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:  # noqa: BLE001
        pass
    return d


def _install_preview_hook():
    """monkeypatch WebUIProgressHandler.update_handler，把采样 preview 图落盘供前端轮询。"""
    try:
        import comfy_execution.progress as _prog
    except Exception:  # noqa: BLE001
        return
    if getattr(_prog.WebUIProgressHandler, "_mrnext_hooked", False):
        return
    _orig = _prog.WebUIProgressHandler.update_handler

    def _patched(self, node_id, value, max_value, state, pid, image=None):
        if image is not None:
            try:
                img = image[1]
                out = os.path.join(_preview_dir(), "latest_%s.jpg" % pid)
                img.save(out, "JPEG", quality=55)
                _LATEST_PREVIEW[pid] = out
            except Exception:  # noqa: BLE001
                pass
        return _orig(self, node_id, value, max_value, state, pid, image)

    _prog.WebUIProgressHandler.update_handler = _patched
    _prog.WebUIProgressHandler._mrnext_hooked = True


def _example_dir():
    """模板目录查找（一体化包优先）：
    ① 本包 vendor/ComfyUI_MiniMaxH3_Director/example_workflows（内嵌引擎，只装本包即可用）
    ② 外部安装的 ComfyUI_MiniMaxH3_Director/example_workflows（用户单独装官方包时）
    """
    # ① vendored（与 api.py 同目录结构：server/../vendor/...）
    here = os.path.dirname(os.path.abspath(__file__))          # .../ComfyUI_MRBoard_Next/server
    pkg = os.path.dirname(here)                                # .../ComfyUI_MRBoard_Next
    vendored = os.path.join(pkg, "vendor", "ComfyUI_MiniMaxH3_Director", "example_workflows")
    if os.path.isdir(vendored):
        return vendored
    # ② 外部安装（官方目录）
    cwd = os.getcwd()
    for base in (os.path.join(os.path.dirname(cwd), "custom_nodes"), cwd):
        p = os.path.join(base, "ComfyUI_MiniMaxH3_Director", "example_workflows")
        if os.path.isdir(p):
            return p
    p = os.path.join(os.path.dirname(pkg), "ComfyUI_MiniMaxH3_Director", "example_workflows")
    return p if os.path.isdir(p) else ""


def _load_example(mode):
    d = _example_dir()
    if not d:
        raise RuntimeError("找不到官方 ComfyUI_MiniMaxH3_Director/example_workflows")
    path = os.path.join(d, TEMPLATE[mode])
    with open(path, "r", encoding="utf-8") as fh:
        wf = json.load(fh)
    nodes = {n["id"]: n for n in wf.get("nodes", [])}
    director = next((n for n in nodes.values() if n.get("type") == "MiniMaxH3Director"), None)
    if director is None:
        raise RuntimeError("示例缺少 MiniMaxH3Director 节点")
    return nodes, director


def _loader_vals(nodes, typ):
    n = next((x for x in nodes.values() if x.get("type") == typ), None)
    return list(n.get("widgets_values") or []) if n else []


def _director_widgets(director):
    """映射 director 的 widget 键 → widgets_values。

    widgets_values 顺序与 inputs 一致：前 4 个是链接(model/video_vae/audio_vae/clip)，
    不进 widgets_values；可选链接(i2v_groups/r2v_groups/refine)也不在。seed 占 2 值
    (数值 + control_after_generate)，故在 seed 之后的第 5 个 widget 位跳过 1 个 control 值。
    注意：bd_grp_sample/bd_grp_advanced/bd_grp_perf 虽在 UI 上是分组标签，但在 Director 的
    INPUT_TYPES 里是真实输入，必须保留（值就是分组标题文本），否则 validate 缺输入失败。
    """
    ins = [i.get("name") for i in director.get("inputs", [])]
    wv = list(director.get("widgets_values") or [])
    keys = [k for k in ins[4:] if k not in ("i2v_groups", "r2v_groups", "refine")]
    out = {}
    wi = 0
    for k in keys:
        if wi == 5:  # seed 的 control_after_generate（第 5 个 widget 位）不进 API
            wi += 1
        if wi < len(wv):
            out[k] = wv[wi]
        wi += 1
    return out


def _apply_opts_overrides(widget, opts):
    """把 opts 里的 director 采样/输出参数覆盖到 widget。"""
    o = opts or {}
    for k in ("width", "height", "ref_max_size", "frame_rate", "total_frames",
              "steps", "sampler", "scheduler", "shift_video", "shift_audio", "cfg",
              # v1.11.13 内置注意力加速（off/sage/block_sparse）—— 必须在这里白名单里，
              # 否则前端选了也传不进节点 widget（真进图断言会挂）
              "attention_accel"):
        if k in o and o[k] not in (None, ""):
            try:
                if k in ("steps", "width", "height", "ref_max_size", "total_frames"):
                    widget[k] = int(o[k])
                elif k in ("frame_rate", "cfg", "shift_video", "shift_audio"):
                    widget[k] = float(o[k])
                else:
                    widget[k] = str(o[k])
            except Exception:  # noqa: BLE001
                pass
    # 性能组布尔参数（官方 bd_grp_perf）
    for k in ("clear_vram_between_segments", "export_source_images"):
        if k in o and o[k] not in (None, ""):
            try:
                widget[k] = bool(o[k])
            except Exception:  # noqa: BLE001
                pass


def _loader_widgets(nodes, typ):
    """返回模板里第一个 typ 节点的 widgets_values（列表拷贝）。"""
    for n in nodes.values():
        if n.get("type") == typ:
            return list(n.get("widgets_values") or [])
    return []


def _base_loaders(g, seq, nodes, opts):
    """组装 UNET/CLIP/视频VAE/音频VAE 加载节点（opts 可覆盖文件名），
    并按需串入通用 LoRA → 加速 LoRA。

    返回 (model_node_id, clip_id, video_vae_id, audio_vae_id)；
    model_node_id 是模型链末端（UNET→[LoRA]→[加速LoRA]→[TE-Speed]），
    直接作为 director 的 model 输入。
    """
    o = dict(opts or {})
    # 兜底：外接加速节点时内置加速必须失效（调用方已经做过一次，这里再兜一道，
    # 保证"送进队列的图"永远不会出现双重加速）
    o, _accel_gate_note = apply_external_accel_gate(o)
    u = str(seq[0]); seq[0] += 1
    c = str(seq[0]); seq[0] += 1
    vv = str(seq[0]); seq[0] += 1
    av = str(seq[0]); seq[0] += 1

    def link(node_id, slot=0):
        return [node_id, slot]

    unet_w = _loader_widgets(nodes, "UNETLoader")
    clip_w = _loader_widgets(nodes, "CLIPLoader")
    all_vaes = [list(n.get("widgets_values") or []) for n in nodes.values() if n.get("type") == "VAELoader"]
    audio_vae_w = next((w for w in all_vaes if w and "audio" in str(w[0]).lower()), None)
    video_vae_w = next((w for w in all_vaes if w and "audio" not in str(w[0]).lower()), all_vaes[0] if all_vaes else None)

    unet_name = o.get("unet_name") or (unet_w[0] if unet_w else "")
    weight_dtype = unet_w[1] if len(unet_w) > 1 else "default"
    clip_name = o.get("clip_name") or (clip_w[0] if clip_w else "")
    clip_type = clip_w[1] if len(clip_w) > 1 else "minimax"
    clip_dev = clip_w[2] if len(clip_w) > 2 else "default"
    vvae_name = o.get("video_vae_name") or (video_vae_w[0] if video_vae_w else "")
    avae_name = o.get("audio_vae_name") or (audio_vae_w[0] if audio_vae_w else "")

    g[u] = {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": weight_dtype}}
    g[c] = {"class_type": "CLIPLoader", "inputs": {"clip_name": clip_name, "type": clip_type, "device": clip_dev}}
    g[vv] = {"class_type": "VAELoader", "inputs": {"vae_name": vvae_name}}
    g[av] = {"class_type": "VAELoader", "inputs": {"vae_name": avae_name}}

    model_node = u
    # 官方 Block Sparse Attention 加速（可选）：PathchSageAttentionKJ → MiniMaxH3MemoryEfficientSageAttentionPatch
    # 串在 UNET 之后、LoRA 之前，patch H3 自注意力降低峰值显存。需 sageattn 库。
    sage = o.get("sage_attention") or o.get("sparse_attention") or ""
    if sage and sage not in ("disabled", "off", False):
        sk = str(seq[0]); seq[0] += 1
        g[sk] = {"class_type": "PathchSageAttentionKJ",
                 "inputs": {"model": link(model_node), "sage_attention": str(sage), "allow_compile": False}}
        model_node = sk
        sp = str(seq[0]); seq[0] += 1
        g[sp] = {"class_type": "MiniMaxH3MemoryEfficientSageAttentionPatch",
                 "inputs": {"model": link(model_node)}}
        model_node = sp
    # 通用 LoRA（可选）
    lora_name = o.get("lora_name") or ""
    if lora_name and lora_name != "(无)":
        lora_strength = float(o.get("lora_strength") or 1.0)
        ln = str(seq[0]); seq[0] += 1
        g[ln] = {"class_type": "LoraLoaderModelOnly",
                 "inputs": {"model": link(model_node), "lora_name": lora_name,
                            "strength_model": lora_strength}}
        model_node = ln
    # 加速 LoRA（8/4 步蒸馏，可选）
    acc_lora = o.get("speed_lora") or ""
    if acc_lora and acc_lora != "(无)":
        acc_strength = float(o.get("speed_lora_strength") or 1.0)
        al = str(seq[0]); seq[0] += 1
        g[al] = {"class_type": "LoraLoaderModelOnly",
                 "inputs": {"model": link(model_node), "lora_name": acc_lora,
                            "strength_model": acc_strength}}
        model_node = al
    return model_node, c, vv, av


def resolve_frames_mode(mode, first_frame=None, last_frame=None):
    """首尾帧模式让步（对齐旧包语义：首帧必填、尾帧可选）。

    只填一张时不报错，而是退化成单帧模式，保证"少填一张也能出片"：
      fl2v + 只有首帧 → i2v（首帧生视频）
      fl2v + 只有尾帧 → fl2v_tail（尾帧生视频）
    返回 (effective_mode, note)。note 为空串表示没有让步。
    """
    m = str(mode or "")
    if m != "fl2v":
        return m, ""
    if first_frame and not last_frame:
        return "i2v", "未提供尾帧图 → 已自动按「首帧生视频 I2V」出片（补上尾帧则会用 FL2V 首尾帧构图）"
    if last_frame and not first_frame:
        return "fl2v_tail", "未提供首帧图 → 已自动按「尾帧生视频 L2V」出片（补上首帧则会用 FL2V 首尾帧构图）"
    return m, ""


def _frame_count(seconds, fps=24.0):
    fc = max(5, int(round(float(seconds) * fps)))
    while fc % 17 != 5:
        fc += 1
    return fc


def _mp_to_wh(mp, w, h, multiple=32):
    """MiniMax H3 官方 ResolutionSelector 算式：比例 + 百万像素 → 宽高（对齐 ×32）。

    与 vendor/ComfyUI_MiniMax_H3_Director/director/refine_pack.py 的
    resolution_from_selector() 同式：scale = √(MP·1024²/(aw·ah))，MP 官方钳制 0.1–16。
    """
    try:
        v = float(mp)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    v = min(16.0, max(0.1, v))
    try:
        w = max(1, int(round(float(w or 16))))
        h = max(1, int(round(float(h or 9))))
    except (TypeError, ValueError):
        w, h = 16, 9
    k = math.gcd(w, h) or 1
    aw, ah = w // k, h // k
    m = max(8, int(multiple or 32))
    scale = math.sqrt((v * 1024.0 * 1024.0) / (aw * ah))
    return (max(m, int(round((aw * scale) / m) * m)), max(m, int(round((ah * scale) / m) * m)))


def concat_common(common, segment):
    """公共提示词 + 分镜提示词 —— 与官方 director/plan.py concat_common_segment_prompt 同款。

    官方原文：both non-empty → ``common + blank line + segment``；只一侧非空 → 取那一侧。
    这里复刻同一规则，好让 t2v（单节点，没有 group 可走 commonEnabled 通道）与
    r2v/i2v/fl2v（走官方 commonEnabled）得到完全一致的最终文本。
    """
    c = str(common or "").strip()
    s = str(segment or "").strip()
    if c and s:
        return "%s\n\n%s" % (c, s)
    return c or s


def _sync_common_prompt(widget, common, enabled):
    """把公共提示词写进官方 timeline_data.global（prompt + commonEnabled）。

    ⚠ commonEnabled 只在**公共提示词非空**时才置 true：
       官方的 fallback_prompt = global.prompt or 节点 global_prompt，若置 true 但 prompt 为空，
       会退化成"节点 global_prompt（=本镜提示词）"，再 concat 一次 → 同一段文本出现两遍。
    """
    common = str(common or "").strip()
    try:
        td = json.loads(str(widget.get("timeline_data") or "{}"))
    except Exception:  # noqa: BLE001
        return
    if not isinstance(td, dict):
        return
    g = td.get("global")
    if not isinstance(g, dict):
        g = {}
    g["prompt"] = common
    g["commonEnabled"] = bool(enabled and common)
    td["global"] = g
    widget["timeline_data"] = json.dumps(td, ensure_ascii=False)


def _sync_timeline_size(widget, megapixels=None, output_flags=None):
    """把 widget 的 width/height/ref_max_size/total_frames 同步进 timeline_data。

    Director 实际按 timeline_data.output 的尺寸出图（而非 widget.width/height 顶层值），
    只覆盖 widget 顶层键不改 timeline_data 会导致 opts 分辨率落空（一直是模板 864×480）。
    """
    try:
        td = json.loads(str(widget.get("timeline_data") or "{}"))
    except Exception:  # noqa: BLE001
        return
    if not isinstance(td, dict):
        return
    try:
        w = int(widget.get("width") or td.get("width") or 864)
        h = int(widget.get("height") or td.get("height") or 480)
    except Exception:  # noqa: BLE001
        return
    r = int(widget.get("ref_max_size") or td.get("refMaxSize") or max(w, h))
    td["width"] = w
    td["height"] = h
    td["refMaxSize"] = r
    # ⚠ frameRate 必须一起写进 timeline_data：官方 plan.py 优先读 td["frameRate"]，
    #   只改 widget.frame_rate 会被模板的 24 覆盖 → 面板改 FPS 完全不生效（用户实报「调了没用」）。
    try:
        td["frameRate"] = float(widget.get("frame_rate") or td.get("frameRate") or 24.0)
    except (TypeError, ValueError):
        pass
    out = td.get("output") or {}
    if isinstance(out, dict):
        out["width"] = w
        out["height"] = h
        out["longEdge"] = max(w, h)
        if megapixels:
            # 官方按 output.mode 出图：fixed=用 width/height（MP 算出来的尺寸要真正生效必须 fixed）
            try:
                out["mode"] = "fixed"
                out["megapixels"] = round(float(megapixels), 3)
            except (TypeError, ValueError):
                pass
        # 官方导出/音频/连续性开关（以前完全没写 → 用户改「分段导出 / 静音 / 段间连续性」在官方侧不生效）
        for _k, _cast in (("exportMode", str), ("audioMode", str),
                          ("continuityEnabled", bool), ("continuityOverlapFrames", int),
                          # 官方 ref_image_size（match|max）：resolve_ref_image_size 全局回退读 output.refImageSize
                          ("refImageSize", str)):
            _v = (output_flags or {}).get(_k)
            if _v in (None, ""):
                continue
            try:
                out[_k] = _cast(_v)
            except (TypeError, ValueError):
                pass
        td["output"] = out
    if "total_frames" in widget:
        try:
            td["totalFrames"] = int(widget["total_frames"])
        except Exception:  # noqa: BLE001
            pass
    widget["timeline_data"] = json.dumps(td, ensure_ascii=False)


def _deep_replace_str(obj, old, new):
    if isinstance(obj, str):
        return obj.replace(old, new)
    if isinstance(obj, list):
        return [_deep_replace_str(x, old, new) for x in obj]
    if isinstance(obj, dict):
        return {k: _deep_replace_str(v, old, new) for k, v in obj.items()}
    return obj


def _deep_replace_num(obj, old_num, new_num):
    def go(o):
        if isinstance(o, dict):
            return {k: go(v) for k, v in o.items()}
        if isinstance(o, list):
            return [go(x) for x in o]
        if isinstance(o, (int, float)) and not isinstance(o, bool) and o == old_num:
            return new_num
        return o
    return go(obj)


def _model_salt(opts) -> str:
    """模型/加速栈的指纹（写进 timeline.global.modelSalt）。

    为什么需要它：官方段缓存的指纹（segment_cache._segment_identity_fingerprint）里
    **没有基座模型、没有 LoRA** —— 只换了模型或 LoRA、其它采样参数不变时，指纹一模一样
    → 直接命中旧缓存，复用**上一次（可能带着蒸馏 LoRA / 别的基座）**的渲染产物。
    用户实报「把加速关掉了、还是加速」就是这种陈旧缓存命中。

    把模型栈哈希写进 timeline，再由 vendor 侧读进缓存 key → 换模型/LoRA 自动失效。
    """
    keys = ("unet_name", "clip_name", "video_vae_name", "audio_vae_name",
            "lora_name", "lora_strength", "speed_lora", "speed_lora_strength",
            "attention_accel", "steps", "cfg", "sampler", "scheduler",
            "shift_video", "shift_audio", "refine_mode", "refine_steps")
    o = opts or {}
    raw = "|".join("%s=%s" % (k, o.get(k)) for k in keys if o.get(k) not in (None, ""))
    if not raw:
        return ""
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _inject_model_salt(widget, opts) -> None:
    """把模型栈指纹塞进 widget['timeline_data'].global.modelSalt（就地改）。"""
    salt = _model_salt(opts)
    if not salt:
        return
    try:
        td = json.loads(str(widget.get("timeline_data") or "{}"))
        if not isinstance(td, dict):
            return
        g = td.get("global")
        if not isinstance(g, dict):
            g = {}
            td["global"] = g
        g["modelSalt"] = salt
        widget["timeline_data"] = json.dumps(td, ensure_ascii=False)
    except Exception:  # noqa: BLE001 - 指纹注入失败不影响出片
        pass


def build_timeline_from_shots(shots, *, task_type, frame_rate=24.0, width=864, height=480,                              common_prompt="", continuity=False, continuity_overlap=22,
                              export_mode="all", audio_mode="generate",
                              ref_image_size="match") -> dict:
    """把逐镜数据打成官方导演台的 **v5 多段时间线**（严格复刻官方 pack.py 的 schema）。

    ⚠ 为什么必须多段：官方导演台的工作方式就是「每个分镜 = 一个 segment，各自带
    prompt / 帧数 / 参考槽 / 与前镜连续性」，由官方节点逐段生成、再拼音轨。
    以前这条节点路径把**所有镜的提示词拼成一条 t2v**（12 镜 → 一段 15 秒）→
    N 个角色挤进同一段、互相污染 → 用户看到"人物乱入"。

    帧数按官方约定对齐到 17n+5（H3 生成式时间线的合法帧数）。
    """
    fps = float(frame_rate or 24.0)
    segs: list[dict] = []
    cursor = 0
    for i, s in enumerate(shots or []):
        if not isinstance(s, dict):
            continue
        pr = str(s.get("prompt") or s.get("text") or "").strip()
        if not pr:
            continue
        try:
            sec = float(s.get("sec") or 0) or 5.0
        except (TypeError, ValueError):
            sec = 5.0
        ln = _frame_count(sec, fps)
        # 每镜的参考素材（面板落进计划的 media）：官方 segment 用 refs[].imageFile /
        # refAudios[].audioFile / refVideos[].videoFile，槽位从 1 开始（↔ 提示词 <Picture N>）
        def _slots(rels, key):
            out = []
            for k, rel in enumerate((rels or [])[:9]):
                rel = str(rel or "").replace("\\", "/").strip()
                if rel:
                    out.append({"index": k + 1, key: rel})
            return out
        media = s.get("media") if isinstance(s.get("media"), dict) else {}
        refs_img = _slots(media.get("image") or s.get("images"), "imageFile")
        refs_aud = _slots(media.get("audio") or s.get("audios"), "audioFile")
        refs_vid = _slots(media.get("video") or s.get("videos"), "videoFile")
        seg = {
            "id": f"g{i}", "start": cursor, "length": ln, "frameCount": ln,
            "durationSec": sec, "prompt": pr, "negativePrompt": "",
            "taskType": "", "refs": refs_img, "refAudios": refs_aud, "refVideos": refs_vid,
            "continuityFromPrev": bool(s.get("linkNext")),
            "refImageSize": None, "genImage": {"imageFile": ""}, "imageFile": "",
            "startImage": None, "endImage": None,
        }
        # 首尾帧模式：startImage/endImage 与官方一致（{imageFile} 或 None）
        if s.get("firstFrame"):
            seg["startImage"] = {"imageFile": str(s["firstFrame"]).replace("\\", "/")}
        if s.get("lastFrame"):
            seg["endImage"] = {"imageFile": str(s["lastFrame"]).replace("\\", "/")}
        segs.append(seg)
        cursor += ln
    if not segs:
        segs = [{"id": "g0", "start": 0, "length": 124, "frameCount": 124,
                 "prompt": "", "refs": [], "refAudios": [], "refVideos": [],
                 "genImage": {"imageFile": ""}}]
        cursor = 124
    return {
        "version": 5,
        "timelineMode": "prompt_batch",
        "editMode": "segment",
        "frameRate": fps,
        "totalFrames": cursor,
        "global": {"taskType": task_type, "prompt": common_prompt or "",
                   "commonEnabled": bool(common_prompt), "commonCollapsed": False,
                   "refs": [], "refAudios": [], "refVideos": [],
                   "referenceVideo": {}, "continuousReference": False},
        "output": {"mode": "fixed", "width": int(width), "height": int(height),
                   "exportMode": export_mode, "audioMode": audio_mode,
                   "refImageSize": ref_image_size,
                   "continuityEnabled": bool(continuity),
                   "continuityOverlapFrames": int(continuity_overlap)},
        "segments": segs,
        "video": {"fileName": "", "videoFile": "", "subfolder": "", "type": "input",
                  "frames": [], "frameMap": []},
        "videoClips": [], "runSelectEnabled": False, "runSelection": [],
    }


def build_shot_graph(mode, prompt, seed=0, seconds=5.0, frame_rate=24.0,
                     first_frame=None, last_frame=None, refs=None, audios=None,
                     ref_by_num=None, audio_by_num=None, videos=None, video_by_num=None,
                     common_prompt=None, common_enabled=None,
                     _variant=None, steps=None, cfg=None, opts=None, shots=None):
    """返回 API prompt dict（数字字符串 node id）。

    opts 字段（覆盖官方默认）：unet_name, clip_name, video_vae_name, audio_vae_name, lora_name,
    lora_strength, width, height, ref_max_size, total_frames, frame_rate, steps, sampler,
    scheduler, shift_video, shift_audio, cfg。steps/cfg 兼容旧参数。
    加速（可选）：speed_lora/speed_lora_strength（8/4步蒸馏 LoRA，LoraLoaderModelOnly 串链），
    """
    opts_obj = dict(opts or {})
    # 公共提示词（官方 common prompt）：没显式给就从 opts 里取（导演台/流水线都塞在 opts）
    common_prompt = str(common_prompt if common_prompt is not None
                        else (opts_obj.get("common_prompt") or "")).strip()
    # ⚠ 显式传进来的 common_enabled 优先：调用方（api.py）已经从 body/opts 解析过一轮，
    #    这里再让 opts 覆盖回去，会导致"UI 关掉开关但 opts 里还是 true"→ 关不掉。
    if common_enabled is None:
        common_enabled = bool(opts_obj.get("common_enabled", True))
    else:
        common_enabled = bool(common_enabled)
    # 模式与素材强绑定：t2v 纯文字模式不允许任何图片输入（api.py 已兜底一次，这里再守一次，
    # 防止其它调用方（流水线/外部脚本）绕过 API 直接构图时把参考图带进来）。
    if mode not in _GROUP_MODES:
        first_frame = None
        last_frame = None
        refs = None
    if steps is not None and "steps" not in opts_obj:
        opts_obj["steps"] = steps
    if cfg is not None and "cfg" not in opts_obj:
        opts_obj["cfg"] = cfg
    nodes, director = _load_example(mode)
    g = {}
    seq = [0]

    def newid():
        i = str(seq[0])
        seq[0] += 1
        return i

    def link(node_id, slot=0):
        return [node_id, slot]

    def add(class_type, inputs):
        node_id = newid()
        g[node_id] = {"class_type": class_type, "inputs": inputs}
        return node_id

    def tail(director_id):
        cv = add("CreateVideo", {"images": link(director_id, 0), "audio": link(director_id, 1),
                                 "fps": link(director_id, 2), "bit_depth": 8})
        add("SaveVideo", {"video": link(cv), "filename_prefix": _H3_PREFIX,
                          "format": "auto", "codec": "auto"})

    def maybe_refine(d_ins, model_node):
        """二采/超分：接官方 MiniMaxH3DirectorRefine 到 Director.refine。
        latent_upscale = H3 3D latent 放大（无需二采 sigmas）；refine/upscale 需 BasicScheduler sigmas。"""
        rm = (opts.get("refine_mode") or "").strip()
        if rm not in ("refine", "upscale", "latent_upscale"):
            return
        r_ins = {
            "mode": rm,
            "upscale_method": opts.get("refine_upscale_method") or "h3_latent",
            "latent_upscale_model": opts.get("refine_latent_model") or "minimax_h3_latent_upscaler_3d_bf16.safetensors",
            "sampler": opts.get("refine_sampler") or "euler",
            "passes": int(opts.get("refine_passes") or 1),
            "megapixels": float(opts.get("refine_megapixels") or 1.0),
        }
        if rm in ("refine", "upscale"):
            bs = add("BasicScheduler", {
                "model": link(model_node),
                "scheduler": opts.get("refine_scheduler") or "simple",
                "steps": int(opts.get("refine_steps") or 10),
                "denoise": float(opts.get("refine_denoise") or 1.0),
            })
            r_ins["sigmas"] = link(bs)
        rn = add("MiniMaxH3DirectorRefine", r_ins)
        d_ins["refine"] = link(rn)

    # loaders（opts 可覆盖 unet/clip/video_vae/audio_vae/lora 名）
    opts = opts_obj or {}
    u, c, vv, av = _base_loaders(g, seq, nodes, opts)

    widget = _director_widgets(director)
    widget["global_prompt"] = prompt
    try:
        widget["seed"] = int(seed)
    except Exception:  # noqa: BLE001
        pass
    if steps is not None:
        try:
            widget["steps"] = int(steps)
        except Exception:  # noqa: BLE001
            pass
    if cfg is not None:
        try:
            widget["cfg"] = float(cfg)
        except Exception:  # noqa: BLE001
            pass
    # ★ 多段模式（shots 传入时）：复刻官方导演台 —— 每个分镜一个 segment，
    #   各自带 prompt/帧数/连续性，官方节点逐段生成 + 拼音轨。
    if shots and mode in ("t2v", "r2v"):
        _wv_t = list(director.get("widgets_values") or [])
        _td_multi = build_timeline_from_shots(
            shots, task_type=str((_wv_t[0] if _wv_t else "") or ""),
            frame_rate=float(frame_rate))
        widget["timeline_data"] = json.dumps(_td_multi, ensure_ascii=False)
        widget["total_frames"] = int(_td_multi["totalFrames"])  # 防被后续 sync 写回模板值
        widget["global_prompt"] = ""   # 每段各带 prompt，global 留空避免重复注入
    # H3 官方百万像素（0.1–2）：按当前比例换算出宽高（与前端同一算式，后端兜底 → 一定生效）
    _mp = opts_obj.get("megapixels")
    if _mp:
        _wh = _mp_to_wh(_mp, opts_obj.get("width"), opts_obj.get("height"))
        if _wh:
            opts_obj["width"], opts_obj["height"] = _wh
    # 其它 director 参数/输出尺寸覆盖
    _apply_opts_overrides(widget, opts_obj)
    _sync_timeline_size(
        widget, megapixels=_mp,
        output_flags={
            "exportMode": (opts_obj.get("export_mode") or "").lower() or None,
            "audioMode": ((opts_obj.get("audio_mode") or "").lower() or None),
            "continuityEnabled": opts_obj.get("continuity"),
            "continuityOverlapFrames": opts_obj.get("continuity_overlap"),
            "refImageSize": opts_obj.get("ref_image_size"),
        },
    )  # 尺寸 + megapixels + 导出/音频/连续性开关一起同步进 timeline_data
    # 模型栈指纹进 timeline（官方段缓存指纹不含基座/LoRA → 不写这个会命中旧缓存）
    _inject_model_salt(widget, opts_obj)
    if _variant == "no_labels":
        widget = {k: v for k, v in widget.items() if not k.startswith("bd_grp_")}

    if mode not in _GROUP_MODES:
        # t2v：单节点 + timeline 替换
        # ⚠ 多段模式（shots 传入）已在上面把整条 timeline 换掉了 —— 这里不能再做
        #   「把模板单段提示词/总帧深替换」的动作，否则会把多段打回单段。
        if not shots:
            # 公共提示词：单节点没有 group 可走官方 commonEnabled 通道 → 本节点按官方同款规则拼在最前
            if common_prompt and common_enabled:
                prompt = concat_common(common_prompt, prompt)
                widget["global_prompt"] = prompt
            total = _frame_count(seconds, float(frame_rate))
            widget["total_frames"] = total
            td = json.loads(str(widget.get("timeline_data") or "{}"))
            wv = list(director.get("widgets_values") or [])
            orig_prompt = wv[1]
            try:
                orig_total = int(wv[10])
            except Exception:  # noqa: BLE001
                orig_total = total
            if orig_prompt and orig_prompt != prompt:
                td = _deep_replace_str(td, orig_prompt, prompt)
            if orig_total != total and orig_total >= 100:
                td = _deep_replace_num(td, orig_total, total)
            widget["timeline_data"] = json.dumps(td, ensure_ascii=False)
        d_ins = {"model": link(u), "video_vae": link(vv), "audio_vae": link(av), "clip": link(c)}
        d_ins.update(widget)
        maybe_refine(d_ins, u)
        dd = add("MiniMaxH3Director", d_ins)
        if _variant == "no_video":
            return g
        tail(dd)
        return g

    # 外部组模式
    def load_image(rel):
        return add("LoadImage", {"image": rel})

    if mode in ("i2v", "fl2v"):
        li_first = load_image(first_frame) if first_frame else None
    else:
        li_first = None
    if mode in ("fl2v", "fl2v_tail"):
        li_last = load_image(last_frame) if last_frame else None
    else:
        li_last = None

    if shots and mode == "r2v":
        # ★ 复刻官方导演台：**每镜一个参考组**（官方 GroupsCombine 最多 5 组 → 取前 5 镜）。
        #   官方不变量：段 ↔ 组按顺序对应；组内 `<Picture N>` ↔ 第 N 个非空 ref_image_{k} 槽。
        #   所以这里按「正文里的编号升序」排槽，并把标记重编号成连续，避免跳号导致参考失效。
        def _renum(text, tag, rename):
            if not rename or not text:
                return text
            pat = re.compile(r"<\s*%s\s*(\d+)\s*>" % tag, re.IGNORECASE)
            out = pat.sub(lambda m: ("\x00%s%d\x00" % (tag, rename[int(m.group(1))]))
                          if int(m.group(1)) in rename else m.group(0), text)
            return re.sub(r"\x00(%s)(\d+)\x00" % tag, r"<\1 \2>", out)
        _groups = []
        for s in list(shots)[:5]:
            if not isinstance(s, dict):
                continue
            spr = str(s.get("prompt") or s.get("text") or "").strip()
            if not spr:
                continue
            bn = s.get("refByNum") if isinstance(s.get("refByNum"), dict) else {}
            pic = bn.get("picture") if isinstance(bn.get("picture"), dict) else {}
            numbered = []
            for k, v in (pic or {}).items():
                try:
                    numbered.append((int(k), str(v or "").replace("\\", "/").strip()))
                except (TypeError, ValueError):
                    continue
            numbered = [(n, rel) for n, rel in sorted(numbered) if rel]
            extras = [str(x).replace("\\", "/").strip()
                      for x in ((s.get("media") or {}).get("image") or []) if x]
            rels, rename = [], {}
            for n, rel in numbered:
                if rel not in rels:
                    rename[n] = len(rels) + 1
                    rels.append(rel)
            for rel in extras:
                if rel and rel not in rels and len(rels) < 9:
                    rels.append(rel)
            spr = _renum(_renum(spr, "Picture", rename), "Image", rename)
            gi = {}
            for k, rel in enumerate(rels[:9]):
                gi[f"ref_images.ref_image_{k}"] = link(add("LoadImage", {"image": rel}))
            for k, rel in enumerate([str(x).replace("\\", "/").strip()
                                     for x in ((s.get("media") or {}).get("audio") or []) if x][:3]):
                gi[f"ref_audios.ref_audio_{k}"] = link(add("LoadAudio", {"audio": rel}))
            gi["prompt"] = spr
            try:
                gi["duration_sec"] = float(s.get("sec") or 5.0)
            except (TypeError, ValueError):
                gi["duration_sec"] = 5.0
            _groups.append(add("MiniMaxH3DirectorGroupReferenceToVideo", gi))
        if _groups:
            _sync_common_prompt(widget, common_prompt, common_enabled)
            comb = add("MiniMaxH3DirectorGroupsCombine",
                       {f"groups.group_{k}": link(gr) for k, gr in enumerate(_groups)})
            d_ins = {"model": link(u), "video_vae": link(vv), "audio_vae": link(av), "clip": link(c)}
            d_ins["r2v_groups"] = link(comb)
            d_ins.update(widget)
            maybe_refine(d_ins, u)
            dd = add("MiniMaxH3Director", d_ins)
            if _variant == "no_video":
                return g
            tail(dd)
            return g

    if mode == "r2v":
        # 官方参考槽（vendor/lib/ref_images.py tooltip 原文：ref_image_{k} ↔ <Picture {k+1}>）是
        # **按"非空槽的先后顺序"编号**的 —— MiniMaxH3ReferenceToVideo.execute 里
        # `for img in (ref_images or {}).values()` 走 dict 插入顺序，**空槽不占号**。
        # 所以只填第 3 个槽时，官方把它当 <Picture 1>；提示词里的 <Picture 3> 就指向
        # 不存在的参考 → 参考等于没用（用户实报「音色一直不被参考」就是这种"跳号"）。
        # 对策：把有编号的参考**按编号升序压到连续槽位**，并把提示词里的标记**同步重编号**，
        # 保证「提示词第 k 号 ↔ 第 k 个非空槽」这个官方不变量成立。
        def _sort_num(d):
            items = []
            for k, v in (d or {}).items():
                try:
                    items.append((int(k), str(v)))
                except (TypeError, ValueError):
                    continue
            return sorted(items)

        def _compact(by_num, extra, cap):
            """[(旧编号, rel)] + 无编号补充 → (连续排列的 rel 列表, {旧编号: 新编号})"""
            pairs, used = [], set()
            for n, rel in _sort_num(by_num):
                if rel and 1 <= n <= cap and rel not in used:
                    pairs.append((n, rel)); used.add(rel)
            for rel in (extra or []):
                if rel and rel not in used and len(pairs) < cap:
                    pairs.append((0, rel)); used.add(rel)   # 0 = 正文里没标编号
            rename = {}
            for k, (n, _rel) in enumerate(pairs):
                if n:
                    rename[n] = k + 1
            return [rel for _n, rel in pairs], rename

        def _renumber(text, tag, rename):
            """把正文里的 <Picture/Audio N> 按 rename 重编号（两趟替换防 1↔2 互撞）。"""
            if not rename or not text:
                return text
            pat = re.compile(r"<\s*%s\s*(\d+)\s*>" % tag, re.IGNORECASE)

            def _ph(m):
                n = int(m.group(1))
                return "\x00%s%d\x00" % (tag, rename[n]) if n in rename else m.group(0)

            out = pat.sub(_ph, text)
            return re.sub(r"\x00(%s)(\d+)\x00" % tag, r"<\1 \2>", out)

        img_rels, img_rename = _compact(ref_by_num, refs, 9)
        aud_rels, aud_rename = _compact(audio_by_num, audios, 3)
        vid_rels, vid_rename = _compact(video_by_num, videos, 3)
        if ref_by_num:
            prompt = _renumber(prompt, "Picture", img_rename)
        if audio_by_num:
            prompt = _renumber(prompt, "Audio", aud_rename)
        if video_by_num:
            prompt = _renumber(prompt, "Video", vid_rename)
        # Director 的 global_prompt 也用改号后的提示词（它是 fallback/公共段来源，
        # 留着旧标记会在 common 模式下重新引入对不上的 <Picture N>/<Audio N>）
        widget["global_prompt"] = prompt

        g_ins = {}
        for k, rel in enumerate(img_rels):
            g_ins[f"ref_images.ref_image_{k}"] = link(add("LoadImage", {"image": rel}))
        for k, rel in enumerate(aud_rels):
            g_ins[f"ref_audios.ref_audio_{k}"] = link(add("LoadAudio", {"audio": rel}))
        # 参考视频：官方 ref_video_k 收的是**帧序列 (IMAGE)**，不是文件路径
        #   → 需要一个「视频 → IMAGE 帧」的加载节点。优先 VHS（可控帧率/帧数），
        #     退回 ComfyUI 自带的 LoadVideoUI；两个都没有就跳过并记一笔（不让整镜失败）。
        _video_audio_ref = bool(opts_obj.get("video_audio_ref"))
        _vload = None
        try:
            import nodes as _nodes_mod
            _avail = getattr(_nodes_mod, "NODE_CLASS_MAPPINGS", {}) or {}
            for _cand in ("VHS_LoadVideoPath", "VHS_LoadVideo", "LoadVideoUI"):
                if _cand in _avail:
                    _vload = _cand
                    break
        except Exception:  # noqa: BLE001
            _vload = None
        if vid_rels and not _vload:
            print("[MRBoardNext] 参考视频已选中，但本机没有可把视频转成帧的节点"
                  "（VHS_LoadVideoPath / LoadVideoUI）→ 本镜跳过 <Video N> 参考")
        elif vid_rels:
            for k, rel in enumerate(vid_rels):
                if _vload == "LoadVideoUI":
                    _vin = {"video": rel, "frame_rate": 24, "start_time": 0, "end_time": 0,
                            "duration": 0, "start_frame": 0, "end_frame": 0, "duration_frames": 0,
                            "resize_method": "maintain aspect ratio", "custom_width": 0,
                            "custom_height": 0, "display_mode": "seconds",
                            "crop_x": 0, "crop_y": 0, "crop_w": 1, "crop_h": 1}
                else:
                    # 官方要求参考视频 2–15s @24fps；这里按 ~3s 封顶，避免参考 token 过多把显存吃光。
                    # ⚠ 帧数必须满足官方的 **n % 17 == 5 且 n ≥ 5**：
                    #   MiniMaxH3ReferenceToVideo 里有 `while n % 17 != 5: n -= 1`，
                    #   不满足会被**静默截断**（最多白丢 16 帧 ≈ 0.67s）。
                    #   合法值 5/22/39/56/73/90/…；73 ≈ 3.04s（旧值 72 非法 → 被截到 56）。
                    _vin = {"video": rel, "force_rate": 24.0, "custom_width": 0, "custom_height": 0,
                            "frame_load_cap": 73, "skip_first_frames": 0, "select_every_nth": 1}
                _vid_node = add(_vload, _vin)
                g_ins[f"ref_videos.ref_video_{k}"] = link(_vid_node)
                # ② 参考视频的**声轨** → ref_video_audios.ref_video_audio_{k}（官方同号配对）
                #   官方呈现顺序：图片 → 每个视频(先它自己的 <Audio j>，再 <Video k>) → 独立音频；
                #   所以一旦启用，**<Audio> 的编号会「先数视频声轨、再数独立音频」**（官方语义）。
                #   默认不启用：不勾就完全不改变音频编号，不会影响既有提示词。
                #   VHS 的 LoadVideoPath/LoadVideo 第 3 个输出(idx 2) 就是 AUDIO；LoadVideoUI 没有音轨输出。
                if _video_audio_ref and _vload != "LoadVideoUI":
                    g_ins[f"ref_video_audios.ref_video_audio_{k}"] = link(_vid_node, 2)
        g_ins["prompt"] = prompt
        g_ins["duration_sec"] = float(seconds)
        grp = add("MiniMaxH3DirectorGroupReferenceToVideo", g_ins)
    else:
        g_ins = {"prompt": prompt, "duration_sec": float(seconds)}
        if li_first:
            g_ins["first_frame"] = link(li_first)
        if li_last:
            g_ins["last_frame"] = link(li_last)
        grp = add("MiniMaxH3DirectorGroupImageToVideo", g_ins)

    # 公共提示词：外部组模式走官方通道（commonEnabled + global.prompt），官方对每个分段做
    # concat_common_segment_prompt(公共, 本镜) —— 这才是"逐镜生效"的官方实现方式
    _sync_common_prompt(widget, common_prompt, common_enabled)

    comb = add("MiniMaxH3DirectorGroupsCombine", {"groups.group_0": link(grp)})
    d_ins = {"model": link(u), "video_vae": link(vv), "audio_vae": link(av), "clip": link(c)}
    key = "r2v_groups" if mode == "r2v" else "i2v_groups"
    d_ins[key] = link(grp if _variant == "no_combine" else comb)
    d_ins.update(widget)
    maybe_refine(d_ins, u)
    dd = add("MiniMaxH3Director", d_ins)
    if _variant == "no_video":
        return g
    tail(dd)
    return g


def _queue_extra_data(server):
    """构造队列 extra_data，带上活跃前端 client_id（让前端进度条正确显示/消失）+ preview_method（生成中实时预览）。"""
    extra = {"create_time": int(time.time() * 1000), "preview_method": "auto"}
    try:
        sockets = getattr(server, "sockets", None)
        if sockets:
            extra["client_id"] = next(iter(sockets))
    except Exception:  # noqa: BLE001
        pass
    return extra


def _graph_model_line(graph) -> str:
    """摘出构图里实际用到的模型文件名。

    维度类报错（Input and weight inner dimensions must match）本身**完全不提示**是哪个
    LoRA / 基座 / VAE 引起的 —— 把这条上下文带上，用户才能自己修。
    """
    try:
        parts = []
        for _nid, n in (graph or {}).items():
            ct = str((n or {}).get("class_type") or "")
            ins = (n or {}).get("inputs") or {}
            if ct == "UNETLoader":
                parts.append("UNet=" + str(ins.get("unet_name")))
            elif ct == "CLIPLoader":
                parts.append("CLIP=" + str(ins.get("clip_name")))
            elif ct == "VAELoader":
                parts.append("VAE=" + str(ins.get("vae_name")))
            elif ct in ("LoraLoader", "LoraLoaderModelOnly"):
                parts.append("LoRA=" + str(ins.get("lora_name")))
        return " | ".join(parts)
    except Exception:  # noqa: BLE001 - 诊断信息绝不能反过来打断报错
        return ""


_DIM_ERR_MARKERS = ("inner dimensions must match", "size mismatch", "shapes cannot be multiplied",
                    "mat1 and mat2", "cannot be multiplied")


def _dim_error_hint(detail: str, graph) -> str:
    """维度不匹配时补一条可执行的排查提示（这是「拿错 LoRA」最常见的症状）。"""
    low = str(detail or "").lower()
    if not any(m in low for m in _DIM_ERR_MARKERS):
        return ""
    line = _graph_model_line(graph)
    return (" ｜ 疑似「LoRA / 基座 / VAE 不配套」导致维度不匹配。本次构图：" + (line or "(未取到)")
            + "。请核对：① LoRA 与基座同精度族（pruned_int8/convrot 的基座要配 pruned 版 LoRA，"
              "bf16 基座配 bf16 版 LoRA）；② 任务族一致（FL2VA 首尾帧权重别配 Ref2VA 专用 LoRA，"
              "hybrid/curveproj 变体只配 hybrid 基座）；③ 音频 VAE 用 minimax_h3_audio_vae_fp32；"
              "④ 排不掉时先把「蒸馏 LoRA」设为 (无) 再跑一次验证。")


async def run_shot(mode, prompt, out_dir, *, seed=0, seconds=5.0, frame_rate=24.0,
                   first_frame=None, last_frame=None, refs=None, audios=None,
                   ref_by_num=None, audio_by_num=None, videos=None, video_by_num=None,
                   common_prompt=None, common_enabled=None,
                   steps=None, cfg=None, opts=None, timeout=2400):
    import execution
    from server import PromptServer

    server = PromptServer.instance
    graph = build_shot_graph(mode, prompt, seed=seed, seconds=seconds, frame_rate=frame_rate,
                             first_frame=first_frame, last_frame=last_frame, refs=refs,
                             audios=audios, ref_by_num=ref_by_num, audio_by_num=audio_by_num,
                             videos=videos, video_by_num=video_by_num,
                             common_prompt=common_prompt, common_enabled=common_enabled,
                             steps=steps, cfg=cfg, opts=opts)
    prompt_id = str(uuid.uuid4())
    number = float(getattr(server, "number", 0))
    server.number = int(number) + 1
    _install_preview_hook()  # 采样过程中捕获 preview 图供前端轮询
    server.node_replace_manager.apply_replacements(graph)
    valid = await execution.validate_prompt(prompt_id, graph, None)
    if not valid[0]:
        # 把 node_errors 也带回，方便前端诊断：哪个节点缺什么输入
        node_errors = (valid[3] if len(valid) > 3 else {}) or {}
        detail_lines = []
        for nid, err in node_errors.items():
            try:
                err_str = err.get("errors") or []
                if isinstance(err_str, list):
                    for e in err_str:
                        if isinstance(e, dict):
                            t = e.get("type")
                            d = e.get("details", "")
                            detail_lines.append(f"#{nid}({graph.get(nid, {}).get('class_type', '?')}): {t} {d}".strip())
                        else:
                            detail_lines.append(f"#{nid}: {e}")
            except Exception:
                pass
        msg = str(valid[1])[:300]
        if detail_lines:
            msg = msg + " | " + " ; ".join(detail_lines[:6])[:300]
        raise RuntimeError("H3 构图校验失败: " + msg)
    server.prompt_queue.put((number, prompt_id, graph, _queue_extra_data(server),
                             valid[2], {}))

    deadline = time.time() + timeout
    entry = None
    while time.time() < deadline:
        await asyncio.sleep(1.0)
        hist = server.prompt_queue.get_history(prompt_id=prompt_id)
        if prompt_id in hist:
            entry = hist[prompt_id]
            status = entry.get("status") or {}
            if status.get("status_str") == "success":
                break
            if status.get("status_str") == "error":
                msgs = [m for m in (status.get("messages") or []) if m and m[0] == "execution_error"]
                detail = str(msgs[0][1].get("exception_message") or msgs[0][1])[:300] if msgs else "unknown"
                raise RuntimeError("H3 采样出错: " + detail + _dim_error_hint(detail, graph))
    else:
        raise TimeoutError("H3 采样超时（>%ds）" % timeout)

    out_base = folder_paths.get_output_directory()
    fs = sorted(_glob_h3_outputs(f"{_H3_PREFIX}_*.mp4"),
                key=os.path.getmtime)
    if not fs:
        raise RuntimeError("采样成功但未找到视频产物")
    src = fs[-1]
    dst_dir = os.path.normpath(out_dir)
    os.makedirs(dst_dir, exist_ok=True)
    # 保留 output/video/ 中的原始文件（供 ComfyUI 画廊显示），同时复制到资产文件夹
    dst = os.path.join(dst_dir, "h3shot_%s_%d_%s" % (mode, seed, os.path.basename(src)))
    shutil.copy2(src, dst)  # copy 而非 move，保持 output 中有副本供画廊显示
    return dst


async def _run_graph_queue(graph, out_dir, out_prefix, name, timeout):
    """构图 → 队列执行 → 收集视频产物（供 RTX/Flash 超分等复用 run_shot 的队列机制）。"""
    import execution
    from server import PromptServer
    server = PromptServer.instance
    prompt_id = str(uuid.uuid4())
    number = float(getattr(server, "number", 0))
    server.number = int(number) + 1
    server.node_replace_manager.apply_replacements(graph)
    valid = await execution.validate_prompt(prompt_id, graph, None)
    if not valid[0]:
        raise RuntimeError(f"{name} 构图校验失败: " + str(valid[1])[:500])
    server.prompt_queue.put((number, prompt_id, graph, _queue_extra_data(server),
                             valid[2], {}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        await asyncio.sleep(1.0)
        hist = server.prompt_queue.get_history(prompt_id=prompt_id)
        if prompt_id in hist:
            status = (hist[prompt_id].get("status") or {})
            if status.get("status_str") == "success":
                break
            if status.get("status_str") == "error":
                msgs = [m for m in (status.get("messages") or []) if m and m[0] == "execution_error"]
                detail = str(msgs[0][1].get("exception_message") or msgs[0][1])[:300] if msgs else "unknown"
                raise RuntimeError(f"{name} 出错: " + detail)
    else:
        raise TimeoutError(f"{name} 超时（>%ds）" % timeout)
    out_base = folder_paths.get_output_directory()
    fs = sorted(_glob_h3_outputs(out_prefix + "_*.mp4"),
                key=os.path.getmtime)
    if not fs:
        raise RuntimeError(f"{name} 成功但未找到视频产物")
    src = fs[-1]
    os.makedirs(out_dir, exist_ok=True)
    dst = os.path.join(out_dir, os.path.basename(src))
    shutil.copy2(src, dst)  # copy 而非 move，保持 output 中有副本供画廊显示
    return dst


async def run_rtx_upscale(video_rel, out_dir, *, scale=2.0, quality="ULTRA", timeout=1800):
    """RTX Video Super Resolution 独立二采（N 卡硬件超分，最快）。video_rel 为 input 相对路径。"""
    graph = {
        "0": {"class_type": "LoadVideo", "inputs": {"file": video_rel}},
        "1": {"class_type": "GetVideoComponents", "inputs": {"video": ["0", 0]}},
        "2": {"class_type": "RTXVideoSuperResolution", "inputs": {
            "images": ["1", 0],
            "resize_type": {"key": "scale by multiplier", "scale": float(scale)},
            "quality": quality}},
        "3": {"class_type": "CreateVideo", "inputs": {
            "images": ["2", 0], "audio": ["1", 1], "fps": ["1", 2], "bit_depth": 8}},
        "4": {"class_type": "SaveVideo", "inputs": {
            "video": ["3", 0], "filename_prefix": "mrnext_rtx", "format": "auto", "codec": "auto"}},
    }
    return await _run_graph_queue(graph, out_dir, "mrnext_rtx", "RTX VSR 超分", timeout)


async def run_flash_upscale(video_rel, out_dir, *, scale=2, timeout=1800):
    """TE-Speed-FlashVSR 独立二采（扩散超分，快）。video_rel 为 input 相对路径。"""
    graph = {
        "0": {"class_type": "LoadVideo", "inputs": {"file": video_rel}},
        "1": {"class_type": "GetVideoComponents", "inputs": {"video": ["0", 0]}},
        "2": {"class_type": "TEFlashVSRModelLoader", "inputs": {
            "model": "FlashVSR-v1.1", "mode": "tiny", "precision": "bf16", "device": "auto"}},
        "3": {"class_type": "TEFlashVSRRestore", "inputs": {
            "model": ["2", 0], "frames": ["1", 0], "scale": int(scale), "color_fix": True, "seed": 0}},
        "4": {"class_type": "TESpeedVideoCombine", "inputs": {
            "images": ["3", 0], "frame_rate": ["1", 2], "filename_prefix": "mrnext_flash",
            "value": 3, "save_output": True}},
    }
    return await _run_graph_queue(graph, out_dir, "mrnext_flash", "TE-FlashVSR 超分", timeout)


async def run_vosr2_upscale(video_rel, out_dir, *, scale=2, seed=0, timeout=3600):
    """VOSR 2.0 超分（H3 二采平替，一步扩散超分，比 SeedVR2 快且省显存）。
    依赖 ComfyUI-VOSR2 节点（custom_nodes/ComfyUI-VOSR2）；模型 ~7GB 首跑自动从 HF 下载。
    视频走 LoadVideo 帧序列 batch → VOSR2Upscale 逐批超分 → CreateVideo 合回（保留音轨）。"""
    graph = {
        "0": {"class_type": "LoadVideo", "inputs": {"file": video_rel}},
        "1": {"class_type": "GetVideoComponents", "inputs": {"video": ["0", 0]}},
        "2": {"class_type": "VOSR2ModelLoader", "inputs": {"model": "VOSR2", "dtype": "bf16"}},
        "3": {"class_type": "VOSR2Upscale", "inputs": {
            "model": ["2", 0], "image": ["1", 0], "upscale": int(scale), "seed": int(seed),
            "color_alignment": "wavelet",
            # 输出几乎必超 512px → 官方建议 tiling：tile 512 / overlap 64，VAE tile 1024 / overlap 128
            "tile_size": 512, "tile_overlap": 64, "vae_tile_size": 1024, "vae_tile_overlap": 128}},
        "4": {"class_type": "CreateVideo", "inputs": {
            "images": ["3", 0], "audio": ["1", 1], "fps": ["1", 2], "bit_depth": 8}},
        "5": {"class_type": "SaveVideo", "inputs": {
            "video": ["4", 0], "filename_prefix": "mrnext_vosr2", "format": "auto", "codec": "auto"}},
    }
    return await _run_graph_queue(graph, out_dir, "mrnext_vosr2", "VOSR2 超分", timeout)


def _collect_video_after_sync(mode, seed, out_dir, before_files):
    """同步执行后收集最新视频产物（比 before_files 多的 mrnext_h3shot_*.mp4）。"""
    out_base = folder_paths.get_output_directory()
    fs = sorted(_glob_h3_outputs(f"{_H3_PREFIX}_*.mp4"),
                key=os.path.getmtime)
    new = [f for f in fs if f not in before_files]
    if not new:
        raise RuntimeError("同步采样完成但未生成新视频产物")
    src = new[-1]
    dst_dir = os.path.normpath(out_dir)
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, "h3shot_%s_%d_%s" % (mode, seed, os.path.basename(src)))
    shutil.copy2(src, dst)  # copy 而非 move，保持 output 中有副本供画廊显示
    return dst


def run_shot_sync(mode, prompt, out_dir, *, seed=0, seconds=5.0, frame_rate=24.0,
                  first_frame=None, last_frame=None, refs=None, audios=None,
                  ref_by_num=None, audio_by_num=None, videos=None, video_by_num=None,
                  common_prompt=None, common_enabled=None,
                  steps=None, cfg=None, opts=None, timeout=2400):
    """同步执行 H3 出片（供 MRBoardStudio 节点 execute() 调用）。

    节点 execute 运行在 worker 的 asyncio 事件循环里，不能再 asyncio.run / 再提交队列
    （会死锁）。故在新线程里用 PromptExecutor 同步执行构图，规避事件循环冲突。
    返回落盘视频绝对路径；失败抛异常。
    """
    import execution
    from server import PromptServer

    server = PromptServer.instance
    graph = build_shot_graph(mode, prompt, seed=seed, seconds=seconds, frame_rate=frame_rate,
                             first_frame=first_frame, last_frame=last_frame, refs=refs,
                             audios=audios, ref_by_num=ref_by_num, audio_by_num=audio_by_num,
                             videos=videos, video_by_num=video_by_num,
                             common_prompt=common_prompt, common_enabled=common_enabled,
                             steps=steps, cfg=cfg, opts=opts)
    prompt_id = "mrnext_sync_" + str(uuid.uuid4().hex)[:8]

    out_base = folder_paths.get_output_directory()
    before_files = set(_glob_h3_outputs(f"{_H3_PREFIX}_*.mp4"))

    result = {}

    def _run():
        try:
            server.node_replace_manager.apply_replacements(graph)
            ex = execution.PromptExecutor(
                server,
                cache_type=execution.CacheType.NONE,
                cache_args={"lru": 0, "ram": 4.0, "ram_inactive": 8.0})
            ex.execute(graph, prompt_id)
            result["success"] = ex.success
            result["error"] = ("; ".join(ex.status_messages[-3:]) if ex.status_messages else "") if not ex.success else ""
        except Exception as exc:  # noqa: BLE001
            import traceback
            result["success"] = False
            result["error"] = str(exc)[:200] + " || " + traceback.format_exc()[-800:]

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        raise TimeoutError("H3 同步采样超时（>%ds）" % timeout)
    if not result.get("success"):
        _err = result.get("error") or "unknown"
        raise RuntimeError("H3 采样出错: " + _err + _dim_error_hint(_err, graph))
    return _collect_video_after_sync(mode, seed, out_dir, before_files)
