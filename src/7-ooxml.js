/* ============================================================
   7-ooxml.js —— PPTX / POTX 引擎
   从 OOXML 里提取幻灯片结构。与 PDF 引擎共用输出约定。

   与 PDF 的根本差别（这一点必须让 AI 知道）：
   PPTX 里存的是**语义对象**——"这是一个圆角矩形，填充 #1F6F8B，里面有个段落"。
   所以这条路几乎全是[实测]，不需要像 PDF 那样从几何反推段落和表格。

   整个模块包在 IIFE 里：拼进单文件后与 PDF 引擎同处一个作用域，
   UNIT / COMPACT / color / fill 这些名字两边都有，不隔离会直接撞成语法错误。

   相对原 PPT 工具修掉的缺陷（用户发现的「图层信息没转化」）：
   · 原工具从未读取 slideLayout / slideMaster（全文 grep：slideLayout 0 次）
   · ⇒ 版式和母版上的 logo、色条、装饰线、页脚整层不可见
   · ⇒ 占位符没有位置（PowerPoint 对继承位置的占位符不写 <a:xfrm>）
   · ⇒ 背景几乎总是缺失、占位符文字没有字号
   ============================================================ */
const OOXML = (function(){
"use strict";

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships"
};
const EMU_IN = 914400, EMU_CM = 360000, EMU_PT = 12700;

const GEOM = {
  rect:"矩形", roundRect:"圆角矩形", ellipse:"椭圆/圆", triangle:"三角形",
  diamond:"菱形", parallelogram:"平行四边形", trapezoid:"梯形", hexagon:"六边形",
  octagon:"八边形", star5:"五角星", rightArrow:"右箭头", leftArrow:"左箭头",
  upArrow:"上箭头", downArrow:"下箭头", leftRightArrow:"左右箭头", chevron:"V形",
  homePlate:"五边形箭头", pentagon:"五边形箭头", line:"直线", straightConnector1:"直线连接符",
  bentConnector3:"肘形连接符", curvedConnector3:"曲线连接符", flowChartProcess:"流程图-处理",
  flowChartDecision:"流程图-判定", wedgeRectCallout:"矩形标注", cloudCallout:"云形标注",
  can:"圆柱", cube:"立方体", donut:"圆环", pie:"饼形", arc:"弧形", plaque:"缺角矩形",
  bevel:"棱台", frame:"框架", halfFrame:"半框", corner:"角形", teardrop:"泪滴形",
  snip1Rect:"剪去单角矩形", snip2DiagRect:"剪去对角矩形", round1Rect:"圆角单角矩形",
  round2DiagRect:"圆角对角矩形", round2SameRect:"圆角同侧矩形", noSmoking:"禁止符",
  heart:"心形", lightningBolt:"闪电", sun:"太阳", moon:"月亮", smileyFace:"笑脸",
  blockArc:"弧形块", chord:"弦形", pieWedge:"扇形", rtTriangle:"直角三角形"
};
const ALIGN = { l:"左对齐", ctr:"居中", r:"右对齐", just:"两端对齐", dist:"分散对齐" };
const ANCHOR = { t:"顶端", ctr:"居中", b:"底端", just:"两端", dist:"分散" };
const DASH = { solid:"实线", dot:"点线", dash:"虚线", lgDash:"长虚线", dashDot:"点划线",
               lgDashDot:"长点划线", lgDashDotDot:"长双点划线", sysDash:"系统虚线", sysDot:"系统点线" };
const CHART = { barChart:"柱形图/条形图", bar3DChart:"三维柱形图", lineChart:"折线图",
                line3DChart:"三维折线图", pieChart:"饼图", pie3DChart:"三维饼图",
                doughnutChart:"圆环图", areaChart:"面积图", area3DChart:"三维面积图",
                scatterChart:"散点图", bubbleChart:"气泡图", radarChart:"雷达图",
                stockChart:"股价图", surfaceChart:"曲面图", ofPieChart:"复合饼图" };
/* 占位符类型的中文名 + 归并组（匹配继承时 title 与 ctrTitle 等价） */
const PH_NAME = { title:"标题", ctrTitle:"居中标题", subTitle:"副标题", body:"正文",
                  obj:"内容", tbl:"表格", chart:"图表", clipArt:"剪贴画", dgm:"图示",
                  media:"媒体", pic:"图片", sldNum:"幻灯片编号", dt:"日期", ftr:"页脚",
                  hdr:"页眉", sldImg:"幻灯片图像" };
const PH_GROUP = ph => (ph === "ctrTitle" ? "title" : (ph === "subTitle" || ph === "obj" ||
                        ph === "tbl" || ph === "chart" || ph === "pic" || ph === "media" ||
                        ph === "clipArt" || ph === "dgm") ? "body" : (ph || "body"));

/* ==================== 极简 XML 解析（自写，不依赖 DOMParser） ====================
   为什么不用浏览器的 DOMParser：那样 Node 测试台跑不了这条链路，
   等于 PPTX 引擎永远没有自动化回归。换 ~120 行换整条链路可测。 */
function parseXml(text){
  const root = { local: "#root", ns: null, attrs: {}, children: [], text: "" };
  const stack = [root];
  const nsStack = [{ "": null }];
  let i = 0;
  const n = text.length;

  const decodeEnt = s => s.indexOf("&") < 0 ? s : s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e] || m;
  });

  while (i < n){
    const lt = text.indexOf("<", i);
    if (lt < 0){ break; }
    if (lt > i){
      const t = text.slice(i, lt);
      if (t.trim() || /[^\s]/.test(t)) stack[stack.length - 1].text += decodeEnt(t);
    }
    if (text.startsWith("<!--", lt)){ i = text.indexOf("-->", lt); i = i < 0 ? n : i + 3; continue; }
    if (text.startsWith("<![CDATA[", lt)){
      const e = text.indexOf("]]>", lt);
      stack[stack.length - 1].text += text.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3; continue;
    }
    if (text.startsWith("<?", lt) || text.startsWith("<!", lt)){
      const e = text.indexOf(">", lt); i = e < 0 ? n : e + 1; continue;
    }
    const gt = text.indexOf(">", lt);
    if (gt < 0) break;
    let raw = text.slice(lt + 1, gt);
    const selfClose = raw.endsWith("/");
    if (selfClose) raw = raw.slice(0, -1);

    if (raw[0] === "/"){                                   // 闭合标签
      if (stack.length > 1){ stack.pop(); nsStack.pop(); }
      i = gt + 1; continue;
    }

    /* 标签名 + 属性 */
    const sp = raw.search(/[\s]/);
    const qname = sp < 0 ? raw : raw.slice(0, sp);
    const attrsRaw = sp < 0 ? "" : raw.slice(sp);
    const attrs = {};
    const nsMap = Object.create(nsStack[nsStack.length - 1]);
    const re = /([\w:.\-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(attrsRaw))){
      const k = m[1], v = decodeEnt(m[3] !== undefined ? m[3] : (m[4] || ""));
      if (k === "xmlns") nsMap[""] = v;
      else if (k.startsWith("xmlns:")) nsMap[k.slice(6)] = v;
      else attrs[k] = v;
    }
    const ci = qname.indexOf(":");
    const prefix = ci < 0 ? "" : qname.slice(0, ci);
    const local = ci < 0 ? qname : qname.slice(ci + 1);
    const node = { local, ns: nsMap[prefix] || null, attrs, children: [], text: "", nsMap };
    stack[stack.length - 1].children.push(node);
    if (!selfClose){ stack.push(node); nsStack.push(nsMap); }
    i = gt + 1;
  }
  return root.children[0] || null;
}

