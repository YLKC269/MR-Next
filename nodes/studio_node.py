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
            },
        }

    def execute(self, asset_folder, model_name, seed, auto_preview=True):
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

        # 出片模式：有分镜 → 用 subgraph 让 ComfyUI 主线程执行 H3 出片（正确走 CUDA 上下文）
        if shots:
            try:
                from ..server import h3shot as _h3
                # 合并各镜文本为一条时间线描述（t2v 单 Director 出整段）
                texts = [s.get("prompt") or s.get("text") or "" for s in shots]
                texts = [t.strip() for t in texts if t.strip()]
                merged = "。".join(texts) if texts else ""
                if merged:
                    graph = _h3.build_shot_graph(
                        "t2v", merged, seed=int(seed) if seed else 0,
                        seconds=max(3.0, min(15.0, count * 5.0)), frame_rate=24.0,
                        opts={"width": 864, "height": 480, "steps": 8,
                              "sampler": "res_multistep", "scheduler": "simple"})
                    sv_ids = [nid for nid, n in graph.items() if n.get("class_type") == "SaveVideo"]
                    if sv_ids:
                        sub_graph, mapping = _rekey_graph(graph, prefix="mrshot")
                        return {"expand": sub_graph, "result": [None, None, None, [mapping[sv_ids[-1]], 0]]}
            except Exception:  # noqa: BLE001
                pass

        return (plan_json, prompt_blob, count, None)
