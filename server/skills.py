"""skills.py — Skill 提示词优化（本地 Qwen）。

干净封装 comfyUI-llama-TE 的模型存储（_QwenStorage / _调用chat_completion），
不复制其庞大 UI 层，只取最小必要接口：
  - _module()            定位 llama-TE nodes 模块（包名含连字符，走 sys.modules）
  - list_llm_models()    列出 models/LLM 下的主模型与 mmproj
  - families()           可加载的模型系列选项
  - load_model()         构建 config → _QwenStorage.load（与画布加载器同源）
  - status()             当前已加载模型
  - optimize()           Skill 正文 + Task 指令 → 本地 Qwen 单轮对话 → 返回优化文本
本模块不 import aiohttp，只返回纯数据 / 抛异常，由路由层包 HTTP。
"""

import os
import re
import sys

import folder_paths

# 系列常量（与 llama-TE 加载器同源校准；QWEN38系列 若在则替换末项）
_FALLBACK_FAMILIES = ["Qwen3-VL", "Qwen3.5-VL", "Qwen3.6-VL", "Qwen3.8-VL"]

# 模型目录相对 models/
_LLM_FOLDER = "LLM"

DEFAULT_INSTRUCTION = (
    "你是一位提示词优化专家。请严格按上面 Skill 的规范重写/优化下面的提示词。"
    "只输出优化后的结果，不要解释。\n"
    "（重要：禁止输出思考过程、分析、推理、计划、草稿、注释或任何非最终结果的内容；"
    "直接给出最终结果正文。）\n"
    "（No thinking process, no analysis, no reasoning, no plan, no draft, no notes; "
    "output only the final optimized result.）"
)


def default_skills_base():
    """默认技能库：优先内置（本包 skills/ = MiniMax H3 官方 9 个 + 短剧/漫剧/电影 30 个）。
    旧包 skills/ 不存在时回退空串。"""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 包根
    builtin = os.path.join(here, "skills")
    if os.path.isdir(builtin):
        return builtin
    old = os.path.join(os.path.dirname(here), "ComfyUI_MRBoard", "skills")
    return old if os.path.isdir(old) else ""


# ---------------- llama-TE 定位 ----------------

def _is_storage(obj):
    """_QwenStorage 类判定。绝不能对 torch.ops 这类魔术模块用 hasattr 探测。"""
    return (
        obj is not None
        and isinstance(obj, type)
        and callable(getattr(obj, "load", None))
        and callable(getattr(obj, "unload", None))
    )


def _module():
    mod = sys.modules.get("comfyUI-llama-TE.nodes")
    if mod is not None and _is_storage(getattr(mod, "_QwenStorage", None)):
        return mod
    for name, m in list(sys.modules.items()):
        if name.endswith("nodes") and _is_storage(getattr(m, "_QwenStorage", None)):
            return m
    return None


def package_found():
    return _module() is not None


# ---------------- 模型清单与家族 ----------------

def _list_llm_files(folder=""):
    """列出目录下全部文件名（分片只取第一片）。
    folder 为空 → models/LLM；否则扫该自定义目录（旧包做法：任意装 GGUF 的目录）。"""
    try:
        if folder:
            if not os.path.isdir(folder):
                return []
            files = [f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f))]
        else:
            files = folder_paths.get_filename_list(_LLM_FOLDER)
    except Exception:  # noqa: BLE001
        files = []
    if not files:
        return []
    shard_re = re.compile(r"^(?P<prefix>.+)-(?P<index>\d{5})-of-(?P<total>\d{5})\.\w+$", re.I)
    keep = []
    for f in files:
        m = shard_re.fullmatch(os.path.basename(f))
        if m is not None and int(m.group("index")) != 1:
            continue  # 跳过非首分片
        keep.append(f)
    return keep


def list_llm_models(folder=""):
    """返回 (主模型列表, mmproj 列表)。优先走 llama-TE 过滤逻辑；支持自定义 folder。"""
    files = _list_llm_files(folder)
    mod = _module()
    filt = getattr(mod, "_过滤可选llm文件", None) if mod else None
    ok_ext = {".gguf", ".safetensors", ".bin", ".pth", ".pt"}
    if callable(filt):
        try:
            models = filt(files, is_mmproj=False)
            mmproj = ["无"] + filt(files, is_mmproj=True)
            return models, mmproj
        except Exception:  # noqa: BLE001
            pass
    models = [f for f in files if os.path.splitext(f)[1].lower() in ok_ext and "mmproj" not in f.lower()]
    mmproj = ["无"] + [f for f in files if "mmproj" in f.lower() and os.path.splitext(f)[1].lower() in ok_ext]
    return models, mmproj


