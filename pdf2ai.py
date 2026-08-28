#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF 转 AI 文本 —— 高保真版（Python + PyMuPDF）

和同目录那份单文件 HTML 是什么关系？
  · HTML 版是日常主力：零安装、记事本可粘贴、随处能用，自己实现了整套 PDF 解析。
  · 这份是兜底：HTML 版啃不动的时候用。它解决三件 HTML 版结构性做不到的事：

    1. 字体编码。HTML 版只能靠 ToUnicode 映射还原文字；碰上用预定义 CMap
       （GBK-EUC-H / UniGB-UCS2-H 等）的老 PDF，映射表有好几 MB，不可能内联进单文件，
       只能吐「无法确定」。PyMuPDF 自带全套 CMap。
    2. 图片。HTML 版只能报出图片的位置和格式，像素传不出去。
       这份可以 --export-images 直接把图导成文件，你连同文本一起发给 AI。
    3. 表格。PyMuPDF 的 find_tables() 比我手写的几何推断成熟得多。

  两份的输出格式完全一致 —— 给 AI 的提示词不用改，随时可以换着用。

输出的可信度约定（和 HTML 版一致）：
  · 没标记的数值 = 文件里的原始值，精确
  · [推断 置信度x.xx] = 从几何关系重建的
  · 「无法确定」 = 确实解不出来，绝不拿猜测顶替

用法：
    python pdf2ai.py 报告.pdf
    python pdf2ai.py 报告.pdf -o out.md --target 16:9 --unit cm
    python pdf2ai.py 报告.pdf --export-images imgs/   # 把图片导出来一起给 AI
    python pdf2ai.py *.pdf --render-pages preview/    # 顺便渲染页面截图供你核对

依赖：pip install pymupdf
      注意 PyMuPDF 是 AGPL-3.0 协议。自用没问题；要嵌进对外分发的商业产品需另行确认授权。
      HTML 版是我从零实现的，不受此限制。
