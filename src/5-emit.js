/* ============================================================
   5-emit.js —— 输出层
   把重建出来的结构写成给 AI 读的文本。
   这是唯一会离开这台机器的东西，也是决定还原质量的地方。
   ============================================================ */

let UNIT = "cm", COMPACT = true, TARGET = "raw";
let SX = 1, SY = 1, OX = 0, OY = 0;      // 目标版式折算

const PT_CM = 2.54 / 72, PT_IN = 1 / 72;
function cv(pt){
  const v = pt * SX;
  if (UNIT === "pt") return round(v, 1);
  if (UNIT === "in") return round(v * PT_IN, 3);
  return round(v * PT_CM, 2);
}
function cvY(pt){
  const v = pt * SY;
  if (UNIT === "pt") return round(v, 1);
  if (UNIT === "in") return round(v * PT_IN, 3);
  return round(v * PT_CM, 2);
}
function round(v, n){
  const r = Math.round(v * Math.pow(10, n)) / Math.pow(10, n);
  return String(r);
}
const U = () => UNIT === "pt" ? "pt" : UNIT === "in" ? "in" : "cm";

/* 位置串：x/y 加偏移，宽高不加 */
function pos(x0, y0, x1, y1){
  const X = pt => { const v = pt * SX + OX; return UNIT === "pt" ? round(v,1) : UNIT === "in" ? round(v*PT_IN,3) : round(v*PT_CM,2); };
  const Y = pt => { const v = pt * SY + OY; return UNIT === "pt" ? round(v,1) : UNIT === "in" ? round(v*PT_IN,3) : round(v*PT_CM,2); };
  return `x=${X(x0)} y=${Y(y0)} 宽=${cv(x1 - x0)} 高=${cvY(y1 - y0)} ${U()}`;
}
const conf = c => c === undefined || c === null ? "" : ` [推断 置信度${c.toFixed(2)}]`;

/* ---------- 字号：视觉磅值（已含所有缩放） ---------- */
const fsz = s => round(s * SX, 1) + "pt";

/* ---------- 颜色出现频次 -> 主色板 ---------- */
function palette(pages){
  const tally = new Map();
  const bump = (hex, weight) => { if (!hex) return; tally.set(hex, (tally.get(hex) || 0) + weight); };
  for (const pg of pages){
    for (const s of pg.shapes){
      const a = Math.max(1, (s.item.bbox[2]-s.item.bbox[0]) * (s.item.bbox[3]-s.item.bbox[1]));
      bump(s.item.fill, a);
      bump(s.item.stroke, a * 0.15);
    }
    if (pg.background) bump(pg.background.item.fill, pg.w * pg.h * 0.5);
    for (const b of pg.blocks) for (const p of b.paras)
      bump(p.color, (p.x1 - p.x0) * (p.bottom - p.top) * 3);
  }
  const total = Array.from(tally.values()).reduce((a, b) => a + b, 0) || 1;
  return Array.from(tally.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([hex, w]) => ({ hex, pct: w / total }));
}

/* ---------- 文档大纲（书签） ---------- */
function readOutline(doc){
  const g = v => doc.get(v);
  const out = [];
  try {
    const o = g(doc.catalog.Outlines);
    if (!o) return out;
    const walk = (ref, depth, guard) => {
      let n = g(ref), count = 0;
      while (n && count++ < 500 && depth < 8){
        const t = g(n.Title);
        if (t instanceof PStr) out.push({ depth, title: decodeTextString(t.bytes) });
        if (n.First) walk(n.First, depth + 1, guard);
        if (!n.Next) break;
        n = g(n.Next);
      }
    };
    walk(o.First, 0, new Set());
  } catch (e){}
  return out;
}

/* PDF 文本串可能是 UTF-16BE（带 BOM）或 PDFDocEncoding */
function decodeTextString(b){
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF){
    let s = "";
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF){
    try { return new TextDecoder("utf-8").decode(b.subarray(3)); } catch (e){}
  }
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