def recommend_params(model, folder=""):
    """按模型版本/体积推荐最优参数（最大上下文 n_ctx + 采样参数）。

    与旧包「选模型版本自动套最优参数」对齐：新版本 Qwen（3.6/3.8）支持更大上下文，
    小体积模型（≤8B）收敛上下文以省显存。返回可直接喂 load_model/optimize 的 dict。
    """
    key = _version_key(model)
    low = (model or "").lower()
    # 基础推荐
    rec = {
        "n_ctx": 16384,
        "temperature": 0.7,
        "top_p": 0.9,
        "top_k": 20,
        "max_tokens": 2048,
        "n_gpu_layers": -1,
        "think": False,
        "reasoning_effort": "xhigh",
    }
    # 按版本放大上下文
    if key in ("3.8", "3.6"):
        rec["n_ctx"] = 32768
        rec["temperature"] = 0.6
    elif key == "3.5":
        rec["n_ctx"] = 24576
    elif key == "3vl":
        rec["n_ctx"] = 16384
    # 按体积收敛上下文（省显存）：如 4B / 8B
    mb = re.search(r"(\d+(?:\.\d+)?)\s*b", low)
    if mb:
        try:
            size = float(mb.group(1))
            if size <= 8:
                rec["n_ctx"] = min(rec.get("n_ctx", 16384), 16384)
            elif size >= 30:
                rec["n_ctx"] = max(rec.get("n_ctx", 16384), 24576)
        except Exception:  # noqa: BLE001
            pass
    # 量化（fp8/int4 等）提示更大上下文可行，但保守不动
    # mmproj 推荐：按模型版本匹配同版本视觉投影模型（切换 LLM 时自动对应）
    try:
        _, _mmproj_list = list_llm_models(folder)
        rec["mmproj"] = _guess_mmproj(model, _mmproj_list)
    except Exception:  # noqa: BLE001
        rec["mmproj"] = "无"
    return rec


def families():
    mod = _module()
    fam = list(_FALLBACK_FAMILIES)
    if mod is not None:
        opt = getattr(mod, "QWEN38系列", None)
        if opt and opt not in fam:
            fam[-1] = opt
    return fam


def _version_key(name):
    low = (name or "").lower()
    for k in ("3.8", "3.6", "3.5"):
        if k in low:
            return k
    if re.search(r"qwen\s*3\s*-?\s*_?\s*vl|qwen3vl", low):
        return "3vl"
    if "gemma" in low:
        return "gemma"
    return ""


def _guess_family(model_file, fam_list=None):
    fam_map = {
        "3.8": "Qwen3.8-VL",
        "3.6": "Qwen3.6-VL",
        "3.5": "Qwen3.5-VL",
        "3.5-text": "Qwen3.5",  # 纯文本模型使用不带 VL 的家庭
        "3vl": "Qwen3-VL",
    }
    key = _version_key(model_file)
    fam = fam_map.get(key, "")
    if fam_list:
        return fam if fam in fam_list else (fam_list[0] if fam_list else "Qwen3-VL")
    return fam or "Qwen3-VL"


def _guess_mmproj(model_file, mmproj_list):
    cands = [m for m in (mmproj_list or []) if m and m != "无"]
    key = _version_key(model_file)
    if not key or not cands:
        return "无"
    return next((c for c in cands if _version_key(c) == key), "无")


# ---------------- 状态 / 加载 ----------------

def status():
    mod = _module()
    storage = getattr(mod, "_QwenStorage", None) if mod else None
    model_obj = getattr(storage, "model", None) if storage else None
    settings = getattr(model_obj, "settings", {}) or {}
    return {
        "package": package_found(),
        "loaded": model_obj is not None,
        "model": settings.get("model", ""),
        "family": settings.get("family", ""),
        "n_ctx": settings.get("n_ctx", 0),
    }


