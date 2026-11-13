'use strict';

/* ============================================================
 *  engine.js — 消息引擎（三个阅读窗口共享）
 *
 *  调度模型（重写，修掉旧版「重复推进 / 内容乱跳」）：
 *    · 只有一个定时器 engine.timer，入口永远是 step()
 *    · 渲染中的打字机用 engine.busy 占位，打完才排下一条
 *      —— 旧版 wbRender 在 setTimeout 里自己调 renderNext()，
 *         会和外层定时器各推一次，是「完全没法使用」的主因
 *    · pause 不硬清打字定时器，而是让下一 tick 把这句话补完再停，
 *          避免 busy 永远为真导致卡死
 *
 *  用户从输入框发的消息走 userQueue，优先于自动播放出队。
 * ============================================================ */

const Api = {
  async getBook(id) {
    const r = await window.novelApi.getBook(id);
    return r && r.ok ? r.book : null;
  },
  async saveProgress(bookId, chapter, msg) {
    return window.novelApi.saveProgress(bookId, chapter, msg);
  },
  async getState() {
    const r = await window.novelApi.state();
    return r && r.state ? r.state : { paused: true, speed: 5, chapter: 0, msg: 0 };
  },
};

const escapeHtml = (s) => (s || '').replace(/[&<>"']/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const $ = (s) => document.querySelector(s);

const engine = {
  view: 'feishu',
  book: null,
  bookId: null,
  chapterIdx: 0,
  msgIdx: 0,
  paused: true,
  speed: 5,
  queue: [],        // 当前片段自动播放队列
  userQueue: [],    // 输入框手工发的消息（优先）
  timer: null,
  typeTimer: null,
  busy: false,
  scrollEl: null,
  streamEl: null,
  fakeClock: Date.now() - 60_000,
  lastPeerIdx: -1,
  cxThinkingEl: null,
  MAX_NODES: 500,
  // 滚动跟随：用户在底部附近 → 新内容自动滚到底；用户往上翻了 → 停在原地不打扰
  followBottom: true,
  // 键盘交互状态
  lastArrowDown: 0,
  lastArrowUp: 0,
  DOUBLE_PRESS_MS: 1000,
  // 划线批注
  notes: [],
  pendingQuote: null,
  typeState: null,
  undoStack: [],     // 最近操作（划线/批注），Ctrl+Z 撤销
};

window.engine = engine;

/* ============== Codex 阅读设置（设置面板持久化于 localStorage） ==============
 * { theme:'dark'|'light', output:'stream'|'instant', style:'ai'|'plain', speed:1-10 }
 * style：输出排版风格 —— ai = AI 回答伪装排版（编号列表/加粗/文件引用），plain = 原文
 * 设置 UI 在 sidebar-codex.js；这里惰性读取，改动即时生效无需重启 */
const CX_DEF_SETTINGS = { theme: 'dark', output: 'stream', style: 'ai', speed: 5 };
function cxSettings() {
  try { return Object.assign({}, CX_DEF_SETTINGS, JSON.parse(localStorage.getItem('cxSettings') || '{}')); }
  catch (_) { return Object.assign({}, CX_DEF_SETTINGS); }
}
(function cxApplyStartupSpeed() {
  const st = cxSettings();
  if (st.speed >= 1 && st.speed <= 10) engine.speed = st.speed;
})();

/* ============== 通用工具 ============== */
function fmtTime(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return h + ':' + m;
}
function advanceClock(ms) { engine.fakeClock += ms; return new Date(engine.fakeClock); }

function mkEl(cls, html) {
  const d = document.createElement('div');
  d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
}

/* ============== 节奏模型（按人的阅读速度） ==============
 * 速度档位 1-10 映射为阅读速率（字/秒）：中文舒适阅读约 5-7 字/秒，
 * 默认 5 档 = 6 字/秒（≈360 字/分钟）。每条消息的停留 ≈ 字数 / 速率，
 * 短消息给最低停留，另加小间隙模拟「正在输入 / 模型思考」。
 * WorkBuddy / Codex 正文用 4× 速率打字机流式输出（可跟读），打完再补
 * 剩余阅读停留 —— 总节奏等于阅读速度，同时保留 AI 流式的手感。 */
const READING_CPS = [2, 3, 4, 5, 6, 8, 11, 15, 22, 30];

function readingCps() {
  const base = READING_CPS[engine.speed - 1] || 6;
  const k = engine.view === 'codex' ? 1.15 : engine.view === 'workbuddy' ? 0.95 : 1.0;
  return base * k;
}
/* 打字机流式速率（AI 手感，4× 阅读速率，封顶 60 字/秒防闪现） */
function typeCps() { return Math.min(60, Math.round(readingCps() * 4)); }
/* 一条消息读完正文所需停留（ms），短消息保底 800ms；
 * 命令卡/压缩条这类工作痕迹停 350ms 就够（模拟「唰地跑完」） */
function dwellFor(m) {
  const n = (m && m.text ? m.text : '').length;
  const min = (m && (m.kind === 'cx-cmd' || m.kind === 'cx-compacted' || m.kind === 'wb-tool')) ? 350 : 800;
  return Math.max(min, Math.round((n / readingCps()) * 1000));
}
/* 消息之间的小间隙（正在输入 / 思考） */
function gapAfter() {
  const base = { feishu: 1000, workbuddy: 800, codex: 600 }[engine.view] || 800;
  return Math.round(base * (0.7 + Math.random() * 0.6));
}
/* 这条消息是否走流式打字机（打字过程计入阅读时间）；
 * 设置面板选「直接展示」时 Codex 正文不再打字机 */
function isStreamed(m) {
  if (engine.view === 'codex' && cxSettings().output === 'instant') return false;
  return (engine.view === 'codex' && m.kind === 'cx-agent') ||
         (engine.view === 'workbuddy' && m.kind === 'wb-agent');
}
/* 渲染完一条后，距离下一条的总等待 */
function paceAfter(m) {
  // 直接展示模式：不模拟生成节奏，匀速轻推
  if (engine.view === 'codex' && cxSettings().output === 'instant') return 420;
  return (isStreamed(m) ? Math.max(300, Math.round(dwellFor(m) * 0.75)) : dwellFor(m)) + gapAfter();
}

/* ============== 打字机 ==============
 * render（可选）：每拍用富文本渲染器重绘（AI 伪装排版流式时**不会露出星号**） */
function typeInto(el, text, cps, done, render) {
  const total = text.length;
  if (!total) { done(); return; }
  // 每 40ms 一批，速度档位越高每批越多
  const per = Math.max(1, Math.round(cps * 0.04));
  let i = 0;
  const paint = (s) => { if (render) el.innerHTML = render(s); else el.textContent = s; };
  engine.typeState = { el, text, done, render };   // 供 cancelTyping(true) 立即补完
  const tick = () => {
    if (engine.paused) {                 // 暂停：把这句补完再停，避免卡在半句
      paint(text);
      engine.typeTimer = null;
      engine.typeState = null;
      done();
      return;
    }
    i = Math.min(total, i + per);
    paint(text.slice(0, i));
    scrollBottom();
    if (i >= total) { engine.typeTimer = null; engine.typeState = null; done(); return; }
    engine.typeTimer = setTimeout(tick, 40);
  };
  tick();
}
function cancelTyping(finish) {
  if (engine.typeTimer) { clearTimeout(engine.typeTimer); engine.typeTimer = null; }
  if (finish && engine.typeState) {
    // 立即补完当前句（双击展开全章用）：不丢内容，正常走完回调
    const st = engine.typeState;
    engine.typeState = null;
    if (st.el) { if (st.render) st.el.innerHTML = st.render(st.text); else st.el.textContent = st.text; }
    if (st.done) st.done();
  } else {
    engine.typeState = null;
  }
}

/* ============== 视图绑定 / 滚动 ============== */
function bindViewEls() {
  const v = engine.view;
  engine.scrollEl = v === 'codex' ? $('#cx-scroll') : v === 'workbuddy' ? $('#wb-scroll') : $('#fs-scroll');
  engine.streamEl = v === 'codex' ? $('#cx-stream') : v === 'workbuddy' ? $('#wb-stream') : $('#fs-stream');

  // 监听用户滚动：是否处于底部附近（±80px）决定 followBottom
  if (engine.scrollEl) {
    engine.scrollEl.addEventListener('scroll', () => {
      const el = engine.scrollEl;
      engine.followBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
    }, { passive: true });
  }

  bindMouseNav();
  bindTitleEdit();
  ensureFont();
  // 划线/批注功能已移除（buildDrawer / ann-toggle / bindSelectionTools 不再启用）
}

/* 用户当前是否在底部附近 */
function isNearBottom() {
  const el = engine.scrollEl;
  if (!el) return true;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
}

/* ============== 鼠标 / 滚轮交互 ==============
 *  · 鼠标左/右键点击翻节已取消 → 改为键盘 ← → 连续翻节
 *  · 双击左键正文区 → 立即展示当前章节全部内容
 *  · 滚到底继续下滚滚轮 → 追加下一段，与 ↓ 键完全一致（700ms 节流）
 *  · 拖选文本 → 浮出按钮条（划线 / 批注 / 复制）
 *  · 点击已有划线 → 浮出「取消划线」；Ctrl+Z 撤销上一步
 * ============================================================ */
const TITLE_SEL = {
  workbuddy: '#wb-h-title',
  codex: '#cx-title, .cx-banner .t1',
  feishu: '#fs-group-name',
};

function nextSegment() {
  if (window.cxBossActive || window.cxFakeTaskActive) return;      // 伪装对话中：不切章
  if (!engine.book) return;
  const n = engine.chapterIdx + 1;
  if (n < engine.book.chapters.length) loadSegment(n, true);
  else finishBook();
}
function prevSegment() {
  if (window.cxBossActive || window.cxFakeTaskActive) return;
  if (!engine.book) return;
  const p = engine.chapterIdx - 1;
  if (p >= 0) loadSegment(p, true);
}
window.nextSegment = nextSegment;
window.prevSegment = prevSegment;

/* 双击：立即展开当前章节所有剩余内容（暂停自动播放，读完 ↓/滚轮 继续） */
function revealChapterAll() {
  if (window.cxBossActive || window.cxFakeTaskActive || window.cxNCOpen) return;   // 伪装对话 / 新任务视图 / 新聊天空态：绝不输出小说内容
  if (!engine.book) return;
  cancelTyping(true);
  clearTimeout(engine.timer); engine.timer = null;
  engine.paused = true;
  engine.busy = false;
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  engine.revealAll = true;
  while (engine.msgIdx < engine.queue.length) {
    renderMessage(engine.queue[engine.msgIdx], () => {});
    engine.msgIdx += 1;
  }
  engine.revealAll = false;
  engine.typeState = null;
  afterRender();
  saveProgress();
  applyHighlights();
  if (engine.view === 'feishu') fsAddNotice('—— 本章已全部展开，按 ↓ 或滚轮继续 ——');
  else {
    const tip = mkEl(engine.view === 'workbuddy' ? 'wb-status' : 'cx-note', '');
    tip.innerHTML = engine.view === 'workbuddy'
      ? '<span class="wb-badge ok"><i class="dot"></i>本章已全部展开 · 按 ↓ / 滚轮继续</span>'
      : '── 本章已全部展开 · 按 ↓ / 滚轮继续 ──';
    engine.streamEl.appendChild(tip); afterRender();
  }
}
window.revealChapterAll = revealChapterAll;

function bindMouseNav() {
  const el = engine.scrollEl;
  if (!el) return;

  // 双击左键 = 展开当前章节全部内容（在划线上双击不触发；伪装视图/新聊天中不触发）
  el.addEventListener('dblclick', (e) => {
    if (window.cxBossActive || window.cxFakeTaskActive || window.cxNCOpen) return;
    if (e.target.closest && e.target.closest('.hl-mark, .ann-card, .ann-pop, .kbd-toast')) return;
    e.preventDefault();
    revealChapterAll();
  });

  // 滚轮到底继续下滚 = 追加新内容（与 ↓ 键一致，700ms 节流防连滚狂跳）
  el.addEventListener('wheel', (e) => {
    if (e.deltaY <= 0) return;
    if (!isNearBottom()) return;
    const now = Date.now();
    if (now - (engine.lastWheelAppend || 0) < 700) return;
    engine.lastWheelAppend = now;
    appendOnArrowDown();
  }, { passive: true });
}

/* ============== 划线 / 批注 ==============
 *  · 拖选文本松开 → 浮出按钮条：点「划线」落标记并持久化；点「批注」写备注并入流
 *  · 点击已有标记 → 浮出「取消划线 / 删除批注 / 引用回复」
 *  · Ctrl+Z 撤销最近一次划线或批注
 *  · 点击批注卡片 / 标注面板条目 → 输入框预填引用，回复以聊天消息展示
 *  · 章节渲染时按 quote 文本匹配回放划线
 * ============================================================ */
function displayTitle() { return engine.book ? (engine.book.display_title || engine.book.title) : ''; }
window.displayTitle = displayTitle;

function inEditableTarget(t) {
  return t && t.closest && t.closest('input,textarea,button,a,select,[contenteditable="true"],.ann-pop,.ann-drawer');
}

function bindSelectionTools(el) {
  el.addEventListener('mouseup', (e) => {
    // 弹层内点击不处理
    if (e.target.closest && e.target.closest('.ann-pop, .sel-pop, .hl-pop')) return;
    const cx = e.clientX, cy = e.clientY;
    // 延迟判定：双击（词选区）先到则由 dblclick 取消，避免误弹
    clearTimeout(engine._selTimer);
    engine._selTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const quote = sel.toString().trim();
      if (!quote || quote.length < 2) return;
      const range = sel.getRangeAt(0);
      if (inEditableTarget(range.startContainer) || inEditableTarget(range.endContainer)) return;
      openSelPop({ clientX: cx, clientY: cy }, quote, range.cloneRange());
    }, 200);
  });

  // 右键拖选时屏蔽默认菜单（仅当有选区）
  el.addEventListener('contextmenu', (e) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) e.preventDefault();
  });

  // 单击已有划线 / 批注标记 → 浮出「取消划线 / 删除批注」按钮
  el.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.sel-pop, .hl-pop, .ann-pop')) return;
    const mark = e.target.closest && e.target.closest('.hl-mark');
    if (mark && mark.dataset && mark.dataset.nid) { openHlPop(mark, mark.dataset.nid); return; }
    closePops();
  });
}

