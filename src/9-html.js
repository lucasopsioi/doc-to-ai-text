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
