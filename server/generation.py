"""图像生成（phase 2：真实扩散 · Krea2 txt2img）。

实现：构造 Krea2 官方节点图（与旧版前端构图同参）→ 走 ComfyUI prompt 队列
（与「前端队列生成」同一 worker，不进程内二次 executor，避免抢模型/事件循环）→
轮询 history 直到完成 → 把 SaveImage 落盘图拷入目标资产文件夹。

- 模型缺失 / 图校验失败 / 执行出错 / 超时 → 抛异常，由调用方回退占位图。
- 模型默认值与可用清单集中在此，前端只展示。
"""

import asyncio
import os
import shutil
import time
import uuid

import folder_paths

_execution = None
_PromptServer = None


def _runtime():
    """惰性引用 ComfyUI 顶层模块（避免模块导入期副作用）。"""
    global _execution, _PromptServer
    if _execution is None:
        import execution  # noqa: PLC0415  ComfyUI 根 execution.py
        from server import PromptServer  # noqa: PLC0415

        _execution = execution
        _PromptServer = PromptServer
    return _execution, _PromptServer


# ---------------- 模型清单与默认值 ----------------

def _list_models(folder, kw=""):
    try:
        names = folder_paths.get_filename_list(folder)
    except Exception:  # noqa: BLE001
        return []
    return [str(n) for n in names if not kw or kw.lower() in str(n).lower()]


def krea2_defaults():
    """返回 (diffusion, text_encoder, vae) 本机最优默认值，找不到则空串。"""
    diffusion = _list_models("diffusion_models", "krea2")
    tes = _list_models("text_encoders", "qwen3vl")
    vaes = _list_models("vae", "qwen_image")

    model = next((n for n in diffusion if "krea2_turbo_fp8" in n), diffusion[0] if diffusion else "")
    te = next((n for n in tes if "qwen3vl_4b" in n), tes[0] if tes else "")
    vae = next((n for n in vaes if "HDR" not in n), vaes[0] if vaes else "")
    return model, te, vae


def krea2_model_list():
    return {
        "diffusion": _list_models("diffusion_models", "krea2"),
        "text_encoders": _list_models("text_encoders", "qwen3vl"),
        "vaes": _list_models("vae", "qwen_image"),
    }


_PREVIEW_HOOKED = False


def _install_preview_hook():
    """monkeypatch 采样进度回调，把 preview 图落盘到 output/mrnext_preview/latest_{pid}.jpg。

    与 h3shot 用同一目录/命名，因此前端可复用 /mrnext/h3/preview_latest 轮询生图实时预览。
    已 hook 过（含 h3shot 安装的情况）则跳过，避免重复 patch。
    """
    global _PREVIEW_HOOKED
    if _PREVIEW_HOOKED:
        return
    try:
        import comfy_execution.progress as _prog
    except Exception:  # noqa: BLE001
        return
    if getattr(_prog.WebUIProgressHandler, "_mrnext_hooked", False):
        _PREVIEW_HOOKED = True
        return
    _orig = _prog.WebUIProgressHandler.update_handler

    def _patched(self, node_id, value, max_value, state, pid, image=None):
        if image is not None:
            try:
                d = os.path.join(folder_paths.get_output_directory(), "mrnext_preview")
                os.makedirs(d, exist_ok=True)
                image[1].save(os.path.join(d, "latest_%s.jpg" % pid), "JPEG", quality=55)
            except Exception:  # noqa: BLE001
                pass
        return _orig(self, node_id, value, max_value, state, pid, image)

    _prog.WebUIProgressHandler.update_handler = _patched
    _prog.WebUIProgressHandler._mrnext_hooked = True
    _PREVIEW_HOOKED = True


def seedvr2_models():
    """检测 SeedVR2 DiT + VAE 模型是否可用；返回 (dit, vae) 模型名，缺失返回 (None, None)。"""
    sd = os.path.join(folder_paths.models_dir, "SEEDVR2")
    try:
        names = [n for n in os.listdir(sd) if n.endswith(".safetensors")]
    except Exception:  # noqa: BLE001
        return None, None
    dit = next((n for n in names if "fp8" in n.lower() or "3b" in n.lower()),
               next((n for n in names if "dit" in n.lower() or "ema" not in n.lower()), None))
    vae = next((n for n in names if "vae" in n.lower()), None)
    return (dit, vae) if (dit and vae) else (None, None)


# ---------------- 构图（4 模式：t2i / i2i / ref / edit，参考旧包） ----------------

