#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 src/ 下的模块拼成单个自包含的 HTML。

为什么要分模块再拼，而不是直接维护一个大文件：
  · 解析器有一万多行，塞一个文件没法读也没法改
  · 但交付物必须是单文件 —— 用户要能用记事本粘到公司电脑上
所以源码分模块，产物拼成一个。改完 src/ 跑一下这个脚本就行。

用法：  python build.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
SHELL = SRC / "0-shell.html"
OUT = ROOT / "文档转AI文本.html"

MARKER = re.compile(r"[ \t]*/\* <!--INJECT:([^>]+?)--> \*/[ \t]*\r?\n")

# 源码里绝不允许出现字面量控制字符（制表、换行、回车除外）。
#
# 踩过一次：8-topptx.js 把「剔除 XML 非法字符」的正则写成了字面量控制字符。
# Node 直接读源文件，字节原样进正则，范围有序，全部测试通过；
# 但浏览器要先过 HTML 解析器，而 HTML 规范强制把 U+0000 换成 U+FFFD，
# 字符类范围随之逆序 => SyntaxError => 整个脚本一行都不执行。
# 两条路径的解码管线不同，测试台全绿而真实环境全挂 —— 只有构建期扫描拦得住。
CTRL_CHARS = re.compile("[%s]" % "".join(
    chr(c) for c in list(range(0, 9)) + [11, 12] + list(range(14, 32))))


def main() -> int:
    if not SHELL.exists():
        print("找不到外壳文件：%s" % SHELL, file=sys.stderr)
        return 1

    shell = SHELL.read_text(encoding="utf-8")
    missing = []
    used = []
    ctrl_bad = []

    def inject(m):
        name = m.group(1).strip()
        p = SRC / name
        if not p.exists():
            missing.append(name)
            return m.group(0)
        used.append(name)
        body = p.read_text(encoding="utf-8")
        # 各模块自己带 "use strict"，外壳已经声明过一次，去掉重复的
        body = re.sub(r'^\s*"use strict";\s*\n', "", body)
        hits = CTRL_CHARS.findall(body)
        if hits:
            ctrl_bad.append((name, sorted({"0x%02X" % ord(c) for c in hits})))
        return "\n/* ===== %s ===== */\n%s\n" % (name, body)

    html = MARKER.sub(inject, shell)

    if ctrl_bad:
        for name, chars in ctrl_bad:
            print("源码含字面量控制字符（浏览器里必炸）：%s %s" % (name, chars), file=sys.stderr)
        print("请改用反斜杠转义写法，例如写 backslash-x-0-0 而不是真的控制字符。", file=sys.stderr)
        return 1

    if missing:
        print("以下模块找不到，构建中止：" + ", ".join(missing), file=sys.stderr)
        return 1

    # 产物必须是 UTF-8 无 BOM —— 浏览器按 <meta charset> 读
    OUT.write_text(html, encoding="utf-8", newline="\n")

    size_kb = len(html.encode("utf-8")) / 1024
    print("已生成 %s  (%.1f KB, %d 行)" % (OUT.name, size_kb, html.count("\n") + 1))
    print("模块顺序：" + " -> ".join(used))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