/* ---------- 浮动按钮条 ---------- */
function placePop(pop, x, y, w, h) {
  const left = Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8));
  let top = y + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 22);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function closePops() {
  document.querySelectorAll('.sel-pop, .hl-pop').forEach((n) => n.remove());
}

/* 选中文本后弹出：划线 / 批注 / 复制 */
function openSelPop(pos, quote, range) {
  closePops();
  closeNotePop();
  const pop = mkEl('sel-pop');
  pop.innerHTML = `
    <button class="sp-btn" data-act="hl"><b>🖍</b>划线</button>
    <button class="sp-btn" data-act="note"><b>📌</b>批注</button>
    <button class="sp-btn" data-act="copy"><b>⧉</b>复制</button>`;
  document.body.appendChild(pop);
  placePop(pop, pos.clientX, pos.clientY, 236, 42);
  // 按下时不让选区消失
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  pop.addEventListener('click', async (e) => {
    const btn = e.target.closest('.sp-btn');
    if (!btn) return;
    const act = btn.dataset.act;
    const sel = window.getSelection();
    const liveRange = (sel && sel.rangeCount && !sel.isCollapsed) ? sel.getRangeAt(0) : (range || null);
    if (act === 'hl') {
      closePops();
      if (liveRange) await createHighlight(liveRange, quote);
    } else if (act === 'note') {
      closePops();
      if (liveRange) openNotePop(quote, liveRange.cloneRange(), pos);
    } else {
      closePops();
      try { await navigator.clipboard.writeText(quote); flashTip('已复制'); }
      catch (_) { flashTip('复制失败'); }
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    }
  });
}

