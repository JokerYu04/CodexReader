'use strict';

/* ============================================================
 *  chunker.js — Codex 阅读器：把一段正文切成「工作会话消息」队列
 *
 *  消息形状：{ kind, ... }
 *    cx-user / cx-thinking / cx-cmd / cx-compacted / cx-agent / cx-note
 *
 *  ⚠ 伪装红线：所有命令卡、输出、提示里严禁出现书名 / 文件名 /
 *    章节标题等阅读痕迹 —— 命令一律指向虚构的工作目录文件。
 * ============================================================ */

const CHAPTER_RE = /^\s*(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷篇集部]\s*.{0,40}|序章.{0,24}|楔子.{0,24}|后记.{0,24}|尾声.{0,24}|番外.{0,24}|Chapter\s+\d+.{0,40})\s*$/i;

function splitSentences(p) {
  const re = /[^。！？!?…\n]+[。！？!?…]?/g;
  return p.match(re) || [p];
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/* 段落序列 → 长度不超过 max 的若干文本块（保留空行分段感） */
function packBlocks(paras, max) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf.trim()) { out.push(buf.trim()); buf = ''; } };
  for (const p of paras) {
    if (p.length > max) {
      flush();
      const sents = splitSentences(p);
      let s = '';
      for (const t of sents) {
        if ((s + t).length > max && s) { out.push(s.trim()); s = t; }
        else s += t;
      }
      if (s.trim()) { buf = s.trim(); }
      continue;
    }
    if ((buf + '\n\n' + p).length > max && buf) { flush(); buf = p; }
    else buf = buf ? buf + '\n\n' + p : p;
  }
  flush();
  return out;
}

/* 片段序号 */
function segNo(book, ci) {
  const m = /(\d+)\s*\/\s*(\d+)/.exec((book.chapters[ci] || {}).title || '');
  if (m) return { cur: +m[1], total: +m[2] };
  return { cur: ci + 1, total: book.chapters.length };
}

/* ---------------- Codex：工作会话回合 ----------------
 * 用户灰气泡（右对齐）→ 思考态 → 「⌄ 运行了命令」内联可折叠卡
 * → ▌ codex 正文（流式 / 直接展示）→「上下文已自动压缩」→ 灰色统计行
 * ------------------------------------------------------------------- */

/* 伪上下文水位：跨段保持。每段上涨，超过 90% 触发自动压缩并回落 */
const CX_CTX = { val: 12.4 };
window.cxCtxNow = () => CX_CTX.val;

/* 用户提示词池：工作场景的「继续输出」类指令 */
const CX_PROMPTS = [
  '继续，从上次断点接着输出',
  '继续，把剩下的部分都贴出来',
  '接着上次的继续，不要总结',
  '继续输出后面的内容',
  '好，继续',
  '继续，保持原文原样输出',
  '从当前进度继续',
  '接着来，后面还有多少就输出多少',
];

/* 章节中途穿插的用户提示词：长短不一（10~几十字）、口吻多样，像真实工作追问 */
const CX_PROMPTS_MORE = [
  '这块逻辑再展开讲讲，把边界情况也覆盖到',
  '好，这部分可以。下一段接着上面继续处理',
  '输出有点断了，从刚才停下的地方继续',
  '嗯，思路清楚了。按这个方向把剩余部分给完',
  '把上面提到的分支逻辑再细化一下，逐条列出来',
  '刚才那段保留，继续往下写，不要重复已有内容',
  '看起来没问题，继续输出剩余部分',
  '先停一下，把前两点再确认一遍再继续',
  'OK，格式就这样，接着输出后面的内容',
  '这段调用链路再补充一下，配合文件位置说明',
  '继续。注意输出节奏，一次别贴太多',
  '理解了。下一部分直接给出，不用再确认',
  '把刚才的结论整理成要点，然后继续',
  '这里的异常路径怎么处理？顺便继续往下',
  '行，就这样，剩下的部分接着来',
  '刚才的编号列表挺好，后面也保持这个格式',
  '先给结论，再展开细节，继续',
  '这块和上一段是同一个流程吗？继续说',
];

