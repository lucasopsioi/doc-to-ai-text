/* 字体诊断小工具。输出里出现 � 或粗斜体不对时，用它看真实的字体描述符。
   用法：node test/run.js 先跑一次生成 _bundle.cjs，然后
        node test/probe.cjs <某个.pdf> */
const fs = require("fs");
const M = require("./_bundle.cjs");
const doc = new M.PDFDoc(new Uint8Array(fs.readFileSync(process.argv[2])));
doc.load();
const r = new M.Renderer(doc, {});
const pages = Math.min(doc.pages.length, Number(process.argv[3] || 1));
for (let i = 0; i < pages; i++) r.renderPage(doc.pages[i], i);
for (const [, f] of r.fontCache) {
  if (!f) continue;
  console.log(
    `${(f.rawName || "?").padEnd(26)} bold=${String(f.bold).padEnd(5)} italic=${String(f.italic).padEnd(5)}` +
    ` flags=0x${(f.flags || 0).toString(16).padStart(5, "0")} weight=${f.fontWeight} stemV=${f.stemV}` +
    ` 内嵌=${f.embedded} 类型=${f.subtype} ToUnicode=${f.hasToUnicode}` +
    ` 解不出=${f.undecodable}/${f.total}`);
}
for (const w of doc.warnings) console.log("  ! " + w);
