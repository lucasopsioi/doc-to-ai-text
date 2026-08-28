/* ============================================================
   10-htmlmeasure.js —— 渲染 + 量测 + 出文本
   把清洗过的 HTML 塞进隔离 iframe，让浏览器真排一遍，
   再用 getBoundingClientRect / getComputedStyle 量出真实坐标与样式。

   这一层必须有 DOM，Node 里跑不了 —— 所以它只做「量」和「排版成文本」，
   所有能纯函数化的解析都留在 9-html.js，那部分在 Node 里有回归。
   ============================================================ */
const HTMLMEASURE = (function(){
"use strict";

const PX_PT = 72 / 96;
const rgbRe = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i;

function toHex(css){
  const m = rgbRe.exec(String(css || ""));
  if (!m) return null;
  const a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (a < 0.04) return null;                       /* 全透明当没有 */
  const h = n => { const v = Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16); return v.length < 2 ? "0" + v : v; };
  return { hex: ("#" + h(m[1]) + h(m[2]) + h(m[3])).toUpperCase(), alpha: a };
}

/* 字体族取第一个具名的，去掉引号与通用族 */
function firstFont(css){
  const parts = String(css || "").split(",");
  for (const p of parts){
    const n = p.trim().replace(/^["']|["']$/g, "");
    if (!n) continue;
    if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+)$/i.test(n)) continue;
    return n;
  }
  return null;
}

const BLOCKISH = /^(DIV|P|LI|TD|TH|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|DD|DT|FIGCAPTION|SECTION|ARTICLE|HEADER|FOOTER|CENTER|ADDRESS)$/;
const SKIP_TAG = /^(SCRIPT|STYLE|HEAD|META|LINK|TITLE|NOSCRIPT)$/;

/* ==================== 渲染 ==================== */
function renderInFrame(docHtml, widthPx){
  return new Promise(function(resolve, reject){
    const ifr = document.createElement("iframe");
    /* sandbox 不给 allow-scripts：文档内任何脚本都跑不起来。
       配合 9-html 的预清洗与文档内 CSP，共三层。 */
    ifr.setAttribute("sandbox", "allow-same-origin");
    ifr.setAttribute("referrerpolicy", "no-referrer");
    ifr.style.cssText = "position:fixed;left:-99999px;top:0;border:0;visibility:hidden;" +
                        "width:" + widthPx + "px;height:600px";
    let done = false;
    const finish = function(err){
      if (done) return;
      done = true;
      if (err){ try { ifr.remove(); } catch (e){} reject(err); }
      else resolve({ ifr: ifr, cleanup: function(){ try { ifr.remove(); } catch (e){} } });
    };
    ifr.onload = function(){
      try {
        const d = ifr.contentDocument;
        if (!d) return finish(new Error("拿不到 iframe 文档（可能被浏览器策略拦了）"));
        if (!d.body || !d.body.firstChild) return;    /* 还是 about:blank，等真正的 srcdoc */
        /* 撑到内容实际高度，否则量出来的都是视口内的 */
        const h = Math.max(600, d.documentElement.scrollHeight, d.body.scrollHeight);
        ifr.style.height = h + "px";
        /* 让布局稳定下来（图片是 data: 的，已随文档解析完成）。
           ★ 这里不能用 requestAnimationFrame：页面不可见时 rAF 根本不触发
           —— 浏览器后台标签、以及 exe 的窗口被最小化时都是这个状态，
           一旦依赖它，转换会直接卡死到超时。setTimeout 不看可见性。 */
        setTimeout(function(){ setTimeout(function(){ finish(null); }, 0); }, 30);
      } catch (e){ finish(e); }
    };
    ifr.onerror = function(){ finish(new Error("iframe 加载失败")); };
    /* 先挂 srcdoc 再入文档，避免先为 about:blank 触发一次 load */
    ifr.srcdoc = docHtml;
    document.body.appendChild(ifr);
    setTimeout(function(){ finish(new Error("渲染超时（15 秒）")); }, 15000);
  });
}

/* ==================== 表格分类 ====================
   Outlook 用嵌套表格做版面，一张邮件里十几个 <table> 大多不是数据表。
   全当数据表会输出一堆 1x1 的假表格并把正文吞进去（PDF 那边踩过同款）。
   判据用结构信号，不用取值分布。 */
function classifyTable(tbl, win){
  const rows = tbl.rows ? tbl.rows.length : 0;
  let cols = 0;
  for (let i = 0; i < rows; i++) cols = Math.max(cols, tbl.rows[i].cells.length);
  if (rows < 2 || cols < 2) return { data: false, why: "只有 " + rows + " 行 " + cols + " 列", conf: 0 };
  if (tbl.querySelector("table")) return { data: false, why: "内部还嵌着表格，是版面容器", conf: 0 };

  const hasTh = !!tbl.querySelector("th");
  let bordered = 0, cells = 0, longCells = 0;
  for (let i = 0; i < rows; i++){
    for (let j = 0; j < tbl.rows[i].cells.length; j++){
      const c = tbl.rows[i].cells[j];
      cells++;
      const cs = win.getComputedStyle(c);
      if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0) bordered++;
      if ((c.textContent || "").trim().length > 120) longCells++;
    }
  }
  const borderRatio = cells ? bordered / cells : 0;
  const longRatio = cells ? longCells / cells : 0;
  if (hasTh) return { data: true, why: "有 <th> 表头", conf: 0.9 };
  if (borderRatio > 0.5 && longRatio < 0.2)
    return { data: true, why: rows + "×" + cols + "，" + Math.round(borderRatio * 100) + "% 单元格有边框", conf: 0.8 };
  if (longRatio < 0.1 && rows >= 3)
    return { data: true, why: rows + "×" + cols + "，单元格内容都很短", conf: 0.6 };
  return { data: false, why: "无表头无边框且单元格内容偏长，更像版面容器", conf: 0 };
}

