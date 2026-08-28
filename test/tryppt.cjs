/* 手工试跑 PPTX 引擎（调试用）。
   用法：node test/tryppt.cjs <某个.pptx> */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const MODS = ["1-core.js", "2-font.js", "3-render.js", "4-layout.js", "5-emit.js", "7-ooxml.js"];
const bundle = path.join(__dirname, "_bundle.cjs");
if (!fs.existsSync(bundle)) {
  const code = MODS.map(f => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n");
  fs.writeFileSync(bundle, '"use strict";\n' + code + "\nmodule.exports = { OOXML };\n");
}
const M = require(bundle);

const file = process.argv[2];
const buf = new Uint8Array(fs.readFileSync(file));
const t = M.OOXML.convert(buf, path.basename(file), {
  preamble: false, compact: true, unit: "cm",
  layouts: true, tableFmt: true, keepEmpty: false, charts: true
});
const out = path.join(__dirname, "ppt-out.md");
fs.writeFileSync(out, t, "utf8");
console.log(t);
console.error("\n(完整输出已写入 " + out + "，共 " + t.length + " 字符)");