/* ---------- XML 小工具 ---------- */
const kids = (el, ns, tag) => el ? el.children.filter(c => c.local === tag && c.ns === ns) : [];
const kid = (el, ns, tag) => kids(el, ns, tag)[0] || null;
function deep(el, ns, tag, out){
  out = out || [];
  if (!el) return out;
  for (const c of el.children){
    if (c.local === tag && c.ns === ns) out.push(c);
    deep(c, ns, tag, out);
  }
  return out;
}
const deep1 = (el, ns, tag) => { const r = deep(el, ns, tag); return r.length ? r[0] : null; };
const attr = (el, n, d) => (el && el.attrs[n] !== undefined) ? el.attrs[n] : d;
/* 带命名空间的属性：r:id / r:embed 在不同文件里前缀可能不同，按值找 */
function attrNS(el, ns, localName, d){
  if (!el) return d;
  for (const k in el.attrs){
    const ci = k.indexOf(":");
    if (ci < 0){ if (k === localName && !ns) return el.attrs[k]; continue; }
    if (k.slice(ci + 1) !== localName) continue;
    const uri = el.nsMap ? el.nsMap[k.slice(0, ci)] : null;
    if (!ns || uri === ns) return el.attrs[k];
  }
  return d;
}
function allText(el){
  return deep(el, NS.a, "t").map(t => t.text).join("");
}

/* ==================== ZIP（复用 1-core.js 的同步 inflate） ==================== */
function unzip(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--){
    if (dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip/pptx 文件（找不到中央目录）");

  let count = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff){          // ZIP64
    const l = eocd - 20;
    if (l >= 0 && dv.getUint32(l, true) === 0x07064b50){
      const z64 = Number(dv.getBigUint64(l + 8, true));
      if (dv.getUint32(z64, true) === 0x06064b50){
        count = Number(dv.getBigUint64(z64 + 32, true));
        cdOff = Number(dv.getBigUint64(z64 + 48, true));
      }
    }
  }

  const files = Object.create(null);
  let p = cdOff;
  for (let i = 0; i < count; i++){
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    const fnLen = dv.getUint16(p + 28, true);
    const exLen = dv.getUint16(p + 30, true);
    const cmLen = dv.getUint16(p + 32, true);
    let lho = dv.getUint32(p + 42, true);
    const nameBytes = u8.subarray(p + 46, p + 46 + fnLen);
    const name = utf8(nameBytes);

    if (csize === 0xffffffff || lho === 0xffffffff){       // ZIP64 扩展字段
      let e = p + 46 + fnLen; const end = e + exLen;
      while (e + 4 <= end){
        const hid = dv.getUint16(e, true), hsz = dv.getUint16(e + 2, true);
        if (hid === 0x0001){
          let q = e + 4;
          if (dv.getUint32(p + 24, true) === 0xffffffff) q += 8;
          if (csize === 0xffffffff){ csize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (lho === 0xffffffff) lho = Number(dv.getBigUint64(q, true));
          break;
        }
        e += 4 + hsz;
      }
    }
    const lfnLen = dv.getUint16(lho + 26, true);
    const lexLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lfnLen + lexLen;
    files[name] = { method, data: u8.subarray(start, start + csize) };
    p += 46 + fnLen + exLen + cmLen;
  }
  return files;
}

function utf8(bytes){
  if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++){
    const b = bytes[i];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xE0){ s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i] & 0x3f)); }
    else if (b < 0xF0){ s += String.fromCharCode(((b & 0xf) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f)); }
    else {
      const cp = ((b & 7) << 18) | ((bytes[++i] & 0x3f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f);
      s += String.fromCodePoint(cp);
    }
  }
  return s;
}

function entryBytes(entry){
  if (!entry) return null;
  if (entry.method === 0) return entry.data;
  if (entry.method !== 8) throw new Error("不支持的压缩方式 " + entry.method);
  return inflateRaw(entry.data);          // ← 复用 1-core.js 的同步 inflate
}
function readXmlPart(files, name){
  try {
    const b = entryBytes(files[name]);
    return b ? parseXml(utf8(b)) : null;
  } catch (e){ return null; }
}

/* 关系里的 Target 有三种写法：绝对 /ppt/... 、相对 ../charts/... 、同级 chart1.xml */
function resolvePart(basePart, target){
  if (!target) return null;
  if (/^https?:/i.test(target)) return null;
  if (target.charAt(0) === "/") return target.slice(1);
  const parts = basePart.substring(0, basePart.lastIndexOf("/")).split("/");
  for (const seg of target.split("/")){
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}
function readRels(files, partName){
  const relPath = partName.replace(/([^/]+)$/, "_rels/$1.rels");
  const doc = readXmlPart(files, relPath);
  const map = Object.create(null);
  if (!doc) return map;
  for (const rel of doc.children){
    const t = attr(rel, "Target");
    map[attr(rel, "Id")] = attr(rel, "TargetMode") === "External" ? t : resolvePart(partName, t);
  }
  return map;
}
function relTargetOfType(files, partName, typeSuffix){
  const relPath = partName.replace(/([^/]+)$/, "_rels/$1.rels");
  const doc = readXmlPart(files, relPath);
  if (!doc) return null;
  for (const rel of doc.children){
    const ty = attr(rel, "Type", "");
    if (ty.endsWith(typeSuffix)) return resolvePart(partName, attr(rel, "Target"));
  }
  return null;
}

/* ==================== 单位 ==================== */
let UNIT_ = "cm";
function len(emu){
  if (emu === null || emu === undefined) return "?";
  const v = Number(emu);
  if (!isFinite(v)) return "?";
  if (UNIT_ === "emu") return String(v);
  if (UNIT_ === "pt") return round(v / EMU_PT, 1);
  if (UNIT_ === "in") return round(v / EMU_IN, 3);
  return round(v / EMU_CM, 2);
}
const U_ = () => UNIT_ === "emu" ? "EMU" : UNIT_ === "in" ? "in" : UNIT_ === "pt" ? "pt" : "cm";
function round(v, n){ const p = Math.pow(10, n); return String(Math.round(v * p) / p); }

/* ==================== 主题：配色 + 字体 ==================== */
let THEME = {}, CLRMAP = {}, FONTS = {};

function hexOf(v){ return "#" + String(v || "000000").toUpperCase().replace(/^#/, "").slice(-6); }
function hsl2rgb(h, s, l){
  const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))))); };
  return [f(0), f(8), f(4)];
}
function rgb2hsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn){
    const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
    h /= 6;
  }
  return [h, s, l];
}
function applyMods(hexStr, mods){
  let r = parseInt(hexStr.slice(1, 3), 16), g = parseInt(hexStr.slice(3, 5), 16), b = parseInt(hexStr.slice(5, 7), 16);
  for (const m of mods){
    if (m.t === "lumMod" || m.t === "lumOff"){
      const hsl = rgb2hsl(r, g, b);
      let l = hsl[2];
      if (m.t === "lumMod") l *= m.v; else l = Math.min(1, l + m.v);
      const c = hsl2rgb(hsl[0], hsl[1], l); r = c[0]; g = c[1]; b = c[2];
    } else if (m.t === "shade"){ r = Math.round(r * m.v); g = Math.round(g * m.v); b = Math.round(b * m.v); }
    else if (m.t === "tint"){
      r = Math.round(r * m.v + 255 * (1 - m.v));
      g = Math.round(g * m.v + 255 * (1 - m.v));
      b = Math.round(b * m.v + 255 * (1 - m.v));
    }
  }
  const h2 = x => { const v = Math.max(0, Math.min(255, x)).toString(16).toUpperCase(); return v.length < 2 ? "0" + v : v; };
  return "#" + h2(r) + h2(g) + h2(b);
}

