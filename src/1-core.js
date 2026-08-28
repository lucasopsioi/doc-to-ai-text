/* ============================================================
   1-core.js —— PDF 文件结构层
   词法/对象模型 · 解压滤镜 · 加密 · xref/页树
   零第三方依赖。所有函数同步，方便上层直白地写逻辑。
   ============================================================ */

/* ==================== 字节工具 ==================== */
const WS = new Uint8Array(256); [0,9,10,12,13,32].forEach(c => WS[c] = 1);
const DELIM = new Uint8Array(256); [40,41,60,62,91,93,123,125,47,37].forEach(c => DELIM[c] = 1);
const REG = new Uint8Array(256); for (let i = 0; i < 256; i++) REG[i] = (WS[i] || DELIM[i]) ? 0 : 1;

const latin1 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; };
const bytesOf = str => { const a = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff; return a; };
const concatBytes = list => {
  let n = 0; for (const b of list) n += b.length;
  const out = new Uint8Array(n); let p = 0;
  for (const b of list){ out.set(b, p); p += b.length; }
  return out;
};

/* 在 buf 中从 from 起找子串（子串给 latin1 字符串） */
function indexOfBytes(buf, needle, from){
  const n = bytesOf(needle), last = buf.length - n.length;
  outer: for (let i = Math.max(0, from); i <= last; i++){
    for (let j = 0; j < n.length; j++) if (buf[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}
function lastIndexOfBytes(buf, needle, from){
  const n = bytesOf(needle);
  for (let i = Math.min(from, buf.length - n.length); i >= 0; i--){
    let ok = true;
    for (let j = 0; j < n.length; j++) if (buf[i + j] !== n[j]){ ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

/* ==================== PDF 对象模型 ==================== */
class Name {
  constructor(n){ this.name = n; }
  toString(){ return "/" + this.name; }
}
const NAME_CACHE = new Map();
const nm = n => { let v = NAME_CACHE.get(n); if (!v){ v = new Name(n); NAME_CACHE.set(n, v); } return v; };

class Ref {
  constructor(num, gen){ this.num = num; this.gen = gen; }
  get key(){ return this.num + "_" + this.gen; }
}

class PStr {                       // PDF 字符串，内部一律以字节保存
  constructor(bytes){ this.bytes = bytes; }
  get latin1(){ return latin1(this.bytes); }
}

class PStream {
  constructor(dict, raw, doc, num, gen){
    this.dict = dict; this.raw = raw; this.doc = doc;
    this.num = num; this.gen = gen; this._data = null;
  }
  /* 解密 + 逐级解滤镜后的字节 */
  get data(){
    if (this._data) return this._data;
    let bytes = this.raw;
    const d = this.doc;
    if (d && d.decryptor && !this.noDecrypt) bytes = d.decryptor.stream(bytes, this.num, this.gen);
    this._data = applyFilters(bytes, this.dict, d);
    return this._data;
  }
  /* 只解密不解滤镜——图片要拿原始 JPEG 字节时用 */
  get rawDecrypted(){
    const d = this.doc;
    return (d && d.decryptor && !this.noDecrypt) ? d.decryptor.stream(this.raw, this.num, this.gen) : this.raw;
  }
}

/* ==================== 词法分析 ==================== */
class Lexer {
  constructor(buf, pos){ this.b = buf; this.p = pos || 0; }

  skipWs(){
    const b = this.b;
    for (;;){
      while (this.p < b.length && WS[b[this.p]]) this.p++;
      if (b[this.p] === 37){                       // % 注释
        while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
      } else return;
    }
  }

  /* 返回 {t, v}；t: num name str kw [ ] << >> { } eof */
  next(){
    this.skipWs();
    const b = this.b;
    if (this.p >= b.length) return { t: "eof" };
    const c = b[this.p];

    if (c === 47){ this.p++; return { t: "name", v: this.readName() }; }
    if (c === 40){ this.p++; return { t: "str",  v: this.readLiteralStr() }; }
    if (c === 60){
      if (b[this.p + 1] === 60){ this.p += 2; return { t: "<<" }; }
      this.p++; return { t: "str", v: this.readHexStr() };
    }
    if (c === 62){ if (b[this.p + 1] === 62){ this.p += 2; return { t: ">>" }; } this.p++; return this.next(); }
    if (c === 91){ this.p++; return { t: "[" }; }
    if (c === 93){ this.p++; return { t: "]" }; }
    if (c === 123){ this.p++; return { t: "{" }; }
    if (c === 125){ this.p++; return { t: "}" }; }
    if (c === 41){ this.p++; return this.next(); }   // 孤立右括号，跳过

    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46){
      const start = this.p;
      this.p++;
      while (this.p < b.length){
        const d = b[this.p];
        if ((d >= 48 && d <= 57) || d === 46 || d === 45 || d === 43 || d === 69 || d === 101) this.p++;
        else break;
      }
      const s = latin1(b.subarray(start, this.p));
      const v = parseFloat(s);
      return { t: "num", v: isFinite(v) ? v : 0 };
    }

    /* 关键字 */
    const start = this.p;
    while (this.p < b.length && REG[b[this.p]]) this.p++;
    if (this.p === start){ this.p++; return this.next(); }   // 无法识别的分隔符，跳过
    return { t: "kw", v: latin1(b.subarray(start, this.p)) };
  }

  readName(){
    const b = this.b, start = this.p;
    while (this.p < b.length && REG[b[this.p]]) this.p++;
    let s = latin1(b.subarray(start, this.p));
    if (s.indexOf("#") >= 0) s = s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return s;
  }

  readLiteralStr(){
    const b = this.b, out = [];
    let depth = 1;
    while (this.p < b.length){
      let c = b[this.p++];
      if (c === 92){                                 // 反斜杠转义
        c = b[this.p++];
        if (c === 110) out.push(10);
        else if (c === 114) out.push(13);
        else if (c === 116) out.push(9);
        else if (c === 98) out.push(8);
        else if (c === 102) out.push(12);
        else if (c >= 48 && c <= 55){                // 八进制
          let v = c - 48;
          for (let k = 0; k < 2; k++){
            const d = b[this.p];
            if (d >= 48 && d <= 55){ v = v * 8 + (d - 48); this.p++; } else break;
          }
          out.push(v & 0xff);
        }
        else if (c === 13){ if (b[this.p] === 10) this.p++; }   // 续行
        else if (c === 10){ /* 续行 */ }
        else out.push(c);
      }
      else if (c === 40){ depth++; out.push(c); }
      else if (c === 41){ depth--; if (!depth) break; out.push(c); }
      else out.push(c);
    }
    return new PStr(Uint8Array.from(out));
  }

  readHexStr(){
    const b = this.b, out = [];
    let hi = -1;
    while (this.p < b.length){
      const c = b[this.p++];
      if (c === 62) break;
      let v = -1;
      if (c >= 48 && c <= 57) v = c - 48;
      else if (c >= 65 && c <= 70) v = c - 55;
      else if (c >= 97 && c <= 102) v = c - 87;
      else continue;
      if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);                  // 奇数位补 0
    return new PStr(Uint8Array.from(out));
  }
}

/* ==================== 对象解析（递归下降） ==================== */
class Parser {
  constructor(buf, pos, doc){ this.lex = new Lexer(buf, pos); this.doc = doc; this.stack = []; }
  get p(){ return this.lex.p; }
  set p(v){ this.lex.p = v; }

  nextTok(){ return this.stack.length ? this.stack.pop() : this.lex.next(); }
  push(t){ this.stack.push(t); }

  /* 解析一个对象；遇到关键字（如运算符）时返回 {op} */
  parse(objNum, objGen){
    const t = this.nextTok();
    return this.parseFrom(t, objNum, objGen);
  }

  parseFrom(t, objNum, objGen){
    switch (t.t){
      case "eof": return undefined;
      case "num": {
        /* 可能是 "num gen R" 引用 */
        const save = this.lex.p, saveStack = this.stack.slice();
        const t2 = this.nextTok();
        if (t2.t === "num" && Number.isInteger(t.v) && Number.isInteger(t2.v) && t.v >= 0){
          const t3 = this.nextTok();
          if (t3.t === "kw" && t3.v === "R") return new Ref(t.v, t2.v);
          this.stack = saveStack; this.lex.p = save;
          return t.v;
        }
        this.stack = saveStack; this.lex.p = save;
        return t.v;
      }
      case "name": return nm(t.v);
      case "str":  {
        if (this.doc && this.doc.decryptor && objNum !== undefined && !this.doc.inObjStm)
          return new PStr(this.doc.decryptor.string(t.v.bytes, objNum, objGen));
        return t.v;
      }
      case "[": {
        const arr = [];
        for (;;){
          const e = this.nextTok();
          if (e.t === "]" || e.t === "eof") break;
          const v = this.parseFrom(e, objNum, objGen);
          if (v && v.op) continue;
          arr.push(v);
        }
        return arr;
      }
      case "<<": {
        const d = Object.create(null);
        for (;;){
          const k = this.nextTok();
          if (k.t === ">>" || k.t === "eof") break;
          if (k.t !== "name"){ continue; }
          d[k.v] = this.parse(objNum, objGen);
        }
        /* 后面跟 stream？ */
        const save = this.lex.p, saveStack = this.stack.slice();
        const s = this.nextTok();
        if (s.t === "kw" && s.v === "stream") return this.readStream(d, objNum, objGen);
        this.stack = saveStack; this.lex.p = save;
        return d;
      }
      case "kw":
        if (t.v === "true") return true;
        if (t.v === "false") return false;
        if (t.v === "null") return null;
        return { op: t.v };
      default: return { op: t.t };
    }
  }

  readStream(dict, objNum, objGen){
    const b = this.lex.b;
    let p = this.lex.p;
    /* stream 关键字后必须是 CRLF 或 LF */
    if (b[p] === 13) p++;
    if (b[p] === 10) p++;
    const start = p;

    let len = this.doc ? this.doc.get(dict.Length) : dict.Length;
    let end = -1;
    if (typeof len === "number" && len >= 0 && start + len <= b.length){
      end = start + len;
      /* 校验：Length 之后应能很快见到 endstream。研报类 PDF 里 Length 错得很常见 */
      const probe = latin1(b.subarray(end, Math.min(end + 20, b.length)));
      if (!/^\s*endstream/.test(probe)) end = -1;
    }
    if (end < 0){                                    // Length 不可信 —— 自己找 endstream
      const e = indexOfBytes(b, "endstream", start);
      end = e < 0 ? b.length : e;
      /* endstream 前的换行不属于数据 */
      if (b[end - 1] === 10) { if (b[end - 2] === 13) end -= 2; else end -= 1; }
      else if (b[end - 1] === 13) end -= 1;
    }

    const raw = b.subarray(start, Math.max(start, end));
    /* 把游标推到 endstream 之后 */
    const e2 = indexOfBytes(b, "endstream", Math.max(start, end) - 1);
    this.lex.p = e2 < 0 ? b.length : e2 + 9;
    this.stack.length = 0;
    return new PStream(dict, raw, this.doc, objNum, objGen);
  }
}

/* ==================== inflate（自实现，同步） ==================== */
const L_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const L_EXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const D_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const D_EXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const CL_IDX = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

function buildHuff(lengths, n, off){
  const counts = new Int32Array(16);
  for (let i = 0; i < n; i++) counts[lengths[off + i]]++;
  counts[0] = 0;
  const offs = new Int32Array(16);
  let t = 0;
  for (let i = 1; i < 16; i++){ offs[i] = t; t += counts[i]; }
  const symbols = new Int32Array(n);
  for (let i = 0; i < n; i++) if (lengths[off + i]) symbols[offs[lengths[off + i]]++] = i;
  return { counts, symbols };
}

class BitReader {
  constructor(b){ this.b = b; this.p = 0; this.bit = 0; this.buf = 0; }
  getBit(){
    if (this.bit === 0){ this.buf = this.p < this.b.length ? this.b[this.p++] : 0; this.bit = 8; }
    const v = this.buf & 1; this.buf >>= 1; this.bit--;
    return v;
  }
  getBits(n){ let v = 0; for (let i = 0; i < n; i++) v |= this.getBit() << i; return v; }
  align(){ this.bit = 0; }
}

function decodeSym(br, tree){
  let code = 0, first = 0, index = 0;
  for (let len = 1; len < 16; len++){
    code |= br.getBit();
    const count = tree.counts[len];
    if (code - first < count) return tree.symbols[index + (code - first)];
    index += count; first = (first + count) << 1; code <<= 1;
  }
  throw new Error("inflate: 无效的 Huffman 码");
}

const FIXED_LIT = (() => { const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8; for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7; for (let i = 280; i < 288; i++) l[i] = 8;
  return buildHuff(l, 288, 0); })();
const FIXED_DIST = (() => { const l = new Uint8Array(30).fill(5); return buildHuff(l, 30, 0); })();

function inflateRaw(data){
  const br = new BitReader(data);
  let out = new Uint8Array(Math.max(1024, data.length * 4)), o = 0;
  const grow = need => {
    if (o + need <= out.length) return;
    let cap = out.length;
    while (cap < o + need) cap *= 2;
    const n = new Uint8Array(cap); n.set(out.subarray(0, o)); out = n;
  };

  for (;;){
    const last = br.getBit();
    const type = br.getBits(2);

    if (type === 0){                                   // 存储块
      br.align();
      if (br.p + 4 > data.length) break;
      const len = data[br.p] | (data[br.p + 1] << 8);
      br.p += 4;
      grow(len);
      out.set(data.subarray(br.p, br.p + len), o);
      o += len; br.p += len;
    }
    else if (type === 1 || type === 2){
      let lit, dist;
      if (type === 1){ lit = FIXED_LIT; dist = FIXED_DIST; }
      else {
        const hlit = br.getBits(5) + 257, hdist = br.getBits(5) + 1, hclen = br.getBits(4) + 4;
        const clLen = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLen[CL_IDX[i]] = br.getBits(3);
        const clTree = buildHuff(clLen, 19, 0);
        const lens = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < hlit + hdist){
          const sym = decodeSym(br, clTree);
          if (sym === 16){ const prev = lens[i - 1]; let r = br.getBits(2) + 3; while (r--) lens[i++] = prev; }
          else if (sym === 17){ let r = br.getBits(3) + 3;  while (r--) lens[i++] = 0; }
          else if (sym === 18){ let r = br.getBits(7) + 11; while (r--) lens[i++] = 0; }
          else lens[i++] = sym;
        }
        lit = buildHuff(lens, hlit, 0);
        dist = buildHuff(lens, hdist, hlit);
      }
      for (;;){
        const sym = decodeSym(br, lit);
        if (sym === 256) break;
        if (sym < 256){ grow(1); out[o++] = sym; }
        else {
          const li = sym - 257;
          if (li >= L_BASE.length) throw new Error("inflate: 长度码越界");
          const length = L_BASE[li] + br.getBits(L_EXT[li]);
          const ds = decodeSym(br, dist);
          if (ds >= D_BASE.length) throw new Error("inflate: 距离码越界");
          const d = D_BASE[ds] + br.getBits(D_EXT[ds]);
          if (d > o) throw new Error("inflate: 距离超出已解数据");
          grow(length);
          let src = o - d;
          for (let k = 0; k < length; k++) out[o++] = out[src++];
        }
        if (br.p > data.length + 4) throw new Error("inflate: 数据提前结束");
      }
    }
    else throw new Error("inflate: 保留的块类型");

    if (last) break;
    if (br.p >= data.length && br.bit === 0) break;
  }
  return out.subarray(0, o);
}

/* zlib 包装检测 + 容错：有些 PDF 的流前面粘了垃圾字节。
   注意「成功但结果为空」和「失败」必须分开——一个合法的空流如果被当成失败，
   会掉进后面的容错分支，把 zlib 头当 deflate 数据解出一堆垃圾。 */
function flateDecode(data){
  if (!data.length) return data;
  const tryAt = off => {
    if (off >= data.length) return null;
    try { return inflateRaw(data.subarray(off)); } catch (e){ return null; }
  };
  /* 标准 zlib 头：CMF 低四位为 8，且 CMF/FLG 组成的 16 位数能被 31 整除 */
  const cmf = data[0], flg = data[1];
  if ((cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0){
    const r = tryAt(2);
    if (r) return r;                      // 空结果也算成功
  }
  const r0 = tryAt(0); if (r0 && r0.length) return r0;
  const r2 = tryAt(2); if (r2 && r2.length) return r2;
  /* 跳过前导空白后再试一次 */
  let s = 0; while (s < data.length && WS[data[s]]) s++;
  if (s){
    const r = tryAt(s); if (r && r.length) return r;
    const r2b = tryAt(s + 2); if (r2b && r2b.length) return r2b;
  }
  return new Uint8Array(0);
}

/* ==================== 其它滤镜 ==================== */
function lzwDecode(data, early){
  const out = [];
  const dict = [];
  const reset = () => { dict.length = 0; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null); dict.push(null); };
  reset();
  let codeLen = 9, prev = null, bitBuf = 0, bitCnt = 0, p = 0;
  const e = early === 0 ? 0 : 1;
  for (;;){
    while (bitCnt < codeLen){
      if (p >= data.length){ bitCnt = -1; break; }
      bitBuf = (bitBuf << 8) | data[p++]; bitCnt += 8;
    }
    if (bitCnt < 0) break;
    const code = (bitBuf >> (bitCnt - codeLen)) & ((1 << codeLen) - 1);
    bitCnt -= codeLen;
    if (code === 256){ reset(); codeLen = 9; prev = null; continue; }
    if (code === 257) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat([prev[0]]);
    else break;
    for (const b of entry) out.push(b);
    if (prev) dict.push(prev.concat([entry[0]]));
    prev = entry;
    if (dict.length + e >= (1 << codeLen) && codeLen < 12) codeLen++;
  }
  return Uint8Array.from(out);
}

function a85Decode(data){
  const out = []; let tuple = 0, cnt = 0;
  for (let i = 0; i < data.length; i++){
    const c = data[i];
    if (WS[c]) continue;
    if (c === 126) break;                            // ~>
    if (c === 122 && cnt === 0){ out.push(0,0,0,0); continue; }   // z
    if (c < 33 || c > 117) continue;
    tuple = tuple * 85 + (c - 33); cnt++;
    if (cnt === 5){
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0; cnt = 0;
    }
  }
  if (cnt > 1){
    for (let i = cnt; i < 5; i++) tuple = tuple * 85 + 84;
    const b = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255];
    for (let i = 0; i < cnt - 1; i++) out.push(b[i]);
  }
  return Uint8Array.from(out);
}

function ahxDecode(data){
  const out = []; let hi = -1;
  for (let i = 0; i < data.length; i++){
    const c = data[i];
    if (c === 62) break;
    let v = -1;
    if (c >= 48 && c <= 57) v = c - 48;
    else if (c >= 65 && c <= 70) v = c - 55;
    else if (c >= 97 && c <= 102) v = c - 87;
    else continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

function rleDecode(data){
  const out = []; let p = 0;
  while (p < data.length){
    const n = data[p++];
    if (n === 128) break;
    if (n < 128){ for (let i = 0; i <= n; i++) out.push(data[p++]); }
    else { const b = data[p++]; for (let i = 0; i < 257 - n; i++) out.push(b); }
  }
  return Uint8Array.from(out);
}

/* PNG / TIFF 预测器 —— xref 流和图片都要用 */
function unpredict(data, params, doc){
  const g = k => doc ? doc.get(params[k]) : params[k];
  const pred = g("Predictor") || 1;
  if (pred <= 1) return data;
  const colors = g("Colors") || 1;
  const bpc = g("BitsPerComponent") || 8;
  const columns = g("Columns") || 1;
  const bpp = Math.ceil(colors * bpc / 8);
  const rowLen = Math.ceil(colors * bpc * columns / 8);

  if (pred === 2){                                    // TIFF
    if (bpc !== 8) return data;
    for (let r = 0; r + rowLen <= data.length; r += rowLen)
      for (let i = bpp; i < rowLen; i++) data[r + i] = (data[r + i] + data[r + i - bpp]) & 255;
    return data;
  }
  /* PNG：每行前多一个滤镜类型字节 */
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++){
    const ft = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen);
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    cur.set(src);
    for (let i = 0; i < rowLen; i++){
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      switch (ft){
        case 1: cur[i] = (cur[i] + a) & 255; break;
        case 2: cur[i] = (cur[i] + b) & 255; break;
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255; break;
        }
      }
    }
    prev = cur;
  }
  return out;
}

/* 图像类滤镜不解码，原样交给上层（上层只报格式，不解像素） */
const IMAGE_FILTERS = { DCTDecode: "JPEG", JPXDecode: "JPEG2000", JBIG2Decode: "JBIG2", CCITTFaxDecode: "CCITT传真" };

function applyFilters(bytes, dict, doc){
  const g = v => doc ? doc.get(v) : v;
  let filters = g(dict.Filter !== undefined ? dict.Filter : dict.F);
  if (!filters) return bytes;
  if (filters instanceof Name) filters = [filters];
  if (!Array.isArray(filters)) return bytes;
  let parms = g(dict.DecodeParms !== undefined ? dict.DecodeParms : dict.DP);
  if (!Array.isArray(parms)) parms = [parms];

  let data = bytes;
  for (let i = 0; i < filters.length; i++){
    const f = g(filters[i]);
    if (!(f instanceof Name)) continue;
    const pr = g(parms[i]) || Object.create(null);
    switch (f.name){
      case "FlateDecode": case "Fl":
        data = flateDecode(data);
        if (pr && pr.Predictor) data = unpredict(data, pr, doc);
        break;
      case "LZWDecode": case "LZW":
        data = lzwDecode(data, doc ? doc.get(pr.EarlyChange) : pr.EarlyChange);
        if (pr && pr.Predictor) data = unpredict(data, pr, doc);
        break;
      case "ASCII85Decode": case "A85": data = a85Decode(data); break;
      case "ASCIIHexDecode": case "AHx": data = ahxDecode(data); break;
      case "RunLengthDecode": case "RL": data = rleDecode(data); break;
      case "Crypt": break;
      default:
        if (IMAGE_FILTERS[f.name]) return data;      // 图像流，保持原样
        break;
    }
  }
  return data;
}

function imageFilterOf(dict, doc){
  const g = v => doc ? doc.get(v) : v;
  let filters = g(dict.Filter !== undefined ? dict.Filter : dict.F);
  if (!filters) return null;
  if (filters instanceof Name) filters = [filters];
  if (!Array.isArray(filters)) return null;
  for (const f0 of filters){ const f = g(f0); if (f instanceof Name && IMAGE_FILTERS[f.name]) return IMAGE_FILTERS[f.name]; }
  return null;
}

/* ==================== MD5 / RC4 / AES ==================== */
function md5(bytes){
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22, 5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23, 6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const len = bytes.length;
  const padLen = ((len + 8) >> 6 << 6) + 64;
  const m = new Uint8Array(padLen);
  m.set(bytes); m[len] = 0x80;
  const bits = len * 8;
  m[padLen - 8] = bits & 255; m[padLen - 7] = (bits >>> 8) & 255;
  m[padLen - 6] = (bits >>> 16) & 255; m[padLen - 5] = (bits >>> 24) & 255;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const w = new Int32Array(16);
  for (let off = 0; off < padLen; off += 64){
    for (let i = 0; i < 16; i++)
      w[i] = m[off + i*4] | (m[off + i*4 + 1] << 8) | (m[off + i*4 + 2] << 16) | (m[off + i*4 + 3] << 24);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++){
      let F, gi;
      if (i < 16){ F = (B & C) | (~B & D); gi = i; }
      else if (i < 32){ F = (D & B) | (~D & C); gi = (5*i + 1) & 15; }
      else if (i < 48){ F = B ^ C ^ D; gi = (3*i + 5) & 15; }
      else { F = C ^ (B | ~D); gi = (7*i) & 15; }
      F = (F + A + K[i] + w[gi]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => {
    out[i*4] = v & 255; out[i*4+1] = (v >>> 8) & 255; out[i*4+2] = (v >>> 16) & 255; out[i*4+3] = (v >>> 24) & 255;
  });
  return out;
}

function rc4(key, data){
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++){
    j = (j + s[i] + key[i % key.length]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++){
    i = (i + 1) & 255; j = (j + s[i]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

/* 紧凑 AES（128/256，加解密都要——AES-256 的 R6 口令散列需要无填充加密） */
const AES_SBOX = new Uint8Array(256), AES_INV = new Uint8Array(256);
(function(){
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 255) ^ ((p & 0x80) ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >>> 7)) ^ ((q << 2) | (q >>> 6)) ^ ((q << 3) | (q >>> 5)) ^ ((q << 4) | (q >>> 4));
    AES_SBOX[p] = (x ^ 0x63) & 255;
  } while (p !== 1);
  AES_SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) AES_INV[AES_SBOX[i]] = i;
})();
const xt = a => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 255;
const mul = (a, b) => { let r = 0; while (b){ if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };

function aesExpandKey(key){
  const nk = key.length / 4, nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++){
    let t = [w[(i-1)*4], w[(i-1)*4+1], w[(i-1)*4+2], w[(i-1)*4+3]];
    if (i % nk === 0){
      t = [AES_SBOX[t[1]] ^ rcon, AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]];
      rcon = xt(rcon);
    } else if (nk > 6 && i % nk === 4){
      t = t.map(v => AES_SBOX[v]);
    }
    for (let j = 0; j < 4; j++) w[i*4 + j] = w[(i - nk)*4 + j] ^ t[j];
  }
  return { w, nr };
}

function aesEncBlock(st, ks){
  const { w, nr } = ks;
  for (let i = 0; i < 16; i++) st[i] ^= w[i];
  for (let r = 1; r <= nr; r++){
    for (let i = 0; i < 16; i++) st[i] = AES_SBOX[st[i]];
    /* ShiftRows（列主序状态） */
    let t;
    t = st[1]; st[1] = st[5]; st[5] = st[9]; st[9] = st[13]; st[13] = t;
    t = st[2]; st[2] = st[10]; st[10] = t; t = st[6]; st[6] = st[14]; st[14] = t;
    t = st[15]; st[15] = st[11]; st[11] = st[7]; st[7] = st[3]; st[3] = t;
    if (r < nr){
      for (let c = 0; c < 4; c++){
        const a0 = st[c*4], a1 = st[c*4+1], a2 = st[c*4+2], a3 = st[c*4+3];
        st[c*4]   = xt(a0) ^ (xt(a1) ^ a1) ^ a2 ^ a3;
        st[c*4+1] = a0 ^ xt(a1) ^ (xt(a2) ^ a2) ^ a3;
        st[c*4+2] = a0 ^ a1 ^ xt(a2) ^ (xt(a3) ^ a3);
        st[c*4+3] = (xt(a0) ^ a0) ^ a1 ^ a2 ^ xt(a3);
      }
    }
    for (let i = 0; i < 16; i++) st[i] ^= w[r*16 + i];
  }
}

function aesDecBlock(st, ks){
  const { w, nr } = ks;
  for (let i = 0; i < 16; i++) st[i] ^= w[nr*16 + i];
  for (let r = nr - 1; r >= 0; r--){
    /* InvShiftRows */
    let t;
    t = st[13]; st[13] = st[9]; st[9] = st[5]; st[5] = st[1]; st[1] = t;
    t = st[2]; st[2] = st[10]; st[10] = t; t = st[6]; st[6] = st[14]; st[14] = t;
    t = st[3]; st[3] = st[7]; st[7] = st[11]; st[11] = st[15]; st[15] = t;
    for (let i = 0; i < 16; i++) st[i] = AES_INV[st[i]];
    for (let i = 0; i < 16; i++) st[i] ^= w[r*16 + i];
    if (r > 0){
      for (let c = 0; c < 4; c++){
        const a0 = st[c*4], a1 = st[c*4+1], a2 = st[c*4+2], a3 = st[c*4+3];
        st[c*4]   = mul(a0,14) ^ mul(a1,11) ^ mul(a2,13) ^ mul(a3, 9);
        st[c*4+1] = mul(a0, 9) ^ mul(a1,14) ^ mul(a2,11) ^ mul(a3,13);
        st[c*4+2] = mul(a0,13) ^ mul(a1, 9) ^ mul(a2,14) ^ mul(a3,11);
        st[c*4+3] = mul(a0,11) ^ mul(a1,13) ^ mul(a2, 9) ^ mul(a3,14);
      }
    }
  }
}

function aesCbcDecrypt(key, data, ivIncluded, stripPad){
  const ks = aesExpandKey(key);
  let iv, body;
  if (ivIncluded){ iv = data.subarray(0, 16); body = data.subarray(16); }
  else { iv = new Uint8Array(16); body = data; }
  const n = body.length - (body.length % 16);
  const out = new Uint8Array(n);
  const prev = new Uint8Array(iv);
  const blk = new Uint8Array(16), cipher = new Uint8Array(16);
  for (let p = 0; p < n; p += 16){
    cipher.set(body.subarray(p, p + 16));
    blk.set(cipher);
    aesDecBlock(blk, ks);
    for (let i = 0; i < 16; i++) out[p + i] = blk[i] ^ prev[i];
    prev.set(cipher);
  }
  if (stripPad && n){
    const pad = out[n - 1];
    if (pad >= 1 && pad <= 16) return out.subarray(0, n - pad);
  }
  return out;
}

function aesCbcEncryptNoPad(key, iv, data){
  const ks = aesExpandKey(key);
  const n = data.length - (data.length % 16);
  const out = new Uint8Array(n);
  const prev = new Uint8Array(iv);
  const blk = new Uint8Array(16);
  for (let p = 0; p < n; p += 16){
    for (let i = 0; i < 16; i++) blk[i] = data[p + i] ^ prev[i];
    aesEncBlock(blk, ks);
    out.set(blk, p);
    prev.set(blk);
  }
  return out;
}

/* SHA-256/384/512 —— R6 口令散列要用。自实现以保持同步。 */
const K256 = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);

