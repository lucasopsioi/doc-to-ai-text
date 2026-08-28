#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
造一份带真实 Outlook 特征的 .mht 夹具，用于回归。

刻意埋进去的坑（都是 Outlook 真会产生的东西）：
  · multipart/related + 边界
  · 正文 quoted-printable + gb2312（中文必须解对）
  · RFC 2047 编码过的 Subject
  · <!--[if mso]> 条件注释（内容不该出现在正文里）
  · <!--[if !mso]><!--> downlevel-revealed（内容【必须】保留 —— 这条最容易搞反）
  · <o:p></o:p>、VML <v:shape>
  · cid: 内嵌图（要能解出来）
  · http:// 追踪像素（【必须】被掐断，且清洗后全文不许残留 http）
  · onclick 事件属性、<script>
  · 一张真数据表 + 一层版面表格（版面表格不该被当成数据表）
"""
import base64
import quopri
import zlib
import struct
from pathlib import Path

OUT = Path(__file__).resolve().parent / "fixtures" / "outlook.mht"
OUT.parent.mkdir(parents=True, exist_ok=True)


def tiny_png(w=120, h=60, rgb=(31, 111, 139)) -> bytes:
    raw = b""
    for _ in range(h):
        raw += b"\x00" + bytes(rgb) * w

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


HTML = """<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta http-equiv="Content-Type" content="text/html; charset=gb2312">
<style>.MsoNormal{margin:0}</style>
<script>alert('这段脚本必须被移除')</script>
</head>
<body lang=ZH-CN style="background:#FFFFFF">
<!--[if mso]>
<p>MSOONLY_不该出现在正文</p>
<![endif]-->
<!--[if !mso]><!-->
<p class=MsoNormal style="font-size:11pt;color:#1B2A3A">KEEPME_非Outlook才显示的内容<o:p></o:p></p>
<!--<![endif]-->

<table width="900" cellpadding="0" cellspacing="0" border="0">
 <tr><td style="background:#1F6F8B;padding:12px">
   <span style="font-size:20pt;font-weight:bold;color:#FFFFFF">拉美竞品周报</span><o:p></o:p>
 </td></tr>
 <tr><td style="padding:14px">
   <p style="font-size:11pt;color:#333333">本周巴西手机市场出现明显分化，<b>三星</b>份额上升。</p>
   <img src="cid:logo001" width="120" height="60" alt="公司标志">
   <img src="http://track.example.com/open.gif?uid=12345" width="1" height="1" alt="">
   <img src="https://cdn.example.com/banner.png" width="600" height="120" alt="促销横幅">
   <v:shape id="_x0000_s1026" style="width:10pt;height:10pt"><v:imagedata src="x.wmz"/></v:shape>
   <table border="1" cellpadding="4" style="border-collapse:collapse;font-size:10pt">
     <tr><th>品牌</th><th>销量</th><th>份额</th></tr>
     <tr><td>Samsung</td><td>4570k</td><td>31%</td></tr>
     <tr><td>Acme</td><td>26</td><td>0.1%</td></tr>
   </table>
   <p style="font-size:9pt;color:#6B7280" onclick="alert('必须移除')">
     <a href="https://example.com/more">查看详情</a>
   </p>
 </td></tr>
</table>
</body></html>
"""


def build() -> bytes:
    b = "----=_NextPart_000_ABCD_01D9"
    png = tiny_png()

    body_qp = quopri.encodestring(HTML.encode("gb2312")).decode("ascii")
    subj = "=?gb2312?B?" + base64.b64encode("拉美竞品周报 第32周".encode("gb2312")).decode() + "?="

    parts = []
    parts.append(
        "From: =?utf-8?B?" + base64.b64encode("张伟".encode()).decode() + "?= <zhang@example.com>\r\n"
        "To: lucas@example.com\r\n"
        "Subject: " + subj + "\r\n"
        "Date: Thu, 14 Aug 2026 09:12:33 +0800\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: multipart/related; boundary="' + b + '"; type="text/html"\r\n'
        "X-MimeOLE: Produced By Microsoft MimeOLE V16.0\r\n"
        "\r\n"
        "This is a multi-part message in MIME format.\r\n"
        "\r\n"
    )
    parts.append(
        "--" + b + "\r\n"
        "Content-Type: text/html; charset=gb2312\r\n"
        "Content-Transfer-Encoding: quoted-printable\r\n"
        "Content-Location: file:///C:/mail/message.htm\r\n"
        "\r\n" + body_qp + "\r\n"
    )
    parts.append(
        "--" + b + "\r\n"
        "Content-Type: image/png\r\n"
        "Content-Transfer-Encoding: base64\r\n"
        "Content-ID: <logo001>\r\n"
        "Content-Location: file:///C:/mail/image001.png\r\n"
        "\r\n" + "\r\n".join(
            base64.b64encode(png).decode()[i:i + 76]
            for i in range(0, len(base64.b64encode(png).decode()), 76)) + "\r\n"
    )
    parts.append("--" + b + "--\r\n")
    return "".join(parts).encode("latin-1")


if __name__ == "__main__":
    data = build()
    OUT.write_bytes(data)
    print(f"已生成 {OUT}  ({len(data)/1024:.1f} KB)")
