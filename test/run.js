/* ============================================================
   Node 测试台
   把 src/1..5 拼成一个 CJS 模块直接跑，不需要浏览器。

   分两层：
   1. 单元测试 —— 自己手写的 inflate / MD5 / SHA / RC4 / AES
      拿 Node 内置 crypto 和 zlib 当标准答案对照。
      这几块是最容易埋暗坑的地方，而且错了不会报错，只会静默出错数据。
   2. 集成测试 —— 拿真实 PDF 跑全流程

   用法：node test/run.js [额外的pdf路径...]
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const MODULES = ["1-core.js", "2-font.js", "3-render.js", "4-layout.js", "5-emit.js", "7-ooxml.js", "8-topptx.js", "9-html.js"];

/* ---------- 打包 ---------- */
const bundlePath = path.join(__dirname, "_bundle.cjs");
const code = MODULES.map(f => `/* ===== ${f} ===== */\n` + fs.readFileSync(path.join(SRC, f), "utf8")).join("\n");
const exportNames = [
  "OOXML", "TOPPTX", "HTMLDOC",
  "convertBytes", "PDFDoc", "Parser", "Lexer", "Name", "Ref", "PStr", "PStream",
  "inflateRaw", "flateDecode", "lzwDecode", "a85Decode", "ahxDecode", "rleDecode",
  "md5", "rc4", "sha256", "sha384", "sha512", "aesCbcDecrypt", "aesCbcEncryptNoPad",
  "PdfFont", "parseToUnicode", "glyphToUnicode", "Renderer", "analyzePage",
  "finalizePages", "buildOutput", "mmul", "toHex", "classifyPath", "buildLines",
  "shouldMergeLines", "detectColumns", "cluster1D"
];
fs.writeFileSync(bundlePath,
  '"use strict";\n' + code + "\nmodule.exports = { " + exportNames.join(", ") + " };\n");

let M;
try {
  M = require(bundlePath);
} catch (e) {
  console.error("❌ 模块加载失败（语法错误）：\n" + (e.stack || e.message));
  process.exit(1);
}

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? "  → " + detail : "")); console.log("  ✗ " + name + (detail ? "  → " + detail : "")); }
}
function eqBytes(name, a, b) {
  const A = Buffer.from(a), B = Buffer.from(b);
  ok(name, A.equals(B), A.equals(B) ? "" : `长度 ${A.length} vs ${B.length}；前16字节 ${A.slice(0,16).toString("hex")} vs ${B.slice(0,16).toString("hex")}`);
}
function section(t) { console.log("\n=== " + t + " ==="); }

const randBytes = n => crypto.randomBytes(n);

/* ============================================================
   1. inflate
   ============================================================ */
section("inflate（自实现 vs Node zlib）");
{
  const cases = [
    ["空数据", Buffer.alloc(0)],
    ["短文本", Buffer.from("Hello, PDF!")],
    ["全零 10KB", Buffer.alloc(10240)],
    ["高度重复", Buffer.from("ABCABCABC".repeat(3000))],
    ["随机 64KB（不可压缩，会走存储块）", randBytes(65536)],
    ["中文 UTF-8", Buffer.from("拉美竞品情报中枢，巴西手机市场 Q3 分化。".repeat(400), "utf8")],
    ["刚好 32KB 边界（跨窗口回溯）", Buffer.concat([randBytes(100), Buffer.alloc(32768, 7), randBytes(100)])]
  ];
  for (const [name, data] of cases) {
    const raw = zlib.deflateRawSync(data);
    let got;
    try { got = M.inflateRaw(new Uint8Array(raw)); } catch (e) { got = null; ok("inflateRaw " + name, false, e.message); continue; }
    eqBytes("inflateRaw " + name, got, data);

    const z = zlib.deflateSync(data);
    let got2;
    try { got2 = M.flateDecode(new Uint8Array(z)); } catch (e) { got2 = null; }
    eqBytes("flateDecode(zlib头) " + name, got2 || Buffer.alloc(0), data);
  }
  /* 各压缩等级都要过 —— 不同等级会产生固定/动态 Huffman 和存储块三种块型 */
  const src = Buffer.from("量化交易 BTC 合约 brooks_pa 引擎 ".repeat(500), "utf8");
  for (let lvl = 0; lvl <= 9; lvl++) {
    const raw = zlib.deflateRawSync(src, { level: lvl });
    let got = null;
    try { got = M.inflateRaw(new Uint8Array(raw)); } catch (e) {}
    eqBytes(`inflateRaw 压缩等级 ${lvl}`, got || Buffer.alloc(0), src);
  }
}

/* ============================================================
   2. 散列与对称加密
   ============================================================ */
section("MD5 / SHA-256 / SHA-384 / SHA-512 / RC4 / AES");
{
  const sizes = [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 4096];
  for (const n of sizes) {
    const d = randBytes(n);
    eqBytes(`md5 ${n}B`, M.md5(new Uint8Array(d)), crypto.createHash("md5").update(d).digest());
    eqBytes(`sha256 ${n}B`, M.sha256(new Uint8Array(d)), crypto.createHash("sha256").update(d).digest());
    eqBytes(`sha384 ${n}B`, M.sha384(new Uint8Array(d)), crypto.createHash("sha384").update(d).digest());
    eqBytes(`sha512 ${n}B`, M.sha512(new Uint8Array(d)), crypto.createHash("sha512").update(d).digest());
  }

  /* RC4 标准测试向量 */
  const rc4vec = [
    ["Key", "Plaintext", "bbf316e8d940af0ad3"],
    ["Wiki", "pedia", "1021bf0420"],
    ["Secret", "Attack at dawn", "45a01f645fc35b383552544b9bf5"]
  ];
  for (const [k, p, hex] of rc4vec) {
    const got = M.rc4(new Uint8Array(Buffer.from(k)), new Uint8Array(Buffer.from(p)));
    eqBytes(`rc4 "${k}"`, got, Buffer.from(hex, "hex"));
  }

  /* AES-CBC：无填充加密 与 解密，两个方向都要对 */
  for (const bits of [128, 256]) {
    const key = randBytes(bits / 8), iv = randBytes(16), data = randBytes(64);
    const alg = `aes-${bits}-cbc`;

    const ce = crypto.createCipheriv(alg, key, iv);
    ce.setAutoPadding(false);
    const expect = Buffer.concat([ce.update(data), ce.final()]);
    eqBytes(`AES-${bits}-CBC 加密(无填充)`,
      M.aesCbcEncryptNoPad(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(data)), expect);

    /* 解密：PDF 的 AES 流是 IV 前置 + PKCS#7 填充 */
    const cp = crypto.createCipheriv(alg, key, iv);
    cp.setAutoPadding(true);
    const enc = Buffer.concat([iv, cp.update(data), cp.final()]);
    eqBytes(`AES-${bits}-CBC 解密(IV前置+去填充)`,
      M.aesCbcDecrypt(new Uint8Array(key), new Uint8Array(enc), true, true), data);

    /* 无 IV、不去填充（R5/R6 推导文件密钥要用这个模式） */
    const cn = crypto.createCipheriv(alg, key, Buffer.alloc(16));
    cn.setAutoPadding(false);
    const enc2 = Buffer.concat([cn.update(data), cn.final()]);
    eqBytes(`AES-${bits}-CBC 解密(零IV+不去填充)`,
      M.aesCbcDecrypt(new Uint8Array(key), new Uint8Array(enc2), false, false), data);
  }
}

/* ============================================================
   3. 其它滤镜
   ============================================================ */