function color(container){
  if (!container) return null;
  let base = null, label = "", alpha = null;
  const mods = [];
  const srgb = kid(container, NS.a, "srgbClr");
  const schm = kid(container, NS.a, "schemeClr");
  const sysc = kid(container, NS.a, "sysClr");
  const prst = kid(container, NS.a, "prstClr");
  let node = null;

  if (srgb){ base = hexOf(attr(srgb, "val")); node = srgb; }
  else if (schm){
    node = schm;
    const nm = attr(schm, "val");
    const mapped = CLRMAP[nm] || nm;
    base = THEME[mapped] || THEME[nm] || "#000000";
    label = " (主题色 " + nm + (mapped !== nm ? "→" + mapped : "") + ")";
  }
  else if (sysc){ node = sysc; base = hexOf(attr(sysc, "lastClr", "000000")); label = " (系统色 " + attr(sysc, "val") + ")"; }
  else if (prst){ node = prst; base = "#000000"; label = " (预设色 " + attr(prst, "val") + ")"; }
  else return null;

  for (const ch of node.children){
    const v = Number(attr(ch, "val", 0));
    if (ch.local === "alpha") alpha = v / 1000;
    else if (ch.local === "lumMod" || ch.local === "lumOff" || ch.local === "shade" || ch.local === "tint")
      mods.push({ t: ch.local, v: v / 100000 });
  }
  let out = base;
  if (mods.length)
    out = applyMods(base, mods) + "（由 " + base + " 经 " +
          mods.map(m => m.t + " " + Math.round(m.v * 100) + "%").join(" + ") + " 得出）";
  out += label;
  if (alpha !== null && alpha < 100) out += "，不透明度 " + Math.round(alpha) + "%";
  return out;
}

/* ==================== 填充 / 线条 / 效果 / 几何 ==================== */
function fill(spPr){
  if (!spPr) return null;
  if (kid(spPr, NS.a, "noFill")) return "无填充";
  const s = kid(spPr, NS.a, "solidFill");
  if (s) return "纯色 " + color(s);
  const g = kid(spPr, NS.a, "gradFill");
  if (g){
    const stops = deep(g, NS.a, "gs").map(gs => Math.round(Number(attr(gs, "pos", 0)) / 1000) + "% " + color(gs));
    const lin = deep1(g, NS.a, "lin");
    const ang = lin ? Math.round(Number(attr(lin, "ang", 0)) / 60000) + "°" : "";
    return "渐变" + (ang ? "（角度 " + ang + "）" : "") + "：" + stops.join(" → ");
  }
  const b = kid(spPr, NS.a, "blipFill");
  if (b){
    const blip = deep1(b, NS.a, "blip");
    return "图片填充" + (blip ? " (rId " + attrNS(blip, NS.r, "embed", "?") + ")" : "");
  }
  const pat = kid(spPr, NS.a, "pattFill");
  if (pat) return "图案填充 " + attr(pat, "prst", "?") +
    "，前景 " + color(kid(pat, NS.a, "fgClr")) + "，背景 " + color(kid(pat, NS.a, "bgClr"));
  if (kid(spPr, NS.a, "grpFill")) return "继承组合填充";
  return null;
}

function line(spPr){
  const ln = kid(spPr, NS.a, "ln");
  if (!ln) return null;
  if (kid(ln, NS.a, "noFill")) return "无边框";
  const parts = [];
  const w = attr(ln, "w");
  parts.push(w ? round(Number(w) / EMU_PT, 2) + "pt" : "默认粗细");
  const sf = kid(ln, NS.a, "solidFill");
  if (sf) parts.push(color(sf));
  const d = kid(ln, NS.a, "prstDash");
  if (d){ const dv = attr(d, "val", "solid"); parts.push(DASH[dv] || dv); }
  const cap = attr(ln, "cap"); if (cap) parts.push("端点 " + cap);
  const hd = kid(ln, NS.a, "headEnd"), tl = kid(ln, NS.a, "tailEnd");
  if (hd && attr(hd, "type") && attr(hd, "type") !== "none") parts.push("起点箭头 " + attr(hd, "type"));
  if (tl && attr(tl, "type") && attr(tl, "type") !== "none") parts.push("终点箭头 " + attr(tl, "type"));
  return parts.join("，");
}

function effects(spPr){
  const lst = kid(spPr, NS.a, "effectLst");
  if (!lst) return null;
  const out = [];
  for (const e of lst.children){
    if (e.local === "outerShdw"){
      const p = ["外阴影"];
      if (attr(e, "blurRad") !== undefined) p.push("模糊 " + len(attr(e, "blurRad")) + U_());
      if (attr(e, "dist") !== undefined) p.push("距离 " + len(attr(e, "dist")) + U_());
      if (attr(e, "dir") !== undefined) p.push("方向 " + Math.round(Number(attr(e, "dir")) / 60000) + "°");
      const c = color(e); if (c) p.push("颜色 " + c);
      out.push(p.join("，"));
    } else if (e.local === "innerShdw") out.push("内阴影，颜色 " + color(e));
    else if (e.local === "glow") out.push("发光，半径 " + len(attr(e, "rad")) + U_() + "，颜色 " + color(e));
    else if (e.local === "softEdge") out.push("柔化边缘 " + len(attr(e, "rad")) + U_());
    else if (e.local === "reflection") out.push("倒影");
  }
  return out.length ? out.join("；") : null;
}

function xfrmOf(spPr){
  const x = kid(spPr, NS.a, "xfrm");
  if (!x) return null;
  const off = kid(x, NS.a, "off"), ext = kid(x, NS.a, "ext");
  if (!off || !ext) return null;
  return {
    x: Number(attr(off, "x", 0)), y: Number(attr(off, "y", 0)),
    cx: Number(attr(ext, "cx", 0)), cy: Number(attr(ext, "cy", 0)),
    rot: Number(attr(x, "rot", 0)),
    flipH: attr(x, "flipH") === "1", flipV: attr(x, "flipV") === "1"
  };
}
function xfrmStr(t, src){
  if (!t) return null;
  const bits = ["x=" + len(t.x) + " y=" + len(t.y) + " 宽=" + len(t.cx) + " 高=" + len(t.cy) + " " + U_()];
  if (t.rot) bits.push("旋转 " + round(t.rot / 60000, 1) + "°");
  if (t.flipH) bits.push("水平翻转");
  if (t.flipV) bits.push("垂直翻转");
  let s = bits.join("，");
  if (src) s += "   ← 继承自" + src + "（幻灯片上没写死位置，PowerPoint 用的就是这个值）";
  return s;
}

function geomName(spPr){
  const prst = kid(spPr, NS.a, "prstGeom");
  if (prst){
    /* 所有会被拼进输出串的 attr() 都要给默认值，
       否则属性缺失时会打出字面量 undefined —— 真实 PPT 上踩到过一次。 */
    const v = attr(prst, "prst", "rect");
    const adj = deep(prst, NS.a, "gd").map(g => attr(g, "name", "?") + "=" + attr(g, "fmla", "?"));
    return (GEOM[v] || v) + (adj.length ? "（调整值 " + adj.join(" ") + "）" : "");
  }
  if (kid(spPr, NS.a, "custGeom")) return "自定义形状（自由绘制路径）";
  return null;
}

/* ==================== 文字 ==================== */
function resolveTypeface(tf){
  if (!tf) return null;
  if (tf === "+mj-lt") return (FONTS.majorLatin || "主要西文字体") + "（主题 +mj-lt）";
  if (tf === "+mn-lt") return (FONTS.minorLatin || "次要西文字体") + "（主题 +mn-lt）";
  if (tf === "+mj-ea") return (FONTS.majorEA || "主要中文字体") + "（主题 +mj-ea）";
  if (tf === "+mn-ea") return (FONTS.minorEA || "次要中文字体") + "（主题 +mn-ea）";
  return tf;
}