function sha256(bytes){
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const len = bytes.length, padLen = (((len + 8) >> 6) + 1) << 6;
  const m = new Uint8Array(padLen);
  m.set(bytes); m[len] = 0x80;
  const bits = len * 8;
  new DataView(m.buffer).setUint32(padLen - 4, bits >>> 0);
  new DataView(m.buffer).setUint32(padLen - 8, Math.floor(bits / 4294967296));
  const w = new Uint32Array(64), dv = new DataView(m.buffer);
  for (let off = 0; off < padLen; off += 64){
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i*4);
    for (let i = 16; i < 64; i++){
      const a = w[i-15], b = w[i-2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++){
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
  }
  const out = new Uint8Array(32), o = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) o.setUint32(i*4, H[i]);
  return out;
}

/* SHA-384/512 用 BigInt 实现——只在 R6 里跑几十轮，性能无所谓 */
const K512 = ["428a2f98d728ae22","7137449123ef65cd","b5c0fbcfec4d3b2f","e9b5dba58189dbbc","3956c25bf348b538","59f111f1b605d019","923f82a4af194f9b","ab1c5ed5da6d8118","d807aa98a3030242","12835b0145706fbe","243185be4ee4b28c","550c7dc3d5ffb4e2","72be5d74f27b896f","80deb1fe3b1696b1","9bdc06a725c71235","c19bf174cf692694","e49b69c19ef14ad2","efbe4786384f25e3","0fc19dc68b8cd5b5","240ca1cc77ac9c65","2de92c6f592b0275","4a7484aa6ea6e483","5cb0a9dcbd41fbd4","76f988da831153b5","983e5152ee66dfab","a831c66d2db43210","b00327c898fb213f","bf597fc7beef0ee4","c6e00bf33da88fc2","d5a79147930aa725","06ca6351e003826f","142929670a0e6e70","27b70a8546d22ffc","2e1b21385c26c926","4d2c6dfc5ac42aed","53380d139d95b3df","650a73548baf63de","766a0abb3c77b2a8","81c2c92e47edaee6","92722c851482353b","a2bfe8a14cf10364","a81a664bbc423001","c24b8b70d0f89791","c76c51a30654be30","d192e819d6ef5218","d69906245565a910","f40e35855771202a","106aa07032bbd1b8","19a4c116b8d2d0c8","1e376c085141ab53","2748774cdf8eeb99","34b0bcb5e19b48a8","391c0cb3c5c95a63","4ed8aa4ae3418acb","5b9cca4f7763e373","682e6ff3d6b2b8a3","748f82ee5defb2fc","78a5636f43172f60","84c87814a1f0ab72","8cc702081a6439ec","90befffa23631e28","a4506cebde82bde9","bef9a3f7b2c67915","c67178f2e372532b","ca273eceea26619c","d186b8c721c0c207","eada7dd6cde0eb1e","f57d4f7fee6ed178","06f067aa72176fba","0a637dc5a2c898a6","113f9804bef90dae","1b710b35131c471b","28db77f523047d84","32caab7b40c72493","3c9ebe0a15c9bebc","431d67c49c100d4c","4cc5d4becb3e42b6","597f299cfc657e2a","5fcb6fab3ad6faec","6c44198c4a475817"].map(h => BigInt("0x" + h));
const M64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & M64;

