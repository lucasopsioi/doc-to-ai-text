/* ============================================================
   3-render.js —— 内容流解释器
   把 PDF 的绘图指令跑一遍，产出带设备坐标的元素清单。
   这一层只负责「忠实执行」，不做任何语义猜测。

   两个容易整层漏掉的东西在这里处理：
   · OCG 可选内容组 —— PDF 真正意义上的「图层」，可以被设成默认隐藏
   · /Annots 注释层 —— 图章/批注/表单域画在独立的外观流里，不在页面内容流中
   ============================================================ */

/* ---------- 矩阵 ---------- */
const MI = [1, 0, 0, 1, 0, 0];
function mmul(m1, m2){        // 先 m1 后 m2
  return [
    m1[0]*m2[0] + m1[1]*m2[2],
    m1[0]*m2[1] + m1[1]*m2[3],
    m1[2]*m2[0] + m1[3]*m2[2],
    m1[2]*m2[1] + m1[3]*m2[3],
    m1[4]*m2[0] + m1[5]*m2[2] + m2[4],
    m1[4]*m2[1] + m1[5]*m2[3] + m2[5]
  ];
}
const mapx = (m, x, y) => x*m[0] + y*m[2] + m[4];
const mapy = (m, x, y) => x*m[1] + y*m[3] + m[5];
const mscale = m => Math.sqrt(Math.abs(m[0]*m[3] - m[1]*m[2])) || 1;

/* ---------- 颜色 ---------- */
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const toHex = (r, g, b) => "#" + [r, g, b].map(v => {
  const h = Math.round(clamp01(v) * 255).toString(16);
  return h.length < 2 ? "0" + h : h;
}).join("").toUpperCase();

function cmyk2rgb(c, m, y, k){
  return [ (1 - Math.min(1, c + k)), (1 - Math.min(1, m + k)), (1 - Math.min(1, y + k)) ];
}
function lab2rgb(L, a, bb){
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
  const f = t => t > 6/29 ? t*t*t : 3*(6/29)*(6/29)*(t - 4/29);
  let X = 0.9505 * f(fx), Y = 1.0 * f(fy), Z = 1.089 * f(fz);
  let r =  3.2406*X - 1.5372*Y - 0.4986*Z;
  let g = -0.9689*X + 1.8758*Y + 0.0415*Z;
  let b =  0.0557*X - 0.2040*Y + 1.0570*Z;
  const gam = v => { v = clamp01(v); return v <= 0.0031308 ? 12.92*v : 1.055*Math.pow(v, 1/2.4) - 0.055; };
  return [gam(r), gam(g), gam(b)];
}

/* ---------- PDF 函数（渐变与专色要用） ---------- */
class PdfFunction {
  constructor(obj, doc){
    this.doc = doc;
    const g = v => doc.get(v);
    const d = obj instanceof PStream ? obj.dict : obj;
    this.d = d;
    this.type = g(d.FunctionType);
    this.domain = (g(d.Domain) || [0, 1]).map(g);
    this.range = (g(d.Range) || []).map(g);
    if (this.type === 2){
      this.c0 = (g(d.C0) || [0]).map(g);
      this.c1 = (g(d.C1) || [1]).map(g);
      this.n = g(d.N) !== undefined ? g(d.N) : 1;
    } else if (this.type === 3){
      this.funcs = (g(d.Functions) || []).map(f => new PdfFunction(g(f), doc));
      this.bounds = (g(d.Bounds) || []).map(g);
      this.encode = (g(d.Encode) || []).map(g);
    } else if (this.type === 0 && obj instanceof PStream){
      try {
        this.samples = obj.data;
        this.size = (g(d.Size) || []).map(g);
        this.bps = g(d.BitsPerSample) || 8;
        this.nOut = this.range.length >> 1;
        this.encode0 = (g(d.Encode) || []).map(g);
        this.decode0 = (g(d.Decode) || []).map(g);
      } catch (e){ this.broken = true; }
    }
  }

  eval(t){
    const [d0, d1] = [this.domain[0], this.domain[1]];
    t = Math.max(d0, Math.min(d1, t));
    if (this.type === 2){
      const k = Math.pow(this.n === 1 ? (t - d0) / (d1 - d0 || 1) : (t - d0) / (d1 - d0 || 1), this.n);
      const n = Math.max(this.c0.length, this.c1.length);
      const out = [];
      for (let i = 0; i < n; i++){
        const a = this.c0[i] !== undefined ? this.c0[i] : 0;
        const b = this.c1[i] !== undefined ? this.c1[i] : 1;
        out.push(a + k * (b - a));
      }
      return out;
    }
    if (this.type === 3){
      let i = 0;
      while (i < this.bounds.length && t >= this.bounds[i]) i++;
      const lo = i === 0 ? d0 : this.bounds[i - 1];
      const hi = i === this.bounds.length ? d1 : this.bounds[i];
      const e0 = this.encode[2*i] !== undefined ? this.encode[2*i] : 0;
      const e1 = this.encode[2*i+1] !== undefined ? this.encode[2*i+1] : 1;
      const u = hi === lo ? e0 : e0 + (t - lo) / (hi - lo) * (e1 - e0);
      return this.funcs[i] ? this.funcs[i].eval(u) : [0];
    }
    if (this.type === 0 && this.samples && !this.broken){
      const size = this.size[0] || 2;
      const e0 = this.encode0[0] !== undefined ? this.encode0[0] : 0;
      const e1 = this.encode0[1] !== undefined ? this.encode0[1] : size - 1;
      let x = (t - d0) / ((d1 - d0) || 1) * (e1 - e0) + e0;
      x = Math.max(0, Math.min(size - 1, x));
      const i0 = Math.floor(x), i1 = Math.min(size - 1, i0 + 1), fr = x - i0;
      const read = (idx, j) => {
        const bit = (idx * this.nOut + j) * this.bps;
        const max = Math.pow(2, this.bps) - 1;
        let v = 0;
        if (this.bps === 8) v = this.samples[bit >> 3];
        else if (this.bps === 16){ const p = bit >> 3; v = (this.samples[p] << 8) | this.samples[p + 1]; }
        else {
          for (let k = 0; k < this.bps; k++){
            const b = bit + k;
            v = (v << 1) | ((this.samples[b >> 3] >> (7 - (b & 7))) & 1);
          }
        }
        const dm0 = this.decode0[2*j] !== undefined ? this.decode0[2*j] : this.range[2*j];
        const dm1 = this.decode0[2*j+1] !== undefined ? this.decode0[2*j+1] : this.range[2*j+1];
        return dm0 + (v / max) * (dm1 - dm0);
      };
      const out = [];
      for (let j = 0; j < this.nOut; j++) out.push(read(i0, j) * (1 - fr) + read(i1, j) * fr);
      return out;
    }
    /* Type 4（PostScript 计算器）没实现：线性近似，并让上层知道这是估计值 */
    this.approx = true;
    const n = Math.max(1, this.range.length >> 1);
    const out = [];
    for (let i = 0; i < n; i++){
      const lo = this.range[2*i] !== undefined ? this.range[2*i] : 0;
      const hi = this.range[2*i+1] !== undefined ? this.range[2*i+1] : 1;
      out.push(lo + (t - d0) / ((d1 - d0) || 1) * (hi - lo));
    }
    return out;
  }
}