/* ---------- 给 AI 的说明 ---------- */
const PREAMBLE = `> 【给 AI 的说明】下面是一份 PDF 的结构化描述，由「PDF 转 AI 文本」工具从 PDF 的原始绘图指令中提取并重建，
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
> · 坐标原点在页面左上角，x 向右、y 向下（PDF 原生原点在左下，工具已翻转）。单位见每行标注。
> · 元素按 [序号] 排列，序号即绘制顺序，也就是 z 轴叠放顺序：序号大的压在上面。
> · 文本块另有「阅读顺序 N」标注，那是给人读的顺序（已处理多栏），与 z 轴序号不是一回事。
> · 颜色写作 #RRGGBB。透明度单独标注。
> · 字号是视觉磅值，已经把所有变换矩阵的缩放折算进去了。
> · 图片只给位置、尺寸和格式，像素内容无法用文本传输，需要你向用户索取。
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
`;

/* ---------- 元素渲染 ---------- */
function emitTextBlock(b, n, L){
  const roleTag = b.role ? `（${b.role}${conf(b.roleConfidence)}）` : "";
  const annot = b.fromAnnot ? `（注释层：${b.fromAnnot}）` : "";
  const order = b.role ? "" : `  阅读顺序 ${b.readIndex}`;
  const colTag = (b.column !== undefined && b.column > 0) ? `  第${b.column + 1}栏` : "";
  L.push(`### [${n}] 文本块${roleTag}${annot}${order}${colTag}`);
  L.push(`位置: ${pos(b.x0, b.top, b.x1, b.bottom)}   [推断 置信度0.80 —— PDF 无文本框概念，此边界由文字外接框反推]`);

  b.paras.forEach((p, pi) => {
    const meta = [];
    if (p.lineGap && p.size) meta.push(`行距 ${(p.lineGap / p.size).toFixed(2)}倍`);
    if (p.lines.length > 1) meta.push(`${p.lines.length} 行`);
    const label = `段落${pi + 1}${meta.length ? " [" + meta.join("，") + "]" : ""}:`;
    L.push(label);

    /* 逐 run 输出。一段里格式有变化就必须拆，紧凑模式也不能省——
       否则 "占 31% 份额" 里的 24pt 和 10pt 会被 median 抹平成 17pt，
       AI 照着建出来的字号全错，而且输出里没有任何迹象提示出过错。 */
    const runs = collectRuns(p);
    if (runs.length > 1 || EMIT_RUNS){
      for (const r of runs) if (r.text) L.push(`  · "${r.text}"  — ${fmtRun(r)}`);
    } else {
      const one = p.lines.length > 1 ? p.flowText : p.text;
      L.push(`  · "${one}"  — ${fmtPara(p)}`);
      if (p.lines.length > 1 && !COMPACT)
        p.lines.forEach((l, i) => L.push(`     行${i + 1} x=${cv(l.x0)} 宽=${cv(l.x1 - l.x0)}${U()}: "${l.text}"`));
    }
    if (p.bad) L.push(`  ⚠️ 本段有 ${p.bad} 个字形无法确定对应字符（已写成 �），字体未提供 ToUnicode 映射`);
  });
}

let EMIT_RUNS = false;