def build_config(model, family=None, mmproj=None, opts=None, folder=""):
    """组装 _QwenStorage.load 的 config（字段与 llama-TE 加载器一致）。"""
    o = opts or {}
    models, mmproj_list = list_llm_models(folder)
    fam = family or _guess_family(model, families())
    mp = mmproj if mmproj not in (None, "", "auto") else _guess_mmproj(model, mmproj_list)
    return {
        "family": fam,
        "model": model,
        "mmproj": mp if mp else "无",
        "think": bool(o.get("think", False)),
        "preserve_thinking": bool(o.get("preserve_thinking", False)),
        "reasoning_effort": str(o.get("reasoning_effort") or "xhigh"),
        "cpu_moe": bool(o.get("cpu_moe", False)),
        "n_cpu_moe": int(o.get("n_cpu_moe") or 0),
        "n_ctx": int(o.get("n_ctx") or 16384),
        "n_gpu_layers": int(o.get("n_gpu_layers") if o.get("n_gpu_layers") is not None else -1),
        "cache_type_k": o.get("cache_type_k") or "默认(F16)",
        "cache_type_v": o.get("cache_type_v") or "默认(F16)",
        "mtp_enabled": bool(o.get("mtp_enabled", False)),
        "mtp_draft_tokens": int(o.get("mtp_draft_tokens") or 2),
        "flash_attn": o.get("flash_attn") or "不开启",
    }


def load_model(model, family=None, mmproj=None, opts=None, folder=""):
    """同步加载模型（调用方放进线程池，首载可达分钟级）。

    folder 非空且 model 非绝对路径 → 拼成该目录下的绝对路径（旧包做法）：
    llama-TE 内部 os.path.join(models_dir, "LLM", path) 遇到绝对路径会整体重置，
    因此主模型与 mmproj 都能命中自定义目录，无需改动 llama-TE 包。
    """
    mod = _module()
    if mod is None:
        raise RuntimeError("未检测到 comfyUI-llama-TE 包（Qwen TE 模型加载器）")
    storage = mod._QwenStorage
    full_model = os.path.join(folder, model) if (folder and not os.path.isabs(model)) else model
    config = build_config(full_model, family, mmproj, opts, folder=folder)
    storage.load(config)
    return {"model": config["model"], "family": config["family"]}


def unload_model():
    mod = _module()
    if mod is None:
        return False
    mod._QwenStorage.unload()
    return True


# ---------------- 优化 ----------------

def _extract_reply(result):
    """从 llama.cpp 对话结果取最终文本，剥掉 thinking 片段。
    兼容多种返回结构：dict / 对象 / None / 缺 choices / 走 reasoning_content。"""
    # 1) 取 message 对象（dict 或 OpenAI 风格对象都行）
    msg = None
    try:
        if isinstance(result, dict):
            choices = result.get("choices") or []
        else:
            choices = getattr(result, "choices", None) or []
        if not choices:
            return str(result).strip() if result is not None else ""
        first = choices[0]
        msg = first.get("message") if isinstance(first, dict) else getattr(first, "message", None)
    except Exception:  # noqa: BLE001
        return str(result).strip() if result is not None else ""

    if not isinstance(msg, dict):
        msg = {"content": str(msg) if msg is not None else ""}
    content = msg.get("content")
    reasoning = msg.get("reasoning_content")
    if isinstance(content, list):
        content = "\n".join(
            p.get("text", "") if isinstance(p, dict) else str(p) for p in content
        )
    raw = (content or "").strip()
    if not raw and reasoning:
        raw = str(reasoning)
    if not raw:
        return ""

    # 剥 thinking 标签与常见推理开场白（中英扩展）
    raw = re.sub(r"<\s*think(?:ing)?\b[^>]*>.*?(?:<\s*/\s*think(?:ing)?\s*>|$)", "", raw, flags=re.S | re.I)
    for marker in ("here's a thinking process", "let me think step by step",
                   "let's think step by step", "thinking process:",
                   "thinking process：", "思考过程：", "思考过程:",
                   "分析过程：", "分析过程:", "让我思考", "让我想想",
                   "好的，用户", "好的，用户要求", "好的，用户让"):
        i = raw.lower().find(marker)
        if i >= 0:
            # 取 marker 所在行之后的所有内容（去掉标记本身那一行）
            body = "\n".join(raw[i:].splitlines()[1:]).strip()
            if body:
                return body
            break
    return raw.strip()