/* ---------- 颜色空间 ---------- */
class ColorSpace {
  constructor(kind, n, opts){ this.kind = kind; this.n = n; Object.assign(this, opts || {}); }

  toRGB(comps){
    const c = comps.map(v => typeof v === "number" ? v : 0);
    switch (this.kind){
      case "gray": return [clamp01(c[0]), clamp01(c[0]), clamp01(c[0])];
      case "rgb":  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
      case "cmyk": return cmyk2rgb(c[0], c[1], c[2], c[3]);
      case "lab":  return lab2rgb(c[0] !== undefined ? c[0] : 0, c[1] || 0, c[2] || 0);
      case "indexed": {
        const i = Math.max(0, Math.min(this.hival, Math.round(c[0])));
        const base = this.base, bn = base.n;
        const sub = [];
        for (let k = 0; k < bn; k++){
          const v = this.lookup[i * bn + k];
          sub.push((v === undefined ? 0 : v) / 255);
        }
        if (base.kind === "lab"){ sub[0] *= 100; sub[1] = sub[1] * 255 - 128; sub[2] = sub[2] * 255 - 128; }
        return base.toRGB(sub);
      }
      case "sep": {
        /* 专色：用 tint transform 换算到替代空间 */
        if (this.fn && this.alt){
          try { return this.alt.toRGB(this.fn.eval(c[0])); } catch (e){}
        }
        const v = 1 - clamp01(c[0]);
        return [v, v, v];
      }
      case "pattern": return null;                 // 图案/渐变，另行描述
      default: {
        if (this.n === 1) return [clamp01(c[0]), clamp01(c[0]), clamp01(c[0])];
        if (this.n === 4) return cmyk2rgb(c[0], c[1], c[2], c[3]);
        return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
      }
    }
  }

  initial(){
    if (this.kind === "indexed") return [0];
    if (this.kind === "sep") return new Array(this.n).fill(1);
    if (this.kind === "cmyk") return [0, 0, 0, 1];
    if (this.kind === "lab") return [0, 0, 0];
    return new Array(this.n).fill(0);
  }
}

const CS_GRAY = new ColorSpace("gray", 1);
const CS_RGB  = new ColorSpace("rgb", 3);
const CS_CMYK = new ColorSpace("cmyk", 4);
const CS_PATTERN = new ColorSpace("pattern", 1);

function parseColorSpace(cs, doc, resources, depth){
  const g = v => doc.get(v);
  cs = g(cs);
  if (depth > 8) return CS_GRAY;
  if (cs instanceof Name){
    switch (cs.name){
      case "DeviceGray": case "G": case "CalGray": return CS_GRAY;
      case "DeviceRGB": case "RGB": case "CalRGB": return CS_RGB;
      case "DeviceCMYK": case "CMYK": return CS_CMYK;
      case "Pattern": return CS_PATTERN;
      default: {
        /* 资源字典里的具名颜色空间 */
        const csd = resources ? g(resources.ColorSpace) : null;
        if (csd && csd[cs.name] !== undefined) return parseColorSpace(csd[cs.name], doc, null, depth + 1);
        return CS_GRAY;
      }
    }
  }
  if (!Array.isArray(cs) || !cs.length) return CS_GRAY;
  const head = g(cs[0]);
  const kind = head instanceof Name ? head.name : "";
  switch (kind){
    case "ICCBased": {
      const s = g(cs[1]);
      const n = s ? g(s.dict ? s.dict.N : s.N) : 3;
      const alt = s && (s.dict ? s.dict.Alternate : s.Alternate);
      if (alt) return parseColorSpace(alt, doc, resources, depth + 1);
      return n === 1 ? CS_GRAY : n === 4 ? CS_CMYK : CS_RGB;
    }
    case "CalRGB": return CS_RGB;
    case "CalGray": return CS_GRAY;
    case "Lab": return new ColorSpace("lab", 3);
    case "Indexed": case "I": {
      const base = parseColorSpace(cs[1], doc, resources, depth + 1);
      const hival = g(cs[2]) || 0;
      let lookup = g(cs[3]);
      let bytes;
      if (lookup instanceof PStream){ try { bytes = lookup.data; } catch (e){ bytes = new Uint8Array(0); } }
      else if (lookup instanceof PStr) bytes = lookup.bytes;
      else bytes = new Uint8Array(0);
      return new ColorSpace("indexed", 1, { base, hival, lookup: bytes });
    }
    case "Separation": {
      const alt = parseColorSpace(cs[2], doc, resources, depth + 1);
      let fn = null;
      try { fn = new PdfFunction(g(cs[3]), doc); } catch (e){}
      const nmv = g(cs[1]);
      return new ColorSpace("sep", 1, { alt, fn, inkName: nmv instanceof Name ? nmv.name : null });
    }
    case "DeviceN": {
      const names = g(cs[1]) || [];
      const alt = parseColorSpace(cs[2], doc, resources, depth + 1);
      let fn = null;
      try { fn = new PdfFunction(g(cs[3]), doc); } catch (e){}
      return new ColorSpace("sep", names.length || 1, { alt, fn, inkName: names.map(n => g(n) instanceof Name ? g(n).name : "?").join("+") });
    }
    case "Pattern": return CS_PATTERN;
    case "DeviceGray": return CS_GRAY;
    case "DeviceRGB": return CS_RGB;
    case "DeviceCMYK": return CS_CMYK;
  }
  return CS_GRAY;
}

