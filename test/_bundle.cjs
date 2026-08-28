"use strict";
/* ===== 1-core.js ===== */
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

/* ===== 2-font.js ===== */
/* ============================================================
   2-font.js —— 字体与编码层
   把 PDF 里的字节码还原成 Unicode，并给出每个字形的宽度。
   这一层解不出来时必须明说「无法确定」，绝不能吐乱码——
   乱码会让 AI 一本正经地拿垃圾建 PPT，而且到最终稿之前发现不了。
   ============================================================ */

/* ---------- 基础编码表 ---------- */
const ASCII_NAMES = (() => {
  const t = new Array(256).fill(null);
  const seq = "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at".split(" ");
  seq.forEach((n, i) => t[32 + i] = n);
  for (let i = 0; i < 26; i++){ t[65 + i] = String.fromCharCode(65 + i); t[97 + i] = String.fromCharCode(97 + i); }
  "bracketleft backslash bracketright asciicircum underscore grave".split(" ").forEach((n, i) => t[91 + i] = n);
  "braceleft bar braceright asciitilde".split(" ").forEach((n, i) => t[123 + i] = n);
  return t;
})();

function mkEnc(diffs){
  const t = ASCII_NAMES.slice();
  for (const k in diffs) t[+k] = diffs[k];
  return t;
}

const STD_ENC = mkEnc({
  39:"quoteright", 96:"quoteleft",
  161:"exclamdown",162:"cent",163:"sterling",164:"fraction",165:"yen",166:"florin",167:"section",
  168:"currency",169:"quotesingle",170:"quotedblleft",171:"guillemotleft",172:"guilsinglleft",
  173:"guilsinglright",174:"fi",175:"fl",177:"endash",178:"dagger",179:"daggerdbl",180:"periodcentered",
  182:"paragraph",183:"bullet",184:"quotesinglbase",185:"quotedblbase",186:"quotedblright",
  187:"guillemotright",188:"ellipsis",189:"perthousand",191:"questiondown",193:"grave",194:"acute",
  195:"circumflex",196:"tilde",197:"macron",198:"breve",199:"dotaccent",200:"dieresis",202:"ring",
  203:"cedilla",205:"hungarumlaut",206:"ogonek",207:"caron",208:"emdash",225:"AE",227:"ordfeminine",
  232:"Lslash",233:"Oslash",234:"OE",235:"ordmasculine",241:"ae",245:"dotlessi",248:"lslash",
  249:"oslash",250:"oe",251:"germandbls"
});

const WIN_ENC = mkEnc({
  128:"Euro",130:"quotesinglbase",131:"florin",132:"quotedblbase",133:"ellipsis",134:"dagger",
  135:"daggerdbl",136:"circumflex",137:"perthousand",138:"Scaron",139:"guilsinglleft",140:"OE",
  142:"Zcaron",145:"quoteleft",146:"quoteright",147:"quotedblleft",148:"quotedblright",149:"bullet",
  150:"endash",151:"emdash",152:"tilde",153:"trademark",154:"scaron",155:"guilsinglright",156:"oe",
  158:"zcaron",159:"Ydieresis",160:"space",161:"exclamdown",162:"cent",163:"sterling",164:"currency",
  165:"yen",166:"brokenbar",167:"section",168:"dieresis",169:"copyright",170:"ordfeminine",
  171:"guillemotleft",172:"logicalnot",173:"hyphen",174:"registered",175:"macron",176:"degree",
  177:"plusminus",178:"twosuperior",179:"threesuperior",180:"acute",181:"mu",182:"paragraph",
  183:"periodcentered",184:"cedilla",185:"onesuperior",186:"ordmasculine",187:"guillemotright",
  188:"onequarter",189:"onehalf",190:"threequarters",191:"questiondown",192:"Agrave",193:"Aacute",
  194:"Acircumflex",195:"Atilde",196:"Adieresis",197:"Aring",198:"AE",199:"Ccedilla",200:"Egrave",
  201:"Eacute",202:"Ecircumflex",203:"Edieresis",204:"Igrave",205:"Iacute",206:"Icircumflex",
  207:"Idieresis",208:"Eth",209:"Ntilde",210:"Ograve",211:"Oacute",212:"Ocircumflex",213:"Otilde",
  214:"Odieresis",215:"multiply",216:"Oslash",217:"Ugrave",218:"Uacute",219:"Ucircumflex",
  220:"Udieresis",221:"Yacute",222:"Thorn",223:"germandbls",224:"agrave",225:"aacute",
  226:"acircumflex",227:"atilde",228:"adieresis",229:"aring",230:"ae",231:"ccedilla",232:"egrave",
  233:"eacute",234:"ecircumflex",235:"edieresis",236:"igrave",237:"iacute",238:"icircumflex",
  239:"idieresis",240:"eth",241:"ntilde",242:"ograve",243:"oacute",244:"ocircumflex",245:"otilde",
  246:"odieresis",247:"divide",248:"oslash",249:"ugrave",250:"uacute",251:"ucircumflex",
  252:"udieresis",253:"yacute",254:"thorn",255:"ydieresis"
});

const MAC_ENC = mkEnc({
  128:"Adieresis",129:"Aring",130:"Ccedilla",131:"Eacute",132:"Ntilde",133:"Odieresis",134:"Udieresis",
  135:"aacute",136:"agrave",137:"acircumflex",138:"adieresis",139:"atilde",140:"aring",141:"ccedilla",
  142:"eacute",143:"egrave",144:"ecircumflex",145:"edieresis",146:"iacute",147:"igrave",148:"icircumflex",
  149:"idieresis",150:"ntilde",151:"oacute",152:"ograve",153:"ocircumflex",154:"odieresis",155:"otilde",
  156:"uacute",157:"ugrave",158:"ucircumflex",159:"udieresis",160:"dagger",161:"degree",162:"cent",
  163:"sterling",164:"section",165:"bullet",166:"paragraph",167:"germandbls",168:"registered",
  169:"copyright",170:"trademark",171:"acute",172:"dieresis",174:"AE",175:"Oslash",177:"plusminus",
  180:"yen",181:"mu",187:"ordfeminine",188:"ordmasculine",190:"ae",191:"oslash",192:"questiondown",
  193:"exclamdown",194:"logicalnot",196:"florin",199:"guillemotleft",200:"guillemotright",201:"ellipsis",
  202:"space",203:"Agrave",204:"Atilde",205:"Otilde",206:"OE",207:"oe",208:"endash",209:"emdash",
  210:"quotedblleft",211:"quotedblright",212:"quoteleft",213:"quoteright",214:"divide",216:"ydieresis",
  217:"Ydieresis",218:"fraction",219:"currency",220:"guilsinglleft",221:"guilsinglright",222:"fi",
  223:"fl",224:"daggerdbl",225:"periodcentered",226:"quotesinglbase",227:"quotedblbase",
  228:"perthousand",229:"Acircumflex",230:"Ecircumflex",231:"Aacute",232:"Edieresis",233:"Egrave",
  234:"Iacute",235:"Icircumflex",236:"Idieresis",237:"Igrave",238:"Oacute",239:"Ocircumflex",
  241:"Ograve",242:"Uacute",243:"Ucircumflex",244:"Ugrave",245:"dotlessi",246:"circumflex",
  247:"tilde",248:"macron",249:"breve",250:"dotaccent",251:"ring",252:"cedilla",253:"hungarumlaut",
  254:"ogonek",255:"caron"
});

/* ---------- 字形名 -> Unicode ---------- */
const AGL = (() => {
  const m = Object.create(null);
  /* ASCII 段可以直接从编码表反推 */
  for (let i = 32; i < 127; i++) if (ASCII_NAMES[i]) m[ASCII_NAMES[i]] = i;
  const pairs = {
    quoteright:0x2019, quoteleft:0x2018, quotedblleft:0x201C, quotedblright:0x201D,
    quotesinglbase:0x201A, quotedblbase:0x201E, endash:0x2013, emdash:0x2014, bullet:0x2022,
    ellipsis:0x2026, dagger:0x2020, daggerdbl:0x2021, perthousand:0x2030, trademark:0x2122,
    fi:0xFB01, fl:0xFB02, florin:0x0192, fraction:0x2044, guilsinglleft:0x2039, guilsinglright:0x203A,
    guillemotleft:0x00AB, guillemotright:0x00BB, Euro:0x20AC, minus:0x2212, periodcentered:0x00B7,
    exclamdown:0x00A1, questiondown:0x00BF, cent:0x00A2, sterling:0x00A3, currency:0x00A4, yen:0x00A5,
    brokenbar:0x00A6, section:0x00A7, dieresis:0x00A8, copyright:0x00A9, ordfeminine:0x00AA,
    logicalnot:0x00AC, registered:0x00AE, macron:0x00AF, degree:0x00B0, plusminus:0x00B1,
    twosuperior:0x00B2, threesuperior:0x00B3, acute:0x00B4, mu:0x00B5, paragraph:0x00B6,
    cedilla:0x00B8, onesuperior:0x00B9, ordmasculine:0x00BA, onequarter:0x00BC, onehalf:0x00BD,
    threequarters:0x00BE, multiply:0x00D7, divide:0x00F7, germandbls:0x00DF, AE:0x00C6, ae:0x00E6,
    OE:0x0152, oe:0x0153, Oslash:0x00D8, oslash:0x00F8, Lslash:0x0141, lslash:0x0142,
    Scaron:0x0160, scaron:0x0161, Zcaron:0x017D, zcaron:0x017E, Ydieresis:0x0178, Thorn:0x00DE,
    thorn:0x00FE, Eth:0x00D0, eth:0x00F0, dotlessi:0x0131, circumflex:0x02C6, tilde:0x02DC,
    breve:0x02D8, dotaccent:0x02D9, ring:0x02DA, ogonek:0x02DB, hungarumlaut:0x02DD, caron:0x02C7,
    grave:0x0060, space:0x0020, nbspace:0x00A0, hyphen:0x002D, softhyphen:0x00AD,
    arrowleft:0x2190, arrowup:0x2191, arrowright:0x2192, arrowdown:0x2193, arrowboth:0x2194,
    lessequal:0x2264, greaterequal:0x2265, notequal:0x2260, approxequal:0x2248, infinity:0x221E,
    integral:0x222B, radical:0x221A, summation:0x2211, product:0x220F, partialdiff:0x2202,
    Delta:0x0394, Omega:0x03A9, pi:0x03C0, alpha:0x03B1, beta:0x03B2, gamma:0x03B3, delta:0x03B4,
    epsilon:0x03B5, lambda:0x03BB, sigma:0x03C3, tau:0x03C4, phi:0x03C6, omega:0x03C9,
    checkmark:0x2713, lozenge:0x25CA, filledbox:0x25A0, filledrect:0x25AC, triagup:0x25B2,
    triagdn:0x25BC, circle:0x25CB, square:0x25A1
  };
  Object.assign(m, pairs);
  /* 重音字母：名字规律强，程序化生成比手写表可靠 */
  const base = "A E I O U Y a e i o u y N n C c S s Z z";
  const marks = { grave:0x0300, acute:0x0301, circumflex:0x0302, tilde:0x0303, dieresis:0x0308,
                  ring:0x030A, cedilla:0x0327, caron:0x030C };
  const composed = {
    Agrave:0xC0,Aacute:0xC1,Acircumflex:0xC2,Atilde:0xC3,Adieresis:0xC4,Aring:0xC5,Ccedilla:0xC7,
    Egrave:0xC8,Eacute:0xC9,Ecircumflex:0xCA,Edieresis:0xCB,Igrave:0xCC,Iacute:0xCD,Icircumflex:0xCE,
    Idieresis:0xCF,Ntilde:0xD1,Ograve:0xD2,Oacute:0xD3,Ocircumflex:0xD4,Otilde:0xD5,Odieresis:0xD6,
    Ugrave:0xD9,Uacute:0xDA,Ucircumflex:0xDB,Udieresis:0xDC,Yacute:0xDD,
    agrave:0xE0,aacute:0xE1,acircumflex:0xE2,atilde:0xE3,adieresis:0xE4,aring:0xE5,ccedilla:0xE7,
    egrave:0xE8,eacute:0xE9,ecircumflex:0xEA,edieresis:0xEB,igrave:0xEC,iacute:0xED,icircumflex:0xEE,
    idieresis:0xEF,ntilde:0xF1,ograve:0xF2,oacute:0xF3,ocircumflex:0xF4,otilde:0xF5,odieresis:0xF6,
    ugrave:0xF9,uacute:0xFA,ucircumflex:0xFB,udieresis:0xFC,yacute:0xFD,ydieresis:0xFF
  };
  Object.assign(m, composed);
  void base; void marks;
  return m;
})();

