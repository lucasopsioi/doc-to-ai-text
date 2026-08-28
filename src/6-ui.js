/* ============================================================
   6-ui.js —— 界面接线
   只管 DOM。主流程在 5-emit.js 的 convertBytes 里，与环境无关。
   ============================================================ */

const $ = id => document.getElementById(id);
const drop = $("drop"), fileInput = $("file"), out = $("out"), stat = $("stat");
const yieldToUI = () => new Promise(r => setTimeout(r, 0));

drop.addEventListener("click", () => fileInput.click());
["dragenter", "dragover"].forEach(e => drop.addEventListener(e, ev => {
  ev.preventDefault(); drop.classList.add("hot");
}));
["dragleave", "drop"].forEach(e => drop.addEventListener(e, ev => {
  ev.preventDefault(); drop.classList.remove("hot");
}));
drop.addEventListener("drop", ev => handle(ev.dataTransfer.files));
fileInput.addEventListener("change", () => handle(fileInput.files));

const isPdf  = f => /\.pdf$/i.test(f.name);
const isPptx = f => /\.(pptx|potx)$/i.test(f.name);
const isHtml = f => /\.(mht|mhtml|html?)$/i.test(f.name);
const isImg  = f => /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(f.name);

function currentOpts(){
  return {
    /* 通用 */
    preamble:     $("optPreamble").checked,
    compact:      $("optCompact").checked,
    unit:         $("optUnit").value,
    /* PDF */
    mergePara:    $("optPara").checked,
    columns:      $("optColumn").checked,
    headerFooter: $("optHF").checked,
    shapes:       $("optShape").checked,
    tables:       $("optTable").checked,
    charts:       $("optChart").checked,
    runs:         $("optRuns").checked,
    target:       $("optTarget").value,
    annots:       true,
    /* PPT */
    layouts:      $("optLayouts").checked,
    tableFmt:     $("optCellFmt").checked,
    keepEmpty:    $("optEmptyPh").checked,
    pptCharts:    $("optPptChart").checked,
    /* HTML */
    htmlWidth:    parseInt($("optHtmlWidth").value, 10),
    htmlPage:     $("optHtmlPage").value
  };
}

/* PPTX 引擎的选项名与 PDF 的有重叠（charts 两边含义不同），单独组一份 */
function pptOpts(o){
  return {
    preamble: o.preamble, compact: o.compact, unit: o.unit,
    layouts: o.layouts, tableFmt: o.tableFmt, keepEmpty: o.keepEmpty,
    charts: o.pptCharts
  };
}

/* 最近一次拖进来的文件。高保真重解析要拿它重跑一遍，
   不能让用户再拖一次。 */
let LAST_FILES = [];

async function handle(list){
  const all = Array.from(list);
  const arr = all.filter(f => isPdf(f) || isPptx(f) || isHtml(f));
  /* .htm + _files：把一起拖进来的图片做成资源表，供 cid/相对路径解析 */
  const sideImgs = all.filter(isImg);
  if (!arr.length){
    const oldPpt = all.some(f => /\.ppt$/i.test(f.name));
    stat.innerHTML = '<span class="err">请选择 .pdf / .pptx / .potx / .mht / .htm 文件' +
      (oldPpt ? '<br>旧版 .ppt 不支持，需先在 PowerPoint 里另存为 .pptx。' : '') + '</span>';
    return;
  }
  LAST_FILES = arr;
  const opt = currentOpts();
  out.value = "";
  $("copy").disabled = true; $("save").disabled = true; $("toPptx").disabled = true;
  if (HIFI.ready) $("hifi").disabled = true;

  const chunks = [];
  const t0 = performance.now();
  for (const f of arr){
    try {
      stat.textContent = `读取 ${f.name} …`;
      await yieldToUI();
      const buf = new Uint8Array(await f.arrayBuffer());
      if (isPptx(f)){
        stat.textContent = `解析 ${f.name} …（PPT）`;
        await yieldToUI();
        chunks.push(OOXML.convert(buf, f.name, pptOpts(opt)));
      } else if (isHtml(f)){
        stat.textContent = `渲染并量测 ${f.name} …（HTML 没有坐标，要真排一遍）`;
        await yieldToUI();
        const assets = await buildAssets(sideImgs);
        const r = await HTMLLINE.convertFile(buf, f.name, opt, assets);
        chunks.push(r.text);
      } else {
        const r = await convertBytes(buf, f.name, opt,
          (i, n) => { stat.textContent = `解析 ${f.name} … 第 ${i}/${n} 页`; },
          yieldToUI);
        chunks.push(r.text);
      }
    } catch (e){
      chunks.push(`# ${f.name}\n\n转换失败：${e.message}\n\n` +
                  `如果这份文件能正常打开，请把这条错误连同文件名反馈给开发者。\n${e.stack || ""}`);
      stat.innerHTML = `<span class="err">${f.name} 转换失败：${e.message}</span>`;
    }
  }
  const ms = Math.round(performance.now() - t0);
  out.value = chunks.join("\n\n" + "=".repeat(60) + "\n\n");
  const chars = out.value.length;
  const warnCount = (out.value.match(/⚠️/g) || []).length;
  stat.innerHTML = `<span class="ok">完成</span> · ${arr.length} 个文件 · ${chars.toLocaleString()} 字符 · ` +
    `约 ${Math.round(chars / 2.2).toLocaleString()} tokens · ${ms}ms` +
    (warnCount ? ` · <span class="warn">${warnCount} 处需要注意</span>` : "");
  $("copy").disabled = false; $("save").disabled = false; $("toPptx").disabled = false;
  /* 高保真引擎是 PyMuPDF，只认 PDF；这批全是 PPT 时按钮就不该能点 */
  if (HIFI.ready) $("hifi").disabled = !LAST_FILES.some(isPdf);
}