function collectRuns(p){
  const runs = [];
  p.lines.forEach((l, li) => {
    l.parts.forEach((part, i) => {
      /* seps 是 buildLines 自适应补出来的空格，不能丢，否则逐 run 输出会把词粘在一起 */
      const sep = (l.seps && l.seps[i]) || "";
      const key = `${part.fontName}|${Math.round(part.size * 10)}|${part.bold}|${part.italic}|${part.color}`;
      const last = runs[runs.length - 1];
      if (last && last.key === key) last.text += sep + part.text;
      else {
        if (sep && last) last.text += sep;
        runs.push({ key, text: part.text, size: part.size, fontName: part.fontName,
                    bold: part.bold, italic: part.italic, color: part.color, alpha: part.alpha });
      }
    });
    /* 跨行接续：西文之间补空格，中日韩之间不补 */
    if (li < p.lines.length - 1 && runs.length){
      const last = runs[runs.length - 1];
      const nextCh = p.lines[li + 1].text.slice(0, 1);
      if (!isCJK(last.text.slice(-1)) && !isCJK(nextCh) && !/[-\s]$/.test(last.text)) last.text += " ";
    }
  });
  return runs;
}
function fmtRun(r){
  const b = [fsz(r.size)];
  if (r.bold) b.push("粗体");
  if (r.italic) b.push("斜体");
  b.push("字体 " + r.fontName);
  if (r.color) b.push(r.color);
  if (r.alpha !== undefined && r.alpha < 1) b.push(`透明度 ${Math.round((1 - r.alpha) * 100)}%`);
  return b.join(" ");
}
function fmtPara(p){
  const b = [fsz(p.size)];
  if (p.allBold) b.push("粗体");
  else if (p.bold) b.push("部分粗体");
  if (p.italic) b.push("斜体");
  b.push("字体 " + p.fonts.slice(0, 2).join("/"));
  if (p.color) b.push(p.color);
  if (p.colors.length > 1) b.push(`(本段含 ${p.colors.length} 种颜色: ${p.colors.slice(0, 4).join(" ")})`);
  return b.join(" ");
}

function emitTable(t, n, L){
  L.push(`### [${n}] 表格 ${t.ruled ? "" : "（无框线）"}${conf(t.confidence)}`);
  L.push(`位置: ${pos(t.x0, t.y0, t.x1, t.y1)}`);
  L.push(`${t.rows} 行 × ${t.cols} 列　依据: ${t.reason}`);
  if (t.colXs){
    const widths = [];
    for (let i = 0; i < t.colXs.length - 1; i++) widths.push(cv(t.colXs[i + 1] - t.colXs[i]));
    L.push(`列宽: ${widths.join(" | ")} ${U()}`);
  }
  if (t.rowYs){
    const hs = [];
    for (let i = 0; i < t.rowYs.length - 1; i++) hs.push(cvY(t.rowYs[i + 1] - t.rowYs[i]));
    L.push(`行高: ${hs.join(" | ")} ${U()}`);
  }
  t.grid.forEach((row, ri) => {
    const cells = row.map(c => (c.text || "").replace(/\n/g, "⏎"));
    L.push(`  第${ri + 1}行: ${cells.map(c => `"${c}"`).join(" | ")}`);
    if (!COMPACT){
      row.forEach((c, ci) => {
        if (!c.text) return;
        const f = [];
        if (c.size) f.push(fsz(c.size));
        if (c.bold) f.push("粗体");
        if (c.color) f.push(c.color);
        if (c.align) f.push(c.align);
        if (f.length) L.push(`     [${ri + 1},${ci + 1}] ${f.join(" ")}`);
      });
    }
  });
}

function emitChart(c, n, L){
  L.push(`### [${n}] 疑似图表：${c.guess}${conf(c.confidence)}`);
  L.push(`位置: ${pos(c.bbox[0], c.bbox[1], c.bbox[2], c.bbox[3])}`);
  L.push(`识别依据: ${c.reason}`);
  L.push(`⚠️ PDF 里没有图表对象，这是从几何形状反推的。下面给的是原始几何，不是数据。`);
  if (c.colors && c.colors.length) L.push(`配色: ${c.colors.filter(Boolean).join(" ")}`);
  if (c.series && c.series.length && c.series[0].len !== undefined){
    L.push(`各柱几何（按 x 从左到右）:`);
    c.series.forEach((s, i) => {
      L.push(`  柱${i + 1}: 长度 ${cv(s.len)}${U()}  x=${cv(s.x0)}~${cv(s.x1)}  ${s.color || ""}`);
    });
    const lens = c.series.map(s => s.len);
    const mn = Math.min(...lens);
    if (mn > 0) L.push(`  长度比值（若坐标轴从 0 起，这就是数据比值）: ${lens.map(v => (v / mn).toFixed(2)).join(" : ")}`);
    else L.push(`  长度比值: 无法确定（存在零长度柱）`);
  }
  if (c.polyline && c.polyline.length){
    const pts = c.polyline.slice(0, 60);
    L.push(`折线顶点（${c.polyline.length} 个${c.polyline.length > 60 ? "，只列前 60 个" : ""}）:`);
    L.push(`  ${pts.map(p => `(${cv(p[0])},${cvY(p[1])})`).join(" ")}`);
  }
  if (c.center) L.push(`圆心: (${cv(c.center[0])}, ${cvY(c.center[1])}) ${U()}`);
  if (c.labels && c.labels.length){
    L.push(`区域内及周边文字（可能是坐标轴标签/数据标签/图例，工具无法确定归属）:`);
    L.push(`  ${c.labels.slice(0, 40).map(t => `"${t}"`).join("  ")}`);
    if (c.labels.length > 40) L.push(`  …还有 ${c.labels.length - 40} 条未列出`);
  }
}