def _extract_reasoning(result):
    """从 llama.cpp 结果里取「推理过程」（思考模式的 reasoning_content 或 <think> 块）。

    与 _extract_reply 相反：这里专门保留被剥离的思考内容，供前端「推理过程预览」显示。
    取不到返回空串（例如思考模式关闭 / 模型不吐 reasoning）。
    """
    try:
        if isinstance(result, dict):
            choices = result.get("choices") or []
        else:
            choices = getattr(result, "choices", None) or []
        if not choices:
            return ""
        first = choices[0]
        msg = first.get("message") if isinstance(first, dict) else getattr(first, "message", None)
    except Exception:  # noqa: BLE001
        return ""
    if not isinstance(msg, dict):
        return ""
    parts = []
    rc = msg.get("reasoning_content") or msg.get("reasoning")
    if rc:
        parts.append(str(rc).strip())
    content = msg.get("content")
    if isinstance(content, list):
        content = "\n".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    if content:
        # 取 <think>/<thinking> 块原文（可能有多段）
        for m in re.finditer(r"<\s*think(?:ing)?\b[^>]*>(.*?)(?:<\s*/\s*think(?:ing)?\s*>|$)",
                             str(content), flags=re.S | re.I):
            body = (m.group(1) or "").strip()
            if body:
                parts.append(body)
    return "\n\n".join([x for x in parts if x]).strip()


def optimize(text, skill_content="", instruction="", *, params=None, collect=None):
    """单轮对话优化。调用方放进线程池。返回优化后文本，失败抛异常。
    collect: 传入 list 时，把本轮模型思考过程（reasoning）追加进去。"""
    mod = _module()
    if mod is None:
        raise RuntimeError("未检测到 comfyUI-llama-TE 包（Qwen TE 模型加载器）")
    storage = mod._QwenStorage
    model_obj = getattr(storage, "model", None)
    llm = getattr(model_obj, "llm", None) if model_obj else None
    if llm is None:
        raise RuntimeError("本地 Qwen 模型尚未加载：请先在「Skill」面板选模型并加载（首载 1-5 分钟）")

    p = params or {}
    system_parts = []
    if (skill_content or "").strip():
        system_parts.append("# Skill\n" + skill_content.strip())
    system_parts.append("# Task\n" + (instruction or DEFAULT_INSTRUCTION))
    messages = [
        {"role": "system", "content": "\n\n".join(system_parts)},
        {"role": "user", "content": text},
    ]

    # 采样参数（沿用旧版稳定默认）
    temperature = float(p.get("temperature") or 0.7)
    top_p = float(p.get("top_p") or 0.9)
    top_k = int(p.get("top_k") or 20)
    settings = getattr(model_obj, "settings", {}) or {}
    try:
        n_ctx = int(settings.get("n_ctx") or 8192)
    except Exception:  # noqa: BLE001
        n_ctx = 8192

    # token 预算：prompt + 输出必须塞进 n_ctx
    prompt_text = "\n".join(str(m.get("content") or "") for m in messages)
    try:
        try:
            prompt_tokens = len(llm.tokenize(prompt_text.encode("utf-8"), add_bos=False, special=False))
        except TypeError:
            prompt_tokens = len(llm.tokenize(prompt_text.encode("utf-8"), add_bos=False))
    except Exception:  # noqa: BLE001
        prompt_tokens = int(len(prompt_text) * 0.7)
    budget = n_ctx - prompt_tokens - 64
    if budget < 256:
        raise RuntimeError(
            f"提示词 + Skill 正文约 {prompt_tokens} tokens，装不进 n_ctx={n_ctx}；"
            "请调大上下文（如 32768）后重新加载模型"
        )

    call = getattr(mod, "_调用chat_completion", None)
    sample_fn = getattr(mod, "_应用qwen38推荐采样", None) if mod else None
    if callable(sample_fn) and model_obj is not None:
        try:
            temperature, top_p, top_k = sample_fn(model_obj, temperature, top_p, top_k)
        except Exception:  # noqa: BLE001
            pass
    max_tokens = max(256, min(int(p.get("max_tokens") or 2048), budget))
    chat_params = {
        "temperature": temperature,
        "top_p": top_p,
        "top_k": top_k,
        "max_tokens": max_tokens,
    }
    min_p_fn = getattr(mod, "_获取qwen38_min_p", None) if mod else None
    if callable(min_p_fn):
        try:
            v = min_p_fn(model_obj)
            if v is not None:
                chat_params["min_p"] = float(v)
        except Exception:  # noqa: BLE001
            pass

    if callable(call):
        result = call(llm, messages=messages, params=chat_params)
    else:
        result = llm.create_chat_completion(messages=messages, **chat_params)
    # collect：[可选] 外部传入的 list，用来收集每轮推理过程（供「推理过程预览」）
    if isinstance(collect, list):
        try:
            rsn = _extract_reasoning(result)
            if rsn:
                collect.append(rsn)
        except Exception:  # noqa: BLE001
            pass
    return _extract_reply(result)


