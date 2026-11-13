/* ============================================================
 *  fake-task.js —— 「新聊天发送 → 新任务」伪装视图
 *
 *  · 新聊天输入框发消息 → 在侧栏对应项目下新建任务（名称取自
 *    消息前缀），主区切到该任务视图
 *  · 任务视图绝不输出真实内容，只演「Codex 在干活但没答完」：
 *    用户消息气泡 + 「已处理 N秒 / M分S秒」计时 + 状态行轮换
 *    （正在思考 / 正在分析请求 / 正在调用工具 …）
 *  · 「正在重新连接 N/5」：计数在整个对话内持久递增（1/5→5/5），
 *    5/5 之后不再出现；WiFi 图标只在重新连接 / 报错时显示
 *  · 每个对话总时长随机 5~20 分钟，到点后像真 Codex 一样直接报错
 *    （红色错误行）并停止轮换
 *  · 点侧栏「开始阅读」→ 摘下的阅读流原样放回，进度不受影响
 *  · 点侧栏对应任务条目 → 重新进入该任务的伪装视图
 *  · 任务视图里继续发消息 → 只追加气泡并继续演戏，不触碰阅读流
 * ============================================================ */
(function () {
  'use strict';

  const TASKS = {};        // 任务名 -> { frag, elapsed, reconnect, totalSec, ended }
  let cur = null;          // 当前激活的任务名
  let readingFrag = null;  // 首次进入时摘下的阅读流
  let prevPaused = false;
  let elapsedTimer = null;
  let phaseTimer = null;
  let elapsed = 0;

  /* 当前视图里最新一轮的计时元素 / 状态元素（直接持引用，避免选择器失效） */
  let curElapsed = null;
  let curStatusTxt = null;
  let curStatusRow = null;
  let curStatusIco = null;

  const WIFI_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 6.6C5.6 3.3 10.4 3.3 14 6.6"/><path d="M4.2 9C6.5 7 9.5 7 11.8 9"/><path d="M6.4 11.3c1-.9 2.2-.9 3.2 0"/><circle cx="8" cy="13" r=".9" fill="currentColor" stroke="none"/></svg>';

  /* 状态轮换剧本：普通阶段（无图标）+ 低概率「重新连接」（带 WiFi 图标） */
  const PHASES = [
    '正在思考',
    '正在分析请求',
    '正在调用工具',
    '正在检索上下文',
    '正在规划执行步骤',
    '正在核对上下文',
  ];

  const ERR_TEXT = '连接中断：重试多次后仍无法完成请求，请检查网络后重试';

  function randTotalSec() { return 300 + Math.floor(Math.random() * 900); }   // 5 ~ 20 分钟

  /* 计时文案：<60 秒显示秒，超过 1 分钟显示「X分Y秒」 */
  function fmtDur(s) {
    if (s < 60) return '已处理 ' + s + '秒';
    const m = Math.floor(s / 60), r = s % 60;
    return '已处理 ' + m + '分' + (r ? (r + '秒') : '');
  }

  function el(cls, html) {
    const d = document.createElement('div');
    d.className = cls;
    if (html !== undefined) d.innerHTML = html;
    return d;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* 从容器中取「最后一轮」的计时 / 状态元素并绑定引用 */
  function bindRefsFromRoot(root) {
    if (!root) return;
    const es = root.querySelectorAll('.cx-ft-elapsed');
    curElapsed = es.length ? es[es.length - 1] : null;
    const sts = root.querySelectorAll('.cx-ft-status');
    if (sts.length) {
      curStatusRow = sts[sts.length - 1];
      curStatusTxt = curStatusRow.querySelector('.cx-ft-text');
      curStatusIco = curStatusRow.querySelector('.cx-ft-ico');
    } else {
      curStatusRow = curStatusTxt = curStatusIco = null;
    }
  }

  /* ---------------- 计时与状态轮换 ---------------- */
  function stopTimers() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    if (phaseTimer) { clearTimeout(phaseTimer); phaseTimer = null; }
  }

  function schedulePhase() {
    if (!cur || !curStatusTxt) return;
    const t = TASKS[cur];
    if (!t || t.ended) return;

    /* 「正在重新连接 N/5」：计数持久递增，5/5 之后不再出现（最终以报错收尾） */
    let phase, reconnect = false;
    if (t.reconnect < 5 && Math.random() < 0.08) {
      t.reconnect += 1;
      phase = '正在重新连接 ' + t.reconnect + '/5';
      reconnect = true;
    } else {
      phase = PHASES[Math.floor(Math.random() * PHASES.length)];
    }
    curStatusTxt.textContent = phase;
    if (curStatusIco) curStatusIco.style.display = reconnect ? '' : 'none';

    const wait = 6000 + Math.random() * 8000;   // 6 ~ 14 秒，节奏放慢
    phaseTimer = setTimeout(schedulePhase, wait);
  }

  /* 对话到点：像真 Codex 一样直接报错并停止轮换 */
  function endTask() {
    const t = TASKS[cur];
    if (!t) return;
    t.ended = true;
    stopTimers();
    if (curStatusRow) curStatusRow.classList.add('err');
    if (curStatusTxt) curStatusTxt.textContent = ERR_TEXT;
    if (curStatusIco) curStatusIco.style.display = '';   // 报错行带 WiFi 图标
  }

  function startActors() {
    const t = TASKS[cur];
    if (!t || t.ended) return;
    if (!t.totalSec) t.totalSec = randTotalSec();
    stopTimers();
    elapsedTimer = setInterval(() => {
      if (window.cxLockActive) return;   // 假死时状态也不动，更像真的卡住
      if (!cur || !curElapsed) return;
      const tt = TASKS[cur];
      if (!tt || tt.ended) return;
      elapsed++;
      curElapsed.textContent = fmtDur(elapsed);
      if (elapsed >= (tt.totalSec || 600)) endTask();   // 5 ~ 20 分钟到点报错收尾
    }, 1000);
    phaseTimer = setTimeout(schedulePhase, 1800);
  }

  /* ---------------- 视图构建 ---------------- */
  function makeTurnFrag(userText) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('cx-user fade-in', `<span class="cx-user-text">${esc(userText)}</span>`));
    frag.appendChild(el('cx-ft-elapsed fade-in', '已处理 0秒'));
    const st = el('cx-ft-status fade-in',
      `<span class="cx-ft-ico">${WIFI_SVG}</span><span class="cx-ft-text">正在思考</span>`);
    st.querySelector('.cx-ft-ico').style.display = 'none';   // WiFi 图标只在重新连接 / 报错时出现
    frag.appendChild(st);
    return frag;
  }

  function appendTurn(userText) {
    const s = document.getElementById('cx-stream');
    if (!s || !cur) return;
    s.appendChild(makeTurnFrag(userText));
    bindRefsFromRoot(s);
    const t = TASKS[cur];
    /* 报错后再发消息：开启新一轮 5~20 分钟的「处理」（重连计数保留） */
    if (t) { t.ended = false; t.totalSec = randTotalSec(); }
    s.scrollTop = s.scrollHeight;
    startActors();
  }

  /* ---------------- 进入 / 退出 ---------------- */
  function show(name, userText) {
    const eng = window.engine;
    const s = document.getElementById('cx-stream');
    if (!s) return;

    /* 伪装对话（安装插件）若开着，先退回阅读流，避免两套暂存互相覆盖 */
    if (window.cxBossActive && typeof window.cxExitBossChat === 'function') window.cxExitBossChat();

    /* 当前已开着另一个任务视图：先把它的 DOM 与计时存回 TASKS */
    if (cur && TASKS[cur] && s.childNodes.length) {
      const f = document.createDocumentFragment();
      while (s.firstChild) f.appendChild(s.firstChild);
      TASKS[cur].frag = f;
      TASKS[cur].elapsed = elapsed;
    }

    if (!readingFrag) {
      /* 首次进入：摘下阅读流（不销毁），记住暂停状态 */
      readingFrag = document.createDocumentFragment();
      while (s.firstChild) readingFrag.appendChild(s.firstChild);
      prevPaused = eng ? !!eng.paused : false;
      clearTimeout(eng && eng.timer);
      if (eng) eng.paused = true;
    }

    cur = name;
    window.cxFakeTaskActive = true;
    if (!TASKS[name]) {
      TASKS[name] = { frag: null, elapsed: 0, reconnect: 0, totalSec: randTotalSec(), ended: false };
      /* 侧栏该任务条目此刻还没绑「可点击」，注册后让它重渲染一次 */
      if (typeof window.cxRerenderSidebar === 'function') { try { window.cxRerenderSidebar(); } catch (_) {} }
    }
    elapsed = TASKS[name].elapsed || 0;

    s.innerHTML = '';
    if (TASKS[name].frag) {
      s.appendChild(TASKS[name].frag);          // 重进旧任务：原样放回
      bindRefsFromRoot(s);
      if (curElapsed) curElapsed.textContent = fmtDur(elapsed);
      if (TASKS[name].ended) {                  // 已报错的任务：保持报错态，不再轮换
        stopTimers();
        if (curStatusRow) curStatusRow.classList.add('err');
        if (curStatusTxt) curStatusTxt.textContent = ERR_TEXT;
        if (curStatusIco) curStatusIco.style.display = '';
      }
    } else {
      s.appendChild(makeTurnFrag(userText || name));
      bindRefsFromRoot(s);
    }
    /* 侧栏高亮 / 顶栏标题跟随当前任务 */
    if (window.cxSetActiveSession && cur) { try { window.cxSetActiveSession(name); } catch (_) {} }
    startActors();
    s.scrollTop = s.scrollHeight;

    const tt = document.getElementById('cx-title');
    if (tt && !tt.isContentEditable) tt.textContent = name;
  }

  function exit() {
    if (!cur) return;
    const eng = window.engine;
    const s = document.getElementById('cx-stream');
    stopTimers();
    if (cur && TASKS[cur] && s && s.childNodes.length) {
      const f = document.createDocumentFragment();
      while (s.firstChild) f.appendChild(s.firstChild);
      TASKS[cur].frag = f;
      TASKS[cur].elapsed = elapsed;
    }
    cur = null;
    curElapsed = curStatusTxt = curStatusRow = curStatusIco = null;
    window.cxFakeTaskActive = false;
    if (s && readingFrag) {
      s.innerHTML = '';
      s.appendChild(readingFrag);
      readingFrag = null;
    }
    if (eng) eng.paused = prevPaused;
    if (eng && !eng.paused && typeof window.resume === 'function') { try { window.resume(); } catch (_) {} }
    const tt = document.getElementById('cx-title');
    if (tt && !tt.isContentEditable) tt.textContent = window.cxSessionName || '开始阅读';
  }

  /* ---------------- 外部接口 ---------------- */
  window.cxFakeStart = function (name, userText) { show(name, userText); };
  window.cxFakeOpen  = function (name) { show(name); };
  window.cxFakeExit  = function () { exit(); };
  window.cxFakeHas   = function (name) { return !!TASKS[name]; };
  /* 任务改名时同步迁移伪装视图记录（否则改名后点击条目进不去） */
  window.cxFakeRename = function (oldName, newName) {
    if (oldName !== newName && TASKS[oldName]) {
      TASKS[newName] = TASKS[oldName];
      delete TASKS[oldName];
      if (cur === oldName) {
        cur = newName;
        const tt = document.getElementById('cx-title');
        if (tt && !tt.isContentEditable) tt.textContent = newName;
      }
    }
  };
  window.cxFakeTaskActive = false;

  /* 任务视图里继续发消息：只追加气泡 + 继续演戏 */
  const origSend = window.sendUser;
  window.sendUser = function (text) {
    if (window.cxFakeTaskActive) {
      const v = (text || '').trim();
      if (v) appendTurn(v);
      return;
    }
    return origSend.apply(this, arguments);
  };
})();