function emitShape(s, n, L){
  const it = s.item, sh = s.shape;
  L.push(`### [${n}] ${sh.type}${sh.confidence < 0.8 ? conf(sh.confidence) : ""}`);
  L.push(`位置: ${pos(it.bbox[0], it.bbox[1], it.bbox[2], it.bbox[3])}`);
  if (sh.cornerRadius) L.push(`圆角半径: ${cv(sh.cornerRadius)}${U()}`);
  if (it.fill) L.push(`填充: ${it.fill}${it.fillAlpha < 1 ? ` 透明度 ${Math.round((1 - it.fillAlpha) * 100)}%` : ""}`);
  else if (it.fillPattern){
    const p = it.fillPattern;
    if (p.kind === "gradient"){
      L.push(`填充: ${p.typeName}${p.approx ? "（色标为近似值，函数类型未实现精确求值）" : ""}` +
             (p.stops && p.stops.length ? ` 色标 ${p.stops.map(s2 => `${Math.round(s2.t*100)}%→${s2.hex}`).join(" ")}` : ""));
    } else L.push(`填充: ${p.kind === "tiling" ? "图案平铺（无法用文本表达，建议用纯色近似）" : "无法确定"}`);
  }
  else if (!COMPACT) L.push(`填充: 无`);
  if (it.stroke) L.push(`边框: ${it.stroke} 粗细 ${round(it.lineWidth * SX, 2)}pt${it.dash ? " 虚线" : ""}${it.strokeAlpha < 1 ? ` 透明度 ${Math.round((1 - it.strokeAlpha) * 100)}%` : ""}`);
  if (it.blend) L.push(`混合模式: ${it.blend}`);
  if (it.softMask) L.push(`应用了软蒙版（透明度渐变），文本无法完整表达`);
  if (it.fromAnnot) L.push(`来源: 注释层 ${it.fromAnnot}`);
}

function emitImage(im, n, L){
  L.push(`### [${n}] 图片`);
  L.push(`位置: ${pos(im.bbox[0], im.bbox[1], im.bbox[2], im.bbox[3])}`);
  L.push(`像素尺寸: ${im.pixW} × ${im.pixH}　格式: ${im.format}${im.isMask ? "（模板蒙版）" : ""}`);
  if (Math.abs(im.rot) > 1) L.push(`旋转: ${im.rot.toFixed(1)}°`);
  if (im.hasSMask) L.push(`带透明通道`);
  if (im.alpha < 1) L.push(`透明度: ${Math.round((1 - im.alpha) * 100)}%`);
  if (im.fromAnnot) L.push(`来源: 注释层 ${im.fromAnnot}`);
  L.push(`⚠️ 像素内容无法用文本传输。还原时请向用户索取这张图（第 ${im.__page} 页，${im.resName}）。`);
}