/* 字形名 -> 码点。返回 null 表示确实不认识（调用方要如实上报，不许猜） */
function glyphToUnicode(name){
  if (!name) return null;
  if (AGL[name] !== undefined) return AGL[name];
  let m;
  if ((m = /^uni([0-9A-Fa-f]{4,6})$/.exec(name))) return parseInt(m[1], 16);
  if ((m = /^u([0-9A-Fa-f]{4,6})$/.exec(name))) return parseInt(m[1], 16);
  /* Foo.sc / Foo.alt 之类的变体后缀 */
  if ((m = /^(.+?)\.(sc|alt|fitted|oldstyle|lf|tf|sups|subs|dnom|numr|ss\d+|cv\d+)$/.exec(name)))
    return glyphToUnicode(m[1]);
  /* 连字：f_i、f_f_l */
  if (name.indexOf("_") > 0){
    const parts = name.split("_").map(glyphToUnicode);
    if (parts.every(v => v !== null)) return parts;      // 返回数组表示多码点
  }
  /* gXX / cidXX / indexXX —— 这些是子集化后的裸编号，压根不带语义 */
  if (/^(g|cid|index|glyph)\d+$/i.test(name)) return null;
  if (name.length === 1) return name.charCodeAt(0);
  return null;
}

/* ---------- ToUnicode CMap ---------- */
function parseToUnicode(bytes){
  const map = new Map();
  const lx = new Lexer(bytes, 0);
  const stack = [];
  const hexToStr = pstr => {
    const b = pstr.bytes;
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    if (b.length === 1) s = String.fromCharCode(b[0]);
    return s;
  };
  const hexToInt = pstr => { let v = 0; for (const b of pstr.bytes) v = v * 256 + b; return v; };

  for (;;){
    const t = lx.next();
    if (t.t === "eof") break;
    if (t.t === "kw"){
      if (t.v === "beginbfchar"){
        for (;;){
          const a = lx.next();
          if (a.t !== "str") break;
          const b = lx.next();
          if (b.t === "str") map.set(hexToInt(a.v), hexToStr(b.v));
          else if (b.t === "name"){ const u = glyphToUnicode(b.v); if (u !== null) map.set(hexToInt(a.v), typeof u === "number" ? String.fromCodePoint(u) : u.map(c => String.fromCodePoint(c)).join("")); }
          else break;
        }
      } else if (t.v === "beginbfrange"){
        for (;;){
          const a = lx.next();
          if (a.t !== "str") break;
          const b = lx.next();
          if (b.t !== "str") break;
          const lo = hexToInt(a.v), hi = hexToInt(b.v);
          const c = lx.next();
          if (c.t === "str"){
            const base = hexToStr(c.v);
            if (hi - lo > 65535) continue;
            for (let i = lo; i <= hi; i++){
              /* 只递增最后一个码元，这是规范的行为 */
              const s = base.length ? base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (i - lo)) : "";
              map.set(i, s);
            }
          } else if (c.t === "["){
            let i = lo;
            for (;;){
              const e = lx.next();
              if (e.t === "]" || e.t === "eof") break;
              if (e.t === "str") map.set(i++, hexToStr(e.v));
              else i++;
            }
          } else break;
        }
      }
    }
    stack.length = 0;
  }
  return map;
}

/* 内嵌 CMap（/Encoding 指向一个流）：取码字节数与 cid 映射 */
function parseCMapStream(bytes){
  const ranges = [];                      // {lo, hi, nbytes}
  const cidMap = new Map();
  const lx = new Lexer(bytes, 0);
  const toInt = p => { let v = 0; for (const b of p.bytes) v = v * 256 + b; return v; };
  for (;;){
    const t = lx.next();
    if (t.t === "eof") break;
    if (t.t !== "kw") continue;
    if (t.v === "begincodespacerange"){
      for (;;){
        const a = lx.next(); if (a.t !== "str") break;
        const b = lx.next(); if (b.t !== "str") break;
        ranges.push({ lo: toInt(a.v), hi: toInt(b.v), nbytes: a.v.bytes.length });
      }
    } else if (t.v === "begincidrange"){
      for (;;){
        const a = lx.next(); if (a.t !== "str") break;
        const b = lx.next(); if (b.t !== "str") break;
        const c = lx.next(); if (c.t !== "num") break;
        const lo = toInt(a.v), hi = toInt(b.v);
        if (hi - lo <= 65535) for (let i = lo; i <= hi; i++) cidMap.set(i, c.v + (i - lo));
      }
    } else if (t.v === "begincidchar"){
      for (;;){
        const a = lx.next(); if (a.t !== "str") break;
        const b = lx.next(); if (b.t !== "num") break;
        cidMap.set(toInt(a.v), b.v);
      }
    }
  }
  return { ranges, cidMap };
}

/* ---------- 常见中日韩字体名归一 ---------- */
/* 顺序即优先级：先匹配先赢。具体的必须排在笼统的前面——
   MicrosoftYaHei 以 Hei 结尾，如果 /Hei$/ 排在前面，雅黑会被认成黑体。 */
const CJK_FONT_ALIAS = [
  [/Microsoft\s*YaHei|MSYH|MicrosoftJhengHei/i, "微软雅黑"],
  [/SimSun|NSimSun|STSong|SongTi|Song$|MSung|STZhongsong/i, "宋体"],
  [/SimHei|STHeiti|HeiTi|(?:^|[^a-zA-Z])Hei$/i, "黑体"],
  [/FangSong|STFangsong/i, "仿宋"],
  [/KaiTi|STKaiti|Kai$/i, "楷体"],
  [/Source\s*Han\s*Sans|Noto\s*Sans\s*(CJK|SC|TC)|SourceHanSans/i, "思源黑体"],
  [/Source\s*Han\s*Serif|Noto\s*Serif\s*(CJK|SC|TC)|SourceHanSerif/i, "思源宋体"],
  [/PingFang/i, "苹方"],
  [/DengXian/i, "等线"],
  [/YouYuan/i, "幼圆"],
  [/LiSu/i, "隶书"]
];

function fontDisplayName(raw){
  if (!raw) return null;
  /* 子集前缀 ABCDEF+ */
  let n = raw.replace(/^[A-Z]{6}\+/, "");
  for (const [re, cn] of CJK_FONT_ALIAS) if (re.test(n)) return cn + "（" + n + "）";
  return n;
}

/* ---------- 字体对象 ---------- */
class PdfFont {
  constructor(dict, doc, resName){
    this.doc = doc; this.dict = dict; this.resName = resName;
    this.type = "simple";
    this.widths = new Map();
    this.defaultWidth = 500;
    this.toUnicode = null;
    this.encNames = null;
    this.cid2gid = null;
    this.identity = false;
    this.oneByte = true;
    this.codespace = null;
    this.undecodable = 0;      // 解不出 Unicode 的字形数——用来给上层报可信度
    this.total = 0;
    this.build();
  }

  build(){
    const doc = this.doc, g = v => doc.get(v);
    const d = this.dict;
    const sub = g(d.Subtype);
    const subName = sub instanceof Name ? sub.name : "";
    this.subtype = subName;

    let fd = null, desc = d;

    if (subName === "Type0"){
      this.type = "composite";
      this.oneByte = false;
      const df = g(d.DescendantFonts);
      const d0 = Array.isArray(df) ? g(df[0]) : null;
      if (d0){
        desc = d0;
        fd = g(d0.FontDescriptor);
        this.defaultWidth = g(d0.DW) !== undefined ? g(d0.DW) : 1000;
        this.readCidWidths(g(d0.W));
        const c2g = g(d0.CIDToGIDMap);
        if (c2g instanceof PStream){ try { this.cid2gid = c2g.data; } catch (e){} }
      }
      const enc = g(d.Encoding);
      if (enc instanceof Name){
        this.encodingName = enc.name;
        this.identity = /^Identity-[HV]$/.test(enc.name);
        this.vertical = /-V$/.test(enc.name);
        if (!this.identity){
          /* 预定义 CMap（GBK-EUC-H / UniGB-UCS2-H 等）。这些表不在文件里，
             我们没有内置几 MB 的 CMap 数据，只能依赖 ToUnicode。 */
          this.needsPredefCMap = enc.name;
        }
      } else if (enc instanceof PStream){
        try {
          const cm = parseCMapStream(enc.data);
          this.cmapRanges = cm.ranges; this.cmapCid = cm.cidMap;
        } catch (e){}
      }
    } else if (subName === "Type3"){
      this.type = "type3";
      this.fontMatrix = g(d.FontMatrix) || [0.001, 0, 0, 0.001, 0, 0];
      this.charProcs = g(d.CharProcs);
      fd = g(d.FontDescriptor);
      this.readSimpleWidths(d);
      this.readEncoding(g(d.Encoding), subName);
    } else {
      fd = g(d.FontDescriptor);
      this.readSimpleWidths(d);
      this.readEncoding(g(d.Encoding), subName);
    }

    /* 描述符 */
    if (fd){
      const fn = g(fd.FontName);
      this.baseFontRaw = fn instanceof Name ? fn.name : null;
      this.flags = g(fd.Flags) || 0;
      this.italicAngle = g(fd.ItalicAngle) || 0;
      this.stemV = g(fd.StemV) || 0;
      this.fontWeight = g(fd.FontWeight) || 0;
      this.bbox = (g(fd.FontBBox) || []).map(v => g(v));
      if (g(fd.MissingWidth) !== undefined && this.type !== "composite") this.defaultWidth = g(fd.MissingWidth);
      this.embedded = !!(fd.FontFile || fd.FontFile2 || fd.FontFile3);
    }
    const bf = g(d.BaseFont);
    if (!this.baseFontRaw && bf instanceof Name) this.baseFontRaw = bf.name;
    this.name = fontDisplayName(this.baseFontRaw) || "（未命名字体）";
    this.rawName = (this.baseFontRaw || "").replace(/^[A-Z]{6}\+/, "");

    /* 粗体/斜体推断。
       只用「结构信号」，不用「分布信号」：
       名字里的 -Bold 后缀、FontWeight 数值、ForceBold 标志位，都是要么有要么没有，零误伤。

       StemV 曾经也在判据里，实测后删掉了 —— Chromium/Skia 导出的 PDF 里它完全不可比，
       而且方向是反的：MicrosoftYaHei-Bold（真粗体）StemV=84，
       NSimSun（常规体）StemV=488。设任何阈值都同时误伤和漏判，
       这不是调参能救的，是判据本身选错了维度。
       同理 Flags 也不可用：这类 PDF 里所有字体的 Flags 都是 0x4。
       宁可漏判粗体（AI 还能从字体名看出来），也不能误判 —— 误判是查不出来的静默污染。 */
    const nlow = (this.baseFontRaw || "").toLowerCase();
    this.bold = /bold|black|heavy|semibold|demibold|[-,]b[do]?\b/.test(nlow) ||
                this.fontWeight >= 600 ||
                !!(this.flags & (1 << 18));                 // ForceBold
    this.italic = /italic|oblique|[-,]i\b/.test(nlow) || Math.abs(this.italicAngle) > 4 || !!(this.flags & (1 << 6));
    this.serif = !!(this.flags & 2);
    this.fixedPitch = !!(this.flags & 1);
    this.symbolic = !!(this.flags & 4);

    /* ToUnicode 是把码字节还原成人类文字的主路径 */
    const tu = g(d.ToUnicode);
    if (tu instanceof PStream){
      try { this.toUnicode = parseToUnicode(tu.data); } catch (e){ this.toUnicode = null; }
    }
    this.hasToUnicode = !!(this.toUnicode && this.toUnicode.size);
  }