function runFmt(rPr, inherited){
  const p = [];
  const sz = rPr ? attr(rPr, "sz") : null;
  if (sz) p.push(Number(sz) / 100 + "pt");
  else if (inherited && inherited.sz) p.push(inherited.sz / 100 + "pt   ← 字号继承自" + inherited.from);
  if (rPr){
    if (attr(rPr, "b") === "1") p.push("粗体");
    if (attr(rPr, "i") === "1") p.push("斜体");
    const u = attr(rPr, "u"); if (u && u !== "none") p.push("下划线");
    const st = attr(rPr, "strike"); if (st && st !== "noStrike") p.push("删除线");
    const sf = kid(rPr, NS.a, "solidFill"); if (sf) p.push(color(sf));
    const latin = kid(rPr, NS.a, "latin"), ea = kid(rPr, NS.a, "ea");
    const f1 = latin ? resolveTypeface(attr(latin, "typeface")) : null;
    const f2 = ea ? resolveTypeface(attr(ea, "typeface")) : null;
    if (f1 && f2 && f1 !== f2) p.push("字体 西文 " + f1 + " / 中文 " + f2);
    else if (f2) p.push("字体 " + f2);
    else if (f1) p.push("字体 " + f1);
    const spc = attr(rPr, "spc"); if (spc) p.push("字距 " + Number(spc) / 100 + "pt");
    const bl = attr(rPr, "baseline"); if (bl) p.push(Number(bl) > 0 ? "上标" : "下标");
  }
  if (!p.some(s => /字体/.test(s)) && inherited && inherited.font)
    p.push("字体 " + inherited.font + "   ← 继承自" + inherited.from);
  return p.join(" ");
}

function textBody(txBody, pad, inh, out){
  if (!txBody) return;
  const bodyPr = kid(txBody, NS.a, "bodyPr");
  if (bodyPr){
    const b = [];
    const an = attr(bodyPr, "anchor"); if (an) b.push("垂直" + (ANCHOR[an] || an));
    if (attr(bodyPr, "wrap") === "none") b.push("不自动换行");
    const ins = [];
    for (const pair of [["lIns", "左"], ["rIns", "右"], ["tIns", "上"], ["bIns", "下"]]){
      const v = attr(bodyPr, pair[0]);
      if (v !== undefined) ins.push({ label: pair[1], v: Number(v) });
    }
    if (ins.length === 4 && ins.every(i => i.v === ins[0].v)) b.push("四边内边距 " + len(ins[0].v) + U_());
    else for (const i of ins) b.push(i.label + "内边距 " + len(i.v) + U_());
    if (deep1(bodyPr, NS.a, "normAutofit")) b.push("文字自动缩放");
    if (deep1(bodyPr, NS.a, "spAutoFit")) b.push("形状随文字调整");
    const vert = attr(bodyPr, "vert"); if (vert && vert !== "horz") b.push("竖排 " + vert);
    if (b.length) out.push(pad + "文本框设置: " + b.join("，"));
  }

  const paras = kids(txBody, NS.a, "p");
  paras.forEach((p, pi) => {
    const pPr = kid(p, NS.a, "pPr");
    const meta = [];
    let lvl = 0;
    if (pPr){
      const al = attr(pPr, "algn"); if (al) meta.push(ALIGN[al] || al);
      lvl = Number(attr(pPr, "lvl", 0)) || 0;
      if (lvl) meta.push("缩进层级 " + lvl);
      const ln = deep1(pPr, NS.a, "lnSpc");
      if (ln){
        const pct = deep1(ln, NS.a, "spcPct"), pts = deep1(ln, NS.a, "spcPts");
        if (pct) meta.push("行距 " + Math.round(Number(attr(pct, "val")) / 1000) + "%");
        if (pts) meta.push("行距 " + Number(attr(pts, "val")) / 100 + "pt");
      }
      const ptsOf = node => { const q = node ? deep1(node, NS.a, "spcPts") : null; return q ? Number(attr(q, "val")) / 100 + "pt" : null; };
      const vb = ptsOf(deep1(pPr, NS.a, "spcBef")), va = ptsOf(deep1(pPr, NS.a, "spcAft"));
      if (vb) meta.push("段前 " + vb);
      if (va) meta.push("段后 " + va);
      if (kid(pPr, NS.a, "buNone")) meta.push("无项目符号");
      const bc = kid(pPr, NS.a, "buChar"); if (bc) meta.push("项目符号 “" + attr(bc, "char") + "”");
      const ba = kid(pPr, NS.a, "buAutoNum"); if (ba) meta.push("自动编号 " + attr(ba, "type"));
      const mar = attr(pPr, "marL"); if (mar && mar !== "0") meta.push("左缩进 " + len(mar) + U_());
    }
    const lvlInh = inh ? inh(lvl) : null;
    const runs = p.children.filter(c => c.local === "r" || c.local === "br" || c.local === "fld");
    const label = pad + "段落" + (pi + 1) + (meta.length ? " [" + meta.join("，") + "]" : "") + ":";
    if (!runs.length){ out.push(label + " （空行）"); return; }
    out.push(label);
    for (const rn of runs){
      if (rn.local === "br"){ out.push(pad + "  · ⏎ 手动换行"); continue; }
      const t = deep1(rn, NS.a, "t");
      const txt = t ? t.text : "";
      const f = runFmt(kid(rn, NS.a, "rPr"), lvlInh);
      const tag = rn.local === "fld" ? "（域：" + attr(rn, "type", "?") + "）" : "";
      out.push(pad + '  · "' + txt + '"' + tag + (f ? "  — " + f : ""));
    }
  });
}

/* ==================== 表格 / 图表 ==================== */
function tableOf(gf, pad, withCellFmt, compact, out){
  const tbl = deep1(gf, NS.a, "tbl");
  if (!tbl) return false;
  const grid = deep(deep1(tbl, NS.a, "tblGrid"), NS.a, "gridCol");
  const rows = deep(tbl, NS.a, "tr");
  out.push(pad + "表格: " + rows.length + " 行 × " + grid.length + " 列");
  out.push(pad + "列宽: " + grid.map(g => len(attr(g, "w"))).join(" / ") + " " + U_());
  out.push(pad + "行高: " + rows.map(r => len(attr(r, "h"))).join(" / ") + " " + U_());
  let lastFmt = null, lastFont = null;
  rows.forEach((tr, ri) => {
    kids(tr, NS.a, "tc").forEach((tc, ci) => {
      if (attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1"){
        out.push(pad + "  [" + (ri + 1) + "," + (ci + 1) + "] （被合并覆盖）"); return;
      }
      const span = [];
      if (attr(tc, "gridSpan")) span.push("横跨 " + attr(tc, "gridSpan") + " 列");
      if (attr(tc, "rowSpan")) span.push("纵跨 " + attr(tc, "rowSpan") + " 行");
      out.push(pad + "  [" + (ri + 1) + "," + (ci + 1) + "]" + (span.length ? " " + span.join("，") : "") +
               ' "' + allText(tc) + '"');
      if (!withCellFmt) return;
      const tcPr = kid(tc, NS.a, "tcPr");
      if (tcPr){
        const bits = [];
        const f = fill(tcPr); if (f) bits.push("填充 " + f);
        const an = attr(tcPr, "anchor"); if (an) bits.push("垂直" + (ANCHOR[an] || an));
        for (const pair of [["lnL", "左"], ["lnR", "右"], ["lnT", "上"], ["lnB", "下"]]){
          const l = kid(tcPr, NS.a, pair[0]);
          if (!l) continue;
          if (kid(l, NS.a, "noFill")){ bits.push(pair[1] + "边框 无"); continue; }
          const w = attr(l, "w"), c = color(kid(l, NS.a, "solidFill"));
          bits.push(pair[1] + "边框 " + (w ? round(Number(w) / EMU_PT, 2) + "pt" : "") + (c ? " " + c : ""));
        }
        const s = bits.join("；");
        if (s){
          out.push(pad + (compact && s === lastFmt ? "     格式同上格" : "     " + s));
          lastFmt = s;
        }
      }
      const r0 = deep1(tc, NS.a, "r");
      if (r0){
        const f = runFmt(kid(r0, NS.a, "rPr"), null);
        const pPr = deep1(tc, NS.a, "pPr");
        const al = pPr ? attr(pPr, "algn") : null;
        const s = [f, al ? (ALIGN[al] || al) : null].filter(Boolean).join("，");
        if (s && !(compact && s === lastFont)) out.push(pad + "     文字 " + s);
        lastFont = s;
      }
    });
  });
  return true;
}