/* 把一起拖进来的图片读成 data URL，键用文件名 ——
   Outlook 存成 .htm 时图片在 _files 里，HTML 用相对路径引用它们 */
async function buildAssets(files){
  const map = Object.create(null);
  for (const f of files){
    try {
      const url = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(f);
      });
      map[f.name] = url;
    } catch (e){ /* 单张读不了不影响其它 */ }
  }
  return map;
}

/* ============================================================
   高保真重解析
   只有在 exe 里（本地服务提供了 /capabilities）才出现。
   单独双击 HTML 时探测不到，按钮保持隐藏，其余功能完全不受影响。
   ============================================================ */
const HIFI = { ready: false, token: null, dirRoot: null };

(async function probeHiFi(){
  try {
    const token = new URLSearchParams(location.search).get("t");
    if (!token || !/^https?:/.test(location.protocol)) return;
    const r = await fetch(`/capabilities?t=${encodeURIComponent(token)}`, { cache: "no-store" });
    if (!r.ok) return;
    const caps = await r.json();
    if (!caps.highFidelity) return;
    HIFI.ready = true; HIFI.token = token; HIFI.dirRoot = caps.exportDirRoot;
    $("hifi").hidden = false;
    $("hifiOpts").hidden = false;
    $("hifiHint").hidden = false;
  } catch (e){ /* 探测失败就当没有，静默降级 */ }
})();