/* AI 回答常用的小节标题（穿插在正文块开头，营造结构化排版） */
const CX_HEADS = [
  '第一阶段：现状梳理', '第二阶段：问题定位', '排查思路', '关键点确认',
  '阶段小结', '方案设计', '核心逻辑分析', '边界条件处理',
  '后续计划', '风险与注意事项', '实现细节拆解', '数据流梳理',
  '建议的实际处理顺序', '需要先确认的三件事', '补充说明', '约束与前提',
  '复盘与结论', '待办清单',
];

/* 章末过渡块：像 AI 回答收尾的「下一步」 */
const CX_TAILS = [
  '**接下来**\n\n以上第 1~3 项已逐条确认，剩余部分按同样口径继续输出。有问题随时打断我。',
  '**当前进度**\n\n已完成大部分梳理，剩余内容不属于本阶段范围，建议按上面顺序继续推进。',
  '**小结**\n\n- 结论与前面各节一致，可以直接沿用\n- 存在分歧的点已单独标出，等确认后再动\n- 其余部分保持现有实现不动',
  '**一句话**：主线结论没有变化，关键在前两点，剩下的都属于执行层面的细节。',
];

/* 命令池：贴近日常开发的工具调用 */
const CX_TOPICS = ['报表导出', '工单超时', '经分口径', '接口超时', '配置加载', '缓存失效', '权限校验', '数据对账', '重试风暴', '日志脱敏'];
/* 中性工作文件名：正文源命令一律指向这些虚构文件，绝不出现书名 */
const CX_FILES = [
  'src/core/pipeline.go',
  'src/api/handler.ts',
  'src/sync/index.js',
  'services/worker.py',
  'src/repo/order_dao.java',
  'lib/sched/runner.go',
  'src/utils/serialize.ts',
];
const cxHash = () => Math.random().toString(16).slice(2, 9);
const cxDay = () => '11-' + String(1 + Math.floor(Math.random() * 13)).padStart(2, '0');
/* 每本书固定挑一个虚构文件，段内保持一致（像真的在读同一个源文件） */
function cxWorkFile(book, ci) {
  if (!book._cxFile) {
    book._cxFile = CX_FILES[Math.floor(Math.random() * CX_FILES.length)];
  }
  return book._cxFile;
}

function cxGenCmd(cur, file) {
  const gens = [
    () => ({ cmd: 'git log --oneline -5',
             out: [0, 0, 0, 0, 0].map(() => cxHash() + ' ' + pick(['fix', 'feat', 'refactor', 'chore']) + ': ' + pick(CX_TOPICS)).join('\n') }),
    () => ({ cmd: 'git diff --stat',
             out: ` 3 files changed, ${20 + Math.floor(Math.random() * 60)} insertions(+), ${Math.floor(Math.random() * 18)} deletions(-)` }),
    () => ({ cmd: 'rg -n "TODO" src/',
             out: `src/api/handler.go:88: TODO ${pick(CX_TOPICS)}\nsrc/core/sched.go:31: FIXME ${pick(CX_TOPICS)}` }),
    () => ({ cmd: 'pytest -q tests/',
             out: `................  18 passed in ${(2 + Math.random() * 5).toFixed(2)}s` }),
    () => ({ cmd: 'node scripts/report.js --week 46',
             out: '[ok] 已生成 docs/2026-W46.md' }),
    () => ({ cmd: 'ls -t docs/daily | head -5',
             out: '11-13.md\n11-12.md\n11-11.md\n11-10.md\n11-09.md' }),
    () => ({ cmd: `wc -l ${file}`,
             out: ` ${40 * (cur + 38)} ${file}` }),
    () => ({ cmd: 'npm run build 2>&1 | tail -2',
             out: `✓ ${8 + Math.floor(Math.random() * 20)} modules transformed.\n✓ built in ${(1 + Math.random() * 3).toFixed(1)}s` }),
    () => ({ cmd: 'docker compose ps',
             out: 'NAME   STATUS         PORTS\napi    Up 3 days      0.0.0.0:8080->8080\ndb     Up 3 days      5432/tcp' }),
    () => ({ cmd: `tail -n 5 logs/app-${cxDay()}.log`,
             out: [0, 0, 0, 0, 0].map(() => `INFO  ${cxDay()} ${String(9 + Math.floor(Math.random() * 9)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:12  ${pick(CX_TOPICS)} handled`).join('\n') }),
  ];
  return pick(gens)();
}