function sha512core(bytes, H, outBytes){
  const len = bytes.length;
  let padLen = len + 17;
  padLen = Math.ceil(padLen / 128) * 128;
  const m = new Uint8Array(padLen);
  m.set(bytes); m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(padLen - 4, (len * 8) >>> 0);
  dv.setUint32(padLen - 8, Math.floor(len * 8 / 4294967296));
  const w = new Array(80);
  for (let off = 0; off < padLen; off += 128){
    for (let i = 0; i < 16; i++)
      w[i] = (BigInt(dv.getUint32(off + i*8)) << 32n) | BigInt(dv.getUint32(off + i*8 + 4));
    for (let i = 16; i < 80; i++){
      const a = w[i-15], b = w[i-2];
      const s0 = rotr64(a, 1n) ^ rotr64(a, 8n) ^ (a >> 7n);
      const s1 = rotr64(b, 19n) ^ rotr64(b, 61n) ^ (b >> 6n);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) & M64;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 80; i++){
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ ((~e & M64) & g);
      const t1 = (h + S1 + ch + K512[i] + w[i]) & M64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) & M64;
      h = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    const nv = [a,b,c,d,e,f,g,h];
    for (let i = 0; i < 8; i++) H[i] = (H[i] + nv[i]) & M64;
  }
  const out = new Uint8Array(outBytes);
  for (let i = 0; i < outBytes; i++){
    const word = H[i >> 3], shift = BigInt(56 - (i % 8) * 8);
    out[i] = Number((word >> shift) & 0xffn);
  }
  return out;
}
const sha384 = b => sha512core(b, [0xcbbb9d5dc1059ed8n,0x629a292a367cd507n,0x9159015a3070dd17n,0x152fecd8f70e5939n,0x67332667ffc00b31n,0x8eb44a8768581511n,0xdb0c2e0d64f98fa7n,0x47b5481dbefa4fa4n], 48);
const sha512 = b => sha512core(b, [0x6a09e667f3bcc908n,0xbb67ae8584caa73bn,0x3c6ef372fe94f82bn,0xa54ff53a5f1d36f1n,0x510e527fade682d1n,0x9b05688c2b3e6c1fn,0x1f83d9abfb41bd6bn,0x5be0cd19137e2179n], 64);