function chartData(files, rels, rid, pad, out){
  const path = rels[rid];
  if (!path){ out.push(pad + "图表: 找不到图表数据（rId " + rid + "）"); return; }
  const doc = readXmlPart(files, path);
  if (!doc){ out.push(pad + "图表: 无法解析 " + path); return; }
  const plot = deep1(doc, NS.c, "plotArea");
  if (!plot){ out.push(pad + "图表: 无绘图区"); return; }

  for (const t of plot.children){
    if (!/Chart$/.test(t.local)) continue;
    const grouping = deep1(t, NS.c, "grouping");
    const barDir = deep1(t, NS.c, "barDir");
    const extra = [];
    if (barDir) extra.push(attr(barDir, "val") === "bar" ? "水平条" : "垂直柱");
    if (grouping){
      const gv = attr(grouping, "val", "clustered");
      extra.push({ clustered: "簇状", stacked: "堆积", percentStacked: "百分比堆积", standard: "标准" }[gv] || gv);
    }
    out.push(pad + "图表类型: " + (CHART[t.local] || t.local) + (extra.length ? "（" + extra.join("，") + "）" : ""));
    deep(t, NS.c, "ser").forEach((ser, si) => {
      const txEl = deep1(deep1(ser, NS.c, "tx"), NS.c, "v");
      const sname = txEl ? txEl.text : "系列" + (si + 1);
      const spPr = deep1(ser, NS.c, "spPr");
      const f = spPr ? fill(spPr) : null;
      out.push(pad + "  系列「" + sname + "」" + (f ? " 填充 " + f : ""));
      const catRef = deep1(ser, NS.c, "cat");
      const valRef = deep1(ser, NS.c, "val") || deep1(ser, NS.c, "yVal");
      const cats = catRef ? deep(catRef, NS.c, "pt").map(p => { const v = deep1(p, NS.c, "v"); return v ? v.text : ""; }) : [];
      const vals = valRef ? deep(valRef, NS.c, "pt").map(p => { const v = deep1(p, NS.c, "v"); return v ? v.text : ""; }) : [];
      if (si === 0 && cats.length) out.push(pad + "    类别: " + cats.join(" | "));
      if (vals.length) out.push(pad + "    数值: " + vals.join(" | "));
    });
  }
  const legend = deep1(doc, NS.c, "legend");
  if (legend){
    /* <c:legendPos> 允许省略 val，规范默认靠右。
       直接把 attr() 的返回值拼进字符串会打出「图例: undefined」——
       真实 PPT 上实测踩到过。 */
    const pos = deep1(legend, NS.c, "legendPos");
    const pv = pos ? attr(pos, "val", "r") : "r";
    const POS = { r: "右侧", l: "左侧", t: "顶部", b: "底部", tr: "右上" };
    out.push(pad + "图例: " + (POS[pv] || pv));
  } else out.push(pad + "图例: 无");
}

/* ==================== 继承链：幻灯片 → 版式 → 母版 ====================
   这是原工具整个缺失的一层，也是「页面还原出来是空的」的真因。 */
function collectPlaceholders(spTree){
  /* 返回 { byIdx: {}, byType: {} }，值是 {xfrm, txBody, spPr, name} */
  const byIdx = Object.create(null), byType = Object.create(null);
  if (!spTree) return { byIdx, byType };
  const walk = node => {
    for (const el of node.children){
      if (el.local === "sp"){
        const nv = kid(el, NS.p, "nvSpPr");
        const ph = nv ? deep1(nv, NS.p, "ph") : null;
        if (ph){
          const rec = {
            xfrm: xfrmOf(kid(el, NS.p, "spPr")),
            txBody: kid(el, NS.p, "txBody"),
            spPr: kid(el, NS.p, "spPr"),
            type: attr(ph, "type", "body"),
            idx: attr(ph, "idx")
          };
          if (rec.idx !== undefined && byIdx[rec.idx] === undefined) byIdx[rec.idx] = rec;
          const g = PH_GROUP(rec.type);
          if (byType[g] === undefined) byType[g] = rec;
          if (byType[rec.type] === undefined) byType[rec.type] = rec;
        }
      }
      if (el.local === "grpSp") walk(el);
    }
  };
  walk(spTree);
  return { byIdx, byType };
}

/* 沿「版式 → 母版」把所有匹配到的占位符都收集起来。

   ★ 不能找到第一个就返回：默认模板里版式的占位符自己也不写 xfrm，
   它再往上继承母版。只看第一层会得到「匹配上了但没有位置」，
   然后误报成「无法确定」——而那个值在母版上明明有。
   OOXML 的真实语义是**每个属性各自沿链独立解析**：
   位置取第一个写了位置的层级，填充取第一个写了填充的层级，互不相干。 */
function lookupPlaceholderChain(chain, type, idx){
  const hits = [];
  const g = PH_GROUP(type);
  for (const level of chain){
    if (!level) continue;
    let rec = null;
    if (idx !== undefined && level.map.byIdx[idx]) rec = level.map.byIdx[idx];
    else if (level.map.byType[type]) rec = level.map.byType[type];
    else if (level.map.byType[g]) rec = level.map.byType[g];
    if (rec) hits.push({ rec: rec, from: level.name });
  }
  return hits;
}
/* 沿链取第一个非空的属性值 */
function firstFrom(hits, pick){
  for (const h of hits){
    const v = pick(h.rec);
    if (v !== null && v !== undefined) return { v: v, from: h.from };
  }
  return null;
}

/* 从母版 txStyles / 版式或母版占位符的 lstStyle 里取某一级的默认字号与字体 */
function inheritedTextStyle(master, layoutRec, masterRec, phType, lvl){
  const want = "lvl" + (lvl + 1) + "pPr";
  const pick = (lstStyle, from) => {
    if (!lstStyle) return null;
    const node = kid(lstStyle, NS.a, want) || kid(lstStyle, NS.a, "lvl1pPr");
    if (!node) return null;
    const d = kid(node, NS.a, "defRPr");
    if (!d) return null;
    const sz = attr(d, "sz");
    const latin = kid(d, NS.a, "latin"), ea = kid(d, NS.a, "ea");
    const font = ea ? resolveTypeface(attr(ea, "typeface")) : (latin ? resolveTypeface(attr(latin, "typeface")) : null);
    if (!sz && !font) return null;
    return { sz: sz ? Number(sz) : null, font: font, from: from };
  };
  if (layoutRec && layoutRec.txBody){
    const r = pick(kid(layoutRec.txBody, NS.a, "lstStyle"), "版式的占位符");
    if (r) return r;
  }
  if (masterRec && masterRec.txBody){
    const r = pick(kid(masterRec.txBody, NS.a, "lstStyle"), "母版的占位符");
    if (r) return r;
  }
  if (master){
    const ts = deep1(master, NS.p, "txStyles");
    if (ts){
      const g = PH_GROUP(phType);
      const styleEl = g === "title" ? kid(ts, NS.p, "titleStyle")
                    : g === "body" ? kid(ts, NS.p, "bodyStyle")
                    : kid(ts, NS.p, "otherStyle");
      const r = pick(styleEl, "母版文字样式(" + (g === "title" ? "标题" : g === "body" ? "正文" : "其它") + ")");
      if (r) return r;
    }
  }
  return null;
}