"""
from __future__ import annotations

import argparse
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

try:
    import pymupdf
except ImportError:  # 老版本只提供 fitz 这个名字
    try:
        import fitz as pymupdf  # type: ignore
    except ImportError:
        sys.exit(
            "缺少 PyMuPDF。请先安装：\n"
            "    pip install pymupdf\n"
            "如果不想装依赖，直接用同目录的 PDF转AI文本.html（零安装）。"
        )

# Windows 控制台默认 cp936，中文输出会炸；显式切 UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass


# ============================================================
# 单位与折算
# ============================================================
PT_CM = 2.54 / 72
PT_IN = 1 / 72
TARGETS = {"16:9": (960.0, 540.0), "4:3": (720.0, 540.0)}


class Scale:
    """把 PDF 页面坐标折算到目标版式。raw 模式下是恒等变换。"""

    def __init__(self, unit: str = "cm", target: str = "raw",
                 page_w: float = 612.0, page_h: float = 792.0):
        self.unit = unit
        self.target = target
        self.k = 1.0
        self.ox = self.oy = 0.0
        if target in TARGETS:
            tw, th = TARGETS[target]
            self.k = min(tw / page_w, th / page_h)
            self.ox = (tw - page_w * self.k) / 2
            self.oy = (th - page_h * self.k) / 2

    def _fmt(self, v: float) -> str:
        if self.unit == "pt":
            r = round(v, 1)
        elif self.unit == "in":
            r = round(v * PT_IN, 3)
        else:
            r = round(v * PT_CM, 2)
        return f"{r:g}"

    def size(self, pt: float) -> str:      # 长度（不加偏移）
        return self._fmt(pt * self.k)

    def x(self, pt: float) -> str:
        return self._fmt(pt * self.k + self.ox)

    def y(self, pt: float) -> str:
        return self._fmt(pt * self.k + self.oy)

    def fs(self, pt: float) -> str:        # 字号始终按磅报
        return f"{round(pt * self.k, 1):g}pt"

    @property
    def u(self) -> str:
        return {"pt": "pt", "in": "in"}.get(self.unit, "cm")

    def box(self, x0: float, y0: float, x1: float, y1: float) -> str:
        return (f"x={self.x(x0)} y={self.y(y0)} "
                f"宽={self.size(x1 - x0)} 高={self.size(y1 - y0)} {self.u}")


# ============================================================
# 小工具
# ============================================================
CJK_RE = re.compile(r"[⺀-鿿豈-﫿︰-﹏＀-￯　-〿]")
BULLET_RE = re.compile(
    r"^\s*([•·▪◦‣∙●○■□◆◇\-–—*]|\(?\d{1,2}[.)、]|[a-zA-Z][.)]|[一二三四五六七八九十]+[、.])\s+"
)
SENT_END_RE = re.compile(r"[。．.！!？?；;：:]\s*$")


def is_cjk(ch: str) -> bool:
    return bool(ch) and bool(CJK_RE.match(ch))


def median(vals):
    v = sorted(vals)
    if not v:
        return 0.0
    m = len(v) // 2
    return v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2


def most_common(vals):
    c = Counter(v for v in vals if v is not None)
    return c.most_common(1)[0][0] if c else None


def to_hex(rgb) -> str | None:
    """PyMuPDF 的颜色可能是 int（sRGB）也可能是 0~1 的三元组。"""
    if rgb is None:
        return None
    if isinstance(rgb, int):
        return f"#{rgb & 0xFFFFFF:06X}"
    if isinstance(rgb, (tuple, list)):
        if len(rgb) == 1:
            g = max(0.0, min(1.0, float(rgb[0])))
            v = round(g * 255)
            return f"#{v:02X}{v:02X}{v:02X}"
        if len(rgb) >= 3:
            r, g, b = (max(0.0, min(1.0, float(c))) for c in rgb[:3])
            return f"#{round(r*255):02X}{round(g*255):02X}{round(b*255):02X}"
    return None


def union_box(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def overlap_area(a, b) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


# ============================================================
# 数据结构
# ============================================================
class Part:
    """一段同格式的文字。对应 PyMuPDF 的一个 span。"""
    __slots__ = ("text", "x0", "top", "x1", "bottom", "baseline", "size",
                 "font", "bold", "italic", "color", "seq", "alpha", "bad",
                 "annot", "rotated")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


class Line:
    __slots__ = ("text", "parts", "seps", "x0", "x1", "top", "bottom", "baseline",
                 "size", "size_set", "bold", "all_bold", "italic", "fonts",
                 "color", "colors", "bad", "seq", "annot")


class Para:
    __slots__ = ("lines", "text", "flow_text", "x0", "x1", "top", "bottom", "size",
                 "bold", "all_bold", "italic", "fonts", "color", "colors",
                 "line_gap", "bad", "seq", "annot")


class Block:
    __slots__ = ("paras", "x0", "x1", "top", "bottom", "size", "seq",
                 "role", "role_conf", "is_page_number", "column", "read_index", "annot")

    def __init__(self):
        self.role = None
        self.role_conf = None
        self.is_page_number = False
        self.column = 0
        self.read_index = 0
        self.annot = None


# ============================================================
# 抽取层：PyMuPDF -> Part / 图形 / 图片
# ============================================================
FLAG_ITALIC = 1 << 1
FLAG_SERIF = 1 << 2
FLAG_MONO = 1 << 3
FLAG_BOLD = 1 << 4


def font_display_name(raw: str) -> str:
    """去掉子集前缀，并把常见中日韩字体名翻成中文。顺序即优先级，具体的排前面。"""
    n = re.sub(r"^[A-Z]{6}\+", "", raw or "")
    alias = [
        (r"Microsoft\s*YaHei|MSYH|MicrosoftJhengHei", "微软雅黑"),
        (r"SimSun|NSimSun|STSong|SongTi|MSung|STZhongsong", "宋体"),
        (r"SimHei|STHeiti|HeiTi", "黑体"),
        (r"FangSong|STFangsong", "仿宋"),
        (r"KaiTi|STKaiti", "楷体"),
        (r"Source\s*Han\s*Sans|Noto\s*Sans\s*(CJK|SC|TC)", "思源黑体"),
        (r"Source\s*Han\s*Serif|Noto\s*Serif\s*(CJK|SC|TC)", "思源宋体"),
        (r"PingFang", "苹方"),
        (r"DengXian", "等线"),
        (r"LiSu", "隶书"),
    ]
    for pat, cn in alias:
        if re.search(pat, n, re.I):
            return f"{cn}（{n}）"
    return n


def extract_page(page, opt) -> dict:
    """把一页拆成 parts / drawings / images，并带上绘制顺序。"""
    warnings: list[str] = []

    # ---- 不可见文字（渲染模式 3）与绘制顺序，都要靠 texttrace ----
    invisible_boxes: list[tuple] = []
    seq_by_origin: dict[tuple, int] = {}
    invisible_count = 0
    try:
        for sp in page.get_texttrace():
            org = sp.get("origin") or (0, 0)
            key = (round(org[0], 1), round(org[1], 1))
            seq_by_origin.setdefault(key, sp.get("seqno", 0))
            if sp.get("type") in (3, 7):        # 3=不可见, 7=只作裁剪
                invisible_count += 1
                bb = sp.get("bbox")
                if bb:
                    invisible_boxes.append(tuple(bb))
    except Exception as e:      # texttrace 在个别损坏文件上会抛
        warnings.append(f"绘制顺序信息读取失败（{e}），元素顺序按「先图形后文字」近似")

    def is_invisible(bbox) -> bool:
        for ib in invisible_boxes:
            if overlap_area(bbox, ib) > 0.6 * max(1e-6, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])):
                return True
        return False

    # ---- 文字 ----
    parts: list[Part] = []
    bad_total = 0
    try:
        d = page.get_text("dict")
    except Exception as e:
        warnings.append(f"文字提取失败：{e}")
        d = {"blocks": []}

    for blk in d.get("blocks", []):
        if blk.get("type") != 0:
            continue
        for ln in blk.get("lines", []):
            # 竖排/旋转文字单独处理，混进正文会毁掉行聚类
            dirv = ln.get("dir", (1, 0))
            rotated = abs(dirv[1]) > 0.08
            for sp in ln.get("spans", []):
                txt = sp.get("text", "")
                if not txt.strip():
                    continue
                bbox = sp.get("bbox")
                if not bbox:
                    continue
                if is_invisible(bbox):
                    continue
                nbad = txt.count("�")
                bad_total += nbad
                org = sp.get("origin", (bbox[0], bbox[3]))
                flags = sp.get("flags", 0)
                raw_font = sp.get("font", "")
                key = (round(org[0], 1), round(org[1], 1))
                p = Part(
                    text=txt,
                    x0=bbox[0], top=bbox[1], x1=bbox[2], bottom=bbox[3],
                    baseline=org[1],
                    size=sp.get("size", 10.0),
                    font=font_display_name(raw_font),
                    bold=bool(flags & FLAG_BOLD) or bool(re.search(r"bold|black|heavy", raw_font, re.I)),
                    italic=bool(flags & FLAG_ITALIC),
                    color=to_hex(sp.get("color")),
                    seq=seq_by_origin.get(key, 10_000_000),
                    alpha=sp.get("alpha", 1.0) if isinstance(sp.get("alpha"), (int, float)) else 1.0,
                    bad=nbad,
                    annot=None,
                    rotated=rotated,
                )
                parts.append(p)

    # ---- 矢量图形 ----
    ocgs = {}
    try:
        ocgs = page.parent.get_ocgs() or {}
    except Exception:
        pass
    off_layers = {v.get("name") for v in ocgs.values() if not v.get("on", True)}

    drawings = []
    hidden_layer = 0
    try:
        raw_draw = page.get_drawings()
    except Exception as e:
        warnings.append(f"矢量图形提取失败：{e}")
        raw_draw = []
    for dr in raw_draw:
        if dr.get("layer") and dr["layer"] in off_layers:
            hidden_layer += 1
            continue
        rect = dr.get("rect")
        if rect is None:
            continue
        bbox = (rect.x0, rect.y0, rect.x1, rect.y1)
        drawings.append({
            "bbox": bbox,
            "items": dr.get("items", []),
            "fill": to_hex(dr.get("fill")),
            "stroke": to_hex(dr.get("color")),
            "width": dr.get("width") or 0.0,
            "dashes": dr.get("dashes"),
            "even_odd": dr.get("even_odd"),
            "closed": dr.get("closePath"),
            "fill_alpha": dr.get("fill_opacity", 1.0),
            "stroke_alpha": dr.get("stroke_opacity", 1.0),
            "seq": dr.get("seqno", 0),
            "layer": dr.get("layer"),
        })

    # ---- 图片 ----
    images = []
    try:
        for info in page.get_image_info(xrefs=True):
            bb = info.get("bbox")
            if not bb:
                continue
            images.append({
                "bbox": tuple(bb),
                "pix_w": info.get("width", 0),
                "pix_h": info.get("height", 0),
                "cs": info.get("cs-name", "?"),
                "bpc": info.get("bpc", 8),
                "xref": info.get("xref", 0),
                "size": info.get("size", 0),
                "seq": 0,
            })
    except Exception as e:
        warnings.append(f"图片信息读取失败：{e}")

    # ---- 注释层（图章/批注/表单域画在独立外观流里，不在页面内容流中）----
    annots = []
    try:
        for a in page.annots():
            t = a.type[1] if isinstance(a.type, (tuple, list)) else str(a.type)
            if t in ("Link", "Popup"):
                continue
            if a.flags & 2 or a.flags & 32:      # Hidden / NoView
                continue
            r = a.rect
            annots.append({
                "type": t,
                "bbox": (r.x0, r.y0, r.x1, r.y1),
                "content": (a.info or {}).get("content", "") or "",
                "title": (a.info or {}).get("title", "") or "",
            })
    except Exception:
        pass

    return {
        "parts": parts, "drawings": drawings, "images": images, "annots": annots,
        "warnings": warnings, "bad": bad_total,
        "invisible": invisible_count, "hidden_layer": hidden_layer,
    }


# ============================================================
# 语义重建层（与 HTML 版同一套算法）
# ============================================================
def join_parts_adaptive(parts: list[Part]):
    """把同一行的片段拼成字符串，按需补回空格。

    固定阈值必然两头不讨好：0.2em 会把 letter-spacing 的标题拆成单字母，
    0.4em 又会把正常的词粘在一起。判据应该是「这个间隙相对同组其它间隙是不是异常大」。
    """
    gaps = []
    for a, b in zip(parts, parts[1:]):
        g = b.x0 - a.x1
        if g > 0.01:
            gaps.append(g)
    med_gap = median(gaps) if len(gaps) >= 3 else 0.0

    text, seps = "", []
    prev_end, prev_size = None, (parts[0].size if parts else 10.0)
    bad = 0
    for p in parts:
        sep = ""
        if prev_end is not None and p.text:
            gap = p.x0 - prev_end
            em = max(prev_size, p.size)
            both_cjk = is_cjk(text[-1:]) and is_cjk(p.text[:1])
            thr = em * 0.45 if both_cjk else max(em * 0.20, med_gap * 1.8)
            if gap > thr and not text.endswith((" ", "\t")):
                sep = " "
        seps.append(sep)
        text += sep + p.text
        bad += p.bad or 0
        prev_end, prev_size = p.x1, p.size
    return text, seps, bad


def build_lines(parts: list[Part]):
    flat = [p for p in parts if not p.rotated]
    rotated = [p for p in parts if p.rotated]
    flat.sort(key=lambda p: (p.baseline, p.x0))

    buckets: list[dict] = []
    for p in flat:
        hit = None
        for b in reversed(buckets[-24:]):
            tol = max(1.2, max(b["size"], p.size) * 0.32)
            if abs(b["baseline"] - p.baseline) <= tol:
                if min(b["size"], p.size) / max(b["size"], p.size) > 0.45:
                    hit = b
                    break
            if b["baseline"] < p.baseline - p.size * 3:
                break
        if hit:
            hit["parts"].append(p)
            n = len(hit["parts"])
            hit["baseline"] = (hit["baseline"] * (n - 1) + p.baseline) / n
            hit["size"] = max(hit["size"], p.size)
        else:
            buckets.append({"baseline": p.baseline, "size": p.size, "parts": [p]})

    out = []
    for b in buckets:
        ps = sorted(b["parts"], key=lambda x: x.x0)
        text, seps, bad = join_parts_adaptive(ps)
        L = Line()
        L.text, L.parts, L.seps = text, ps, seps
        L.x0, L.x1 = min(p.x0 for p in ps), max(p.x1 for p in ps)
        L.top, L.bottom = min(p.top for p in ps), max(p.bottom for p in ps)
        L.baseline = b["baseline"]
        sizes = [p.size for p in ps]
        L.size = median(sizes)
        L.size_set = sorted({round(s, 1) for s in sizes})
        L.bold = any(p.bold for p in ps)
        L.all_bold = all(p.bold for p in ps)
        L.italic = any(p.italic for p in ps)
        L.fonts = list(dict.fromkeys(p.font for p in ps))
        L.color = most_common([p.color for p in ps])
        L.colors = list(dict.fromkeys(c for c in (p.color for p in ps) if c))
        L.bad = bad
        L.seq = min(p.seq for p in ps)
        L.annot = ps[0].annot
        out.append(L)
    out.sort(key=lambda l: (l.top, l.x0))
    return out, rotated


def should_merge_lines(prev: Line, nxt: Line, max_right: float, min_left: float) -> bool:
    """两行是否属于同一段。

    合并太狠：两段并成一段，AI 少建一个项目符号。
    合并太松：一段拆成八行，AI 当成八个独立文本框。
    下面这套判据按「商务 PPT 导出的 PDF + 研报」调过。
    """
    lead = nxt.baseline - prev.baseline
    gap = nxt.top - prev.bottom
    size = max(prev.size, nxt.size)

    if min(prev.size, nxt.size) / size < 0.85:
        return False                       # 字号跳变 = 标题接正文
    if prev.all_bold != nxt.all_bold:
        return False                       # 粗细跳变 = 强调行独立成段
    if lead > size * 1.9 or gap > size * 1.1:
        return False                       # 段间距，不是行距
    if lead < size * 0.4:
        return False

    ov = min(prev.x1, nxt.x1) - max(prev.x0, nxt.x0)
    min_w = min(prev.x1 - prev.x0, nxt.x1 - nxt.x0)
    if ov < min_w * 0.5:
        return False                       # 水平不重叠 = 并排两栏

    short = (max_right - prev.x1) > size * 2.5
    if short and SENT_END_RE.search(prev.text):
        return False
    if short and (nxt.x0 - min_left) > size * 1.2:
        return False                       # 短行 + 首行缩进 = 新段
    if BULLET_RE.match(nxt.text):
        return False                       # 项目符号各自独立
    return True


def lines_to_para(ls: list[Line]) -> Para:
    p = Para()
    p.lines = ls
    p.text = "\n".join(l.text for l in ls)
    flow = ""
    for i, l in enumerate(ls):
        if i == 0:
            flow = l.text
        else:
            need = not is_cjk(flow[-1:]) and not is_cjk(l.text[:1]) and not flow.endswith(("-", " "))
            flow += (" " if need else "") + l.text
    p.flow_text = flow
    p.x0, p.x1 = min(l.x0 for l in ls), max(l.x1 for l in ls)
    p.top, p.bottom = min(l.top for l in ls), max(l.bottom for l in ls)
    p.size = median([l.size for l in ls])
    p.bold = any(l.bold for l in ls)
    p.all_bold = all(l.all_bold for l in ls)
    p.italic = any(l.italic for l in ls)
    p.fonts = list(dict.fromkeys(f for l in ls for f in l.fonts))
    p.color = most_common([l.color for l in ls])
    p.colors = list(dict.fromkeys(c for l in ls for c in l.colors))
    p.line_gap = median([b.baseline - a.baseline for a, b in zip(ls, ls[1:])]) if len(ls) > 1 else None
    p.bad = sum(l.bad for l in ls)
    p.seq = min(l.seq for l in ls)
    p.annot = ls[0].annot
    return p


def build_paragraphs(lines: list[Line], merge: bool) -> list[Para]:
    if not merge:
        return [lines_to_para([l]) for l in lines]
    paras, cur = [], []
    for L in lines:
        if not cur:
            cur = [L]
            continue
        mr = max(l.x1 for l in cur)
        ml = min(l.x0 for l in cur)
        if should_merge_lines(cur[-1], L, mr, ml):
            cur.append(L)
        else:
            paras.append(lines_to_para(cur))
            cur = [L]
    if cur:
        paras.append(lines_to_para(cur))
    return paras


def group_blocks(paras: list[Para]) -> list[Block]:
    blocks, used = [], set()
    ordered = sorted(paras, key=lambda p: p.top)
    for i, p0 in enumerate(ordered):
        if i in used:
            continue
        group = [p0]
        used.add(i)
        for j in range(i + 1, len(ordered)):
            if j in used:
                continue
            p = ordered[j]
            last = group[-1]
            gap = p.top - max(q.bottom for q in group)
            if gap > max(last.size, p.size) * 2.2:
                break
            left_aligned = abs(p.x0 - last.x0) < max(last.size, p.size) * 1.6
            ov = min(last.x1, p.x1) - max(last.x0, p.x0)
            min_w = min(last.x1 - last.x0, p.x1 - p.x0)
            if left_aligned and ov > min_w * 0.35 and gap >= -1:
                group.append(p)
                used.add(j)
        b = Block()
        b.paras = group
        b.x0, b.x1 = min(p.x0 for p in group), max(p.x1 for p in group)
        b.top, b.bottom = min(p.top for p in group), max(p.bottom for p in group)
        b.size = median([p.size for p in group])
        b.seq = min(p.seq for p in group)
        b.annot = group[0].annot
        blocks.append(b)
    return blocks


def detect_columns(blocks: list[Block], page_w: float):
    items = [b for b in blocks if (b.x1 - b.x0) > 2]
    if len(items) < 4:
        return {"columns": 1, "gutters": [], "confidence": 0.0, "bounds": None}
    left = min(b.x0 for b in items)
    right = max(b.x1 for b in items)
    top = min(b.top for b in items)
    bottom = max(b.bottom for b in items)
    span_h = bottom - top
    if right - left < page_w * 0.3 or span_h <= 0:
        return {"columns": 1, "gutters": [], "confidence": 0.0, "bounds": None}

    N = 400
    step = (right - left) / N
    cover = [0.0] * N
    for b in items:
        i0 = max(0, int((b.x0 - left) / step))
        i1 = min(N - 1, math.ceil((b.x1 - left) / step))
        for i in range(i0, i1 + 1):
            cover[i] += b.bottom - b.top

    gutters, run = [], -1
    for i in range(N + 1):
        empty = i < N and cover[i] <= span_h * 0.02
        if empty and run < 0:
            run = i
        elif not empty and run >= 0:
            w = (i - run) * step
            if w > page_w * 0.015 and run > 2 and i < N - 2:
                gutters.append({"x0": left + run * step, "x1": left + i * step, "w": w})
            run = -1
    gutters.sort(key=lambda g: -g["w"])
    keep = sorted([g for g in gutters[:3] if g["w"] > page_w * 0.02], key=lambda g: g["x0"])
    if not keep:
        return {"columns": 1, "gutters": [], "confidence": 0.0, "bounds": None}

    bounds = [left] + [(g["x0"] + g["x1"]) / 2 for g in keep] + [right]
    counts = []
    for a, b in zip(bounds, bounds[1:]):
        counts.append(sum(1 for it in items if a <= (it.x0 + it.x1) / 2 < b))
    if sum(1 for c in counts if c >= 2) < 2:
        return {"columns": 1, "gutters": [], "confidence": 0.0, "bounds": None}
    conf = min(0.95, 0.45 + 0.15 * min(len(counts), 3) + (0.2 if min(counts) >= 3 else 0))
    return {"columns": len(counts), "gutters": keep, "confidence": conf, "bounds": bounds}


def mark_headers_footers(pages: list[dict]):
    n = len(pages)
    if n < 3:
        return                       # 页数太少，跨页统计不可靠，宁可不判
    tally = defaultdict(list)
    for pi, pg in enumerate(pages):
        for b in pg["blocks"]:
            rel_t = b.top / pg["h"]
            rel_b = b.bottom / pg["h"]
            if rel_t > 0.12 and rel_b < 0.88:
                continue
            norm = re.sub(r"\s+", " ", re.sub(r"\d+", "#", " ".join(p.text for p in b.paras))).strip()[:60]
            tally[("H" if rel_t <= 0.12 else "F", norm)].append((pi, b))
    need = max(3, math.ceil(n * 0.5))
    for (kind, _), lst in tally.items():
        hits = len({pi for pi, _ in lst})
        if hits >= need:
            for _, b in lst:
                b.role = "页眉" if kind == "H" else "页脚"
                b.role_conf = min(0.95, hits / n)
    for pg in pages:
        for b in pg["blocks"]:
            if b.role:
                continue
            t = " ".join(p.text for p in b.paras).strip()
            rel_t, rel_b = b.top / pg["h"], b.bottom / pg["h"]
            if re.fullmatch(r"[\-—–\s]*\d{1,4}[\-—–\s]*", t) and (rel_t <= 0.10 or rel_b >= 0.90):
                b.role = "页脚" if rel_b >= 0.90 else "页眉"
                b.role_conf = 0.8
                b.is_page_number = True


# ---------- 形状分类 ----------
def classify_drawing(dr: dict, page_w: float, page_h: float) -> dict:
    x0, y0, x1, y1 = dr["bbox"]
    w, h = x1 - x0, y1 - y0
    area = w * h
    items = dr["items"]
    kinds = [it[0] for it in items]
    out = {"w": w, "h": h, "area": area}

    if dr["fill"] and area > page_w * page_h * 0.88 and w > page_w * 0.93 and h > page_h * 0.93:
        return {**out, "type": "背景", "confidence": 0.9}
    if min(w, h) <= 3.2 and max(w, h) > 6:
        return {**out, "type": "水平线" if w >= h else "垂直线", "confidence": 0.9}
    if len(items) == 1 and kinds[0] == "l":
        p1, p2 = items[0][1], items[0][2]
        dx, dy = abs(p2.x - p1.x), abs(p2.y - p1.y)
        t = "水平线" if dy < 0.8 else ("垂直线" if dx < 0.8 else "斜线")
        return {**out, "type": t, "confidence": 0.95}
    if len(items) == 1 and kinds[0] == "re":
        square = abs(w - h) / max(w, h, 1e-6) < 0.02
        return {**out, "type": "正方形" if square else "矩形", "confidence": 0.95}
    if len(items) == 1 and kinds[0] == "qu":
        return {**out, "type": "四边形", "confidence": 0.85}

    n_curve = kinds.count("c")
    n_line = kinds.count("l")
    if n_curve == 4 and n_line == 0:
        square = abs(w - h) / max(w, h, 1e-6) < 0.03
        return {**out, "type": "圆形" if square else "椭圆", "confidence": 0.85,
                "radius": (w / 2, h / 2)}
    if 2 <= n_curve <= 8 and n_line >= 2:
        return {**out, "type": "圆角矩形", "confidence": 0.75}
    if n_curve == 0 and n_line == 2 and dr.get("closed"):
        return {**out, "type": "三角形", "confidence": 0.8}
    if n_curve == 0 and n_line >= 2:
        if dr.get("closed"):
            return {**out, "type": f"{n_line + 1}边形", "confidence": 0.7}
        return {**out, "type": "折线", "confidence": 0.8}
    if n_curve and not dr.get("closed"):
        return {**out, "type": "曲线", "confidence": 0.75}
    if all(k == "re" for k in kinds) and len(kinds) <= 3:
        return {**out, "type": "矩形组", "confidence": 0.7}
    return {**out, "type": "复合路径", "confidence": 0.5, "sub_count": len(items)}


# ---------- 疑似图表 ----------
def detect_charts(shapes: list[dict], lines: list[Line], page_w: float, page_h: float):
    charts = []
    rects = [s for s in shapes
             if s["shape"]["type"] in ("矩形", "正方形") and s["dr"]["fill"]
             and 4 < s["shape"]["area"] < page_w * page_h * 0.5]

    by_w = defaultdict(list)
    for r in rects:
        w = round((r["dr"]["bbox"][2] - r["dr"]["bbox"][0]) * 2) / 2
        if w >= 1:
            by_w[w].append(r)

    for w, group in by_w.items():
        if len(group) < 3:
            continue
        for axis, base_fn, len_fn in (
            ("垂直柱", lambda r: r["dr"]["bbox"][3], lambda r: r["dr"]["bbox"][3] - r["dr"]["bbox"][1]),
            ("水平条", lambda r: r["dr"]["bbox"][0], lambda r: r["dr"]["bbox"][2] - r["dr"]["bbox"][0]),
        ):
            bm = median([base_fn(r) for r in group])
            aligned = [r for r in group if abs(base_fn(r) - bm) < 1.5]
            if len(aligned) < 3:
                continue
            lens = [len_fn(r) for r in aligned]
            if len({round(v) for v in lens}) < 2:
                continue                        # 长度全一样 = 表格底纹，不是柱子
            bbox = union_box([r["dr"]["bbox"] for r in aligned])
            probe = (bbox[0] - 40, bbox[1] - 25, bbox[2] + 40, bbox[3] + 30)
            labels = [l.text for l in lines
                      if overlap_area((l.x0, l.top, l.x1, l.bottom), probe) > 0 and l.text.strip()]
            aligned.sort(key=lambda r: r["dr"]["bbox"][0])
            charts.append({
                "guess": f"柱形图（{axis}）",
                "bbox": bbox,
                "series": [{"x0": r["dr"]["bbox"][0], "y0": r["dr"]["bbox"][1],
                            "x1": r["dr"]["bbox"][2], "y1": r["dr"]["bbox"][3],
                            "len": len_fn(r), "color": r["dr"]["fill"]} for r in aligned],
                "colors": list(dict.fromkeys(r["dr"]["fill"] for r in aligned)),
                "labels": labels,
                "members": {id(r["dr"]) for r in aligned},
                "confidence": min(0.8, 0.4 + len(aligned) * 0.05),
                "reason": f"{len(aligned)} 个等宽({w:.1f}pt)、共基线、长度不同的填充矩形",
            })
            break

    # 饼图/环形图：一组共圆心的曲线扇形
    wedges = [s for s in shapes
              if s["dr"]["fill"] and any(it[0] == "c" for it in s["dr"]["items"])
              and s["shape"]["type"] not in ("圆形", "椭圆") and s["shape"]["area"] > 20]
    groups = defaultdict(list)
    for s in wedges:
        pts = []
        for it in s["dr"]["items"]:
            for q in it[1:]:
                if hasattr(q, "x"):
                    pts.append((round(q.x), round(q.y)))
        if not pts:
            continue
        (cx, cy), hits = Counter(pts).most_common(1)[0]
        if hits < 2:
            continue
        groups[(round(cx / 6), round(cy / 6))].append((s, cx, cy))
    for _, g in groups.items():
        if len(g) < 2:
            continue
        bbox = union_box([s["dr"]["bbox"] for s, _, _ in g])
        if bbox[2] - bbox[0] < 15 or bbox[3] - bbox[1] < 15:
            continue
        probe = (bbox[0] - 60, bbox[1] - 30, bbox[2] + 60, bbox[3] + 30)
        labels = [l.text for l in lines
                  if overlap_area((l.x0, l.top, l.x1, l.bottom), probe) > 0 and l.text.strip()]
        charts.append({
            "guess": "饼图/环形图" if len(g) >= 3 else "饼图/环形图（扇区偏少，可能是图标）",
            "bbox": bbox,
            "series": [{"color": s["dr"]["fill"], "bbox": s["dr"]["bbox"]} for s, _, _ in g],
            "colors": list(dict.fromkeys(s["dr"]["fill"] for s, _, _ in g)),
            "labels": labels,
            "members": {id(s["dr"]) for s, _, _ in g},
            "center": (g[0][1], g[0][2]),
            "confidence": min(0.7, 0.3 + len(g) * 0.08),
            "reason": f"{len(g)} 个共圆心(±6pt)的闭合曲线填充路径",
        })

    charts.sort(key=lambda c: -c["confidence"])
    kept = []
    for c in charts:
        ca = (c["bbox"][2] - c["bbox"][0]) * (c["bbox"][3] - c["bbox"][1])
        if any(overlap_area(k["bbox"], c["bbox"]) > 0.6 * min(ca, (k["bbox"][2]-k["bbox"][0])*(k["bbox"][3]-k["bbox"][1]))
               for k in kept):
            continue
        kept.append(c)
    return kept


# ============================================================
# 给 AI 的说明（与 HTML 版逐字一致）
# ============================================================
PREAMBLE = """> 【给 AI 的说明】下面是一份 PDF 的结构化描述，由「PDF 转 AI 文本」工具从 PDF 的原始绘图指令中提取并重建，
> 目的是让你据此还原成 PPT。请严格按这些参数还原，不要自行发挥版式、配色或字号。
>
> ⚠️ 先读这段，PDF 和 PPT 的导出文本不是一回事：
> PPTX 里存的是语义对象（"这是一个圆角矩形，里面有个段落"）；
> PDF 里没有形状、没有段落、没有表格，只有"把某个字画在某个坐标""从这点画条线到那点"。
> 所以下面的内容分两类，可信度完全不同：
>
>   · 没有标记的数值 —— 直接来自文件的原始绘图指令：坐标、尺寸、颜色、字号、字体名、文字内容。
>     这些是精确值，不是估计，请照抄，不要"优化"。
>   · 标了 [推断 置信度x.xx] 的 —— 工具从几何关系重建出来的：段落归并、文本框边界、表格行列、
>     多栏顺序、页眉页脚、图表类型。置信度低于 0.6 的地方你可以按常识调整，
>     但调整时不要推翻没有标记的原始数值。
>   · 标了「无法确定」的 —— 工具确实解不出来，没有拿猜测糊弄你。请按你的判断补齐，
>     并在交付时告诉用户你补了什么。
>
> 阅读约定：
> · 坐标原点在页面左上角，x 向右、y 向下。单位见每行标注。
> · 元素按 [序号] 排列，序号即绘制顺序，也就是 z 轴叠放顺序：序号大的压在上面。
> · 文本块另有「阅读顺序 N」标注，那是给人读的顺序（已处理多栏），与 z 轴序号不是一回事。
> · 颜色写作 #RRGGBB。透明度单独标注。
> · 字号是视觉磅值，已经把所有变换矩阵的缩放折算进去了。
> · 图片只给位置、尺寸和格式；如果本文件附带了导出的图片目录，文件名会一并给出。
>
> 还原成 PPT 的建议：
> 1. 用 python-pptx 生成。幻灯片尺寸用文首「目标版式」给出的值。
> 2. 一个「文本块」= 一个 textbox。用块的 x/y/宽/高 定位，word_wrap=True，段落和字符格式照抄。
>    不要把整页文字塞进一个 textbox，也不要每行建一个。
> 3. 「表格」必须用真正的 pptx 表格（add_table），不要用文本框拼。列宽用给出的列边界算。
> 4. 「矩形/圆角矩形/线条/椭圆」用 add_shape / add_connector 还原，填充和边框照抄。
>    标了「背景」的整页色块请设成幻灯片背景，不要建成形状。
> 5. 「疑似图表」给的是每根柱子/每块扇形的几何和颜色，外加附近的文字标签。
>    优先用 add_chart 重建成真图表；如果标签和几何对不上数据，宁可用形状按原几何摆出来，也不要编数据。
> 6. 报告类 PDF 一页的信息量常常超过一张幻灯片。允许你把一页拆成多张，但拆完要说明怎么拆的。
> 7. 遇到「页眉」「页脚」：那是每页重复的模板元素，不要在每张幻灯片上重复创建，
>    放进母版或直接省略，并告诉用户你的处理方式。
"""


def guess_paper(w: float, h: float) -> str:
    def near(a, b):
        return abs(w - a) < 8 and abs(h - b) < 8
    if near(595, 842) or near(842, 595):
        return "，A4"
    if near(612, 792) or near(792, 612):
        return "，Letter"
    if near(842, 1191) or near(1191, 842):
        return "，A3"
    if near(720, 540):
        return "，4:3 幻灯片"
    if near(960, 540) or near(720, 405):
        return "，16:9 幻灯片"
    r = w / h if h else 1
    if abs(r - 16 / 9) < 0.03:
        return "，16:9 宽屏，很可能原本就是幻灯片"
    if abs(r - 4 / 3) < 0.03:
        return "，4:3，很可能原本就是幻灯片"
    return ""


def origin_hint(meta: dict) -> str | None:
    s = f"{meta.get('creator','')} {meta.get('producer','')}".lower()
    if re.search(r"powerpoint|keynote|impress|canva|figma|sketch", s):
        which = ("PowerPoint" if "powerpoint" in s else
                 "Keynote" if "keynote" in s else
                 "Canva" if "canva" in s else
                 "Figma" if "figma" in s else "演示/设计工具")
        return (f"这份 PDF 原本就是演示文稿导出的（{which}）。"
                "版面可以逐页 1:1 还原成幻灯片，不需要重新排版。")
    if re.search(r"word|wps|pages", s):
        return ("这份 PDF 原本是文字处理软件的文档（Word/WPS 类），版面是为纸张排的。"
                "转成 PPT 时通常需要重新组织，而不是照搬坐标。")
    if re.search(r"latex|pdftex|xetex|luatex", s):
        return "这份 PDF 由 LaTeX 排版。多为学术/报告版式，正文栏宽固定，转 PPT 需要重新分块。"
    if re.search(r"chromium|skia|headless|wkhtmltopdf|weasyprint", s):
        return ("这份 PDF 是从网页渲染出来的（浏览器打印）。文字与色块是分离的，"
                "版面通常是流式布局，转 PPT 时按内容分块比照搬坐标更合适。")
    return None


# ============================================================
# 输出层
# ============================================================
def fmt_run(r: dict, sc: Scale) -> str:
    b = [sc.fs(r["size"])]
    if r["bold"]:
        b.append("粗体")
    if r["italic"]:
        b.append("斜体")
    b.append("字体 " + (r["font"] or "未知"))
    if r["color"]:
        b.append(r["color"])
    return " ".join(b)


def collect_runs(p: Para) -> list[dict]:
    runs: list[dict] = []
    for li, l in enumerate(p.lines):
        for i, part in enumerate(l.parts):
            sep = l.seps[i] if l.seps and i < len(l.seps) else ""
            key = (part.font, round(part.size, 1), part.bold, part.italic, part.color)
            if runs and runs[-1]["key"] == key:
                runs[-1]["text"] += sep + part.text
            else:
                if sep and runs:
                    runs[-1]["text"] += sep
                runs.append({"key": key, "text": part.text, "size": part.size,
                             "font": part.font, "bold": part.bold,
                             "italic": part.italic, "color": part.color})
        if li < len(p.lines) - 1 and runs:
            last = runs[-1]
            nxt = p.lines[li + 1].text[:1]
            if not is_cjk(last["text"][-1:]) and not is_cjk(nxt) and not last["text"].endswith(("-", " ")):
                last["text"] += " "
    return runs


def emit_text_block(b: Block, n: int, sc: Scale, out: list[str], compact: bool):
    role = f"（{b.role} [推断 置信度{b.role_conf:.2f}]）" if b.role else ""
    order = "" if b.role else f"  阅读顺序 {b.read_index}"
    col = f"  第{b.column + 1}栏" if b.column else ""
    out.append(f"### [{n}] 文本块{role}{order}{col}")
    out.append(f"位置: {sc.box(b.x0, b.top, b.x1, b.bottom)}"
               f"   [推断 置信度0.80 —— PDF 无文本框概念，此边界由文字外接框反推]")
    for pi, p in enumerate(b.paras, 1):
        meta = []
        if p.line_gap and p.size:
            meta.append(f"行距 {p.line_gap / p.size:.2f}倍")
        if len(p.lines) > 1:
            meta.append(f"{len(p.lines)} 行")
        out.append(f"段落{pi}" + (f" [{'，'.join(meta)}]" if meta else "") + ":")
        runs = collect_runs(p)
        if len(runs) > 1:
            # 一段里格式有变化就必须逐 run 输出，紧凑模式也不能省 ——
            # 否则 median 会把 "占 31% 份额" 的 24pt 和 10pt 抹平成 17pt
            for r in runs:
                if r["text"]:
                    out.append(f'  · "{r["text"]}"  — {fmt_run(r, sc)}')
        else:
            one = p.flow_text if len(p.lines) > 1 else p.text
            bits = [sc.fs(p.size)]
            if p.all_bold:
                bits.append("粗体")
            elif p.bold:
                bits.append("部分粗体")
            if p.italic:
                bits.append("斜体")
            bits.append("字体 " + "/".join(p.fonts[:2]))
            if p.color:
                bits.append(p.color)
            out.append(f'  · "{one}"  — {" ".join(bits)}')
        if p.bad:
            out.append(f"  ⚠️ 本段有 {p.bad} 个字形无法确定对应字符（已写成 �）")


def emit_table(t: dict, n: int, sc: Scale, out: list[str], compact: bool):
    out.append(f"### [{n}] 表格 [推断 置信度{t['confidence']:.2f}]")
    out.append(f"位置: {sc.box(*t['bbox'])}")
    out.append(f"{t['rows']} 行 × {t['cols']} 列　依据: {t['reason']}")
    if t.get("col_edges") and len(t["col_edges"]) > 1:
        widths = [sc.size(b - a) for a, b in zip(t["col_edges"], t["col_edges"][1:])]
        out.append(f"列宽: {' | '.join(widths)} {sc.u}")
    for ri, row in enumerate(t["grid"], 1):
        cells = [(c or "").replace("\n", "⏎") for c in row]
        out.append(f"  第{ri}行: " + " | ".join(f'"{c}"' for c in cells))


def emit_chart(c: dict, n: int, sc: Scale, out: list[str]):
    out.append(f"### [{n}] 疑似图表：{c['guess']} [推断 置信度{c['confidence']:.2f}]")
    out.append(f"位置: {sc.box(*c['bbox'])}")
    out.append(f"识别依据: {c['reason']}")
    out.append("⚠️ PDF 里没有图表对象，这是从几何形状反推的。下面给的是原始几何，不是数据。")
    if c["colors"]:
        out.append("配色: " + " ".join(x for x in c["colors"] if x))
    if c["series"] and "len" in c["series"][0]:
        out.append("各柱几何（按 x 从左到右）:")
        for i, s in enumerate(c["series"], 1):
            out.append(f"  柱{i}: 长度 {sc.size(s['len'])}{sc.u}  "
                       f"x={sc.x(s['x0'])}~{sc.x(s['x1'])}  {s['color'] or ''}")
        lens = [s["len"] for s in c["series"]]
        mn = min(lens)
        if mn > 0:
            out.append("  长度比值（若坐标轴从 0 起，这就是数据比值）: "
                       + " : ".join(f"{v / mn:.2f}" for v in lens))
        else:
            out.append("  长度比值: 无法确定（存在零长度柱）")
    if c.get("center"):
        out.append(f"圆心: ({sc.x(c['center'][0])}, {sc.y(c['center'][1])}) {sc.u}")
    if c["labels"]:
        out.append("区域内及周边文字（可能是坐标轴标签/数据标签/图例，工具无法确定归属）:")
        out.append("  " + "  ".join(f'"{t}"' for t in c["labels"][:40]))
        if len(c["labels"]) > 40:
            out.append(f"  …还有 {len(c['labels']) - 40} 条未列出")


def emit_shape(s: dict, n: int, sc: Scale, out: list[str], compact: bool):
    dr, sh = s["dr"], s["shape"]
    conf = f" [推断 置信度{sh['confidence']:.2f}]" if sh["confidence"] < 0.8 else ""
    out.append(f"### [{n}] {sh['type']}{conf}")
    out.append(f"位置: {sc.box(*dr['bbox'])}")
    if dr["fill"]:
        a = "" if dr["fill_alpha"] >= 1 else f" 透明度 {round((1 - dr['fill_alpha']) * 100)}%"
        out.append(f"填充: {dr['fill']}{a}")
    elif not compact:
        out.append("填充: 无")
    if dr["stroke"]:
        a = "" if dr["stroke_alpha"] >= 1 else f" 透明度 {round((1 - dr['stroke_alpha']) * 100)}%"
        dash = " 虚线" if dr["dashes"] and dr["dashes"] not in ("[] 0", "[]0") else ""
        out.append(f"边框: {dr['stroke']} 粗细 {round(dr['width'] * sc.k, 2)}pt{dash}{a}")
    if dr.get("layer"):
        out.append(f"所属图层: {dr['layer']}")


def emit_image(im: dict, n: int, sc: Scale, out: list[str], page_no: int):
    out.append(f"### [{n}] 图片")
    out.append(f"位置: {sc.box(*im['bbox'])}")
    out.append(f"像素尺寸: {im['pix_w']} × {im['pix_h']}　颜色空间: {im['cs']}　位深: {im['bpc']}")
    if im.get("file"):
        out.append(f"已导出为文件: {im['file']}　← 请连同本文本一起提供给 AI")
    else:
        out.append(f"⚠️ 像素内容无法用文本传输。还原时请向用户索取这张图"
                   f"（第 {page_no} 页，xref {im['xref']}）；"
                   f"或者重跑本工具时加上 --export-images 参数自动导出。")


# ============================================================
# 主流程
# ============================================================
def convert(src, opt, display_name: str | None = None) -> str:
    """src 可以是路径，也可以是 PDF 字节流（exe 里的高保真模式走字节流）。"""
    if isinstance(src, (bytes, bytearray)):
        doc = pymupdf.open(stream=bytes(src), filetype="pdf")
        doc_name = display_name or "input.pdf"
    else:
        src = Path(src)
        doc = pymupdf.open(src)
        doc_name = display_name or src.name
    warnings: list[str] = []

    if doc.needs_pass:
        if not doc.authenticate(""):
            raise RuntimeError(
                "这份 PDF 设了打开口令，空口令打不开。"
                "请先在阅读器里用口令打开并另存为无口令版本再转。"
            )
        warnings.append("文件已加密（空口令），已自动解密。")
    elif doc.is_encrypted:
        warnings.append("文件带加密标记（空口令可读），已自动解密。")

    meta = doc.metadata or {}
    n_pages = doc.page_count
    if n_pages == 0:
        raise RuntimeError("没有找到任何页面。文件可能已损坏。")

    img_dir = Path(opt.export_images) if opt.export_images else None
    if img_dir:
        img_dir.mkdir(parents=True, exist_ok=True)
    png_dir = Path(opt.render_pages) if opt.render_pages else None
    if png_dir:
        png_dir.mkdir(parents=True, exist_ok=True)

    pages: list[dict] = []
    fonts_used: Counter = Counter()
    exported: set[int] = set()

    for pi in range(n_pages):
        page = doc[pi]
        raw = extract_page(page, opt)
        warnings.extend(raw["warnings"])

        rect = page.rect
        pw, ph = rect.width, rect.height

        lines, rotated = build_lines(raw["parts"])
        for p in raw["parts"]:
            fonts_used[p.font] += len(p.text)

        # ---- 表格：用 PyMuPDF 自带的检测，比手写几何推断成熟 ----
        tables: list[dict] = []
        used_lines: set[int] = set()
        if opt.tables:
            try:
                finder = page.find_tables()
                for tb in finder.tables:
                    grid = tb.extract()
                    rows = len(grid)
                    cols = max((len(r) for r in grid), default=0)
                    if rows < 2 or cols < 2:
                        continue     # 单行或单列不是表格，只是几条线
                    filled = sum(1 for r in grid for c in r if c and str(c).strip())
                    if filled / max(1, rows * cols) < 0.25:
                        continue
                    bbox = tuple(tb.bbox)
                    # tb.cells 是 (x0,y0,x1,y1) 列表，合并单元格处为 None
                    try:
                        edges = {round(c[0], 1) for c in tb.cells if c}
                        edges |= {round(c[2], 1) for c in tb.cells if c}
                        col_edges = sorted(edges)
                    except Exception:
                        col_edges = None
                    tables.append({
                        "bbox": bbox, "rows": rows, "cols": cols,
                        "grid": [[(c if c is not None else "") for c in r] for r in grid],
                        "col_edges": col_edges,
                        "confidence": 0.85,
                        "reason": f"PyMuPDF find_tables 识别，{filled}/{rows*cols} 个单元格有内容",
                        "seq": 10_000_000,
                    })
                    for l in lines:
                        if overlap_area((l.x0, l.top, l.x1, l.bottom), bbox) > \
                                0.6 * max(1e-6, (l.x1 - l.x0) * (l.bottom - l.top)):
                            used_lines.add(id(l))
            except Exception as e:
                warnings.append(f"第 {pi+1} 页表格检测失败：{e}")

        # ---- 形状 ----
        shapes = [{"dr": dr, "shape": classify_drawing(dr, pw, ph)} for dr in raw["drawings"]] \
            if opt.shapes else []
        background = next((s for s in shapes if s["shape"]["type"] == "背景"), None)

        # ---- 图表 ----
        charts = detect_charts(shapes, lines, pw, ph) if opt.charts else []
        chart_members = {m for c in charts for m in c["members"]}

        # ---- 段落与文本块 ----
        free = [l for l in lines if id(l) not in used_lines]
        paras = build_paragraphs(free, opt.merge_para)
        blocks = group_blocks(paras)

        # ---- 图片导出 ----
        for im in raw["images"]:
            if img_dir and im["xref"] and im["xref"] not in exported:
                try:
                    info = doc.extract_image(im["xref"])
                    fn = img_dir / f"p{pi+1:03d}_x{im['xref']}.{info['ext']}"
                    fn.write_bytes(info["image"])
                    # 用正斜杠，跨平台一致，贴给 AI 也不会被当成转义符
                    im["file"] = f"{img_dir.name}/{fn.name}"
                    exported.add(im["xref"])
                except Exception as e:
                    warnings.append(f"第 {pi+1} 页图片 xref {im['xref']} 导出失败：{e}")
            elif im["xref"] in exported and img_dir:
                im["file"] = f"p*_x{im['xref']}.*（与前页同一张图，已导出）"

        if png_dir:
            try:
                page.get_pixmap(dpi=110).save(png_dir / f"page{pi+1:03d}.png")
            except Exception:
                pass

        pages.append({
            "w": pw, "h": ph, "rot": page.rotation,
            "lines": lines, "rotated": rotated, "blocks": blocks,
            "tables": tables, "charts": charts, "chart_members": chart_members,
            "shapes": [s for s in shapes if s is not background], "background": background,
            "images": raw["images"], "annots": raw["annots"],
            "bad": raw["bad"], "invisible": raw["invisible"], "hidden_layer": raw["hidden_layer"],
            "dropped": 0,
        })

    # ---- 跨页：分栏 / 页眉页脚 / 阅读顺序 ----
    for pg in pages:
        pg["columns"] = detect_columns(pg["blocks"], pg["w"]) if opt.columns \
            else {"columns": 1, "gutters": [], "confidence": 0.0, "bounds": None}
    if opt.header_footer:
        mark_headers_footers(pages)
    for pg in pages:
        body = [b for b in pg["blocks"] if not b.role]
        col = pg["columns"]
        if col["columns"] > 1 and col["bounds"]:
            for b in body:
                cx = (b.x0 + b.x1) / 2
                b.column = max(i for i, v in enumerate(col["bounds"][:-1]) if cx >= v)
            body.sort(key=lambda b: (b.column, b.top, b.x0))
        else:
            body.sort(key=lambda b: (b.top, b.x0))
        for i, b in enumerate(body, 1):
            b.read_index = i

    # ============ 组装输出 ============
    p0 = pages[0]
    sc = Scale(opt.unit, opt.target, p0["w"], p0["h"])
    uniform = len({(round(p["w"]), round(p["h"])) for p in pages}) == 1

    L: list[str] = []
    L.append(f"# PDF 结构化描述：{doc_name}")
    L.append("")

    raw_sc = Scale(opt.unit, "raw", p0["w"], p0["h"])
    native = "" if opt.unit == "pt" else f"{round(p0['w'])} × {round(p0['h'])} pt，"
    L.append(f"页面尺寸: {raw_sc.size(p0['w'])} × {raw_sc.size(p0['h'])} {sc.u}　"
             f"({native}比例 {p0['w']/p0['h']:.3f}:1{guess_paper(p0['w'], p0['h'])})"
             + ("" if uniform else "　（各页尺寸不一致，见每页标注）"))
    L.append(f"页数: {n_pages}")

    if opt.target in TARGETS:
        tw, th = TARGETS[opt.target]
        line = (f"{opt.target} 幻灯片 {raw_sc.size(tw)} × {raw_sc.size(th)} {sc.u}　"
                f"（缩放 {sc.k:.4f}×，居中偏移 x+{raw_sc.size(sc.ox)} y+{raw_sc.size(sc.oy)}{sc.u}；"
                f"下面所有坐标已折算完毕，直接用）")
        if abs(p0["w"] / p0["h"] - tw / th) > 0.12:
            line += (f"\n⚠️ 原页面比例 {p0['w']/p0['h']:.3f}:1 与目标 {tw/th:.3f}:1 差得较多，"
                     "等比缩放后会留出大片空白边。如果这是竖版报告转横版幻灯片，"
                     "建议你按内容重新排版，而不是照搬坐标——那样每页会有一半是空的。")
        if not uniform:
            line += "\n⚠️ 本文档各页尺寸不一致，折算系数按第 1 页计算，其它页请按各页自己的尺寸重算。"
        L.append(f"目标版式: {line}")
    else:
        L.append("目标版式: 保持 PDF 原尺寸")

    if meta.get("creator") or meta.get("producer"):
        L.append("生成工具: " + " / ".join(x for x in (meta.get("creator"), meta.get("producer")) if x))
        hint = origin_hint(meta)
        if hint:
            L.append(f"→ {hint}")
    if meta.get("title"):
        L.append(f"文档标题: {meta['title']}")
    if meta.get("author"):
        L.append(f"作者: {meta['author']}")

    if fonts_used:
        top = fonts_used.most_common(14)
        L.append("用到的字体（按字数）: " + "　/　".join(f"{f}({c}字)" for f, c in top)
                 + (f" …共 {len(fonts_used)} 种" if len(fonts_used) > 14 else ""))

    pal: Counter = Counter()
    for pg in pages:
        for s in pg["shapes"]:
            a = max(1.0, (s["dr"]["bbox"][2] - s["dr"]["bbox"][0]) * (s["dr"]["bbox"][3] - s["dr"]["bbox"][1]))
            if s["dr"]["fill"]:
                pal[s["dr"]["fill"]] += a
            if s["dr"]["stroke"]:
                pal[s["dr"]["stroke"]] += a * 0.15
        for b in pg["blocks"]:
            for p in b.paras:
                if p.color:
                    pal[p.color] += (p.x1 - p.x0) * (p.bottom - p.top) * 3
    if pal:
        tot = sum(pal.values()) or 1
        L.append("主色板（按覆盖面积）: "
                 + " ".join(f"{h}({round(v/tot*100)}%)" for h, v in pal.most_common(12)))

    toc = doc.get_toc(simple=True) or []
    if toc:
        L.append("")
        L.append("文档大纲（来自 PDF 书签，可直接当作 PPT 的章节结构）:")
        for lvl, title, pno in toc[:80]:
            L.append("  " * max(0, lvl - 1) + f"- {title}　(第 {pno} 页)")
        if len(toc) > 80:
            L.append(f"  …共 {len(toc)} 条，只列前 80 条")

    # ---- 全局警告 ----
    tot_bad = sum(p["bad"] for p in pages)
    tot_inv = sum(p["invisible"] for p in pages)
    tot_hid = sum(p["hidden_layer"] for p in pages)
    if tot_bad:
        warnings.append(f"有 {tot_bad} 个字形无法确定对应字符（已写成 �）。"
                        "这类字体没有提供可用的编码映射；如果这些位置的文字很重要，"
                        "请在阅读器里选中复制后单独补给 AI。")
    if tot_inv:
        warnings.append(f"跳过了 {tot_inv} 段不可见文字（渲染模式 3）。"
                        "扫描件的 OCR 文字层通常长这样；如果本文件是扫描件，"
                        "说明可见内容其实是图片，需要另行处理。")
    if tot_hid:
        warnings.append(f"跳过了 {tot_hid} 个位于隐藏图层（OCG 关闭）的图形——"
                        "它们在阅读器里也看不见，不属于页面内容。")
    if img_dir:
        warnings.append(f"图片已导出到 {img_dir}/（共 {len(exported)} 张）。"
                        "请连同本文本一起提供给 AI，否则 AI 只知道图的位置，不知道内容。")

    if warnings:
        L.append("")
        L.append("## ⚠️ 转换过程中的已知问题（请连同正文一起读）")
        seen = set()
        for w in warnings:
            if w not in seen:
                seen.add(w)
                L.append(f"- {w}")

    L.append("")
    if opt.preamble:
        L.append(PREAMBLE)
        L.append("")
    L.append("---")
    L.append("")

    # ---- 逐页 ----
    for pi, pg in enumerate(pages, 1):
        L.append(f"## 第 {pi} 页 / 共 {n_pages} 页")
        if not uniform:
            nat = "" if opt.unit == "pt" else f"{round(pg['w'])} × {round(pg['h'])} pt，"
            L.append(f"本页尺寸: {raw_sc.size(pg['w'])} × {raw_sc.size(pg['h'])} {sc.u}　"
                     f"({nat}比例 {pg['w']/pg['h']:.3f}:1{guess_paper(pg['w'], pg['h'])})")
        if pg["rot"]:
            L.append(f"页面旋转: {pg['rot']}°（坐标已按旋转后的视觉方向给出）")
        c = pg["columns"]
        if c["columns"] > 1:
            L.append(f"分栏: {c['columns']} 栏 [推断 置信度{c['confidence']:.2f}]　"
                     f"栏间空隙位于 x≈"
                     + ", ".join(sc.x((g['x0'] + g['x1']) / 2) for g in c["gutters"]) + f" {sc.u}")
        if pg["background"]:
            L.append(f"背景: {pg['background']['dr']['fill'] or '（图案/渐变）'}")
        L.append("")

        els = []
        for b in pg["blocks"]:
            els.append((b.seq, "text", b))
        for t in pg["tables"]:
            els.append((t["seq"], "table", t))
        for ch in pg["charts"]:
            els.append((min((s["dr"]["seq"] for s in pg["shapes"] if id(s["dr"]) in ch["members"]), default=0),
                        "chart", ch))
        for im in pg["images"]:
            els.append((im["seq"], "image", im))

        dropped = 0
        min_area = pg["w"] * pg["h"] * 0.00004
        for s in pg["shapes"]:
            if id(s["dr"]) in pg["chart_members"]:
                continue
            bb = s["dr"]["bbox"]
            a = max((bb[2] - bb[0]) * (bb[3] - bb[1]), (bb[2] - bb[0]) + (bb[3] - bb[1]))
            if opt.compact and a < min_area and s["shape"]["type"] not in ("水平线", "垂直线"):
                dropped += 1
                continue
            els.append((s["dr"]["seq"], "shape", s))
        pg["dropped"] = dropped

        els.sort(key=lambda e: e[0])
        for n, (_, kind, v) in enumerate(els, 1):
            if kind == "text":
                emit_text_block(v, n, sc, L, opt.compact)
            elif kind == "table":
                emit_table(v, n, sc, L, opt.compact)
            elif kind == "chart":
                emit_chart(v, n, sc, L)
            elif kind == "shape":
                emit_shape(v, n, sc, L, opt.compact)
            elif kind == "image":
                emit_image(v, n, sc, L, pi)
            L.append("")

        if pg["rotated"]:
            L.append(f"### 旋转/竖排文字（{len(pg['rotated'])} 段，未参与段落归并）")
            for r in pg["rotated"][:30]:
                L.append(f'  · "{r.text}"  {sc.fs(r.size)} {r.font} {r.color or ""}  '
                         f"位置 x={sc.x(r.x0)} y={sc.y(r.top)}{sc.u}")
            if len(pg["rotated"]) > 30:
                L.append(f"  …还有 {len(pg['rotated']) - 30} 段")
            L.append("")

        if pg["annots"]:
            L.append(f"### 注释层（{len(pg['annots'])} 个，画在独立外观流里，不在页面内容流中）")
            for a in pg["annots"][:20]:
                txt = (a["content"] or a["title"] or "").replace("\n", " ")[:120]
                L.append(f"  · {a['type']}  位置 {sc.box(*a['bbox'])}" + (f'  内容 "{txt}"' if txt else ""))
            L.append("")

        if dropped:
            L.append(f"（本页另有 {dropped} 个面积极小的碎路径未列出，多为图标轮廓）")
        L.append(f"（本页共 {len(els)} 个元素"
                 + (f"，含 {len(pg['tables'])} 个表格" if pg["tables"] else "")
                 + (f"，含 {len(pg['charts'])} 处疑似图表" if pg["charts"] else "") + "）")
        L.append("")
        L.append("---")
        L.append("")

    L.append("## 还原自检清单（给 AI）")
    L.append("做完 PPT 后请逐条自查，并把结果告诉用户：")
    L.append("1. 每一页的元素数量对上了吗？有没有整块内容被跳过？")
    L.append("2. 标了「无法确定」和 � 的地方，你是怎么补的？补了什么？")
    L.append("3. 置信度低于 0.6 的推断（表格、图表、分栏），你采纳了还是改了？为什么？")
    L.append("4. 图片位置留出来了吗？还是直接省略了？需要用户提供哪几张图？")
    L.append("5. 页眉页脚你是放进母版、还是每页重复、还是省略了？")
    L.append("6. 如果做了拆页或重排版，说明依据。不要默默改版式。")

    doc.close()
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="把 PDF 转成带位置和格式信息的结构化文本，供 AI 还原成 PPT。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="日常用同目录的 PDF转AI文本.html 即可（零安装）。"
               "这份高保真版用于 HTML 版啃不动的文件，或需要导出图片的场合。",
    )
    ap.add_argument("pdf", nargs="+", type=Path, help="输入的 PDF（可多个）")
    ap.add_argument("-o", "--out", type=Path, help="输出文件（默认与 PDF 同名的 .md）")
    ap.add_argument("--target", choices=["raw", "16:9", "4:3"], default="raw", help="目标版式折算")
    ap.add_argument("--unit", choices=["cm", "pt", "in"], default="cm", help="长度单位")
    ap.add_argument("--no-preamble", dest="preamble", action="store_false", help="不附给 AI 的说明")
    ap.add_argument("--no-compact", dest="compact", action="store_false", help="输出全部细节（体积翻倍）")
    ap.add_argument("--no-merge-para", dest="merge_para", action="store_false", help="不合并行为段落")
    ap.add_argument("--no-columns", dest="columns", action="store_false", help="不做分栏检测")
    ap.add_argument("--no-header-footer", dest="header_footer", action="store_false", help="不识别页眉页脚")
    ap.add_argument("--no-tables", dest="tables", action="store_false", help="不检测表格")
    ap.add_argument("--no-shapes", dest="shapes", action="store_false", help="不提取矢量图形")
    ap.add_argument("--no-charts", dest="charts", action="store_false", help="不做疑似图表分析")
    ap.add_argument("--export-images", metavar="DIR", help="把 PDF 里的图片导出到目录，一并交给 AI")
    ap.add_argument("--render-pages", metavar="DIR", help="额外渲染每页 PNG，供你人工核对")
    opt = ap.parse_args()

    rc = 0
    for p in opt.pdf:
        if not p.exists():
            print(f"找不到文件：{p}", file=sys.stderr)
            rc = 1
            continue
        try:
            text = convert(p, opt)
        except Exception as e:
            print(f"{p.name} 转换失败：{e}", file=sys.stderr)
            rc = 1
            continue
        out = opt.out if (opt.out and len(opt.pdf) == 1) else p.with_suffix(".md")
        out.write_text(text, encoding="utf-8", newline="\n")
        approx = len(text) / 2.2
        print(f"{p.name} → {out}　{len(text):,} 字符 · 约 {approx:,.0f} tokens")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
