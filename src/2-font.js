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