$("hifi").addEventListener("click", async () => {
  if (!HIFI.ready || !LAST_FILES.length) return;
  const pdfs = LAST_FILES.filter(isPdf);
  if (!pdfs.length){
    stat.innerHTML = '<span class="warn">高保真引擎（PyMuPDF）只处理 PDF，这批文件里没有 PDF</span>';
    return;
  }
  const opt = currentOpts();
  const wantImages = $("optImages").checked;
  $("hifi").disabled = true; $("copy").disabled = true; $("save").disabled = true;

  const chunks = [];
  const t0 = performance.now();
  if (pdfs.length < LAST_FILES.length)
    chunks.push(`> 注：本次只对 ${pdfs.length} 个 PDF 做了高保真重解析；` +
                `PPT 文件不经过这条路（PPTX 本来就是语义格式，纯 JS 引擎已是精确提取）。\n`);
  for (const f of pdfs){
    stat.textContent = `高保真解析 ${f.name} …（大文件可能要几十秒）`;
    await yieldToUI();
    try {
      const qs = new URLSearchParams({
        t: HIFI.token, name: f.name,
        unit: opt.unit, target: opt.target,
        preamble: opt.preamble ? "1" : "0",
        compact: opt.compact ? "1" : "0",
        mergePara: opt.mergePara ? "1" : "0",
        columns: opt.columns ? "1" : "0",
        headerFooter: opt.headerFooter ? "1" : "0",
        tables: opt.tables ? "1" : "0",
        shapes: opt.shapes ? "1" : "0",
        charts: opt.charts ? "1" : "0",
        images: wantImages ? "1" : "0"
      });
      const resp = await fetch(`/highfidelity?${qs}`, { method: "POST", body: f });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      let text = data.text;
      if (data.imageDir){
        text += `\n\n> 【图片已导出】共 ${(data.images || []).length} 张，位于：\n> ${data.imageDir}\n` +
                `> 请把这些图片连同本文本一起提供给 AI，否则 AI 只知道图的位置，不知道内容。\n`;
      }
      chunks.push(text);
    } catch (e){
      chunks.push(`# ${f.name}\n\n高保真解析失败：${e.message}\n\n` +
                  `纯浏览器解析的结果没有被覆盖 —— 重新拖一次文件即可回到那份结果。`);
      stat.innerHTML = `<span class="err">高保真解析失败：${e.message}</span>`;
    }
  }
  const ms = Math.round(performance.now() - t0);
  out.value = chunks.join("\n\n" + "=".repeat(60) + "\n\n");
  const chars = out.value.length;
  const warnCount = (out.value.match(/⚠️/g) || []).length;
  stat.innerHTML = `<span class="ok">高保真解析完成</span> · ${pdfs.length} 个 PDF · ` +
    `${chars.toLocaleString()} 字符 · 约 ${Math.round(chars / 2.2).toLocaleString()} tokens · ${ms}ms` +
    (warnCount ? ` · <span class="warn">${warnCount} 处需要注意</span>` : "");
  $("hifi").disabled = false; $("copy").disabled = false; $("save").disabled = false;
  $("toPptx").disabled = false;
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(out.value);
    stat.innerHTML = '<span class="ok">已复制到剪贴板</span>';
  } catch {
    out.select(); document.execCommand("copy");
    stat.innerHTML = '<span class="ok">已复制</span>';
  }
});
$("save").addEventListener("click", () => {
  const b = new Blob([out.value], { type: "text/markdown;charset=utf-8" });
  download(b, "结构化描述.md");
});