/* ---------- 图形状态 ---------- */
class GState {
  constructor(){
    this.ctm = MI.slice();
    this.fillCS = CS_GRAY; this.strokeCS = CS_GRAY;
    this.fill = [0, 0, 0]; this.stroke = [0, 0, 0];
    this.fillPattern = null; this.strokePattern = null;
    this.lineWidth = 1; this.dash = null; this.lineCap = 0; this.lineJoin = 0;
    this.fillAlpha = 1; this.strokeAlpha = 1;
    this.blend = null; this.softMask = false;
    this.font = null; this.fontSize = 0; this.fontRef = null;
    this.charSpace = 0; this.wordSpace = 0; this.hscale = 1;
    this.leading = 0; this.rise = 0; this.render = 0;
    this.clip = null;                     // [x0,y0,x1,y1] 设备坐标下的外接矩形近似
  }
  clone(){
    const g = new GState();
    for (const k in this) g[k] = Array.isArray(this[k]) ? this[k].slice() : this[k];
    return g;
  }
}

/* ---------- 渲染器 ---------- */
class Renderer {
  constructor(doc, opts){
    this.doc = doc;
    this.opts = opts || {};
    this.fontCache = new Map();
    this.items = [];
    this.notes = [];
    this.hiddenOCGs = this.readHiddenOCGs();
    this.fontsUsed = new Map();
    this.seq = 0;
  }

  note(s){ if (this.notes.indexOf(s) < 0) this.notes.push(s); }

  /* 默认关闭的可选内容组 —— 这些内容在阅读器里是看不见的 */
  readHiddenOCGs(){
    const doc = this.doc, g = v => doc.get(v);
    const set = new Set();
    try {
      const ocp = g(doc.catalog.OCProperties);
      if (!ocp) return set;
      const d = g(ocp.D);
      if (!d) return set;
      const off = g(d.OFF);
      if (Array.isArray(off)) for (const r of off) if (r instanceof Ref) set.add(r.num);
      const bs = g(d.BaseState);
      if (bs instanceof Name && bs.name === "OFF"){
        const all = g(ocp.OCGs);
        if (Array.isArray(all)) for (const r of all) if (r instanceof Ref) set.add(r.num);
        const on = g(d.ON);
        if (Array.isArray(on)) for (const r of on) if (r instanceof Ref) set.delete(r.num);
      }
    } catch (e){}
    return set;
  }

  ocgHidden(ref){
    if (!ref) return false;
    if (ref instanceof Ref){
      if (this.hiddenOCGs.has(ref.num)) return true;
      const d = this.doc.get(ref);
      if (d && this.doc.get(d.Type) instanceof Name && this.doc.get(d.Type).name === "OCMD"){
        let ocgs = this.doc.get(d.OCGs);
        if (ocgs instanceof Ref) ocgs = [d.OCGs];
        if (Array.isArray(ocgs)) for (const o of ocgs) if (o instanceof Ref && this.hiddenOCGs.has(o.num)) return true;
      }
    }
    return false;
  }

  /* ============ 页面入口 ============ */
  renderPage(page, pageIndex){
    const doc = this.doc, g = v => doc.get(v);
    this.items = [];
    this.seq = 0;

    let mb = (g(page.MediaBox) || [0, 0, 612, 792]).map(v => g(v));
    let cb = g(page.CropBox);
    if (Array.isArray(cb)) cb = cb.map(v => g(v)); else cb = null;
    const box = (cb && cb.length === 4 && (cb[2] - cb[0]) > 1 && (cb[3] - cb[1]) > 1) ? cb : mb;
    const x0 = Math.min(box[0], box[2]), x1 = Math.max(box[0], box[2]);
    const y0 = Math.min(box[1], box[3]), y1 = Math.max(box[1], box[3]);
    const w = x1 - x0, h = y1 - y0;
    let rot = ((g(page.Rotate) || 0) % 360 + 360) % 360;
    rot = Math.round(rot / 90) * 90 % 360;

    let base, pw, ph;
    switch (rot){
      case 90:  base = [0, 1, 1, 0, -y0, -x0]; pw = h; ph = w; break;
      case 180: base = [-1, 0, 0, 1, x1, -y0];  pw = w; ph = h; break;
      case 270: base = [0, -1, -1, 0, y1, x1];  pw = h; ph = w; break;
      default:  base = [1, 0, 0, -1, -x0, y1];  pw = w; ph = h; break;
    }

    this.page = { w: pw, h: ph, rot, index: pageIndex, mediaBox: mb, cropBox: cb };

    const gs = new GState();
    gs.ctm = base;
    gs.clip = [0, 0, pw, ph];

    let content;
    try { content = doc.pageContent(page); }
    catch (e){ this.note("页面内容流读取失败：" + e.message); content = new Uint8Array(0); }

    const res = g(page.Resources) || Object.create(null);
    try { this.execute(content, res, gs, 0); }
    catch (e){ this.note("内容流执行中断：" + e.message + "（已保留中断前解析出的元素）"); }

    /* 注释层：图章、批注、表单域的外观流不在页面内容流里 */
    if (this.opts.annots !== false) this.renderAnnots(page, base);

    return { items: this.items, w: pw, h: ph, rot };
  }