/* ==================== 量测 ==================== */
function measure(win, doc, opt){
  const body = doc.body;
  const items = [];
  const warn = [];
  let seq = 0;

  const rootRect = body.getBoundingClientRect();
  const OX = rootRect.left, OY = rootRect.top;
  const box = el => {
    const r = el.getBoundingClientRect();
    return { x: r.left - OX, y: r.top - OY, w: r.width, h: r.height };
  };
  const visible = (el, cs) =>
    cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.05;

  /* 取一个元素的直接内联内容，切成段落（<br> 分段） */
  function paragraphsOf(el){
    const paras = [];
    let cur = [];
    const flush = () => { if (cur.some(r => r.text.trim())) paras.push(cur); cur = []; };

    const walkInline = function(node, style){
      for (let n = node.firstChild; n; n = n.nextSibling){
        if (n.nodeType === 3){
          const t = n.nodeValue.replace(/\s+/g, " ");
          if (t) cur.push({ text: t, style: style, href: null });
        } else if (n.nodeType === 1){
          const tag = n.tagName;
          if (SKIP_TAG.test(tag)) continue;
          if (tag === "BR"){ flush(); continue; }
          const cs = win.getComputedStyle(n);
          if (!visible(n, cs)) continue;
          if (cs.display === "block" || cs.display === "list-item" || BLOCKISH.test(tag)) continue;  /* 块级子元素单独成块 */
          if (tag === "IMG") continue;
          const st = {
            size: parseFloat(cs.fontSize) || 0,
            bold: (parseInt(cs.fontWeight, 10) || 400) >= 600 || cs.fontWeight === "bold",
            italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
            font: firstFont(cs.fontFamily),
            color: (toHex(cs.color) || {}).hex || null,
            underline: /underline/.test(cs.textDecorationLine || cs.textDecoration || ""),
            strike: /line-through/.test(cs.textDecorationLine || cs.textDecoration || "")
          };
          const href = tag === "A" ? n.getAttribute("href") : null;
          const before = cur.length;
          walkInline(n, st);
          if (href) for (let k = before; k < cur.length; k++) cur[k].href = href;
        }
      }
    };

    const cs0 = win.getComputedStyle(el);
    walkInline(el, {
      size: parseFloat(cs0.fontSize) || 0,
      bold: (parseInt(cs0.fontWeight, 10) || 400) >= 600 || cs0.fontWeight === "bold",
      italic: cs0.fontStyle === "italic" || cs0.fontStyle === "oblique",
      font: firstFont(cs0.fontFamily),
      color: (toHex(cs0.color) || {}).hex || null,
      underline: /underline/.test(cs0.textDecorationLine || cs0.textDecoration || ""),
      strike: /line-through/.test(cs0.textDecorationLine || cs0.textDecoration || "")
    });
    flush();

    /* 相邻同格式片段合并成 run */
    return paras.map(function(frags){
      const runs = [];
      for (const f of frags){
        const key = [f.style.size, f.style.bold, f.style.italic, f.style.font,
                     f.style.color, f.style.underline, f.style.strike, f.href].join("|");
        const last = runs[runs.length - 1];
        if (last && last.key === key) last.text += f.text;
        else runs.push({ key: key, text: f.text, style: f.style, href: f.href });
      }
      for (const r of runs) r.text = r.text.replace(/\s+/g, " ");
      /* 段首尾的空白没有意义 */
      if (runs.length){ runs[0].text = runs[0].text.replace(/^\s+/, ""); runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, ""); }
      return { runs: runs.filter(r => r.text) , align: cs0.textAlign };
    }).filter(p => p.runs.length);
  }

  function hasDirectText(el){
    for (let n = el.firstChild; n; n = n.nextSibling)
      if (n.nodeType === 3 && n.nodeValue.trim()) return true;
      else if (n.nodeType === 1 && !BLOCKISH.test(n.tagName) && !SKIP_TAG.test(n.tagName)
               && n.tagName !== "IMG" && (n.textContent || "").trim()) return true;
    return false;
  }

  /* 背景色块与边框：这些是 PPT 里要还原成形状的东西 */
  function recordDecor(el, cs, b){
    if (b.w < 2 || b.h < 2) return;
    const bg = toHex(cs.backgroundColor);
    const bw = ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]
      .map(k => parseFloat(cs[k]) || 0);
    const maxBw = Math.max.apply(null, bw);
    const bc = toHex(cs.borderTopColor) || toHex(cs.borderLeftColor);
    const hasBorder = maxBw > 0 && cs.borderTopStyle !== "none" && bc;
    if (!bg && !hasBorder) return;
    /* 整页白底不算装饰 */
    if (bg && bg.hex === "#FFFFFF" && b.w > 0.95 * body.scrollWidth && b.y < 2) return;
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    items.push({
      seq: seq++, kind: "decor", box: b,
      fill: bg ? bg.hex : null, fillAlpha: bg ? bg.alpha : 1,
      stroke: hasBorder ? bc.hex : null, strokeW: hasBorder ? maxBw * PX_PT : 0,
      dashed: /dashed|dotted/.test(cs.borderTopStyle),
      radius: radius,
      tag: el.tagName
    });
  }

  function walk(el, depth){
    if (depth > 60) return;
    for (let n = el.firstElementChild; n; n = n.nextElementSibling){
      const tag = n.tagName;
      if (SKIP_TAG.test(tag)) continue;
      const cs = win.getComputedStyle(n);
      if (!visible(n, cs)) continue;
      const b = box(n);

      if (tag === "IMG"){
        const blocked = n.getAttribute("data-blocked");
        items.push({
          seq: seq++, kind: "image", box: b,
          alt: n.getAttribute("alt") || "",
          src: blocked || n.getAttribute("src") || "",
          blocked: !!blocked,
          embedded: !blocked && /^data:/i.test(n.getAttribute("src") || ""),
          natW: n.naturalWidth || 0, natH: n.naturalHeight || 0
        });
        continue;
      }

      if (tag === "TABLE"){
        const cls = classifyTable(n, win);
        recordDecor(n, cs, b);
        if (cls.data){
          const grid = [], colX = [];
          for (let i = 0; i < n.rows.length; i++){
            const row = [];
            for (let j = 0; j < n.rows[i].cells.length; j++){
              const c = n.rows[i].cells[j];
              const ccs = win.getComputedStyle(c);
              const cb = box(c);
              if (i === 0) colX.push(cb.x, cb.x + cb.w);
              row.push({
                text: (c.textContent || "").replace(/\s+/g, " ").trim(),
                bold: (parseInt(ccs.fontWeight, 10) || 400) >= 600 || c.tagName === "TH",
                size: parseFloat(ccs.fontSize) || 0,
                color: (toHex(ccs.color) || {}).hex || null,
                fill: (toHex(ccs.backgroundColor) || {}).hex || null,
                align: ccs.textAlign,
                colspan: c.colSpan || 1, rowspan: c.rowSpan || 1
              });
            }
            grid.push(row);
          }
          const rowY = [];
          for (let i = 0; i < n.rows.length; i++){
            const rb = box(n.rows[i]);
            rowY.push(rb.h);
          }
          items.push({ seq: seq++, kind: "table", box: b, grid: grid,
                       colX: colX, rowH: rowY, why: cls.why, conf: cls.conf });
          continue;                                /* 数据表内部不再往下走 */
        }
        /* 版面表格：透明容器，继续下钻 */
        walk(n, depth + 1);
        continue;
      }

      if (tag === "HR"){
        items.push({ seq: seq++, kind: "decor", box: { x: b.x, y: b.y, w: b.w, h: Math.max(1, b.h) },
                     fill: (toHex(cs.borderTopColor) || { hex: "#CCCCCC" }).hex, fillAlpha: 1,
                     stroke: null, strokeW: 0, dashed: false, radius: 0, tag: "HR" });
        continue;
      }

      recordDecor(n, cs, b);

      if (hasDirectText(n)){
        const paras = paragraphsOf(n);
        if (paras.length){
          items.push({
            seq: seq++, kind: "text", box: b, paras: paras,
            tag: tag,
            heading: /^H[1-6]$/.test(tag) ? tag : null,
            listItem: tag === "LI"
          });
        }
      }
      walk(n, depth + 1);
    }
  }

  walk(body, 0);

  /* 内容实际占的范围 —— body 宽度是我们给的，内容可能只占一部分 */
  let cw = 0, ch = 0;
  for (const it of items){
    cw = Math.max(cw, it.box.x + it.box.w);
    ch = Math.max(ch, it.box.y + it.box.h);
  }
  cw = Math.min(cw, body.scrollWidth) || body.scrollWidth;
  ch = ch || body.scrollHeight;

  return { items: items, contentW: cw, contentH: ch, warnings: warn };
}

/* ==================== 切页 ==================== */
function paginate(m, opt){
  if (opt.htmlPage === "one"){
    return [{ items: m.items, w: m.contentW, h: m.contentH, offsetY: 0 }];
  }
  const ratio = opt.target === "4:3" ? 3 / 4 : 9 / 16;
  const pageH = Math.max(80, m.contentW * ratio);
  const pages = [];
  const n = Math.max(1, Math.ceil(m.contentH / pageH));
  for (let i = 0; i < n; i++) pages.push({ items: [], w: m.contentW, h: pageH, offsetY: i * pageH });
  for (const it of m.items){
    /* 按元素顶端归页，绝不把一个元素劈成两半 */
    let p = Math.floor(it.box.y / pageH);
    if (p < 0) p = 0;
    if (p >= n) p = n - 1;
    const spans = (it.box.y + it.box.h) > (p + 1) * pageH + 1;
    pages[p].items.push(Object.assign({}, it, { spansPage: spans }));
  }
  return pages.filter((p, i) => p.items.length || i === 0);
}

return { renderInFrame: renderInFrame, measure: measure, paginate: paginate,
         classifyTable: classifyTable, toHex: toHex, firstFont: firstFont, PX_PT: PX_PT };
})();