  readSimpleWidths(d){
    const g = v => this.doc.get(v);
    const fc = g(d.FirstChar), w = g(d.Widths);
    if (Array.isArray(w) && typeof fc === "number")
      for (let i = 0; i < w.length; i++){
        const v = g(w[i]);
        if (typeof v === "number") this.widths.set(fc + i, v);
      }
  }

  readCidWidths(W){
    const g = v => this.doc.get(v);
    if (!Array.isArray(W)) return;
    let i = 0;
    while (i < W.length){
      const a = g(W[i]);
      const b = g(W[i + 1]);
      if (Array.isArray(b)){
        for (let k = 0; k < b.length; k++){ const v = g(b[k]); if (typeof v === "number") this.widths.set(a + k, v); }
        i += 2;
      } else {
        const c = g(W[i + 2]);
        if (typeof b === "number" && typeof c === "number"){
          if (b - a <= 65535) for (let k = a; k <= b; k++) this.widths.set(k, c);
        }
        i += 3;
      }
    }
  }

  readEncoding(enc, subName){
    const g = v => this.doc.get(v);
    /* 基础编码：符号字体默认用字体自带的内建编码 */
    let base = null;
    if (this.symbolic === undefined) this.symbolic = false;
    const pickBase = n => n === "WinAnsiEncoding" ? WIN_ENC : n === "MacRomanEncoding" ? MAC_ENC : n === "StandardEncoding" ? STD_ENC : null;

    if (enc instanceof Name){ base = pickBase(enc.name); this.baseEncName = enc.name; }
    else if (enc && typeof enc === "object" && !(enc instanceof PStream)){
      const be = g(enc.BaseEncoding);
      if (be instanceof Name){ base = pickBase(be.name); this.baseEncName = be.name; }
      const diffs = g(enc.Differences);
      if (Array.isArray(diffs)){
        const t = (base || STD_ENC).slice();
        let code = 0;
        for (const it0 of diffs){
          const it = g(it0);
          if (typeof it === "number") code = it;
          else if (it instanceof Name) t[code++] = it.name;
        }
        this.encNames = t;
        this.hasDifferences = true;
        return;
      }
    }
    if (base) this.encNames = base.slice();
    else if (subName === "TrueType" || subName === "Type1" || subName === "MMType1" || subName === "Type3")
      this.encNames = STD_ENC.slice();          // 无声明时的保守默认
  }

  /* 把字符串字节切成码：简单字体 1 字节，Type0 一般 2 字节 */
  splitCodes(bytes){
    const out = [];
    if (this.type !== "composite"){
      for (let i = 0; i < bytes.length; i++) out.push({ code: bytes[i], raw: 1 });
      return out;
    }
    if (this.cmapRanges && this.cmapRanges.length){
      let i = 0;
      while (i < bytes.length){
        let n = 0, code = 0;
        for (const r of this.cmapRanges){
          if (i + r.nbytes > bytes.length) continue;
          let v = 0;
          for (let k = 0; k < r.nbytes; k++) v = v * 256 + bytes[i + k];
          if (v >= r.lo && v <= r.hi){ n = r.nbytes; code = v; break; }
        }
        if (!n){ n = 2; code = (bytes[i] << 8) | (bytes[i + 1] || 0); }
        out.push({ code, raw: n });
        i += n;
      }
      return out;
    }
    for (let i = 0; i + 1 < bytes.length; i += 2) out.push({ code: (bytes[i] << 8) | bytes[i + 1], raw: 2 });
    if (bytes.length % 2) out.push({ code: bytes[bytes.length - 1], raw: 1 });
    return out;
  }

  cidOf(code){
    if (this.cmapCid && this.cmapCid.has(code)) return this.cmapCid.get(code);
    return code;
  }

  widthOf(code){
    const key = this.type === "composite" ? this.cidOf(code) : code;
    const w = this.widths.get(key);
    if (typeof w === "number") return w / 1000;
    return this.defaultWidth / 1000;
  }

  /* 返回 {text, ok}；ok=false 表示这个码没能可靠还原 */
  unicodeOf(code){
    this.total++;
    if (this.toUnicode && this.toUnicode.has(code)){
      const s = this.toUnicode.get(code);
      if (s !== undefined && s !== "" && s !== "") return { text: s, ok: true };
    }
    if (this.encNames && this.encNames[code]){
      const u = glyphToUnicode(this.encNames[code]);
      if (u !== null){
        const s = typeof u === "number" ? String.fromCodePoint(u) : u.map(c => String.fromCodePoint(c)).join("");
        return { text: s, ok: true };
      }
    }
    if (this.type !== "composite" && !this.symbolic && code >= 32 && code < 127)
      return { text: String.fromCharCode(code), ok: true };
    /* Identity-H 且无 ToUnicode：码就是字体内部字形号，与 Unicode 无关。
       这里绝不能拿 code 当字符返回——那正是"乱码"的来源。 */
    this.undecodable++;
    return { text: null, ok: false };
  }

  get reliability(){
    if (!this.total) return 1;
    return 1 - this.undecodable / this.total;
  }

  /* 给输出层用的一句话描述 */
  describe(){
    const bits = [this.name];
    if (this.bold) bits.push("粗体");
    if (this.italic) bits.push("斜体");
    if (!this.embedded) bits.push("未内嵌");
    return bits.join(" ");
  }
}

/* 字体缓存：同一份资源字典里的字体反复出现，重建代价很高 */
function getFont(doc, ref, resName, cache){
  const key = ref instanceof Ref ? "R" + ref.num : "N" + resName;
  if (cache.has(key)) return cache.get(key);
  let f = null;
  try {
    const d = doc.get(ref);
    if (d && typeof d === "object" && !(d instanceof PStream)) f = new PdfFont(d, doc, resName);
  } catch (e){ f = null; }
  cache.set(key, f);
  return f;
}

/* ===== 3-render.js ===== */
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

/* ===== 4-layout.js ===== */
/* ============================================================
   4-layout.js —— 语义重建层
   PDF 里没有段落、没有文本框、没有表格，只有「把字画在某坐标」。
   这一层负责从几何关系把语义重新拼回来。

   铁律：这一层输出的每一条都是「推断」，必须带置信度。
   宁可标「无法确定」，也不许给 AI 一个自信的错误结论。
   ============================================================ */

/* ---------- 通用 ---------- */
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const median = a => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mode = a => {
  if (!a.length) return 0;
  const c = new Map();
  for (const v of a){ const k = Math.round(v * 10) / 10; c.set(k, (c.get(k) || 0) + 1); }
  let best = null, bn = -1;
  for (const [k, n] of c) if (n > bn){ bn = n; best = k; }
  return best;
};

/* 中日韩文字（含全角标点）。这类文字不用空格分词，补空格的规则完全不同。 */
const CJK_RE = /[⺀-鿿豈-﫿︰-﹏＀-￯　-〿]/;
const isCJK = ch => !!ch && CJK_RE.test(ch);

/* 文字的上下沿。PDF 只给基线，字面高度要从字体框推。 */
function textTop(it){
  const f = it.font;
  let asc = 0.78;
  if (f && f.bbox && f.bbox.length === 4 && f.bbox[3] > 0) asc = Math.min(1.2, f.bbox[3] / 1000);
  return it.y0 - asc * it.size;
}
function textBottom(it){
  const f = it.font;
  let desc = 0.22;
  if (f && f.bbox && f.bbox.length === 4 && f.bbox[1] < 0) desc = Math.min(0.5, -f.bbox[1] / 1000);
  return it.y0 + desc * it.size;
}
const itemBox = it => it.kind === "text"
  ? [Math.min(it.x0, it.x1), textTop(it), Math.max(it.x0, it.x1), textBottom(it)]
  : it.bbox;

/* 把同一行里的若干文字片段拼成一个字符串，并按需补回空格。

   PDF 常常不写空格字符，靠摆位置制造词间距。用固定阈值判必然两头不讨好：
   0.2em 会把 letter-spacing 的标题（"L A T A M"）拆成一堆单字母，
   0.4em 又会把正常的词粘在一起。
   真正的判据是「这个间隙相对同组其它间隙是不是异常大」——
   字间距是均匀的，词间空格是突出的。所以阈值按组自适应。

   表格单元格也用这个函数，保证同一套规则。 */
function joinPartsAdaptive(parts){
  const gaps = [];
  for (let i = 1; i < parts.length; i++){
    const a = parts[i - 1], b = parts[i];
    const g = Math.min(b.x0, b.x1) - Math.max(a.x0, a.x1);
    if (g > 0.01) gaps.push(g);
  }
  const medGap = gaps.length >= 3 ? median(gaps) : 0;

  let text = "", prevEnd = null, prevSize = parts.length ? parts[0].size : 10;
  let bad = 0, total = 0;
  const seps = [];                    // seps[i] = 第 i 段前面补的分隔符，逐 run 输出时要用
  parts.forEach(p => {
    let sep = "";
    const left = Math.min(p.x0, p.x1);
    if (prevEnd !== null && p.text.length){
      const gap = left - prevEnd;
      const em = Math.max(prevSize, p.size);
      /* 中日韩文字本来就不用空格分词，门槛要高得多，
         否则每两个汉字之间都会被塞进一个空格 */
      const bothCJK = isCJK(text.slice(-1)) && isCJK(p.text.slice(0, 1));
      const thr = bothCJK ? em * 0.45 : Math.max(em * 0.20, medGap * 1.8);
      if (gap > thr && !/\s$/.test(text)) sep = " ";
    }
    seps.push(sep);
    text += sep + p.text;
    bad += p.badCount || 0;
    total += p.text.length;
    prevEnd = Math.max(p.x0, p.x1);
    prevSize = p.size;
  });
  return { text, bad, total, seps };
}

