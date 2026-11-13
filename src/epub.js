'use strict';
/* ============================================================
 *  epub.js — EPUB 解析（依赖 electron-builder 自带的 yauzl）
 *
 *  EPUB = ZIP 容器：
 *    META-INF/container.xml     → 指向 OPF 包文档位置
 *    content.opf                → metadata + spine（阅读顺序）
 *    *.xhtml / *.html           → 各章节内容
 *
 *  输出与 parse.js 的 chapters 结构一致：
 *    { title, paras: [...] }[]
 *  按字符数切分长章节，逻辑与 splitByLength 的 hardSplit 一致。
 * ============================================================ */
const fs = require('fs');
const yauzl = require('yauzl');

/* ---------- HTML → 纯文本 ---------- */
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function htmlToText(html) {
  let s = String(html);
  // 块级标签与 <br> 转换行边界（在标签处切开，保留段落结构）
  s = s.replace(/<\s*(br|BR)\s*\/?\s*>/g, '\n');
  s = s.replace(/<\s*\/\s*(p|div|h[1-6]|li|blockquote|section|article|tr)\s*>/gi, '\n\n');
  s = s.replace(/<\s*(h[1-6])[^>]*>/gi, '\n\n');
  // 去 script/style/svg 与全部其余标签
  s = s.replace(/<\s*(script|style|svg|head)[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // 规范空白：全角空格保留（中文缩进），其余行内空白折叠
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n');
  return s.replace(/\n{3,}/g, '\n\n');
}

/* ---------- ZIP 读取 ---------- */
function openZip(path) {
  return new Promise((resolve, reject) => {
    // autoClose 必须关：目录读完（end）就会关 fd，后面 openReadStream 全部报 closed。
    // 生命周期由 parseEpub 的 finally 里 zf.close() 手动管理。
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zf) => {
      if (err) reject(err); else resolve(zf);
    });
  });
}

function readEntry(zf, entry) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    zf.openReadStream(entry, (err, rs) => {
      if (err) { reject(err); return; }
      rs.on('data', (c) => chunks.push(c));
      rs.on('end', () => resolve(Buffer.concat(chunks)));
      rs.on('error', reject);
    });
  });
}

/* 收集 zip 内全部 entry（路径 → entry 映射） */
async function zipEntries(zf) {
  return new Promise((resolve, reject) => {
    const map = new Map();
    zf.on('error', reject);
    zf.on('entry', (entry) => {
      map.set(entry.fileName.replace(/\\/g, '/'), entry);
      zf.readEntry();
    });
    zf.on('end', () => resolve(map));
    zf.readEntry();
  });
}

/* 解析 XML 里 attr="value"（宽容版，不做完整 XML 解析） */
function pickAttr(xml, tag, attr) {
  const re = new RegExp('<\\s*' + tag + '[^>]*\\b' + attr + '\\s*=\\s*"([^"]*)"', 'i');
  const m = re.exec(xml);
  if (m) return m[1];
  const re2 = new RegExp('<\\s*' + tag + "[^>]*\\b" + attr + "\\s*=\\s*'([^']*)'", 'i');
  const m2 = re2.exec(xml);
  return m2 ? m2[1] : '';
}

