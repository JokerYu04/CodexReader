'use strict';

/* ============================================================
 *  sidebar-codex.js — Codex 视图：可编辑侧栏 + 「新聊天」界面
 *
 *  · 侧栏数据模型存 localStorage（键 cxSidebarModel / cxSessionName）
 *    首次运行播种默认内容（与真实 Codex 截图一致）
 *  · 会话条目：单击=选中（顶栏标题跟随）；双击=行内改名；
 *    右键=菜单（重命名 / 新增任务 / 删除）
 *  · 项目：单击=折叠/展开；右键=菜单（重命名 / 新增任务 / 删除）
 *  · 「新聊天」：覆盖主区显示 Codex 空态（居中 logo +
 *    「我们应该在<项目名>中做些什么？」+ 项目胶囊 + 随心输入）；
 *    点会话 / 发消息 / Esc 退出。项目名自动取当前会话所属项目。
 *  · 无 Electron 环境（静态预览）也能跑：engine 相关调用全部守卫。
 * ============================================================ */

(function () {
  const host = document.getElementById('cx-side-groups');
  if (!host) return;   // 非 Codex 视图不初始化

  /* ---------------- 数据模型 ---------------- */
  const LS_MODEL = 'cxSidebarModel';
  const LS_SESSION = 'cxSessionName';

  const DEFAULT_MODEL = {
    pinned: [
      {
        name: 'PBOS项目', open: true,
        children: ['每日工作汇报', '需求分析', '11月政企（2）', '11月政企（1）', '经分设备工单统计10.8'],
      },
    ],
    projects: [
      { name: '准入客户端', open: true, children: [] },
      { name: 'git-rea', open: true, children: ['https://github.com/morlutao…'] },
      { name: '日常', open: true, children: ['评估配置', '解释 DataOutputStream 和 I…', '梳理数据库设计实现流程', '开始阅读', '安装插件'] },
    ],
  };

  function loadModel() {
    try {
      const m = JSON.parse(localStorage.getItem(LS_MODEL));
      if (m && Array.isArray(m.pinned) && Array.isArray(m.projects)) return m;
    } catch (_) {}
    return JSON.parse(JSON.stringify(DEFAULT_MODEL));
  }

  const model = loadModel();
  /* 运行时唯一项目 id（non-enumerable，不会写入 localStorage）：DOM 与 model 可靠对应 */
  let __uid = 0;
  [...model.pinned, ...model.projects].forEach((p) => {
    Object.defineProperty(p, '__id', { value: ++__uid, enumerable: false, configurable: true });
  });
  let sessionName = localStorage.getItem(LS_SESSION) || '需求分析';
  window.cxSessionName = sessionName;
  window.cxNCOpen = false;

  /* 名字锁定的条目：功能按名字绑定，禁止改名（双击/右键均不可） */
  const LOCKED_NAMES = ['开始阅读', '安装插件'];
  const isLockedName = (n) => LOCKED_NAMES.indexOf(n) >= 0;

  function save() {
    try {
      localStorage.setItem(LS_MODEL, JSON.stringify(model));
      localStorage.setItem(LS_SESSION, sessionName);
    } catch (_) {}
  }

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isUrl = (s) => /^https?:/.test(s);

  const FOLDER_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h5.6c.7 0 1.2.5 1.2 1.2v6.8c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/></svg>';
  const BRANCH_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.2-2.4 2.4-4.6 3"/></svg>';
  const SEND_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V4M4.5 7.5L8 4l3.5 3.5"/></svg>';
  const BOOKMARK_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4.5 2.5h7v11l-3.5-2.4L4.5 13.5z"/></svg>';
  const LOGO_SVG = '<svg viewBox="0 0 48 48" width="46" height="46" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M17 9c-4.5 0-6 2-6 5.5v5c0 2.6-1.8 4.2-4.6 4.5 2.8.3 4.6 1.9 4.6 4.5v5C11 38.4 12.5 40 17 40"/><path d="M31 9c4.5 0 6 2 6 5.5v5c0 2.6 1.8 4.2 4.6 4.5-2.8.3-4.6 1.9-4.6 4.5v5C37 38.4 35.5 40 31 40"/><path d="M21 25.5h6"/></svg>';

  function activeProjectName() {
    const all = [...model.pinned, ...model.projects];
    const p = all.find((x) => x.children.includes(sessionName));
    if (p) return p.name;
    return (model.pinned[0] || model.projects[0] || { name: 'PBOS项目' }).name;
  }

  /* 全库唯一任务名：避免同名条目导致定位/改名错位 */
  function uniqueTaskName(base) {
    const all = new Set([...model.pinned, ...model.projects].flatMap((p) => p.children));
    if (!all.has(base)) return base;
    let i = 2;
    while (all.has(base + ' ' + i)) i++;
    return base + ' ' + i;
  }

  /* 第一个可用会话名（非 URL），找不到才用兜底 */
  function firstAvailableSession() {
    for (const p of [...model.pinned, ...model.projects]) {
      const c = p.children.find((x) => !isUrl(x));
      if (c) return c;
    }
    return '需求分析';
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    flushEditor();   // 重建 DOM 前先提交进行中的编辑，避免输入框残留在游离节点上
    host.innerHTML = '';
    host.appendChild(buildGroup('置顶', model.pinned));
    host.appendChild(buildGroup('项目', model.projects));
    markActive();
  }

  function buildGroup(label, arr) {
    const g = document.createElement('div');
    g.className = 'cx-side-group';
    const l = document.createElement('div');
    l.className = 'cx-side-label';
    l.textContent = label;
    g.appendChild(l);
    arr.forEach((p) => g.appendChild(buildProj(p, arr)));
    if (label === '置顶') {
      const more = document.createElement('div');
      more.className = 'cx-side-item cx-more';
      more.innerHTML = '展开显示 <span class="cx-chev">⌄</span>';
      g.appendChild(more);
    }
    return g;
  }

  function buildProj(p, parentArr) {
    const wrap = document.createElement('div');
    wrap.className = 'cx-proj' + (p.open ? '' : ' folded');

    const head = document.createElement('div');
    head.className = 'cx-proj-head';
    head.innerHTML =
      `<span class="cx-proj-ico">${FOLDER_SVG}</span>` +
      `<span class="cx-proj-name">${esc(p.name)}</span>` +
      `<span class="cx-proj-chev">⌄</span>`;
    head.addEventListener('click', () => {
      p.open = !p.open;
      wrap.classList.toggle('folded', !p.open);
      save();
    });
    head.addEventListener('dblclick', (e) => { e.preventDefault(); startRenameProj(head, p); });
    head.addEventListener('contextmenu', (e) => openMenu(e, { type: 'proj', ref: p, parentArr }));

    const body = document.createElement('div');
    body.className = 'cx-proj-body';
    if (!p.children.length) {
      const d = document.createElement('div');
      d.className = 'cx-side-dim';
      d.textContent = '暂无聊天';
      body.appendChild(d);
    }
    p.children.forEach((name) => body.appendChild(buildItem(p, name)));

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  function buildItem(proj, name) {
    const it = document.createElement('div');
    it.className = 'cx-side-item' + (isUrl(name) ? ' cx-url' : '');
    it.textContent = name;
    it.dataset.name = name;
    it.dataset.pid = proj.__id;   // 所属项目运行时 id，DOM 重建后仍可精确定位
    const locked = LOCKED_NAMES.indexOf(name) >= 0;
    if (locked) it.dataset.locked = '1';
    if (name === '开始阅读') {
      /* 唯一可点击的会话：回到阅读界面并开播（若在伪装对话/新任务视图中先退出） */
      it.classList.add('cx-clickable');
      it.addEventListener('click', () => {
        if (window.cxBossActive && typeof window.cxExitBossChat === 'function') window.cxExitBossChat();
        if (window.cxFakeTaskActive && typeof window.cxFakeExit === 'function') window.cxFakeExit();
        closeNewChat();
        window.cxSetActiveSession ? window.cxSetActiveSession('开始阅读')
          : (sessionName = '开始阅读', window.cxSessionName = '开始阅读', save(), markActive(), syncTitle());
        try {
          if (typeof engine !== 'undefined' && engine && engine.book && engine.paused) {
            engine.paused = false;
            toast('已开始阅读');
          }
        } catch (_) {}
      });
    } else if (name === '安装插件') {
      /* 一键防被抓：切到预先编排的「安装工作插件」历史对话 */
      it.classList.add('cx-clickable');
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof window.cxShowBossChat === 'function') window.cxShowBossChat();
        else togglePlusMenu(it);   // 模块未加载时的兜底
      });
    }
    /* 有伪装视图的新任务条目：点击重新进入该任务视图 */
    if (window.cxFakeHas && window.cxFakeHas(name)) {
      it.classList.add('cx-clickable');
      it.addEventListener('click', () => {
        selectItem(name);   // 侧栏高亮 / 顶栏标题跟随
        if (typeof window.cxFakeOpen === 'function') window.cxFakeOpen(name);
      });
    }
    /* 其余条目均不可点击；非锁定条目保留双击改名 */
    if (!locked) {
      it.addEventListener('dblclick', (e) => { e.preventDefault(); startRenameItem(it, proj, name); });
    }
    it.addEventListener('contextmenu', (e) => openMenu(e, { type: 'item', ref: proj, name, el: it }));
    return it;
  }

  function markActive() {
    host.querySelectorAll('.cx-side-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.name === sessionName);
      if (el.classList.contains('active')) el.id = 'cx-side-active';
      else if (el.id === 'cx-side-active') el.removeAttribute('id');
    });
  }

  function syncTitle() {
    if (window.cxNCOpen) return;
    const tt = document.getElementById('cx-title');
    if (tt && !tt.isContentEditable) tt.textContent = sessionName;
  }

  function selectItem(name) {
    sessionName = name;
    window.cxSessionName = name;
    save();
    closeNewChat();
    markActive();
    syncTitle();
  }

  /* ---------------- 行内改名 ----------------
   *  全局同一时刻只允许一个编辑框：
   *  · 开新编辑框前强制提交上一个（flushEditor）
   *  · render() 重建 DOM 前也先提交，杜绝「游离输入框残留」
   */
  let activeEditor = null;   // 当前编辑框的 finish 函数

  function flushEditor() {
    if (!activeEditor) return;
    const f = activeEditor;
    activeEditor = null;
    f(true);
  }

  function inlineEdit(el, oldVal, onCommit) {
    if (el.querySelector('input')) return;
    flushEditor();                       // 关掉并提交已有编辑框
    const input = document.createElement('input');
    input.className = 'cx-rename';
    input.value = oldVal;
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (activeEditor === finish) activeEditor = null;
      onCommit(ok ? (input.value.trim() || oldVal) : oldVal);
    };
    activeEditor = finish;
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    input.addEventListener('dblclick', (ev) => ev.stopPropagation());
  }

  function startRenameItem(el, proj, oldName) {
    if (isLockedName(oldName)) { toast('该条目名称不可修改'); return; }   // 名字锁定：双击/右键均拒绝
    inlineEdit(el, oldName, (v) => {
      const idx = proj.children.indexOf(oldName);
      if (idx >= 0) proj.children[idx] = v;
      if (sessionName === oldName) { sessionName = v; window.cxSessionName = v; }
      if (window.cxFakeRename) { try { window.cxFakeRename(oldName, v); } catch (_) {} }   // 伪装任务记录跟随改名
      save();
      render();
      syncTitle();
      refreshNCLabels();
    });
  }

  function startRenameProj(headEl, p) {
    const nameEl = headEl.querySelector('.cx-proj-name');
    if (!nameEl) return;
    inlineEdit(nameEl, p.name, (v) => {
      p.name = v;
      save();
      render();
      refreshNCLabels();
    });
  }

  /* ---------------- 右键菜单 ---------------- */
  const menu = document.createElement('div');
  menu.className = 'cx-ctx';
  menu.hidden = true;
  menu.innerHTML =
    '<div class="cx-ctx-item" data-act="rename">重命名</div>' +
    '<div class="cx-ctx-item" data-act="add">新增任务</div>' +
    '<div class="cx-ctx-item danger" data-act="del">删除</div>';
  document.body.appendChild(menu);
  let menuTarget = null;

  function openMenu(e, target) {
    e.preventDefault();
    e.stopPropagation();
    menuTarget = target;
    /* 锁定名字的条目：禁用「重命名」项 */
    const rn = menu.querySelector('[data-act="rename"]');
    if (rn) {
      const locked = target.type === 'item' && isLockedName(target.name);
      rn.classList.toggle('disabled', locked);
      rn.title = locked ? '该条目名称不可修改' : '';
    }
    menu.hidden = false;
    menu.style.left = Math.min(e.clientX, window.innerWidth - 140) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 110) + 'px';
  }

  document.addEventListener('mousedown', (e) => {
    if (!menu.contains(e.target)) menu.hidden = true;
  });
  window.addEventListener('blur', () => { menu.hidden = true; });

  menu.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act || !menuTarget) return;
    menu.hidden = true;
    doMenuAct(act);
  });

  function doMenuAct(act) {
    const t = menuTarget;
    menuTarget = null;
    if (act === 'rename') {
      if (t.type === 'item') {
        if (isLockedName(t.name)) { toast('该条目名称不可修改'); return; }
        // 菜单打开后 DOM 可能已被重建，按「项目 id + 名称」在当前 DOM 里重新定位
        const el = [...host.querySelectorAll('.cx-side-item')]
          .find((x) => x.dataset.pid === String(t.ref.__id) && x.dataset.name === t.name);
        if (el) startRenameItem(el, t.ref, t.name);
      } else {
        const head = host.querySelectorAll('.cx-proj-head');
        // 重命名目标项目：按引用找到对应 head（render 后 DOM 与 model 顺序一致）
        const all = [...t.parentArr];
        const i = all.indexOf(t.ref);
        if (head[i]) startRenameProj(head[i], t.ref);
      }
      return;
    }
    if (act === 'add') {
      const newName = uniqueTaskName('新任务');
      if (t.type === 'proj') t.ref.children.push(newName);
      else {
        const idx = t.ref.children.indexOf(t.name);
        t.ref.children.splice(idx >= 0 ? idx + 1 : t.ref.children.length, 0, newName);
      }
      t.ref.open = true;
      save();
      render();
      const el = [...host.querySelectorAll('.cx-side-item')]
        .find((x) => x.dataset.pid === String(t.ref.__id) && x.dataset.name === newName);
      if (el) startRenameItem(el, t.ref, newName);
      return;
    }
    if (act === 'del') {
      if (t.type === 'item' && isLockedName(t.name)) { toast('该条目为功能入口，不可删除'); return; }
      if (t.type === 'proj' && t.ref.children.some(isLockedName)) { toast('该项目内含功能入口条目，不可删除'); return; }
      const label = t.type === 'proj' ? t.ref.name : t.name;
      if (!window.confirm(`删除「${label}」？`)) return;
      if (t.type === 'proj') {
        const i = t.parentArr.indexOf(t.ref);
        if (i >= 0) t.parentArr.splice(i, 1);
        // 若当前会话在被删项目里，回落到第一个可用会话
        if (!sessionExists(sessionName)) {
          sessionName = firstAvailableSession();
          window.cxSessionName = sessionName;
        }
      } else {
        const i = t.ref.children.indexOf(t.name);
        if (i >= 0) t.ref.children.splice(i, 1);
        if (sessionName === t.name) {
          // 优先同项目其余会话，其次全库任一可用会话
          const fb = t.ref.children.find((c) => !isUrl(c)) || firstAvailableSession();
          sessionName = fb;
          window.cxSessionName = fb;
        }
      }
      save();
      render();
      syncTitle();
      refreshNCLabels();
    }
  }

  /* 当前会话名是否真实存在于侧栏 */
  function sessionExists(name) {
    return [...model.pinned, ...model.projects].some((p) => p.children.includes(name));
  }

  /* ---------------- 新聊天界面 ---------------- */
  const overlay = document.createElement('div');
  overlay.id = 'cx-newchat';
  overlay.className = 'cx-newchat';
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="cx-nc-center">' +
      `<div class="cx-nc-logo"><img src="assets/codex-knot.png" alt="" draggable="false"></div>` +
      '<div class="cx-nc-question">我们应该在<span class="cx-nc-proj"></span>中做些什么？</div>' +
    '</div>' +
    '<div class="cx-nc-bottom">' +
      '<div class="cx-nc-chip">' +
        `<span class="cx-nc-chip-name">${FOLDER_SVG}<b></b></span>` +
        `<span class="cx-nc-chip-git">${BRANCH_SVG}创建 Git 存储库</span>` +
      '</div>' +
      '<div class="cx-nc-composer">' +
        '<textarea class="cx-nc-input" rows="1" placeholder="随心输入"></textarea>' +
        '<div class="cx-comp-row">' +
          '<div class="cx-comp-left">' +
            '<span class="cx-plus" title="附件">＋</span>' +
            '<button class="cx-approve nc-approve" type="button"><span class="cx-ap-ico"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5.8 8.2V3.6a.9.9 0 011.8 0V7"/><path d="M7.6 7V2.9a.9.9 0 011.8 0V7"/><path d="M9.4 7V3.6a.9.9 0 011.8 0v4.6"/><path d="M11.2 8V6.5a.9.9 0 011.8 0v2.3c0 2.8-1.8 5-4.6 5-1.9 0-2.8-.5-3.8-2L2.9 9.3c-.5-.7-.3-1.5.4-1.9.5-.3 1.2-.2 1.6.3l.9 1"/></svg></span>请求访问</button>' +
          '</div>' +
          '<div class="cx-comp-right">' +
            '<span class="cx-model"><span class="cx-model-label">6.1 Sol 中<i class="cx-chev">⌄</i></span></span>' +
            `<button class="cx-send nc-send" type="button" title="发送">${SEND_SVG}</button>` +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  const mainEl = document.querySelector('.cx-main');
  if (mainEl) mainEl.appendChild(overlay);

  function refreshNCLabels() {
    const pn = activeProjectName();
    const q = overlay.querySelector('.cx-nc-proj');
    const b = overlay.querySelector('.cx-nc-chip-name b');
    if (q) q.textContent = pn;
    if (b) b.textContent = pn;
  }

  function openNewChat() {
    window.cxNCOpen = true;
    overlay.hidden = false;
    refreshNCLabels();
    // 新聊天界面若在锁定状态下打开，按钮文案也要同步成「完全访问」
    if (window.cxSyncLockBtns) window.cxSyncLockBtns(!!window.cxLockActive);
    if (window.pause) { try { pause(); } catch (_) {} }
    const tt = document.getElementById('cx-title');
    if (tt) tt.textContent = '新聊天';
    const ta = overlay.querySelector('.cx-nc-input');
    ta.value = '';
    ta.style.height = 'auto';
    setTimeout(() => { try { ta.focus(); } catch (_) {} }, 60);
  }

  function closeNewChat() {
    if (!window.cxNCOpen) return;
    window.cxNCOpen = false;
    overlay.hidden = true;
    syncTitle();
  }
  window.cxOpenNewChat = openNewChat;   // 空格快捷键入口（engine.bindKeyboard 调用）
  window.cxCloseNewChat = closeNewChat; // boss 对话等外部模块使用
  window.cxRerenderSidebar = function () { render(); markActive(); };  // fake-task 注册任务后调用
  /* 统一设置当前所处会话：侧栏高亮 / 顶栏标题 / 持久化同步跟随
   * （安装插件对话、新任务视图等外部模块切换视图时调用） */
  window.cxSetActiveSession = function (name) {
    if (!name || !sessionExists(name)) return;
    sessionName = name;
    window.cxSessionName = name;
    save();
    markActive();
    syncTitle();
  };

  const ncBtn = document.getElementById('cx-newchat-btn');
  if (ncBtn) ncBtn.addEventListener('click', openNewChat);

  const ncInput = overlay.querySelector('.cx-nc-input');
  function ncSend() {
    const v = ncInput.value.trim();
    if (!v) { closeNewChat(); return; }
    ncInput.value = '';
    ncInput.style.height = 'auto';
    /* 「安装插件」伪装对话若开着，先退回阅读流，避免暂存互相覆盖 */
    if (window.cxBossActive && typeof window.cxExitBossChat === 'function') window.cxExitBossChat();
    /* 在当前项目下新建任务：名称取消息前缀（去重），并切到该任务的伪装视图 */
    const proj = [...model.pinned, ...model.projects].find((p) => p.name === activeProjectName())
      || model.pinned[0] || model.projects[0];
    const base = v.length > 16 ? v.slice(0, 16) + '…' : v;
    const name = uniqueTaskName(base);
    proj.children.push(name);
    proj.open = true;
    sessionName = name;
    window.cxSessionName = name;
    save();
    render();
    markActive();
    closeNewChat();
    syncTitle();
    if (typeof window.cxFakeStart === 'function') window.cxFakeStart(name, v);
  }
  ncInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ncSend(); }
  });
  ncInput.addEventListener('input', () => {
    ncInput.style.height = 'auto';
    ncInput.style.height = Math.min(120, ncInput.scrollHeight) + 'px';
  });
  const ncSendBtn = overlay.querySelector('.nc-send');
  if (ncSendBtn) ncSendBtn.addEventListener('click', ncSend);
  const ncAp = overlay.querySelector('.nc-approve');
  if (ncAp) ncAp.addEventListener('click', () => {
    /* 与阅读界面的「完全访问」同一开关：隐藏锁定（假装无响应） */
    if (window.cxToggleLock) window.cxToggleLock();
  });
  // 新聊天界面里的 ＋：同样弹出「添加小说 / 书库切换」菜单
  const ncPlus = overlay.querySelector('.cx-plus');
  if (ncPlus) ncPlus.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlusMenu(ncPlus);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.cxNCOpen) {
      const ae = document.activeElement;
      if (!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable))) closeNewChat();
    }
  });

  /* ---------------- 设置面板 / 主题 / 阅读偏好 ----------------
   *  · 外观：深色 / 浅色主题（body[data-theme]，CSS 变量整体切换）
   *  · 阅读：输出方式（流式 / 直接展示）、输出风格（AI 伪装 / 原文）、输出速度
   *  全部持久化 localStorage「cxSettings」；engine.js 用 cxSettings() 惰性读取
   * ------------------------------------------------------------- */
  const LS_SETTINGS = 'cxSettings';
  const DEF_SETTINGS = { theme: 'dark', output: 'stream', style: 'ai', speed: 5 };
  function loadSettings() {
    try { return Object.assign({}, DEF_SETTINGS, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); }
    catch (_) { return Object.assign({}, DEF_SETTINGS); }
  }
  const settings = loadSettings();
  window.cxSettingsCache = settings;
  function persistSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (_) {}
  }
  function applyTheme() {
    if (settings.theme === 'light') document.body.dataset.theme = 'light';
    else delete document.body.dataset.theme;
  }
  applyTheme();

  function applySpeed(n) {
    settings.speed = Math.max(1, Math.min(10, parseInt(n, 10) || 5));
    persistSettings();
    if (typeof window.setSpeed === 'function') { try { window.setSpeed(settings.speed); } catch (_) {} }
    try { if (window.novelApi && window.novelApi.setState) window.novelApi.setState({ speed: settings.speed }); } catch (_) {}
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'cx-toast fade-in';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.remove(); }, 2200);
  }

  // 更新按钮：转一圈 + 提示（纯伪装，不动网络）
  const upBtn = document.getElementById('cx-update-btn');
  if (upBtn) upBtn.addEventListener('click', () => {
    upBtn.classList.add('spin');
    setTimeout(() => upBtn.classList.remove('spin'), 1400);
    toast('Codex 已是最新版本 0.55.0');
  });

  const settingsEl = document.createElement('div');
  settingsEl.id = 'cx-settings';
  settingsEl.className = 'cx-settings';
  settingsEl.hidden = true;
  settingsEl.innerHTML =
    '<div class="cx-set-scrim"></div>' +
    '<div class="cx-set-panel">' +
      '<div class="cx-set-head">' +
        '<span class="cx-set-title">设置</span>' +
        '<span class="cx-set-close" title="关闭">✕</span>' +
      '</div>' +
      '<div class="cx-set-body">' +
        '<div class="cx-set-label">外观</div>' +
        '<div class="cx-set-row">' +
          '<span class="cx-set-name">模式</span>' +
          '<div class="cx-theme-cards">' +
            '<button class="cx-theme-card" data-theme="dark" type="button"><span class="tc-mini tc-dark"></span>深色</button>' +
            '<button class="cx-theme-card" data-theme="light" type="button"><span class="tc-mini tc-light"></span>浅色</button>' +
          '</div>' +
        '</div>' +
        '<div class="cx-set-label">阅读</div>' +
        '<div class="cx-set-row">' +
          '<span class="cx-set-name">输出方式</span>' +
          '<div class="cx-seg" id="cx-seg-output">' +
            '<button type="button" data-val="stream">流式输出</button>' +
            '<button type="button" data-val="instant">直接展示</button>' +
          '</div>' +
        '</div>' +
        '<div class="cx-set-row">' +
          '<span class="cx-set-name">输出风格</span>' +
          '<div class="cx-seg" id="cx-seg-style">' +
            '<button type="button" data-val="ai">AI 排版</button>' +
            '<button type="button" data-val="plain">原文</button>' +
          '</div>' +
        '</div>' +
        '<div class="cx-set-row">' +
          '<span class="cx-set-name">输出速度</span>' +
          '<div class="cx-speed-ctl">' +
            '<input type="range" id="cx-set-speed" min="1" max="10" step="1">' +
            '<span class="cx-speed-val" id="cx-set-speed-val">5</span>' +
          '</div>' +
        '</div>' +
        '<div class="cx-set-kbd">快捷键：空格 新聊天 · Alt 安装插件 · j 上一章 · k 下一章 · ← / → 翻章 · ↓ 追加输出 · 双击 ↓ / ↑ 调速 · 双击正文 展开全章</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(settingsEl);

  function syncSettingsUI() {
    settingsEl.querySelectorAll('.cx-theme-card').forEach((c) => {
      c.classList.toggle('sel', c.dataset.theme === settings.theme);
    });
    settingsEl.querySelectorAll('#cx-seg-output button').forEach((b) => {
      b.classList.toggle('sel', b.dataset.val === settings.output);
    });
    settingsEl.querySelectorAll('#cx-seg-style button').forEach((b) => {
      b.classList.toggle('sel', b.dataset.val === (settings.style || 'ai'));
    });
    const r = settingsEl.querySelector('#cx-set-speed');
    if (r) r.value = settings.speed;
    const v = settingsEl.querySelector('#cx-set-speed-val');
    if (v) v.textContent = settings.speed;
  }

  function openSettings() {
    syncSettingsUI();
    settingsEl.hidden = false;
  }
  function closeSettings() { settingsEl.hidden = true; }

  const gearBtn = document.getElementById('cx-settings-btn');
  if (gearBtn) gearBtn.addEventListener('click', openSettings);
  settingsEl.querySelector('.cx-set-close').addEventListener('click', closeSettings);
  settingsEl.querySelector('.cx-set-scrim').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsEl.hidden) { e.stopPropagation(); closeSettings(); }
  }, true);

  settingsEl.querySelectorAll('.cx-theme-card').forEach((c) => {
    c.addEventListener('click', () => {
      settings.theme = c.dataset.theme;
      persistSettings();
      applyTheme();
      syncSettingsUI();
    });
  });
  /* 切换输出方式 / 输出风格后立即重载当前章，不必等下一章 */
  function reloadCurrentChapter() {
    if (window.cxBossActive || window.cxFakeTaskActive || window.cxNCOpen) return;
    if (window.engine && engine.book && typeof window.loadChapter === 'function') {
      const wasPlaying = !engine.paused;
      try {
        window.loadChapter(engine.chapterIdx, true);
        if (wasPlaying && typeof window.resume === 'function') window.resume();
      } catch (_) {}
    }
  }

  settingsEl.querySelectorAll('#cx-seg-output button').forEach((b) => {
    b.addEventListener('click', () => {
      if (settings.output === b.dataset.val) return;
      settings.output = b.dataset.val;
      persistSettings();
      syncSettingsUI();
      reloadCurrentChapter();
    });
  });
  settingsEl.querySelectorAll('#cx-seg-style button').forEach((b) => {
    b.addEventListener('click', () => {
      if ((settings.style || 'ai') === b.dataset.val) return;
      settings.style = b.dataset.val;
      persistSettings();
      syncSettingsUI();
      reloadCurrentChapter();
      toast(b.dataset.val === 'ai' ? '已切换为 AI 排版' : '已切换为原文模式');
    });
  });
  const speedRange = settingsEl.querySelector('#cx-set-speed');
  if (speedRange) speedRange.addEventListener('input', () => {
    applySpeed(speedRange.value);
    const v = settingsEl.querySelector('#cx-set-speed-val');
    if (v) v.textContent = settings.speed;
  });

  /* ---------------- ＋ 添加小说 / 书库切换（仿 Codex 加号菜单） ---------------- */
  const PM_FILE_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M3.5 1.8h5.6l3.5 3.5v8.9c0 .55-.45 1-1 1h-8.1c-.55 0-1-.45-1-1V2.8c0-.55.45-1 1-1z"/><path d="M9 1.8v4h4"/></svg>';
  const PM_BOOK_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 2.5h4.5c.8 0 1.5.7 1.5 1.5v9c0-.8-.7-1.5-1.5-1.5H2.5z"/><path d="M13.5 2.5H9c-.8 0-1.5.7-1.5 1.5v9c0-.8.7-1.5 1.5-1.5h4.5z"/></svg>';

  const pm = document.createElement('div');
  pm.id = 'cx-plus-menu';
  pm.className = 'cx-plus-menu';
  pm.hidden = true;
  pm.innerHTML =
    '<div class="cx-pm-label">添加</div>' +
    '<div class="cx-pm-item" id="cx-pm-import">' +
      `<span class="cx-pm-ico">${PM_FILE_SVG}</span>` +
      '<div class="cx-pm-txt"><b>文件和文件夹</b><i>导入 txt / epub 小说</i></div>' +
    '</div>' +
    '<div class="cx-pm-label">书库</div>' +
    '<div class="cx-pm-books" id="cx-pm-books"></div>';
  document.body.appendChild(pm);

  async function refreshPmBooks() {
    const box = pm.querySelector('#cx-pm-books');
    if (!box) return;
    let books = [];
    if (window.novelApi && window.novelApi.list) {
      try { const r = await window.novelApi.list(); books = (r && r.books) || []; } catch (_) {}
    }
    box.innerHTML = '';
    if (!books.length) {
      const d = document.createElement('div');
      d.className = 'cx-pm-empty';
      d.textContent = '书库是空的，先添加一本';
      box.appendChild(d);
      return;
    }
    books.forEach((b) => {
      const it = document.createElement('div');
      it.className = 'cx-pm-item cx-pm-book' + (window.engine && engine.bookId === b.id ? ' active' : '');
      const pct = b.progress && b.progress.chapter != null
        ? Math.min(100, Math.round(((b.progress.chapter + 1) / Math.max(1, b.chapter_count)) * 100)) : 0;
      it.innerHTML =
        `<span class="cx-pm-ico">${PM_BOOK_SVG}</span>` +
        `<div class="cx-pm-txt"><b>${esc(b.title || '未命名')}</b><i>${b.chapter_count || 0} 段 · ${(b.char_count || 0).toLocaleString()} 字 · ${pct}%</i></div>`;
      it.addEventListener('click', () => switchToBook(b.id));
      box.appendChild(it);
    });
  }

  async function switchToBook(id) {
    pm.hidden = true;
    if (!window.novelApi || typeof window.loadBook !== 'function') return;
    try {
      closeNewChat();   // 新聊天界面下切书：先回阅读视图
      await window.novelApi.setState({ bookId: id });
      if (typeof window.pause === 'function') { try { pause(); } catch (_) {} }
      await window.loadBook(id);
      engine.paused = false;   // 切完直接开始推内容
      toast('已切换 · 内容即将输出');
    } catch (e) { try { window.novelApi.log('switchBook 异常: ' + e); } catch (_) {} }
  }

  async function importNovel() {
    if (!window.novelApi || !window.novelApi.import) { toast('当前环境不支持导入'); return; }
    pm.hidden = true;
    const r = await window.novelApi.import();
    if (!r || !r.ok) {
      if (r && r.error && r.error !== 'cancel') toast('导入失败：' + r.error);
      return;
    }
    if (r.book && r.book.id) {
      closeNewChat();   // 新聊天界面下导入：先回阅读视图
      await window.novelApi.setState({ bookId: r.book.id });
      if (typeof window.pause === 'function') { try { pause(); } catch (_) {} }
      await window.loadBook(r.book.id);
      engine.paused = false;
    }
    await refreshPmBooks();
    toast(r.dup ? '已在书库中' : '已添加 · 开始阅读');
  }

  const pmImport = pm.querySelector('#cx-pm-import');
  if (pmImport) pmImport.addEventListener('click', importNovel);

  /* ＋ 菜单开关（阅读输入框与新聊天界面共用） */
  function togglePlusMenu(anchor) {
    if (pm.hidden) {
      pm.hidden = false;
      const r = anchor.getBoundingClientRect();
      pm.style.left = Math.max(8, Math.min(r.left - 6, window.innerWidth - 300)) + 'px';
      pm.style.bottom = Math.max(12, window.innerHeight - r.top + 8) + 'px';
      pm.style.top = 'auto';
      refreshPmBooks();
    } else {
      pm.hidden = true;
    }
  }
  /* 点击「点外关闭」时，两个 ＋ 按钮都算菜单自身的一部分 */
  function plusAnchorHit(e) {
    return [plusBtn, ncPlus].some((b) => b && (b === e.target || b.contains(e.target)));
  }

  const plusBtn = document.getElementById('cx-plus-btn');
  if (plusBtn) plusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlusMenu(plusBtn);
  });
  document.addEventListener('mousedown', (e) => {
    if (!pm.hidden && !pm.contains(e.target) && !plusAnchorHit(e)) pm.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pm.hidden) pm.hidden = true;
  });

  /* ---------------- 启动 ---------------- */
  render();
})();
