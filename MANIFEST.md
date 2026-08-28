# MANIFEST · doc-to-ai-text

> PDF/PPT/邮件→AI可读文本｜源：PDF转AI文本｜构建：本文件由 build-staging.js 生成，逐文件处置如下
> COPY=原样文本 RENAMED=做了名称脱敏 ZIPFIX=办公文件内部XML脱敏 BINARY=二进制原样 EXCLUDE=不进仓 REDACTED=打码模板

BINARY   icon.ico
COPY     README.md
COPY     build.py
COPY     make_icon.py
COPY     pdf2ai.py
COPY     src/0-shell.html
COPY     src/1-core.js
COPY     src/10-htmlmeasure.js
COPY     src/11-htmlemit.js
COPY     src/2-font.js
COPY     src/3-render.js
COPY     src/4-layout.js
COPY     src/5-emit.js
COPY     src/6-ui.js
COPY     src/7-ooxml.js
COPY     src/8-topptx.js
COPY     src/9-html.js
COPY     test/_bundle.cjs
COPY     test/make_pptx.py
COPY     test/out-hand.pdf.md
COPY     test/out-inherit.pptx.md
COPY     test/out-matplotlib.pdf.md
COPY     test/out-roundtrip.md
COPY     test/probe.cjs
COPY     test/tryppt.cjs
COPY     文档转AI文本.html
OVERLAY  LICENSE（docs-src 提供）
OVERLAY  README.md（docs-src 提供）
RENAMED  README.md -> README.zh.md（中文版保留，英文主README来自docs-src）
RENAMED  build_exe.py
RENAMED  launcher.py
RENAMED  test/make-mht.py
RENAMED  test/out-_______2026-07-21___.pdf.md
RENAMED  test/run.js
ZIPFIX   test/fixtures/inherit.pptx（无需改）
ZIPFIX   test/roundtrip.pptx（无需改）

## 未进仓（按顶层路径归并，共 6 个文件）

- `__pycache__` — 排除 4 个文件
- `test` — 排除 1 个文件
- `文档转AI文本.exe` — 排除 1 个文件