/* ==================== PDF 标准安全处理器 ==================== */
const PAD = new Uint8Array([
  0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
  0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A]);

class Decryptor {
  /* 只支持空口令（"能打开就能转"）。设了打开口令的 PDF 会明确报错而不是吐乱码。 */
  constructor(enc, idFirst, doc){
    const g = v => doc.get(v);
    this.v = g(enc.V) || 0;
    this.r = g(enc.R) || 2;
    const O = g(enc.O), U = g(enc.U);
    this.O = O ? O.bytes : new Uint8Array(32);
    this.U = U ? U.bytes : new Uint8Array(32);
    this.p = g(enc.P) | 0;
    this.length = g(enc.Length) || 40;
    this.encryptMetadata = g(enc.EncryptMetadata) !== false;
    this.id = idFirst || new Uint8Array(0);
    this.cfm = "V2";                                  // V2=RC4, AESV2=AES128, AESV3=AES256

    if (this.v >= 4){
      const cf = g(enc.CF) || Object.create(null);
      const stmf = g(enc.StmF);
      const nameF = stmf instanceof Name ? stmf.name : "Identity";
      this.identity = nameF === "Identity";
      const cfd = g(cf[nameF]);
      if (cfd){
        const m = g(cfd.CFM);
        if (m instanceof Name) this.cfm = m.name;
        const l = g(cfd.Length);
        if (l) this.length = l <= 40 ? l * 8 : l;
      }
    }

    if (this.r >= 5) this.key = this.computeKeyR5(enc, doc);
    else this.key = this.computeKeyLegacy();
    this.aes = this.cfm === "AESV2" || this.cfm === "AESV3";
  }

