/* ============================================================
   11-htmlemit.js —— HTML 线的总装与出文本
   输出格式与 PDF / PPTX 线逐字一致，所以「文本 -> PPT」那条管线不用改。
   ============================================================ */
const HTMLLINE = (function(){
"use strict";

const PX_PT = 72 / 96;

/* ---------- 单位 ---------- */
function mkFmt(unit, k){
  const f = function(px){
    const pt = px * PX_PT * k;
    if (unit === "pt") return String(Math.round(pt * 10) / 10);
    if (unit === "in") return String(Math.round(pt / 72 * 1000) / 1000);
    return String(Math.round(pt / 72 * 2.54 * 100) / 100);
  };
  f.u = unit === "pt" ? "pt" : unit === "in" ? "in" : "cm";
  f.fs = function(px){ return (Math.round(px * PX_PT * k * 10) / 10) + "pt"; };
  return f;
}

const escQ = s => String(s === undefined || s === null ? "" : s).replace(/"/g, "'");

/* ---------- 给 AI 的说明（HTML 版） ---------- */
const PREAMBLE = "> 【给 AI 的说明】下面是一份 HTML（多为 Outlook 邮件）的结构化描述，\n" +
"> 由「文档转AI文本」把它在浏览器里真实排版一遍后量出来的。目的是让你据此还原成 PPT。\n" +
">\n" +
"> ⚠️ 这条线和 PDF / PPT 那两条有一个根本区别，先读懂再动手：\n" +
"> HTML 文件里**没有坐标**，它是流式布局，位置是浏览器排出来的。\n" +
"> 所以下面的坐标是「按指定宽度渲染后量出来的真实值」——精确，但**依赖渲染宽度和本机字体**：\n" +
"> 换一个宽度、或者本机缺某个字体，换行位置会变，坐标随之变。\n" +
"> 文首会写明用的是哪个宽度。\n" +
">\n" +
"> 可信度分级与另外两条线一致：\n" +
">   · 没有标记的数值 —— 量出来的真实值（坐标、尺寸、字号、颜色、字体名），请照抄。\n" +
">   · [推断 置信度x.xx] —— 从结构关系判断的（哪些 <table> 是真数据表、哪些只是版面容器）。\n" +
">   · 「无法确定」 —— 确实解不出来，没拿猜测糊弄你。\n" +
">\n" +
"> 阅读约定：\n" +
"> · 坐标原点在页面左上角，x 向右、y 向下。单位见每行标注。\n" +
"> · 元素按 [序号] 排列，序号即文档顺序，基本等同于阅读顺序。\n" +
"> · 颜色写作 #RRGGBB。\n" +
"> · 「矩形」多半是网页里的背景色块 / 边框容器，还原成 PPT 的形状即可。\n" +
">\n" +
"> 关于图片（这条你必须照做）：\n" +
"> · 邮件里的图分两种。内嵌图（cid:）能拿到，但**像素没法用文本传输**；\n" +
">   远程图（http）被工具**主动掐断了**——邮件里的远程图片就是追踪像素，\n" +
">   一加载发件人就知道收件人读了信，所以本工具不联网取它。\n" +
"> · 两种情况都给了**准确的位置和尺寸**。请在 PPT 里**按这个位置和尺寸留出空白占位框**，\n" +
">   不要把图省略掉、也不要把周围内容挪上去填满。用户要的就是这块留白。\n" +
"> · 占位框里写上图片的文件名或 alt 文字，方便用户后面自己贴图。\n" +
">\n" +
"> 还原成 PPT 的建议：\n" +
"> 1. 用 python-pptx。幻灯片尺寸用文首「目标版式」给出的值。\n" +
"> 2. 一个「文本块」= 一个 textbox，按给的 x/y/宽/高 定位，word_wrap=True，格式照抄。\n" +
"> 3. 「表格」用真正的 pptx 表格（add_table）。\n" +
"> 4. 邮件正文往往很长，工具已按目标版式切好页。跨页的元素会标注「跨页」，\n" +
">    你可以按内容调整分页，但要说明怎么调的。\n";

/* ---------- 主流程 ---------- */
async function convert(input, fileName, opt){
  /* input: {html, assets, meta} */
  const width = Math.max(320, Math.min(2400, opt.htmlWidth || 900));
  const san = HTMLDOC.sanitize(input.html, input.assets, opt);
  const docHtml = HTMLDOC.wrapDocument(san.html, width);

  const r = await HTMLMEASURE.renderInFrame(docHtml, width);
  let m;
  try {
    m = HTMLMEASURE.measure(r.ifr.contentWindow, r.ifr.contentDocument, opt);
  } finally {
    r.cleanup();
  }

  const pages = HTMLMEASURE.paginate(m, opt);

  /* 目标版式折算：按页宽缩放到幻灯片宽度 */
  let k = 1, targetLine = "保持渲染尺寸";
  if (opt.target === "16:9" || opt.target === "4:3"){
    const twPt = opt.target === "16:9" ? 960 : 720;
    k = twPt / (m.contentW * PX_PT);
    targetLine = opt.target + " 幻灯片（内容宽度 " + Math.round(m.contentW) + "px 缩放 " +
                 (Math.round(k * 1000) / 1000) + "× 铺满页宽，下面坐标已折算完毕）";
  }
  const f = mkFmt(opt.unit, k);

  const L = [];
  L.push("# HTML 结构化描述：" + fileName);
  L.push("");
  const pw = pages[0] ? pages[0].w : m.contentW;
  const ph = pages[0] ? pages[0].h : m.contentH;
  L.push("页面尺寸: " + f(pw) + " × " + f(ph) + " " + f.u +
         "　(渲染宽度 " + width + "px，内容实占 " + Math.round(m.contentW) + "×" + Math.round(m.contentH) + "px)");
  L.push("页数: " + pages.length + (opt.htmlPage === "one" ? "（整封不切页）" : "（按目标版式切页）"));
  L.push("目标版式: " + targetLine);

  const meta = input.meta || {};
  if (meta.subject) L.push("邮件主题: " + meta.subject);
  if (meta.from) L.push("发件人: " + meta.from);
  if (meta.to) L.push("收件人: " + meta.to);
  if (meta.date) L.push("日期: " + meta.date);

  /* ---- 警告 ---- */
  const W = [];
  W.push("坐标是按 " + width + "px 宽度渲染后量出来的真实值，不是文件里存的——" +
         "HTML 没有坐标。换渲染宽度、或本机缺字体导致换行不同，坐标都会变。");
  if (san.stats.blockedRemote)
    W.push("⛔ 掐断了 " + san.stats.blockedRemote + " 个远程资源引用（未联网获取）。" +
           "邮件里的远程图片通常是追踪像素，一加载发件人就知道你读了信。" +
           "这些图的位置和尺寸仍然给了，还原时按位置留白即可。");
  if (san.stats.resolved)
    W.push("从 .mht 里解出 " + san.stats.resolved + " 处内嵌图片引用（本地数据，没有联网）。");
  if (san.stats.missing)
    W.push("有 " + san.stats.missing + " 个图片引用指向随包的本地文件但没找到（只拖了 .htm 没拖 _files 文件夹？）。" +
           "位置仍按原始 width/height 留白。");
  if (san.stats.blockedScript)
    W.push("移除了 " + san.stats.blockedScript + " 处脚本/外链标签（渲染时也禁用了脚本执行）。");
  if (san.stats.msoBlocks)
    W.push("清掉了 " + san.stats.msoBlocks + " 段 Outlook 条件注释（<!--[if mso]>），" +
           "不清的话它们会被当成正文显示出来。");
  const spanning = pages.reduce((a, p) => a + p.items.filter(i => i.spansPage).length, 0);
  if (spanning)
    W.push("有 " + spanning + " 个元素跨越了切页边界，已整体归到它顶端所在的那一页（不劈开元素）。");

  L.push("");
  L.push("## ⚠️ 转换过程中的已知问题（请连同正文一起读）");
  for (const w of W) L.push("- " + w);

  L.push("");
  if (opt.preamble){ L.push(PREAMBLE); L.push(""); }
  L.push("---");
  L.push("");

  /* ---- 逐页 ---- */
  const stats = { text: 0, decor: 0, table: 0, image: 0, blocked: 0 };
  pages.forEach(function(pg, pi){
    L.push("## 第 " + (pi + 1) + " 页 / 共 " + pages.length + " 页");
    L.push("");
    const sorted = pg.items.slice().sort((a, b) => a.seq - b.seq);
    let n = 0;
    for (const it of sorted){
      n++;
      const b = { x: it.box.x, y: it.box.y - pg.offsetY, w: it.box.w, h: it.box.h };
      const pos = "位置: x=" + f(b.x) + " y=" + f(b.y) + " 宽=" + f(b.w) + " 高=" + f(b.h) + " " + f.u;

      if (it.kind === "text"){
        stats.text++;
        const tag = it.heading ? "（" + it.heading + " 标题）" : (it.listItem ? "（列表项）" : "");
        L.push("### [" + n + "] 文本块" + tag + (it.spansPage ? "  ⚠️跨页" : ""));
        L.push(pos);
        it.paras.forEach(function(p, i){
          const al = p.align === "center" ? "居中" : p.align === "right" ? "右对齐"
                   : p.align === "justify" ? "两端对齐" : null;
          L.push("段落" + (i + 1) + (al ? " [" + al + "]" : "") + ":");
          for (const run of p.runs){
            const bits = [f.fs(run.style.size)];
            if (run.style.bold) bits.push("粗体");
            if (run.style.italic) bits.push("斜体");
            if (run.style.underline) bits.push("下划线");
            if (run.style.strike) bits.push("删除线");
            if (run.style.font) bits.push("字体 " + run.style.font);
            if (run.style.color) bits.push(run.style.color);
            L.push('  · "' + escQ(run.text) + '"  — ' + bits.join(" ") +
                   (run.href ? "  ← 链接 " + run.href : ""));
          }
        });
      }
      else if (it.kind === "image"){
        stats.image++;
        if (it.blocked) stats.blocked++;
        L.push("### [" + n + "] 图片" + (it.spansPage ? "  ⚠️跨页" : ""));
        L.push(pos);
        const src = String(it.src || "");
        const name = src.replace(/^cid:/i, "").split(/[\\/]/).pop().split("?")[0].slice(0, 80);
        if (it.blocked){
          L.push("来源: 远程图片，已主动掐断未加载（追踪像素风险）　原始地址: " + (name || src.slice(0, 80)));
        } else if (it.embedded){
          L.push("来源: 邮件内嵌图（cid:），像素在本机但无法用文本传输" +
                 (it.natW ? "　原始像素 " + it.natW + "×" + it.natH : ""));
        } else {
          L.push("来源: " + (name || "无法确定"));
        }
        if (it.alt) L.push("替代文字: " + it.alt);
        L.push("⚠️ 请在这个位置按这个尺寸留出空白占位框，不要省略、也不要把周围内容挪上来填满。");
      }
      else if (it.kind === "table"){
        stats.table++;
        L.push("### [" + n + "] 表格  [推断 置信度" + it.conf.toFixed(2) + "]" +
               (it.spansPage ? "  ⚠️跨页" : ""));
        L.push(pos);
        const rows = it.grid.length;
        const cols = it.grid.reduce((a, r) => Math.max(a, r.length), 0);
        L.push(rows + " 行 × " + cols + " 列　依据: " + it.why);
        if (it.colX && it.colX.length >= 4){
          const ws = [];
          for (let i = 0; i + 1 < it.colX.length; i += 2) ws.push(f(it.colX[i + 1] - it.colX[i]));
          L.push("列宽: " + ws.join(" | ") + " " + f.u);
        }
        it.grid.forEach(function(row, ri){
          L.push("  第" + (ri + 1) + "行: " + row.map(c => '"' + escQ(c.text) + '"').join(" | "));
        });
      }
      else if (it.kind === "decor"){
        stats.decor++;
        const shape = it.radius > 1 ? "圆角矩形" : (it.box.h <= 3 ? "水平线" : "矩形");
        L.push("### [" + n + "] " + shape + (it.spansPage ? "  ⚠️跨页" : ""));
        L.push(pos);
        if (it.radius > 1) L.push("圆角半径: " + f(it.radius) + f.u);
        if (it.fill) L.push("填充: " + it.fill +
          (it.fillAlpha < 0.99 ? " 透明度 " + Math.round((1 - it.fillAlpha) * 100) + "%" : ""));
        if (it.stroke) L.push("边框: " + it.stroke + " 粗细 " +
          (Math.round(it.strokeW * k * 100) / 100) + "pt" + (it.dashed ? " 虚线" : ""));
      }
      L.push("");
    }
    L.push("（本页共 " + n + " 个元素）");
    L.push("");
    L.push("---");
    L.push("");
  });

  L.push("## 还原自检清单（给 AI）");
  L.push("做完 PPT 后请逐条自查，并把结果告诉用户：");
  L.push("1. 每张图片都留出占位框了吗？位置和尺寸和给的一致吗？（这是用户明确要求的）");
  L.push("2. 被掐断的远程图片，你是留白还是省略了？必须留白。");
  L.push("3. 标了「跨页」的元素你怎么处理的？");
  L.push("4. 置信度低于 0.6 的表格判断，你采纳了还是改了？");
  L.push("5. 如果调整了分页或版式，说明依据。");

  return { text: L.join("\n"), stats: stats, sanStats: san.stats,
           pages: pages.length, width: width, contentW: m.contentW, contentH: m.contentH };
}

/* 入口：认 .mht/.mhtml 与 .htm/.html（后者可同时拖 _files 文件夹里的图） */
async function convertFile(bytes, fileName, opt, sideFiles){
  const isMht = /\.(mht|mhtml)$/i.test(fileName);
  let input;
  if (isMht){
    const p = HTMLDOC.parseMht(bytes);
    input = { html: p.html, assets: p.assets,
              meta: { subject: p.subject, from: p.from, to: p.to, date: p.date } };
  } else {
    /* 猜编码：先看 meta charset，再退 UTF-8 */
    let head = "";
    for (let i = 0; i < Math.min(bytes.length, 4096); i++) head += String.fromCharCode(bytes[i]);
    const cm = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
    const html = HTMLDOC.decodeText(bytes, cm ? cm[1] : "utf-8");
    input = { html: html, assets: sideFiles || Object.create(null), meta: {} };
  }
  return convert(input, fileName, opt);
}

return { convert: convert, convertFile: convertFile, PREAMBLE: PREAMBLE };
})();