/* ---------- 1. 文字块 -> 行 ---------- */
function buildLines(texts){
  /* 旋转文字单独成组：竖排标签、水印、旋转表头，混进正文会毁掉行聚类 */
  const flat = [], rotated = [];
  for (const t of texts){
    const r = ((t.rot % 360) + 360) % 360;
    if (r < 3 || r > 357) flat.push(t); else rotated.push(t);
  }

  flat.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  const lines = [];
  for (const t of flat){
    const tol = Math.max(1.2, t.size * 0.32);
    let hit = null;
    /* 从后往前找同一基线的行；只回看少量行，避免 O(n²) */
    for (let i = lines.length - 1, k = 0; i >= 0 && k < 24; i--, k++){
      const L = lines[i];
      if (Math.abs(L.baseline - t.y0) <= Math.max(tol, L.size * 0.32)){
        /* 字号差太多就不算同一行（上下标除外，那个 size 小很多但基线也不同） */
        if (Math.min(L.size, t.size) / Math.max(L.size, t.size) > 0.45){ hit = L; break; }
      }
      if (L.baseline < t.y0 - t.size * 3) break;
    }
    if (hit){
      hit.parts.push(t);
      hit.baseline = (hit.baseline * (hit.parts.length - 1) + t.y0) / hit.parts.length;
      hit.size = Math.max(hit.size, t.size);
    } else {
      lines.push({ baseline: t.y0, size: t.size, parts: [t] });
    }
  }

  const out = [];
  for (const L of lines){
    L.parts.sort((a, b) => a.x0 - b.x0);

    const { text, bad, total, seps } = joinPartsAdaptive(L.parts);
    const xs = L.parts.map(p => Math.min(p.x0, p.x1));
    const xe = L.parts.map(p => Math.max(p.x0, p.x1));
    const sizes = L.parts.map(p => p.size);
    out.push({
      kind: "line",
      text,
      x0: Math.min(...xs), x1: Math.max(...xe),
      top: Math.min(...L.parts.map(textTop)), bottom: Math.max(...L.parts.map(textBottom)),
      baseline: L.baseline,
      size: median(sizes), maxSize: Math.max(...sizes),
      /* 同一基线上出现多种字号是很常见的（"占 31% 份额" 里数字更大）。
         median 会把它们抹平成一个数，所以要保留原始清单，让输出层知道该逐 run 展开。 */
      sizeSet: Array.from(new Set(sizes.map(s => Math.round(s * 10) / 10))),
      parts: L.parts, seps,
      bold: L.parts.some(p => p.bold), italic: L.parts.some(p => p.italic),
      allBold: L.parts.every(p => p.bold),
      fonts: Array.from(new Set(L.parts.map(p => p.fontName))),
      color: mostCommon(L.parts.map(p => p.color)),
      colors: Array.from(new Set(L.parts.map(p => p.color).filter(Boolean))),
      bad, total,
      seq: Math.min(...L.parts.map(p => p.seq)),
      fromAnnot: L.parts[0].fromAnnot || null
    });
  }
  out.sort((a, b) => (a.top - b.top) || (a.x0 - b.x0));
  return { lines: out, rotated };
}

function mostCommon(arr){
  const c = new Map();
  for (const v of arr){ if (v == null) continue; c.set(v, (c.get(v) || 0) + 1); }
  let best = null, bn = 0;
  for (const [k, n] of c) if (n > bn){ bn = n; best = k; }
  return best;
}

/* ---------- 2. 行 -> 段落 ----------

   这是整个工具里最主观的一步，也是最影响 AI 还原质量的一步：
   合并太狠，两段并成一段，AI 建出来的 PPT 少一个项目符号；
   合并太松，一段拆成八行，AI 会当成八个独立文本框。

   下面的默认规则按「商务 PPT 导出的 PDF + 研报」调过，判据依次是：
   行距、左右边界、字号一致性、以及上一行的结尾是否像句子结束。
*/
function shouldMergeLines(prev, next, ctx){
  const gap = next.top - prev.bottom;
  const lead = next.baseline - prev.baseline;
  const size = Math.max(prev.size, next.size);

  /* 字号差超过 15% —— 多半是标题接正文，不能并 */
  if (Math.min(prev.size, next.size) / size < 0.85) return false;
  /* 粗细不一致：标题/强调行独立成段 */
  if (prev.allBold !== next.allBold) return false;
  /* 行距超过 1.9 倍字号 —— 段间距，不是行距 */
  if (lead > size * 1.9 || gap > size * 1.1) return false;
  /* 行距为负或为零：不是正常的上下行 */
  if (lead < size * 0.4) return false;

  /* 水平方向必须有实质重叠，否则是并排的两栏 */
  const ov = Math.min(prev.x1, next.x1) - Math.max(prev.x0, next.x0);
  const minW = Math.min(prev.x1 - prev.x0, next.x1 - next.x0);
  if (ov < minW * 0.5) return false;

  /* 上一行明显没写满（右边界比本段最宽行短一大截）且以句末标点结尾 —— 段落结束 */
  const short = (ctx.maxRight - prev.x1) > size * 2.5;
  if (short && /[。．.！!？?；;：:]\s*$/.test(prev.text)) return false;
  /* 上一行是短行且下一行有首行缩进 —— 新段落 */
  if (short && (next.x0 - ctx.minLeft) > size * 1.2) return false;
  /* 项目符号开头 —— 每条独立 */
  if (/^\s*([•·▪◦‣∙●○■□◆◇\-–—*]|\(?\d{1,2}[.)、]|[a-zA-Z][.)]|[一二三四五六七八九十]+[、.])\s+/.test(next.text)) return false;

  return true;
}

function buildParagraphs(lines, opt){
  if (!opt.mergePara) return lines.map(l => lineToPara([l]));
  const paras = [];
  let cur = [];
  for (const L of lines){
    if (!cur.length){ cur = [L]; continue; }
    const prev = cur[cur.length - 1];
    const ctx = {
      maxRight: Math.max(...cur.map(l => l.x1)),
      minLeft: Math.min(...cur.map(l => l.x0))
    };
    if (shouldMergeLines(prev, L, ctx)) cur.push(L);
    else { paras.push(lineToPara(cur)); cur = [L]; }
  }
  if (cur.length) paras.push(lineToPara(cur));
  return paras;
}

function lineToPara(ls){
  const joinText = ls.map(l => l.text).join("\n");
  const sizes = ls.map(l => l.size);
  return {
    kind: "para",
    lines: ls,
    text: joinText,
    /* 单行合并成一句：中文行尾不补空格，西文补 */
    flowText: ls.reduce((acc, l, i) => {
      if (!i) return l.text;
      const prevCh = acc.slice(-1), curCh = l.text.slice(0, 1);
      const cjk = /[　-鿿＀-￯]/;
      const needSpace = !cjk.test(prevCh) && !cjk.test(curCh) && !/[-\s]$/.test(acc);
      return acc + (needSpace ? " " : "") + l.text;
    }, ""),
    x0: Math.min(...ls.map(l => l.x0)), x1: Math.max(...ls.map(l => l.x1)),
    top: Math.min(...ls.map(l => l.top)), bottom: Math.max(...ls.map(l => l.bottom)),
    size: median(sizes), maxSize: Math.max(...ls.map(l => l.maxSize)),
    bold: ls.some(l => l.bold), allBold: ls.every(l => l.allBold),
    italic: ls.some(l => l.italic),
    fonts: Array.from(new Set(ls.flatMap(l => l.fonts))),
    color: mostCommon(ls.map(l => l.color)),
    colors: Array.from(new Set(ls.flatMap(l => l.colors))),
    lineGap: ls.length > 1 ? median(ls.slice(1).map((l, i) => l.baseline - ls[i].baseline)) : null,
    bad: ls.reduce((a, l) => a + l.bad, 0),
    total: ls.reduce((a, l) => a + l.total, 0),
    seq: Math.min(...ls.map(l => l.seq)),
    fromAnnot: ls[0].fromAnnot || null
  };
}

/* ---------- 3. 段落 -> 文本块（对应 PPT 里一个文本框） ---------- */
function groupBlocks(paras){
  const blocks = [];
  const used = new Set();
  const sorted = paras.slice().sort((a, b) => a.top - b.top);
  for (let i = 0; i < sorted.length; i++){
    if (used.has(i)) continue;
    const group = [sorted[i]];
    used.add(i);
    for (let j = i + 1; j < sorted.length; j++){
      if (used.has(j)) continue;
      const p = sorted[j];
      const last = group[group.length - 1];
      const gap = p.top - Math.max(...group.map(q => q.bottom));
      if (gap > Math.max(last.size, p.size) * 2.2) break;
      /* 左边界对齐（同一个文本框里的多段通常共享左边界或缩进层级） */
      const leftAligned = Math.abs(p.x0 - last.x0) < Math.max(last.size, p.size) * 1.6;
      const ov = Math.min(last.x1, p.x1) - Math.max(last.x0, p.x0);
      const minW = Math.min(last.x1 - last.x0, p.x1 - p.x0);
      if (leftAligned && ov > minW * 0.35 && gap >= -1){ group.push(p); used.add(j); }
    }
    blocks.push({
      kind: "textblock",
      paras: group,
      x0: Math.min(...group.map(p => p.x0)), x1: Math.max(...group.map(p => p.x1)),
      top: Math.min(...group.map(p => p.top)), bottom: Math.max(...group.map(p => p.bottom)),
      size: median(group.map(p => p.size)),
      seq: Math.min(...group.map(p => p.seq)),
      fromAnnot: group[0].fromAnnot || null
    });
  }
  return blocks;
}