/* ---------- 主输出 ---------- */
function buildOutput(fileName, doc, pages, meta, opt){
  UNIT = opt.unit; COMPACT = opt.compact; TARGET = opt.target; EMIT_RUNS = opt.runs;
  SX = SY = 1; OX = OY = 0;

  const L = [];
  const p0 = pages[0] || { w: 612, h: 792 };
  const sizes = new Set(pages.map(p => `${Math.round(p.w)}x${Math.round(p.h)}`));
  const uniform = sizes.size === 1;

  /* 目标版式折算 */
  let targetLine = "保持 PDF 原尺寸";
  if (TARGET !== "raw"){
    const tw = TARGET === "16:9" ? 960 : 720, th = 540;      // pt: 13.333in×7.5in / 10in×7.5in
    const s = Math.min(tw / p0.w, th / p0.h);
    SX = SY = s;
    OX = (tw - p0.w * s) / 2;
    OY = (th - p0.h * s) / 2;
    const fmt = v => UNIT === "pt" ? round(v,1) : UNIT === "in" ? round(v*PT_IN,3) : round(v*PT_CM,2);
    targetLine = `${TARGET} 幻灯片 ${fmt(tw)} × ${fmt(th)} ${U()}　` +
      `（缩放 ${s.toFixed(4)}×，居中偏移 x+${fmt(OX)} y+${fmt(OY)}${U()}；下面所有坐标已折算完毕，直接用）`;
    if (Math.abs(p0.w / p0.h - tw / th) > 0.12)
      targetLine += `\n⚠️ 原页面比例 ${(p0.w/p0.h).toFixed(3)}:1 与目标 ${(tw/th).toFixed(3)}:1 差得较多，等比缩放后会留出大片空白边。` +
                    `如果这是竖版报告转横版幻灯片，建议你按内容重新排版，而不是照搬坐标——那样每页会有一半是空的。`;
    if (!uniform) targetLine += `\n⚠️ 本文档各页尺寸不一致，折算系数按第 1 页计算，其它页请按各页自己的尺寸重算。`;
  }

  /* ---- 文档头 ---- */
  L.push(`# PDF 结构化描述：${fileName}`);
  L.push("");
  const fmtSz = (w, h) => {
    const ratio = `比例 ${(w / h).toFixed(3)}:1${guessPaper(w, h)}`;
    const native = UNIT === "pt" ? "" : `${Math.round(w)} × ${Math.round(h)} pt，`;
    return `${cv(w)} × ${cvY(h)} ${U()}　(${native}${ratio})`;
  };
  SX = SY = 1;                              // 页面尺寸用原值报
  L.push(`页面尺寸: ${fmtSz(p0.w, p0.h)}${uniform ? "" : "　（各页尺寸不一致，见每页标注）"}`);
  L.push(`页数: ${pages.length}`);
  if (TARGET !== "raw"){ const tw = TARGET === "16:9" ? 960 : 720; SX = SY = Math.min(tw / p0.w, 540 / p0.h); }
  L.push(`目标版式: ${targetLine}`);

  if (meta.producer || meta.creator){
    L.push(`生成工具: ${[meta.creator, meta.producer].filter(Boolean).join(" / ")}`);
    const src = originHint(meta);
    if (src) L.push(`→ ${src}`);
  }
  if (meta.title) L.push(`文档标题: ${meta.title}`);
  if (meta.author) L.push(`作者: ${meta.author}`);

  const fonts = Array.from(meta.fonts.values());
  if (fonts.length){
    L.push(`用到的字体: ${fonts.slice(0, 14).map(f => f.describe()).join("　/　")}${fonts.length > 14 ? ` …共 ${fonts.length} 种` : ""}`);
  }
  const pal = palette(pages);
  if (pal.length) L.push(`主色板（按覆盖面积）: ${pal.map(p => `${p.hex}(${Math.round(p.pct * 100)}%)`).join(" ")}`);

  const outline = readOutline(doc);
  if (outline.length){
    L.push("");
    L.push(`文档大纲（来自 PDF 书签，可直接当作 PPT 的章节结构）:`);
    for (const o of outline.slice(0, 80)) L.push(`${"  ".repeat(o.depth)}- ${o.title}`);
    if (outline.length > 80) L.push(`  …共 ${outline.length} 条，只列前 80 条`);
  }

  /* ---- 全局警告 ---- */
  const warns = [];
  for (const w of doc.warnings) warns.push(w);
  const badFonts = fonts.filter(f => f.total > 0 && f.reliability < 0.98);
  if (badFonts.length){
    warns.push(`以下字体没有提供 ToUnicode 映射，部分字形无法确定对应哪个字符（已写成 �，没有拿猜测糊弄）：` +
      badFonts.map(f => `${f.name}(${f.undecodable}/${f.total} 个)`).join("、") +
      `。如果这些位置的文字很重要，请在 PDF 阅读器里选中复制后单独补给 AI。`);
  }
  const totalHidden = pages.reduce((a, p) => a + p.stats.hiddenLayer, 0);
  if (totalHidden) warns.push(`跳过了 ${totalHidden} 个位于隐藏图层（OCG 关闭）的元素——它们在阅读器里也看不见，不属于页面内容。`);
  const totalInv = pages.reduce((a, p) => a + p.stats.invisibleText, 0);
  if (totalInv) warns.push(`跳过了 ${totalInv} 段不可见文字（渲染模式 3）。扫描件的 OCR 文字层通常长这样；如果本文件是扫描件，说明可见内容其实是图片。`);
  const drops = pages.reduce((a, p) => a + (p.droppedShapes || 0), 0);
  if (drops) warns.push(`为控制体积，省略了 ${drops} 个面积极小的碎路径（多为图标轮廓与装饰点）。它们不影响版面结构，但如果某页图标缺失，原因在此。`);

  if (warns.length){
    L.push("");
    L.push("## ⚠️ 转换过程中的已知问题（请连同正文一起读）");
    for (const w of warns) L.push(`- ${w}`);
  }

  L.push("");
  if (opt.preamble){ L.push(PREAMBLE); L.push(""); }
  L.push("---");
  L.push("");

  /* ---- 逐页 ---- */
  pages.forEach((pg, pi) => {
    L.push(`## 第 ${pi + 1} 页 / 共 ${pages.length} 页`);
    if (!uniform) L.push(`本页尺寸: ${fmtSz(pg.w, pg.h)}`);
    if (pg.rot) L.push(`页面旋转: ${pg.rot}°（坐标已按旋转后的视觉方向给出）`);
    if (pg.columns && pg.columns.columns > 1)
      L.push(`分栏: ${pg.columns.columns} 栏${conf(pg.columns.confidence)}　栏间空隙位于 x≈${pg.columns.gutters.map(g => cv((g.x0+g.x1)/2)).join(", ")} ${U()}`);
    if (pg.background) L.push(`背景: ${pg.background.item.fill || "（图案/渐变）"}`);
    L.push("");

    /* 所有元素合成一条按绘制顺序（= z 轴）排的清单 */
    const els = [];
    for (const b of pg.blocks) els.push({ seq: b.seq, t: "text", v: b });
    for (const t of pg.tables) els.push({ seq: tableSeq(t), t: "table", v: t });
    for (const c of pg.charts) els.push({ seq: Math.min(...Array.from(c.members).map(m => m.seq)), t: "chart", v: c });
    for (const im of pg.images){ im.__page = pi + 1; els.push({ seq: im.seq, t: "image", v: im }); }

    /* 形状：过滤碎路径，但必须报出丢了多少 */
    const chartMembers = new Set();
    for (const c of pg.charts) for (const m of c.members) chartMembers.add(m);
    let dropped = 0;
    const minArea = (pg.w * pg.h) * 0.00004;      // 约 A4 上的 2×2 pt
    for (const s of pg.shapes){
      if (s === pg.background) continue;
      if (chartMembers.has(s.item)) continue;
      const a = Math.max(boxW(s.item.bbox) * boxH(s.item.bbox), boxW(s.item.bbox) + boxH(s.item.bbox));
      if (COMPACT && a < minArea && s.shape.type !== "水平线" && s.shape.type !== "垂直线"){ dropped++; continue; }
      els.push({ seq: s.item.seq, t: "shape", v: s });
    }
    pg.droppedShapes = dropped;
    for (const sh of pg.shadings) els.push({ seq: sh.seq, t: "shading", v: sh });

    els.sort((a, b) => a.seq - b.seq);

    let n = 0;
    for (const e of els){
      n++;
      switch (e.t){
        case "text":  emitTextBlock(e.v, n, L); break;
        case "table": emitTable(e.v, n, L); break;
        case "chart": emitChart(e.v, n, L); break;
        case "shape": emitShape(e.v, n, L); break;
        case "image": emitImage(e.v, n, L); break;
        case "shading": {
          const g = e.v.gradient;
          L.push(`### [${n}] 渐变填充区域`);
          L.push(`位置: ${pos(e.v.bbox[0], e.v.bbox[1], e.v.bbox[2], e.v.bbox[3])}`);
          L.push(`${g.typeName}${g.stops && g.stops.length ? ` 色标 ${g.stops.map(s => `${Math.round(s.t*100)}%→${s.hex}`).join(" ")}` : ""}`);
          break;
        }
      }
      L.push("");
    }

    if (pg.rotated && pg.rotated.length){
      L.push(`### 旋转/竖排文字（${pg.rotated.length} 段，未参与段落归并）`);
      for (const r of pg.rotated.slice(0, 30))
        L.push(`  · "${r.text}"  旋转 ${r.rot.toFixed(0)}°  ${fsz(r.size)} ${r.fontName} ${r.color || ""}  位置 x=${cv(r.x0)} y=${cvY(r.y0)}${U()}`);
      if (pg.rotated.length > 30) L.push(`  …还有 ${pg.rotated.length - 30} 段`);
      L.push("");
    }

    if (dropped) L.push(`（本页另有 ${dropped} 个面积极小的碎路径未列出，多为图标轮廓）`);
    L.push(`（本页共 ${n} 个元素${pg.tables.length ? `，含 ${pg.tables.length} 个表格` : ""}${pg.charts.length ? `，含 ${pg.charts.length} 处疑似图表` : ""}）`);
    L.push("");
    L.push("---");
    L.push("");
  });

  /* ---- 收尾清单 ---- */
  L.push("## 还原自检清单（给 AI）");
  L.push("做完 PPT 后请逐条自查，并把结果告诉用户：");
  L.push("1. 每一页的元素数量对上了吗？有没有整块内容被跳过？");
  L.push("2. 标了「无法确定」和 � 的地方，你是怎么补的？补了什么？");
  L.push("3. 置信度低于 0.6 的推断（表格、图表、分栏），你采纳了还是改了？为什么？");
  L.push("4. 图片位置留出来了吗？还是直接省略了？需要用户提供哪几张图？");
  L.push("5. 页眉页脚你是放进母版、还是每页重复、还是省略了？");
  L.push("6. 如果做了拆页或重排版，说明依据。不要默默改版式。");
  return L.join("\n");
}