  renderAnnots(page, base){
    const doc = this.doc, g = v => doc.get(v);
    const annots = g(page.Annots);
    if (!Array.isArray(annots)) return;
    let n = 0;
    for (const aRef of annots){
      const a = g(aRef);
      if (!a || typeof a !== "object") continue;
      const sub = g(a.Subtype);
      const subName = sub instanceof Name ? sub.name : "";
      if (subName === "Link" || subName === "Popup") continue;      // 无外观，纯交互
      const flags = g(a.F) || 0;
      if (flags & 2) continue;                                       // Hidden
      if (flags & 32) continue;                                      // NoView
      if (this.ocgHidden(a.OC)) continue;

      const ap = g(a.AP);
      if (!ap) continue;
      let nAp = g(ap.N);
      if (nAp && !(nAp instanceof PStream)){
        /* 外观状态字典：按 /AS 选一个 */
        const as = g(a.AS);
        if (as instanceof Name) nAp = g(nAp[as.name]);
        else { const k = Object.keys(nAp)[0]; nAp = k ? g(nAp[k]) : null; }
      }
      if (!(nAp instanceof PStream)) continue;

      const rect = (g(a.Rect) || []).map(v => g(v));
      if (rect.length !== 4) continue;
      const rx0 = Math.min(rect[0], rect[2]), rx1 = Math.max(rect[0], rect[2]);
      const ry0 = Math.min(rect[1], rect[3]), ry1 = Math.max(rect[1], rect[3]);

      /* 表单 XObject 的 BBox 经 Matrix 变换后，要贴合到 Rect 上 */
      const bbox = (g(nAp.dict.BBox) || [0, 0, 1, 1]).map(v => g(v));
      const mtx = (g(nAp.dict.Matrix) || MI).map(v => g(v));
      const corners = [[bbox[0],bbox[1]],[bbox[2],bbox[1]],[bbox[2],bbox[3]],[bbox[0],bbox[3]]]
        .map(([x, y]) => [mapx(mtx, x, y), mapy(mtx, x, y)]);
      const bx0 = Math.min(...corners.map(c => c[0])), bx1 = Math.max(...corners.map(c => c[0]));
      const by0 = Math.min(...corners.map(c => c[1])), by1 = Math.max(...corners.map(c => c[1]));
      const sx = (bx1 - bx0) > 1e-6 ? (rx1 - rx0) / (bx1 - bx0) : 1;
      const sy = (by1 - by0) > 1e-6 ? (ry1 - ry0) / (by1 - by0) : 1;
      const fit = [sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy];

      const gs = new GState();
      gs.ctm = mmul(mmul(mtx, fit), base);
      gs.clip = [0, 0, this.page.w, this.page.h];
      gs.annot = subName;

      const res = g(nAp.dict.Resources) || Object.create(null);
      const before = this.items.length;
      try { this.execute(nAp.data, res, gs, 1); } catch (e){}
      for (let i = before; i < this.items.length; i++){
        this.items[i].fromAnnot = subName;
        this.items[i].annotName = (() => { const t = g(a.T); return t instanceof PStr ? t.latin1 : null; })();
      }
      if (this.items.length > before) n++;
    }
    if (n) this.note(`本页有 ${n} 个注释/表单元素画在独立的外观流里，已一并提取（标注为「注释层」）`);
  }