/* ==================== 形状递归 ==================== */
function walkShapes(node, ctx, depth, counter, out, opt){
  const pad = "  ".repeat(depth);
  for (const el of node.children){
    const ln = el.local;

    if (ln === "sp" || ln === "cxnSp"){
      const nv = kid(el, NS.p, ln === "sp" ? "nvSpPr" : "nvCxnSpPr");
      const cNv = nv ? kid(nv, NS.p, "cNvPr") : null;
      /* 隐藏形状：原工具照样输出，AI 会把看不见的东西画出来 */
      if (cNv && attr(cNv, "hidden") === "1"){
        if (!opt.compact) out.push(pad + "（跳过 1 个隐藏形状「" + attr(cNv, "name", "") + "」）");
        ctx.hiddenCount++;
        continue;
      }
      const name = cNv ? attr(cNv, "name", "") : "";
      const spPr = kid(el, NS.p, "spPr");
      const txBody = kid(el, NS.p, "txBody");
      const ph = nv ? deep1(nv, NS.p, "ph") : null;

      const hasText = txBody && deep(txBody, NS.a, "t").some(t => t.text.trim());
      if (ph && !hasText && !opt.keepEmpty) continue;
      /* 描述版式/母版时只要装饰形状：占位符会在各页单独描述，这里列出来是重复 */
      if (ph && opt.skipPlaceholders) continue;

      const n = ++counter.n;
      const g = geomName(spPr) || (ln === "cxnSp" ? "连接符" : "形状");
      out.push(pad + "### [" + n + "] " + g + (name ? " 「" + name + "」" : ""));

      let hits = [], phType = null;
      if (ph){
        phType = attr(ph, "type", "body");
        const idx = attr(ph, "idx");
        hits = lookupPlaceholderChain(ctx.chain, phType, idx);
        out.push(pad + "占位符: " + (PH_NAME[phType] || phType) + "（type=" + phType +
                 (idx !== undefined ? " idx=" + idx : "") + "）" +
                 (hits.length ? "　匹配到" + hits.map(h => h.from).join(" → ") : "　⚠️ 版式/母版里找不到对应占位符"));
      }

      /* 位置：幻灯片上没写死就沿继承链找 —— 这正是原工具整层丢失的信息。
         注意要一路找到「真的写了 xfrm 」的那一层，不能在第一个匹配上就停。 */
      let t = xfrmOf(spPr), src = null;
      if (!t){
        const r = firstFrom(hits, rec => rec.xfrm);
        if (r){ t = r.v; src = r.from; }
      }
      const xs = xfrmStr(t, src);
      if (xs) out.push(pad + "位置: " + xs);
      else if (ph) out.push(pad + "位置: 无法确定（幻灯片、版式、母版上都没有写 xfrm）");

      let f = fill(spPr);
      if (!f){
        const r = firstFrom(hits, rec => rec.spPr ? fill(rec.spPr) : null);
        if (r) f = r.v + "   ← 继承自" + r.from;
      }
      if (f && !(opt.compact && f === "无填充")) out.push(pad + "填充: " + f);

      let l = line(spPr);
      if (!l){
        const r = firstFrom(hits, rec => rec.spPr ? line(rec.spPr) : null);
        if (r) l = r.v + "   ← 继承自" + r.from;
      }
      if (l && !(opt.compact && l === "无边框")) out.push(pad + "边框: " + l);

      const e = effects(spPr); if (e) out.push(pad + "效果: " + e);

      /* 纯装饰形状没有文字，紧凑模式下不必打印一行「段落1: （空行）」 */
      if (txBody && (hasText || !opt.compact)){
        const layoutRec = hits.length ? hits[0].rec : null;
        const masterRec = hits.length > 1 ? hits[hits.length - 1].rec : null;
        const inh = lvl => inheritedTextStyle(ctx.master, layoutRec, masterRec, phType, lvl);
        textBody(txBody, pad, ph ? inh : null, out);
      }
      out.push("");
    }

    else if (ln === "pic"){
      const nv = kid(el, NS.p, "nvPicPr");
      const cNv = nv ? kid(nv, NS.p, "cNvPr") : null;
      if (cNv && attr(cNv, "hidden") === "1"){ ctx.hiddenCount++; continue; }
      const spPr = kid(el, NS.p, "spPr");
      const blip = deep1(el, NS.a, "blip");
      const rid = blip ? attrNS(blip, NS.r, "embed", null) : null;
      const src = rid && ctx.rels[rid] ? ctx.rels[rid].split("/").pop() : "未知";
      const n = ++counter.n;
      out.push(pad + "### [" + n + "] 图片 「" + (cNv ? attr(cNv, "name", "") : "") + "」");
      const xs = xfrmStr(xfrmOf(spPr), null); if (xs) out.push(pad + "位置: " + xs);
      out.push(pad + "图片文件: " + src + "  ⚠️ 像素内容无法用文本传输，还原时需另行提供");
      /* 裁剪：原工具没提取，裁过的图会按整图还原 */
      const srcRect = deep1(el, NS.a, "srcRect");
      if (srcRect){
        const c = [];
        for (const k of ["l", "t", "r", "b"]){
          const v = attr(srcRect, k);
          if (v) c.push({ l: "左", t: "上", r: "右", b: "下" }[k] + "裁 " + round(Number(v) / 1000, 1) + "%");
        }
        if (c.length) out.push(pad + "裁剪: " + c.join("，") + "（相对原图的百分比）");
      }
      const l = line(spPr); if (l) out.push(pad + "边框: " + l);
      const e = effects(spPr); if (e) out.push(pad + "效果: " + e);
      const g = geomName(spPr); if (g && g !== "矩形") out.push(pad + "裁剪形状: " + g);
      out.push("");
    }

    else if (ln === "graphicFrame"){
      const nv = kid(el, NS.p, "nvGraphicFramePr");
      const cNv = nv ? kid(nv, NS.p, "cNvPr") : null;
      if (cNv && attr(cNv, "hidden") === "1"){ ctx.hiddenCount++; continue; }
      const x = kid(el, NS.p, "xfrm");
      const n = ++counter.n;
      const off = x ? kid(x, NS.a, "off") : null, ext = x ? kid(x, NS.a, "ext") : null;
      const pos = (off && ext) ? "x=" + len(attr(off, "x")) + " y=" + len(attr(off, "y")) +
                  " 宽=" + len(attr(ext, "cx")) + " 高=" + len(attr(ext, "cy")) + " " + U_() : null;

      if (deep1(el, NS.a, "tbl")){
        out.push(pad + "### [" + n + "] 表格 「" + (cNv ? attr(cNv, "name", "") : "") + "」");
        if (pos) out.push(pad + "位置: " + pos);
        tableOf(el, pad, opt.tableFmt, opt.compact, out);
      } else {
        const chartRef = deep1(el, NS.c, "chart");
        out.push(pad + "### [" + n + "] " + (chartRef ? "图表" : "嵌入对象") + " 「" + (cNv ? attr(cNv, "name", "") : "") + "」");
        if (pos) out.push(pad + "位置: " + pos);
        if (chartRef && opt.charts) chartData(ctx.files, ctx.rels, attrNS(chartRef, NS.r, "id", null), pad, out);
        else if (chartRef) out.push(pad + "（图表数据提取已关闭）");
      }
      out.push("");
    }

    else if (ln === "grpSp"){
      const nv = kid(el, NS.p, "nvGrpSpPr");
      const cNv = nv ? kid(nv, NS.p, "cNvPr") : null;
      if (cNv && attr(cNv, "hidden") === "1"){ ctx.hiddenCount++; continue; }
      const grpSpPr = kid(el, NS.p, "grpSpPr");
      const n = ++counter.n;
      out.push(pad + "### [" + n + "] 组合 「" + (cNv ? attr(cNv, "name", "") : "") + "」（下列子元素坐标为组合内部坐标系）");
      const xs = xfrmStr(xfrmOf(grpSpPr), null); if (xs) out.push(pad + "位置: " + xs);
      const gx = kid(grpSpPr, NS.a, "xfrm");
      const chOff = gx ? kid(gx, NS.a, "chOff") : null, chExt = gx ? kid(gx, NS.a, "chExt") : null;
      if (chOff && chExt)
        out.push(pad + "子坐标系: 原点 x=" + len(attr(chOff, "x")) + " y=" + len(attr(chOff, "y")) +
                 " 尺寸 " + len(attr(chExt, "cx")) + "×" + len(attr(chExt, "cy")) + " " + U_());
      out.push("");
      walkShapes(el, ctx, depth + 1, counter, out, opt);
    }
  }
}