/* ---------------- 伪装排版：把小说段落改写成 AI 回答的典型格式 ----------------
 * ① 部分段落句子重组为编号列表   ② 子句级加粗（**xx**）
 * ③ 句尾追加虚构文件引用（`file (line N)`）   ④ 正文块开头加小节标题
 * 文本内容不动，只改观感 —— 阅读连续性优先，装饰密度控制在三成左右。
 * --------------------------------------------------------------------------- */
/* 子句级加粗：取开头子句加 **（列表项引导短语用，像 `1. **总睡眠偏少**：解释`） */
function cxLeadBold(t, maxHead) {
  if (t.startsWith('**') || t.length < 22) return t;
  const cIdx = t.indexOf('，');
  const headLen = (cIdx > 4 && cIdx <= maxHead) ? cIdx : Math.min(10, t.length);
  return '**' + t.slice(0, headLen) + '**' + t.slice(headLen);
}

function cxStylePara(p, file, cur) {
  const allSents = splitSentences(p);

  /* ① 列表优先（基于原始长段落判断）：句子多时整段改成编号/破折号列表，
   *    每项引导短语加粗 —— 这是 AI 回答最典型的样子 */
  if (allSents.length >= 3 && p.length > 90 && Math.random() < .55) {
    const bullet = Math.random() < .3;
    const items = [];
    let i = 0;
    while (i < allSents.length) {
      const take = Math.random() < .5 ? 1 : 2;
      let t = allSents.slice(i, i + take).join('').trim();
      if (t.length > 40 && Math.random() < .25) {
        const line = (cur - 1) * 40 + 3 + Math.floor(Math.random() * 38);
        t = t + `（见 \`${file} (line ${line})\`）`;
      }
      items.push(t);
      i += take;
    }
    return items.map((t, k) => {
      const v = (k === 0 || Math.random() < .5) ? cxLeadBold(t, 14) : t;
      return (bullet ? '- ' : `${k + 1}. `) + v;
    }).join('\n');
  }

  /* ② 长段落按句子拆短（每 1~2 句一段）：AI 回答极少有大段连排，这是「长文本感」主因 */
  let paras = [p];
  if (p.length > 150) {
    const groups = [];
    let gi = 0;
    while (gi < allSents.length) {
      const take = Math.random() < .55 ? 1 : 2;
      groups.push(allSents.slice(gi, gi + take).join(''));
      gi += take;
    }
    paras = groups.map((g) => g.trim()).filter(Boolean);
  }

  let boldBudget = 1;
  let refDone = false;
  return paras.map((pp) => {
    let t = pp;
    if (boldBudget > 0 && t.length > 30 && Math.random() < .55) {
      const cIdx = t.indexOf('，');
      const headLen = (cIdx > 5 && cIdx < 20) ? cIdx : (8 + Math.floor(Math.random() * 6));
      t = '**' + t.slice(0, headLen) + '**' + t.slice(headLen);
      boldBudget--;
    }
    if (!refDone && t.length > 40 && Math.random() < .3) {
      const line = (cur - 1) * 40 + 3 + Math.floor(Math.random() * 38);
      t = t + `（见 \`${file} (line ${line})\`）`;
      refDone = true;
    }
    return t;
  }).join('\n\n');
}