/* 点击已有标记 → 取消划线 / 删除批注 / 引用回复 */
function openHlPop(mark, nid) {
  closePops();
  closeNotePop();
  const rec = (engine.notes || []).find((n) => n.id === nid);
  const isNote = rec && rec.type === 'note';
  const pop = mkEl('hl-pop');
  pop.innerHTML = `
    <button class="sp-btn danger" data-act="del">${isNote ? '🗑 删除批注' : '✕ 取消划线'}</button>
    <button class="sp-btn" data-act="reply">💬 引用回复</button>`;
  document.body.appendChild(pop);
  const r = mark.getBoundingClientRect();
  placePop(pop, r.left + r.width / 2, r.bottom, isNote ? 210 : 200, 42);
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  pop.addEventListener('click', async (e) => {
    const btn = e.target.closest('.sp-btn');
    if (!btn) return;
    if (btn.dataset.act === 'del') { closePops(); await removeMark(nid); }
    else { closePops(); if (rec) prefillReply(rec); }
  });
}

/* 划线 / 批注：先写记录拿到 id，再包 DOM 标记并记 data-nid，便于点击取消与 Ctrl+Z 撤销 */
async function createHighlight(range, quote, opts) {
  const o = opts || {};
  const rec = await saveNote({ type: o.type || 'hl', chapter: engine.chapterIdx, quote, note: o.note || '' });
  if (!rec) return null;
  const span = document.createElement('span');
  span.className = 'hl-mark' + (rec.type === 'note' ? ' is-note' : '');
  span.dataset.nid = rec.id;
  try { range.surroundContents(span); }
  catch (_) {
    try { span.appendChild(range.extractContents()); range.insertNode(span); }
    catch (__) { /* 跨节点选区兜底失败：仅记录不标记 */ }
  }
  const s = window.getSelection();
  if (s && s.removeAllRanges) s.removeAllRanges();
  pushUndo(rec);
  if (!o.silent) flashTip(rec.type === 'note' ? '批注已保存' : '已划线 · 点标记可取消，Ctrl+Z 撤销');
  return rec;
}

/* 移除划线/批注：解包 DOM + 删记录 + 移除批注卡片 */
async function removeMark(nid) {
  const scope = engine.streamEl || document;
  scope.querySelectorAll('.hl-mark[data-nid="' + nid + '"]').forEach(unwrapMark);
  const card = scope.querySelector('.ann-card[data-id="' + nid + '"]');
  if (card) card.remove();
  if (window.novelApi && engine.bookId) {
    try { await window.novelApi.removeNote(engine.bookId, nid); } catch (_) {}
  }
  engine.notes = (engine.notes || []).filter((n) => n.id !== nid);
  engine.undoStack = (engine.undoStack || []).filter((a) => a.id !== nid);
  flashTip('已撤销上一步');
  const d = document.getElementById('ann-drawer');
  if (d && !d.classList.contains('hidden')) renderDrawerList();
}

function unwrapMark(span) {
  const parent = span.parentNode;
  if (!parent) return;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  parent.removeChild(span);
  if (parent.normalize) parent.normalize();
}

/* 撤销栈：只记划线 / 批注 */
function pushUndo(rec) {
  if (!rec) return;
  engine.undoStack = engine.undoStack || [];
  engine.undoStack.push({ id: rec.id, type: rec.type, quote: rec.quote, chapter: rec.chapter });
  if (engine.undoStack.length > 50) engine.undoStack.shift();
}

async function undoLast() {
  const st = engine.undoStack || [];
  if (!st.length) { flashTip('没有可撤销的划线/批注'); return; }
  const act = st[st.length - 1];
  await removeMark(act.id);
}
window.undoLast = undoLast;
window.removeMark = removeMark;

function openNotePop(quote, range, pos) {
  closeNotePop();
  const pop = mkEl('ann-pop');
  pop.innerHTML = `
    <div class="ann-pop-quote">「${escapeHtml(quote.slice(0, 80))}${quote.length > 80 ? '…' : ''}」</div>
    <textarea class="ann-pop-input" rows="3" placeholder="写批注…（Enter 保存）"></textarea>
    <div class="ann-pop-btns">
      <button class="ann-pop-save">保存批注</button>
      <button class="ann-pop-cancel">取消</button>
    </div>`;
  document.body.appendChild(pop);
  const x = Math.min(pos.clientX, window.innerWidth - 280);
  const y = Math.min(pos.clientY + 8, window.innerHeight - 190);
  pop.style.left = Math.max(8, x) + 'px';
  pop.style.top = Math.max(8, y) + 'px';
  const ta = pop.querySelector('.ann-pop-input');
  setTimeout(() => ta.focus(), 30);

  const save = async () => {
    const note = ta.value.trim();
    if (!note) { closeNotePop(); return; }
    const sel = window.getSelection();
    const live = (sel && sel.rangeCount && !sel.isCollapsed) ? sel.getRangeAt(0) : (range || null);
    const rec = live
      ? await createHighlight(live, quote, { type: 'note', note, silent: true })
      : await saveNote({ type: 'note', chapter: engine.chapterIdx, quote, note });
    closeNotePop();
    if (rec) {
      // createHighlight 内部已入撤销栈；仅在无选区直接存记录时补一次
      if (!live) pushUndo(rec);
      appendAnnCard(rec);
      flashTip('批注已保存 · Ctrl+Z 可撤销');
    }
  };
  pop.querySelector('.ann-pop-save').addEventListener('click', save);
  pop.querySelector('.ann-pop-cancel').addEventListener('click', closeNotePop);
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') closeNotePop();
    ev.stopPropagation();
  });
}
function closeNotePop() {
  const old = document.querySelector('.ann-pop');
  if (old) old.remove();
}
window.closeNotePop = closeNotePop;

async function saveNote(payload) {
  if (!engine.bookId || !window.novelApi) return null;
  const r = await window.novelApi.addNote(engine.bookId, payload);
  if (r && r.ok) { engine.notes.push(r.note); return r.note; }
  return null;
}

/* 批注卡片入流（聊天内容形态） */
function appendAnnCard(rec) {
  const card = mkEl('ann-card fade-in');
  card.dataset.id = rec.id;
  card.innerHTML = `
    <div class="ann-card-head">📌 批注 · 第 ${rec.chapter + 1} ${engine.book && engine.book.encoding === 'epub' ? '章' : '段'}</div>
    <div class="ann-card-quote">「${escapeHtml(rec.quote.slice(0, 60))}${rec.quote.length > 60 ? '…' : ''}」</div>
    <div class="ann-card-note">${escapeHtml(rec.note || '')}</div>
    <div class="ann-card-hint">点击回复 · 发送后显示为聊天消息</div>`;
  card.addEventListener('click', (e) => {
    if (e.target.closest('.ann-del')) return;
    prefillReply(rec);
  });
  engine.streamEl.appendChild(card); afterRender();
}

