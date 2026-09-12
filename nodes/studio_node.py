"""MRBoardStudio — 全新干净节点。

职责：
  - 作为导演台 UI 的宿主（前端在 beforeRegisterNodeDef 里挂一个 DOM widget）。
  - execute() 负责“产出”：读取 UI 落盘的成片/分镜计划，装配为结构化输出
    （分镜数据 / 分镜提示词 / 分镜数），供下游节点消费。
  - 不输出 IMAGE，因此 ComfyUI 不会在节点底部弹出原生预览框。
"""

import json
import os

import folder_paths

CATEGORY = "MRBoard/Next"


def _rekey_graph(graph, prefix="sub"):
    """给子图节点 id 加前缀避免与主图冲突，并重写内部链接引用。"""
    mapping = {str(k): f"{prefix}_{k}" for k in graph}
    new = {}
    for old_id, node in graph.items():
        nid = mapping[str(old_id)]
        ins = {}
        for k, v in node.get("inputs", {}).items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and v[0] in mapping:
                ins[k] = [mapping[v[0]], v[1]]
            else:
                ins[k] = v
        new[nid] = {"class_type": node["class_type"], "inputs": ins}
    return new, mapping


class MRBoardStudio:
    """MR分镜助手导演台 · Next（干净重写）。

    两个工作模式：
      1. 有分镜计划（asset_folder 下 _plan.json）→ execute 返回 subgraph（H3 出片图），
         ComfyUI 在主线程执行子图，直接生成并保存视频（第 4 输出「成片视频」）。
      2. 无分镜计划 → 返回分镜数据/提示词/计数（原 UI 宿主行为）。
    """

    CATEGORY = CATEGORY
    FUNCTION = "execute"
    RETURN_TYPES = ("STRING", "STRING", "INT", "VIDEO")
    RETURN_NAMES = ("分镜数据", "分镜提示词", "分镜数", "成片视频")
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "asset_folder": (
                    "STRING",
                    {"default": "mrboard_next", "multiline": False},
                ),
                "model_name": (
                    "STRING",
                    {"default": "", "multiline": False, "placeholder": "生成用 checkpoint 文件名"},
                ),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
            },
            "optional": {
                "auto_preview": ("BOOLEAN", {"default": True}),
                # 出片参数（JSON，工作流随行携带）。本节点直接「队列运行」时用它建 H3 图；
                # 留空 = 内置保守默认（t2v / 864×480 / 8 步）—— 默认空保证不影响已有工作流。
                # 为什么放节点上：面板里的参数存在浏览器 localStorage，**不随工作流走**，
                # 换个机器/换个人打开工作流参数就没了；写在这里才能真正「跟工作流一起带走」。
                # 可用键见 server/h3shot.py：unet_name / clip_name / video_vae_name /
                # audio_vae_name / lora_name(+lora_strength) / speed_lora(+speed_lora_strength) /
                # steps / cfg / sampler / scheduler / shift_video / shift_audio /
                # width / height / frame_rate / seconds / ref_max_size / attention_accel /
                # clear_vram_between_segments / export_source_images
                # ⚠ 必须 multiline=False：多行 STRING 在 ComfyUI 里是「占据节点剩余高度的
                # 大文本框」，会把下面的 DOM 部件（整个导演台面板）挤到底部，
                # 节点上方出现一大片空白（用户实报）。单行就只占一行。
                "params_json": ("STRING", {"default": "", "multiline": False,
                                           "placeholder": '{"steps": 8, "unet_name": "...", "speed_lora": "..."}'}),
            },
        }

    def execute(self, asset_folder, model_name, seed, auto_preview=True, params_json=""):
        base = folder_paths.get_input_directory()
        folder = asset_folder.strip().strip("/\\").replace("\\", "/")
        plan_path = os.path.join(base, folder, "_plan.json") if folder else ""

        shots = []
        if plan_path and os.path.isfile(plan_path):
            try:
                with open(plan_path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                shots = data.get("shots", []) if isinstance(data, dict) else []
            except Exception:  # noqa: BLE001
                shots = []

        count = len(shots)
        plan_json = json.dumps({"shots": shots}, ensure_ascii=False, indent=2)
        prompt_blob = "\n\n".join(
            f"【第{i + 1}镜】{s.get('prompt', '')}" for i, s in enumerate(shots)
        )

        # 兼容前端可能挂载的预览钩子（无则忽略）
        try:
            ui = getattr(self, "ui", None)
            if callable(ui) and auto_preview:
                ui(shots)
        except Exception:  # noqa: BLE001
            pass

        # 出片参数，优先级：节点 params_json > <folder>/_params.json > 内置保守默认。
        # 为什么有文件这一层：工作流的 widgets_values 是按下标序列化的，前端版本差异会让
        # 位置映射飘；把同一份参数落到素材目录的 _params.json 就不受前端解析影响。
        params = {}
        if plan_path:
            pfile = os.path.join(os.path.dirname(plan_path), "_params.json")
            if os.path.isfile(pfile):
                try:
                    with open(pfile, "r", encoding="utf-8") as fh:
                        loaded = json.load(fh)
                    if isinstance(loaded, dict):
                        params = {k: v for k, v in loaded.items() if v is not None and v != ""}
                except Exception as exc:  # noqa: BLE001
                    print("[MRBoardStudio] _params.json 读取失败（忽略）：", exc)
        if params_json and str(params_json).strip():
            try:
                loaded = json.loads(params_json)
                if isinstance(loaded, dict):
                    params.update({k: v for k, v in loaded.items() if v is not None and v != ""})
                else:
                    print("[MRBoardStudio] params_json 不是 JSON 对象（忽略）")
            except Exception as exc:  # noqa: BLE001
                print("[MRBoardStudio] params_json 解析失败（忽略）：", exc)

        # 出片模式：有分镜 → 用 subgraph 让 ComfyUI 主线程执行 H3 出片（正确走 CUDA 上下文）
        if shots:
            try:
                from ..server import h3shot as _h3
                # ★ 复刻官方导演台：把「逐镜」原样交给官方 Director —— 构造官方 v5 多段时间线
                #   （每镜一个 segment：自己的 prompt / 帧数 / 与前镜连续性），
                #   官方节点逐段生成 + 音轨拼接 + 连续性处理，就是官方导演台的原生行为。
                #   ⚠ 以前是把所有镜的提示词拼成一条 t2v（12 镜 → 一段 15 秒）
                #     → N 个角色挤进同一段互相污染 = 用户看到的"人物乱入"。
                texts = [str(s.get("prompt") or s.get("text") or "").strip() for s in shots]
                if any(texts):
                    # 默认按官方值（25 步 / 864×480）；params_json 或 _params.json 可覆盖。
                    opts = {"width": 864, "height": 480, "steps": 25,
                            "sampler": "res_multistep", "scheduler": "simple"}
                    opts.update({k: v for k, v in params.items()
                                 if k not in ("mode", "seconds", "frame_rate")})
                    graph = _h3.build_shot_graph(
                        "t2v", "", seed=int(seed) if seed else 0, shots=shots,
                        frame_rate=float(params.get("frame_rate") or 24.0),
                        opts=opts)
                    sv_ids = [nid for nid, n in graph.items() if n.get("class_type") == "SaveVideo"]
                    if sv_ids:
                        sub_graph, mapping = _rekey_graph(graph, prefix="mrshot")
                        return {"expand": sub_graph, "result": [None, None, None, [mapping[sv_ids[-1]], 0]]}
            except Exception:  # noqa: BLE001
                pass

        return (plan_json, prompt_blob, count, None)
