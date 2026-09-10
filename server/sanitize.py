"""sanitize.py — 工作流消毒（清理重复 node id / 链接引用错位）。

ComfyUI「is funky」告警常由重复 node id、链接两端引用不一致引起。
对工作流 JSON：把重复的 node id 重新编号 → 同步改 link 两端 / input.link /
output.links / widgets_values 等字符串里出现的旧 id → 结果可直接覆盖存档。
链接数组按 [link_id, node, out_slot, in_slot, type] 布局处理（与本机已验证逻辑一致）。
"""

import re


def sanitize_workflow(graph):
    """返回 (graph, idmap, count)。idmap: {old_id: new_id}，count = 重编号个数。"""
    nodes = graph.get("nodes") or []
    links = graph.get("links") or []
    if not isinstance(nodes, list) or not isinstance(links, list):
        return graph, {}, 0

    seen = set()
    existing_ids = set()
    for n in nodes:
        try:
            existing_ids.add(int(n.get("id")))
        except Exception:  # noqa: BLE001
            pass
    next_id = max(existing_ids) + 1 if existing_ids else 1

    idmap = {}
    for n in nodes:
        try:
            nid = int(n.get("id"))
        except Exception:  # noqa: BLE001
            continue
        if nid in seen:
            while next_id in seen or next_id in existing_ids:
                next_id += 1
            idmap[nid] = next_id
            n["id"] = next_id
            existing_ids.add(next_id)
            next_id += 1
        else:
            seen.add(nid)

    # link 两端旧 id 改写（L[0]/L[1]）
    for L in links:
        if isinstance(L, list) and len(L) >= 5:
            try:
                o = int(L[0])
                if o in idmap:
                    L[0] = idmap[o]
            except Exception:  # noqa: BLE001
                pass
            try:
                t = int(L[1])
                if t in idmap:
                    L[1] = idmap[t]
            except Exception:  # noqa: BLE001
                pass

    # 强制链接两端引用一致
    by_id = {int(n.get("id")): n for n in nodes if isinstance(n, dict)}
    for L in links:
        if not isinstance(L, list) or len(L) < 5:
            continue
        try:
            lid, oid, oidx, iidx = int(L[0]), int(L[1]), int(L[2]), int(L[3])
        except Exception:  # noqa: BLE001
            continue
        tn = by_id.get(oid)  # 与旧实现一致：对 L[1] 所指节点同时修正 outputs 与 inputs
        if tn is not None:
            outs = tn.get("outputs") or []
            while len(outs) <= oidx:
                outs.append({"name": "", "links": [], "type": "*"})
            cur = outs[oidx].get("links")
            if not isinstance(cur, list):
                cur = []
            if lid not in cur:
                cur.append(lid)
                outs[oidx]["links"] = cur
            tn["outputs"] = outs
            ins = tn.get("inputs") or []
            while len(ins) <= iidx:
                ins.append({"name": "", "link": None, "type": "*"})
            ins[iidx]["link"] = lid
            tn["inputs"] = ins

    for n in nodes:
        for inp in n.get("inputs") or []:
            if isinstance(inp, dict) and "link" in inp:
                try:
                    iv = int(inp["link"])
                    if iv in idmap:
                        inp["link"] = idmap[iv]
                except Exception:  # noqa: BLE001
                    pass
        for outp in n.get("outputs") or []:
            if isinstance(outp, dict) and isinstance(outp.get("links"), list):
                new_links = []
                for x in outp["links"]:
                    try:
                        xi = int(x)
                        new_links.append(idmap.get(xi, xi))
                    except Exception:  # noqa: BLE001
                        new_links.append(x)
                outp["links"] = new_links

    def _repl(m):
        try:
            return str(idmap.get(int(m.group(0)), int(m.group(0))))
        except Exception:  # noqa: BLE001
            return m.group(0)

    for n in nodes:
        wvs = n.get("widgets_values")
        if isinstance(wvs, list):
            for i, w in enumerate(wvs):
                if isinstance(w, str):
                    nn = re.sub(r"\b\d+\b", _repl, w)
                    if nn != w:
                        wvs[i] = nn
        for k, v in list(n.items()):
            if isinstance(v, str) and k not in ("id", "type"):
                nn = re.sub(r"\b\d+\b", _repl, v)
                if nn != v:
                    n[k] = nn

    return graph, idmap, len(idmap)