  computeKeyLegacy(){
    const n = Math.max(5, Math.min(16, this.length >> 3));
    const parts = [PAD, this.O.subarray(0, 32)];
    const pb = new Uint8Array(4);
    new DataView(pb.buffer).setInt32(0, this.p, true);
    parts.push(pb, this.id);
    if (this.r >= 4 && !this.encryptMetadata) parts.push(new Uint8Array([0xff,0xff,0xff,0xff]));
    let k = md5(concatBytes(parts));
    if (this.r >= 3) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, n));
    return k.subarray(0, n);
  }

  /* R5(已废弃的 Adobe 扩展) 与 R6(PDF 2.0)：AES-256 */
  computeKeyR5(enc, doc){
    const g = v => doc.get(v);
    const UE = g(enc.UE);
    const validSalt = this.U.subarray(32, 40), keySalt = this.U.subarray(40, 48);
    const pwd = new Uint8Array(0);
    const check = this.hash2B(pwd, validSalt, new Uint8Array(0));
    this.userPasswordOk = check.every((v, i) => v === this.U[i]);
    const ik = this.hash2B(pwd, keySalt, new Uint8Array(0));
    if (!UE) return ik;
    return aesCbcDecrypt(ik, UE.bytes, false, false).subarray(0, 32);
  }

  hash2B(pwd, salt, udata){
    let K = sha256(concatBytes([pwd, salt, udata]));
    if (this.r === 5) return K;
    let round = 0, E = null;
    for (;;){
      const one = concatBytes([pwd, K, udata]);
      const K1 = new Uint8Array(one.length * 64);
      for (let i = 0; i < 64; i++) K1.set(one, i * one.length);
      E = aesCbcEncryptNoPad(K.subarray(0, 16), K.subarray(16, 32), K1);
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += E[i];
      const mod = sum % 3;
      K = mod === 0 ? sha256(E) : (mod === 1 ? sha384(E) : sha512(E));
      round++;
      if (round >= 64 && E[E.length - 1] <= round - 32) break;
      if (round > 500) break;                          // 防御性上限
    }
    return K.subarray(0, 32);
  }

  objKey(num, gen){
    if (this.r >= 5) return this.key;
    const ext = new Uint8Array(this.aes ? 9 : 5);
    ext[0] = num & 255; ext[1] = (num >> 8) & 255; ext[2] = (num >> 16) & 255;
    ext[3] = gen & 255; ext[4] = (gen >> 8) & 255;
    if (this.aes){ ext[5] = 0x73; ext[6] = 0x41; ext[7] = 0x6c; ext[8] = 0x54; }  // sAlT
    const k = md5(concatBytes([this.key, ext]));
    return k.subarray(0, Math.min(this.key.length + 5, 16));
  }

  apply(data, num, gen){
    if (this.identity) return data;
    const k = this.objKey(num, gen);
    if (this.aes) return aesCbcDecrypt(k, data, true, true);
    return rc4(k, data);
  }
  stream(data, num, gen){ try { return this.apply(data, num, gen); } catch (e){ return data; } }
  string(data, num, gen){ try { return this.apply(data, num, gen); } catch (e){ return data; } }
}

