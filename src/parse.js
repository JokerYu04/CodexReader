'use strict';
/* ============================================================
 *  parse.js — 通用文本切分（txt / md / log / csv …）
 *
 *  设计原则：不假设内容是小说。
 *    mode = 'length'  （默认）纯按字数切分，任何 txt 都能吃
 *    mode = 'chapter' 小说专属：按「第N章」标题切 + 去广告行
 *    mode = 'auto'    先数章标题，命中 >=3 个走 chapter，否则 length
 *
 *  编码探测顺序：BOM → utf-8(严格) → utf-16 启发 → 宽容 utf-8(阈值)
 *               → gb18030 / big5 → latin1
 * ============================================================ */

function decodeLenient(enc, buf) {
  try { return new TextDecoder(enc).decode(buf); } catch (_) { return null; }
}
function countReplacement(s) {
  let n = 0;
  for (const ch of s) if (ch === '\uFFFD') n++;
  return n;
}

function detectDecode(buf) {
  // 1) BOM 优先
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
    return [new TextDecoder('utf-8').decode(buf.subarray(3)), 'utf-8-sig'];
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE)
    return [new TextDecoder('utf-16le').decode(buf.subarray(2)), 'utf-16le'];
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF)
    return [new TextDecoder('utf-16be').decode(buf.subarray(2)), 'utf-16be'];
  // 2) 严格 UTF-8（全合法即 UTF-8）
  try { return [new TextDecoder('utf-8', { fatal: true }).decode(buf), 'utf-8']; } catch (_) {}
  // 3) 无 BOM UTF-16 启发（头部大量 0x00；阈值 8%）
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  let zeros = 0;
  for (const b of head) if (b === 0) zeros++;
  if (zeros > head.length * 0.08) {
    const u16 = decodeLenient('utf-16le', buf);
    if (u16 && countReplacement(u16) <= Math.max(4, u16.length * 0.005))
      return [u16, 'utf-16le'];
  }
  // 4) 关键：宽容 UTF-8 + 替换字符率（<=3%）
  //    真实 GBK 文件按 UTF-8 解会产生海量 U+FFFD；
  //    "UTF-8 但含零星坏字节"只有少数 U+FFFD。阈值区分两者，
  //    避免整本 UTF-8 被误判成 GB18030 导致全篇乱码。
  const u8 = decodeLenient('utf-8', buf);
  if (u8) {
    const f = countReplacement(u8);
    if (f <= Math.max(3, Math.floor(u8.length * 0.03)))
      return [u8, f ? 'utf-8(含坏字节' + f + ')' : 'utf-8'];
  }
  // 5) GB18030 / Big5：选替换字符更少的
  let best = null;
  for (const enc of ['gb18030', 'big5']) {
    const s = decodeLenient(enc, buf);
    if (!s) continue;
    const f = countReplacement(s);
    if (!best || f < best.f) best = { enc, s, f };
  }
  if (best) return [best.s, best.enc];
  // 6) 兜底
  return [u8 || new TextDecoder('latin1').decode(buf), 'utf-8(降级)'];
}

/* ---------------- 文本规范化 ---------------- */
const BIDI = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
function normalize(text) {
  return text
    .replace(BIDI, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/* ---------------- 小说专属（仅 chapter 模式用） ---------------- */
const CHAPTER_RE = /^\s*(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷篇集部]\s*.{0,40}|序章.{0,24}|楔子.{0,24}|后记.{0,24}|尾声.{0,24}|番外.{0,24}|Chapter\s+\d+.{0,40})\s*$/i;
const AD_RES = [
  /https?:\/\/|www\./i,
  /笔趣|顶点|八一中文|小说下载|手机版阅读|手机阅读|一秒记住|请记住本站|本章免费|首发网址|最快更新/i,
];

function looksLikeNovel(text) {
  const probe = text.slice(0, 120000).split('\n');
  let hits = 0;
  for (const line of probe) {
    const t = line.trim();
    if (t && CHAPTER_RE.test(t)) { hits++; if (hits >= 3) return true; }
  }
  return false;
}

function splitByChapter(text) {
  const chapters = [];
  let curTitle = '正文';
  let curParas = [];
  const flush = () => { if (curParas.length) chapters.push({ title: curTitle, paras: curParas.slice() }); };
  for (const lineRaw of text.split('\n')) {
    const line = lineRaw.trim().replace(/^[\u3000\s]+/, '').replace(/[\u3000\s]+$/, '');
    if (!line) continue;
    if (AD_RES.some((re) => re.test(line))) continue;
    if (CHAPTER_RE.test(line)) { flush(); curTitle = line; curParas = []; }
    else curParas.push(line);
  }
  flush();
  if (!chapters.length) chapters.push({ title: '正文', paras: [] });
  return chapters;
}

/* ---------------- Markdown（md / markdown） ----------------
 *  1) 自动选切章层级：H1 为主（>=2 个且不少于 H2）用 H1，否则 H2，再否则 H3
 *  2) 清洗语法：front-matter / 图片 / 链接 / 粗斜体 / 引用 / 表格 / HTML / 分隔线
 *  3) 代码块默认保留原文（技术文档场景要读代码）
 * --------------------------------------------------------- */
function stripFrontMatter(text) {
  const m = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

function headingStats(text) {
  const c = { 1: 0, 2: 0, 3: 0 };
  for (const line of text.split('\n')) {
    const m = /^(#{1,3})[ \t]+(\S.*)$/.exec(line);
    if (m) c[m[1].length]++;
  }
  return c;
}
/* 返回 1/2/3 = 用该级标题切章；0 = 无可用标题（回退按长度切） */
function pickHeadingLevel(text) {
  const c = headingStats(text);
  if (c[1] >= 2 && c[1] >= c[2]) return 1;   // 只有 1 个 H1 通常是文档大标题，不算章节
  if (c[2] >= 2) return 2;
  if (c[3] >= 2) return 3;
  if (c[1] === 1) return 1;
  if (c[2] === 1) return 2;
  if (c[3] === 1) return 3;
  return 0;
}

function cleanMarkdown(text) {
  let s = stripFrontMatter(text);
  // 代码块：去掉围栏，保留代码原文（含缩进）
  s = s.replace(/^[ \t]*```[^\n]*\n?([\s\S]*?)^[ \t]*```[ \t]*$/gm, (_m, code) => code.replace(/\s+$/, ''));
  s = s.replace(/^[ \t]*~~~[^\n]*\n?([\s\S]*?)^[ \t]*~~~[ \t]*$/gm, (_m, code) => code.replace(/\s+$/, ''));
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片 → 保留 alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 链接 → 保留文字（无文字则保留地址）
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, t, u) => (String(t).trim() || String(u).trim()));
  // 引用块去符号
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  // 加粗 / 斜体 / 删除线
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2').replace(/(^|[^_\w])_([^_\n]+)_/g, '$1$2');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  // 脚注标记
  s = s.replace(/\[\^[^\]]*\]/g, '');
  // 表格分隔行 |---|:---:| 与主题分隔线 --- ***
  s = s.replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, '');
  s = s.replace(/^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '');
  // 表格行：竖线分列 → 中文顿点分隔
  s = s.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row) =>
    row.split('|').map((c) => c.trim()).filter(Boolean).join(' · '));
  // 任务列表 / 无序列表
  s = s.replace(/^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]*/gm, '$1· ');
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1· ');
  // HTML 标签
  s = s.replace(/<[^>]+>/g, '');
  return s;
}