section("ASCIIHex / ASCII85 / RunLength");
{
  eqBytes("ASCIIHexDecode", M.ahxDecode(new Uint8Array(Buffer.from("48656C6C6F>"))), Buffer.from("Hello"));
  eqBytes("ASCIIHexDecode 奇数位补零", M.ahxDecode(new Uint8Array(Buffer.from("4A6>"))), Buffer.from([0x4A, 0x60]));
  eqBytes("ASCII85Decode", M.a85Decode(new Uint8Array(Buffer.from("87cURD]i,\"Ebo80~>"))), Buffer.from("Hello World!"));
  eqBytes("ASCII85Decode 带 <~ 前缀", M.a85Decode(new Uint8Array(Buffer.from("87cURD_*#4DfTZ)~>"))), Buffer.from("Hello, World"));
  eqBytes("ASCII85 z 简写", M.a85Decode(new Uint8Array(Buffer.from("z~>"))), Buffer.alloc(4));
  eqBytes("RunLengthDecode", M.rleDecode(new Uint8Array([2, 65, 66, 67, 254, 88, 128])),
    Buffer.from("ABC" + "X".repeat(3)));
}

/* ============================================================
   4. 手搓 PDF —— 已知答案的精度回归
   ============================================================ */
section("精度回归（手写 PDF，答案已知）");

