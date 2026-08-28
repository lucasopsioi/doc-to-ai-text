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