function download(blob, name){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ============================================================
   页签
   ============================================================ */
function showTab(which){
  const a = which === "A";
  $("tabA").classList.toggle("on", a);
  $("tabB").classList.toggle("on", !a);
  $("panelA").hidden = !a;
  $("panelB").hidden = a;
}
$("tabA").addEventListener("click", () => showTab("A"));
$("tabB").addEventListener("click", () => showTab("B"));

/* ============================================================
   ② AI 文本 → PPT
   纯 JS 直接写 .pptx（ZIP 存储模式），不依赖 Python，
   所以单独一份 HTML 也能用这个功能。
   ============================================================ */
function runToPptx(text, srcName){
  const t0 = performance.now();
  let r;
  try {
    r = TOPPTX.convert(text);
  } catch (e){
    $("genStat").innerHTML = `<span class="err">生成失败：${e.message}</span>`;
    $("genReport").innerHTML = "";
    return;
  }
  const m = r.model, s = m.stats;
  const ms = Math.round(performance.now() - t0);
  const base = (srcName || m.title || "生成").replace(/\.(pdf|pptx|potx|md)$/i, "");
  download(new Blob([r.bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }),
           base + ".pptx");

  $("genStat").innerHTML = `<span class="ok">已生成并下载</span> · ${m.slides.length} 页 · ` +
    `${Math.round(r.bytes.length / 1024).toLocaleString()} KB · ${ms}ms`;
  const bits = [];
  bits.push(`画布 <b>${m.w} × ${m.h} ${m.unit}</b>　共 <b>${m.slides.length}</b> 页`);
  bits.push(`文本框 <b>${s.text}</b>　形状 <b>${s.shape}</b>　表格 <b>${s.table}</b>` +
            (s.image ? `　图片占位 <b>${s.image}</b>` : "") +
            (s.chart ? `　疑似图表 <b>${s.chart}</b>` : ""));
  for (const w of m.warnings) bits.push(`<span class="w">⚠️ ${w}</span>`);
  $("genReport").innerHTML = bits.join("<br>");
}

$("genPptx").addEventListener("click", () => {
  const text = $("inText").value.trim();
  if (!text){ $("genStat").innerHTML = '<span class="err">请先粘贴结构化文本</span>'; return; }
  runToPptx(text, null);
});

$("pasteBack").addEventListener("click", () => {
  if (!out.value.trim()){ $("genStat").innerHTML = '<span class="err">①那边还没有结果</span>'; return; }
  $("inText").value = out.value;
  $("genStat").textContent = "已填入①的结果，可以点「生成 .pptx」了";
});

/* ①里的一键直转：转文本 → 立刻转回 PPT，闭环 */
$("toPptx").addEventListener("click", () => {
  if (!out.value.trim()) return;
  $("inText").value = out.value;
  showTab("B");
  runToPptx(out.value, LAST_FILES.length ? LAST_FILES[0].name : null);
});

/* ============================================================
   浏览器端自检： 在地址后加 ?selftest=1
   渲染量测这条路 Node 测不了（没有 DOM），只有真浏览器能验。
   最关键的一条是「渲染全程零外部请求」—— 邮件里的远程图就是追踪像素，
   一旦漏放行，发件人立刻知道收件人读了信。这条必须能反复自动验证，
   不能只靠某次手工检查。
   ============================================================ */
async function browserSelfTest(){
  const res = [];
  const ok = (name, cond, detail) => res.push({ name, pass: !!cond, detail: cond ? "" : (detail || "") });
  try {
    const buf = new Uint8Array(await (await fetch("test/fixtures/outlook.mht")).arrayBuffer());
    const seen = [];
    const po = new PerformanceObserver(l => {
      for (const e of l.getEntries())
        if (/^https?:\/\//i.test(e.name) && !e.name.startsWith(location.origin)) seen.push(e.name);
    });
    po.observe({ entryTypes: ["resource"] });

    const r = await HTMLLINE.convertFile(buf, "outlook.mht",
      { preamble:false, compact:true, unit:"pt", target:"16:9", htmlWidth:900, htmlPage:"slice" }, {});
    await new Promise(s => setTimeout(s, 400));
    po.disconnect();
    const t = r.text;

    ok("★ 渲染全程零外部请求（追踪像素未触发）", seen.length === 0, seen.join(" "));
    ok("gb2312 中文正文", t.includes("本周巴西手机市场"));
    ok("RFC2047 主题解码", /邮件主题: .*拉美竞品周报/.test(t));
    ok("mso-only 内容移除", !t.includes("MSOONLY_"));
    ok("downlevel-revealed 保留", t.includes("KEEPME_"));
    ok("数据表识别且仅一个（版面表未误判）",
       (t.match(/### \[\d+\] 表格/g) || []).length === 1);
    ok("表格内容正确", /"Samsung" \| "4570k" \| "31%"/.test(t));
    ok("图片留出位置", (t.match(/### \[\d+\] 图片/g) || []).length === 3 &&
       /按这个尺寸留出空白占位框/.test(t));
    ok("追踪 ID 未泄漏进文本", !t.includes("uid=12345"));
    ok("无 undefined/NaN", !/undefined|NaN/.test(t));
    const g = TOPPTX.convert(t);
    ok("闭环：HTML 文本能转成 pptx", g.bytes.length > 5000 && g.model.slides.length >= 1,
       g.bytes.length + "B");
  } catch (e){
    ok("自检本身跑通", false, e.message);
  }
  const bad = res.filter(r => !r.pass);
  document.title = (bad.length ? "✗ " + bad.length + " 项失败" : "✓ 全部通过") + " · 浏览器自检";
  const box = document.createElement("pre");
  box.id = "selftest-result";
  box.style.cssText = "position:fixed;inset:0;z-index:9999;background:#111;color:#ddd;" +
                      "font:13px/1.7 Consolas,monospace;padding:24px;overflow:auto;margin:0";
  box.textContent = "浏览器端自检\n" + "=".repeat(52) + "\n" +
    res.map(r => (r.pass ? "  ✓ " : "  ✗ ") + r.name + (r.detail ? "  -> " + r.detail : "")).join("\n") +
    "\n" + "=".repeat(52) + "\n通过 " + (res.length - bad.length) + " · 失败 " + bad.length;
  document.body.appendChild(box);
  window.__selftest = { pass: bad.length === 0, results: res };
  return window.__selftest;
}
if (new URLSearchParams(location.search).get("selftest") === "1")
  window.addEventListener("load", browserSelfTest);
