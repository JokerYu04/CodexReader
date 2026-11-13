/* ============================================================
 *  boss-chat.js —— 「安装插件」伪装工作对话（一键防被抓）
 *
 *  · 点击侧栏「安装插件」或按 F9 → 切到一份预先编排好的
 *    「让 Codex 安装工作插件」多轮历史对话（PDF / Word / AI
 *    使用规范三个插件，带用时、命令卡，完全静态渲染，
 *    就像打开一段真实的历史会话）
 *  · 对话中继续发消息 → 伪装回复（不触碰阅读流）
 *  · 点击侧栏「开始阅读」→ 回到阅读流并继续播放
 *  · 阅读进度不受影响（切回来从当前章节重新加载）
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 剧本 ----------------
   * 时间线：11月10日 上午（周六加班氛围，最不引人怀疑）
   * -------------------------------------- */
  const SCRIPT = [
    { kind: 'bc-user',
      text: '帮我把 PDF 处理插件装一下，平时经常要把 PDF 里的表格提出来整理到 Excel 里' },
    { kind: 'bc-sep', dur: '1m 42s' },
    { kind: 'cx-cmd',
      cmd: 'codex plugin install pdf-toolkit --registry internal',
      out: 'resolving pdf-toolkit@2.4.1 ...\ndownloading pdf-toolkit-2.4.1.tgz (3.2 MB) ...\nverifying checksum ... ok\ninstalling to ~/.codex/plugins/pdf-toolkit\nregistered skills: pdf\n✓ pdf-toolkit 2.4.1 installed' },
    { kind: 'cx-agent',
      text: '已经帮你装好了，`pdf-toolkit` 插件现在在本机的 ~/.codex/plugins/pdf-toolkit。\n\n它会在你下一轮对话里可用。\n\n要点：已注册为 `pdf` 技能，包含这些能力——PDF 文字与表格提取（可导出 CSV/Excel）、按页拆分合并、扫描件 OCR、长文档摘要。' },
    { kind: 'bc-user',
      text: '再装一个处理 Word 文档的，周报和实施方案都要用 docx' },
    { kind: 'bc-sep', dur: '48s' },
    { kind: 'cx-cmd',
      cmd: 'codex plugin install docx-suite',
      out: 'resolving docx-suite@1.8.0 ...\ndownloading docx-suite-1.8.0.tgz (1.9 MB) ...\ninstalling to ~/.codex/plugins/docx-suite\nregistered skills: docx\n✓ docx-suite 1.8.0 installed' },
    { kind: 'cx-agent',
      text: '`docx-suite` 也装好了。\n\n主要能力：按模板批量生成 Word（周报/方案/纪要）、表格与图表插入、docx↔pdf↔md 格式互转、修订追踪。\n\n和 `pdf` 技能可以串联使用，比如「把这份 PDF 里的表格整理成 docx 周报模板」一句话就能完成。' },
    { kind: 'bc-user',
      text: '把我们部门的 AI 使用规范也做成一个 skill 吧，写东西的时候自动按规范检查' },
    { kind: 'bc-sep', dur: '2m 5s' },
    { kind: 'cx-cmd',
      cmd: 'codex skill create ai-policy --from ./docs/AI使用规范v3.md',
      out: 'parsing docs/AI使用规范v3.md (14.2 KB) ...\ngenerating SKILL.md ...\nrules extracted: 23 (数据安全 8 / 输出审核 9 / 禁用场景 6)\nwriting to ~/.codex/skills/ai-policy\n✓ skill ai-policy created' },
    { kind: 'cx-agent',
      text: '已创建 `ai-policy` skill，写入了 ~/.codex/skills/ai-policy/SKILL.md。\n\n我提取了规范里的 23 条规则，分成了三类：数据安全（8 条）、输出审核（9 条）、禁用场景（6 条）。实际效果上，这个 skill 已经可以正常生效，而且它自己写了 "ACTIVATE EVERY RESPONSE"，所以你后续不管是写代码还是写文档，我都会优先按规范的方式处理。\n\n简单的：\n\n• 能做的：涉及客户数据的输出会自动脱敏提醒；对外文档会先过一遍审核要点\n• 不能做的：规范里明确禁止的场景（如未审批的数据出域）我会直接拒绝并提示走人工流程' },
    { kind: 'bc-user',
      text: '把这三个都设置成默认模式并全局使用' },
    { kind: 'bc-sep', dur: '36s' },
    { kind: 'cx-agent',
      text: '我查过了，本地没有"把某个 skill 设成系统级默认并全局强制启用"的开关，三个插件目前只是已安装到 ~/.codex/skills/ 对应目录。\n\n实际效果上，这些 skill 已经可以正常生效，而且各自都写了触发条件，所以你后续做 PDF、Word、规范检查相关任务时，我会优先按对应 skill 的方式处理。\n\n简单的：\n\n• 能做的：已安装，后续相关任务我会默认按它来\n• 不能做的：没有发现 Codex 里可配置的"全局默认 skill"开关\n\n如果你愿意，我可以继续帮你做两种可选方案之一：把常用命令做成一个聚合 skill，或者写一个启动钩子按项目自动加载。' },
  ];

  /* 继续对话时的伪装回复池 */
  const REPLIES = [
    '好的，已记录。当前三个插件（pdf-toolkit / docx-suite / ai-policy）都在生效中，有新任务直接说就行。',
    '这个需要先看到具体文件才能处理，你把文档拖进对话里，我先分析第一部分。',
    '收到，我会在下轮对话里优先按已安装的 skill 处理。',
    '可以做。我先按 docx 周报模板生成一版，你确认格式后我再批量跑。',
  ];
  let replyIdx = 0;

  /* ---------------- 渲染 ---------------- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function el(cls, html) {
    const d = document.createElement('div');
    d.className = cls;
    if (html !== undefined) d.innerHTML = html;
    return d;
  }

  function renderCmd(m) {
    const div = el('cx-cmdrun fade-in');
    div.innerHTML =
      '<button class="cx-cmdrun-head" type="button" title="展开/收起">' +
        '<span class="cx-cmdrun-chev">⌄</span><span class="cx-cmdrun-label">运行了命令</span>' +
        `<span class="cx-cmdrun-name">${esc(m.cmd)}</span>` +
      '</button>' +
      `<div class="cx-cmdrun-body"><pre class="cx-cmdrun-out">${esc(m.out || '')}</pre></div>`;
    div.querySelector('.cx-cmdrun-head').addEventListener('click', () => div.classList.toggle('open'));
    return div;
  }

  function renderAgent(m) {
    const div = el('cx-agent');
    div.innerHTML = '<div class="cx-agent-tag">▌ codex</div><div class="cx-agent-body"></div>';
    div.querySelector('.cx-agent-body').textContent = m.text;
    return div;
  }

  function renderScript() {
    const s = window.engine.streamEl;
    s.innerHTML = '';
    for (const m of SCRIPT) {
      if (m.kind === 'bc-user') {
        s.appendChild(el('cx-user', `<span class="cx-user-text">${esc(m.text)}</span>`));
      } else if (m.kind === 'bc-sep') {
        s.appendChild(el('cx-bc-sep', `<span class="cx-bc-dots">⋮</span><span class="cx-bc-dur">用时 ${esc(m.dur)}</span><span class="cx-bc-chev">›</span>`));
      } else if (m.kind === 'cx-cmd') {
        s.appendChild(renderCmd(m));
      } else if (m.kind === 'cx-agent') {
        s.appendChild(renderAgent(m));
      } else if (m.kind === 'cx-note') {
        s.appendChild(el('cx-note', esc(m.text)));
      }
    }
  }

  /* ---------------- 进入 / 退出 ----------------
   * 阅读流不销毁：进入前把现有节点摘下来存入片段，退出时原样放回，
   * 保证「开始阅读」返回时看到的还是原来的输出，不会重新播放。
   * ------------------------------------------------ */
  let savedNodes = null;   // DocumentFragment：被藏起来的阅读流
  let prevPaused = false;
  let prevSession = null;  // 进入前侧栏选中的会话（退出时恢复高亮）

  function show() {
    const eng = window.engine;
    if (!eng || !eng.streamEl || savedNodes) return;
    // 新任务伪装视图若开着，先退回阅读流，避免两套暂存互相覆盖
    if (window.cxFakeTaskActive && typeof window.cxFakeExit === 'function') window.cxFakeExit();
    window.cxBossActive = true;
    prevSession = window.cxSessionName || '开始阅读';
    /* 侧栏高亮跟随：点亮「安装插件」条目 */
    if (window.cxSetActiveSession) { try { window.cxSetActiveSession('安装插件'); } catch (_) {} }
    prevPaused = !!eng.paused;
    if (typeof window.pause === 'function') { try { window.pause(); } catch (_) {} }
    clearTimeout(eng.timer);
    eng.paused = true;
    // 关掉可能开着的新聊天界面
    if (window.cxNCOpen && typeof window.cxCloseNewChat === 'function') window.cxCloseNewChat();
    const s = eng.streamEl;
    savedNodes = document.createDocumentFragment();
    while (s.firstChild) savedNodes.appendChild(s.firstChild);   // 摘下阅读流（不销毁）
    renderScript();
    const tt = document.getElementById('cx-title');
    if (tt && !tt.isContentEditable) tt.textContent = '安装插件';
    requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; });
  }

  function exit() {
    const eng = window.engine;
    if (!eng || !savedNodes) return;
    window.cxBossActive = false;
    const s = eng.streamEl;
    s.innerHTML = '';
    s.appendChild(savedNodes);          // 原样放回阅读流，不重新输出
    savedNodes = null;
    s.scrollTop = s.scrollHeight;
    eng.paused = prevPaused;
    // 若之前在播放，恢复节奏推进（resume 只续播，不会重载重播）
    if (!eng.paused && typeof window.resume === 'function') { try { window.resume(); } catch (_) {} }
    // 侧栏高亮恢复进入前选中的会话；顶栏标题同步
    if (window.cxSetActiveSession && prevSession) { try { window.cxSetActiveSession(prevSession); } catch (_) {} }
    const tt = document.getElementById('cx-title');
    if (tt && !tt.isContentEditable) tt.textContent = window.cxSessionName || '开始阅读';
  }

  /* ---------------- 对话中继续发消息（伪装回复，不触碰阅读流） ---------------- */
  function bossReply(text) {
    const eng = window.engine;
    if (!eng || !eng.streamEl) return;
    const s = eng.streamEl;
    s.appendChild(el('cx-user fade-in', `<span class="cx-user-text">${esc(text)}</span>`));
    after(500, () => {
      s.appendChild(el('cx-thinking', '<i class="cx-spin"></i> 思考中…'));
      after(900, () => {
        const th = s.querySelector('.cx-thinking');
        if (th) th.remove();
        s.appendChild(renderAgent({ text: REPLIES[replyIdx++ % REPLIES.length] }));
        scrollBottom();
      });
    });
    scrollBottom();
    function scrollBottom() { s.scrollTop = s.scrollHeight; }
    function after(ms, fn) { clearTimeout(eng._bcTimer); eng._bcTimer = setTimeout(fn, ms); }
  }

  /* ---------------- 发送拦截 + F9 快捷键 ---------------- */
  const origSend = window.sendUser;
  window.sendUser = function (text) {
    if (window.cxBossActive) {
      const v = (text || '').trim();
      if (v) bossReply(v);
      return;
    }
    return origSend.apply(this, arguments);
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F9') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    if (!window.cxBossActive) show();
  });

  window.cxShowBossChat = show;
  window.cxExitBossChat = exit;
})();