function cxDisguise(block, file, cur) {
  const paras = String(block).split('\n\n').map((p) => cxStylePara(p, file, cur));
  let text = paras.join('\n\n');
  /* 约八成正文块带一个小节标题，像结构化 AI 回答 */
  if (Math.random() < .8) text = '**' + pick(CX_HEADS) + '**\n\n' + text;
  return text;
}

function chunkCodex(book, ci) {
  const ch = book.chapters[ci]; if (!ch) return [];
  const { cur, total } = segNo(book, ci);
  const chars = ch.paras.reduce((s, p) => s + p.length, 0);
  const file = cxWorkFile(book, ci);

  /* 伪上下文水位：每段上涨 5~14%，超过 90% 触发自动压缩并回落到 26~36% */
  CX_CTX.val = Math.min(96, CX_CTX.val + 5 + Math.random() * 9);
  let compacted = false;
  if (CX_CTX.val > 90) { compacted = true; CX_CTX.val = 26 + Math.random() * 10; }

  const out = [];
  out.push({ kind: 'cx-user', text: compacted ? '上下文压缩完成了？接着输出刚才没贴完的部分' : pick(CX_PROMPTS) });
  out.push({ kind: 'cx-thinking', text: '' });
  /* 每段固定一条「读取源文件」的命令卡 —— 指向中性虚构文件，行号随进度推进 */
  out.push({
    kind: 'cx-cmd',
    cmd: `sed -n '${(cur - 1) * 40 + 1},${cur * 40}p' ${file}`,
    out: `${ch.paras.length} 行 · ${chars} 字`,
  });
  if (compacted) out.push({ kind: 'cx-compacted', text: '' });

  /* 正文块之间：每 2~3 块穿插一条用户提示词（长短口吻多样），再随机挂命令卡
   * style='plain'（设置里的「原文」风格）时退回旧版：无伪装排版、无中途提示词 */
  const useAI = !window.cxSettings || window.cxSettings().style !== 'plain';
  /* AI 风格每条消息压到 ~380 字：AI 回答极少有 700 字连排大段，短块+穿插才有对话感 */
  const blocks = packBlocks(ch.paras, useAI ? 380 : 700);
  let extraCmds = blocks.length >= 4 ? 2 : (Math.random() < .5 ? 1 : 0);
  let sinceUser = 0;
  let userEvery = 2 + Math.floor(Math.random() * 2);
  blocks.forEach((b, i) => {
    out.push({ kind: 'cx-agent', text: useAI ? cxDisguise(b, file, cur) : b });
    sinceUser++;
    if (useAI && sinceUser >= userEvery && i < blocks.length - 1) {
      out.push({ kind: 'cx-user', text: pick(CX_PROMPTS_MORE) });
      if (extraCmds > 0 && Math.random() < .5) {
        const c = cxGenCmd(cur, file);
        out.push({ kind: 'cx-cmd', cmd: c.cmd, out: c.out });
        extraCmds--;
      }
      sinceUser = 0;
      userEvery = 2 + Math.floor(Math.random() * 2);
    } else if (!useAI && extraCmds > 0 && i < blocks.length - 1 && Math.random() < .45) {
      const c = cxGenCmd(cur, file);
      out.push({ kind: 'cx-cmd', cmd: c.cmd, out: c.out });
      extraCmds--;
    }
  });

  /* AI 风格：章末 50% 概率补一个「接下来/小结」过渡块，像 AI 回答收尾 */
  if (useAI && Math.random() < .5) out.push({ kind: 'cx-agent', text: pick(CX_TAILS) });

  out.push({ kind: 'cx-note', text: `已用 ${Math.max(120, Math.round(chars * 1.4)).toLocaleString()} tokens · context ${CX_CTX.val.toFixed(1)}%` });
  return out;
}

const Chunkers = { codex: chunkCodex };
window.Chunkers = Chunkers;
window.splitSentences = splitSentences;
window.ChapterPat = CHAPTER_RE;
