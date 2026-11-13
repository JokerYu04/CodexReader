'use strict';
/* ============================================================
 *  main.js — Codex 阅读器（独立项目）主进程
 *  单窗口：Codex 桌面客户端风格阅读界面
 *  书库存储 / txt / epub 解析复用 src/store.js、src/parse.js、src/epub.js
 * ============================================================ */
const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./src/store');

const TEXT_EXT = ['txt', 'text', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'ini'];
const EPUB_EXT = ['epub'];

let THEME = 'dark';
let win = null;
let DATA_DIR = '';

function log(msg) {
  try {
    fs.appendFileSync(path.join(DATA_DIR || app.getPath('userData'), 'app.log'),
      `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

function dataDir() {
  const d = path.join(__dirname, 'data');
  try {
    fs.mkdirSync(path.join(d, 'books'), { recursive: true });
    fs.accessSync(d, fs.constants.W_OK);
    return d;
  } catch (_) {
    return app.getPath('userData');
  }
}

function makeWindow() {
  const w = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    resizable: true,
    frame: false,          // 无边框：顶栏由前端自绘（菜单栏 + 窗口按钮，仿真 Codex）
    title: 'Codex',
    backgroundColor: '#131313',
    icon: path.join(__dirname, 'icon.ico'),
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  w.loadFile(path.join(__dirname, 'frontend', 'reader.html'));
  return w;
}

/* 拖入文件夹时递归取书 */
function collectBookFiles(dir, depth) {
  const out = [];
  if (depth > 3) return out;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const fp = path.join(dir, n);
    let st = null;
    try { st = fs.statSync(fp); } catch (_) { continue; }
    if (st.isDirectory()) out.push(...collectBookFiles(fp, depth + 1));
    else if (st.isFile() && [...TEXT_EXT, ...EPUB_EXT].includes(path.extname(n).toLowerCase().replace('.', ''))) out.push(fp);
  }
  return out;
}

function importPath(p) {
  try {
    let st = null;
    try { st = fs.statSync(p); } catch (_) {}
    if (st && st.isDirectory()) {
      const files = collectBookFiles(p, 0);
      if (!files.length) return { ok: false, error: '文件夹里没有 txt / epub' };
      const done = [];
      let last = null;
      for (const f of files) { last = importPath(f); if (last && last.ok) done.push(last); }
      return { ok: done.length > 0, batch: true, count: done.length, total: files.length, last, error: done.length ? '' : (last && last.error) };
    }

    let raw;
    try { raw = fs.readFileSync(p); } catch (e) { return { ok: false, error: '文件不存在或无法读取' }; }
    if (!raw.length) return { ok: false, error: '空文件' };
    const ext = path.extname(p).toLowerCase().replace('.', '');
    const title = path.basename(p, path.extname(p));
    const dup = store.listBooks().some((b) => b.path === p);
    if (dup) {
      const exist = store.listBooks().find((b) => b.path === p);
      return { ok: true, dup: true, book: exist, error: '已在书库中' };
    }

    if (EPUB_EXT.includes(ext) || (raw.length > 4 && raw[0] === 0x50 && raw[1] === 0x4B)) {
      const { parseEpub } = require('./src/epub');
      return parseEpub(p, {})
        .then((meta) => {
          const t = (meta.book_title && meta.book_title.length >= 2) ? meta.book_title : title;
          return store.addBook({
            path: p, title: t,
            encoding: meta.encoding,
            chapters: meta.chapters,
            para_count: meta.chapters.reduce((s, c) => s + c.paras.length, 0),
            char_count: meta.char_count,
            split_mode: 'epub',
          });
        })
        .catch((e) => ({ ok: false, error: 'EPUB 解析失败: ' + (e && e.message || e) }));
    }

    const { parseText } = require('./src/parse');
    const meta = parseText(raw, { mode: 'auto', chunkSize: 5000, ext });
    const res = store.addBook({ path: p, title, ...meta });
    log('importPath 成功: ' + title + ' / ' + (res.book && res.book.chapter_count) + ' 段');
    return res;
  } catch (e) {
    log('importPath 异常: ' + (e && e.stack || e));
    return { ok: false, error: '解析失败: ' + (e && e.message || e) };
  }
}

function registerIpc() {
  ipcMain.handle('books:list', () => ({ ok: true, books: store.listBooks() }));
  ipcMain.handle('books:get', (_e, id) => store.getBook(id));
  ipcMain.handle('books:remove', (_e, id) => store.removeBook(id));
  ipcMain.handle('books:importDialog', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '添加小说（txt / md / epub）',
        filters: [
          { name: '支持的文件', extensions: [...TEXT_EXT, ...EPUB_EXT] },
          { name: '文本文件', extensions: TEXT_EXT },
          { name: 'EPUB 电子书', extensions: EPUB_EXT },
          { name: '所有文件', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, error: 'cancel' };
      return importPath(r.filePaths[0]);
    } catch (e) {
      return { ok: false, error: '对话框异常: ' + (e && e.message || e) };
    }
  });
  ipcMain.handle('books:importPath', (_e, p) => importPath(p));
  ipcMain.handle('books:notes:list', (_e, id) => store.listNotes(id));
  ipcMain.handle('books:notes:add', (_e, id, note) => store.addNote(id, note));
  ipcMain.handle('books:notes:remove', (_e, id, noteId) => store.removeNote(id, noteId));
  ipcMain.handle('progress:save', (_e, id, ch, msg) => store.saveProgress(id, ch, msg));
  ipcMain.handle('state:get', () => ({ ok: true, state: store.loadState() }));
  ipcMain.handle('state:set', (_e, patch) => ({ ok: true, state: store.updateState(patch) }));
  ipcMain.on('app:log', (_e, msg) => log(String(msg)));
  // 自绘顶栏的窗口控制（最小化 / 最大化还原 / 关闭）
  ipcMain.on('win:control', (_e, action) => {
    if (!win || win.isDestroyed()) return;
    if (action === 'min') win.minimize();
    else if (action === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
  });
}

function bootstrap() {
  DATA_DIR = dataDir();
  log('启动 dataDir=' + DATA_DIR);
  store.init(DATA_DIR);
  registerIpc();
  Menu.setApplicationMenu(null);
  win = makeWindow();
  // 最大化状态推给渲染层（顶栏「最大化/还原」图标跟随切换）
  const sendMaxState = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maxstate', win.isMaximized());
  };
  win.on('maximize', sendMaxState);
  win.on('unmaximize', sendMaxState);
  win.webContents.on('did-finish-load', () => {
    sendMaxState();   // 启动时同步一次当前状态
    // 启动后自动恢复上次阅读的书（有书才推 bookId）
    const s = store.loadState();
    if (s && s.bookId) win.webContents.send('control', { cmd: 'book', arg: s.bookId });
  });
  app.on('window-all-closed', () => app.quit());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.whenReady().then(bootstrap);
}