  /* ============ 内容流执行 ============ */
  execute(bytes, resources, gs, depth){
    if (depth > 12){ this.note("表单 XObject 嵌套过深，已停止递归"); return; }
    const doc = this.doc, g = v => doc.get(v);
    const parser = new Parser(bytes, 0, null);        // 内容流内的字符串不加密
    const stack = [];
    const gsStack = [];
    let tm = MI.slice(), tlm = MI.slice();
    let path = [];            // 当前路径的子路径
    let cur = null;           // 当前子路径
    let startPt = null, curPt = null;
    let pendingClip = 0;
    const mcStack = [];       // 标记内容栈；元素为 {hidden}
    let hiddenDepth = 0;
    let opCount = 0;

    const args = [];

    const flushPath = (doFill, doStroke, evenOdd, close) => {
      if (close && cur && cur.pts.length) cur.closed = true;
      if (cur && cur.pts.length > 1) path.push(cur);
      else if (cur && cur.pts.length === 1 && doStroke) path.push(cur);
      cur = null;
      if (path.length && (doFill || doStroke)) this.emitPath(path, gs, doFill, doStroke, evenOdd, hiddenDepth > 0);
      if (pendingClip){
        const bb = pathBBox(path);
        if (bb) gs.clip = intersectBox(gs.clip, bb);
        pendingClip = 0;
      }
      path = [];
      startPt = null;
    };

    for (;;){
      if (++opCount > 3000000){ this.note("内容流过长，已截断"); break; }
      let obj;
      try { obj = parser.parse(); } catch (e){ break; }
      if (obj === undefined) break;

      if (!(obj && obj.op !== undefined)){ args.push(obj); if (args.length > 64) args.shift(); continue; }
      const op = obj.op;
      const A = args;
      const num = i => { const v = A[i]; return typeof v === "number" ? v : 0; };

      switch (op){
        /* ---- 图形状态 ---- */
        case "q": gsStack.push(gs.clone()); break;
        case "Q": if (gsStack.length) gs = gsStack.pop(); break;
        case "cm": if (A.length >= 6) gs.ctm = mmul([num(A.length-6),num(A.length-5),num(A.length-4),num(A.length-3),num(A.length-2),num(A.length-1)], gs.ctm); break;
        case "w": gs.lineWidth = num(A.length-1); break;
        case "J": gs.lineCap = num(A.length-1); break;
        case "j": gs.lineJoin = num(A.length-1); break;
        case "d": {
          const arr = A[A.length-2];
          gs.dash = Array.isArray(arr) && arr.length ? { arr: arr.map(v => typeof v === "number" ? v : 0), phase: num(A.length-1) } : null;
          break;
        }
        case "gs": {
          const n = A[A.length-1];
          if (n instanceof Name){
            const eg = g(resources.ExtGState);
            const e = eg ? g(eg[n.name]) : null;
            if (e){
              if (typeof g(e.ca) === "number") gs.fillAlpha = g(e.ca);
              if (typeof g(e.CA) === "number") gs.strokeAlpha = g(e.CA);
              if (typeof g(e.LW) === "number") gs.lineWidth = g(e.LW);
              const bm = g(e.BM);
              if (bm instanceof Name && bm.name !== "Normal" && bm.name !== "Compatible") gs.blend = bm.name;
              else if (Array.isArray(bm) && g(bm[0]) instanceof Name) gs.blend = g(bm[0]).name;
              const sm = g(e.SMask);
              gs.softMask = !!(sm && !(sm instanceof Name && sm.name === "None"));
              const fnt = g(e.Font);
              if (Array.isArray(fnt)){
                const f = getFont(doc, fnt[0], "gsFont", this.fontCache);
                if (f){ gs.font = f; gs.fontSize = g(fnt[1]) || 0; }
              }
            }
          }
          break;
        }

        /* ---- 颜色 ---- */
        case "g":  gs.fillCS = CS_GRAY;  gs.fill = [num(A.length-1)]; gs.fillPattern = null; break;
        case "G":  gs.strokeCS = CS_GRAY; gs.stroke = [num(A.length-1)]; gs.strokePattern = null; break;
        case "rg": gs.fillCS = CS_RGB;   gs.fill = [num(A.length-3),num(A.length-2),num(A.length-1)]; gs.fillPattern = null; break;
        case "RG": gs.strokeCS = CS_RGB; gs.stroke = [num(A.length-3),num(A.length-2),num(A.length-1)]; gs.strokePattern = null; break;
        case "k":  gs.fillCS = CS_CMYK;  gs.fill = [num(A.length-4),num(A.length-3),num(A.length-2),num(A.length-1)]; gs.fillPattern = null; break;
        case "K":  gs.strokeCS = CS_CMYK; gs.stroke = [num(A.length-4),num(A.length-3),num(A.length-2),num(A.length-1)]; gs.strokePattern = null; break;
        case "cs": case "CS": {
          const cs = parseColorSpace(A[A.length-1], doc, resources, 0);
          if (op === "cs"){ gs.fillCS = cs; gs.fill = cs.initial(); gs.fillPattern = null; }
          else { gs.strokeCS = cs; gs.stroke = cs.initial(); gs.strokePattern = null; }
          break;
        }
        case "sc": case "scn": case "SC": case "SCN": {
          const isFill = op[0] === "s";
          const cs = isFill ? gs.fillCS : gs.strokeCS;
          const last = A[A.length-1];
          if (last instanceof Name){
            const pat = this.resolvePattern(last, resources, gs);
            if (isFill){ gs.fillPattern = pat; } else { gs.strokePattern = pat; }
          } else {
            const comps = A.filter(v => typeof v === "number").slice(-Math.max(1, cs.n));
            if (isFill){ gs.fill = comps; gs.fillPattern = null; }
            else { gs.stroke = comps; gs.strokePattern = null; }
          }
          break;
        }

        /* ---- 路径构建 ---- */
        case "m": {
          if (cur && cur.pts.length > 1) path.push(cur);
          curPt = [mapx(gs.ctm, num(A.length-2), num(A.length-1)), mapy(gs.ctm, num(A.length-2), num(A.length-1))];
          startPt = curPt;
          cur = { pts: [curPt], curves: false, closed: false };
          break;
        }
        case "l": {
          if (!cur) cur = { pts: curPt ? [curPt] : [], curves: false, closed: false };
          curPt = [mapx(gs.ctm, num(A.length-2), num(A.length-1)), mapy(gs.ctm, num(A.length-2), num(A.length-1))];
          cur.pts.push(curPt);
          break;
        }
        case "c": case "v": case "y": {
          if (!cur) cur = { pts: curPt ? [curPt] : [], curves: false, closed: false };
          let p1, p2, p3;
          const P = (i, j) => [mapx(gs.ctm, num(i), num(j)), mapy(gs.ctm, num(i), num(j))];
          const L = A.length;
          if (op === "c"){ p1 = P(L-6,L-5); p2 = P(L-4,L-3); p3 = P(L-2,L-1); }
          else if (op === "v"){ p1 = curPt || P(L-4,L-3); p2 = P(L-4,L-3); p3 = P(L-2,L-1); }
          else { p1 = P(L-4,L-3); p2 = p3 = P(L-2,L-1); p3 = P(L-2,L-1); }
          /* 贝塞尔按 8 段折线近似：足够做外接框和形状识别，同时保留控制点 */
          const p0 = curPt || p1;
          for (let t = 1; t <= 8; t++){
            const u = t / 8, iu = 1 - u;
            const bx = iu*iu*iu*p0[0] + 3*iu*iu*u*p1[0] + 3*iu*u*u*p2[0] + u*u*u*p3[0];
            const by = iu*iu*iu*p0[1] + 3*iu*iu*u*p1[1] + 3*iu*u*u*p2[1] + u*u*u*p3[1];
            cur.pts.push([bx, by]);
          }
          cur.curves = true;
          if (!cur.ctrl) cur.ctrl = [];
          cur.ctrl.push([p0, p1, p2, p3]);
          curPt = p3;
          break;
        }
        case "h": if (cur && cur.pts.length){ cur.closed = true; if (startPt) curPt = startPt; } break;
        case "re": {
          if (cur && cur.pts.length > 1) path.push(cur);
          const L = A.length;
          const x = num(L-4), y = num(L-3), rw = num(L-2), rh = num(L-1);
          const pts = [[x,y],[x+rw,y],[x+rw,y+rh],[x,y+rh]]
            .map(([px, py]) => [mapx(gs.ctm, px, py), mapy(gs.ctm, px, py)]);
          path.push({ pts, curves: false, closed: true, isRect: true });
          cur = null; curPt = pts[0]; startPt = pts[0];
          break;
        }

        /* ---- 路径绘制 ---- */
        case "S": flushPath(false, true, false, false); break;
        case "s": flushPath(false, true, false, true); break;
        case "f": case "F": flushPath(true, false, false, true); break;
        case "f*": flushPath(true, false, true, true); break;
        case "B": flushPath(true, true, false, false); break;
        case "B*": flushPath(true, true, true, false); break;
        case "b": flushPath(true, true, false, true); break;
        case "b*": flushPath(true, true, true, true); break;
        case "n": flushPath(false, false, false, false); break;
        case "W": pendingClip = 1; break;
        case "W*": pendingClip = 2; break;

        /* ---- 文本 ---- */
        case "BT": tm = MI.slice(); tlm = MI.slice(); break;
        case "ET": break;
        case "Tc": gs.charSpace = num(A.length-1); break;
        case "Tw": gs.wordSpace = num(A.length-1); break;
        case "Tz": gs.hscale = num(A.length-1) / 100; break;
        case "TL": gs.leading = num(A.length-1); break;
        case "Ts": gs.rise = num(A.length-1); break;
        case "Tr": gs.render = num(A.length-1); break;
        case "Tf": {
          const n = A[A.length-2];
          gs.fontSize = num(A.length-1);
          if (n instanceof Name){
            const fd = g(resources.Font);
            const ref = fd ? fd[n.name] : null;
            gs.font = ref ? getFont(doc, ref, n.name, this.fontCache) : null;
            if (gs.font) this.fontsUsed.set(gs.font.name + "|" + (gs.font.bold?"b":"") + (gs.font.italic?"i":""), gs.font);
            if (!gs.font) this.note("资源里找不到字体 /" + n.name + "，该段文字的字体信息无法确定");
          }
          break;
        }
        case "Td": tlm = mmul([1,0,0,1,num(A.length-2),num(A.length-1)], tlm); tm = tlm.slice(); break;
        case "TD": gs.leading = -num(A.length-1); tlm = mmul([1,0,0,1,num(A.length-2),num(A.length-1)], tlm); tm = tlm.slice(); break;
        case "Tm": if (A.length >= 6){ tlm = [num(A.length-6),num(A.length-5),num(A.length-4),num(A.length-3),num(A.length-2),num(A.length-1)]; tm = tlm.slice(); } break;
        case "T*": tlm = mmul([1,0,0,1,0,-gs.leading], tlm); tm = tlm.slice(); break;
        case "Tj": case "'": case "\"": {
          if (op !== "Tj"){
            if (op === "\""){ gs.wordSpace = num(A.length-3); gs.charSpace = num(A.length-2); }
            tlm = mmul([1,0,0,1,0,-gs.leading], tlm); tm = tlm.slice();
          }
          const s = A[A.length-1];
          if (s instanceof PStr) tm = this.showText(s.bytes, gs, tm, hiddenDepth > 0, null);
          break;
        }
        case "TJ": {
          const arr = A[A.length-1];
          if (Array.isArray(arr)) tm = this.showTextArray(arr, gs, tm, hiddenDepth > 0);
          break;
        }

        /* ---- XObject ---- */
        case "Do": {
          const n = A[A.length-1];
          if (!(n instanceof Name)) break;
          const xd = g(resources.XObject);
          const xo = xd ? g(xd[n.name]) : null;
          if (!(xo instanceof PStream)) break;
          if (this.ocgHidden(xo.dict.OC)){ this.note("跳过了 1 个被设为隐藏的可选内容图层（XObject）"); break; }
          const st = g(xo.dict.Subtype);
          const stn = st instanceof Name ? st.name : "";
          if (stn === "Image"){
            this.emitImage(xo, gs, n.name, hiddenDepth > 0);
          } else if (stn === "Form"){
            const sub = gs.clone();
            const mtx = (g(xo.dict.Matrix) || MI).map(v => g(v));
            sub.ctm = mmul(mtx, gs.ctm);
            const bbox = (g(xo.dict.BBox) || []).map(v => g(v));
            if (bbox.length === 4){
              const cs = [[bbox[0],bbox[1]],[bbox[2],bbox[1]],[bbox[2],bbox[3]],[bbox[0],bbox[3]]]
                .map(([x, y]) => [mapx(sub.ctm, x, y), mapy(sub.ctm, x, y)]);
              const bb = [Math.min(...cs.map(c=>c[0])), Math.min(...cs.map(c=>c[1])),
                          Math.max(...cs.map(c=>c[0])), Math.max(...cs.map(c=>c[1]))];
              sub.clip = intersectBox(sub.clip, bb);
            }
            const subRes = g(xo.dict.Resources) || resources;
            let data = null;
            try { data = xo.data; } catch (e){}
            if (data) this.execute(data, subRes, sub, depth + 1);
          }
          break;
        }

        /* ---- 内联图片 ---- */
        case "BI": {
          const r = this.readInlineImage(parser, resources, gs, hiddenDepth > 0);
          if (!r) { this.note("内联图片解析失败，已跳过"); }
          break;
        }

        /* ---- 渐变 ---- */
        case "sh": {
          const n = A[A.length-1];
          if (n instanceof Name){
            const sd = g(resources.Shading);
            const s = sd ? g(sd[n.name]) : null;
            if (s) this.emitShading(s, gs, hiddenDepth > 0);
          }
          break;
        }

        /* ---- 标记内容 / 可选内容图层 ---- */
        case "BDC": {
          const tag = A[A.length-2], prop = A[A.length-1];
          let hidden = false;
          if (tag instanceof Name && tag.name === "OC"){
            let ref = null;
            if (prop instanceof Name){
              const pd = g(resources.Properties);
              ref = pd ? pd[prop.name] : null;
            } else ref = prop;
            hidden = this.ocgHidden(ref);
            if (hidden) this.note("跳过了被设为隐藏的可选内容图层（阅读器里也看不见）");
          }
          mcStack.push({ hidden });
          if (hidden) hiddenDepth++;
          break;
        }
        case "BMC": mcStack.push({ hidden: false }); break;
        case "EMC": { const m = mcStack.pop(); if (m && m.hidden) hiddenDepth--; break; }

        case "d0": case "d1": break;                 // Type3 字形度量
        default: break;
      }
      args.length = 0;
    }

    if (cur && cur.pts.length > 1) path.push(cur);
  }

