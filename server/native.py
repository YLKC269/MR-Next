"""native.py — Windows 原生选择对话框（IFileOpenDialog via ctypes，零依赖）。

只保留最稳核心：专用 STA 线程 + IFileOpenDialog 选 文件夹/文件(单选/多选) +
标题 / 起始目录 / 类型过滤器。所有返回经线程 join 汇聚，任一步失败不崩：
  pick(kind="file"|"folder", title=..., filetypes=[(名称, "*.png *.jpg")], multiple=..., start_path=...)
  → {"ok": bool, "paths": [...], "cancel": bool, "error": ""}
64 位注意：关键 Win32 返回指针必须显式 restype（默认 c_int 截断）；COM 方法走
vtable 槽位 + WINFUNCTYPE，restype 显式声明。
"""

import ctypes
import ctypes.wintypes as wt
import os
import re
import threading

_FOS_PICKFOLDERS = 0x20
_FOS_FORCEFILESYSTEM = 0x40
_FOS_ALLOWMULTISELECT = 0x200
_SIGDN_FILESYSPATH = 0x80058000
_CANCEL_HR = "800704C7"  # HRESULT_FROM_WIN32(ERROR_CANCELLED)


class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


class _FILTERSPEC(ctypes.Structure):
    _fields_ = [("pszName", ctypes.c_wchar_p), ("pszSpec", ctypes.c_wchar_p)]


def _mk_guid(s):
    m = re.match(r"\{?([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{12})\}?", s)
    d4 = [int(m.group(4)[0:2], 16), int(m.group(4)[2:4], 16)]
    d4 += [int(m.group(5)[i:i + 2], 16) for i in range(0, 12, 2)]
    return _GUID(int(m.group(1), 16), int(m.group(2), 16), int(m.group(3), 16),
                 (ctypes.c_ubyte * 8)(*d4))


_CLSID_FileOpenDialog = _mk_guid("{DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7}")
_IID_IFileOpenDialog = _mk_guid("{D57C7288-D4AD-4768-BE02-9D969532D960}")
_IID_IShellItem = _mk_guid("{43826D1E-E718-42EE-BC55-A1E261C37BFE}")

ole32 = ctypes.windll.ole32
shell32 = ctypes.windll.shell32
user32 = ctypes.windll.user32
# 64 位：返回指针必须显式 restype
user32.GetForegroundWindow.restype = ctypes.c_void_p
user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
user32.SetForegroundWindow.restype = ctypes.c_bool


def _method(obj, slot, restype, *argtypes):
    """按 vtable 槽位取 COM 方法（槽位已含 IUnknown 的 0/1/2）。"""
    tbl = ctypes.cast(obj, ctypes.POINTER(ctypes.c_void_p)).contents.value
    fn = ctypes.cast(tbl, ctypes.POINTER(ctypes.c_void_p))[slot]
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(fn)


def _hr(ret):
    if ret < 0:
        raise OSError("HRESULT 0x%08X" % (ret & 0xFFFFFFFF))


def _release(obj):
    try:
        _method(obj, 2, ctypes.c_ulong)(obj)
    except Exception:  # noqa: BLE001
        pass