/* ==================== PDF 文档 ==================== */
class PDFDoc {
  constructor(buf){
    this.buf = buf;
    this.xref = new Map();          // num -> {off} | {stm, idx}
    this.trailer = Object.create(null);
    this.cache = new Map();
    this.decryptor = null;
    this.inObjStm = false;
    this.warnings = [];
    this.recovered = false;
  }

  warn(msg){ if (this.warnings.indexOf(msg) < 0) this.warnings.push(msg); }

  load(){
    try { this.readXrefChain(); } catch (e){ this.warn("xref 解析失败：" + e.message); }
    if (!this.trailer.Root || !this.xref.size){ this.recoverByScan(); }
    this.setupDecryption();
    /* 校验 Root 可用 */
    let cat = this.get(this.trailer.Root);
    if (!cat || !(cat.Pages || cat.Type)){
      this.recoverByScan();
      cat = this.get(this.trailer.Root);
    }
    this.catalog = cat || Object.create(null);
  }

  readXrefChain(){
    const tail = Math.max(0, this.buf.length - 2048);
    const sx = lastIndexOfBytes(this.buf, "startxref", this.buf.length - 9);
    if (sx < 0) throw new Error("找不到 startxref");
    const lx = new Lexer(this.buf, sx + 9);
    const t = lx.next();
    if (t.t !== "num") throw new Error("startxref 后不是数字");
    const seen = new Set();
    let off = t.v;
    while (off !== undefined && off !== null && off > 0 && off < this.buf.length && !seen.has(off)){
      seen.add(off);
      const next = this.readXrefSection(off);
      off = next;
    }
  }

