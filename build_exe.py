#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打包成单文件 exe。

本机踩过的坑，都已在下面规避（来源：knowledge/lessons/env-and-infra.md）：
  · workpath / specpath 必须是纯 ASCII 路径 —— 工程在 D:\\workspace\\ 下会炸，
    统统指到 %TEMP%\\pdf2aibuild
  · 产物先用 ASCII 名构建，构建完再改中文名（改名对已编译的 exe 完全安全）
  · 打进去的资源也用 ASCII 名（app.html）
  · --windowed 的 exe 没有 stdout，所以自检结果一律写文件再读回来
  · ★ 解析自检过 ≠ 界面能开：构建后必须同时跑 --selfcheck 和 --uicheck，
    后者真把窗口开出来再关掉。只跑前者等于没验界面。

用法：
    python build_exe.py                 构建 + 自检
    python build_exe.py --deploy        再复制一份到桌面
    python build_exe.py --skip-uicheck  跳过开窗口自检（无人值守环境用）
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ASCII_BUILD = Path(tempfile.gettempdir()) / "pdf2aibuild"
EXE_ASCII = "doc2aitext"
EXE_CN = "文档转AI文本.exe"
HTML_CN = "文档转AI文本.html"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    print("  $ " + " ".join(str(c) for c in cmd[:6]) + (" …" if len(cmd) > 6 else ""))
    return subprocess.run(cmd, text=True, encoding="utf-8", errors="replace", **kw)


def state_file() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "文档转AI文本" / "last-run.json"


def read_state(after: float, timeout: float = 180) -> dict | None:
    """等 exe 把状态写出来。--windowed 没有 stdout，只能这么读结果。"""
    p = state_file()
    end = time.time() + timeout
    while time.time() < end:
        if p.exists() and p.stat().st_mtime >= after - 1:
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                pass
        time.sleep(0.4)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deploy", action="store_true", help="构建成功后复制到桌面")
    ap.add_argument("--skip-uicheck", action="store_true")
    opt = ap.parse_args()

    print("=== 1. 生成图标 ===")
    sys.path.insert(0, str(ROOT))
    import make_icon
    ico = make_icon.build_ico(ROOT / "icon.ico")
    print(f"  {ico.name}  {ico.stat().st_size/1024:.1f} KB")

    print("=== 2. 构建单文件 HTML ===")
    r = run([sys.executable, str(ROOT / "build.py")], cwd=ROOT, capture_output=True)
    print("  " + (r.stdout or "").strip().replace("\n", "\n  "))
    if r.returncode:
        print(r.stderr, file=sys.stderr)
        return 1

    html = ROOT / HTML_CN
    if not html.exists():
        print("构建产物不存在", file=sys.stderr)
        return 1

    print("=== 3. 准备 ASCII 构建区 ===")
    if ASCII_BUILD.exists():
        shutil.rmtree(ASCII_BUILD, ignore_errors=True)
    stage = ASCII_BUILD / "stage"
    stage.mkdir(parents=True, exist_ok=True)
    shutil.copy2(html, stage / "app.html")          # 资源改 ASCII 名
    dist = ASCII_BUILD / "dist"
    print(f"  {ASCII_BUILD}")

    print("=== 4. PyInstaller ===")
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile", "--windowed", "--clean", "--noconfirm",
        "--name", EXE_ASCII,
        "--icon", str(ico),
        "--add-data", f"{stage / 'app.html'}{os.pathsep}.",
        "--workpath", str(ASCII_BUILD / "work"),
        "--specpath", str(ASCII_BUILD / "spec"),
        "--distpath", str(dist),
        "--collect-all", "pymupdf",
        "--hidden-import", "pdf2ai",
        # 用不上的大件，排掉能省不少体积
        "--exclude-module", "tkinter",
        "--exclude-module", "numpy",
        "--exclude-module", "matplotlib",
        "--exclude-module", "PIL",
        "--exclude-module", "pytest",
        str(ROOT / "launcher.py"),
    ]
    try:
        import webview  # noqa: F401
        cmd[cmd.index("--collect-all"):cmd.index("--collect-all")] = ["--collect-all", "webview"]
        print("  检测到 pywebview，将打包原生窗口支持")
    except ImportError:
        print("  未安装 pywebview，exe 将回落到默认浏览器打开（功能不受影响）")

    r = run(cmd, cwd=ROOT, capture_output=True)
    if r.returncode:
        tail = (r.stdout or "")[-3000:] + "\n" + (r.stderr or "")[-3000:]
        print(tail, file=sys.stderr)
        return 1

    exe = dist / f"{EXE_ASCII}.exe"
    if not exe.exists():
        print("没有产出 exe", file=sys.stderr)
        return 1
    print(f"  {exe.name}  {exe.stat().st_size/1024/1024:.1f} MB")

    print("=== 5. 自检（解析链路）===")
    # 有真实 PDF 就一并验 —— 合成的小 PDF 验不出冻结环境里
    # PyMuPDF 的字体/表格资源齐不齐，而那正是这个 exe 存在的理由
    sample = next((str(p) for p in (
        Path("D:/workspace/拉美竞品每日快报系统/latam-monitor/reports/拉美竞品快报_2026-07-21_演示.pdf"),
    ) if p.exists()), None)
    t0 = time.time()
    cmd5 = [str(exe), "--selfcheck"] + ([sample] if sample else [])
    if sample:
        print(f"  含真实样本：{Path(sample).name}")
    r = run(cmd5, capture_output=True)
    st = read_state(t0, timeout=420)
    if not st:
        print("  ✗ 没读到自检结果（exe 可能闪退，看 " + str(state_file().parent / "crash.log") + "）",
              file=sys.stderr)
        return 1
    for k in ("htmlBytes", "htmlLooksRight", "hasHiFi", "hifiChars",
              "hifiFoundText", "hifiFoundRect", "hifiFoundColor", "tokenEnforced",
              "sample", "sampleChars", "samplePages", "sampleTables", "sampleCJK", "sampleBad"):
        if k in st:
            print(f"  {k}: {st[k]}")
    if not st.get("pass"):
        print(f"  ✗ 自检未通过：{st.get('error') or st}", file=sys.stderr)
        return 1
    print("  ✓ 解析链路通过")

    if not opt.skip_uicheck:
        print("=== 6. 自检（界面真的能开）===")
        print("  提示：会短暂弹出一个窗口，几秒后自动关闭")
        t0 = time.time()
        run([str(exe), "--uicheck", "4"], capture_output=True)
        st = read_state(t0, timeout=90)
        if not st:
            print("  ✗ 没读到界面自检结果", file=sys.stderr)
            return 1
        print(f"  backend={st.get('backend')}  windowOpened={st.get('windowOpened')}")
        if not st.get("pass"):
            print(f"  ✗ 界面开不出来：{st.get('error')}", file=sys.stderr)
            print("    （知识库教训：解析自检过 ≠ 界面能开，这条不能跳）", file=sys.stderr)
            return 1
        print("  ✓ 界面通过")

    print("=== 7. 改名并放到工程目录 ===")
    final = ROOT / EXE_CN
    if final.exists():
        final.unlink()
    shutil.copy2(exe, final)                        # 改名对已编译 exe 完全安全
    print(f"  {final}")

    if opt.deploy:
        desktop = Path(os.path.expanduser("~")) / "Desktop"
        if not desktop.exists():
            print(f"  找不到桌面目录 {desktop}", file=sys.stderr)
            return 1
        target = desktop / EXE_CN
        shutil.copy2(exe, target)
        print(f"=== 8. 已放到桌面 ===\n  {target}  {target.stat().st_size/1024/1024:.1f} MB")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