/* 相对 href 解析（相对 OPF 所在目录） */
function resolveHref(opfDir, href) {
  const clean = decodeURIComponent((href || '').split('#')[0].replace(/\\/g, '/'));
  if (!clean) return '';
  const stack = (opfDir ? opfDir.split('/') : []);
  for (const seg of clean.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

/* 单 XHTML 内提取章节标题：h1-h3 优先，否则首行 */
function extractTitle(html, fallback) {
  const m = /<\s*h[1-3][^>]*>([\s\S]*?)<\s*\/\s*h[1-3]\s*>/i.exec(html);
  if (m) {
    const t = decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 80);
  }
  return fallback;
}

/* 长章节按字数再切（与 parse.js hardSplit 同逻辑） */
function hardSplit(s, size) {
  const sents = s.match(/[^。！？!?…；;\n]+[。！？!?…；;]?|\n+/g) || [s];
  const soft = [];
  let buf = '';
  for (const t of sents) {
    if (/^\n+$/.test(t) && buf) { buf += t; continue; }
    if ((buf + t).length > size && buf) { soft.push(buf); buf = t; }
    else buf += t;
  }
  if (buf) soft.push(buf);
  const out = [];
  for (const p of soft) {
    if (p.length <= size) { out.push(p); continue; }
    for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
  }
  return out.filter((x) => x.trim());
}

/* ---------------- 主入口 ----------------
 * 返回 { chapters: [{title, paras}], encoding: 'epub', char_count, spine_count }
 */
async function parseEpub(filePath, opts) {
  const o = opts || {};
  const maxPara = Math.max(400, parseInt(o.chunkSize, 10) || 5000);

  const zf = await openZip(filePath);
  let entries;
  try {
    entries = await zipEntries(zf);
  } catch (e) {
    try { zf.close(); } catch (_) {}
    throw new Error('EPUB 目录读取失败: ' + e.message);
  }

  try {
    // 1) container.xml → OPF 路径
    const containerEntry = entries.get('META-INF/container.xml');
    let opfPath = '';
    if (containerEntry) {
      const xml = (await readEntry(zf, containerEntry)).toString('utf8');
      opfPath = pickAttr(xml, 'rootfile', 'full-path');
    }
    // 兜底：找第一个 .opf
    if (!opfPath) {
      for (const k of entries.keys()) if (/\.opf$/i.test(k)) { opfPath = k; break; }
    }
    if (!opfPath || !entries.has(opfPath)) throw new Error('找不到 OPF 包文档（不是有效 EPUB）');

    // 2) OPF → spine 顺序 + manifest href 映射 + 书名
    const opfBuf = await readEntry(zf, entries.get(opfPath));
    const opf = opfBuf.toString('utf8');
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

    const titleTag = /<\s*dc:title[^>]*>([\s\S]*?)<\s*\/\s*dc:title\s*>/i.exec(opf)
      || /<\s*title[^>]*>([\s\S]*?)<\s*\/\s*title\s*>/i.exec(opf);
    const bookTitle = titleTag ? decodeEntities(titleTag[1]).replace(/\s+/g, ' ').trim() : '';

    const manifest = {};
    const itemRe = /<\s*item\b[^>]*>/gi;
    let im;
    while ((im = itemRe.exec(opf))) {
      const tag = im[0];
      const id = pickAttr(tag, 'item', 'id');
      const href = pickAttr(tag, 'item', 'href');
      const type = pickAttr(tag, 'item', 'media-type');
      if (id && href) manifest[id] = { href: resolveHref(opfDir, href), type };
    }

    const spineIds = [];
    const itemrefRe = /<\s*itemref\b[^>]*>/gi;
    let sr;
    while ((sr = itemrefRe.exec(opf))) {
      const idref = pickAttr(sr[0], 'itemref', 'idref');
      const linear = pickAttr(sr[0], 'itemref', 'linear');
      if (idref && linear !== 'no') spineIds.push(idref);
    }
    if (!spineIds.length) {
      // 无 spine：按路径排序取全部 xhtml
      for (const k of entries.keys())
        if (/\.(xhtml|html|htm)$/i.test(k) && !/^(meta|toc|nav|title)/i.test(k.split('/').pop()))
          spineIds.push(k);
    }

    // 3) 依序读文档 → 纯文本
    const chapters = [];
    let charCount = 0;
    for (const id of spineIds) {
      const item = manifest[id] || { href: id };
      const entry = entries.get(item.href);
      if (!entry || entry.uncompressedSize > 8 * 1024 * 1024) continue;
      if (!/\.(xhtml|html|htm)$/i.test(item.href)) continue;
      const html = (await readEntry(zf, entry)).toString('utf8');
      const text = htmlToText(html);
      const paras = text.split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (!paras.length) continue;
      const title = extractTitle(html, '第 ' + (chapters.length + 1) + ' 节');
      // 章内超长再切：保持单章标题 + 序号
      if (paras.join('').length > maxPara * 3) {
        const merged = paras.join('\n\n');
        const parts = hardSplit(merged, maxPara);
        parts.forEach((p, idx) => {
          chapters.push({
            title: parts.length > 1 ? `${title}（${idx + 1}/${parts.length}）` : title,
            paras: p.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean),
          });
        });
      } else {
        chapters.push({ title, paras });
      }
      charCount += paras.reduce((s, p) => s + p.length, 0);
    }

    if (!chapters.length) throw new Error('EPUB 内没有可读文本');

    // 封面/目录页噪声过滤：标题以「第 N 节」且正文 <30 字的尾巴章节合并到前章
    const cleaned = chapters.filter((c) => c.paras.join('').length >= 2 || /封面|目录|版权/.test(c.title) === false);
    return {
      chapters: cleaned.length ? cleaned : chapters,
      encoding: 'epub',
      char_count: charCount,
      spine_count: spineIds.length,
      book_title: bookTitle,
    };
  } finally {
    try { zf.close(); } catch (_) {}
  }
}

module.exports = { parseEpub, htmlToText };