  /* 返回 /Prev 偏移 */
  readXrefSection(off){
    const lx = new Lexer(this.buf, off);
    const save = lx.p;
    const t = lx.next();

    if (t.t === "kw" && t.v === "xref"){
      /* 传统 xref 表 */
      for (;;){
        const a = lx.next();
        if (a.t === "kw" && a.v === "trailer") break;
        if (a.t !== "num") break;
        const b = lx.next();
        if (b.t !== "num") break;
        const start = a.v, count = b.v;
        lx.skipWs();
        for (let i = 0; i < count; i++){
          /* 每项固定 20 字节，但有些生成器写 19 —— 用词法器兜底 */
          const o = lx.next(), g = lx.next(), ty = lx.next();
          if (o.t !== "num" || g.t !== "num") return null;
          const num = start + i;
          if (ty.t === "kw" && ty.v === "n" && !this.xref.has(num)) this.xref.set(num, { off: o.v, gen: g.v });
        }
      }
      const p = new Parser(this.buf, lx.p, this);
      const tr = p.parse();
      if (tr && typeof tr === "object"){
        for (const k in tr) if (!(k in this.trailer)) this.trailer[k] = tr[k];
        /* 混合文件：/XRefStm 指向一个交叉引用流 */
        if (tr.XRefStm) { try { this.readXrefSection(this.get(tr.XRefStm)); } catch (e){} }
        return tr.Prev !== undefined ? this.get(tr.Prev) : null;
      }
      return null;
    }

    /* 交叉引用流：N G obj << ... >> stream */
    lx.p = save;
    const p = new Parser(this.buf, save, this);
    const a = p.parse(), b = p.parse(), kw = p.parse();
    if (!(kw && kw.op === "obj")) throw new Error("xref 位置不是 xref 表也不是对象");
    const stm = p.parse(a, b);
    if (!(stm instanceof PStream)) throw new Error("xref 流不是流对象");
    stm.noDecrypt = true;                              // 交叉引用流永不加密
    this.readXrefStream(stm);
    const d = stm.dict;
    for (const k in d) if (!(k in this.trailer)) this.trailer[k] = d[k];
    return d.Prev !== undefined ? this.get(d.Prev) : null;
  }

  readXrefStream(stm){
    const d = stm.dict;
    const W = (this.get(d.W) || []).map(v => this.get(v));
    const size = this.get(d.Size) || 0;
    let index = this.get(d.Index);
    if (!Array.isArray(index)) index = [0, size];
    const data = stm.data;
    const rowLen = W.reduce((a, b) => a + b, 0);
    if (!rowLen) return;
    let p = 0;
    for (let s = 0; s < index.length; s += 2){
      const start = this.get(index[s]), count = this.get(index[s + 1]);
      for (let i = 0; i < count; i++){
        if (p + rowLen > data.length) return;
        const f = [];
        for (let k = 0; k < W.length; k++){
          let v = 0;
          for (let j = 0; j < W[k]; j++) v = v * 256 + data[p++];
          f.push(W[k] === 0 ? (k === 0 ? 1 : 0) : v);
        }
        const num = start + i;
        if (this.xref.has(num)) continue;
        if (f[0] === 1) this.xref.set(num, { off: f[1], gen: f[2] || 0 });
        else if (f[0] === 2) this.xref.set(num, { stm: f[1], idx: f[2] });
      }
    }
  }

  /* 全文件扫描重建 —— 网上下载的 PDF 被截断/被工具改写后 xref 常常是错的 */
  recoverByScan(){
    if (this.recovered) return;
    this.recovered = true;
    this.warn("xref 不可用，已改用全文件扫描重建对象表（位置信息仍然精确，只是解析慢一点）");
    const buf = this.buf;
    const found = new Map();
    /* 找所有 "num gen obj" */
    let i = 0;
    for (;;){
      i = indexOfBytes(buf, "obj", i);
      if (i < 0) break;
      /* 往回读 gen 和 num */
      let j = i - 1;
      while (j >= 0 && WS[buf[j]]) j--;
      const genEnd = j + 1;
      while (j >= 0 && buf[j] >= 48 && buf[j] <= 57) j--;
      const genStart = j + 1;
      if (genStart === genEnd){ i += 3; continue; }
      while (j >= 0 && WS[buf[j]]) j--;
      const numEnd = j + 1;
      while (j >= 0 && buf[j] >= 48 && buf[j] <= 57) j--;
      const numStart = j + 1;
      if (numStart === numEnd){ i += 3; continue; }
      if (numStart > 0 && REG[buf[numStart - 1]]){ i += 3; continue; }
      const num = parseInt(latin1(buf.subarray(numStart, numEnd)), 10);
      const gen = parseInt(latin1(buf.subarray(genStart, genEnd)), 10);
      if (isFinite(num)) found.set(num, { off: numStart, gen });     // 后出现的覆盖先出现的（增量更新）
      i += 3;
    }
    for (const [k, v] of found) this.xref.set(k, v);
    this.cache.clear();

    /* trailer / Root */
    if (!this.trailer.Root){
      let t = buf.length;
      for (;;){
        t = lastIndexOfBytes(buf, "trailer", t - 1);
        if (t < 0) break;
        try {
          const p = new Parser(buf, t + 7, this);
          const tr = p.parse();
          if (tr && tr.Root){ for (const k in tr) if (!(k in this.trailer)) this.trailer[k] = tr[k]; break; }
        } catch (e){}
      }
    }
    if (!this.trailer.Root){
      /* 直接找 /Type /Catalog */
      for (const [num, e] of this.xref){
        try {
          const o = this.fetch(num);
          const d = o instanceof PStream ? o.dict : o;
          if (d && d.Type instanceof Name && d.Type.name === "Catalog"){ this.trailer.Root = new Ref(num, e.gen || 0); break; }
        } catch (err){}
      }
    }
    /* 还是没有 Root：找 /Type /Pages 里没有 /Parent 的那个，自己伪造一个目录 */
    if (!this.trailer.Root){
      for (const [num, e] of this.xref){
        try {
          const o = this.fetch(num);
          const d = o instanceof PStream ? o.dict : o;
          if (d && d.Type instanceof Name && d.Type.name === "Pages" && !d.Parent){
            this.trailer.Root = { Type: nm("Catalog"), Pages: new Ref(num, e.gen || 0) };
            this.warn("文档目录缺失，已按页树根节点重建");
            break;
          }
        } catch (err){}
      }
    }
  }