/* ---------- 4. 分栏检测（研报/白皮书必需） ---------- */
function detectColumns(blocks, pageW, pageH){
  const items = blocks.filter(b => (b.x1 - b.x0) > 2);
  if (items.length < 4) return { columns: 1, gutters: [], confidence: 0 };

  const left = Math.min(...items.map(b => b.x0));
  const right = Math.max(...items.map(b => b.x1));
  const top = Math.min(...items.map(b => b.top));
  const bottom = Math.max(...items.map(b => b.bottom));
  const spanH = bottom - top;
  if (right - left < pageW * 0.3 || spanH <= 0) return { columns: 1, gutters: [], confidence: 0 };

  /* 把每个块投影到 x 轴，找始终没有内容的竖直空隙 */
  const N = 400;
  const step = (right - left) / N;
  const cover = new Float64Array(N);
  for (const b of items){
    const i0 = Math.max(0, Math.floor((b.x0 - left) / step));
    const i1 = Math.min(N - 1, Math.ceil((b.x1 - left) / step));
    for (let i = i0; i <= i1; i++) cover[i] += (b.bottom - b.top);
  }
  const gutters = [];
  let run = -1;
  for (let i = 0; i <= N; i++){
    const empty = i < N && cover[i] <= spanH * 0.02;
    if (empty && run < 0) run = i;
    else if (!empty && run >= 0){
      const w = (i - run) * step;
      /* 栏间距至少要有 1.5% 页宽，且不能贴着页边 */
      if (w > pageW * 0.015 && run > 2 && i < N - 2)
        gutters.push({ x0: left + run * step, x1: left + i * step, w });
      run = -1;
    }
  }
  /* 只保留足够宽的空隙，且栏数不超过 4 —— 再多基本是表格不是分栏 */
  gutters.sort((a, b) => b.w - a.w);
  const keep = gutters.slice(0, 3).filter(g => g.w > pageW * 0.02).sort((a, b) => a.x0 - b.x0);
  if (!keep.length) return { columns: 1, gutters: [], confidence: 0 };

  /* 验证：每一栏都要有足够多的块，否则那不是分栏，是个别元素造成的空隙 */
  const bounds = [left, ...keep.map(g => (g.x0 + g.x1) / 2), right];
  const counts = [];
  for (let i = 0; i < bounds.length - 1; i++)
    counts.push(items.filter(b => (b.x0 + b.x1) / 2 >= bounds[i] && (b.x0 + b.x1) / 2 < bounds[i + 1]).length);
  const valid = counts.filter(c => c >= 2).length;
  if (valid < 2) return { columns: 1, gutters: [], confidence: 0 };

  const conf = Math.min(0.95, 0.45 + 0.15 * Math.min(counts.length, 3) + (Math.min(...counts) >= 3 ? 0.2 : 0));
  return { columns: counts.length, gutters: keep, bounds, confidence: conf };
}

/* ---------- 5. 页眉页脚（跨页统计，单页判不了） ---------- */
function normForRepeat(s){
  return s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 60);
}
function markHeadersFooters(pages, pageH){
  const n = pages.length;
  if (n < 3) return;                                  // 页数太少，统计不可靠，宁可不判
  const tally = new Map();
  for (let pi = 0; pi < n; pi++){
    for (const b of pages[pi].blocks){
      const rel = b.top / (pages[pi].h || pageH);
      const relB = b.bottom / (pages[pi].h || pageH);
      if (rel > 0.12 && relB < 0.88) continue;
      const key = (rel <= 0.12 ? "H|" : "F|") + normForRepeat(b.paras.map(p => p.text).join(" "));
      if (!tally.has(key)) tally.set(key, []);
      tally.get(key).push({ pi, b });
    }
  }
  const need = Math.max(3, Math.ceil(n * 0.5));
  for (const [key, list] of tally){
    const pagesHit = new Set(list.map(x => x.pi)).size;
    if (pagesHit >= need){
      for (const { b } of list){
        b.role = key[0] === "H" ? "页眉" : "页脚";
        b.roleConfidence = Math.min(0.95, pagesHit / n);
      }
    }
  }
  /* 纯页码：单独一个数字且位置在页首/页尾，即使内容每页不同也算 */
  for (const pg of pages){
    for (const b of pg.blocks){
      if (b.role) continue;
      const t = b.paras.map(p => p.text).join(" ").trim();
      const rel = b.top / (pg.h || pageH), relB = b.bottom / (pg.h || pageH);
      if (/^[\-—–\s]*\d{1,4}[\-—–\s]*$/.test(t) && (rel <= 0.10 || relB >= 0.90)){
        b.role = relB >= 0.90 ? "页脚" : "页眉";
        b.roleConfidence = 0.8;
        b.isPageNumber = true;
      }
    }
  }
}

/* ---------- 6. 线条抽取（表格与分隔线的基础） ---------- */
/* 抽取横线与竖线。

   必须逐「子路径」看，不能只看整个路径的外接框：
   很多生成器（含 PyMuPDF 自己）把整张表格的十几条框线一次性提交成
   一个路径对象。那个对象的外接框就是整张表的大小，既不细也不长，
   只看外接框会一条线都抽不出来 —— 表格随之整个漏检，
   而输出看起来完全正常（文字都在，只是降级成了普通文本块）。 */
function extractRules(paths){
  const hs = [], vs = [];
  for (const p of paths){
    const lw = p.lineWidth || 1;
    for (const sub of p.subpaths){
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of sub.pts){
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (!isFinite(x0)) continue;
      const w = x1 - x0, h = y1 - y0;

      if (p.stroke){
        if (h <= Math.max(2.5, lw * 1.6) && w > 6)
          hs.push({ y: (y0 + y1) / 2, x0, x1, w, thick: Math.max(lw, h), color: p.stroke, dash: p.dash, item: p });
        else if (w <= Math.max(2.5, lw * 1.6) && h > 6)
          vs.push({ x: (x0 + x1) / 2, y0, y1, h, thick: Math.max(lw, w), color: p.stroke, dash: p.dash, item: p });
      }
      /* 细长填充矩形 —— 大量 PDF 的表格线是填出来的，不是描出来的。
         只认矩形子路径，否则字形轮廓那种复杂填充路径会喷出一堆假线。 */
      if (p.fill && sub.isRect){
        if (h <= 3.2 && w > 6)
          hs.push({ y: (y0 + y1) / 2, x0, x1, w, thick: h, color: p.fill, dash: null, item: p, filled: true });
        else if (w <= 3.2 && h > 6)
          vs.push({ x: (x0 + x1) / 2, y0, y1, h, thick: w, color: p.fill, dash: null, item: p, filled: true });
      }
    }
  }
  return { hs, vs };
}

function cluster1D(values, tol){
  const s = values.slice().sort((a, b) => a - b);
  const out = [];
  for (const v of s){
    if (out.length && v - out[out.length - 1].max <= tol){
      const g = out[out.length - 1];
      g.vals.push(v); g.max = v; g.c = avg(g.vals);
    } else out.push({ vals: [v], max: v, c: v });
  }
  return out.map(g => g.c);
}

/* ---------- 7. 表格检测 ---------- */
function detectTables(rules, lines, pageW, pageH, opt){
  if (!opt.tables) return [];
  const tables = [];
  const { hs, vs } = rules;
  if (hs.length < 2 || vs.length < 1) return detectUnruledTables(lines, pageW, opt);

  /* 把线按连通区域聚成候选表格 */
  const tol = 3.0;
  const ys = cluster1D(hs.map(h => h.y), tol);
  const xs = cluster1D(vs.map(v => v.x), tol);
  if (ys.length < 2 || xs.length < 2) return detectUnruledTables(lines, pageW, opt);

  /* 用横线的 x 跨度和竖线的 y 跨度求交集，确定表格外框 */
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 - x0 < 20 || y1 - y0 < 10) return detectUnruledTables(lines, pageW, opt);

  /* 只保留真正落在框内、且跨度够长的线 */
  const rowYs = ys.filter(y => hs.some(h => Math.abs(h.y - y) <= tol && h.w > (x1 - x0) * 0.25));
  const colXs = xs.filter(x => vs.some(v => Math.abs(v.x - x) <= tol && v.h > (y1 - y0) * 0.25));
  if (rowYs.length < 2 || colXs.length < 2) return detectUnruledTables(lines, pageW, opt);

  const rows = rowYs.length - 1, cols = colXs.length - 1;
  /* 只有一列的「表格」不是表格，那只是几条横线。
     整页的装饰边框最容易被误判成这个，一旦误判会把整页正文全吞进去。 */
  if (rows < 2 || cols < 2 || rows * cols > 2000) return detectUnruledTables(lines, pageW, opt);

  /* 填单元格：必须按文字片段分配，不能按整行。
     一行文字往往横跨好几列，整行的中心点永远落在中间那一列，
     结果是两边的列全空、内容全挤在中间——看起来还挺像回事，但全错。 */
  const cellOf = (x, y) => {
    let c = -1, r = -1;
    for (let i = 0; i < cols; i++) if (x >= colXs[i] - 1 && x <= colXs[i + 1] + 1){ c = i; break; }
    for (let i = 0; i < rows; i++) if (y >= rowYs[i] - 1 && y <= rowYs[i + 1] + 1){ r = i; break; }
    return (c >= 0 && r >= 0) ? [r, c] : null;
  };

  const buckets = new Map();                   // "r,c" -> [{p, L}]
  const usedLines = new Set();
  for (const L of lines){
    let touched = false;
    for (const p of L.parts){
      const px = (Math.min(p.x0, p.x1) + Math.max(p.x0, p.x1)) / 2;
      const py = L.baseline - p.size * 0.35;   // 取字面中部，避开行边界
      const rc = cellOf(px, py);
      if (!rc) continue;
      const key = rc[0] + "," + rc[1];
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ p, L });
      touched = true;
    }
    if (touched) usedLines.add(L);
  }

  const grid = [];
  for (let r = 0; r < rows; r++){
    const row = [];
    for (let c = 0; c < cols; c++){
      const items = buckets.get(r + "," + c) || [];
      /* 一个单元格里可能有多行，按基线分组后各自拼接 */
      const byLine = new Map();
      for (const it of items){
        const k = Math.round(it.L.baseline * 2);
        if (!byLine.has(k)) byLine.set(k, []);
        byLine.get(k).push(it.p);
      }
      const cellLines = Array.from(byLine.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, ps]) => joinPartsAdaptive(ps.sort((a, b) => a.x0 - b.x0)).text);
      const parts = items.map(it => it.p);
      row.push({
        text: cellLines.join("\n"),
        x0: colXs[c], x1: colXs[c + 1], y0: rowYs[r], y1: rowYs[r + 1],
        size: parts.length ? median(parts.map(p => p.size)) : null,
        bold: parts.length > 0 && parts.every(p => p.bold),
        color: mostCommon(parts.map(p => p.color)),
        align: parts.length ? guessAlignParts(parts, colXs[c], colXs[c + 1]) : null
      });
    }
    grid.push(row);
  }

  const filled = grid.flat().filter(c => c.text.trim()).length;
  const ratio = filled / (rows * cols);
  /* 空得太厉害说明这堆线其实不是表格（可能是页面装饰框） */
  if (ratio < 0.25) return detectUnruledTables(lines, pageW, opt);

  /* 记下被表格用掉的路径，输出时不要再当成独立形状重复列一遍 */
  const usedPaths = new Set();
  for (const h of hs) if (rowYs.some(y => Math.abs(h.y - y) <= tol)) usedPaths.add(h.item);
  for (const v of vs) if (colXs.some(x => Math.abs(v.x - x) <= tol)) usedPaths.add(v.item);

  tables.push({
    kind: "table", ruled: true,
    x0, y0, x1, y1, rows, cols, grid,
    colXs, rowYs,
    usedLines, usedPaths,
    confidence: Math.min(0.95, 0.55 + ratio * 0.4),
    reason: `由 ${rowYs.length} 条横线和 ${colXs.length} 条竖线围成，${filled}/${rows * cols} 个单元格有内容`
  });
  return tables;
}

function guessAlignParts(parts, x0, x1){
  const w = x1 - x0;
  if (w <= 0 || !parts.length) return null;
  const left = Math.min(...parts.map(p => Math.min(p.x0, p.x1)));
  const right = Math.max(...parts.map(p => Math.max(p.x0, p.x1)));
  const l = (left - x0) / w, r = (x1 - right) / w;
  if (Math.abs(l - r) < 0.10) return "居中";
  if (r < l * 0.5) return "右对齐";
  return "左对齐";
}