/* 点击批注 → 输入框预填引用，发送后以聊天消息展示 */
function prefillReply(rec) {
  engine.pendingQuote = rec.quote;
  const input = inputElFor();
  if (!input) return;
  const quoted = `回复批注 「${rec.quote.slice(0, 30)}${rec.quote.length > 30 ? '…' : ''}」：`;
  if (input.value !== undefined) input.value = quoted;
  else input.textContent = quoted;
  input.focus();
  // 光标落到末尾
  if (document.createRange && input.textContent !== undefined) {
    const r = document.createRange();
    r.selectNodeContents(input); r.collapse(false);
    const s = window.getSelection(); if (s) { s.removeAllRanges(); s.addRange(r); }
  }
  flashTip('已引用划线，输入回复后 Enter 发送');
}
function inputElFor() {
  return engine.view === 'feishu' ? $('#fs-input') : engine.view === 'workbuddy' ? $('#wb-input') : $('#cx-input');
}

/* 发送时若有 pendingQuote，拼成带引用的聊天消息（继续功能不受影响） */
function composeUserText(v) {
  if (engine.pendingQuote) {
    const q = engine.pendingQuote;
    engine.pendingQuote = null;
    return `「${q.slice(0, 60)}${q.length > 60 ? '…' : ''}」\n${v}`;
  }
  return v;
}

function flashTip(text) {
  const tip = document.createElement('div');
  tip.className = 'kbd-toast fade-in';
  tip.textContent = text;
  engine.streamEl.appendChild(tip);
  setTimeout(() => { if (tip.parentNode) tip.remove(); }, 1800);
}

/* 章节渲染后按 quote 回放划线 —— 划线/批注功能已移除，保留空实现避免调用点报错 */
function applyHighlights() { return; }

/* ============== 标注面板（查看全部划线/批注） ============== */
function buildDrawer() {
  if (document.getElementById('ann-drawer')) return;
  const d = mkEl('ann-drawer hidden');
  d.id = 'ann-drawer';
  d.innerHTML = `
    <div class="ann-drawer-head">
      <span>划线与批注 <b id="ann-count">0</b></span>
      <button class="ann-drawer-close" title="关闭">✕</button>
    </div>
    <div class="ann-drawer-list"></div>`;
  document.body.appendChild(d);
  d.querySelector('.ann-drawer-close').addEventListener('click', toggleDrawer);
}

function toggleDrawer() {
  const d = document.getElementById('ann-drawer');
  if (!d) return;
  const showing = !d.classList.contains('hidden');
  if (showing) { d.classList.add('hidden'); return; }
  renderDrawerList();
  d.classList.remove('hidden');
}
window.toggleDrawer = toggleDrawer;

function renderDrawerList() {
  const d = document.getElementById('ann-drawer');
  const list = d.querySelector('.ann-drawer-list');
  const notes = engine.notes || [];
  d.querySelector('#ann-count').textContent = notes.length;
  if (!notes.length) {
    list.innerHTML = '<div class="ann-empty">还没有划线或批注。<br>拖选文本 → 点「划线」；点已有划线可取消，Ctrl+Z 撤销。</div>';
    return;
  }
  list.innerHTML = '';
  const unit = engine.book && engine.book.encoding === 'epub' ? '章' : '段';
  for (const n of [...notes].reverse()) {
    const item = mkEl('ann-item' + (n.type === 'note' ? ' is-note' : ''));
    item.innerHTML = `
      <div class="ann-item-head">
        <span class="ann-item-type">${n.type === 'note' ? '📌 批注' : '🖍 划线'}</span>
        <span class="ann-item-loc">第 ${n.chapter + 1} ${unit}</span>
        <button class="ann-del" title="删除">✕</button>
      </div>
      <div class="ann-item-quote">「${escapeHtml(n.quote.slice(0, 80))}${n.quote.length > 80 ? '…' : ''}」</div>
      ${n.note ? `<div class="ann-item-note">${escapeHtml(n.note)}</div>` : ''}`;
    item.querySelector('.ann-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (window.novelApi) await window.novelApi.removeNote(engine.bookId, n.id);
      engine.notes = engine.notes.filter((x) => x.id !== n.id);
      renderDrawerList();
    });
    item.addEventListener('click', () => {
      if (n.type === 'note') prefillReply(n);
      else {
        // 划线条目：预填引用也允许回复
        prefillReply({ quote: n.quote });
      }
      toggleDrawer();
    });
    list.appendChild(item);
  }
}

/* ============== 章节选择器 + 进度展示 ============== */
function updateProgressUI() {
  if (!engine.book) return;
  const total = engine.book.chapters.length;
  const ch = engine.book.chapters[engine.chapterIdx];
  const unit = engine.book.encoding === 'epub' ? '章' : '段';
  const pct = total ? Math.round(((engine.chapterIdx + 1) / total) * 100) : 0;
  const s = $('#wb-h-sub');
  if (engine.view === 'workbuddy' && s)
    s.textContent = `第 ${engine.chapterIdx + 1}/${total} ${unit} · ${pct}% · ${ch ? ch.title : ''}`;
  const cs = $('#cx-progress');
  if (cs) cs.textContent = `${engine.chapterIdx + 1}/${total} · ${pct}%`;
  const fs = $('#fs-progress');
  if (fs) fs.textContent = `第 ${engine.chapterIdx + 1}/${total} ${unit} · ${pct}%`;
  // 章节选择器
  const sel = $('#chsel');
  if (sel && sel.dataset.for === String(engine.bookId)) {
    sel.value = String(engine.chapterIdx);
  }
}

function buildChapterSelect() {
  if (!engine.book) return;
  let sel = $('#chsel');
  if (!sel) {
    sel = document.createElement('select');
    sel.id = 'chsel';
    const host = document.querySelector('#chsel-host');
    if (!host) return;
    host.appendChild(sel);
  }
  sel.dataset.for = String(engine.bookId);
  sel.innerHTML = '';
  const unit = engine.book.encoding === 'epub' ? '章' : '段';
  engine.book.chapters.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    const t = c.title ? c.title.slice(0, 18) : `第 ${i + 1} ${unit}`;
    opt.textContent = `${i + 1}. ${t}`;
    sel.appendChild(opt);
  });
  sel.value = String(engine.chapterIdx);
  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.value, 10);
      if (!isNaN(idx)) loadSegment(idx, true);
    });
  }
}

function loadNotes() {
  engine.notes = [];
  if (engine.bookId && window.novelApi && window.novelApi.listNotes) {
    window.novelApi.listNotes(engine.bookId).then((r) => {
      if (r && r.ok) engine.notes = r.notes || [];
    }).catch(() => {});
  }
}

/* ============== 顶栏标题编辑 ==============
 * 双击标题进入编辑，Enter/失焦提交，Esc 还原。
 * workbuddy / codex 改书名（持久化 + 广播所有窗口），feishu 改群名（localStorage）。
 * ============================================================ */
function titleElFor() { return document.querySelector(TITLE_SEL[engine.view]); }

function restoreTitleEl(el) {
  el.contentEditable = 'false';
  if (engine.view === 'feishu') el.textContent = localStorage.getItem('fs-group-name') || '摸鱼茶水间';
  else if (engine.view === 'codex') el.textContent = window.cxSessionName || '需求分析';
  else if (engine.book) el.textContent = displayTitle();
}

async function commitTitle(t) {
  if (engine.view === 'feishu') {
    localStorage.setItem('fs-group-name', t);
    return;
  }
  // 只改阅读器顶栏显示名，不动小说本身的书名
  if (!engine.bookId || !window.novelApi) return;
  const r = await window.novelApi.rename(engine.bookId, t);
  if (r && r.ok) engine.book.display_title = r.display_title;
}