/* ==================== 背景（幻灯片 → 版式 → 母版 回退） ==================== */
function backgroundOf(root){
  const bg = deep1(root, NS.p, "bg");
  if (!bg) return null;
  const bgPr = deep1(bg, NS.p, "bgPr");
  if (bgPr){ const f = fill(bgPr); if (f) return f; }
  const ref = deep1(bg, NS.p, "bgRef");
  if (ref){
    const c = color(ref);
    return "主题背景样式 idx=" + attr(ref, "idx", "?") + (c ? "，颜色 " + c : "");
  }
  return null;
}

/* ==================== 给 AI 的说明（PPTX 专用） ==================== */
const PREAMBLE = `> 【给 AI 的说明】下面是一份 PowerPoint 的完整结构化描述，由「文档转 AI 文本」工具
> 从 .pptx 的 OOXML 中提取。请严格按这些参数还原，不要自行发挥版式、配色或字号。
>
> ✅ 和 PDF 那条路不同：PPTX 里存的是**语义对象**（"这是一个圆角矩形，里面有个段落"），
> 所以下面几乎全是精确值，不是从几何反推出来的估计。数值请直接照抄。
>
> 阅读约定：
> · 坐标原点在幻灯片左上角，x 向右、y 向下。单位见每行标注。
> · 形状按 [序号] 排列，序号即 z 轴叠放顺序（序号大的压在上面）。
> · "组合" 内的子元素使用组合自己的内部坐标系，需按组合的子坐标系映射回画布。
> · 颜色写作 #RRGGBB；标注"由 X 经 lumMod/shade 得出"时，X 是主题基色，后面是变换。
> · 标了「← 继承自版式/母版」的值：幻灯片本身没写这个属性，PowerPoint 实际渲染用的就是这个值。
>   这些是真实值，不是猜测，请照用。
> · 图片只给文件名，像素内容需另行提供。
>
> ★ 关于「版式库」：
> 文档开头列出了所有用到的版式（slideLayout）及其上的装饰元素（logo、色条、页脚等）。
> 这些是**模板元素**，每张用该版式的幻灯片上都会显示，但它们只描述一次。
> 还原时请**建一次母版/版式**，不要在每张幻灯片上重复创建这些形状——
> 否则 12 页的 PPT 会多出 12 份一模一样的 logo。
> 如果你用的库不支持自定义版式，就在每页画一遍，但要告诉用户你这么做了。
>
> 还原建议：用 python-pptx 生成，形状按序号顺序创建；
> 表格必须用真正的 pptx 表格（add_table）而非文本框拼接。
`;