/* 无框线表格：靠列对齐识别。判据严格，因为误判代价高。 */
function detectUnruledTables(lines, pageW, opt){
  if (!opt.tables || lines.length < 6) return [];
  const out = [];
  /* 找连续的、每行都被大间隙切成 >=2 段的行 */
  const seg = L => {
    const parts = L.parts.slice().sort((a, b) => a.x0 - b.x0);
    const cells = [];
    let curText = "", curX0 = null, curX1 = null, prevEnd = null, sz = L.size;
    for (const p of parts){
      const left = Math.min(p.x0, p.x1), right = Math.max(p.x0, p.x1);
      if (prevEnd !== null && (left - prevEnd) > sz * 1.6){
        cells.push({ text: curText.trim(), x0: curX0, x1: curX1 });
        curText = ""; curX0 = null;
      }
      if (curX0 === null) curX0 = left;
      curX1 = right;
      curText += (curText && (left - (prevEnd || left)) > sz * 0.2 ? " " : "") + p.text;
      prevEnd = right;
    }
    if (curText.trim()) cells.push({ text: curText.trim(), x0: curX0, x1: curX1 });
    return cells;
  };

  let run = [];
  const flush = () => {
    if (run.length >= 3){
      const colCounts = run.map(r => r.cells.length);
      const nCols = mode(colCounts);
      const consistent = colCounts.filter(c => c === nCols).length / colCounts.length;
      /* 列起点必须跨行对齐 */
      const starts = [];
      for (const r of run) r.cells.forEach((c, i) => { (starts[i] = starts[i] || []).push(c.x0); });
      const jitter = starts.slice(0, nCols).map(s => {
        const m = median(s);
        return avg(s.map(v => Math.abs(v - m)));
      });
      const sz = median(run.map(r => r.line.size));
      const aligned = jitter.length && jitter.every(j => j < sz * 1.2);
      if (nCols >= 2 && consistent >= 0.7 && aligned){
        const grid = run.map(r => {
          const row = [];
          for (let i = 0; i < nCols; i++){
            const c = r.cells[i];
            row.push({ text: c ? c.text : "", x0: c ? c.x0 : null, x1: c ? c.x1 : null,
                       size: r.line.size, bold: r.line.allBold, color: r.line.color, align: null });
          }
          return row;
        });
        out.push({
          kind: "table", ruled: false,
          x0: Math.min(...run.map(r => r.line.x0)), x1: Math.max(...run.map(r => r.line.x1)),
          y0: Math.min(...run.map(r => r.line.top)), y1: Math.max(...run.map(r => r.line.bottom)),
          rows: run.length, cols: nCols, grid,
          usedLines: new Set(run.map(r => r.line)),
          confidence: Math.min(0.75, 0.35 + consistent * 0.3 + (run.length >= 5 ? 0.1 : 0)),
          reason: `连续 ${run.length} 行按 ${nCols} 列对齐（无框线，靠列对齐推断，请核对）`
        });
      }
    }
    run = [];
  };

  for (let i = 0; i < lines.length; i++){
    const L = lines[i];
    const cells = seg(L);
    const prev = run.length ? run[run.length - 1].line : null;
    const contiguous = !prev || (L.top - prev.bottom) < L.size * 1.6;
    if (cells.length >= 2 && contiguous) run.push({ line: L, cells });
    else { flush(); if (cells.length >= 2) run.push({ line: L, cells }); }
  }
  flush();
  return out;
}

/* ---------- 8. 形状分类 ---------- */
const AXIS_TOL = 0.8;
function classifyPath(p, pageW, pageH){
  const [x0, y0, x1, y1] = p.bbox;
  const w = x1 - x0, h = y1 - y0;
  const area = w * h;
  const pageArea = pageW * pageH;
  const sp = p.subpaths;

  const out = { w, h, area };

  /* 整页填充 = 背景 */
  if (p.fill && area > pageArea * 0.88 && w > pageW * 0.93 && h > pageH * 0.93){
    out.type = "背景"; out.confidence = 0.9; return out;
  }
  /* 细长 = 线条 */
  const thin = Math.min(w, h);
  if (thin <= 3.2 && Math.max(w, h) > 6){
    out.type = w >= h ? "水平线" : "垂直线";
    out.confidence = 0.9;
    return out;
  }
  if (sp.length === 1 && sp[0].pts.length === 2){
    const [a, b] = sp[0].pts;
    const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    out.type = dy < AXIS_TOL ? "水平线" : dx < AXIS_TOL ? "垂直线" : "斜线";
    out.confidence = 0.95;
    return out;
  }

  const single = sp.length === 1 ? sp[0] : null;
  if (single){
    if (single.isRect){
      out.type = (Math.abs(w - h) / Math.max(w, h) < 0.02) ? "正方形" : "矩形";
      out.confidence = 0.95;
      return out;
    }
    const pts = dedupePts(single.pts);
    if (!single.curves){
      if (pts.length === 4 && isAxisRect(pts)){
        out.type = (Math.abs(w - h) / Math.max(w, h) < 0.02) ? "正方形" : "矩形";
        out.confidence = 0.92; return out;
      }
      if (pts.length === 3){ out.type = "三角形"; out.confidence = 0.85; return out; }
      if (pts.length === 4){ out.type = "四边形"; out.confidence = 0.75; return out; }
      if (pts.length >= 5 && pts.length <= 10 && single.closed){
        out.type = `${pts.length}边形`; out.confidence = 0.7; return out;
      }
      if (!single.closed && pts.length > 3){ out.type = "折线"; out.confidence = 0.8; return out; }
    } else {
      const nCurves = single.ctrl ? single.ctrl.length : 0;
      /* 4 段贝塞尔闭合 = 椭圆；圆角矩形是 4 段短弧 + 4 条直边 */
      if (nCurves === 4 && single.closed && isEllipseLike(single, x0, y0, x1, y1)){
        out.type = (Math.abs(w - h) / Math.max(w, h) < 0.03) ? "圆形" : "椭圆";
        out.confidence = 0.85;
        out.radius = [w / 2, h / 2];
        return out;
      }
      if (nCurves >= 2 && nCurves <= 8 && single.closed){
        const r = cornerRadius(single, x0, y0, x1, y1);
        if (r !== null){
          out.type = "圆角矩形"; out.confidence = 0.8; out.cornerRadius = r; return out;
        }
      }
      if (!single.closed){ out.type = "曲线"; out.confidence = 0.75; return out; }
      out.type = "自由形状"; out.confidence = 0.6; return out;
    }
  }

  /* 多子路径：可能是带洞的形状、图标、或一组箭头 */
  if (sp.length > 1 && sp.length <= 3 && sp.every(s => s.isRect)){
    out.type = "矩形组"; out.confidence = 0.7; return out;
  }
  out.type = "复合路径";
  out.subCount = sp.length;
  out.confidence = 0.5;
  return out;
}

function dedupePts(pts){
  const out = [];
  for (const p of pts){
    const l = out[out.length - 1];
    if (!l || Math.abs(l[0] - p[0]) > 0.05 || Math.abs(l[1] - p[1]) > 0.05) out.push(p);
  }
  if (out.length > 1){
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05) out.pop();
  }
  return out;
}
function isAxisRect(pts){
  if (pts.length !== 4) return false;
  for (let i = 0; i < 4; i++){
    const a = pts[i], b = pts[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > AXIS_TOL && Math.abs(a[1] - b[1]) > AXIS_TOL) return false;
  }
  return true;
}
function isEllipseLike(sp, x0, y0, x1, y1){
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  if (rx < 0.5 || ry < 0.5) return false;
  let err = 0, n = 0;
  for (const [px, py] of sp.pts){
    const d = Math.pow((px - cx) / rx, 2) + Math.pow((py - cy) / ry, 2);
    err += Math.abs(d - 1); n++;
  }
  return n > 4 && err / n < 0.12;
}
function cornerRadius(sp, x0, y0, x1, y1){
  /* 圆角矩形：绝大多数点应该贴在四条边上，只有角落偏离 */
  let onEdge = 0, total = 0, maxIn = 0;
  for (const [px, py] of sp.pts){
    total++;
    const dl = Math.abs(px - x0), dr = Math.abs(px - x1);
    const dt = Math.abs(py - y0), db = Math.abs(py - y1);
    const m = Math.min(dl, dr, dt, db);
    if (m < 0.6) onEdge++;
    else maxIn = Math.max(maxIn, Math.min(Math.min(dl, dr), Math.min(dt, db)));
  }
  if (total < 8) return null;
  if (onEdge / total < 0.45) return null;
  const r = maxIn;
  if (r <= 0.5 || r > Math.min(x1 - x0, y1 - y0) / 2 + 1) return null;
  return r;
}