  setupDecryption(){
    const encRef = this.trailer.Encrypt;
    if (!encRef) return;
    const enc = this.get(encRef);
    if (!enc) return;
    const filt = this.get(enc.Filter);
    if (filt instanceof Name && filt.name !== "Standard"){
      this.warn("使用了非标准加密处理器 " + filt.name + "，无法解密");
      return;
    }
    const ids = this.get(this.trailer.ID);
    const id0 = (Array.isArray(ids) && ids[0] && this.get(ids[0]) instanceof PStr) ? this.get(ids[0]).bytes : new Uint8Array(0);
    try {
      this.decryptor = new Decryptor(enc, id0, this);
      this.encryptRefNum = encRef instanceof Ref ? encRef.num : -1;
      this.cache.clear();
      this.warn("文件已加密（空口令），已自动解密");
    } catch (e){
      this.warn("解密失败：" + e.message + "。如果这份 PDF 设了打开口令，请先用阅读器去掉口令再转。");
    }
  }

  /* 解引用 */
  get(v){
    let n = 0;
    while (v instanceof Ref && n++ < 32) v = this.fetch(v.num, v.gen);
    return v;
  }

  fetch(num, gen){
    const key = num;
    if (this.cache.has(key)) return this.cache.get(key);
    this.cache.set(key, null);                         // 防循环
    const e = this.xref.get(num);
    if (!e) {
      if (!this.recovered){ this.recoverByScan(); return this.fetch(num, gen); }
      return null;
    }
    let val = null;
    try {
      if (e.stm !== undefined) val = this.fetchFromObjStm(e.stm, e.idx, num);
      else {
        const p = new Parser(this.buf, e.off, this);
        const a = p.parse(), b = p.parse(), kw = p.parse();
        if (kw && kw.op === "obj"){
          if (a !== num && !this.recovered){         // 偏移对不上，说明 xref 是坏的
            this.recoverByScan();
            this.cache.delete(key);
            return this.fetch(num, gen);
          }
          val = p.parse(num, typeof b === "number" ? b : 0);
          if (val && val.op) val = null;
        }
      }
    } catch (err){ val = null; }
    this.cache.set(key, val);
    return val;
  }

  fetchFromObjStm(stmNum, idx, wantNum){
    let info = this._objStm && this._objStm.get(stmNum);
    if (!info){
      const stm = this.get(new Ref(stmNum, 0));
      if (!(stm instanceof PStream)) return null;
      const data = stm.data;
      const n = this.get(stm.dict.N) || 0, first = this.get(stm.dict.First) || 0;
      const lx = new Lexer(data, 0);
      const pairs = [];
      for (let i = 0; i < n; i++){
        const a = lx.next(), b = lx.next();
        if (a.t !== "num" || b.t !== "num") break;
        pairs.push([a.v, b.v]);
      }
      info = { data, first, pairs };
      if (!this._objStm) this._objStm = new Map();
      this._objStm.set(stmNum, info);
    }
    let entry = info.pairs[idx];
    if (!entry || entry[0] !== wantNum) entry = info.pairs.find(p => p[0] === wantNum);
    if (!entry) return null;
    const prevFlag = this.inObjStm;
    this.inObjStm = true;                              // 对象流内的字符串不再单独解密
    try {
      const p = new Parser(info.data, info.first + entry[1], this);
      const v = p.parse(wantNum, 0);
      return (v && v.op) ? null : v;
    } finally { this.inObjStm = prevFlag; }
  }

  /* ---------- 页树 ---------- */
  get pages(){
    if (this._pages) return this._pages;
    const out = [];
    const inheritKeys = ["Resources", "MediaBox", "CropBox", "Rotate"];
    const seen = new Set();
    const walk = (nodeRef, inherited, depth) => {
      if (depth > 64 || out.length > 5000) return;
      const key = nodeRef instanceof Ref ? nodeRef.key : null;
      if (key){ if (seen.has(key)) return; seen.add(key); }
      const node = this.get(nodeRef);
      if (!node || typeof node !== "object") return;
      const inh = Object.assign({}, inherited);
      for (const k of inheritKeys) if (node[k] !== undefined) inh[k] = node[k];
      const type = this.get(node.Type);
      const kids = this.get(node.Kids);
      if (Array.isArray(kids) && (!type || type.name !== "Page")){
        for (const k of kids) walk(k, inh, depth + 1);
      } else if (node.Contents !== undefined || (type && type.name === "Page")){
        const page = Object.assign(Object.create(null), node);
        for (const k of inheritKeys) if (page[k] === undefined && inh[k] !== undefined) page[k] = inh[k];
        page.__ref = nodeRef;
        out.push(page);
      }
    };
    const cat = this.catalog || Object.create(null);
    walk(cat.Pages, Object.create(null), 0);
    if (!out.length){
      /* 兜底：扫描所有 /Type /Page */
      this.recoverByScan();
      const nums = Array.from(this.xref.keys()).sort((a, b) => a - b);
      for (const n of nums){
        const o = this.fetch(n);
        const d = o instanceof PStream ? null : o;
        if (d && d.Type instanceof Name && d.Type.name === "Page"){ d.__ref = new Ref(n, 0); out.push(d); }
      }
      if (out.length) this.warn("页树不可用，已按对象扫描顺序还原页面顺序（顺序可能与阅读器不一致）");
    }
    this._pages = out;
    return out;
  }

  /* 页面内容流（可能是数组，需要拼接） */
  pageContent(page){
    const c = this.get(page.Contents);
    const parts = [];
    const add = s => { if (s instanceof PStream){ try { parts.push(s.data); } catch (e){} } };
    if (Array.isArray(c)) for (const x of c) add(this.get(x));
    else add(c);
    if (!parts.length) return new Uint8Array(0);
    /* 各段之间补空白，防止跨段把两个 token 粘在一起 */
    const sep = new Uint8Array([10]);
    const joined = [];
    parts.forEach((p, i) => { if (i) joined.push(sep); joined.push(p); });
    return concatBytes(joined);
  }
}
