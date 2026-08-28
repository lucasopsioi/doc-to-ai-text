#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 exe 图标（.ico），不依赖 PIL。

为什么自己写：PIL 不一定装，而且知识库记过它的坑
（`imgs[0].save(sizes=...)` 是拿基图缩放，用 16×16 当基图出来的 ico 全糊）。
这里每个尺寸都独立渲染成 PNG 再塞进 ICO 容器，不存在基图方向问题。
Vista 以后的 Windows 支持 ICO 里直接放 PNG。

图案：品牌色圆角方块 + 白色文档 + 右下角转换箭头。
纯几何绘制，4 倍超采样做抗锯齿，不需要字体。
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ACCENT = (31, 111, 139)      # #1F6F8B，和界面主色一致
PAPER = (255, 255, 255)
INK = (31, 111, 139)
ARROW = (255, 209, 102)

SS = 4                        # 超采样倍数


def _rounded_rect(x, y, w, h, r, px, py):
    """点 (px,py) 是否落在圆角矩形内。"""
    if px < x or py < y or px >= x + w or py >= y + h:
        return False
    for cx, cy in ((x + r, y + r), (x + w - r, y + r), (x + r, y + h - r), (x + w - r, y + h - r)):
        if ((px < x + r and cx == x + r) or (px > x + w - r and cx == x + w - r)) and \
           ((py < y + r and cy == y + r) or (py > y + h - r and cy == y + h - r)):
            return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return True


def _render(size: int) -> bytes:
    """渲染成 RGBA 字节。"""
    n = size * SS
    S = float(n)
    buf = bytearray(n * n * 4)

    # 版面（按 1.0 归一化后乘 S）
    doc_x, doc_y, doc_w, doc_h = 0.22 * S, 0.14 * S, 0.50 * S, 0.66 * S
    fold = 0.16 * S
    line_x0, line_x1 = doc_x + 0.06 * S, doc_x + doc_w - 0.06 * S
    lines_y = [0.34 * S, 0.44 * S, 0.54 * S, 0.64 * S]
    line_h = 0.035 * S

    for py in range(n):
        for px in range(n):
            x, y = px + 0.5, py + 0.5
            col = None

            # 底板
            if _rounded_rect(0.03 * S, 0.03 * S, 0.94 * S, 0.94 * S, 0.20 * S, x, y):
                col = ACCENT

            # 文档主体（右上角切掉一个三角形做折角）
            if doc_x <= x < doc_x + doc_w and doc_y <= y < doc_y + doc_h:
                in_fold = (x - (doc_x + doc_w - fold)) + (doc_y + fold - y) > 0
                if not in_fold:
                    col = PAPER

            # 折角的小三角（浅一点，制造层次）
            if (doc_x + doc_w - fold) <= x < doc_x + doc_w and doc_y <= y < doc_y + fold:
                if (x - (doc_x + doc_w - fold)) + (doc_y + fold - y) > 0:
                    if (x - (doc_x + doc_w - fold)) <= (y - doc_y):
                        col = (205, 224, 232)

            # 文本行
            for ly in lines_y:
                w_ratio = 1.0 if ly != lines_y[-1] else 0.55
                if ly <= y < ly + line_h and line_x0 <= x < line_x0 + (line_x1 - line_x0) * w_ratio:
                    col = INK

            # 右下角转换箭头（一根横杆 + 一个三角头）
            ax0, ay = 0.50 * S, 0.795 * S
            bar_h, head = 0.075 * S, 0.11 * S
            if ax0 <= x < 0.80 * S and ay <= y < ay + bar_h:
                col = ARROW
            if 0.78 * S <= x < 0.78 * S + head:
                dy = abs(y - (ay + bar_h / 2))
                if dy <= (head - (x - 0.78 * S)) * 0.85:
                    col = ARROW

            if col is not None:
                i = (py * n + px) * 4
                buf[i:i + 4] = bytes((col[0], col[1], col[2], 255))

    # 降采样（盒式滤波），顺带得到抗锯齿的 alpha
    out = bytearray(size * size * 4)
    for oy in range(size):
        for ox in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    i = (((oy * SS + sy) * n) + (ox * SS + sx)) * 4
                    al = buf[i + 3]
                    r += buf[i] * al
                    g += buf[i + 1] * al
                    b += buf[i + 2] * al
                    a += al
            j = (oy * size + ox) * 4
            if a:
                out[j] = r // a
                out[j + 1] = g // a
                out[j + 2] = b // a
                out[j + 3] = a // (SS * SS)
            else:
                out[j + 3] = 0
    return bytes(out)


def _png(rgba: bytes, size: int) -> bytes:
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def build_ico(dest: Path, sizes=(16, 24, 32, 48, 64, 128, 256)) -> Path:
    pngs = [(s, _png(_render(s), s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, blobs = b"", b""
    for s, data in pngs:
        entries += struct.pack("<BBBBHHII",
                               0 if s >= 256 else s, 0 if s >= 256 else s,
                               0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    dest.write_bytes(header + entries + blobs)
    return dest


if __name__ == "__main__":
    p = build_ico(Path(__file__).with_name("icon.ico"))
    print(f"已生成 {p.name}  ({p.stat().st_size / 1024:.1f} KB, {len(p.read_bytes())} 字节)")
