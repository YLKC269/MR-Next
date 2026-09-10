"""h3shot.py — 官方 MiniMax H3 Director 引擎 · 逐镜成片（媒体感知，修复版）。

两套构图（官方 example 载荷模板 + 确定性替换）：
  t2v                    → MiniMaxH3Director 单节点（timeline_data 深替换 prompt/帧数）
  i2v / fl2v / fl2v_tail → Group(ImageToVideo) 外部组 → Combine → director.i2v_groups
  r2v                    → Group(ReferenceToVideo) 外部组 → Combine → director.r2v_groups
节点 id 用数字字符串；链接一律 [node_id, slot]。顶层 no_wrap 陷阱：node_id 不得再套层。
"""

import asyncio
import glob
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
# 必须整体让路 —— 内置 sage / TE-Speed / 加速 LoRA 都会改写模型与噪声调度，与外部加速
# 叠加会变成"双重加速"（调度被改两遍 → 画面发灰、显存反而爆）。
_ACCEL_OPT_KEYS = ("sage_attention", "sparse_attention", "speed_node", "speed_mode", "speed_lora")
_ACCEL_OPT_LABEL = {
    "sage_attention": "BlockSparse/SageAttention",
    "sparse_attention": "BlockSparse/SageAttention",
    "speed_node": "TE-Speed 加速节点",
    "speed_mode": "TE-Speed 加速节点",
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
_EXT_SELF_RE = re.compile(r"MRBoard|MRNext|MiniMaxH3MemoryEfficientSageAttentionPatch|MiniMaxH3Director|^TESpeedMiniMaxH3$", re.I)
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
              "steps", "sampler", "scheduler", "shift_video", "shift_audio", "cfg"):
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
    并按需串入通用 LoRA → 加速 LoRA → TESpeedMiniMaxH3 加速节点。

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
    # 加速 LoRA（8/4 步蒸馏，可选，配合 TE-Speed 的 8-step/4-step 模式）
    acc_lora = o.get("speed_lora") or ""
    if acc_lora and acc_lora != "(无)":
        acc_strength = float(o.get("speed_lora_strength") or 1.0)
        al = str(seq[0]); seq[0] += 1
        g[al] = {"class_type": "LoraLoaderModelOnly",
                 "inputs": {"model": link(model_node), "lora_name": acc_lora,
                            "strength_model": acc_strength}}
        model_node = al
    # TE-Speed-MiniMaxH3 加速节点（可选；mode: standard / 4-step LoRA / 8-step LoRA）
    speed_mode = o.get("speed_node") or o.get("speed_mode") or ""
    if speed_mode and speed_mode != "off":
        sd = str(seq[0]); seq[0] += 1
        g[sd] = {"class_type": "TESpeedMiniMaxH3",
                 "inputs": {"model": link(model_node),
                            "processing_control_value": float(o.get("speed_control") or 0.08),
                            "processing_percent_1": float(o.get("speed_pct1") or 0.1),
                            "processing_percent_2": float(o.get("speed_pct2") or 0.9),
                            "mcs": int(o.get("speed_mcs") or 2),
                            "device": o.get("speed_device") or "auto",
                            "mode": speed_mode}}
        model_node = sd
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


def _sync_timeline_size(widget, megapixels=None):
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


def build_shot_graph(mode, prompt, seed=0, seconds=5.0, frame_rate=24.0,
                     first_frame=None, last_frame=None, refs=None, audios=None, _variant=None,
                     steps=None, cfg=None, opts=None):
    """返回 API prompt dict（数字字符串 node id）。

    opts 字段（覆盖官方默认）：unet_name, clip_name, video_vae_name, audio_vae_name, lora_name,
    lora_strength, width, height, ref_max_size, total_frames, frame_rate, steps, sampler,
    scheduler, shift_video, shift_audio, cfg。steps/cfg 兼容旧参数。
    加速（可选）：speed_lora/speed_lora_strength（8/4步蒸馏 LoRA，LoraLoaderModelOnly 串链），
    speed_node=standard|4-step LoRA|8-step LoRA + speed_device(默认 auto)+speed_control/speed_pct1/
    speed_pct2/speed_mcs → 模型链末尾插 TESpeedMiniMaxH3 加速节点。
    """
    opts_obj = dict(opts or {})
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
    # H3 官方百万像素（0.1–2）：按当前比例换算出宽高（与前端同一算式，后端兜底 → 一定生效）
    _mp = opts_obj.get("megapixels")
    if _mp:
        _wh = _mp_to_wh(_mp, opts_obj.get("width"), opts_obj.get("height"))
        if _wh:
            opts_obj["width"], opts_obj["height"] = _wh
    # 其它 director 参数/输出尺寸覆盖
    _apply_opts_overrides(widget, opts_obj)
    _sync_timeline_size(widget, megapixels=_mp)  # 把尺寸 + megapixels 同步进 timeline_data
    if _variant == "no_labels":
        widget = {k: v for k, v in widget.items() if not k.startswith("bd_grp_")}

    if mode not in _GROUP_MODES:
        # t2v：单节点 + timeline 替换
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

    if mode == "r2v":
        ref_ids = [load_image(r) for r in (refs or [])[:9] if r]
        g_ins = {f"ref_images.ref_image_{k}": link(nid) for k, nid in enumerate(ref_ids)}
        # 音色参考：<Audio N> → ref_audios.ref_audio_{N-1}
        # （官方组节点输入名，与 ref_images.ref_image_k 同构；H3 最多 3 条参考音频）
        aud_ids = [add("LoadAudio", {"audio": a}) for a in (audios or [])[:3] if a]
        if aud_ids:
            g_ins.update({f"ref_audios.ref_audio_{k}": link(nid) for k, nid in enumerate(aud_ids)})
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


async def run_shot(mode, prompt, out_dir, *, seed=0, seconds=5.0, frame_rate=24.0,
                   first_frame=None, last_frame=None, refs=None, audios=None, steps=None, cfg=None,
                   opts=None, timeout=2400):
    import execution
    from server import PromptServer

    server = PromptServer.instance
    graph = build_shot_graph(mode, prompt, seed=seed, seconds=seconds, frame_rate=frame_rate,
                             first_frame=first_frame, last_frame=last_frame, refs=refs,
                             audios=audios, steps=steps, cfg=cfg, opts=opts)
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
                raise RuntimeError("H3 采样出错: " + detail)
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
                  first_frame=None, last_frame=None, refs=None, audios=None, steps=None, cfg=None,
                  opts=None, timeout=2400):
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
                             audios=audios, steps=steps, cfg=cfg, opts=opts)
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
        raise RuntimeError("H3 采样出错: " + (result.get("error") or "unknown"))
    return _collect_video_after_sync(mode, seed, out_dir, before_files)
