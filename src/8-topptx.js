/* ============================================================
   8-topptx.js —— 结构化文本 → 真 .pptx（反向管线）
   把本工具输出的那套文本重新变回 PowerPoint 文件，闭环：
     PDF/PPT → 结构化文本 → （你让 AI 改内容）→ .pptx

   为什么纯 JS 直接写 pptx，而不调 python-pptx：
   ZIP 允许「存储」模式（method 0，不压缩），PowerPoint 完全接受不压缩的 .pptx。
   于是只要 CRC32 + ZIP 打包（约 30 行）就够，不需要实现 deflate 压缩器。
   这保住了整个工具最重要的性质：单文件 HTML、零安装、记事本能传。
   走 Python 的话这个功能就只有 exe 版能用，能传到公司电脑的那份 HTML 就废了一半。

   与解析方向的关系：解析器写在 3~7 号模块，这里是它的逆运算。
   两边共用同一套文本约定，所以可以做「转出去再转回来」的往返回归测试。
   ============================================================ */
const TOPPTX = (function(){
"use strict";

const EMU_CM = 360000, EMU_PT = 12700, EMU_IN = 914400;

/* ==================== 单位 ==================== */
function toEmu(v, unit){
  if (!isFinite(v)) return 0;
  if (unit === "pt") return Math.round(v * EMU_PT);
  if (unit === "in") return Math.round(v * EMU_IN);
  if (unit === "emu") return Math.round(v);
  return Math.round(v * EMU_CM);              // cm
}

/* ==================== 文本解析 ====================
   解析的是「给人看的」格式，不是机器格式。所以要能容忍：
   · 行尾的 "   ← 继承自母版（…）" 说明
   · "  [推断 置信度0.80 —— …]" 标注
   · PDF 版与 PPT 版的措辞差异（页面尺寸/画布尺寸、第N页/幻灯片N、表格两种写法）
   容忍不了的一律记进 warnings，不静默丢。 */

const stripNote = s => String(s).split("   ←")[0].split("  [推断")[0].trim();
const num = s => { const v = parseFloat(s); return isFinite(v) ? v : 0; };

/* 位置: x=72 y=66 宽=162 高=18 pt   [推断 …] */
const RE_POS = /^位置:\s*x=(-?[\d.]+)\s+y=(-?[\d.]+)\s+宽=(-?[\d.]+)\s+高=(-?[\d.]+)\s*(cm|pt|in|EMU)?/;
/* ### [3] 矩形 「名字」 / ### [2] 文本块  阅读顺序 1 / ### [4] 表格  [推断 …] */
const RE_HEAD = /^(\s*)###\s*\[(\d+)\]\s*(.+?)\s*$/;
/* · "文字"  — 18pt 粗体 字体 Helvetica #000000 */
const RE_RUN = /^\s*·\s*"([\s\S]*)"(?:（域[^）]*）)?\s*(?:—\s*(.*))?$/;
const RE_PARA = /^(\s*)段落(\d+)\s*(?:\[([^\]]*)\])?\s*:\s*(.*)$/;

/* 中文形状名 → OOXML prstGeom */
const GEOM2PRST = {
  "矩形": "rect", "正方形": "rect", "形状": "rect", "背景": "rect",
  "圆角矩形": "roundRect", "椭圆": "ellipse", "圆形": "ellipse", "椭圆/圆": "ellipse",
  "三角形": "triangle", "直角三角形": "rtTriangle", "菱形": "diamond",
  "平行四边形": "parallelogram", "梯形": "trapezoid", "六边形": "hexagon",
  "八边形": "octagon", "五角星": "star5", "右箭头": "rightArrow", "左箭头": "leftArrow",
  "上箭头": "upArrow", "下箭头": "downArrow", "左右箭头": "leftRightArrow", "V形": "chevron",
  "五边形箭头": "homePlate", "圆柱": "can", "立方体": "cube", "圆环": "donut",
  "饼形": "pie", "弧形": "arc", "心形": "heart", "闪电": "lightningBolt",
  "太阳": "sun", "月亮": "moon", "笑脸": "smileyFace", "四边形": "rect",
  "5边形": "pentagon", "6边形": "hexagon", "7边形": "heptagon", "8边形": "octagon",
  "复合路径": "rect", "自由形状": "rect", "矩形组": "rect", "曲线": "line", "折线": "line",
  "水平线": "line", "垂直线": "line", "斜线": "line", "连接符": "line", "自定义形状": "rect"
};
const LINE_KINDS = { "水平线": 1, "垂直线": 1, "斜线": 1, "连接符": 1, "折线": 1, "曲线": 1 };

/* 从 "纯色 #1E7A46 (主题色 bg1)" / "#1F6F8B" / "渐变（角度 90°）：0% #A → 100% #B" 里取颜色 */
function parseFillDesc(s){
  if (!s) return null;
  s = stripNote(s);
  if (/^无填充/.test(s)) return { kind: "none" };
  const grad = /^渐变/.test(s);
  const hexes = s.match(/#[0-9A-Fa-f]{6}/g) || [];
  if (grad && hexes.length >= 2){
    const ang = /角度\s*(-?[\d.]+)/.exec(s);
    return { kind: "grad", from: hexes[0].toUpperCase(), to: hexes[hexes.length - 1].toUpperCase(),
             angle: ang ? num(ang[1]) : 90 };
  }
  if (hexes.length) return { kind: "solid", hex: hexes[0].toUpperCase() };
  if (/图案填充|图片填充/.test(s)) return { kind: "unsupported", desc: s };
  return null;
}

/* 边框：PDF 版 "#000000 粗细 0.6pt"；PPT 版 "0.75pt #1B2A3A，实线" */
function parseLineDesc(s){
  if (!s) return null;
  s = stripNote(s);
  if (/^无边框/.test(s)) return { kind: "none" };
  const hex = (s.match(/#[0-9A-Fa-f]{6}/) || [])[0];
  const w = /(?:粗细\s*)?(-?[\d.]+)\s*pt/.exec(s);
  return { kind: "solid", hex: hex ? hex.toUpperCase() : "#000000",
           w: w ? num(w[1]) : 1, dash: /虚线|点线|点划线/.test(s) ? "dash" : null };
}

/* run 格式串： "18pt 粗体 斜体 字体 微软雅黑（MicrosoftYaHei） #1B2A3A" */
function parseRunFmt(s){
  const out = { size: null, bold: false, italic: false, font: null, color: null };
  if (!s) return out;
  s = s.replace(/\s{2,}←[^—]*/g, " ");        // 去掉 "  ← 字号继承自…" 之类的说明
  const sz = /(-?[\d.]+)pt/.exec(s);
  if (sz) out.size = num(sz[1]);
  out.bold = /粗体/.test(s) && !/部分粗体/.test(s);
  out.italic = /斜体/.test(s);
  const col = /#[0-9A-Fa-f]{6}/.exec(s);
  if (col) out.color = col[0].toUpperCase();
  const f = /字体\s+([^#]+?)(?:\s+#|\s*$)/.exec(s);
  if (f) out.font = normFont(f[1]);
  return out;
}

/* "微软雅黑（MicrosoftYaHei-Bold）" → 微软雅黑（中文别名才是 Windows 认的字体名）
   "主要中文字体（主题 +mj-ea）" → null（让它继承主题） */
function normFont(raw){
  let s = String(raw).trim();
  s = s.replace(/\s*西文\s*/, "").split(" / ")[0].trim();
  if (/主题\s*\+m[jn]-/.test(s)) return null;
  const m = /^([^（(]+)[（(]([^）)]*)[）)]\s*$/.exec(s);
  if (m){
    const outer = m[1].trim();
    if (/[一-鿿]/.test(outer)) return outer;   // 中文别名，直接用
    return outer || m[2].trim();
  }
  return s || null;
}

function parse(text){
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const warn = [];
  const model = { unit: "cm", w: 0, h: 0, slides: [], title: null };

  /* ---- 文档头 ---- */
  for (let i = 0; i < Math.min(lines.length, 60); i++){
    const l = lines[i];
    let m = /^#\s*(?:PDF|PPT)\s*结构化描述：\s*(.+)$/.exec(l);
    if (m) model.title = m[1].trim();
    m = /^(?:页面尺寸|画布尺寸|本页尺寸):\s*([\d.]+)\s*×\s*([\d.]+)\s*(cm|pt|in|EMU)/.exec(l);
    if (m && !model.w){ model.w = num(m[1]); model.h = num(m[2]); model.unit = m[3] === "EMU" ? "emu" : m[3]; }
  }
  if (!model.w){
    model.w = 33.867; model.h = 19.05; model.unit = "cm";
    warn.push("文本里读不到画布尺寸，已按 16:9（33.87 × 19.05 cm）生成。如果原稿不是这个比例，请在文首补一行「画布尺寸: W × H cm」。");
  }

  /* ---- 逐行状态机 ----
     容器可能是「某一页」，也可能是「版式库里的某个版式」。
     版式库里的元素不能跳过：它们在每一页上都真实可见。
     但也不能塞进每一页（那正是版式库要避免的重复），
     所以单独收着，生成时做成真正的 slideLayout。 */
  let slide = null, layout = null, shape = null, para = null;
  let inTable = false, inChart = false, inPhList = false;
  model.layouts = [];

  const container = () => slide || layout;
  const pushShape = () => {
    const c = container();
    if (c && shape && shape.keep !== false) c.shapes.push(shape);
    shape = null; para = null;
  };
  const newSlide = label => {
    pushShape(); layout = null;
    slide = { label, bg: null, shapes: [], groups: [], layoutName: null };
    model.slides.push(slide);
  };

  for (let i = 0; i < lines.length; i++){
    const raw = lines[i];
    const l = raw.trim();

    /* 自检清单等收尾段落，不属于内容 */
    if (/^##\s*还原自检清单/.test(l) || /^##\s*⚠️/.test(l)) { pushShape(); slide = layout = null; continue; }
    if (/^##\s*版式库/.test(l)){ pushShape(); slide = null; layout = null; continue; }

    let m;
    if ((m = /^##\s*(?:第\s*(\d+)\s*页|幻灯片\s*(\d+))/.exec(l))){
      newSlide(m[1] || m[2]);
      continue;
    }
    /* ### 版式「名字」（type=obj） */
    if ((m = /^###\s*版式「([^」]*)」/.exec(l))){
      pushShape(); slide = null; inPhList = false;
      layout = { name: m[1], bg: null, shapes: [], groups: [] };
      model.layouts.push(layout);
      continue;
    }
    /* 版式库里的小节标题；「本版式的占位符位置」下面是 "· xxx" 列表，不是形状 */
    if (/^####\s/.test(l)){ pushShape(); inPhList = /占位符位置/.test(l); continue; }
    if (inPhList && /^·/.test(l)) continue;

    if (!container()) continue;

    if ((m = /^使用版式:\s*「([^」]*)」/.exec(l))){ if (slide) slide.layoutName = m[1]; continue; }
    if (/^使用版式:/.test(l)) continue;
    if ((m = /^被这些幻灯片使用:/.exec(l))) continue;

    if ((m = /^背景:\s*(.+)$/.exec(l))){ container().bg = parseFillDesc(m[1]); continue; }

    /* ---- 元素头 ---- */
    if ((m = RE_HEAD.exec(raw))){
      pushShape();
      const indent = m[1].length;
      let title = m[3];
      inTable = inChart = false;
      const nameM = /「([^」]*)」/.exec(title);
      const name = nameM ? nameM[1] : "";
      const kindRaw = stripNote(title.replace(/「[^」]*」/, "")).replace(/\s{2,}.*$/, "").trim();

      shape = { indent, name, kindRaw, box: null, fill: null, line: null, rot: 0,
                paras: [], keep: true };

      if (/^文本块/.test(kindRaw)) shape.type = "text";
      else if (/^表格/.test(kindRaw)){ shape.type = "table"; shape.rows = []; inTable = true; }
      else if (/^图片/.test(kindRaw)) shape.type = "image";
      else if (/^疑似图表/.test(kindRaw)){ shape.type = "chart"; shape.bars = []; shape.guess = kindRaw; inChart = true; }
      else if (/^组合/.test(kindRaw)){ shape.type = "group"; shape.keep = false; slide.groups.push(shape); }
      else if (/^渐变填充区域/.test(kindRaw)) shape.type = "shape";
      else shape.type = "shape";
      continue;
    }
    if (!shape) continue;

    /* ---- 通用属性 ---- */
    if ((m = RE_POS.exec(l))){
      shape.box = { x: num(m[1]), y: num(m[2]), w: num(m[3]), h: num(m[4]),
                    unit: m[5] ? (m[5] === "EMU" ? "emu" : m[5]) : model.unit };
      const rot = /旋转\s*(-?[\d.]+)\s*°/.exec(l);
      if (rot) shape.rot = num(rot[1]);
      shape.flipH = /水平翻转/.test(l);
      shape.flipV = /垂直翻转/.test(l);
      continue;
    }
    if ((m = /^填充:\s*(.+)$/.exec(l))){ shape.fill = parseFillDesc(m[1]); continue; }
    if ((m = /^边框:\s*(.+)$/.exec(l))){ shape.line = parseLineDesc(m[1]); continue; }
    if ((m = /^子坐标系:\s*原点\s*x=(-?[\d.]+)\s*y=(-?[\d.]+)\s*尺寸\s*(-?[\d.]+)×(-?[\d.]+)/.exec(l))){
      shape.childOrigin = { x: num(m[1]), y: num(m[2]), w: num(m[3]), h: num(m[4]) };
      continue;
    }
    if (/^圆角半径:/.test(l)) continue;

    /* ---- 文本 ---- */
    if ((m = RE_PARA.exec(raw))){
      para = { runs: [], align: null };
      const meta = m[3] || "";
      if (/居中/.test(meta)) para.align = "ctr";
      else if (/右对齐/.test(meta)) para.align = "r";
      else if (/两端对齐/.test(meta)) para.align = "just";
      else if (/左对齐/.test(meta)) para.align = "l";
      shape.paras.push(para);
      const rest = (m[4] || "").trim();
      if (rest && rest !== "（空行）"){
        const rm = RE_RUN.exec("· " + rest);
        if (rm) para.runs.push(Object.assign({ text: rm[1] }, parseRunFmt(rm[2])));
      }
      continue;
    }
    if ((m = RE_RUN.exec(raw))){
      if (!para){ para = { runs: [], align: null }; shape.paras.push(para); }
      const t = m[1];
      if (t === "⏎ 手动换行" || /^⏎/.test(t)) { para.runs.push({ text: "\n", br: true }); continue; }
      para.runs.push(Object.assign({ text: t }, parseRunFmt(m[2])));
      continue;
    }

    /* ---- 表格 ---- */
    if (inTable){
      if ((m = /^(\d+)\s*行\s*×\s*(\d+)\s*列/.exec(l))){ shape.nRows = +m[1]; shape.nCols = +m[2]; continue; }
      if ((m = /^列宽:\s*(.+?)\s*(cm|pt|in|EMU)?$/.exec(l))){
        shape.colW = m[1].split(/\s*[|\/]\s*/).map(num);
        shape.colUnit = m[2] === "EMU" ? "emu" : (m[2] || model.unit);
        continue;
      }
      if ((m = /^行高:\s*(.+?)\s*(cm|pt|in|EMU)?$/.exec(l))){
        shape.rowH = m[1].split(/\s*[|\/]\s*/).map(num);
        shape.rowUnit = m[2] === "EMU" ? "emu" : (m[2] || model.unit);
        continue;
      }
      /* PDF 版：  第1行: "a" | "b" | "c" */
      if ((m = /^第(\d+)行:\s*(.*)$/.exec(l))){
        const cells = (m[2].match(/"([\s\S]*?)"/g) || []).map(s => s.slice(1, -1).replace(/⏎/g, "\n"));
        shape.rows[+m[1] - 1] = cells;
        continue;
      }
      /* PPT 版：  [1,1] "a"   /  [1,2] 横跨 2 列 "b"  /  [2,1] （被合并覆盖） */
      if ((m = /^\[(\d+),(\d+)\]\s*(.*)$/.exec(l))){
        const r = +m[1] - 1, c = +m[2] - 1, rest = m[3];
        const tm = /"([\s\S]*)"\s*$/.exec(rest);
        if (!shape.rows[r]) shape.rows[r] = [];
        shape.rows[r][c] = tm ? tm[1].replace(/⏎/g, "\n") : "";
        continue;
      }
    }

    /* ---- 疑似图表：把每根柱子的几何拿回来，按原样摆成矩形 ---- */
    if (inChart && (m = /^柱(\d+):\s*长度\s*([\d.]+)\S*\s+x=([\d.]+)~([\d.]+)\s*(#[0-9A-Fa-f]{6})?/.exec(l))){
      shape.bars.push({ len: num(m[2]), x0: num(m[3]), x1: num(m[4]), color: m[5] ? m[5].toUpperCase() : null });
      continue;
    }
  }
  pushShape();

  /* ---- 组合：把子元素坐标从组合内部坐标系映射回画布 ---- */
  for (const s of model.slides) applyGroups(s, warn);
  for (const g of model.layouts) applyGroups(g, warn);

  /* ---- 清理与统计 ---- */
  let nText = 0, nShape = 0, nTable = 0, nImg = 0, nChart = 0;
  const clean = c => c.shapes.filter(sh => {
    if (!sh.box) return false;                         // 没位置的画不出来
    const hasText = sh.paras.some(p => p.runs.some(r => r.text && r.text.trim()));
    if (sh.type === "text" && !hasText) return false;
    return true;
  });
  for (const s of model.slides){
    s.shapes = clean(s);
    for (const sh of s.shapes){
      /* PPT 来源里带文字的形状写作「形状 「Title 1」」而不是「文本块」，
         统计时按「有没有文字」算，否则报出来的文本框数是 0，看着像没解析到 */
      const hasText = sh.paras.some(p => p.runs.some(r => r.text && r.text.trim()));
      if (sh.type === "table") nTable++;
      else if (sh.type === "image") nImg++;
      else if (sh.type === "chart") nChart++;
      else if (sh.type === "text" || hasText) nText++;
      else nShape++;
    }
  }
  for (const g of model.layouts) g.shapes = clean(g);
  /* 只保留真的被某一页引用、且有内容的版式 */
  model.layouts = model.layouts.filter(g => g.shapes.length || g.bg);
  if (!model.slides.length) warn.push("没有解析出任何页面。请确认粘贴的是本工具输出的结构化文本（应当有「## 第 N 页」或「## 幻灯片 N」这样的行）。");
  if (nImg) warn.push(`有 ${nImg} 张图片：文本里只有位置和文件名，没有像素。已在对应位置画了带文件名的占位框，请自行替换成真图。`);
  if (nChart) warn.push(`有 ${nChart} 处疑似图表：已按文本里给出的柱子几何摆成矩形（形状与原图一致），不是真正的 PPT 图表对象。需要真图表的话得自己在 PowerPoint 里重建。`);

  model.stats = { text: nText, shape: nShape, table: nTable, image: nImg, chart: nChart };
  model.warnings = warn;
  return model;
}

/* 组合内部坐标系 → 画布坐标。
   OOXML 的真实变换：X = 组合x + (子x − chOffX) × (组合宽 / chExtW) */
function applyGroups(slide, warn){
  if (!slide.groups.length) return;
  for (const g of slide.groups){
    if (!g.box || !g.childOrigin){
      warn.push("有个组合缺少位置或子坐标系信息，它的子元素坐标可能不准。");
      continue;
    }
    const sx = g.childOrigin.w ? g.box.w / g.childOrigin.w : 1;
    const sy = g.childOrigin.h ? g.box.h / g.childOrigin.h : 1;
    for (const sh of slide.shapes){
      if (sh.indent > g.indent && sh.box && !sh.__mapped){
        sh.box.x = g.box.x + (sh.box.x - g.childOrigin.x) * sx;
        sh.box.y = g.box.y + (sh.box.y - g.childOrigin.y) * sy;
        sh.box.w *= sx;
        sh.box.h *= sy;
        sh.__mapped = true;
      }
    }
  }
}

/* ==================== ZIP（存储模式，不压缩） ==================== */
const CRC_TABLE = (function(){
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf){
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function utf8bytes(str){
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  const out = [];
  for (let i = 0; i < str.length; i++){
    let c = str.codePointAt(i);
    if (c > 0xFFFF) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

function zipStore(entries){
  /* entries: [{name, data:Uint8Array}] —— 全部用 method 0（存储），
     不需要 deflate 压缩器，PowerPoint 照样打得开。 */
  const chunks = [], central = [];
  let offset = 0;
  for (const e of entries){
    const nameB = utf8bytes(e.name);
    const crc = crc32(e.data);
    const lh = new Uint8Array(30 + nameB.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);            // version needed
    dv.setUint16(6, 0x0800, true);        // UTF-8 文件名标志
    dv.setUint16(8, 0, true);             // method = stored
    dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true);   // 固定时间戳，保证可复现
    dv.setUint32(14, crc, true);
    dv.setUint32(18, e.data.length, true);
    dv.setUint32(22, e.data.length, true);
    dv.setUint16(26, nameB.length, true);
    dv.setUint16(28, 0, true);
    lh.set(nameB, 30);
    chunks.push(lh, e.data);

    const ch = new Uint8Array(46 + nameB.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameB, 46);
    central.push(ch);
    offset += lh.length + e.data.length;
  }
  let cdLen = 0;
  for (const c of central) cdLen += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, offset, true);

  let total = offset + cdLen + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks){ out.set(c, p); p += c.length; }
  for (const c of central){ out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

/* ==================== OOXML 生成 ==================== */
const esc = s => String(s === undefined || s === null ? "" : s)
  /* 剔掉 XML 里非法的控制字符。必须用 \x 转义写，不能写字面量控制字符：
     Node 直接读源文件没事，但浏览器要先过 HTML 解析器，而 HTML 规范强制
     把 U+0000 换成 U+FFFD，字符类范围就逆序了，整个脚本当场 SyntaxError。 */
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const hex6 = h => String(h || "#000000").replace("#", "").toUpperCase().slice(-6);

function fillXml(f){
  if (!f) return "";
  if (f.kind === "none") return "<a:noFill/>";
  if (f.kind === "solid") return `<a:solidFill><a:srgbClr val="${hex6(f.hex)}"/></a:solidFill>`;
  if (f.kind === "grad")
    return `<a:gradFill rotWithShape="1"><a:gsLst>` +
           `<a:gs pos="0"><a:srgbClr val="${hex6(f.from)}"/></a:gs>` +
           `<a:gs pos="100000"><a:srgbClr val="${hex6(f.to)}"/></a:gs></a:gsLst>` +
           `<a:lin ang="${Math.round((f.angle || 0) * 60000)}" scaled="0"/></a:gradFill>`;
  if (f.kind === "unsupported") return `<a:solidFill><a:srgbClr val="DDDDDD"/></a:solidFill>`;
  return "";
}
function lineXml(l){
  if (!l) return "";
  if (l.kind === "none") return "<a:ln><a:noFill/></a:ln>";
  return `<a:ln w="${Math.max(1, Math.round((l.w || 1) * EMU_PT))}">` +
         `<a:solidFill><a:srgbClr val="${hex6(l.hex)}"/></a:solidFill>` +
         (l.dash ? `<a:prstDash val="dash"/>` : "") + `</a:ln>`;
}

function xfrmXml(box, unit, rot, flipH, flipV){
  const u = box.unit || unit;
  const attrs = [];
  if (rot) attrs.push(`rot="${Math.round(rot * 60000)}"`);
  if (flipH) attrs.push('flipH="1"');
  if (flipV) attrs.push('flipV="1"');
  return `<a:xfrm ${attrs.join(" ")}>` +
         `<a:off x="${toEmu(box.x, u)}" y="${toEmu(box.y, u)}"/>` +
         `<a:ext cx="${Math.max(1, toEmu(box.w, u))}" cy="${Math.max(1, toEmu(box.h, u))}"/></a:xfrm>`;
}

function runXml(r, def){
  const props = [];
  const sz = r.size || (def && def.size);
  if (sz) props.push(`sz="${Math.round(sz * 100)}"`);
  if (r.bold) props.push('b="1"');
  if (r.italic) props.push('i="1"');
  const col = r.color || (def && def.color);
  const font = r.font || (def && def.font);
  let inner = "";
  if (col) inner += `<a:solidFill><a:srgbClr val="${hex6(col)}"/></a:solidFill>`;
  if (font) inner += `<a:latin typeface="${esc(font)}"/><a:ea typeface="${esc(font)}"/><a:cs typeface="${esc(font)}"/>`;
  return `<a:r><a:rPr lang="zh-CN" altLang="en-US" ${props.join(" ")} dirty="0">${inner}</a:rPr>` +
         `<a:t>${esc(r.text)}</a:t></a:r>`;
}

function txBodyXml(shape){
  const paras = shape.paras.length ? shape.paras : [{ runs: [], align: null }];
  const body = paras.map(p => {
    const pPr = p.align ? `<a:pPr algn="${p.align}"/>` : "";
    const runs = p.runs.filter(r => !r.br && r.text !== undefined);
    if (!runs.length) return `<a:p>${pPr}</a:p>`;
    return `<a:p>${pPr}` + runs.map(r => runXml(r, null)).join("") + `</a:p>`;
  }).join("");
  /* 关掉自动缩放、允许换行；不设垂直居中，贴合原稿从上往下排 */
  return `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0">` +
         `<a:noAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody>`;
}

function spXml(id, name, geomPrst, box, unit, fill, line, shape, txBody){
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name || ("Shape" + id))}"/>` +
         `<p:cNvSpPr${txBody ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>` +
         `<p:spPr>${xfrmXml(box, unit, shape && shape.rot, shape && shape.flipH, shape && shape.flipV)}` +
         `<a:prstGeom prst="${geomPrst}"><a:avLst/></a:prstGeom>` +
         (fill || "<a:noFill/>") + (line || "") + `</p:spPr>` +
         (txBody || `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>`) + `</p:sp>`;
}

function tableXml(id, sh, unit){
  const u = sh.box.unit || unit;
  const nCols = sh.nCols || Math.max.apply(null, sh.rows.map(r => (r || []).length).concat([1]));
  const nRows = sh.nRows || sh.rows.length;
  let colW = sh.colW && sh.colW.length === nCols
    ? sh.colW.map(w => toEmu(w, sh.colUnit || u))
    : new Array(nCols).fill(Math.round(toEmu(sh.box.w, u) / nCols));
  let rowH = sh.rowH && sh.rowH.length === nRows
    ? sh.rowH.map(h => toEmu(h, sh.rowUnit || u))
    : new Array(nRows).fill(Math.round(toEmu(sh.box.h, u) / Math.max(1, nRows)));

  const grid = `<a:tblGrid>` + colW.map(w => `<a:gridCol w="${Math.max(1, w)}"/>`).join("") + `</a:tblGrid>`;
  const rows = [];
  for (let r = 0; r < nRows; r++){
    const cells = [];
    for (let c = 0; c < nCols; c++){
      const txt = (sh.rows[r] && sh.rows[r][c]) || "";
      const paras = String(txt).split("\n").map(t =>
        `<a:p><a:r><a:rPr lang="zh-CN" sz="1200" dirty="0"/><a:t>${esc(t)}</a:t></a:r></a:p>`).join("");
      cells.push(`<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paras}</a:txBody><a:tcPr/></a:tc>`);
    }
    rows.push(`<a:tr h="${Math.max(1, rowH[r] || 200000)}">${cells.join("")}</a:tr>`);
  }
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(sh.name || "Table")}"/>` +
         `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
         `<p:xfrm><a:off x="${toEmu(sh.box.x, u)}" y="${toEmu(sh.box.y, u)}"/>` +
         `<a:ext cx="${toEmu(sh.box.w, u)}" cy="${toEmu(sh.box.h, u)}"/></p:xfrm>` +
         `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
         `<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>` +
         grid + rows.join("") + `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function shapesXml(container, model){
  const unit = model.unit;
  let id = 1;
  const parts = [];
  for (const sh of container.shapes){
    id++;
    if (sh.type === "text"){
      parts.push(spXml(id, sh.name || "TextBox", "rect", sh.box, unit,
                       fillXml(sh.fill) || "<a:noFill/>", lineXml(sh.line), sh, txBodyXml(sh)));
    } else if (sh.type === "table"){
      parts.push(tableXml(id, sh, unit));
    } else if (sh.type === "image"){
      /* 没有像素，只能画个占位框把位置留出来，并把文件名写上 */
      const ph = { paras: [{ align: "ctr", runs: [{ text: "【图片占位】" + (sh.imgFile || sh.name || ""), size: 10, color: "#888888" }] }] };
      parts.push(spXml(id, "ImagePlaceholder", "rect", sh.box, unit,
                       `<a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill>`,
                       `<a:ln w="12700"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill><a:prstDash val="dash"/></a:ln>`,
                       sh, txBodyXml(ph)));
    } else if (sh.type === "chart"){
      /* 疑似图表：按文本里给出的柱子几何原样摆矩形，形状与原图一致 */
      if (sh.bars && sh.bars.length){
        const u = sh.box.unit || unit;
        const base = sh.box.y + sh.box.h;
        for (const b of sh.bars){
          id++;
          const box = { x: b.x0, y: base - b.len, w: Math.max(0.01, b.x1 - b.x0), h: b.len, unit: u };
          parts.push(spXml(id, "Bar", "rect", box, unit,
                           `<a:solidFill><a:srgbClr val="${hex6(b.color || "#4F81BD")}"/></a:solidFill>`, "", null, null));
        }
      } else {
        const ph = { paras: [{ align: "ctr", runs: [{ text: "【" + (sh.guess || "疑似图表") + "】文本里没有可用几何", size: 10, color: "#888888" }] }] };
        parts.push(spXml(id, "ChartPlaceholder", "rect", sh.box, unit,
                         `<a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill>`,
                         `<a:ln><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill><a:prstDash val="dash"/></a:ln>`,
                         sh, txBodyXml(ph)));
      }
    } else {
      const prst = GEOM2PRST[sh.kindRaw] || "rect";
      const isLine = LINE_KINDS[sh.kindRaw];
      let ln = lineXml(sh.line);
      if (isLine && !ln) ln = lineXml({ kind: "solid", hex: (sh.fill && sh.fill.hex) || "#000000", w: Math.max(0.5, Math.min(sh.box.w, sh.box.h)) });
      const fl = isLine ? "<a:noFill/>" : (fillXml(sh.fill) || "<a:noFill/>");
      const box = isLine
        ? { x: sh.box.x, y: sh.box.y + (sh.box.h > sh.box.w ? 0 : sh.box.h / 2),
            w: sh.box.h > sh.box.w ? 0 : sh.box.w, h: sh.box.h > sh.box.w ? sh.box.h : 0, unit: sh.box.unit }
        : sh.box;
      parts.push(spXml(id, sh.name, prst, box, unit, fl, ln, sh,
                       sh.paras.length ? txBodyXml(sh) : null));
    }
  }

  return parts.join("");
}

const SPTREE_HEAD = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
const NSDECL = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const bgXml = c => (c.bg && c.bg.kind !== "none")
  ? `<p:bg><p:bgPr>${fillXml(c.bg)}<a:effectLst/></p:bgPr></p:bg>` : "";

function slideXml(slide, model){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NSDECL}><p:cSld>${bgXml(slide)}${SPTREE_HEAD}${shapesXml(slide, model)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/* 版式：模板元素做成真正的 slideLayout，而不是塞进每一页。
   PowerPoint 会把版式上的非占位符形状渲染到每张用它的幻灯片上 ——
   视觉与原文件一致，而且只定义一次。 */
function layoutXml(lay, model){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NSDECL} type="blank" preserve="1"><p:cSld name="${esc(lay.name || "空白")}">${bgXml(lay)}${SPTREE_HEAD}${shapesXml(lay, model)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

/* ---------- 固定骨架 ---------- */
const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><!--LAYOUTIDS--></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;


function build(model){
  const n = model.slides.length;
  const cx = toEmu(model.w, model.unit), cy = toEmu(model.h, model.unit);
  const files = [];
  const add = (name, str) => files.push({ name, data: utf8bytes(str) });

  /* 没有版式库时也要有一个空白版式 —— OOXML 要求母版至少挂一个 */
  const layouts = (model.layouts && model.layouts.length)
    ? model.layouts : [{ name: "空白", shapes: [], bg: null }];
  const layoutIndexOf = slide => {
    if (!model.layouts || !model.layouts.length) return 0;
    for (let i = 0; i < model.layouts.length; i++)
      if (model.layouts[i].name === slide.layoutName) return i;
    return 0;
  };

  const slideOverrides = model.slides.map((_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const layoutOverrides = layouts.map((_, i) =>
    `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`).join("");

  add("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>${layoutOverrides}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);

  add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);

  const sldIds = model.slides.map((_, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  add("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="${cy}" cy="${cx}"/></p:presentation>`);

  const presRels = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`]
    .concat(model.slides.map((_, i) =>
      `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`))
    .concat([`<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`]);
  add("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels.join("")}</Relationships>`);

  add("ppt/theme/theme1.xml", THEME_XML);

  const layoutIds = layouts.map((_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`).join("");
  add("ppt/slideMasters/slideMaster1.xml", MASTER_XML.replace("<!--LAYOUTIDS-->", layoutIds));
  const masterRels = layouts.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${i + 1}.xml"/>`)
    .concat([`<Relationship Id="rId${layouts.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>`]);
  add("ppt/slideMasters/_rels/slideMaster1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${masterRels.join("")}</Relationships>`);

  layouts.forEach((lay, i) => {
    add(`ppt/slideLayouts/slideLayout${i + 1}.xml`, layoutXml(lay, model));
    add(`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  });

  model.slides.forEach((s, i) => {
    add(`ppt/slides/slide${i + 1}.xml`, slideXml(s, model));
    add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${layoutIndexOf(s) + 1}.xml"/></Relationships>`);
  });

  const title = esc(model.title || "由结构化文本生成");
  add("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${title}</dc:title><cp:revision>1</cp:revision></cp:coreProperties>`);
  add("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>文档转AI文本</Application><Slides>${n}</Slides></Properties>`);

  return zipStore(files);
}

function convert(text){
  const model = parse(text);
  if (!model.slides.length) throw new Error(model.warnings[0] || "没有解析出任何页面");
  return { bytes: build(model), model: model };
}

return { parse, build, convert, zipStore, crc32, toEmu, normFont, parseFillDesc, parseLineDesc, parseRunFmt };
})();