def _pick_edit_lora():
    """找 Krea2 编辑 LoRA（identity_edit / 编辑 类命名优先）。无则空串（编辑模式允许不强求）。"""
    try:
        names = folder_paths.get_filename_list("loras")
    except Exception:  # noqa: BLE001
        return ""
    best = ""
    for n in names:
        low = str(n).lower()
        if "identity_edit" in low or ("编辑" in str(n)) or (
            "krea2" in low and ("edit" in low or "identity" in low)
        ):
            best = str(n)
            if "identity_edit" in low:
                break
    return best


def list_loras(extra_path=""):
    """返回可用 LoRA 列表（默认 models/loras/ + extra_path 指定的自定义文件夹，合并去重）。
    extra_path:
      空串             → 仅默认目录
      绝对路径 /models 子目录 / 相对路径 → 会尝试解析到本机真实路径并扫描
    """
    out = []
    seen = set()
    def _add(name, prefix=""):
        k = str(name).strip()
        if not k or k in seen: return
        seen.add(k)
        out.append((prefix + k) if prefix else k)
    try:
        for n in folder_paths.get_filename_list("loras"):
            s = str(n)
            if s.startswith("put_"):
                continue
            _add(s)
    except Exception:  # noqa: BLE001
        pass
    if extra_path:
        for n in _scan_extra_lora_dir(extra_path):
            _add(n)
    return out


def _scan_extra_lora_dir(extra_path):
    """扫描用户指定 LoRA 目录，返回 ['ext/xxx.safetensors', ...] 形式（带子目录相对路径前缀）。
    优先尝试 folder_paths 解析（含 loras/xxx 子目录）；失败则按绝对/相对路径扫磁盘。
    只收 .safetensors / .pt / .bin / .ckpt。"""
    if not extra_path:
        return []
    extras = []
    LORA_EXT = (".safetensors", ".pt", ".bin", ".ckpt")
    def _walk(root, prefix=""):
        try:
            for name in sorted(os.listdir(root)):
                full = os.path.join(root, name)
                if os.path.isdir(full):
                    extras.extend(_walk(full, prefix + name + "/"))
                elif any(name.lower().endswith(e) for e in LORA_EXT):
                    if not name.startswith("put_"):
                        extras.append(prefix + name)
        except Exception:
            pass
        return extras
    # 1) 试 folder_paths（传入绝对路径 或 "loras/foo" 形式）
    try:
        keys_to_try = []
        # 如果用户传了 "loras/xxx"，直接当 folder
        if extra_path.startswith("loras"):
            keys_to_try.append(extra_path)
        # 也许 extra_path 已经是绝对路径 ⇒ 走第 2 步
        for k in keys_to_try:
            try:
                names = folder_paths.get_filename_list(k)
                for n in names:
                    s = str(n)
                    if any(s.lower().endswith(e) for e in LORA_EXT) and not s.startswith("put_"):
                        # 去掉顶层 folder key 前缀（保持与默认格式一致）
                        rest = s[len(k):].lstrip("/")
                        extras.append(rest or s)
            except Exception:
                continue
    except Exception:
        pass
    # 2) 直接当绝对/相对路径扫
    if not extras:
        base = None
        try:
            # folder_paths.base_path = ComfyUI 根
            base = folder_paths.base_path
        except Exception:
            base = None
        candidates = []
        if os.path.isabs(extra_path):
            candidates.append(extra_path)
        if base:
            candidates.append(os.path.join(base, extra_path))
            candidates.append(os.path.join(base, "models", extra_path))
        candidates.append(extra_path)
        for c in candidates:
            if os.path.isdir(c):
                extras = _walk(c)
                break
    return extras