function splitByMarkdown(text, size) {
  const level = pickHeadingLevel(text);
  const clean = cleanMarkdown(text);
  if (!level) return fromChunks(splitByLength(clean, size));

  const chapters = [];
  let curTitle = '开头';
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    chapters.push({ title: curTitle, paras: cur.slice() });
  };
  for (const raw of clean.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(#{1,6})[ \t]+(\S.*)$/.exec(raw);
    if (m && m[1].length <= level) { flush(); curTitle = m[2]; cur = []; continue; }
    if (m) { cur.push(m[2]); continue; }            // 更深层级：只留文字，不切章
    for (const p of (line.length > size ? hardSplit(line, size) : [line])) cur.push(p);
  }
  flush();
  if (!chapters.length) return fromChunks(splitByLength(clean, size));
  return chapters;
}

/* ---------------- 通用按长度切分 ---------------- */
// 单块超长时：先按句读/换行软切，仍超长再硬切
function hardSplit(s, size) {
  const sents = s.match(/[^。！？!?…；;\n]+[。！？!?…；;]?|\n+/g) || [s];
  const soft = [];
  let buf = '';
  for (const t of sents) {
    // 纯换行不单独成段，并入上一句，避免切出空片段
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
  return out;
}

function splitByLength(text, size) {
  // 空行 = 自然边界；单换行保留在同一块内
  const blocks = text.split(/\n[ \t]*\n/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let buf = [];
  let len = 0;
  const flush = () => { if (buf.length) { chunks.push(buf.join('\n\n')); buf = []; len = 0; } };
  for (const b of blocks) {
    if (b.length > size) {
      flush();
      const parts = hardSplit(b, size);
      for (let i = 0; i < parts.length - 1; i++) chunks.push(parts[i]);
      buf = [parts[parts.length - 1]];
      len = buf[0].length;
      continue;
    }
    if (len && len + b.length > size) flush();
    buf.push(b);
    len += b.length + 2;
  }
  flush();
  return chunks.filter((c) => c.trim());
}

/* ---------------- 入口 ---------------- */
function parseText(raw, opts) {
  const o = opts || {};
  const size = Math.max(120, parseInt(o.chunkSize, 10) || 5000);
  const [text, enc] = detectDecode(raw);
  const clean = normalize(text);

  const mdExt = ['md', 'markdown', 'mdown', 'mkd'].includes(String(o.ext || '').toLowerCase());
  let mode = o.mode || 'length';
  if (mode === 'auto') {
    // md 优先按标题切；否则小说特征命中走章节，都不满足按长度
    if (mdExt) mode = 'markdown';
    else mode = looksLikeNovel(clean) ? 'chapter' : 'length';
  }

  let chapters;
  if (mode === 'markdown') {
    chapters = splitByMarkdown(clean, size);
  } else if (mode === 'chapter') {
    chapters = splitByChapter(clean);
    if (chapters.length <= 1) chapters = fromChunks(splitByLength(clean, size));
  } else {
    chapters = fromChunks(splitByLength(clean, size));
  }

  if (!chapters.length) chapters = [{ title: '空文档', paras: ['（这个文件没有可读内容）'] }];
  const para_count = chapters.reduce((s, c) => s + (c.paras ? c.paras.length : 0), 0);
  return { encoding: enc, chapters, para_count, char_count: clean.length, split_mode: mode };
}

function fromChunks(chunks) {
  const n = chunks.length;
  return chunks.map((c, i) => ({
    title: `片段 ${i + 1}/${n}`,
    paras: c.split('\n').map((x) => x.replace(/\s+$/, '')).filter(Boolean),
  }));
}

module.exports = {
  parseText, parseNovel: parseText, detectDecode, splitByLength,
  splitByMarkdown, cleanMarkdown, pickHeadingLevel, stripFrontMatter,
};