function bindTitleEdit() {
  document.addEventListener('dblclick', (e) => {
    const el = e.target.closest(TITLE_SEL[engine.view]);
    if (!el || el.isContentEditable) return;
    e.preventDefault();
    el.contentEditable = 'true';
    el.focus();
    const sel = window.getSelection();
    if (sel) { const r = document.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r); }
  });

  const finishEdit = async (el, submit) => {
    if (!el || !el.isContentEditable) return;
    el.contentEditable = 'false';
    const t = el.textContent.trim();
    if (submit && t) await commitTitle(t);
    else restoreTitleEl(el);
  };

  // 点击标题外 → 收起并提交
  document.addEventListener('mousedown', (e) => {
    const el = titleElFor();
    if (el && el.isContentEditable && !el.contains(e.target)) finishEdit(el, true);
  });
  document.addEventListener('keydown', (e) => {
    const el = titleElFor();
    if (!el || !el.isContentEditable) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      finishEdit(el, true);
    } else if (e.key === 'Escape') {
      finishEdit(el, false);
    }
  });
  // 失焦兜底（点击浏览器其它区域等）
  document.addEventListener('focusout', (e) => {
    const el = e.target.closest ? e.target.closest(TITLE_SEL[engine.view]) : null;
    if (el && el.isContentEditable && !el.contains(e.relatedTarget)) finishEdit(el, true);
  });
}

/* 字体自检：微软雅黑缺失时提示（CSS 栈自动回退，不做网络下载——版权字体不可分发） */
function ensureFont() {
  try {
    if (document.fonts && !document.fonts.check('15px "Microsoft YaHei"', '微')) {
      console.warn('[font] 系统未安装 Microsoft YaHei，已回退到系统字体栈');
      document.body.classList.add('no-yahei');
    }
  } catch (_) {}
}

/* 智能滚动：只有用户本来就在底部时才跟随到底；往上翻了就停住不打扰视图 */
function scrollBottom(force) {
  if (!engine.scrollEl) return;
  if (!force && !engine.followBottom) return;
  requestAnimationFrame(() => {
    engine.scrollEl.scrollTop = engine.scrollEl.scrollHeight;
    // 直接置 true 会覆盖用户紧接着的上翻操作；由 scroll 事件自行回算
  });
}
function trimStream() {
  if (!engine.streamEl) return;
  while (engine.streamEl.children.length > engine.MAX_NODES) {
    engine.streamEl.removeChild(engine.streamEl.firstChild);
  }
}
function afterRender() { trimStream(); scrollBottom(); }

/* ============== 飞书渲染（保持不变） ============== */
// 注意：FS_USERS 已在先加载的 chunker.js 里声明。
// 两个 <script> 共享全局作用域，const 重复声明会直接抛错导致本文件整体失效
// —— 这就是旧版「窗口完全没法使用」的第二个根因。这里只引用不再声明。

function fsAddTime() {
  const d = advanceClock(15_000 + Math.random() * 30_000);
  const div = mkEl('fs-time', fmtTime(d));
  engine.streamEl.appendChild(div); afterRender();
}
function fsAddNotice(text) {
  const div = mkEl('fs-sys', escapeHtml(text));
  engine.streamEl.appendChild(div); afterRender();
}
function fsAddMemberJoin() {
  const div = mkEl('fs-sys', '阿虚 加入了群聊');
  engine.streamEl.appendChild(div); afterRender();
}
function fsRender(m) {
  if (engine.lastPeerIdx !== -1 && Date.now() - engine.fakeClock > 90_000) {
    fsAddTime(); engine.fakeClock = Date.now();
  }
  const isNewGroup = m.whoIdx !== engine.lastPeerIdx;
  engine.lastPeerIdx = m.whoIdx ?? -1;

  const u = FS_USERS[m.whoIdx || 0];
  const div = mkEl('fs-msg fade-in');

  if (m.kind === 'reaction') {
    div.style.cssText = 'padding-left:44px;margin-top:2px;margin-bottom:8px';
    div.innerHTML = `<div class="reaction">${u.name} ${escapeHtml(m.text)}</div>`;
  } else if (m.kind === 'self-text') {
    div.classList.add('self');
    div.innerHTML = `<div class="body"><div class="bubble">${escapeHtml(m.text)}</div></div>
      <div class="ava" style="background:#5476ff">我</div>`;
  } else {
    div.innerHTML = `
      <div class="ava" style="background:${u.color}">${u.initial}</div>
      <div class="body">
        ${isNewGroup ? `<div class="name">${u.name} <span class="role">机器人</span></div>` : ''}
        <div class="bubble">${escapeHtml(m.text)}</div>
      </div>`;
  }
  engine.streamEl.appendChild(div); afterRender();
}

/* ============== WorkBuddy 渲染 ============== */
function wbUpdateHeader() {
  const t = $('#wb-h-title'), s = $('#wb-h-sub');
  if (!engine.book) return;
  if (t) t.textContent = displayTitle();
  updateProgressUI();
}
// wbSessionHead 已按需求移除：首页中间不再输出标题/字数提示文案