_END_RE = re.compile(r"[。！？!?\.。\"'）)\]}】》」』]\s*$")


def _looks_truncated(text, params):
    """启发式判断输出是否被 max_tokens 截断（需要接续）。"""
    t = (text or "").strip()
    if not t:
        return False
    try:
        mt = int((params or {}).get("max_tokens") or 2048)
    except Exception:  # noqa: BLE001
        mt = 2048
    # 接近上限（中文按 1 字≈1 token 粗估，英文偏小，取 0.85 阈值）
    if len(t) >= mt * 0.85:
        return True
    # 不以结束标点结尾 → 大概率被截断
    return not _END_RE.search(t)


def optimize_continue(text, skill_content="", instruction="", *, params=None,
                      max_rounds=3, on_round=None, collect=None):
    """接续推理（参考旧包）：单轮输出被截断时，把已生成内容作为前缀继续生成，直到完整或达轮次上限。

    每轮把「已生成 + 续写指令」作为新的 user 输入再调一次模型，结果拼接，直到
    _looks_truncated 判定完整（以结束符收尾且未逼近 max_tokens）或达到 max_rounds。
    on_round(round, text) 可选回调，用于前端显示进度。
    """
    p = dict(params or {})
    result = optimize(text, skill_content, instruction, params=p, collect=collect)
    rounds = 1
    if callable(on_round):
        try:
            on_round(rounds, result)
        except Exception:  # noqa: BLE001
            pass
    while rounds < max_rounds and _looks_truncated(result, p):
        cont = (result or "").rstrip() + (
            "\n\n（上面是已生成的部分。请严格从断点处继续写完剩余内容，"
            "不要重复已写内容，不要解释，直接接着写。）"
        )
        more = optimize(cont, skill_content, instruction, params=p, collect=collect)
        if not more or not more.strip():
            break
        result = result.rstrip() + "\n" + more.strip()
        rounds += 1
        if callable(on_round):
            try:
                on_round(rounds, result)
            except Exception:  # noqa: BLE001
                pass
    return result


# ---------------- 技能库扫描（纯文件系统） ----------------

def scan_skills(base):
    """列出 base 下含 SKILL.md / SKILL.cn.md 的技能目录。"""
    out = []
    if not base or not os.path.isdir(base):
        return out
    for name in sorted(os.listdir(base)):
        d = os.path.join(base, name)
        if not os.path.isdir(d):
            continue
        files = [f for f in ("SKILL.cn.md", "SKILL.md") if os.path.isfile(os.path.join(d, f))]
        if not files:
            continue
        meta, desc = _skill_meta(os.path.join(d, files[0]))
        label = meta or name
        out.append({
            "id": name,
            "name": label,
            "description": desc,
            "cn": "SKILL.cn.md" in files,
        })
    return out


def read_skill(base, skill_id):
    """读取技能正文：优先 SKILL.cn.md，回退 SKILL.md。返回 (content, filename)。"""
    if not base or not skill_id:
        raise FileNotFoundError("技能路径为空")
    d = os.path.abspath(os.path.join(base, skill_id))
    if not d.startswith(os.path.abspath(base)):
        raise ValueError("技能路径越界")
    for f in ("SKILL.cn.md", "SKILL.md"):
        p = os.path.join(d, f)
        if os.path.isfile(p):
            with open(p, "r", encoding="utf-8", errors="ignore") as fh:
                return fh.read(), f
    raise FileNotFoundError(f"技能 {skill_id} 不存在")


def _skill_meta(path):
    """提取 frontmatter 的 name/label 与 description（没有则返回目录名/首行）。"""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            head = fh.read(4000)
    except Exception:  # noqa: BLE001
        return "", ""
    m = re.match(r"^---\s*\n(.*?)\n---", head, re.S)
    if not m:
        first = next((ln.strip() for ln in head.splitlines() if ln.strip()), "")
        return first.strip("# ").strip(), ""
    body = m.group(1)
    name = ""
    desc = ""
    label = ""
    for ln in body.splitlines():
        low = ln.lower()
        if low.startswith("label:") and not label:
            label = ln.split(":", 1)[1].strip().strip("'\"")
        elif (low.startswith("name:") or low.startswith("label:")) and not name:
            name = ln.split(":", 1)[1].strip().strip("'\"")
        elif low.startswith("description:") and not desc:
            desc = ln.split(":", 1)[1].strip().strip("'\"")
    return label or name, desc  # 优先中文 label（中文名），否则英文 name/id