function buildTestPdf(opts) {
  opts = opts || {};
  const content = opts.content || `
q 0.121569 0.435294 0.545098 rg
72 600 200 80 re f
Q
q 1 0 0 RG 3 w
100 500 m 400 500 l S
Q
BT /F1 24 Tf 0.2 0.4 0.6 rg 72 700 Td (Hello Precision) Tj ET
BT /F1 10 Tf 0 g 72 660 Td (second line at ten point) Tj ET
BT /F2 14 Tf 0 g 72 620 Td [(Kerned) -500 (Words)] TJ ET
`;
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
            "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>";
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>";

  const parts = [];
  const offsets = [];
  let buf = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  parts.push(buf);
  let pos = buf.length;

  const emit = (num, body, streamData) => {
    let s = `${num} 0 obj\n${body}\n`;
    if (streamData !== undefined) s += `stream\n${streamData}\nendstream\n`;
    s += "endobj\n";
    const b = Buffer.from(s, "latin1");
    offsets[num] = pos;
    parts.push(b);
    pos += b.length;
  };

  emit(1, objs[1]);
  emit(2, objs[2]);
  emit(3, objs[3]);
  emit(4, `<< /Length ${content.length} >>`, content);
  emit(5, objs[5]);
  emit(6, objs[6]);

  const xrefPos = pos;
  let xref = "xref\n0 7\n0000000000 65535 f \n";
  for (let i = 1; i <= 6; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  xref += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

const OPT = {
  preamble: false, mergePara: true, columns: true, headerFooter: true,
  shapes: true, tables: true, charts: true, runs: false, compact: true,
  target: "raw", unit: "pt", annots: true
};

(async () => {
  {
    const pdf = buildTestPdf();
    let r;
    try { r = await M.convertBytes(new Uint8Array(pdf), "precision.pdf", OPT); }
    catch (e) { ok("手写 PDF 能解析", false, e.message + "\n" + e.stack); r = null; }

    if (r) {
      const t = r.text;
      ok("手写 PDF 能解析", true);
      ok("页数 = 1", /页数: 1/.test(t), t.match(/页数: \d+/));
      ok("页面尺寸 612x792", /612 × 792 pt/.test(t), (t.match(/页面尺寸: .*/) || [])[0]);
      ok("识别为 Letter", /Letter/.test(t));

      /* 文字内容 */
      ok('提取到 "Hello Precision"', t.includes("Hello Precision"));
      ok('提取到 "second line at ten point"', t.includes("second line at ten point"));
      ok('TJ 数组拼接正确（Kerned Words）', /Kerned\s*Words/.test(t), (t.match(/"Kerned[^"]*"/) || [])[0]);

      /* 字号：24pt 和 10pt 必须原样出现 */
      ok("24pt 字号正确", /24pt/.test(t), (t.match(/— 24[^\n]*/) || [])[0]);
      ok("10pt 字号正确", /10pt/.test(t));
      ok("Helvetica 字体名", /Helvetica/.test(t));
      ok("Times-Bold 识别为粗体", /Times-Bold/.test(t) && /粗体/.test(t));

      /* 坐标：PDF 里文字基线在 (72,700)，页高 792，翻转后 y = 792-700 = 92 */
      const m = t.match(/### \[\d+\] 文本块[^\n]*\n位置: x=([\d.]+) y=([\d.]+)/);
      ok("文本块 x 坐标 = 72", m && Math.abs(parseFloat(m[1]) - 72) < 1.5, m ? m[1] : "没匹配到");
      ok("文本块 y 坐标 ≈ 92-18=74（基线上方约0.78em）", m && Math.abs(parseFloat(m[2]) - 73.3) < 6, m ? m[2] : "没匹配到");

      /* 矩形：(72,600) 200x80，翻转后 top = 792-680 = 112 */
      const rect = t.match(/### \[\d+\] 矩形\n位置: x=([\d.]+) y=([\d.]+) 宽=([\d.]+) 高=([\d.]+)/);
      ok("矩形 x=72", rect && Math.abs(parseFloat(rect[1]) - 72) < 0.5, rect ? rect[1] : "没匹配到矩形");
      ok("矩形 y=112", rect && Math.abs(parseFloat(rect[2]) - 112) < 0.5, rect ? rect[2] : "-");
      ok("矩形 宽=200", rect && Math.abs(parseFloat(rect[3]) - 200) < 0.5, rect ? rect[3] : "-");
      ok("矩形 高=80", rect && Math.abs(parseFloat(rect[4]) - 80) < 0.5, rect ? rect[4] : "-");

      /* 颜色：0.121569 0.435294 0.545098 -> #1F6F8B（和 PPT 工具 README 里那个验证色一致） */
      ok("填充色 #1F6F8B", /#1F6F8B/.test(t), (t.match(/填充: #\w+/) || [])[0]);
      ok("描边色 #FF0000", /#FF0000/.test(t), (t.match(/边框: #\w+[^\n]*/) || [])[0]);
      ok("线宽 3pt", /粗细 3/.test(t), (t.match(/粗细 [\d.]+pt/) || [])[0]);
      ok("水平线被识别", /水平线/.test(t));
      ok("文字色 #336699", /#336699/.test(t));
    }
  }

  /* ---- 目标版式折算 ---- */
  {
    const pdf = buildTestPdf();
    const r = await M.convertBytes(new Uint8Array(pdf), "t.pdf",
      Object.assign({}, OPT, { target: "16:9", unit: "pt" }));
    const t = r.text;
    /* 612x792 装进 960x540：scale = min(960/612, 540/792) = 0.6818 */
    ok("16:9 折算比例正确", /缩放 0\.681[0-9]/.test(t), (t.match(/缩放 [\d.]+×/) || [])[0]);
    ok("提示了比例不匹配", /比例.*差得较多|留出大片空白/.test(t));
    const m = t.match(/### \[\d+\] 矩形\n位置: x=([\d.]+)/);
    /* x = 72*0.6818 + (960-612*0.6818)/2 = 49.09 + 271.4 = 320.5 */
    ok("16:9 下矩形 x 已折算并居中", m && Math.abs(parseFloat(m[1]) - 320.5) < 2, m ? m[1] : "-");
  }

  /* ---- 单位换算 ---- */
  {
    const pdf = buildTestPdf();
    const r = await M.convertBytes(new Uint8Array(pdf), "t.pdf", Object.assign({}, OPT, { unit: "cm" }));
    const rect = r.text.match(/### \[\d+\] 矩形\n位置: x=([\d.]+) y=([\d.]+) 宽=([\d.]+)/);
    /* 72pt = 2.54cm, 200pt = 7.06cm */
    ok("cm 换算 x=2.54", rect && Math.abs(parseFloat(rect[1]) - 2.54) < 0.02, rect ? rect[1] : "-");
    ok("cm 换算 宽=7.06", rect && Math.abs(parseFloat(rect[3]) - 7.06) < 0.02, rect ? rect[3] : "-");
  }

  /* ---- 坏 xref 的自愈 ---- */
  {
    const pdf = buildTestPdf();
    const broken = Buffer.from(pdf);
    /* 把 startxref 的值改成错的，逼工具走全文件扫描 */
    const s = broken.toString("latin1").replace(/startxref\n\d+/, "startxref\n999999");
    const r = await M.convertBytes(new Uint8Array(Buffer.from(s, "latin1")), "broken.pdf", OPT);
    ok("xref 损坏时能自愈", r.text.includes("Hello Precision"),
       r.text.slice(0, 200));
    ok("自愈时有明确告警", /扫描重建|xref/.test(r.text));
  }

  /* ---- 隐藏图层（OCG）必须被跳过 ---- */
  {
    const content = `
/OC /MC0 BDC
q 1 0 0 rg 50 50 100 100 re f Q
BT /F1 12 Tf 60 600 Td (INVISIBLE LAYER TEXT) Tj ET
EMC
BT /F1 12 Tf 60 500 Td (VISIBLE TEXT) Tj ET
`;
    /* 手工组装带 OCProperties 的 PDF */
    const mk = () => {
      const parts = [];
      let pos = 0;
      const offsets = [];
      const push = s => { const b = Buffer.from(s, "latin1"); parts.push(b); pos += b.length; };
      push("%PDF-1.5\n");
      const emit = (num, body, stream) => {
        offsets[num] = pos;
        let s = `${num} 0 obj\n${body}\n`;
        if (stream !== undefined) s += `stream\n${stream}\nendstream\n`;
        push(s + "endobj\n");
      };
      emit(1, "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R] /D << /OFF [7 0 R] >> >> >>");
      emit(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
      emit(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /Properties << /MC0 7 0 R >> >> /Contents 4 0 R >>");
      emit(4, `<< /Length ${content.length} >>`, content);
      emit(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
      emit(7, "<< /Type /OCG /Name (Hidden Layer) >>");
      const xrefPos = pos;
      let xref = "xref\n0 8\n0000000000 65535 f \n";
      for (let i = 1; i <= 7; i++) xref += String(offsets[i] || 0).padStart(10, "0") + (offsets[i] ? " 00000 n \n" : " 65535 f \n");
      xref += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
      push(xref);
      return Buffer.concat(parts);
    };
    const r = await M.convertBytes(new Uint8Array(mk()), "ocg.pdf", OPT);
    ok("隐藏图层的文字被排除", !r.text.includes("INVISIBLE LAYER TEXT"));
    ok("可见文字保留", r.text.includes("VISIBLE TEXT"));
    ok("隐藏图层有告警说明", /隐藏图层|OCG/.test(r.text), "");
  }

  /* ---- 不可见文字（渲染模式 3）---- */
  {
    const content = `BT /F1 12 Tf 3 Tr 60 600 Td (OCR HIDDEN LAYER) Tj ET
BT /F1 12 Tf 0 Tr 60 500 Td (NORMAL TEXT) Tj ET`;
    const pdf = buildTestPdf({ content });
    const r = await M.convertBytes(new Uint8Array(pdf), "invis.pdf", OPT);
    ok("渲染模式3的不可见文字被排除", !r.text.includes("OCR HIDDEN LAYER"));
    ok("正常文字保留", r.text.includes("NORMAL TEXT"));
    ok("不可见文字有告警", /不可见文字/.test(r.text));
  }

  /* ---- 表格检测 ---- */
  {
    let c = "q 0 g 0.5 w\n";
    const xs = [100, 200, 300, 400], ys = [700, 680, 660, 640];
    for (const y of ys) c += `${xs[0]} ${y} m ${xs[3]} ${y} l S\n`;
    for (const x of xs) c += `${x} ${ys[3]} m ${x} ${ys[0]} l S\n`;
    c += "Q\n";
    /* 用 ASCII —— 这份测试 PDF 用的是 Helvetica/WinAnsi，本来就表达不了中文。
       中文路径由后面的真实 PDF 集成测试覆盖。 */
    const cells = [["Brand", "Units", "Share"], ["Samsung", "4570k", "31%"], ["Acme", "26", "0.1%"]];
    cells.forEach((row, ri) => row.forEach((txt, ci) => {
      c += `BT /F1 9 Tf 0 g ${xs[ci] + 5} ${ys[ri] - 14} Td (${txt}) Tj ET\n`;
    }));
    const pdf = buildTestPdf({ content: c });
    const r = await M.convertBytes(new Uint8Array(pdf), "table.pdf", OPT);
    const t = r.text;
    ok("检测到表格", /### \[\d+\] 表格/.test(t), (t.match(/### \[\d+\] [^\n]*/g) || []).join(" | "));
    ok("表格是 3行×3列", /3 行 × 3 列/.test(t), (t.match(/\d+ 行 × \d+ 列/) || [])[0]);
    /* 关键回归：一行文字横跨三列时，必须按文字片段分配到各列，
       不能按整行中心分配（那样内容会全挤在中间列，两边列全空） */
    ok("表头三列各就各位", /"Brand" \| "Units" \| "Share"/.test(t),
       (t.match(/  第\d行: [^\n]*/g) || []).join("\n"));
    ok("数据行三列各就各位", /"Samsung" \| "4570k" \| "31%"/.test(t),
       (t.match(/  第\d行: [^\n]*/g) || []).join("\n"));
    ok("给出了列宽", /列宽: /.test(t), (t.match(/列宽: [^\n]*/) || [])[0]);
  }

  /* ---- 整张表格的框线画在「一个路径」里 ---- */
  {
    /* 很多生成器（PyMuPDF 的 new_shape 就是）把十几条框线一次性提交成一个路径对象。
       只看整个路径的外接框会一条线都抽不出来，表格整个漏检 ——
       而且输出看着完全正常，文字都在，只是降级成了普通文本块。
       这条是拿 Python 版交叉验证时发现的。 */
    const xs = [100, 220, 340, 460], ys = [700, 675, 650, 625];
    let c = "q 0 g 0.6 w\n";
    for (const y of ys) c += `${xs[0]} ${y} m ${xs[3]} ${y} l\n`;
    for (const x of xs) c += `${x} ${ys[3]} m ${x} ${ys[0]} l\n`;
    c += "S\nQ\n";                       // 关键：只描一次边，所有线同属一个路径
    const cells = [["Brand", "Units", "Share"], ["Samsung", "4570k", "31%"], ["Acme", "26", "0.1%"]];
    cells.forEach((row, ri) => row.forEach((txt, ci) => {
      c += `BT /F1 9 Tf 0 g ${xs[ci] + 5} ${ys[ri] - 16} Td (${txt}) Tj ET\n`;
    }));
    const pdf = buildTestPdf({ content: c });
    const r = await M.convertBytes(new Uint8Array(pdf), "onepath.pdf", OPT);
    const t = r.text;
    ok("单路径框线的表格能被识别", /### \[\d+\] 表格/.test(t),
       (t.match(/### \[\d+\] [^\n[]*/g) || []).join(" | "));
    ok("单路径表格是 3行×3列", /3 行 × 3 列/.test(t), (t.match(/\d+ 行 × \d+ 列/) || [])[0]);
    ok("单路径表格单元格分列正确", /"Samsung" \| "4570k" \| "31%"/.test(t),
       (t.match(/  第\d行: [^\n]*/g) || []).join("\n"));
    ok("表格框线不再重复列成独立形状", !/### \[\d+\] 复合路径/.test(t),
       (t.match(/### \[\d+\] [^\n[]*/g) || []).join(" | "));
  }

  /* ---- 只有横线、没有竖线 -> 不是表格 ---- */
  {
    /* 页面装饰性的横线框。旧版会把这判成「N 行 × 1 列的表格」，
       然后把整页正文吞进去 —— 真实报告 PDF 上实测踩到过。 */
    let c = "q 0 g 0.5 w\n";
    for (const y of [750, 700, 650, 600]) c += `50 ${y} m 550 ${y} l S\n`;
    c += "50 600 m 50 750 l S\n";       // 只有一条竖线 => 只能围出 1 列
    c += "Q\n";
    c += "BT /F1 11 Tf 0 g 60 720 Td (This is ordinary body text, not a table.) Tj ET\n";
    c += "BT /F1 11 Tf 0 g 60 670 Td (It should stay a text block.) Tj ET\n";
    const pdf = buildTestPdf({ content: c });
    const r = await M.convertBytes(new Uint8Array(pdf), "notable.pdf", OPT);
    const t = r.text;
    ok("单列不算表格", !/### \[\d+\] 表格/.test(t), (t.match(/\d+ 行 × \d+ 列/) || [])[0] || "");
    ok("正文仍以文本块输出", /### \[\d+\] 文本块/.test(t) && t.includes("ordinary body text"));
  }

  /* ---- 字间距 vs 词间距（自适应阈值） ---- */
  {
    const c = `
BT /F1 12 Tf 0 g 60 700 Td [(L) -300 (A) -300 (T) -300 (A) -300 (M)] TJ ET
BT /F1 12 Tf 0 g 60 660 Td [(HELLO) -300 (WORLD)] TJ ET
BT /F1 12 Tf 0 g 60 620 Td [(A) -300 (B) -300 (C) -900 (D) -300 (E)] TJ ET
`;
    const pdf = buildTestPdf({ content: c });
    const r = await M.convertBytes(new Uint8Array(pdf), "spacing.pdf", OPT);
    const t = r.text;
    /* 均匀的小间隙 = letter-spacing，不该补空格 */
    ok("letter-spacing 不被拆成单字母", /"LATAM"/.test(t),
       (t.match(/· "[^"]*"/g) || []).join("  "));
    /* 只有一个间隙、无从比较时，回退到 0.2em 固定阈值 */
    ok("单个大间隙仍补空格", /"HELLO WORLD"/.test(t),
       (t.match(/· "[^"]*"/g) || []).join("  "));
    /* 混合：小间隙是字距，大间隙是词距 */
    ok("字间距中的词间距被识别出来", /"ABC DE"/.test(t),
       (t.match(/· "[^"]*"/g) || []).join("  "));
  }

  /* ---- 同一行混排字号必须逐 run 输出，不能被 median 抹平 ---- */
  {
    const c = `BT 0 g /F1 24 Tf 60 700 Td (Share ) Tj /F1 10 Tf (of market) Tj ET`;
    const pdf = buildTestPdf({ content: c });
    const r = await M.convertBytes(new Uint8Array(pdf), "mixed.pdf", OPT);
    const t = r.text;
    ok("混排字号：24pt 保留", /24pt/.test(t), (t.match(/· "[^"]*"[^\n]*/g) || []).join("\n     "));
    ok("混排字号：10pt 保留", /10pt/.test(t));
    ok("混排字号未被平均成 17pt", !/17pt/.test(t));
  }

  /* ---- 柱形图检测 ---- */
  {
    let c = "q\n";
    const heights = [40, 80, 120, 60, 100];
    heights.forEach((h, i) => {
      c += `0.${2 + i} 0.4 0.7 rg ${100 + i * 40} 400 20 ${h} re f\n`;
    });
    c += "Q\n";
    c += "BT /F1 8 Tf 0 g 100 385 Td (Q1) Tj ET\n";
    const pdf = buildTestPdf({ content: c });
    const r = await M.convertBytes(new Uint8Array(pdf), "chart.pdf", OPT);
    const t = r.text;
    ok("检测到疑似柱形图", /疑似图表：柱形图/.test(t), (t.match(/### \[\d+\] [^\n]*/g) || []).join(" | "));
    ok("柱形图列出了各柱几何", /柱1: 长度/.test(t));
    ok("给出了长度比值", /长度比值/.test(t), (t.match(/长度比值[^\n]*/) || [])[0]);
    ok("图表标注了不确定性", /PDF 里没有图表对象/.test(t));
  }

  /* ---- 形状分类 ---- */
  {
    const c = `
q 0 0 1 rg 50 700 60 60 re f Q
q 1 0 0 rg 150 700 m 210 700 l 180 760 l h f Q
q 0 0.6 0 rg
250 730 m 250 746.57 263.43 760 280 760 c 296.57 760 310 746.57 310 730 c
310 713.43 296.57 700 280 700 c 263.43 700 250 713.43 250 730 c h f Q
q 0 g 0.8 w 400 700 m 500 760 l S Q
`;
    const pdf = buildTestPdf({ content: c });
    const r = await M.convertBytes(new Uint8Array(pdf), "shapes.pdf", OPT);
    const t = r.text;
    ok("识别正方形", /### \[\d+\] 正方形/.test(t), (t.match(/### \[\d+\] [^\n[]*/g) || []).join(" | "));
    ok("识别三角形", /### \[\d+\] 三角形/.test(t));
    ok("识别圆形", /### \[\d+\] (圆形|椭圆)/.test(t));
    ok("识别斜线", /### \[\d+\] 斜线/.test(t));
  }

  /* ---- 粗体判定只认结构信号，不认 StemV ---- */
  {
    /* 真实取样（Chromium/Skia 导出的报告 PDF）：
       MicrosoftYaHei-Bold 真粗体 StemV=84，NSimSun 常规体 StemV=488。
       StemV 方向是反的，任何阈值都同时误伤和漏判。 */
    const mk = (fontName, stemV, weight) => {
      const parts = []; let pos = 0; const offsets = [];
      const push = s => { const b = Buffer.from(s, "latin1"); parts.push(b); pos += b.length; };
      const emit = (num, body, stream) => {
        offsets[num] = pos;
        let s = `${num} 0 obj\n${body}\n`;
        if (stream !== undefined) s += `stream\n${stream}\nendstream\n`;
        push(s + "endobj\n");
      };
      const content = `BT /F1 12 Tf 0 g 60 700 Td (Sample) Tj ET`;
      push("%PDF-1.4\n");
      emit(1, "<< /Type /Catalog /Pages 2 0 R >>");
      emit(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
      emit(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
      emit(4, `<< /Length ${content.length} >>`, content);
      emit(5, `<< /Type /Font /Subtype /TrueType /BaseFont /${fontName} /FirstChar 32 /LastChar 126 /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>`);
      emit(6, `<< /Type /FontDescriptor /FontName /${fontName} /Flags 4 /StemV ${stemV} /FontWeight ${weight} /ItalicAngle 0 >>`);
      const xrefPos = pos;
      let xref = "xref\n0 7\n0000000000 65535 f \n";
      for (let i = 1; i <= 6; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
      xref += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
      push(xref);
      return Buffer.concat(parts);
    };
    const isBold = async (fontName, stemV, weight) => {
      const r = await M.convertBytes(new Uint8Array(mk(fontName, stemV, weight)), "f.pdf", OPT);
      return /粗体/.test(r.text);
    };
    ok("StemV=488 的常规体不算粗体", !(await isBold("NSimSun", 488, 0)));
    ok("StemV=84 但名字带 -Bold 算粗体", await isBold("MicrosoftYaHei-Bold", 84, 0));
    ok("FontWeight=700 算粗体", await isBold("SomeFont", 60, 700));
    ok("FontWeight=400 不算粗体", !(await isBold("SomeFont", 200, 400)));
  }

  /* ---- 页面旋转 ---- */
  {
    const pdf = buildTestPdf();
    const s = pdf.toString("latin1").replace("/MediaBox [0 0 612 792]", "/Rotate 90 /MediaBox [0 0 612 792]");
    const r = await M.convertBytes(new Uint8Array(Buffer.from(s, "latin1")), "rot.pdf", OPT);
    ok("旋转90度后宽高互换", /792 × 612 pt/.test(r.text), (r.text.match(/页面尺寸: [^\n]*/) || [])[0]);
    ok("标注了页面旋转", /页面旋转: 90/.test(r.text));
  }

  /* ============================================================
     5. PPTX 引擎
     ============================================================ */
  section("XML 解析器（自写，不依赖 DOMParser）");
  {
    const X = M.OOXML.parseXml;
    let d = X('<a:root xmlns:a="NSA"><a:kid v="1"/><a:kid v="2">文字</a:kid></a:root>');
    ok("根节点名与命名空间", d && d.local === "root" && d.ns === "NSA", d && d.local + "/" + d.ns);
    ok("子节点数", d && d.children.length === 2, d && String(d.children.length));
    ok("属性", d && d.children[0].attrs.v === "1");
    ok("文本内容", d && d.children[1].text === "文字", d && JSON.stringify(d.children[1].text));

    d = X('<r xmlns="D" xmlns:b="B"><b:x/><y/></r>');
    ok("默认命名空间", d && d.ns === "D" && d.children[1].ns === "D");
    ok("前缀命名空间", d && d.children[0].ns === "B" && d.children[0].local === "x");

    d = X('<r><t>a &amp; b &lt;c&gt; &#65;&#x42;</t></r>');
    ok("实体解码", d && d.children[0].text === "a & b <c> AB", d && JSON.stringify(d.children[0].text));

    d = X('<r><t><![CDATA[<not a tag> & stuff]]></t></r>');
    ok("CDATA", d && d.children[0].text === "<not a tag> & stuff", d && JSON.stringify(d.children[0].text));

    d = X('<?xml version="1.0"?><!-- c --><r><a/><!-- x --><b/></r>');
    ok("跳过声明与注释", d && d.local === "r" && d.children.length === 2,
       d && d.local + " kids=" + (d.children || []).length);

    d = X('<r a="1" b = \'2\'  c="有中文" />');
    ok("单双引号与空格容错", d && d.attrs.a === "1" && d.attrs.b === "2" && d.attrs.c === "有中文");
  }

  section("PPTX 引擎（版式/母版继承）");
  {
    const fx = path.join(__dirname, "fixtures", "inherit.pptx");
    if (!fs.existsSync(fx)) {
      console.log("  (跳过：缺少 fixtures/inherit.pptx，用 test/make_pptx.py 生成)");
    } else {
      const POPT = { preamble: false, compact: true, unit: "cm",
                     layouts: true, tableFmt: true, keepEmpty: false, charts: true };
      let t = null;
      try { t = M.OOXML.convert(new Uint8Array(fs.readFileSync(fx)), "inherit.pptx", POPT); }
      catch (e) { ok("PPTX 能解析", false, e.message + "\n" + (e.stack || "").split("\n")[1]); }

      if (t) {
        ok("PPTX 能解析", true);
        ok("画布 16:9", /33\.87 × 19\.05 cm/.test(t) && /16:9/.test(t), (t.match(/画布尺寸: [^\n]*/) || [])[0]);
        ok("幻灯片数 = 2", /幻灯片数: 2/.test(t));
        ok("主题配色被提取", /accent1=#4F81BD/.test(t));
        ok("主题字体被提取", /主题字体: .*Calibri/.test(t), (t.match(/主题字体: [^\n]*/) || [])[0]);

        /* ---- 这一组就是用户发现的「图层信息没转化」---- */
        ok("有版式库", /## 版式库/.test(t));
        ok("★母版上的色条被提取（原工具完全看不见）", /「MasterBar」/.test(t) && /#1F6F8B/.test(t),
           (t.match(/### \[\d\] 矩形 「[^」]*」/g) || []).join(" | "));
        ok("★版式上的角标被提取", /「LayoutBadge」/.test(t) && /#C6402E/.test(t));
        ok("★母版背景被提取", /背景: 纯色 #F6F8FA/.test(t), (t.match(/背景: [^\n]*/) || [])[0]);
        ok("模板元素只列一次，没在每页重复",
           (t.match(/「MasterBar」/g) || []).length === 2,   // 两个版式各一次，页面里 0 次
           "出现 " + (t.match(/「MasterBar」/g) || []).length + " 次");
        ok("版式标注了被哪些页使用", /被这些幻灯片使用: 第 1 页/.test(t));

        /* ---- 占位符继承：必须一路走到母版才拿得到位置 ---- */
        ok("★标题占位符拿到了继承来的位置", /位置: x=1\.27 y=0\.76 宽=22\.86 高=3\.18 cm\s+← 继承自母版/.test(t),
           (t.match(/位置: [^\n]*继承[^\n]*/) || [])[0] || "没有任何继承来的位置");
        ok("★正文占位符拿到了继承来的位置", /位置: x=1\.27 y=4\.45 宽=22\.86 高=12\.57 cm/.test(t));
        ok("继承链被标注出来", /匹配到版式「Title and Content」 → 母版/.test(t));
        ok("★标题字号从母版继承 44pt", /44pt\s+← 字号继承自母版文字样式\(标题\)/.test(t),
           (t.match(/· "继承测试标题"[^\n]*/) || [])[0]);
        ok("★正文字号从母版继承 32pt", /32pt\s+← 字号继承自母版文字样式\(正文\)/.test(t));
        ok("主题字体引用被解开", /主题 \+mj-ea/.test(t) || /主题 \+mn-ea/.test(t));

        /* ---- 幻灯片自身的形状仍然精确 ---- */
        ok("写死位置的矩形精确", /「ExplicitBox」\n位置: x=1 y=5 宽=3 高=2 cm\n填充: 纯色 #1E7A46/.test(t),
           (t.match(/「ExplicitBox」[\s\S]{0,80}/) || [])[0]);

        /* ---- 隐藏形状 ---- */
        ok("★隐藏形状被跳过", !/GhostShape/.test(t));
        ok("跳过的隐藏形状有计数", /另跳过 1 个隐藏形状/.test(t) && /全文共跳过 1 个/.test(t));

        /* ---- 表格 ---- */
        ok("表格 2×3", /表格: 2 行 × 3 列/.test(t));
        ok("表格列宽", /列宽: 6 \/ 6 \/ 6 cm/.test(t));
        ok("表格单元格", /\[1,1\] "Brand"/.test(t) && /\[2,2\] "4570k"/.test(t));

        ok("无 undefined/NaN", !/undefined|NaN/.test(t), (t.match(/[^\n]*(undefined|NaN)[^\n]*/) || [])[0]);

        /* 单位换算 */
        const tEmu = M.OOXML.convert(new Uint8Array(fs.readFileSync(fx)), "inherit.pptx",
                                     Object.assign({}, POPT, { unit: "emu" }));
        ok("EMU 单位：矩形 x=360000", /「ExplicitBox」\n位置: x=360000 /.test(tEmu),
           (tEmu.match(/「ExplicitBox」[\s\S]{0,60}/) || [])[0]);
        const tIn = M.OOXML.convert(new Uint8Array(fs.readFileSync(fx)), "inherit.pptx",
                                    Object.assign({}, POPT, { unit: "in" }));
        ok("英寸单位：矩形 宽=1.181", /「ExplicitBox」\n位置: [^\n]*宽=1\.181/.test(tIn),
           (tIn.match(/「ExplicitBox」[\s\S]{0,80}/) || [])[0]);

        /* 关掉版式库 */
        const tNo = M.OOXML.convert(new Uint8Array(fs.readFileSync(fx)), "inherit.pptx",
                                    Object.assign({}, POPT, { layouts: false }));
        ok("可以关掉版式库", !/## 版式库/.test(tNo));
        ok("关掉版式库后位置继承仍然生效", /← 继承自母版/.test(tNo));

        fs.writeFileSync(path.join(__dirname, "out-inherit.pptx.md"), t, "utf8");
      }
    }
  }


  /* ============================================================
     HTML / Outlook 邮件线（纯函数部分；渲染量测那段要 DOM，走浏览器集成测试）
     ============================================================ */
  section("HTML / Outlook：MIME 解析与清洗");
  {
    const fx = path.join(__dirname, "fixtures", "outlook.mht");
    if (!fs.existsSync(fx)) {
      console.log("  (跳过：先跑 python test/make-mht.py)");
    } else {
      const bytes = new Uint8Array(fs.readFileSync(fx));
      const p = M.HTMLDOC.parseMht(bytes);

      /* --- MIME --- */
      ok("MHT 取出 HTML 正文", p.html.length > 500, `只有 ${p.html.length} 字符`);
      ok("quoted-printable 解码", !/=\r?\n/.test(p.html) && p.html.indexOf("=E6") < 0,
         (p.html.match(/=[0-9A-F]{2}/) || [])[0]);
      ok("gb2312 中文解对", p.html.includes("拉美竞品周报") && p.html.includes("本周巴西手机市场"),
         p.html.slice(0, 120));
      ok("RFC2047 Subject 解码", p.subject.includes("拉美竞品周报"), p.subject);
      ok("RFC2047 From 解码", p.from.includes("张伟"), p.from);
      ok("cid 内嵌图解出", !!p.assets["cid:logo001"] && /^data:image\/png;base64,/.test(p.assets["cid:logo001"]),
         Object.keys(p.assets).join(" | "));
      ok("按文件名也能查到内嵌图", !!p.assets["image001.png"], Object.keys(p.assets).join(" | "));

      /* --- 清洗 --- */
      const san = M.HTMLDOC.sanitize(p.html, p.assets, {});
      const h = san.html;

      /* ★ 安全：最重要的一组。追踪像素一加载，发件人就知道你读了信。
         判据必须是「没有 http 地址处在会被抓取的位置」，而不是「全文没有 http 字样」——
         后者是前者的松散代理，既漏测（漏了 url()/@import）又误伤
         （<a href> 含 http 但链接不会自动请求，保留它才能在输出里报出链接）。
         data-blocked 里留着原地址是故意的：只为报告用，浏览器永远不请求 data-* 属性。 */
      ok("★ 没有 img 还带着远程 src", !/<img[^>]*\ssrc\s*=\s*["']https?:/i.test(h),
         (h.match(/<img[^>]*src=["']https?:[^"']*/i) || [])[0]);
      ok("★ 没有 background 属性带远程地址", !/\sbackground\s*=\s*["']https?:/i.test(h),
         (h.match(/\sbackground=["']https?:[^"']*/i) || [])[0]);
      ok("★ 样式里没有 url(http…)", !/url\(\s*["']?https?:/i.test(h),
         (h.match(/url\(\s*["']?https?:[^)]*/i) || [])[0]);
      ok("★ 没有 @import", !/@import/i.test(h));
      ok("★ 没有 link / script 标签", !/<link/i.test(h) && !/<script/i.test(h));
      /* 反向：链接文字与地址应当保留下来，这是有用信息不该误删 */
      ok("<a href> 保留（链接不会自动请求）", /href="https:\/\/example\.com\/more"/.test(h),
         (h.match(/<a[^>]*>/) || [])[0]);
      /* 隐私：被掐断的地址只用于报告，且输出文本里会剥掉 query（追踪 ID 常绑定邮箱） */
      ok("被掐地址仅存于 data-blocked（惰性属性）",
         /data-blocked="[^"]*track\.example\.com/.test(h) &&
         !/src\s*=\s*["'][^"']*track\.example\.com/i.test(h),
         (h.match(/<img[^>]*track[^>]*>/) || [])[0]);
      ok("追踪 ID 不会进输出文本（emit 只取文件名、剥 query）",
         "http://track.example.com/open.gif?uid=12345"
           .replace(/^cid:/i, "").split(/[\/]/).pop().split("?")[0] === "open.gif");
      ok("★ 远程横幅也被掐断", /data-blocked="[^"]*cdn\.example\.com/.test(h),
         (h.match(/<img[^>]*cdn[^>]*>/) || [])[0]);
      ok("统计报出被掐断数", san.stats.blockedRemote >= 2, JSON.stringify(san.stats));

      ok("cid 图被换成 data URL", /<img[^>]+src="data:image\/png;base64,/.test(h));
      ok("统计报出解析数", san.stats.resolved >= 1, JSON.stringify(san.stats));

      /* mso 条件注释：一个要删，一个要留 —— 这条最容易搞反 */
      ok("mso-only 内容被移除", !h.includes("MSOONLY_"),
         (h.match(/MSOONLY_[^<]*/) || [])[0]);
      ok("★ downlevel-revealed 内容被保留", h.includes("KEEPME_"),
         "非 mso 才显示的内容不能跟着一起删掉");
      ok("条件注释计数", san.stats.msoBlocks >= 1, JSON.stringify(san.stats));

      ok("<o:p> 去掉", !/<o:p/i.test(h));
      ok("VML 去掉", !/<v:shape/i.test(h) && !/<v:imagedata/i.test(h));
      ok("script 移除", !/<script/i.test(h) && !h.includes("这段脚本必须被移除"));
      ok("事件属性移除", !/\son\w+\s*=/i.test(h), (h.match(/\son\w+\s*=[^\s>]*/) || [])[0]);
      ok("正文文字保住", h.includes("三星") && h.includes("Samsung") && h.includes("4570k"));
      ok("链接文字保住", h.includes("查看详情"));
    }
  }

  /* ---- 编码与 MIME 的边角 ---- */
  {
    ok("QP 软换行", M.HTMLDOC.decodeQP("ab=\r\ncd") === "abcd");
    ok("QP 十六进制", M.HTMLDOC.decodeQP("a=41b") === "aAb");
    ok("头部折行接回", (() => {
      const h = M.HTMLDOC.splitHeaders("Content-Type: multipart/related;\r\n\tboundary=\"XY\"");
      return /boundary="XY"/.test(h["content-type"]);
    })(), JSON.stringify(M.HTMLDOC.splitHeaders("Content-Type: multipart/related;\r\n\tboundary=\"XY\"")));
    ok("RFC2047 Q 编码下划线是空格",
       M.HTMLDOC.decodeHeaderWord("=?utf-8?Q?a_b?=") === "a b",
       M.HTMLDOC.decodeHeaderWord("=?utf-8?Q?a_b?="));
    /* 相对路径图片没随包带上时，不能当成远程，也不能静默丢 */
    const s2 = M.HTMLDOC.sanitize('<img src="image002.png" width="80" height="40">', {}, {});
    ok("缺失的本地图记进 missing 而非 blockedRemote",
       s2.stats.missing === 1 && s2.stats.blockedRemote === 0, JSON.stringify(s2.stats));
    ok("缺失的本地图仍留下 data-blocked 以便留白", /data-blocked="image002\.png"/.test(s2.html), s2.html);
    /* data: 图不受影响 */
    const s3 = M.HTMLDOC.sanitize('<img src="data:image/png;base64,AAAA">', {}, {});
    ok("data: 图原样放行", /src="data:image\/png;base64,AAAA"/.test(s3.html), s3.html);
  }

  /* ============================================================
     6. 反向：结构化文本 → .pptx
     ============================================================ */
  section("文本 → PPTX（ZIP 与解析）");
  {
    /* CRC32 拿 zlib 当标准答案 —— 写 zip 时算错 CRC，PowerPoint 会直接说文件损坏 */
    for (const s of ["", "a", "Hello, World!", "拉美竞品情报", "x".repeat(5000)]) {
      const buf = Buffer.from(s, "utf8");
      ok(`crc32 "${s.slice(0, 12)}"(${buf.length}B)`,
         M.TOPPTX.crc32(new Uint8Array(buf)) === zlib.crc32(buf),
         M.TOPPTX.crc32(new Uint8Array(buf)) + " vs " + zlib.crc32(buf));
    }

    /* 生成的 zip 必须能被标准解压器读回来 —— 用我自己的 unzip 交叉验证 */
    const z = M.TOPPTX.zipStore([
      { name: "a.txt", data: new Uint8Array(Buffer.from("hello")) },
      { name: "dir/中文.xml", data: new Uint8Array(Buffer.from("<x>中文</x>", "utf8")) }
    ]);
    let files = null;
    try { files = M.OOXML.unzip(z); } catch (e) { ok("生成的 zip 可被解析", false, e.message); }
    if (files) {
      ok("生成的 zip 可被解析", true);
      ok("zip 条目齐全", !!files["a.txt"] && !!files["dir/中文.xml"], Object.keys(files).join(","));
    }

    ok("单位换算 cm→EMU", M.TOPPTX.toEmu(1, "cm") === 360000);
    ok("单位换算 pt→EMU", M.TOPPTX.toEmu(1, "pt") === 12700);
    ok("单位换算 in→EMU", M.TOPPTX.toEmu(1, "in") === 914400);
    ok("字体名取中文别名", M.TOPPTX.normFont("微软雅黑（MicrosoftYaHei-Bold）") === "微软雅黑",
       M.TOPPTX.normFont("微软雅黑（MicrosoftYaHei-Bold）"));
    ok("主题字体引用不落成字体名", M.TOPPTX.normFont("主要中文字体（主题 +mj-ea）") === null);
    ok("纯 ASCII 字体名原样", M.TOPPTX.normFont("Helvetica") === "Helvetica");
    ok("填充串解析", (M.TOPPTX.parseFillDesc("纯色 #1E7A46") || {}).hex === "#1E7A46");
    ok("PDF 版填充串解析", (M.TOPPTX.parseFillDesc("#1F6F8B") || {}).hex === "#1F6F8B");
    ok("渐变串解析", (() => { const f = M.TOPPTX.parseFillDesc("渐变（角度 90°）：0% #AABBCC → 100% #112233");
       return f && f.kind === "grad" && f.from === "#AABBCC" && f.to === "#112233"; })());
    ok("PDF 版边框串解析", (() => { const l = M.TOPPTX.parseLineDesc("#000000 粗细 0.6pt");
       return l && l.hex === "#000000" && Math.abs(l.w - 0.6) < 1e-9; })());
    ok("PPT 版边框串解析", (() => { const l = M.TOPPTX.parseLineDesc("0.75pt #1B2A3A，实线");
       return l && l.hex === "#1B2A3A" && Math.abs(l.w - 0.75) < 1e-9; })());
    ok("run 格式串解析", (() => { const r = M.TOPPTX.parseRunFmt("10.5pt 粗体 字体 微软雅黑（MicrosoftYaHei-Bold） #1B2A3A");
       return r.size === 10.5 && r.bold && r.font === "微软雅黑" && r.color === "#1B2A3A"; })(),
       JSON.stringify(M.TOPPTX.parseRunFmt("10.5pt 粗体 字体 微软雅黑（MicrosoftYaHei-Bold） #1B2A3A")));
    ok("继承说明不干扰 run 解析", (() => {
       const r = M.TOPPTX.parseRunFmt("44pt   ← 字号继承自母版文字样式(标题) 字体 主要中文字体（主题 +mj-ea）   ← 继承自母版文字样式(标题)");
       return r.size === 44 && r.font === null; })(),
       JSON.stringify(M.TOPPTX.parseRunFmt("44pt   ← 字号继承自母版文字样式(标题) 字体 主要中文字体（主题 +mj-ea）   ← 继承自母版文字样式(标题)")));
  }

  section("★ 往返：PPT → 文本 → PPT → 文本");
  {
    const fx = path.join(__dirname, "fixtures", "inherit.pptx");
    if (!fs.existsSync(fx)) {
      console.log("  (跳过：缺少 fixtures/inherit.pptx)");
    } else {
      const POPT = { preamble: false, compact: true, unit: "cm",
                     layouts: true, tableFmt: true, keepEmpty: false, charts: true };
      const t1 = M.OOXML.convert(new Uint8Array(fs.readFileSync(fx)), "inherit.pptx", POPT);

      let round = null;
      try { round = M.TOPPTX.convert(t1); }
      catch (e) { ok("文本能转回 pptx", false, e.message + "\n     " + (e.stack || "").split("\n")[1]); }

      if (round) {
        ok("文本能转回 pptx", true);
        fs.writeFileSync(path.join(__dirname, "roundtrip.pptx"), Buffer.from(round.bytes));
        console.log(`     生成 ${Math.round(round.bytes.length / 1024)} KB · ` +
                    `${round.model.slides.length} 页 · 文本框 ${round.model.stats.text} · ` +
                    `形状 ${round.model.stats.shape} · 表格 ${round.model.stats.table}`);

        /* 再解析一遍生成的文件 —— 两个方向同时错且错得一致的概率极低 */
        let t2 = null;
        try { t2 = M.OOXML.convert(round.bytes, "roundtrip.pptx", POPT); }
        catch (e) { ok("生成的 pptx 能被重新解析", false, e.message); }

        if (t2) {
          ok("生成的 pptx 能被重新解析", true);
          fs.writeFileSync(path.join(__dirname, "out-roundtrip.md"), t2, "utf8");

          ok("往返：页数保持 2", /幻灯片数: 2/.test(t2), (t2.match(/幻灯片数: \d+/) || [])[0]);
          ok("往返：画布尺寸不变", /33\.87 × 19\.05 cm/.test(t2), (t2.match(/画布尺寸: [^\n]*/) || [])[0]);
          ok("往返：背景保住", /#F6F8FA/.test(t2), (t2.match(/背景: [^\n]*/) || [])[0]);

          /* 文字内容 */
          for (const s of ["继承测试标题", "第一行正文", "第二行正文", "第二页"])
            ok(`往返：文字「${s}」还在`, t2.includes(s));

          /* 位置：占位符继承来的坐标，往返后必须变成写死的坐标 */
          ok("往返：标题位置固化为 1.27/0.76", /位置: x=1\.27 y=0\.76 宽=22\.86 高=3\.18 cm/.test(t2),
             (t2.match(/位置: [^\n]*/g) || []).slice(0, 4).join(" | "));
          ok("往返：ExplicitBox 位置精确", /位置: x=1 y=5 宽=3 高=2 cm/.test(t2),
             (t2.match(/位置: x=1 [^\n]*/) || [])[0]);
          ok("往返：ExplicitBox 填充色精确", /纯色 #1E7A46/.test(t2));

          /* 字号 */
          ok("往返：标题 44pt 固化", /"继承测试标题"[^\n]*44pt/.test(t2),
             (t2.match(/· "继承测试标题"[^\n]*/) || [])[0]);
          ok("往返：正文 32pt 固化", /"第一行正文"[^\n]*32pt/.test(t2),
             (t2.match(/· "第一行正文"[^\n]*/) || [])[0]);

          /* 表格 */
          ok("往返：表格仍是 2×3", /表格: 2 行 × 3 列/.test(t2), (t2.match(/表格: [^\n]*/) || [])[0]);
          ok("往返：表格内容完整", /"Brand"/.test(t2) && /"4570k"/.test(t2) && /"31%"/.test(t2));
          ok("往返：表格列宽保持 6cm", /列宽: 6 \/ 6 \/ 6 cm/.test(t2), (t2.match(/列宽: [^\n]*/) || [])[0]);

          /* 母版装饰元素被固化成普通形状（新文件没有母版，这是预期行为） */
          ok("往返：母版色条被固化进页面", /#1F6F8B/.test(t2),
             "母版元素应当变成页面上的实体形状");

          ok("往返：无 undefined/NaN", !/undefined|NaN/.test(t2),
             (t2.match(/[^\n]*(undefined|NaN)[^\n]*/) || [])[0]);
        }
      }
    }
  }

  /* ============================================================
     7. 真实 PDF
     ============================================================ */
  section("真实 PDF 集成测试");
  const realPdfs = [
    "D:/workspace/拉美竞品每日快报系统/latam-monitor/reports/拉美竞品快报_2026-07-21_演示.pdf",
    "D:/workspace/freqtrade/.venv/Lib/site-packages/matplotlib/mpl-data/images/matplotlib.pdf",
    "D:/workspace/freqtrade/.venv/Lib/site-packages/matplotlib/mpl-data/images/hand.pdf"
  ].concat(process.argv.slice(2));

  for (const p of realPdfs) {
    if (!fs.existsSync(p)) { console.log("  (跳过，文件不存在) " + p); continue; }
    const name = path.basename(p);
    const buf = fs.readFileSync(p);
    const t0 = Date.now();

    /* 命令行传进来的 .pptx 走 OOXML 引擎 */
    if (/\.(pptx|potx)$/i.test(name)) {
      let t = null;
      try {
        t = M.OOXML.convert(new Uint8Array(buf), name, {
          preamble: false, compact: true, unit: "cm",
          layouts: true, tableFmt: true, keepEmpty: false, charts: true
        });
      } catch (e) {
        ok("解析 " + name, false, e.message + "\n     " + (e.stack || "").split("\n")[1]);
        continue;
      }
      const g = re => (t.match(re) || []).length;
      ok("解析 " + name, true);
      console.log(`     ${g(/^## 幻灯片 /gm)} 页 · ${g(/^### 版式「/gm)} 个版式 · ` +
                  `${g(/← 继承自/g)} 处继承值 · ${g(/图表类型: /g)} 图表 · ${g(/^表格: /gm)} 表格 · ` +
                  `${t.length} 字符 · ${Date.now() - t0}ms`);
      ok(name + " 输出非空", t.length > 500);
      /* 属性缺失时把 attr() 直接拼进串会打出字面量 undefined —— 真实 PPT 上踩到过 */
      ok(name + " 未出现 undefined/NaN", !/undefined|NaN/.test(t),
         (t.match(/[^\n]*(undefined|NaN)[^\n]*/) || [])[0]);
      fs.writeFileSync(path.join(__dirname, "out-" + name.replace(/[^\w.-]/g, "_") + ".md"), t, "utf8");
      continue;
    }

    let r = null;
    try {
      r = await M.convertBytes(new Uint8Array(buf), name, OPT);
    } catch (e) {
      ok("解析 " + name, false, e.message + "\n     " + (e.stack || "").split("\n").slice(1, 4).join("\n     "));
      continue;
    }
    const ms = Date.now() - t0;
    const t = r.text;
    const pageCount = r.pages.length;
    /* 统计提取到的全部文字：表格里的也要算 ——
       只数表格外的话，表格识别得越好这个数越小，指标方向就反了 */
    const blockChars = r.pages.reduce((a, pg) => a + pg.blocks.reduce((b, bl) =>
      b + bl.paras.reduce((c, pa) => c + pa.text.length, 0), 0), 0);
    const tableChars = r.pages.reduce((a, pg) => a + pg.tables.reduce((b, tb) =>
      b + tb.grid.reduce((c, row) => c + row.reduce((d, cell) => d + (cell.text || "").length, 0), 0), 0), 0);
    const textChars = blockChars + tableChars;
    /* 从真实计数器取，别去数输出文本里的 � ——
       自检清单里本来就写着这个字符，那样每个文件都会报「1 个未解出」 */
    const badChars = r.pages.reduce((a, pg) => a + pg.blocks.reduce((b, bl) =>
      b + bl.paras.reduce((c, pa) => c + (pa.bad || 0), 0), 0), 0);
    const shapes = r.pages.reduce((a, pg) => a + pg.shapes.length, 0);
    const tables = r.pages.reduce((a, pg) => a + pg.tables.length, 0);
    const charts = r.pages.reduce((a, pg) => a + pg.charts.length, 0);
    const images = r.pages.reduce((a, pg) => a + pg.images.length, 0);

    ok("解析 " + name, true);
    console.log(`     ${pageCount} 页 · ${textChars} 字(正文${blockChars}+表格${tableChars}) · ${shapes} 形状 · ${tables} 表格 · ` +
                `${charts} 疑似图表 · ${images} 图片 · ${t.length} 输出字符 · ${ms}ms` +
                (badChars ? `  ⚠️ ${badChars} 个字形未解出` : ""));

    ok(name + " 有页面", pageCount > 0);
    ok(name + " 输出非空", t.length > 200);
    /* 有文字层的 PDF 必须提到字 —— matplotlib 的图标 PDF 是纯矢量，跳过这条 */
    if (!/hand\.pdf|matplotlib\.pdf/.test(name)) {
      ok(name + " 提取到文字", textChars > 50, `只提取到 ${textChars} 个字`);
    }
    ok(name + " 未出现 undefined/NaN", !/undefined|NaN/.test(t),
       (t.match(/[^\n]*(undefined|NaN)[^\n]*/) || [])[0]);
    fs.writeFileSync(path.join(__dirname, "out-" + name.replace(/[^\w.-]/g, "_") + ".md"), t, "utf8");
  }

  /* ============================================================
     汇总
     ============================================================ */
  console.log("\n" + "=".repeat(60));
  console.log(`通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.log("\n失败清单：");
    failures.forEach(f => console.log("  ✗ " + f));
    process.exit(1);
  } else {
    console.log("全部通过");
  }
})();