/* 富格式：标题行（第X章/序章/楔子/番外/「一、」/「1.」等）加粗放大，其余保持原样 */
const RICH_HEAD_RE = /^\s*(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回卷篇集部][^\n]{0,40}|序章[^\n]{0,24}|楔子[^\n]{0,24}|番外[^\n]{0,24}|尾声[^\n]{0,24}|后记[^\n]{0,24}|[一二三四五六七八九十]+\s*、[^\n]{1,30}|\d{1,3}\s*[、.][^\n]{1,30})\s*$/;
/* Codex 风格富文本：**加粗** / `行内代码`，配合 chunker 的伪装排版 */
function cxRich(text) {
  return String(text || '').split('\n').map((line) => {
    if (!line.trim()) return '';
    let esc = escapeHtml(line);
    esc = esc.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    esc = esc.replace(/`([^`]+)`/g, '<code class="cx-code">$1</code>');
    return esc;
  }).join('\n');
}

function fmtRich(text) {
  return String(text || '').split('\n').map((line) => {
    if (!line.trim()) return '';
    const esc = escapeHtml(line);
    if (RICH_HEAD_RE.test(line)) return '<b class="wb-rich-h">' + esc + '</b>';
    return esc;
  }).join('\n');
}

function wbRender(m, done) {
  const s = engine.streamEl;
  if (m.kind === 'wb-user') {
    const div = mkEl('wb-user fade-in', `<div class="who">你</div><div class="bubble">${escapeHtml(m.text)}</div>`);
    s.appendChild(div); afterRender(); done();
    return;
  }
  if (m.kind === 'wb-tool') {
    const div = mkEl('wb-tool fade-in');
    div.innerHTML = `
      <div class="wb-tool-head">
        <span class="wb-tool-icon">🔧</span>
        <span class="wb-tool-name">${escapeHtml(m.name || 'tool')}</span>
        <span class="wb-tool-detail">${escapeHtml(m.detail || '')}</span>
        <span class="wb-tool-status"><i class="wb-spin"></i><span class="t">运行中</span></span>
      </div>
      <div class="wb-tool-body">${escapeHtml(m.text || '')}</div>`;
    s.appendChild(div); afterRender();
    // 一会儿翻成已完成，纯装饰，不阻塞调度
    setTimeout(() => {
      div.classList.add('ok');
      const t = div.querySelector('.wb-tool-status .t');
      if (t) t.textContent = '已完成';
    }, 900);
    done();
    return;
  }
  if (m.kind === 'wb-status') {
    const div = mkEl('wb-status fade-in', `<span class="wb-badge ${m.tone === 'ok' ? 'ok' : ''}"><i class="dot"></i>${escapeHtml(m.text)}</span>`);
    s.appendChild(div); afterRender(); done();
    return;
  }
  // wb-agent：操作行只在最新一条助手消息下显示；打完后换富格式
  const prevCards = s.querySelectorAll('.wb-card.has-actions');
  prevCards.forEach((c) => c.classList.remove('has-actions'));
  const div = mkEl('wb-agent fade-in');
  const secs = 40 + Math.floor(Math.random() * 400);
  const durTxt = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
  div.innerHTML = `
    <div class="wb-avatar">⚙</div>
    <div class="wb-agent-col">
      <div class="who"><b>阿枢</b><span class="wb-who-status">已处理 ${durTxt}</span></div>
      <div class="wb-card"></div>
    </div>`;
  const body = div.querySelector('.wb-card');
  s.appendChild(div); afterRender();
  typeInto(body, m.text, typeCps(), () => {
    body.innerHTML = fmtRich(m.text);
    body.classList.add('has-actions');
    done();
  });
}

/* ============== Codex 渲染 ============== */
function cxClearThinking() {
  if (engine.cxThinkingEl && engine.cxThinkingEl.parentNode) engine.cxThinkingEl.remove();
  engine.cxThinkingEl = null;
}
/* Codex 顶栏标题 = 侧栏当前选中会话（sidebar-codex.js 维护，默认「需求分析」，不跟书名走） */
function cxBanner() {
  if (window.cxNCOpen) return;   // 新聊天界面打开时顶栏显示「新聊天」，别覆盖
  const t = window.cxSessionName || '需求分析';
  const tt = document.getElementById('cx-title');
  if (tt && !tt.isContentEditable) tt.textContent = t;
}
function cxSetContext(pct) {
  const el = $('#cx-context');
  if (el) el.textContent = `context ${Math.min(96, pct).toFixed(1)}% · ${(pct * 0.7).toFixed(1)}k tokens`;
}
function cxRender(m, done) {
  const s = engine.streamEl;
  if (m.kind === 'cx-user') {
    cxClearThinking();
    s.appendChild(mkEl('cx-user fade-in',
      `<span class="cx-prompt-mark">›</span><span class="cx-user-text">${escapeHtml(m.text)}</span>`));
    afterRender(); done(); return;
  }
  if (m.kind === 'cx-thinking') {
    const div = mkEl('cx-thinking', '<i class="cx-spin"></i> 思考中…');
    s.appendChild(div); afterRender();
    engine.cxThinkingEl = div; done(); return;
  }
  if (m.kind === 'cx-cmd') {
    cxClearThinking();
    const div = mkEl('cx-cmdrun fade-in');
    div.innerHTML =
      `<button class="cx-cmdrun-head" type="button" title="展开/收起">` +
        `<span class="cx-cmdrun-chev">⌄</span><span class="cx-cmdrun-label">运行了命令</span>` +
        `<span class="cx-cmdrun-name">${escapeHtml(m.cmd)}</span>` +
      `</button>` +
      `<div class="cx-cmdrun-body"><pre class="cx-cmdrun-out">${escapeHtml(m.out || '')}</pre></div>`;
    div.querySelector('.cx-cmdrun-head').addEventListener('click', () => div.classList.toggle('open'));
    s.appendChild(div); afterRender(); done(); return;
  }
  if (m.kind === 'cx-compacted') {
    cxClearThinking();
    s.appendChild(mkEl('cx-compacted fade-in', '上下文已自动压缩'));
    afterRender(); done(); return;
  }
  if (m.kind === 'cx-note') {
    const mt = /context\s+([\d.]+)%/.exec(m.text || '');
    if (mt) cxSetContext(parseFloat(mt[1]));
    s.appendChild(mkEl('cx-note fade-in', escapeHtml(m.text)));
    afterRender(); done(); return;
  }
  // cx-agent
  cxClearThinking();
  const div = mkEl('cx-agent fade-in');
  div.innerHTML = `<div class="cx-agent-tag">▌ codex</div><div class="cx-agent-body"></div>`;
  const body = div.querySelector('.cx-agent-body');
  s.appendChild(div); afterRender();
  // 「直接展示」：整段一次性呈现（含伪装富文本排版），不走打字机
  if (cxSettings().output === 'instant') { body.innerHTML = cxRich(m.text); afterRender(); done(); return; }
  typeInto(body, m.text, typeCps(), () => { body.innerHTML = cxRich(m.text); done(); }, cxRich);
}

/* ============== 派发 ============== */
function renderMessage(m, done) {
  if (engine.view === 'feishu') { fsRender(m); done(); }
  else if (engine.view === 'workbuddy') wbRender(m, done);
  else cxRender(m, done);
}

/* ============== 调度 ============== */
function schedule(ms) {
  clearTimeout(engine.timer);
  engine.timer = setTimeout(step, Math.max(30, ms || 0));
}

function step() {
  if (window.cxBossActive || window.cxFakeTaskActive) return;      // 伪装对话中：主循环不向流里写任何小说内容
  if (engine.busy || !engine.book) return;
  // drainUser：暂停态下仅排空用户消息（批注回复），排完继续暂停
  if (engine.paused && !engine.drainUser) return;

  // 1) 手工输入优先（指令回复本身短，用正常节奏）
  if (engine.userQueue.length) {
    const m = engine.userQueue.shift();
    engine.busy = true;
    renderMessage(m, () => { engine.busy = false; schedule(gapAfter()); });
    return;
  }

  // 2) 当前片段播完 → 下一段
  if (engine.msgIdx >= engine.queue.length) {
    if (engine.drainUser) { engine.drainUser = false; pause(); return; }
    gotoNextSegment();
    return;
  }

  // 3) 正常出队：停留时间 = 这条消息的字数 ÷ 阅读速率
  const m = engine.queue[engine.msgIdx];
  engine.msgIdx += 1;
  engine.busy = true;
  renderMessage(m, () => {
    engine.busy = false;
    saveProgress();
    applyHighlights();
    schedule(paceAfter(m));
  });
}

function gotoNextSegment() {
  if (!engine.book) return;
  const next = engine.chapterIdx + 1;
  if (next < engine.book.chapters.length) {
    /* 一个章节 = 一次完整对话：章末暂停，提示手动进入下一章（自动续读已移除） */
    pause();
    cxClearThinking();
    const NOTE = '── 本章已读完 · 按 → / k 或滚轮进入下一章 ──';
    const last = engine.streamEl.lastElementChild;
    if (!(last && last.classList.contains('cx-note') && last.textContent === NOTE)) {
      engine.streamEl.appendChild(mkEl('cx-note fade-in', NOTE));
    }
    afterRender();
  } else {
    finishBook();
  }
}

function finishBook() {
  if (engine.view === 'feishu') fsAddNotice('—— 全文读完 ——');
  else if (engine.view === 'workbuddy') {
    engine.streamEl.appendChild(mkEl('wb-status fade-in',
      '<span class="wb-badge ok"><i class="dot"></i>已读完最后一章</span>'));
    afterRender();
  } else {
    cxClearThinking();
    engine.streamEl.appendChild(mkEl('cx-note fade-in', '已完成 · 已到文件末尾'));
    afterRender();
  }
  pause();
}

/* ============== 片段加载 ============== */
function loadSegment(ci, reset) {
  if (!engine.book) return;
  if (ci < 0 || ci >= engine.book.chapters.length) { finishBook(); return; }
  cancelTyping();
  clearTimeout(engine.timer);
  engine.chapterIdx = ci;

  const chunker = (window.Chunkers || {})[engine.view];
  engine.queue = chunker ? chunker(engine.book, ci) : [];
  engine.msgIdx = 0;

  // 诊断：渲染进程实际拿到的首段内容（区分「解析层乱」还是「渲染层乱」）
  try {
    const ch = engine.book.chapters[ci] || {};
    const fp = (ch.paras && ch.paras[0]) || '';
    if (window.novelApi && window.novelApi.log)
      window.novelApi.log(`[reader:${engine.view}] 段「${ch.title || ''}」首段=${fp.slice(0, 60)}`);
  } catch (_) {}

  if (reset) {
    engine.streamEl.innerHTML = '';
    engine.lastPeerIdx = -1;
    engine.cxThinkingEl = null;
    engine.fakeClock = Date.now() - 60_000;
    // 翻章视图归零（流式随后自动跟随底部；直接展示模式在 renderAll 完成后再置顶一次）
    if (engine.scrollEl) engine.scrollEl.scrollTop = 0;
    if (engine.view === 'feishu') {
      fsAddMemberJoin();
      fsAddNotice(`—— 开始连载《${displayTitle()}》· ${engine.book.chapters[ci].title} ——`);
    } else if (engine.view === 'workbuddy') {
      wbUpdateHeader();   // 首页中间提示文案已移除，仅同步顶栏标题
    } else {
      cxBanner();
    }
  }
  // 「直接展示」= 整章瞬显：本章全部内容一次性渲染完毕，不再逐块蹦出（根治闪烁）
  if (engine.view === 'codex' && cxSettings().output === 'instant') {
    engine.msgIdx = engine.queue.length;   // 标记本章已出队，主循环只负责后续翻章
    const msgs = engine.queue.slice();
    let ri = 0;
    (function renderAll() {
      if (ri >= msgs.length) {
        afterRender();
        // 整章瞬显：定位到章节开头而不是末尾
        engine.followBottom = false;
        requestAnimationFrame(() => { if (engine.scrollEl) engine.scrollEl.scrollTop = 0; });
        return;
      }
      renderMessage(msgs[ri++], renderAll);
    })();
  }

  engine.busy = false;
  saveProgress();
  updateProgressUI();
  buildChapterSelect();
  schedule(500);
}
window.loadChapter = loadSegment;   // 兼容旧调用

/* ============== 进度 ============== */
function saveProgress() {
  if (!engine.book) return;
  try { Api.saveProgress(engine.book.id, engine.chapterIdx, engine.msgIdx); } catch (_) {}
}

/* ============== 控制 API ============== */
function start() {
  if (!engine.book) return;
  engine.paused = false;
  if (!engine.queue.length) loadSegment(engine.chapterIdx, true);
  else schedule(120);
}
function pause() {
  engine.paused = true;
  clearTimeout(engine.timer); engine.timer = null;
  // 不硬清 typeTimer：让打字机下一 tick 把这句话补完并收尾
}
function resume() { if (engine.book) { engine.paused = false; schedule(120); } }
function skip() {
  if (!engine.book) return;
  if (engine.chapterIdx + 1 < engine.book.chapters.length) loadSegment(engine.chapterIdx + 1, true);
  else finishBook();
}
function restart() {
  if (!engine.book) return;
  engine.paused = false;
  loadSegment(0, true);
}
function setSpeed(n) { engine.speed = Math.max(1, Math.min(10, parseInt(n, 10) || 5)); }
function switchBook(b) { loadBook(typeof b === 'string' ? b : b.id); }
// keyboard toast 样式挂在皮肤 CSS（.kbd-toast）

async function loadBook(id) {
  engine.book = await Api.getBook(id);
  engine.bookId = id;
  if (!engine.book) return;
  cancelTyping();
  engine.userQueue = [];
  engine.pendingQuote = null;
  loadNotes();
  const p = engine.book.progress || {};
  engine.chapterIdx = p.chapter || 0;   // 默认从保存进度开始读
  loadSegment(engine.chapterIdx, true);
}

/* ============== 用户输入的智能回复 ============== */
function localSentences(t) {
  const fn = window.splitSentences;
  if (typeof fn === 'function') return fn(t);
  return t.match(/[^。！？!?…\n]+[。！？!?…]?/g) || [t];
}
function replyFor(v) {
  const t = (v || '').trim();
  const seg = engine.book && engine.book.chapters[engine.chapterIdx];
  const body = seg ? seg.paras.join(' ').replace(/\s+/g, ' ') : '';
  const total = engine.book ? engine.book.chapters.length : 0;

  if (/总结|概括|讲了什么|摘要|大意/.test(t)) {
    const s = localSentences(body).filter((x) => x.trim().length > 6).slice(0, 3);
    return s.length ? '这一段主要讲了：\n· ' + s.join('\n· ') : '这一段还没读出内容，先往下走一段我再总结。';
  }
  if (/进度|多长|多少字|还剩|第几/.test(t)) {
    const chars = (engine.book && engine.book.char_count) || 0;
    return `当前第 ${engine.chapterIdx + 1} / ${total} 段，全文约 ${chars.toLocaleString()} 字。`;
  }
  if (/慢|暂停|停一下|等下/.test(t)) return '好，我放慢一档。想继续直接说「继续」。';
  if (/快|加速/.test(t)) return '收到，提速。';
  if (/你是谁|什么模型|谁/.test(t)) return '我是本机的阅读助手，只负责把 txt 按你要的节奏推给你，不联网。';
  if (/[?？]$/.test(t)) return '这个问题超出我能回答的范围了 —— 我只读你导入的文件。要我继续往下推吗？';
  return '收到，我接着往下推。需要慢一点、跳段或者总结，直接说。';
}

/* 向本视图发一条用户消息，并让助手回一句 */
function sendUser(text) {
  const isReply = !!engine.pendingQuote;          // 批注回复：发送后不自动续播
  const v = composeUserText((text || '').trim()).trim();
  if (!v) return;
  const cmd = v.toLowerCase();

  if (/^(继续|继续读|go|more|next|n)$/i.test(v)) { resume(); return; }
  if (/^(暂停|pause|stop|p)$/i.test(v)) { pause(); return; }
  if (/^(跳段|下一段|下一章|skip)$/i.test(v)) { skip(); return; }

  const gm = /^(总结|概括|摘要|进度)$/.test(v) || /[?？。]$/.test(v) || v.length > 4;
  if (engine.view === 'feishu') {
    engine.userQueue.push({ kind: 'self-text', text: v });
    if (gm) engine.userQueue.push({ kind: 'peer', whoIdx: 0, text: replyFor(v) });
  } else if (engine.view === 'workbuddy') {
    engine.userQueue.push({ kind: 'wb-user', text: v });
    engine.userQueue.push({ kind: 'wb-tool', name: 'Think', detail: '解析指令', text: v.length + ' 字指令' });
    engine.userQueue.push({ kind: 'wb-agent', text: replyFor(v) });
    engine.userQueue.push({ kind: 'wb-status', text: '已完成', tone: 'ok' });
  } else {
    engine.userQueue.push({ kind: 'cx-user', text: v });
    engine.userQueue.push({ kind: 'cx-thinking', text: '' });
    const needle = v.replace(/["`'$\\]/g, '').slice(0, 14) || 'keyword';
    engine.userQueue.push({ kind: 'cx-cmd', cmd: `rg -n "${needle}" ~/work`, out: `${1 + Math.floor(Math.random() * 3)} 处匹配` });
    engine.userQueue.push({ kind: 'cx-agent', text: replyFor(v) });
    const ctx = window.cxCtxNow ? window.cxCtxNow() : 14 + Math.random() * 6;
    engine.userQueue.push({ kind: 'cx-note', text: `已用 ${Math.max(24, v.length * 2)} tokens · context ${ctx.toFixed(1)}%` });
  }
  if (isReply) {
    // 批注回复只展示聊天内容，不自动续播 —— 用户用 ↓ / 滚轮 继续
    if (engine.paused) { engine.drainUser = true; schedule(150); return; }
    schedule(150);
    return;
  }
  engine.paused = false;
  schedule(120);
}
window.sendUser = sendUser;