def build_graph_v2(mode, *, prompt, model, text_encoder, vae,
                   width=1024, height=1024, steps=8, seed=0,
                   batch_size=1, prefix="mrnext",
                   src_rel="", ref_rels=None, strength=0.6, edit_lora="",
                   enhance="off", scale=None):
    """四模式构图（参考旧包 mrboard_assetgen.js 的 buildGraph）。
    enhance: off|builtin|seedvr2|vosr2；scale: 放大倍率（builtin=latent 倍数 / seedvr2=目标短边倍数 / vosr2=整数倍）。
    mode: t2i(文生图) | i2i(图生图) | ref(参考生图) | edit(编辑图)
    - t2i: EmptyLatentImage + KSampler
    - i2i: LoadImage → VAEEncode → KSampler(denoise=strength)
    - ref: EmptyLatentImage + 1-3 段 ReferenceLatent 链（角色/风格/场景参考）
    - edit: LoadImage → VAEEncode → ReferenceLatent(1) + Krea2 edit LoRA → KSampler(denoise=1.0) → VAEDecode
    返回 graph dict（节点 id 字符串）。"""
    ref_rels = [str(r) for r in (ref_rels or []) if str(r).strip()]
    if mode not in ("t2i", "i2i", "ref", "edit"):
        raise ValueError("unsupported mode: " + mode)
    if mode in ("i2i", "edit") and not src_rel:
        raise ValueError(mode + " 需要 src_rel（input 相对路径）")
    if mode == "ref" and not ref_rels:
        raise ValueError("ref 模式至少 1 张参考图")

    def link(i, out=0):
        return [str(i), out]

    g = {
        "0": {"class_type": "UNETLoader", "inputs": {"unet_name": model, "weight_dtype": "default"}},
        "1": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": text_encoder, "type": "krea2", "device": "default"}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": link(1)}},
        "4": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": link(3)}},
    }
    model_key = link(0)
    pos_key = link(3)
    neg_key = link(4)

    # ---- 选择/构造 latent_image ----
    if mode == "t2i" or mode == "ref":
        g["5"] = {"class_type": "EmptyLatentImage",
                  "inputs": {"width": int(width), "height": int(height), "batch_size": int(batch_size or 1)}}
        latent_key = link(5)
    else:  # i2i / edit：原图编码后的 latent
        g["li"] = {"class_type": "LoadImage", "inputs": {"image": src_rel}}
        g["enc"] = {"class_type": "VAEEncode", "inputs": {"pixels": link("li"), "vae": link(2)}}
        latent_key = link("enc")

    # ---- 参考 / 编辑 reference 链（串联 pos conditioning） ----
    if mode == "ref":
        # 1-3 段 ReferenceLatent 链
        for i, rel in enumerate(ref_rels[:3]):
            ridx = i  # rl0, rl1, rl2
            li = "rli" + str(ridx)
            ei = "rei" + str(ridx)
            rl = "rl" + str(ridx)
            g[li] = {"class_type": "LoadImage", "inputs": {"image": rel}}
            g[ei] = {"class_type": "VAEEncode", "inputs": {"pixels": link(li), "vae": link(2)}}
            g[rl] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": pos_key, "latent": link(ei)}}
            pos_key = link(rl)
    elif mode == "edit":
        g["rl0"] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": pos_key, "latent": link("enc")}}
        pos_key = link("rl0")
        lora_name = (edit_lora or "").strip() or _pick_edit_lora()
        if lora_name:
            g["lora"] = {"class_type": "LoraLoaderModelOnly",
                         "inputs": {"model": model_key, "lora_name": lora_name, "strength_model": 1.0}}
            model_key = link("lora")

    # ---- 决定 KSampler denoise 与 steps ----
    if mode == "i2i":
        denoise = max(0.05, min(0.95, float(strength)))
    elif mode == "edit":
        denoise = 1.0
    else:
        denoise = 1.0

    g["ks"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": model_key, "positive": pos_key, "negative": neg_key,
            "latent_image": latent_key, "seed": int(seed) & 0xFFFFFFFF,
            "steps": int(steps), "cfg": 1.0,
            "sampler_name": "euler", "scheduler": "simple", "denoise": float(denoise),
        },
    }

    # ---- 增强：仅 t2i / ref 支持 seedvr2 / builtin（i2i/edit 输出尺寸=原图，1.5x 可能过界） ----
    if enhance == "seedvr2" and mode in ("t2i", "ref"):
        dit, vae_name = seedvr2_models()
        if dit and vae_name:
            g["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": link("ks"), "vae": link(2)}}
            short = min(int(width), int(height))
            _sc = max(1.0, min(4.0, float(scale) if scale else 2.0))
            res = max(512, min(2560, (int(round(short * _sc)) // 2) * 2))
            g["sv2_dit"] = {"class_type": "SeedVR2LoadDiTModel", "inputs": {"model": dit, "device": "cuda:0"}}
            g["sv2_vae"] = {"class_type": "SeedVR2LoadVAEModel", "inputs": {"model": vae_name, "device": "cuda:0"}}
            g["sv2_up"] = {"class_type": "SeedVR2VideoUpscaler", "inputs": {
                "image": link("dec"), "dit": link("sv2_dit"), "vae": link("sv2_vae"),
                "seed": int(seed) & 0xFFFFFFFF, "resolution": res, "max_resolution": 0,
                "batch_size": 1, "uniform_batch_size": False, "color_correction": "lab",
            }}
            g["save"] = {"class_type": "SaveImage", "inputs": {"images": link("sv2_up"), "filename_prefix": prefix}}
            return g
        enhance = "builtin"  # 缺失回退

    if enhance == "vosr2" and mode in ("t2i", "ref"):
        # VOSR 2.0 一步扩散超分（与视频二采同一套节点）：decode → VOSR2Upscale → SaveImage
        _vs = int(round(max(1.0, min(4.0, float(scale) if scale else 2.0))))
        g["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": link("ks"), "vae": link(2)}}
        g["vos_m"] = {"class_type": "VOSR2ModelLoader", "inputs": {"model": "VOSR2", "dtype": "bf16"}}
        g["vos_up"] = {"class_type": "VOSR2Upscale", "inputs": {
            "model": link("vos_m"), "image": link("dec"), "upscale": _vs,
            "seed": int(seed) & 0xFFFFFFFF, "color_alignment": "wavelet",
            "tile_size": 512, "tile_overlap": 64, "vae_tile_size": 1024, "vae_tile_overlap": 128}}
        g["save"] = {"class_type": "SaveImage", "inputs": {"images": link("vos_up"), "filename_prefix": prefix}}
        return g

    if enhance == "builtin" and mode in ("t2i", "ref"):
        _bs = max(1.0, min(4.0, float(scale) if scale else 1.5))
        g["up"] = {"class_type": "LatentUpscaleBy",
                   "inputs": {"samples": link("ks"), "upscale_method": "bilinear", "scale_by": _bs}}
        g["ks2"] = {
            "class_type": "KSampler",
            "inputs": {
                "model": model_key, "positive": pos_key, "negative": neg_key,
                "latent_image": link("up"), "seed": (int(seed) + 1) & 0xFFFFFFFF,
                "steps": max(4, int(steps) // 2), "cfg": 1.0,
                "sampler_name": "euler", "scheduler": "simple", "denoise": 0.45,
            },
        }
        g["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": link("ks2"), "vae": link(2)}}
    else:
        g["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": link("ks"), "vae": link(2)}}

    g["save"] = {"class_type": "SaveImage", "inputs": {"images": link("dec"), "filename_prefix": prefix}}
    return g


# 兼容旧名（generate.js 老调用点也走这里）

def _build_graph(prompt, model, text_encoder, vae, width, height, steps, seed, prefix,
                 batch_size=1, enhance="off", scale=None):
    """Krea2 txt2img 构图；enhance 可选 "off" | "builtin" | "seedvr2" | "vosr2"。
    builtin：首采后 LatentUpscaleBy（scale 倍，默认 1.5x）→ 二次 KSampler(denoise 0.45) 精修；
    seedvr2：首采 decode 后走 SeedVR2 一步修复超分（目标短边 = 原短边 × scale，默认 2）；
    vosr2  ：首采 decode 后走 VOSR 2.0 一步扩散超分（整数倍 scale，默认 2，快且省显存）。"""
    def link(i, out=0):
        return [str(i), out]

    g = {
        "0": {"class_type": "UNETLoader", "inputs": {"unet_name": model, "weight_dtype": "default"}},
        "1": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": text_encoder, "type": "krea2", "device": "default"}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": link(1)}},
        "4": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": link(3)}},
        "5": {"class_type": "EmptyLatentImage",
              "inputs": {"width": int(width), "height": int(height), "batch_size": int(batch_size or 1)}},
        "6": {"class_type": "KSampler",
              "inputs": {
                  "model": link(0), "positive": link(3), "negative": link(4),
                  "latent_image": link(5), "seed": int(seed) & 0xFFFFFFFF,
                  "steps": int(steps), "cfg": 1.0,
                  "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
              }},
    }
    if enhance == "seedvr2":
        dit, vae_name = seedvr2_models()
        if not (dit and vae_name):
            enhance = "builtin"  # 模型缺失回退内置精修
        else:
            g["7"] = {"class_type": "VAEDecode", "inputs": {"samples": link(6), "vae": link(2)}}
            short = min(int(width), int(height))
            _sc = float(scale) if scale else 2.0
            _sc = max(1.0, min(4.0, _sc))
            res = max(512, min(2560, (int(round(short * _sc)) // 2) * 2))
            g["20"] = {"class_type": "SeedVR2LoadDiTModel", "inputs": {"model": dit, "device": "cuda:0"}}
            g["21"] = {"class_type": "SeedVR2LoadVAEModel", "inputs": {"model": vae_name, "device": "cuda:0"}}
            g["22"] = {"class_type": "SeedVR2VideoUpscaler", "inputs": {
                "image": link(7), "dit": link(20), "vae": link(21),
                "seed": int(seed) & 0xFFFFFFFF, "resolution": res, "max_resolution": 0,
                "batch_size": 1, "uniform_batch_size": False, "color_correction": "lab",
            }}
            g["8"] = {"class_type": "SaveImage", "inputs": {"images": link(22), "filename_prefix": prefix}}
            return g
    if enhance == "vosr2":
        # VOSR 2.0：decode 后按整数倍超分（与视频二采同一套节点，一步扩散，快且省显存）
        _vs = int(round(max(1.0, min(4.0, float(scale) if scale else 2.0))))
        g["7"] = {"class_type": "VAEDecode", "inputs": {"samples": link(6), "vae": link(2)}}
        g["30"] = {"class_type": "VOSR2ModelLoader", "inputs": {"model": "VOSR2", "dtype": "bf16"}}
        g["31"] = {"class_type": "VOSR2Upscale", "inputs": {
            "model": link(30), "image": link(7), "upscale": _vs,
            "seed": int(seed) & 0xFFFFFFFF, "color_alignment": "wavelet",
            "tile_size": 512, "tile_overlap": 64, "vae_tile_size": 1024, "vae_tile_overlap": 128}}
        g["8"] = {"class_type": "SaveImage", "inputs": {"images": link(31), "filename_prefix": prefix}}
        return g
    if enhance == "builtin":
        _bs = max(1.0, min(4.0, float(scale) if scale else 1.5))
        g["9"] = {"class_type": "LatentUpscaleBy",
                  "inputs": {"samples": link(6), "upscale_method": "bilinear", "scale_by": _bs}}
        g["10"] = {"class_type": "KSampler",
                   "inputs": {
                       "model": link(0), "positive": link(3), "negative": link(4),
                       "latent_image": link(9), "seed": int(seed) & 0xFFFFFFFF,
                       "steps": max(4, int(steps) // 2), "cfg": 1.0,
                       "sampler_name": "euler", "scheduler": "simple", "denoise": 0.45,
                   }}
        g["7"] = {"class_type": "VAEDecode", "inputs": {"samples": link(10), "vae": link(2)}}
    else:
        g["7"] = {"class_type": "VAEDecode", "inputs": {"samples": link(6), "vae": link(2)}}
    g["8"] = {"class_type": "SaveImage",
              "inputs": {"images": link(7), "filename_prefix": prefix}}
    return g


def build_enhance_graph(rels, model, text_encoder, vae, prefix, *, seed=0, steps=8,
                        engine="builtin", scale=None):
    """对已生成结果图二次画质增强；engine 可选 "builtin" | "seedvr2" | "vosr2"。
    builtin：LoadImage → VAEEncode → LatentUpscaleBy（scale 倍，默认 1.5）→ KSampler(denoise 0.45) → VAEDecode；
    seedvr2：LoadImage → SeedVR2VideoUpscaler（目标短边 = 原短边 × scale，默认按 1080 兜底）；
    vosr2  ：LoadImage → VOSR2Upscale（整数倍 scale，默认 2；一步扩散，快且省显存）。
    每张图独立成链、共享模型/条件节点，一次排队全部跑完。"""
    def link(i, out=0):
        return [str(i), out]

    if engine == "vosr2":
        # VOSR 2.0 一步扩散超分（与视频二采同一套节点）；单图 = 1 帧 batch，直接可用
        _vs = int(round(max(1.0, min(4.0, float(scale) if scale else 2.0))))
        g = {"vm": {"class_type": "VOSR2ModelLoader", "inputs": {"model": "VOSR2", "dtype": "bf16"}}}
        for i, rel in enumerate(rels):
            sfx = "" if i == 0 else str(i + 1)
            g["li" + sfx] = {"class_type": "LoadImage", "inputs": {"image": rel}}
            g["enh" + sfx] = {"class_type": "VOSR2Upscale", "inputs": {
                "model": link("vm"), "image": link("li" + sfx), "upscale": _vs,
                "seed": (int(seed) + i) & 0xFFFFFFFF, "color_alignment": "wavelet",
                "tile_size": 512, "tile_overlap": 64, "vae_tile_size": 1024, "vae_tile_overlap": 128}}
            g["save" + sfx] = {"class_type": "SaveImage",
                               "inputs": {"images": link("enh" + sfx), "filename_prefix": prefix}}
        return g

    if engine == "seedvr2":
        dit, vae_name = seedvr2_models()
        if not (dit and vae_name):
            raise RuntimeError("SeedVR2 模型缺失（需 models/SEEDVR2 下的 DiT + VAE）")
        # 目标短边 = 原图短边 × scale（默认 2 倍；原逻辑固定 1080 会在小图上过度放大）
        _sc = max(1.0, min(4.0, float(scale) if scale else 0.0))
        g = {
            "ldit": {"class_type": "SeedVR2LoadDiTModel", "inputs": {"model": dit, "device": "cuda:0"}},
            "lvae": {"class_type": "SeedVR2LoadVAEModel", "inputs": {"model": vae_name, "device": "cuda:0"}},
        }
        for i, rel in enumerate(rels):
            s = "" if i == 0 else str(i + 1)
            if _sc > 0:
                try:
                    from PIL import Image as _PILImage  # noqa: PLC0415
                    _p = os.path.join(folder_paths.get_input_directory(), str(rel).replace("/", os.sep))
                    with _PILImage.open(_p) as _im:
                        res = max(512, min(2560, (int(round(min(_im.size) * _sc)) // 2) * 2))
                except Exception:  # noqa: BLE001 —— 读不到尺寸就退回 1080 短边
                    res = 1080
            else:
                res = 1080
            g["li" + s] = {"class_type": "LoadImage", "inputs": {"image": rel}}
            g["enh" + s] = {"class_type": "SeedVR2VideoUpscaler", "inputs": {
                "image": link("li" + s), "dit": link("ldit"), "vae": link("lvae"),
                "seed": (int(seed) + i) & 0xFFFFFFFF, "resolution": res, "max_resolution": 0,
                "batch_size": 1, "uniform_batch_size": False, "color_correction": "lab",
            }}
            g["save" + s] = {"class_type": "SaveImage",
                             "inputs": {"images": link("enh" + s), "filename_prefix": prefix}}
        return g

    g = {
        "0": {"class_type": "UNETLoader", "inputs": {"unet_name": model, "weight_dtype": "default"}},
        "1": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": text_encoder, "type": "krea2", "device": "default"}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": ENH2_PROMPT, "clip": link(1)}},
        "4": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": link(3)}},
    }
    for i, rel in enumerate(rels):
        s = "" if i == 0 else str(i + 1)
        g["li" + s] = {"class_type": "LoadImage", "inputs": {"image": rel}}
        g["enc" + s] = {"class_type": "VAEEncode", "inputs": {"pixels": link("li" + s), "vae": link(2)}}
        g["up" + s] = {"class_type": "LatentUpscaleBy",
                       "inputs": {"samples": link("enc" + s), "upscale_method": "bilinear",
                                  "scale_by": max(1.0, min(4.0, float(scale) if scale else 1.5))}}
        g["ks" + s] = {"class_type": "KSampler",
                       "inputs": {
                           "model": link(0), "positive": link(3), "negative": link(4),
                           "latent_image": link("up" + s), "seed": (int(seed) + i) & 0xFFFFFFFF,
                           "steps": int(steps), "cfg": 1.0,
                           "sampler_name": "euler", "scheduler": "simple", "denoise": 0.45,
                       }}
        g["dec" + s] = {"class_type": "VAEDecode", "inputs": {"samples": link("ks" + s), "vae": link(2)}}
        g["save" + s] = {"class_type": "SaveImage",
                         "inputs": {"images": link("dec" + s), "filename_prefix": prefix}}
    return g


ENH2_PROMPT = "masterpiece, best quality, ultra detailed, sharp focus, high resolution"


# ---------------- 执行入口 ----------------

async def run_krea2_generate(mode, prompt, model, out_root, *,
                              seed=0, width=1024, height=1024, steps=8, batch=1,
                              text_encoder=None, vae=None, timeout=1200, enhance="off",
                              src_rel="", ref_rels=None, strength=0.6, edit_lora="",
                              prompt_id=None, enhance_scale=None):
    """四模式统一生成入口（参考旧包 mrboard_assetgen 的 buildGraph + queuePrompt）。

    mode: t2i / i2i / ref / edit。失败抛异常（由调用方回退占位）。
    enhance_scale: 增强放大倍率（builtin=latent 倍数 / seedvr2=目标短边倍数 / vosr2=整数倍）。
    """
    _runtime()  # 提前 import execution / PromptServer
    from server import PromptServer  # noqa: PLC0415

    te = text_encoder or krea2_defaults()[1]
    va = vae or krea2_defaults()[2]
    if not (model and te and va):
        raise RuntimeError("Krea2 模型组件缺失（需 krea2 diffusion + qwen3vl TE + qwen_image vae）")
    if mode in ("i2i", "edit") and not str(src_rel or "").strip():
        raise ValueError(mode + " 需要 src_rel")
    if mode == "ref" and not (ref_rels and len(ref_rels) > 0):
        raise ValueError("ref 模式至少 1 张参考图")

    import random as _rnd
    if seed is None or int(seed) < 0:
        seed = _rnd.randint(0, 0xFFFFFFFF)
    # 兼容 bool：True → builtin；字符串原样
    if enhance is True:
        enhance = "builtin"
    elif enhance not in ("off", "builtin", "seedvr2", "vosr2"):
        enhance = "off"

    pid = prompt_id or str(uuid.uuid4())
    graph = build_graph_v2(
        mode,
        prompt=prompt, model=model, text_encoder=te, vae=va,
        width=width, height=height, steps=steps, seed=seed,
        batch_size=batch, prefix=f"mrnext/{pid[:8]}",
        src_rel=src_rel, ref_rels=ref_rels or [], strength=strength, edit_lora=edit_lora,
        enhance=enhance, scale=enhance_scale,
    )
    return await _run_graph(graph, out_root, timeout=timeout, prompt_id=pid)


async def run_krea2_t2i(prompt, model, out_root, *,
                        seed=0, width=1024, height=1024, steps=8, batch=1,
                        text_encoder=None, vae=None, timeout=1200, enhance="off",
                        prompt_id=None, enhance_scale=None):
    """真实生成并拷入 out_root；成功返回落盘绝对路径列表，失败抛异常。
    enhance: "off" | "builtin" | "seedvr2" | "vosr2"。prompt_id 可由调用方指定（供前端按 pid 轮询实时预览）。
    enhance_scale: 放大倍率（内置精修=latent 倍数 / SeedVR2=目标短边倍数 / VOSR2=整数倍数）。"""
    execution, server_cls = _runtime()
    server = server_cls.instance

    te = text_encoder or krea2_defaults()[1]
    va = vae or krea2_defaults()[2]
    if not (model and te and va):
        raise RuntimeError("Krea2 模型组件缺失（需 krea2 diffusion + qwen3vl TE + qwen_image vae）")

    import random as _rnd
    if seed is None or int(seed) < 0:
        seed = _rnd.randint(0, 0xFFFFFFFF)

    # 兼容 bool：True → builtin；字符串原样
    if enhance is True:
        enhance = "builtin"
    elif enhance not in ("off", "builtin", "seedvr2", "vosr2"):
        enhance = "off"

    pid = prompt_id or str(uuid.uuid4())
    graph = _build_graph(prompt, model, te, va, width, height, steps, seed, f"mrnext/{pid[:8]}",
                         batch_size=batch, enhance=enhance, scale=enhance_scale)
    return await _run_graph(graph, out_root, timeout=timeout, prompt_id=pid)


async def run_enhance_image(rels, model, out_root, *, seed=0, steps=8,
                            text_encoder=None, vae=None, timeout=1200, engine="builtin",
                            scale=None):
    """对已生成结果图二次画质增强；成功返回落盘绝对路径列表，失败抛异常。
    engine: "builtin" | "seedvr2" | "vosr2"；scale: 放大倍率（默认 builtin 1.5 / 其它 2）。"""
    _runtime()  # 惰性初始化 ComfyUI 顶层模块
    from server import PromptServer  # noqa: PLC0415

    server = PromptServer.instance

    if engine in ("seedvr2", "vosr2"):
        # SeedVR2 / VOSR2 都不依赖 Krea2 模型（各自加载自己的超分权重）
        import random as _rnd
        if seed is None or int(seed) < 0:
            seed = _rnd.randint(0, 0xFFFFFFFF)
        prompt_id = str(uuid.uuid4())
        graph = build_enhance_graph(rels, "", "", "", f"mrnext/enh/{prompt_id[:8]}",
                                    seed=seed, steps=steps, engine=engine, scale=scale)
        return await _run_graph(graph, out_root, timeout=timeout)

    te = text_encoder or krea2_defaults()[1]
    va = vae or krea2_defaults()[2]
    if not (model and te and va):
        raise RuntimeError("Krea2 模型组件缺失（需 krea2 diffusion + qwen3vl TE + qwen_image vae）")

    import random as _rnd
    if seed is None or int(seed) < 0:
        seed = _rnd.randint(0, 0xFFFFFFFF)

    # rel 是 input 相对路径（如 mrboard_next/xxx.png），LoadImage 直接按名加载
    prompt_id = str(uuid.uuid4())
    graph = build_enhance_graph(rels, model, te, va, f"mrnext/enh/{prompt_id[:8]}",
                                seed=seed, steps=steps, engine="builtin", scale=scale)
    return await _run_graph(graph, out_root, timeout=timeout)


async def _run_graph(graph, out_root, *, timeout=1200, prompt_id=None):
    """提交构图到 ComfyUI 队列，轮询 history，收集 SaveImage 输出并拷入 out_root。"""
    execution, server_cls = _runtime()
    server = server_cls.instance
    prompt_id = prompt_id or str(uuid.uuid4())

    # ---- 提交（镜像 server.post_prompt 的核心步骤）----
    number = float(getattr(server, "number", 0))
    server.number = int(number) + 1
    server.node_replace_manager.apply_replacements(graph)
    valid = await execution.validate_prompt(prompt_id, graph, None)
    if not valid[0]:
        raise RuntimeError("图校验失败: " + str(valid[1])[:400])
    outputs_to_execute = valid[2]
    # 队列 extra_data：必须带活跃前端 client_id，否则 ComfyUI 前端进度条显示后不会消失。
    # preview_method=auto 让 ComfyUI 在采样中产生预览图（配合上面的 hook 落盘 → 前端实时预览）。
    extra_data = {"create_time": int(time.time() * 1000), "preview_method": "auto"}
    try:
        sockets = getattr(server, "sockets", None)
        if sockets:
            extra_data["client_id"] = next(iter(sockets))
    except Exception:  # noqa: BLE001
        pass
    _install_preview_hook()  # 生图采样预览图落盘，供前端轮询
    server.prompt_queue.put((number, prompt_id, graph, extra_data, outputs_to_execute, {}))

    # ---- 轮询 history 直到完成/出错/超时 ----
    deadline = time.time() + timeout
    entry = None
    while time.time() < deadline:
        await asyncio.sleep(0.5)
        hist = server.prompt_queue.get_history(prompt_id=prompt_id)
        if prompt_id in hist:
            entry = hist[prompt_id]
            status = entry.get("status") or {}
            if status.get("status_str") == "success":
                break
            if status.get("status_str") == "error":
                msgs = [m for m in (status.get("messages") or []) if m and m[0] == "execution_error"]
                detail = str(msgs[0][1].get("exception_message") or msgs[0][1])[:300] if msgs else "unknown"
                raise RuntimeError("生成执行出错: " + detail)
    else:
        raise TimeoutError("生成超时（>%ds）" % timeout)

    # ---- 收集 SaveImage 输出并拷入目标目录 ----
    images = []
    outputs = (entry or {}).get("outputs") or {}
    for node_id, out in outputs.items():
        if isinstance(out, dict) and out.get("images"):
            images.extend(out["images"])
    if not images:
        raise RuntimeError("执行成功但未取到输出图")

    out_dir = os.path.normpath(out_root)
    os.makedirs(out_dir, exist_ok=True)
    out_base = folder_paths.get_output_directory()
    saved = []
    stamp = int(time.time() * 1000)
    for i, im in enumerate(images):
        src = os.path.join(out_base, (im.get("subfolder") or "").replace("/", os.sep), im.get("filename") or "")
        if not os.path.isfile(src):
            raise RuntimeError("输出文件缺失: " + str(src))
        dst = os.path.join(out_dir, f"{stamp}_{im.get('filename') or ('img_' + str(i))}")
        shutil.copyfile(src, dst)
        saved.append(dst)
    return saved


# ---------------- 占位图（回退/演示用） ----------------

def generate_placeholder(prompt, out_path, seed=0, width=1024, height=1024):
    """生成一张标注提示词的占位图；真实引擎不可用时兜底，保证闭环可演示。"""
    from PIL import Image, ImageDraw, ImageFont  # noqa: PLC0415

    def font(size=28):
        for c in ("C:/Windows/Fonts/msyh.ttc",
                  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                  "/System/Library/Fonts/PingFang.ttc"):
            if os.path.isfile(c):
                try:
                    return ImageFont.truetype(c, size)
                except Exception:  # noqa: BLE001
                    pass
        return ImageFont.load_default()

    import textwrap

    width, height = int(width), int(height)
    img = Image.new("RGB", (width, height), (28, 32, 40))
    draw = ImageDraw.Draw(img)
    draw.rectangle([8, 8, width - 8, height - 8], outline=(90, 110, 140), width=2)
    draw.text((24, 28), "MRBoard Next · 生成占位", fill=(140, 200, 255), font=font(30))
    draw.text((24, 74), f"seed: {seed}", fill=(160, 170, 190), font=font(22))
    y = 120
    for line in textwrap.wrap(prompt or "(空提示词)", 18)[:14]:
        draw.text((24, y), line, fill=(220, 226, 235), font=font(24))
        y += 34
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path)
    return out_path