  /* ---------- 图案 / 渐变填充 ---------- */
  resolvePattern(nameObj, resources, gs){
    const doc = this.doc, g = v => doc.get(v);
    const pd = g(resources.Pattern);
    const p = pd ? g(pd[nameObj.name]) : null;
    if (!p) return { kind: "unknown" };
    const dict = p instanceof PStream ? p.dict : p;
    const ptype = g(dict.PatternType);
    if (ptype === 2){
      const sh = g(dict.Shading);
      const info = this.shadingInfo(sh);
      const mtx = (g(dict.Matrix) || MI).map(v => g(v));
      if (info) info.matrix = mmul(mtx, gs.ctm);
      return info || { kind: "gradient", stops: [] };
    }
    return { kind: "tiling" };
  }

  shadingInfo(sh){
    const doc = this.doc, g = v => doc.get(v);
    sh = g(sh);
    if (!sh) return null;
    const d = sh instanceof PStream ? sh.dict : sh;
    const type = g(d.ShadingType);
    const cs = parseColorSpace(d.ColorSpace, doc, null, 0);
    let fnObj = g(d.Function);
    if (Array.isArray(fnObj)) fnObj = g(fnObj[0]);
    let fn = null;
    try { if (fnObj) fn = new PdfFunction(fnObj, doc); } catch (e){}
    const stops = [];
    if (fn){
      for (const t of [0, 0.5, 1]){
        try {
          const rgb = cs.toRGB(fn.eval(fn.domain[0] + t * (fn.domain[1] - fn.domain[0])));
          if (rgb) stops.push({ t, hex: toHex(rgb[0], rgb[1], rgb[2]) });
        } catch (e){}
      }
    }
    const coords = (g(d.Coords) || []).map(v => g(v));
    return {
      kind: "gradient",
      shadingType: type,
      typeName: type === 2 ? "线性渐变" : type === 3 ? "径向渐变" : type === 1 ? "函数渐变" : "网格渐变",
      stops, coords,
      approx: fn ? !!fn.approx : true
    };
  }