def _show_dialog(kind, title, filetypes, multiple, start_path):
    """在【当前线程】弹对话框（须已 CoInitializeEx STA）。返回路径/取消/异常。"""
    initialized = False
    dlg = ctypes.c_void_p()
    try:
        user32.AllowSetForegroundWindow(0xFFFFFFFF)
        ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED
        initialized = True
        _hr(ole32.CoCreateInstance(ctypes.byref(_CLSID_FileOpenDialog), None, 1,
                                   ctypes.byref(_IID_IFileOpenDialog), ctypes.byref(dlg)))
        opts = ctypes.c_uint()
        _hr(_method(dlg, 10, ctypes.HRESULT, ctypes.POINTER(ctypes.c_uint))(dlg, ctypes.byref(opts)))
        opts.value |= _FOS_FORCEFILESYSTEM
        if kind == "folder":
            opts.value |= _FOS_PICKFOLDERS
        elif multiple:
            opts.value |= _FOS_ALLOWMULTISELECT
        _hr(_method(dlg, 9, ctypes.HRESULT, ctypes.c_uint)(dlg, opts.value))
        _hr(_method(dlg, 17, ctypes.HRESULT, ctypes.c_wchar_p)(dlg, str(title)[:120]))

        if kind != "folder" and filetypes:
            specs = []
            for ft in filetypes:
                if isinstance(ft, (list, tuple)) and len(ft) == 2 and str(ft[0]) and str(ft[1]):
                    specs.append(_FILTERSPEC(str(ft[0]), str(ft[1])))
            if specs:
                arr = (_FILTERSPEC * len(specs))(*specs)
                _hr(_method(dlg, 4, ctypes.HRESULT, ctypes.c_uint,
                            ctypes.POINTER(_FILTERSPEC))(dlg, len(specs), arr))
                _hr(_method(dlg, 5, ctypes.HRESULT, ctypes.c_uint)(dlg, 1))

        if start_path and os.path.isdir(start_path):
            si0 = ctypes.c_void_p()
            if shell32.SHCreateItemFromParsingName(start_path, None,
                                                   ctypes.byref(_IID_IShellItem),
                                                   ctypes.byref(si0)) == 0 and si0:
                _hr(_method(dlg, 12, ctypes.HRESULT, ctypes.c_void_p)(dlg, si0))
                _release(si0)

        parent = user32.GetForegroundWindow()
        _hr(_method(dlg, 3, ctypes.HRESULT, ctypes.c_void_p)(
            dlg, ctypes.c_void_p(parent)))  # Show（阻塞）
        if parent:
            try:
                user32.SetForegroundWindow(parent)
            except Exception:  # noqa: BLE001
                pass

        def _item_path(si):
            pw = ctypes.c_void_p()
            _hr(_method(si, 5, ctypes.HRESULT, ctypes.c_uint,
                        ctypes.POINTER(ctypes.c_void_p))(si, _SIGDN_FILESYSPATH, ctypes.byref(pw)))
            s = ctypes.wstring_at(pw) if pw else ""
            if pw:
                ole32.CoTaskMemFree(pw)
            _release(si)
            return s

        if kind == "folder":
            si = ctypes.c_void_p()
            _hr(_method(dlg, 20, ctypes.HRESULT, ctypes.POINTER(ctypes.c_void_p))(
                dlg, ctypes.byref(si)))
            return [_item_path(si)] if si else []
        if multiple:
            arr = ctypes.c_void_p()
            _hr(_method(dlg, 27, ctypes.HRESULT, ctypes.POINTER(ctypes.c_void_p))(
                dlg, ctypes.byref(arr)))
            out = []
            if arr:
                cnt = ctypes.c_uint()
                _hr(_method(arr, 7, ctypes.HRESULT, ctypes.POINTER(ctypes.c_uint))(
                    arr, ctypes.byref(cnt)))
                for i in range(min(cnt.value, 100)):
                    si = ctypes.c_void_p()
                    _hr(_method(arr, 8, ctypes.HRESULT, ctypes.c_uint,
                                ctypes.POINTER(ctypes.c_void_p))(arr, i, ctypes.byref(si)))
                    if si:
                        out.append(_item_path(si))
                _release(arr)
            return out
        si = ctypes.c_void_p()
        _hr(_method(dlg, 20, ctypes.HRESULT, ctypes.POINTER(ctypes.c_void_p))(
            dlg, ctypes.byref(si)))
        return [_item_path(si)] if si else []
    except OSError as exc:
        if _CANCEL_HR in str(exc).upper():
            return None  # 用户取消
        return {"__err__": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"__err__": str(exc)}
    finally:
        if dlg:
            _release(dlg)
        if initialized:
            try:
                ole32.CoUninitialize()
            except Exception:  # noqa: BLE001
                pass


def pick(kind="file", title="选择", filetypes=None, multiple=False, start_path=""):
    """新线程 STA 弹对话框；返回 {ok, paths, cancel, error}。"""
    result = {}

    def _run():
        result["value"] = _show_dialog(kind, title, filetypes, multiple, start_path)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join()  # 模态对话框，join 到用户关闭

    value = result.get("value")
    if value is None:
        return {"ok": True, "paths": [], "cancel": True, "error": ""}
    if isinstance(value, dict) and value.get("__err__"):
        return {"ok": False, "paths": [], "cancel": False,
                "error": value["__err__"]}
    return {"ok": True, "paths": value, "cancel": False, "error": ""}