function tableSeq(t){
  let m = Infinity;
  if (t.usedLines) for (const L of t.usedLines) m = Math.min(m, L.seq);
  return isFinite(m) ? m : 0;
}

function guessPaper(w, h){
  const key = (a, b) => Math.abs(w - a) < 8 && Math.abs(h - b) < 8;
  if (key(595, 842) || key(842, 595)) return "，A4";
  if (key(612, 792) || key(792, 612)) return "，Letter";
  if (key(842, 1191) || key(1191, 842)) return "，A3";
  if (key(720, 540)) return "，4:3 幻灯片";
  if (key(960, 540) || key(720, 405)) return "，16:9 幻灯片";
  const r = w / h;
  if (Math.abs(r - 16/9) < 0.03) return "，16:9 宽屏，很可能原本就是幻灯片";
  if (Math.abs(r - 4/3) < 0.03) return "，4:3，很可能原本就是幻灯片";
  return "";
}

/* ============================================================
   主流程 —— 与运行环境无关，浏览器和 Node 都能跑
   （测试脚本直接调 convertBytes，不需要 DOM）
   ============================================================ */
function readMeta(doc, renderer){
  const g = v => doc.get(v);
  const out = {};
  try {
    const info = g(doc.trailer.Info);
    if (info && typeof info === "object"){
      const s = k => { const v = g(info[k]); return v instanceof PStr ? decodeTextString(v.bytes).trim() : null; };
      out.title = s("Title") || null;
      out.author = s("Author") || null;
      out.subject = s("Subject") || null;
      out.creator = s("Creator") || null;
      out.producer = s("Producer") || null;
    }
  } catch (e){}
  const fm = new Map();
  for (const [, f] of renderer.fontCache)
    if (f) fm.set(f.name + "|" + (f.bold ? "b" : "") + (f.italic ? "i" : ""), f);
  out.fonts = fm;
  return out;
}