  emitShading(sh, gs, hidden){
    const info = this.shadingInfo(sh);
    if (!info) return;
    const bb = gs.clip ? gs.clip.slice() : [0, 0, this.page.w, this.page.h];
    this.items.push({
      seq: this.seq++, kind: "shading", bbox: bb, gradient: info,
      alpha: gs.fillAlpha, hidden, clip: gs.clip
    });
  }

  /* ---------- 文本 ---------- */
  showTextArray(arr, gs, tm, hidden){
    /* TJ 里的数字是字距调整，PDF 常靠它摆词间距而不写空格字符。
       但「该不该补空格」不在这里判 —— 单看一个调整值分不清
       「词间距」和「整行 letter-spacing」，必须有整行上下文。
       这里只忠实地推进文本矩阵，补空格交给 4-layout 的 buildLines。 */
    let out = tm;
    for (const el of arr){
      if (typeof el === "number"){
        const shift = -el / 1000 * gs.fontSize * gs.hscale;
        out = mmul([1, 0, 0, 1, shift, 0], out);
      } else if (el instanceof PStr){
        out = this.showText(el.bytes, gs, out, hidden);
      }
    }
    return out;
  }

  showText(bytes, gs, tm, hidden){
    const font = gs.font;
    if (!font){
      /* 没有字体就无法确定编码。如实记录，不猜。 */
      this.pendingNoFont = (this.pendingNoFont || 0) + 1;
      return tm;
    }
    const fs = gs.fontSize;
    const codes = font.splitCodes(bytes);
    const trm0 = mmul(mmul([fs * gs.hscale, 0, 0, fs, 0, gs.rise], tm), gs.ctm);

    let text = "";
    let anyBad = false, badCount = 0;
    const glyphXs = [];
    let localTm = tm;
    let firstTrm = null;

    for (const { code } of codes){
      const trm = mmul(mmul([fs * gs.hscale, 0, 0, fs, 0, gs.rise], localTm), gs.ctm);
      if (!firstTrm) firstTrm = trm;
      const u = font.unicodeOf(code);
      if (u.ok) text += u.text;
      else { anyBad = true; badCount++; text += "�"; }
      glyphXs.push(mapx(trm, 0, 0));

      const w0 = font.widthOf(code);
      const isSpaceCode = font.type !== "composite" && code === 32;
      const tx = (w0 * fs + gs.charSpace + (isSpaceCode ? gs.wordSpace : 0)) * gs.hscale;
      localTm = mmul([1, 0, 0, 1, tx, 0], localTm);
    }

    const trmEnd = mmul(mmul([fs * gs.hscale, 0, 0, fs, 0, gs.rise], localTm), gs.ctm);
    const x0 = mapx(firstTrm || trm0, 0, 0), y0 = mapy(firstTrm || trm0, 0, 0);
    const x1 = mapx(trmEnd, 0, 0), y1 = mapy(trmEnd, 0, 0);

    /* 设备空间下的视觉字号 = 文本空间垂直单位向量的长度 */
    const t0 = firstTrm || trm0;
    const sizeDev = Math.hypot(t0[2], t0[3]);
    const rot = Math.atan2(t0[1], t0[0]) * 180 / Math.PI;

    /* 不可见文字（渲染模式 3/7）照样记录，只打标记。
       过滤和计数统一由 4-layout 做 —— 在这里直接丢掉的话，
       上层就数不出「跳过了多少段不可见文字」，用户看不到扫描件 OCR 层的线索。 */
    if (text.length){
      const rgb = gs.fillCS.toRGB(gs.fill);
      const srgb = gs.strokeCS.toRGB(gs.stroke);
      /* 描边模式(Tr 1/2)下颜色以描边色为准 */
      const useStroke = gs.render === 1 || gs.render === 5;
      const col = useStroke ? srgb : rgb;
      this.items.push({
        seq: this.seq++, kind: "text",
        text, x0, y0, x1, y1,
        size: sizeDev, rot,
        font, fontName: font.name, bold: font.bold, italic: font.italic,
        color: col ? toHex(col[0], col[1], col[2]) : null,
        colorIsPattern: !col,
        alpha: useStroke ? gs.strokeAlpha : gs.fillAlpha,
        invisible: gs.render === 3 || gs.render === 7,
        renderMode: gs.render,
        hidden, clip: gs.clip,
        glyphXs, badCount, unreliable: anyBad,
        charSpace: gs.charSpace, wordSpace: gs.wordSpace, hscale: gs.hscale
      });
    }
    return localTm;
  }

