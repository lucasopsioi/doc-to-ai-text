#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文档转 AI 文本 —— exe 启动器

为什么要起一个本地 http 服务而不是直接双击 HTML：
  · 剪贴板 API（navigator.clipboard）只在「安全上下文」里可用。
    localhost 算安全上下文，file:// 不算。虽然代码里有 execCommand 兜底，
    但走 localhost 能用上正经的剪贴板接口。
  · 更重要的：exe 里打包了 PyMuPDF 高保真引擎，网页需要一个本地端点去调它。
    这也是这个 exe 存在的意义 —— 不然它和直接双击 HTML 没区别。
  · 只监听 127.0.0.1 的随机端口，不对外暴露；端点带一次性令牌。

打包（见 build_exe.py）：
    pyinstaller --onefile --windowed --name doc2aitext launcher.py ...

自检开关（打包后必须跑，见知识库教训「解析自检过 ≠ 界面能开」）：
    doc2aitext.exe --selfcheck        只验服务与转换链路
    doc2aitext.exe --uicheck 3        真开窗口，3 秒后自动关，把结果写进状态文件
"""
from __future__ import annotations

import http.server
import json
import os
import secrets
import socket
import socketserver
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from datetime import datetime
from pathlib import Path

APP_NAME = "文档转 AI 文本"


# ---------------------------------------------------------------- 路径与日志
def resource_path(rel: str) -> Path:
    """兼容 PyInstaller 打包后的资源路径。"""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return Path(base) / rel


def state_dir() -> Path:
    d = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "文档转AI文本"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        d = Path.home()
    return d


def write_state(**kw) -> None:
    """--windowed 的 exe 没有 stdout，print 什么都看不到。
    所以运行状态一律写文件，自检和排障都靠它。"""
    try:
        kw["time"] = datetime.now().isoformat(timespec="seconds")
        (state_dir() / "last-run.json").write_text(
            json.dumps(kw, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:
        pass


def crash_log(exc: BaseException) -> None:
    try:
        p = state_dir() / "crash.log"
        with p.open("a", encoding="utf-8") as f:
            f.write(f"\n===== {datetime.now().isoformat(timespec='seconds')} =====\n")
            f.write("".join(traceback.format_exception(exc)))
    except Exception:
        pass


# ---------------------------------------------------------------- 高保真引擎
HIFI_ERROR: str | None = None
try:
    import pdf2ai  # 打包时一并收进来
    _ = pdf2ai.convert
    HAS_HIFI = True
except Exception as e:      # 没打包进来 / PyMuPDF 缺失，都要能优雅降级
    HAS_HIFI = False
    HIFI_ERROR = f"{type(e).__name__}: {e}"


class Opt:
    """给 pdf2ai.convert 用的选项对象，字段与命令行 argparse 的一致。"""

    def __init__(self, q: dict):
        def flag(name: str, default: bool = True) -> bool:
            v = q.get(name, [None])[0]
            return default if v is None else v not in ("0", "false", "False")

        self.preamble = flag("preamble")
        self.compact = flag("compact")
        self.merge_para = flag("mergePara")
        self.columns = flag("columns")
        self.header_footer = flag("headerFooter")
        self.tables = flag("tables")
        self.shapes = flag("shapes")
        self.charts = flag("charts")
        self.target = q.get("target", ["raw"])[0]
        self.unit = q.get("unit", ["cm"])[0]
        if self.target not in ("raw", "16:9", "4:3"):
            self.target = "raw"
        if self.unit not in ("cm", "pt", "in"):
            self.unit = "cm"
        self.export_images = None
        self.render_pages = None


def export_dir_for(stem: str) -> Path:
    base = Path.home() / "Documents" / "文档转AI文本导出" / f"{stem}_图片"
    base.mkdir(parents=True, exist_ok=True)
    return base


# ---------------------------------------------------------------- HTTP 服务
HTML_BYTES = b""
TOKEN = secrets.token_urlsafe(24)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # -- 工具 --
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _authed(self, q: dict) -> bool:
        return secrets.compare_digest(q.get("t", [""])[0], TOKEN)

    # -- 路由 --
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)

        if u.path == "/":
            self._send(200, HTML_BYTES, "text/html; charset=utf-8")
        elif u.path == "/capabilities":
            self._json(200, {
                "app": APP_NAME,
                "highFidelity": HAS_HIFI and self._authed(q),
                "highFidelityError": None if HAS_HIFI else HIFI_ERROR,
                "exportDirRoot": str(Path.home() / "Documents" / "文档转AI文本导出"),
            })
        else:
            self._send(404, b"not found", "text/plain; charset=utf-8")

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path != "/highfidelity":
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        if not self._authed(q):
            self._json(403, {"error": "令牌不匹配"})
            return
        if not HAS_HIFI:
            self._json(501, {"error": "这个 exe 没有内置高保真引擎：" + (HIFI_ERROR or "")})
            return

        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n <= 0 or n > 400 * 1024 * 1024:
            self._json(400, {"error": "文件为空或过大（上限 400MB）"})
            return

        # HTTP/1.1 下必须把 body 读干净，否则连接会错位
        data = b""
        while len(data) < n:
            chunk = self.rfile.read(min(1 << 20, n - len(data)))
            if not chunk:
                break
            data += chunk

        name = urllib.parse.unquote(q.get("name", ["input.pdf"])[0])
        opt = Opt(q)
        want_images = q.get("images", ["0"])[0] not in ("0", "false", "False")
        stem = Path(name).stem or "input"
        if want_images:
            opt.export_images = str(export_dir_for(stem))

        try:
            text = pdf2ai.convert(data, opt, display_name=name)
        except Exception as e:
            crash_log(e)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})
            return

        out = {"text": text}
        if want_images:
            d = Path(opt.export_images)
            files = sorted(p.name for p in d.glob("*") if p.is_file())
            out["imageDir"] = str(d)
            out["images"] = files
        self._json(200, out)

    def log_message(self, *args):
        pass          # 静音；--windowed 下往 stderr 写会出问题


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def start_server() -> tuple[Server, str]:
    port = free_port()
    httpd = Server(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{port}/?t={TOKEN}"


# ---------------------------------------------------------------- 自检
def _tiny_pdf() -> bytes:
    content = (b"BT /F1 18 Tf 0.2 0.4 0.6 rg 72 700 Td (SelfCheck OK) Tj ET\n"
               b"q 1 0 0 rg 72 600 100 50 re f Q")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>" % len(content),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    buf = b"%PDF-1.4\n"
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(buf))
        buf += b"%d 0 obj\n" % i + o + b"\n"
        if i == 4:
            buf += b"stream\n" + content + b"\nendstream\n"
        buf += b"endobj\n"
    x = len(buf)
    buf += b"xref\n0 6\n0000000000 65535 f \n"
    for o in offs:
        buf += b"%010d 00000 n \n" % o
    buf += b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % x
    return buf


def selfcheck(sample: str | None = None) -> int:
    """验证服务、页面、以及高保真链路。打包后必跑。

    sample 传一份真实 PDF 时会额外走一遍完整链路 —— 合成的小 PDF 验不出
    冻结环境里 PyMuPDF 的字体/表格资源是不是齐的。
    """
    import urllib.request

    results: dict[str, object] = {"mode": "selfcheck", "hasHiFi": HAS_HIFI,
                                  "hifiError": HIFI_ERROR}
    httpd, url = start_server()
    base = url.split("/?")[0]
    ok = True
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            html = r.read()
        results["htmlBytes"] = len(html)
        results["htmlLooksRight"] = (b"convertBytes" in html and b'id="drop"' in html)
        ok &= bool(results["htmlLooksRight"]) and len(html) > 100_000

        with urllib.request.urlopen(f"{base}/capabilities?t={TOKEN}", timeout=15) as r:
            caps = json.loads(r.read())
        results["capabilities"] = caps
        ok &= caps.get("highFidelity") is HAS_HIFI

        if HAS_HIFI:
            req = urllib.request.Request(
                f"{base}/highfidelity?t={TOKEN}&name=selfcheck.pdf&unit=pt&preamble=0",
                data=_tiny_pdf(), method="POST")
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.loads(r.read())
            txt = out.get("text", "")
            results["hifiChars"] = len(txt)
            results["hifiFoundText"] = "SelfCheck OK" in txt
            results["hifiFoundRect"] = "矩形" in txt
            results["hifiFoundColor"] = "#1F6F8B" in txt or "#336699" in txt
            ok &= results["hifiFoundText"] and results["hifiFoundRect"]

        # 真实 PDF 的完整链路
        if HAS_HIFI and sample:
            sp = Path(sample)
            results["sample"] = sp.name
            req = urllib.request.Request(
                f"{base}/highfidelity?t={TOKEN}"
                f"&name={urllib.parse.quote(sp.name)}&unit=pt&preamble=0",
                data=sp.read_bytes(), method="POST")
            with urllib.request.urlopen(req, timeout=300) as r:
                out = json.loads(r.read())
            txt = out.get("text", "")
            results["sampleChars"] = len(txt)
            results["samplePages"] = txt.count("## 第 ")
            results["sampleTables"] = txt.count("] 表格")
            # 中文必须解得出来，不能是一片 �
            cjk = sum(1 for ch in txt if "一" <= ch <= "鿿")
            results["sampleCJK"] = cjk
            results["sampleBad"] = txt.count("�")
            ok &= len(txt) > 2000 and results["samplePages"] >= 1 and cjk > 200

        # 未授权请求必须被挡
        try:
            urllib.request.urlopen(f"{base}/highfidelity?t=wrong", data=b"x", timeout=10)
            results["tokenEnforced"] = False
            ok = False
        except urllib.error.HTTPError as e:
            results["tokenEnforced"] = e.code == 403
            ok &= e.code == 403
    except Exception as e:
        crash_log(e)
        results["error"] = f"{type(e).__name__}: {e}"
        ok = False
    finally:
        httpd.shutdown()

    results["pass"] = ok
    write_state(**results)
    return 0 if ok else 1


def uicheck(seconds: float) -> int:
    """真的把窗口开出来，跑几秒自动关。
    知识库教训：解析自检过 ≠ 界面能开。这一条必须单独验。"""
    httpd, url = start_server()
    state: dict[str, object] = {"mode": "uicheck", "url": url.split("?")[0]}
    try:
        import webview
        state["backend"] = "pywebview"
        state["pywebviewVersion"] = getattr(webview, "__version__", "?")
        win = webview.create_window(APP_NAME, url, width=1120, height=880)

        def closer():
            time.sleep(seconds)
            try:
                win.destroy()
            except Exception:
                pass

        threading.Thread(target=closer, daemon=True).start()
        webview.start()                  # 阻塞直到窗口关闭
        state["windowOpened"] = True
        state["pass"] = True
    except Exception as e:
        crash_log(e)
        state["backend"] = "failed"
        state["error"] = f"{type(e).__name__}: {e}"
        state["windowOpened"] = False
        state["pass"] = False            # 界面开不出来就是没过，别自欺
    finally:
        httpd.shutdown()
    write_state(**state)
    return 0 if state.get("pass") else 1


# ---------------------------------------------------------------- 主流程
def main() -> int:
    global HTML_BYTES
    args = sys.argv[1:]

    # 打包时资源用 ASCII 名（app.html）——工程目录在 D:\workspace\ 下，
    # 非 ASCII 路径踩过 PyInstaller 的坑，能避就避。直接跑源码时回落中文名。
    try:
        for cand in ("app.html", "文档转AI文本.html"):
            p = resource_path(cand)
            if p.exists():
                HTML_BYTES = p.read_bytes()
                break
        if not HTML_BYTES:
            raise FileNotFoundError("app.html / 文档转AI文本.html 都找不到")
    except Exception as e:
        crash_log(e)
        write_state(mode="startup", error=f"读不到内置的 HTML：{e}", **{"pass": False})
        return 2

    if "--selfcheck" in args:
        i = args.index("--selfcheck")
        sample = args[i + 1] if len(args) > i + 1 and not args[i + 1].startswith("-") else None
        return selfcheck(sample)
    if "--uicheck" in args:
        i = args.index("--uicheck")
        secs = float(args[i + 1]) if len(args) > i + 1 else 3.0
        return uicheck(secs)

    httpd, url = start_server()
    base = url.split("?")[0]
    # 状态必须在开窗之前就落盘：webview.start() 会一直阻塞到用户关窗，
    # 写在它后面的话，恰恰在最需要排障的场景（「双击了没反应」）下什么都没有。
    write_state(mode="run", phase="starting", backend="unknown", url=base, pid=os.getpid())
    try:
        try:
            import webview
            write_state(mode="run", phase="window-opening", backend="pywebview",
                        url=base, pid=os.getpid())
            webview.create_window(APP_NAME, url, width=1180, height=900)
            webview.start()                              # 阻塞到窗口关闭
            write_state(mode="run", phase="closed", backend="pywebview", url=base)
        except Exception as e:
            # WebView2 缺失之类的问题：退回默认浏览器，不要让用户看到闪退
            crash_log(e)
            write_state(mode="run", phase="fallback-browser", backend="browser",
                        url=base, pid=os.getpid(), fallbackFrom=f"{type(e).__name__}: {e}")
            webbrowser.open(url)
            threading.Event().wait()     # 浏览器模式下进程必须活着，否则服务就断了
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException as _e:          # 闪退零线索是最难排的故障
        crash_log(_e)
        write_state(mode="fatal", error=f"{type(_e).__name__}: {_e}", **{"pass": False})
        raise SystemExit(3)