/* ---------- 9. 疑似图表 ---------- */
function detectCharts(shapes, lines, pageW, pageH, opt){
  if (!opt.charts) return [];
  const charts = [];
  const rects = shapes.filter(s => (s.shape.type === "矩形" || s.shape.type === "正方形") && s.item.fill
                                   && s.shape.area > 4 && s.shape.area < pageW * pageH * 0.5);

  /* --- 柱形图：一组等宽、共底线、不同高的矩形 --- */
  const byWidth = new Map();
  for (const r of rects){
    const w = Math.round((r.item.bbox[2] - r.item.bbox[0]) * 2) / 2;
    if (w < 1) continue;
    if (!byWidth.has(w)) byWidth.set(w, []);
    byWidth.get(w).push(r);
  }
  for (const [w, group] of byWidth){
    if (group.length < 3) continue;
    /* 共底（垂直柱）或共左（水平条） */
    for (const [axis, getBase, getLen] of [
      ["垂直柱", r => r.item.bbox[3], r => r.item.bbox[3] - r.item.bbox[1]],
      ["水平条", r => r.item.bbox[0], r => r.item.bbox[2] - r.item.bbox[0]]
    ]){
      const bases = group.map(getBase);
      const bm = median(bases);
      const aligned = group.filter(r => Math.abs(getBase(r) - bm) < 1.5);
      if (aligned.length < 3) continue;
      const lens = aligned.map(getLen);
      if (new Set(lens.map(v => Math.round(v))).size < 2) continue;   // 长度全一样，那是表格底纹不是柱子
      const bbox = unionBox(aligned.map(r => r.item.bbox));
      const near = lines.filter(L => boxOverlap([L.x0, L.top, L.x1, L.bottom],
        [bbox[0] - 40, bbox[1] - 25, bbox[2] + 40, bbox[3] + 30]) > 0);
      charts.push({
        kind: "chart", guess: "柱形图（" + axis + "）",
        bbox,
        series: aligned.sort((a, b) => a.item.bbox[0] - b.item.bbox[0]).map(r => ({
          x0: r.item.bbox[0], y0: r.item.bbox[1], x1: r.item.bbox[2], y1: r.item.bbox[3],
          len: getLen(r), color: r.item.fill
        })),
        colors: Array.from(new Set(aligned.map(r => r.item.fill))),
        labels: near.map(L => L.text).filter(t => t.trim()),
        members: new Set(aligned.map(r => r.item)),
        confidence: Math.min(0.8, 0.4 + aligned.length * 0.05),
        reason: `${aligned.length} 个等宽(${w.toFixed(1)}pt)、共基线、长度不同的填充矩形`
      });
      break;
    }
  }

  /* --- 饼图/环形图：一组共圆心的扇形（闭合曲线路径） --- */
  const wedges = shapes.filter(s => s.item.fill && s.item.subpaths.some(sp => sp.curves && sp.closed)
                                    && s.shape.type !== "圆形" && s.shape.type !== "椭圆"
                                    && s.shape.area > 20);
  if (wedges.length >= 2){
    const centers = wedges.map(s => {
      /* 扇形的圆心是那个被多次经过的点：取路径中出现频次最高的顶点 */
      const pts = s.item.subpaths.flatMap(sp => sp.pts);
      const cnt = new Map();
      for (const [x, y] of pts){
        const k = Math.round(x) + "," + Math.round(y);
        cnt.set(k, (cnt.get(k) || 0) + 1);
      }
      let bk = null, bn = 0;
      for (const [k, n] of cnt) if (n > bn){ bn = n; bk = k; }
      const [cx, cy] = bk.split(",").map(Number);
      return { s, cx, cy, hits: bn };
    });
    const groups = new Map();
    for (const c of centers){
      const key = Math.round(c.cx / 6) + "|" + Math.round(c.cy / 6);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const [, g] of groups){
      if (g.length < 2) continue;
      const bbox = unionBox(g.map(c => c.s.item.bbox));
      if (boxW(bbox) < 15 || boxH(bbox) < 15) continue;
      const near = lines.filter(L => boxOverlap([L.x0, L.top, L.x1, L.bottom],
        [bbox[0] - 60, bbox[1] - 30, bbox[2] + 60, bbox[3] + 30]) > 0);
      charts.push({
        kind: "chart", guess: g.length >= 3 ? "饼图/环形图" : "饼图/环形图（扇区偏少，可能是图标）",
        bbox,
        series: g.map(c => ({ color: c.s.item.fill, bbox: c.s.item.bbox })),
        colors: Array.from(new Set(g.map(c => c.s.item.fill))),
        labels: near.map(L => L.text).filter(t => t.trim()),
        members: new Set(g.map(c => c.s.item)),
        center: [g[0].cx, g[0].cy],
        confidence: Math.min(0.7, 0.3 + g.length * 0.08),
        reason: `${g.length} 个共圆心(±6pt)的闭合曲线填充路径`
      });
    }
  }

  /* --- 折线图：长折线 + 附近有坐标轴样的长直线 --- */
  const polylines = shapes.filter(s => (s.shape.type === "折线" || s.shape.type === "曲线")
                                       && s.item.stroke && s.item.subpaths.some(sp => sp.pts.length >= 4));
  for (const pl of polylines){
    const bbox = pl.item.bbox;
    if (boxW(bbox) < pageW * 0.08 || boxH(bbox) < 4) continue;
    const near = lines.filter(L => boxOverlap([L.x0, L.top, L.x1, L.bottom],
      [bbox[0] - 45, bbox[1] - 25, bbox[2] + 45, bbox[3] + 30]) > 0);
    const pts = pl.item.subpaths.flatMap(sp => sp.pts);
    charts.push({
      kind: "chart", guess: "折线图（数据系列）",
      bbox,
      polyline: pts,
      colors: [pl.item.stroke],
      lineWidth: pl.item.lineWidth,
      labels: near.map(L => L.text).filter(t => t.trim()),
      members: new Set([pl.item]),
      confidence: 0.45,
      reason: `一条含 ${pts.length} 个顶点、跨度 ${boxW(bbox).toFixed(0)}pt 的折线`
    });
  }

  /* 去重：同一区域重复报的只留置信度最高的 */
  charts.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const c of charts){
    if (kept.some(k => boxOverlap(k.bbox, c.bbox) > Math.min(boxW(c.bbox) * boxH(c.bbox), boxW(k.bbox) * boxH(k.bbox)) * 0.6)) continue;
    kept.push(c);
  }
  return kept;
}

function unionBox(list){
  return [Math.min(...list.map(b => b[0])), Math.min(...list.map(b => b[1])),
          Math.max(...list.map(b => b[2])), Math.max(...list.map(b => b[3]))];
}

/* ---------- 10. 单页总装 ---------- */
function analyzePage(raw, opt){
  const pageW = raw.w, pageH = raw.h;
  let items = raw.items;

  const stats = { hiddenLayer: 0, invisibleText: 0, clippedOut: 0 };

  items = items.filter(it => {
    if (it.hidden){ stats.hiddenLayer++; return false; }
    if (it.kind === "text" && it.invisible){ stats.invisibleText++; return false; }
    /* 完全落在裁剪框外的东西在阅读器里看不见 */
    const b = itemBox(it);
    if (b && it.clip){
      const ov = boxOverlap(b, it.clip);
      const a = Math.max(1e-6, (b[2] - b[0]) * (b[3] - b[1]));
      if (ov <= 0 && a > 0.5){ stats.clippedOut++; return false; }
    }
    return true;
  });

  const texts  = items.filter(it => it.kind === "text" && it.text.trim());
  const paths  = items.filter(it => it.kind === "path");
  const images = items.filter(it => it.kind === "image");
  const shadings = items.filter(it => it.kind === "shading");

  const { lines, rotated } = buildLines(texts);

  /* 形状分类 */
  const shapes = paths.map(p => ({ item: p, shape: classifyPath(p, pageW, pageH) }));

  /* 表格 */
  const rules = extractRules(paths);
  const tables = detectTables(rules, lines, pageW, pageH, opt);
  const inTable = new Set();
  for (const t of tables) if (t.usedLines) for (const L of t.usedLines) inTable.add(L);

  /* 图表 */
  const charts = detectCharts(shapes, lines, pageW, pageH, opt);
  const chartMembers = new Set();
  for (const c of charts) if (c.members) for (const m of c.members) chartMembers.add(m);

  /* 段落与文本块（表格里的行不参与） */
  const freeLines = lines.filter(L => !inTable.has(L));
  const paras = buildParagraphs(freeLines, opt);
  const blocks = groupBlocks(paras);

  /* 背景与装饰。表格框线和图表构件都已经在各自的条目里描述过了，不再单列。 */
  const tablePaths = new Set();
  for (const t of tables) if (t.usedPaths) for (const p of t.usedPaths) tablePaths.add(p);
  const bg = shapes.find(s => s.shape.type === "背景");
  const decor = shapes.filter(s => s !== bg && !chartMembers.has(s.item) && !tablePaths.has(s.item));

  return {
    w: pageW, h: pageH, rot: raw.rot,
    lines, rotated, blocks, tables, charts, images, shadings,
    shapes: decor, background: bg || null,
    rules, stats,
    columns: null      // 稍后由 finalizePages 填
  };
}

/* ---------- 11. 跨页总装：分栏 + 页眉页脚 + 阅读顺序 ---------- */
function finalizePages(pages, opt){
  for (const pg of pages){
    pg.columns = opt.columns ? detectColumns(pg.blocks, pg.w, pg.h) : { columns: 1, gutters: [], confidence: 0 };
  }
  if (opt.headerFooter) markHeadersFooters(pages, pages.length ? pages[0].h : 792);

  for (const pg of pages){
    const body = pg.blocks.filter(b => !b.role);
    const col = pg.columns;
    if (col && col.columns > 1 && col.bounds){
      for (const b of body){
        const cx = (b.x0 + b.x1) / 2;
        let ci = 0;
        for (let i = 0; i < col.bounds.length - 1; i++) if (cx >= col.bounds[i]) ci = i;
        b.column = ci;
      }
      body.sort((a, b) => (a.column - b.column) || (a.top - b.top) || (a.x0 - b.x0));
    } else {
      for (const b of body) b.column = 0;
      body.sort((a, b) => (a.top - b.top) || (a.x0 - b.x0));
    }
    body.forEach((b, i) => b.readIndex = i + 1);
    pg.bodyBlocks = body;
    pg.headerBlocks = pg.blocks.filter(b => b.role === "页眉");
    pg.footerBlocks = pg.blocks.filter(b => b.role === "页脚");
  }
}

/* ===== 5-emit.js ===== */
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

/* ===== 7-ooxml.js ===== */
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

/* ===== 8-topptx.js ===== */
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

/* ===== 9-html.js ===== */
/* ============================================================
   9-html.js —— HTML / Outlook 邮件 → 结构化文本
   与 PDF、PPTX 并列的第三条输入线。

   根本难点：HTML 没有坐标。
   PDF 里字有 (x,y)，PPTX 里形状有 xfrm，而 HTML 是流式布局，
   位置是浏览器排出来的，文件里根本没有。
   ——但这个工具本身就跑在浏览器里，浏览器就是排版引擎。
   所以：塞进隔离的离屏 iframe 真排一遍，再用 getBoundingClientRect
   + getComputedStyle 把真实坐标与真实样式量出来。
   于是 HTML 与 PDF/PPTX 共用同一套坐标契约，「文本→PPT」那条线不用改。

   ★ 安全：邮件 HTML 里的远程图片就是追踪像素，一渲染就联网，
   发件人立刻知道你读了这封信。本工具承诺不联网，所以渲染前
   必须掐断所有 http(s) 资源，只放行 MHT 内嵌的 cid: 与 data:。
   三层防御：预清洗改写 URL + iframe sandbox（禁脚本）+ 文档内 CSP。

   可测性：MIME/MHT 解析与清洗是纯函数，Node 里能跑；
   量测那一段必须有 DOM，走浏览器集成测试。
   ============================================================ */