/* ============== 主进程推送 ============== */
function onStateChange(state) {
  if (!state) return;
  if (state.bookId && state.bookId !== engine.bookId) loadBook(state.bookId);
  if (typeof state.paused === 'boolean') {
    engine.paused = state.paused;
    if (!state.paused) schedule(150);
  }
  if (state.speed) engine.speed = state.speed;
}
function onBookChanged(book) { if (book && book.id) loadBook(book.id); }
function onBookRenamed(p) {
  // p = { id, title?, display_title? }：阅读界面只显示伪装名，改名广播按需更新
  if (!engine.book || engine.book.id !== p.id) return;
  if (p.title) engine.book.title = p.title;
  if (p.display_title !== undefined) engine.book.display_title = p.display_title || '';
  // Codex 顶栏固定显示「需求分析」，改名广播不覆盖
  if (engine.view === 'codex') return;
  const el = titleElFor();
  if (el && !el.isContentEditable) el.textContent = displayTitle();
}
function onControl({ cmd, arg }) {
  if (cmd === 'start') start();
  else if (cmd === 'pause') pause();
  else if (cmd === 'resume') resume();
  else if (cmd === 'skip') skip();
  else if (cmd === 'restart') restart();
  else if (cmd === 'speed') setSpeed(arg);
  else if (cmd === 'book') switchBook(arg);
}