async function convertBytes(buf, fileName, opt, onProgress, yieldFn){
  const tick = yieldFn || (() => Promise.resolve());
  if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)){
    const at = indexOfBytes(buf, "%PDF-", 0);
    if (at < 0 || at > 4096) throw new Error("这不像是一个 PDF 文件（找不到 %PDF- 文件头）");
  }

  const doc = new PDFDoc(buf);
  doc.load();

  if (doc.decryptor && doc.decryptor.r >= 5 && doc.decryptor.userPasswordOk === false)
    doc.warn("这份 PDF 设了打开口令，空口令验证未通过。文字很可能解不出来——请先在阅读器里用口令打开并另存为无口令版本再转。");

  const pageList = doc.pages;
  if (!pageList.length) throw new Error("没有找到任何页面。文件可能已损坏，或者不是标准 PDF。");

  const renderer = new Renderer(doc, { annots: opt.annots !== false, keepInvisible: false });
  const analyzed = [];
  for (let i = 0; i < pageList.length; i++){
    if (onProgress) onProgress(i + 1, pageList.length);
    let raw;
    try { raw = renderer.renderPage(pageList[i], i); }
    catch (e){ doc.warn(`第 ${i + 1} 页渲染失败：${e.message}`); raw = { items: [], w: 612, h: 792, rot: 0 }; }
    let pg;
    try { pg = analyzePage(raw, opt); }
    catch (e){
      doc.warn(`第 ${i + 1} 页结构分析失败：${e.message}`);
      pg = { w: raw.w, h: raw.h, rot: raw.rot, lines: [], rotated: [], blocks: [], tables: [],
             charts: [], images: [], shadings: [], shapes: [], background: null,
             rules: { hs: [], vs: [] }, stats: { hiddenLayer: 0, invisibleText: 0, clippedOut: 0 } };
    }
    analyzed.push(pg);
    if (i % 4 === 3) await tick();
  }

  for (const n of renderer.notes) doc.warn(n);
  if (renderer.pendingNoFont)
    doc.warn(`有 ${renderer.pendingNoFont} 段文字所属的字体在资源字典里找不到，这部分文字无法解码，已跳过。`);

  finalizePages(analyzed, opt);
  const meta = readMeta(doc, renderer);
  return { text: buildOutput(fileName, doc, analyzed, meta, opt), doc, pages: analyzed, meta, renderer };
}

function originHint(meta){
  const s = ((meta.creator || "") + " " + (meta.producer || "")).toLowerCase();
  if (/powerpoint|keynote|impress|canva|figma|sketch/.test(s))
    return `这份 PDF 原本就是演示文稿导出的（${/powerpoint/.test(s) ? "PowerPoint" : /keynote/.test(s) ? "Keynote" : /canva/.test(s) ? "Canva" : /figma/.test(s) ? "Figma" : "演示/设计工具"}）。版面可以逐页 1:1 还原成幻灯片，不需要重新排版。`;
  if (/word|wps|pages/.test(s))
    return `这份 PDF 原本是文字处理软件的文档（Word/WPS 类），版面是为纸张排的。转成 PPT 时通常需要重新组织，而不是照搬坐标。`;
  if (/latex|pdftex|xetex|luatex/.test(s))
    return `这份 PDF 由 LaTeX 排版。多为学术/报告版式，正文栏宽固定，转 PPT 需要重新分块。`;
  if (/scan|scanner/.test(s))
    return `生成工具名里带扫描字样，如果正文提取不到文字，说明是扫描件，需要 OCR。`;
  return null;
}