const HTMLDOC = (function(){
"use strict";

/* CSS px -> pt：CSS 像素恒为 1/96 英寸，pt 为 1/72 英寸 */
const PX_PT = 72 / 96;

/* ==================== MIME / MHT ====================
   Outlook「另存为 -> 单个文件网页」出来的就是 .mht：
   multipart/related，正文一段，每张图各一段，
   用 Content-Location 或 Content-ID 互相引用。 */

function splitHeaders(block){
  /* 头部以空行结束；折行（下一行以空白开头）要接回上一行 */
  const out = Object.create(null);
  const lines = String(block).split(/\r?\n/);
  let cur = null;
  for (const raw of lines){
    if (/^[ \t]/.test(raw) && cur){ out[cur] += " " + raw.trim(); continue; }
    const m = /^([\x21-\x39\x3b-\x7e]+):\s*([\s\S]*)$/.exec(raw);
    if (!m) continue;
    cur = m[1].toLowerCase();
    out[cur] = m[2].trim();
  }
  return out;
}

function decodeQP(str){
  return String(str)
    .replace(/=\r?\n/g, "")                       /* 软换行 */
    .replace(/=([0-9A-Fa-f]{2})/g, function(_, h){ return String.fromCharCode(parseInt(h, 16)); });
}

function b64ToBytes(s){
  const clean = String(s).replace(/[^A-Za-z0-9+/=]/g, "");
  if (typeof atob === "function"){
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(clean, "base64"));   /* Node 测试台 */
}

function bytesToB64(bytes){
  if (typeof btoa === "function"){
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  return Buffer.from(bytes).toString("base64");
}

function latin1ToBytes(s){
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
}

function decodeText(bytes, charset){
  const cs = String(charset || "utf-8").toLowerCase().replace(/[^a-z0-9-]/g, "");
  function tryOne(c){
    try { return new TextDecoder(c).decode(bytes); } catch (e){ return null; }
  }
  /* gb2312 实际都是 gbk/gb18030 的子集，按 gb18030 解更稳 */
  const order = /gb2312|gbk|gb18030|hz/.test(cs) ? ["gb18030", "utf-8"]
              : /big5/.test(cs) ? ["big5", "utf-8"]
              : /1252|latin|iso-8859/.test(cs) ? ["windows-1252", "utf-8"]
              : ["utf-8", "gb18030"];
  for (const c of order){ const r = tryOne(c); if (r !== null) return r; }
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/* RFC 2047 编码头： =?utf-8?B?xxx?= / =?gb2312?Q?xxx?= */
function decodeHeaderWord(s){
  if (!s) return s;
  return String(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function(_, cs, enc, data){
    try {
      const bytes = enc.toUpperCase() === "B"
        ? b64ToBytes(data)
        : latin1ToBytes(decodeQP(data.replace(/_/g, " ")));
      return decodeText(bytes, cs);
    } catch (e){ return data; }
  });
}

const mimeOf = h => String(h["content-type"] || "text/plain").split(";")[0].trim().toLowerCase();
function charsetOf(h){
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(h["content-type"] || "");
  return m ? m[1] : null;
}

/* 返回 {html, assets:{url->dataURL}, parts, subject, from, to, date} */
function parseMht(bytes){
  /* 头部与边界一律 ASCII，先按 latin1 读；正文各段再按各自 charset 解 */
  let raw = "";
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);

  const sep = raw.search(/\r?\n\r?\n/);
  const top = splitHeaders(raw.slice(0, sep < 0 ? raw.length : sep));
  const bm = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(top["content-type"] || "");

  const assets = Object.create(null);
  const parts = [];
  let html = null, htmlCharset = null;

  function takePart(block){
    const s = block.search(/\r?\n\r?\n/);
    if (s < 0) return;
    const h = splitHeaders(block.slice(0, s));
    const bodyRaw = block.slice(s).replace(/^\r?\n\r?\n/, "");
    const enc = String(h["content-transfer-encoding"] || "").toLowerCase().trim();
    const mime = mimeOf(h);
    let data;
    if (enc === "base64") data = b64ToBytes(bodyRaw);
    else if (enc === "quoted-printable") data = latin1ToBytes(decodeQP(bodyRaw));
    else data = latin1ToBytes(bodyRaw);

    const loc = h["content-location"] || "";
    const cid = String(h["content-id"] || "").replace(/^</, "").replace(/>$/, "");
    parts.push({ mime: mime, loc: loc, cid: cid, size: data.length });

    if (mime === "text/html" && html === null){
      htmlCharset = charsetOf(h);
      html = decodeText(data, htmlCharset);
      return;
    }
    if (/^image\//.test(mime) || mime === "application/octet-stream"){
      const url = "data:" + (mime === "application/octet-stream" ? "image/png" : mime) +
                  ";base64," + bytesToB64(data);
      if (loc) assets[loc] = url;
      if (cid) assets["cid:" + cid] = url;
      if (loc){                                    /* Outlook 常只写文件名 */
        const base = loc.split(/[\\/]/).pop();
        if (base && !assets[base]) assets[base] = url;
      }
    }
  }

  if (bm){
    const b = "--" + bm[1];
    const chunks = raw.split(b);
    for (let i = 1; i < chunks.length; i++){
      if (/^--/.test(chunks[i])) break;            /* 结束边界 */
      takePart(chunks[i].replace(/^\r?\n/, ""));
    }
  } else {
    takePart(raw);
  }

  if (html === null){
    html = decodeText(bytes, charsetOf(top));
    if (!/<[a-z!]/i.test(html)){
      html = "<pre>" + html.replace(/[&<>]/g, function(c){
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
      }) + "</pre>";
    }
  }

  return {
    html: html, assets: assets, parts: parts,
    subject: decodeHeaderWord(top["subject"] || ""),
    from: decodeHeaderWord(top["from"] || ""),
    to: decodeHeaderWord(top["to"] || ""),
    date: top["date"] || "",
    charset: htmlCharset
  };
}

/* ==================== 清洗 ====================
   三个目标，缺一不可：
   (1) 不联网（追踪像素）(2) 不执行脚本 (3) 去掉 Outlook 私货，
   否则 mso 条件注释里的内容会被当正文显示出来。 */

const RE_MSO_COND        = /<!--\[if[\s\S]*?<!\[endif\]-->/gi;
const RE_MSO_REVEAL_OPEN = /<!--\[if[^\]]*\]>\s*<!-->/gi;
const RE_MSO_REVEAL_CLOSE= /<!--\s*<!\[endif\]-->/gi;
const RE_PAIRED_BAD      = /<(script|noscript|iframe|frame|frameset|object|embed|applet|form)\b[\s\S]*?<\/\1\s*>/gi;
const RE_VOID_BAD        = /<(script|iframe|object|embed|applet|link|base|meta)\b[^>]*>/gi;
const RE_ON_ATTR         = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const RE_REMOTE          = /^(?:https?:|\/\/)/i;

const escAttr = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function sanitize(html, assets, opt){
  opt = opt || {};
  const stats = { blockedRemote: 0, blockedScript: 0, msoBlocks: 0, vml: 0, resolved: 0, missing: 0 };
  let s = String(html);

  /* --- Outlook 条件注释 ---
     downlevel-revealed（<!--[if !mso]><!--> ... <!--<![endif]-->）的开合标记
     必须先单独拆掉，否则下面那条整段删会把中间的正文一起吃了。 */
  s = s.replace(RE_MSO_REVEAL_OPEN, "").replace(RE_MSO_REVEAL_CLOSE, "");
  s = s.replace(RE_MSO_COND, function(){ stats.msoBlocks++; return ""; });

  /* --- 脚本与外部引用 --- */
  s = s.replace(RE_PAIRED_BAD, function(){ stats.blockedScript++; return ""; });
  s = s.replace(RE_VOID_BAD, function(){ stats.blockedScript++; return ""; });
  s = s.replace(RE_ON_ATTR, "");
  s = s.replace(/\s(?:href|action)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, "");

  /* --- VML / Office 专有标签：去壳留内容 --- */
  s = s.replace(/<\/?o:p\b[^>]*>/gi, "");
  s = s.replace(/<\/?(?:v|o|w|m|x|st1):[a-z0-9_-]+\b[^>]*>/gi, function(){ stats.vml++; return ""; });

  /* --- 资源：cid/本地 -> data:；远程 -> 掐断 --- */
  function resolveUrl(u){
    if (!u) return null;
    const rawU = String(u).trim().replace(/^["']/, "").replace(/["']$/, "");
    if (/^data:/i.test(rawU)) return rawU;
    if (assets){
      if (assets[rawU]) { stats.resolved++; return assets[rawU]; }
      const noCid = rawU.replace(/^cid:/i, "");
      if (assets["cid:" + noCid]) { stats.resolved++; return assets["cid:" + noCid]; }
      const base = noCid.split(/[\\/]/).pop().split("?")[0];
      if (assets[base]) { stats.resolved++; return assets[base]; }
    }
    if (RE_REMOTE.test(rawU)) { stats.blockedRemote++; return null; }
    stats.missing++;
    return null;                                   /* 相对路径但没随包带上 */
  }

  s = s.replace(/\ssrcset\s*=\s*(["'])[\s\S]*?\1/gi, "");
  /* 被掐断的图不能留 src —— 留着浏览器照样会去请求。
     改挂 data-blocked / data-w / data-h，量测时据此画留白框。 */
  s = s.replace(/<img\b([^>]*)>/gi, function(m, attrs){
    const sm = /\ssrc\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
    if (!sm) return m;
    const r = resolveUrl(sm[2]);
    if (r) return "<img" + attrs.replace(sm[0], ' src="' + escAttr(r) + '"') + ">";
    return "<img" + attrs.replace(sm[0], "") +
           ' data-blocked="' + escAttr(sm[2]) + '">';
  });
  s = s.replace(/(<[^>]+\sbackground\s*=\s*)(["'])([\s\S]*?)\2/gi, function(m, pre, q, url){
    const r = resolveUrl(url);
    return r ? pre + q + escAttr(r) + q : "";
  });

  /* 样式里的 url(...) —— 背景图一样会联网 */
  s = s.replace(/url\(\s*([^)]*?)\s*\)/gi, function(m, u){
    const r = resolveUrl(u);
    return r ? "url(" + r + ")" : "none";
  });
  s = s.replace(/@import[^;]+;/gi, function(){ stats.blockedRemote++; return ""; });

  return { html: s, stats: stats };
}

/* 构造送进 iframe 的文档：自带 CSP，作为第三层防御。
   预清洗已经把远程 URL 去掉了，CSP 是「万一漏了一条」的兜底。 */
function wrapDocument(bodyHtml, widthPx){
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; " +
      "script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'" +
    '">' +
    '<style>' +
      'html,body{margin:0;padding:0;background:#fff}' +
      'body{width:' + widthPx + 'px;overflow-x:hidden;' +
      'font-family:"Microsoft YaHei","Segoe UI",sans-serif;font-size:14px}' +
      'img{max-width:100%}' +
      /* 被掐断的图：按原始 width/height 留白，让位置和尺寸仍然可测 */
      'img[data-blocked]{display:inline-block;min-width:24px;min-height:24px;' +
      'background:repeating-linear-gradient(45deg,#f4f4f4,#f4f4f4 6px,#e8e8e8 6px,#e8e8e8 12px);' +
      'border:1px dashed #bbb;box-sizing:border-box}' +
    '</style></head><body>' + bodyHtml + '</body></html>';
}

/* 被掐断的图仍要知道原尺寸才好留白 */
function preferredImgSize(el){
  const w = parseFloat(el.getAttribute("width")) || 0;
  const h = parseFloat(el.getAttribute("height")) || 0;
  return { w: w, h: h };
}

return {
  parseMht: parseMht,
  sanitize: sanitize,
  wrapDocument: wrapDocument,
  decodeQP: decodeQP,
  decodeText: decodeText,
  decodeHeaderWord: decodeHeaderWord,
  splitHeaders: splitHeaders,
  b64ToBytes: b64ToBytes,
  bytesToB64: bytesToB64,
  preferredImgSize: preferredImgSize,
  PX_PT: PX_PT
};
})();

module.exports = { OOXML, TOPPTX, HTMLDOC, convertBytes, PDFDoc, Parser, Lexer, Name, Ref, PStr, PStream, inflateRaw, flateDecode, lzwDecode, a85Decode, ahxDecode, rleDecode, md5, rc4, sha256, sha384, sha512, aesCbcDecrypt, aesCbcEncryptNoPad, PdfFont, parseToUnicode, glyphToUnicode, Renderer, analyzePage, finalizePages, buildOutput, mmul, toHex, classifyPath, buildLines, shouldMergeLines, detectColumns, cluster1D };