window.engine = engine;
window.start = start; window.pause = pause; window.resume = resume;
window.skip = skip; window.restart = restart; window.setSpeed = setSpeed;
window.switchBook = switchBook;
window.onStateChange = onStateChange; window.onBookChanged = onBookChanged;
window.onBookRenamed = onBookRenamed;
window.onControl = onControl;
window.getEngine = () => engine;
window.loadBook = loadBook;
window.loadSegment = loadSegment;
window.isNearBottom = isNearBottom;
window.appendOnArrowDown = appendOnArrowDown;

/* ============== 输入框联动 ============== */
function bindInput(sel, onSend) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const v = (el.value !== undefined ? el.value : el.textContent).trim();
      if (!v) return;
      onSend(v);
      if (el.value !== undefined) el.value = ''; else el.textContent = '';
    }
  });
}
window.bindInput = bindInput;

/* ============== 键盘交互 ==============
 *  · ⬇️：仅当正文已滚动到底部（或加载后即在底部）时，追加输出一段新内容；
 *        未在底部时不触发，避免误操作。
 *  · 1 秒内连按两次 ⬇️：输出速度降一档；连按两次 ⬆️：升一档（持久化）。
 * ============================================================ */
function appendOnArrowDown() {
  if (window.cxBossActive || window.cxFakeTaskActive) return;      // 伪装对话中：绝不触发小说输出
  if (!engine.book) return;
  if (!isNearBottom()) return;          // 不在底部 → 忽略
  if (engine.busy || engine.typeTimer) return;   // 正在打字 → 让它打完

  // 暂停中：先恢复，下一步再判断推进方式
  if (engine.paused) engine.paused = false;

  if (engine.msgIdx >= engine.queue.length) {
    // 本段已播完：⬇️ 直接触发下一段（跳过 4 秒段间等待）
    const next = engine.chapterIdx + 1;
    if (next < engine.book.chapters.length) loadSegment(next, true);
    else finishBook();
    return;
  }
  // 播放中：立即推下一条（清掉节奏等待）
  clearTimeout(engine.timer);
  engine.timer = null;
  schedule(60);
}

function bumpSpeed(delta) {
  const before = engine.speed;
  engine.speed = Math.max(1, Math.min(10, engine.speed + delta));
  if (engine.speed === before) return;
  try { if (window.novelApi) window.novelApi.setState({ speed: engine.speed }); } catch (_) {}
  // 在视图里给一条轻提示（不打断当前节奏）
  const tip = document.createElement('div');
  tip.className = 'kbd-toast fade-in';
  tip.textContent = (delta > 0 ? '▲ 提速至 ' : '▼ 降速至 ') + engine.speed + ' / 10';
  engine.streamEl.appendChild(tip);
  setTimeout(() => { if (tip.parentNode) tip.remove(); }, 1800);
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    // 伪装对话（boss-chat）中：阅读快捷键全部不响应
    if (window.cxBossActive || window.cxFakeTaskActive) return;
    // 输入框 / 正在编辑的标题里不响应（用户在打字）
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

    // Ctrl/⌘ + Z：撤销上一步划线或批注
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undoLast();
      return;
    }

    const now = Date.now();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (now - engine.lastArrowDown < engine.DOUBLE_PRESS_MS) {
        engine.lastArrowDown = 0;          // 计满双击后重置窗口
        bumpSpeed(-1);                     // 双击 ↓：降一档（不追加）
      } else {
        engine.lastArrowDown = now;        // 第一拜只记时，等第二拜判定
        // 单击语义延迟到窗口结束再执行：若 1s 内来了第二拜就是降速，否则追加
        const stamp = now;
        setTimeout(() => {
          if (engine.lastArrowDown === stamp) {
            engine.lastArrowDown = 0;
            appendOnArrowDown();           // 确认是单击 ↓：到底才追加
          }
        }, engine.DOUBLE_PRESS_MS);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (now - engine.lastArrowUp < engine.DOUBLE_PRESS_MS) {
        engine.lastArrowUp = 0;
        bumpSpeed(+1);                     // 双击 ↑：升一档
      } else {
        engine.lastArrowUp = now;
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      nextSegment();                       // 连续按 → 连续翻下一节
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prevSegment();                       // 连续按 → 连续回上一节
    } else if (engine.view === 'codex' && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault();
      prevSegment();                       // j = 上一章
    } else if (engine.view === 'codex' && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      nextSegment();                       // k = 下一章
    }
    /* 空格 / Alt 由下方的全局监听处理（伪装对话视图下也可用） */
  });
}
window.bindKeyboard = bindKeyboard;

/* ---------------- 全局快捷键（所有界面通用） ----------------
 * · 空格 = 新聊天界面     · Alt = 安装插件伪装对话
 * 例外（不响应）：锁定态（假死）、设置面板开着、已处于目标界面
 * 输入框已聚焦时：Alt 仍然生效（不产生字符）；空格只在输入框为空时生效，
 * 有内容时让位给正常打字 —— 避免「光标在输入框里就再也按不出快捷键」
 * 用捕获阶段注册，保证在 boss 对话 / 新任务伪装视图里也能触发 */
document.addEventListener('keydown', (e) => {
  if (document.body.classList.contains('locked')) return;
  const se = document.getElementById('cx-settings');
  if (se && !se.hidden) return;

  /* Alt：安装插件（已在安装插件界面则不重复触发） */
  if (e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
    if (window.cxBossActive) return;
    e.preventDefault();
    if (typeof window.cxShowBossChat === 'function') window.cxShowBossChat();
    return;
  }

  /* 空格：新聊天（新聊天 / 安装插件界面里的空格属于打字，不拦截） */
  if (e.key !== ' ' && e.code !== 'Space') return;
  if (window.cxNCOpen || window.cxBossActive) return;
  const ae = document.activeElement;
  const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
  if (editable) {
    const val = (ae.value != null ? ae.value : ae.textContent) || '';
    if (val.trim()) return;              // 正在写提示词时不抢空格
  }
  e.preventDefault();
  if (typeof window.cxOpenNewChat === 'function') window.cxOpenNewChat();
}, true);

/* 注册主进程推送事件 */
if (window.novelApi) {
  window.novelApi.onControl((payload) => window.onControl(payload));
  window.novelApi.onStateChange((s) => window.onStateChange(s));
  if (window.novelApi.onBookChanged) window.novelApi.onBookChanged((b) => window.onBookChanged(b));
  if (window.novelApi.onBookRenamed) window.novelApi.onBookRenamed((p) => window.onBookRenamed(p));
}