  /* ---------- 路径 ---------- */
  emitPath(subpaths, gs, doFill, doStroke, evenOdd, hidden){
    const bb = pathBBox(subpaths);
    if (!bb) return;
    const fillRGB = doFill ? (gs.fillPattern ? null : gs.fillCS.toRGB(gs.fill)) : null;
    const strokeRGB = doStroke ? (gs.strokePattern ? null : gs.strokeCS.toRGB(gs.stroke)) : null;
    const lw = gs.lineWidth * mscale(gs.ctm);
    this.items.push({
      seq: this.seq++, kind: "path",
      subpaths, bbox: bb,
      fill: fillRGB ? toHex(fillRGB[0], fillRGB[1], fillRGB[2]) : null,
      fillPattern: doFill ? gs.fillPattern : null,
      stroke: strokeRGB ? toHex(strokeRGB[0], strokeRGB[1], strokeRGB[2]) : null,
      strokePattern: doStroke ? gs.strokePattern : null,
      lineWidth: lw, dash: gs.dash, lineCap: gs.lineCap, lineJoin: gs.lineJoin,
      evenOdd,
      fillAlpha: gs.fillAlpha, strokeAlpha: gs.strokeAlpha,
      blend: gs.blend, softMask: gs.softMask,
      hidden, clip: gs.clip
    });
  }

  /* ---------- 图片 ---------- */
  emitImage(xo, gs, resName, hidden){
    const doc = this.doc, g = v => doc.get(v);
    const d = xo.dict;
    /* 单位正方形经 CTM 变换后就是图片在页面上的位置 */
    const cs = [[0,0],[1,0],[1,1],[0,1]].map(([x, y]) => [mapx(gs.ctm, x, y), mapy(gs.ctm, x, y)]);
    const bb = [Math.min(...cs.map(c=>c[0])), Math.min(...cs.map(c=>c[1])),
                Math.max(...cs.map(c=>c[0])), Math.max(...cs.map(c=>c[1]))];
    const w = g(d.Width) || g(d.W) || 0, h = g(d.Height) || g(d.H) || 0;
    const isMask = g(d.ImageMask) === true || g(d.IM) === true;
    let csName = null;
    try {
      const c = parseColorSpace(d.ColorSpace !== undefined ? d.ColorSpace : d.CS, doc, null, 0);
      csName = c.kind;
    } catch (e){}
    this.items.push({
      seq: this.seq++, kind: "image",
      bbox: bb, corners: cs,
      pixW: w, pixH: h,
      format: imageFilterOf(d, doc) || "位图(未压缩或Flate)",
      isMask, colorSpace: csName,
      bpc: g(d.BitsPerComponent) || g(d.BPC) || (isMask ? 1 : 8),
      resName, alpha: gs.fillAlpha, hidden, clip: gs.clip,
      hasSMask: !!(d.SMask || d.Mask),
      rot: Math.atan2(gs.ctm[1], gs.ctm[0]) * 180 / Math.PI,
      stream: xo
    });
  }

  readInlineImage(parser, resources, gs, hidden){
    /* BI <键值对> ID <二进制数据> EI */
    const lex = parser.lex;
    const b = lex.b;
    const d = Object.create(null);
    for (;;){
      const t = lex.next();
      if (t.t === "eof") return false;
      if (t.t === "kw" && t.v === "ID") break;
      if (t.t !== "name") continue;
      const key = t.v;
      const p2 = new Parser(b, lex.p, null);
      const v = p2.parse();
      lex.p = p2.lex.p;
      d[key] = v;
    }
    let p = lex.p;
    if (WS[b[p]]) p++;
    const start = p;
    /* 找 EI：必须前后都是空白，避免撞上二进制数据里的字节 */
    let end = -1;
    for (let i = start; i < b.length - 1; i++){
      if (b[i] === 69 && b[i + 1] === 73 && (i === 0 || WS[b[i - 1]])){
        const after = b[i + 2];
        if (after === undefined || WS[after] || DELIM[after]){ end = i; break; }
      }
    }
    if (end < 0) end = b.length;
    lex.p = Math.min(b.length, end + 2);

    const cs = [[0,0],[1,0],[1,1],[0,1]].map(([x, y]) => [mapx(gs.ctm, x, y), mapy(gs.ctm, x, y)]);
    const bb = [Math.min(...cs.map(c=>c[0])), Math.min(...cs.map(c=>c[1])),
                Math.max(...cs.map(c=>c[0])), Math.max(...cs.map(c=>c[1]))];
    this.items.push({
      seq: this.seq++, kind: "image", inline: true,
      bbox: bb, corners: cs,
      pixW: this.doc.get(d.W) || this.doc.get(d.Width) || 0,
      pixH: this.doc.get(d.H) || this.doc.get(d.Height) || 0,
      format: imageFilterOf(d, this.doc) || "内联位图",
      isMask: this.doc.get(d.IM) === true || this.doc.get(d.ImageMask) === true,
      bpc: this.doc.get(d.BPC) || this.doc.get(d.BitsPerComponent) || 8,
      resName: "（内联）", alpha: gs.fillAlpha, hidden, clip: gs.clip,
      rot: Math.atan2(gs.ctm[1], gs.ctm[0]) * 180 / Math.PI
    });
    return true;
  }
}

/* ---------- 几何小工具 ---------- */
function pathBBox(subpaths){
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of subpaths) for (const [x, y] of sp.pts){
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return isFinite(x0) ? [x0, y0, x1, y1] : null;
}
function intersectBox(a, b){
  if (!a) return b ? b.slice() : null;
  if (!b) return a.slice();
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}
const boxW = b => b ? Math.max(0, b[2] - b[0]) : 0;
const boxH = b => b ? Math.max(0, b[3] - b[1]) : 0;
function boxOverlap(a, b){
  if (!a || !b) return 0;
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return (w > 0 && h > 0) ? w * h : 0;
}