/* ==================== 主转换 ==================== */
function convert(bytes, fileName, opt){
  UNIT_ = opt.unit === "in" ? "in" : opt.unit === "pt" ? "pt" : opt.unit === "emu" ? "emu" : "cm";
  const files = unzip(bytes);
  const warnings = [];
  THEME = {}; CLRMAP = {}; FONTS = {};

  /* ---- 主题：配色 + 字体 ---- */
  const themePart = relTargetOfType(files, "ppt/slideMasters/slideMaster1.xml", "/theme") || "ppt/theme/theme1.xml";
  const theme = readXmlPart(files, themePart) || readXmlPart(files, "ppt/theme/theme1.xml");
  if (theme){
    const cs = deep1(theme, NS.a, "clrScheme");
    if (cs) for (const c of cs.children){
      const s = kid(c, NS.a, "srgbClr"), y = kid(c, NS.a, "sysClr");
      THEME[c.local] = s ? hexOf(attr(s, "val")) : (y ? hexOf(attr(y, "lastClr", "000000")) : "#000000");
    }
    const fs = deep1(theme, NS.a, "fontScheme");
    if (fs){
      const mj = kid(fs, NS.a, "majorFont"), mn = kid(fs, NS.a, "minorFont");
      const pick = (node, tag) => { const e = node ? kid(node, NS.a, tag) : null; return e ? attr(e, "typeface") : null; };
      FONTS.majorLatin = pick(mj, "latin"); FONTS.majorEA = pick(mj, "ea");
      FONTS.minorLatin = pick(mn, "latin"); FONTS.minorEA = pick(mn, "ea");
    }
  }

  /* ---- 画布 ---- */
  const pres = readXmlPart(files, "ppt/presentation.xml");
  let cx = 12192000, cy = 6858000;
  if (pres){
    const sz = deep1(pres, NS.p, "sldSz");
    if (sz){ cx = Number(attr(sz, "cx", cx)); cy = Number(attr(sz, "cy", cy)); }
  }

  /* ---- 幻灯片顺序 ---- */
  const presRels = readRels(files, "ppt/presentation.xml");
  let order = [];
  if (pres) for (const sId of deep(pres, NS.p, "sldId")){
    const t = presRels[attrNS(sId, NS.r, "id", null)];
    if (t) order.push(t);
  }
  if (!order.length){
    order = Object.keys(files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]));
    if (order.length) warnings.push("presentation.xml 里读不到幻灯片顺序，已按文件名排序（顺序可能与实际不一致）");
  }
  if (!order.length) throw new Error("没有找到任何幻灯片。文件可能不是有效的 .pptx");

  /* ---- 预扫：收集用到的版式与母版，建立继承链 ---- */
  const layoutCache = Object.create(null);
  const masterCache = Object.create(null);
  const layoutUse = [];              // 保持首次出现顺序
  const slideMeta = [];

  for (const path of order){
    const layoutPath = relTargetOfType(files, path, "/slideLayout");
    let masterPath = null;
    if (layoutPath){
      if (!layoutCache[layoutPath]){
        const doc = readXmlPart(files, layoutPath);
        const mp = relTargetOfType(files, layoutPath, "/slideMaster");
        layoutCache[layoutPath] = {
          doc, path: layoutPath, masterPath: mp,
          name: doc ? (attr(deep1(doc, NS.p, "cSld"), "name", "") || layoutPath.split("/").pop()) : layoutPath.split("/").pop(),
          type: doc ? attr(doc, "type", "") : "",
          map: doc ? collectPlaceholders(deep1(doc, NS.p, "spTree")) : { byIdx: {}, byType: {} },
          rels: readRels(files, layoutPath)
        };
        layoutUse.push(layoutPath);
      }
      masterPath = layoutCache[layoutPath].masterPath;
    }
    if (masterPath && !masterCache[masterPath]){
      const doc = readXmlPart(files, masterPath);
      masterCache[masterPath] = {
        doc, path: masterPath,
        map: doc ? collectPlaceholders(deep1(doc, NS.p, "spTree")) : { byIdx: {}, byType: {} },
        rels: readRels(files, masterPath)
      };
      /* 母版的 clrMap 决定 schemeClr 的映射 */
      if (doc){
        const cm = deep1(doc, NS.p, "clrMap");
        if (cm) for (const k in cm.attrs) CLRMAP[k] = cm.attrs[k];
      }
    }
    slideMeta.push({ path, layoutPath, masterPath });
  }
  if (!layoutUse.length)
    warnings.push("这份文件里读不到任何版式（slideLayout）。占位符的位置与字号将无法确定——" +
                  "如果输出里大量出现「无法确定」，原因在此。");

  /* ==================== 组装输出 ==================== */
  const L = [];
  L.push("# PPT 结构化描述：" + fileName);
  L.push("");
  L.push("画布尺寸: " + len(cx) + " × " + len(cy) + " " + U_() +
         "　(" + round(cx / EMU_IN, 3) + " × " + round(cy / EMU_IN, 3) + " 英寸，比例 " + round(cx / cy, 3) + ":1" +
         (Math.abs(cx / cy - 16 / 9) < 0.02 ? "，16:9" : Math.abs(cx / cy - 4 / 3) < 0.02 ? "，4:3" : "") + ")");
  L.push("幻灯片数: " + order.length);
  const themeStr = Object.keys(THEME).map(k => k + "=" + THEME[k]).join(" ");
  if (themeStr) L.push("主题配色: " + themeStr);
  const fdesc = [];
  if (FONTS.majorLatin || FONTS.majorEA) fdesc.push("标题字体 " + [FONTS.majorLatin, FONTS.majorEA].filter(Boolean).join(" / "));
  if (FONTS.minorLatin || FONTS.minorEA) fdesc.push("正文字体 " + [FONTS.minorLatin, FONTS.minorEA].filter(Boolean).join(" / "));
  if (fdesc.length) L.push("主题字体: " + fdesc.join("；"));

  if (warnings.length){
    L.push("");
    L.push("## ⚠️ 转换过程中的已知问题（请连同正文一起读）");
    for (const w of warnings) L.push("- " + w);
  }

  L.push("");
  if (opt.preamble){ L.push(PREAMBLE); L.push(""); }

  /* ---- 版式库：模板元素只描述一次 ---- */
  if (opt.layouts !== false && layoutUse.length){
    L.push("---");
    L.push("");
    L.push("## 版式库（模板元素，只列一次，请勿在每页重复创建）");
    L.push("");
    for (const lp of layoutUse){
      const lay = layoutCache[lp];
      const usedBy = slideMeta.map((m, i) => m.layoutPath === lp ? i + 1 : null).filter(Boolean);
      L.push("### 版式「" + lay.name + "」" + (lay.type ? "（type=" + lay.type + "）" : ""));
      L.push("被这些幻灯片使用: 第 " + usedBy.join("、") + " 页");
      const mst = lay.masterPath ? masterCache[lay.masterPath] : null;
      const bgL = lay.doc ? backgroundOf(lay.doc) : null;
      const bgM = mst && mst.doc ? backgroundOf(mst.doc) : null;
      if (bgL) L.push("背景: " + bgL);
      else if (bgM) L.push("背景: " + bgM + "   ← 来自母版");
      L.push("");

      /* 母版上的装饰形状（非占位符）——原工具完全看不见的那一层 */
      const decorOpt = Object.assign({}, opt, { keepEmpty: false, skipPlaceholders: true });

      if (mst && mst.doc){
        const showMaster = attr(lay.doc, "showMasterSp", "1") !== "0";
        if (showMaster){
          const buf = [];
          walkShapes(deep1(mst.doc, NS.p, "spTree"), {
            files, rels: mst.rels, chain: [], master: mst.doc, hiddenCount: 0
          }, 0, { n: 0 }, buf, decorOpt);
          if (buf.filter(x => x !== "").length){
            L.push("#### 母版上的固定元素（每张用此版式的页面都会显示）");
            L.push(...buf);
          }
        } else L.push("（本版式设置了不显示母版形状）");
      }

      if (lay.doc){
        const buf = [];
        walkShapes(deep1(lay.doc, NS.p, "spTree"), {
          files, rels: lay.rels, chain: mst ? [{ map: mst.map, name: "母版" }] : [],
          master: mst ? mst.doc : null, hiddenCount: 0
        }, 0, { n: 0 }, buf, decorOpt);
        if (buf.filter(x => x !== "").length){
          L.push("#### 版式上的固定元素");
          L.push(...buf);
        }
        /* 占位符的位置：给 AI 建版式用 */
        const phs = [];
        const map = lay.map;
        const seen = new Set();
        for (const k in map.byIdx) phs.push(map.byIdx[k]);
        for (const k in map.byType) if (!phs.includes(map.byType[k])) phs.push(map.byType[k]);
        const lines = [];
        for (const rec of phs){
          if (seen.has(rec)) continue;
          seen.add(rec);
          if (!rec.xfrm) continue;
          lines.push("  · " + (PH_NAME[rec.type] || rec.type) +
                     (rec.idx !== undefined ? "(idx=" + rec.idx + ")" : "") + "　" + xfrmStr(rec.xfrm, null));
        }
        if (lines.length){
          L.push("#### 本版式的占位符位置");
          L.push(...lines);
        }
      }
      L.push("");
    }
  }

  L.push("---");
  L.push("");

  /* ---- 逐页 ---- */
  let totalHidden = 0;
  for (let i = 0; i < order.length; i++){
    const path = order[i];
    const meta = slideMeta[i];
    const doc = readXmlPart(files, path);
    L.push("## 幻灯片 " + (i + 1) + " / " + order.length);
    if (!doc){ L.push("（解析失败：" + path + "）", ""); continue; }

    const lay = meta.layoutPath ? layoutCache[meta.layoutPath] : null;
    const mst = meta.masterPath ? masterCache[meta.masterPath] : null;
    if (lay) L.push("使用版式: 「" + lay.name + "」（模板元素见文首「版式库」，不要重复创建）");
    else L.push("使用版式: 无法确定");

    const bgS = backgroundOf(doc);
    const bgL = lay && lay.doc ? backgroundOf(lay.doc) : null;
    const bgM = mst && mst.doc ? backgroundOf(mst.doc) : null;
    if (bgS) L.push("背景: " + bgS);
    else if (bgL) L.push("背景: " + bgL + "   ← 继承自版式");
    else if (bgM) L.push("背景: " + bgM + "   ← 继承自母版");
    L.push("");

    const chain = [];
    if (lay) chain.push({ map: lay.map, name: "版式「" + lay.name + "」" });
    if (mst) chain.push({ map: mst.map, name: "母版" });

    const ctx = {
      files, rels: readRels(files, path), chain,
      master: mst ? mst.doc : null, hiddenCount: 0,
      masterRecFor: type => mst ? (mst.map.byType[PH_GROUP(type)] || mst.map.byType[type] || null) : null
    };
    const counter = { n: 0 };
    walkShapes(deep1(doc, NS.p, "spTree"), ctx, 0, counter, L, opt);
    totalHidden += ctx.hiddenCount;
    L.push("（本页共 " + counter.n + " 个元素" +
           (ctx.hiddenCount ? "，另跳过 " + ctx.hiddenCount + " 个隐藏形状" : "") + "）");
    L.push("");
    L.push("---");
    L.push("");
  }

  if (totalHidden){
    L.push("> 全文共跳过 " + totalHidden + " 个标记为隐藏的形状（PowerPoint 选择窗格里被关掉的），");
    L.push("> 它们在放映和打印时都不显示，不属于页面内容。");
    L.push("");
  }

  L.push("## 还原自检清单（给 AI）");
  L.push("做完后请逐条自查，并把结果告诉用户：");
  L.push("1. 每一页的元素数量对上了吗？");
  L.push("2. 「版式库」里的模板元素，你是建成了母版/版式，还是每页重复画了？说明你的做法。");
  L.push("3. 标了「← 继承自版式/母版」的位置和字号，你用上了吗？那些是真实渲染值。");
  L.push("4. 标了「无法确定」的地方，你是怎么补的？");
  L.push("5. 图片位置留出来了吗？需要用户提供哪几张图？");
  return L.join("\n");
}

return { convert, parseXml, unzip, PREAMBLE };
})();
