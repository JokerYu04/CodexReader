'use strict';
/* ============================================================
 *  store.js — 书库 / 进度 / 状态持久化
 *  data/
 *    library.json   元信息：{ books:{id:meta}, order:[id...] }
 *    state.json     全局：{ bookId, chapter, msg, paused, speed }
 *    books/<id>.json 章节内容：{ chapters:[...] }
 *  章节与元信息分离：save_progress 只改 library.json，不重写整本小说。
 * ============================================================ */
const fs = require('fs');
const path = require('path');

let DATA = '';
let LIB = '';
let STATE = '';
let BOOKS = '';
let SETTINGS = '';

function init(dir) {
  DATA = dir;
  LIB = path.join(dir, 'library.json');
  STATE = path.join(dir, 'state.json');
  BOOKS = path.join(dir, 'books');
  SETTINGS = path.join(dir, 'settings.json');
  fs.mkdirSync(BOOKS, { recursive: true });
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return fallback; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}

function loadLib() {
  const lib = readJson(LIB, { books: {}, order: [] });
  if (!Array.isArray(lib.folders)) lib.folders = [];   // [{id,name,expanded}]
  if (!Array.isArray(lib.order)) lib.order = [];
  return lib;
}
function saveLib(lib) { writeJson(LIB, lib); }

function loadState() {
  return readJson(STATE, { bookId: null, chapter: 0, msg: 0, paused: true, speed: 5 });
}
function saveState(s) { writeJson(STATE, s); }

/* 应用级设置（外观主题等）。theme: 'light' | 'dark' | 'system' */
function loadSettings() {
  const s = readJson(SETTINGS, {});
  if (!['light', 'dark', 'system'].includes(s.theme)) s.theme = 'system';
  return s;
}
function saveSettings(patch) {
  const s = Object.assign(loadSettings(), patch || {});
  writeJson(SETTINGS, s);
  return s;
}

function metaOnly(b) {
  const { chapters, ...meta } = b;
  return meta;
}
function getBookDoc(id) {
  const file = path.join(BOOKS, id + '.json');
  return readJson(file, null);
}
function saveBookDoc(id, chapters) {
  writeJson(path.join(BOOKS, id + '.json'), { chapters });
}

function listBooks() {
  const lib = loadLib();
  const out = [];
  for (const id of lib.order) {
    const b = lib.books[id];
    if (!b) continue;
    if (!fs.existsSync(b.path)) continue;
    out.push({ ...metaOnly(b), missing: false });
  }
  return out;
}

function getBook(id) {
  const lib = loadLib();
  const b = lib.books[id];
  if (!b) return { ok: false, error: 'not found' };
  const doc = getBookDoc(id);
  if (!doc) return { ok: false, error: 'content missing' };
  return { ok: true, book: { ...metaOnly(b), chapters: doc.chapters } };
}

function addBook({ path: p, title, chapters, encoding, para_count, split_mode, char_count }) {
  const lib = loadLib();
  const id = 'bk_' + Date.now() + '_' + Math.floor(Math.random() * 1e4);
  const meta = {
    id, title, path: p, size: fs.statSync(p).size,
    added_at: new Date().toLocaleString('sv'),
    last_read_at: new Date().toLocaleString('sv'),
    progress: { chapter: 0, msg: 0 },
    encoding, para_count, chapter_count: chapters.length,
    split_mode: split_mode || 'length',
    char_count: char_count || 0,
  };
  lib.books[id] = meta;
  lib.order.push(id);
  saveLib(lib);
  saveBookDoc(id, chapters);
  const s = loadState();
  saveState({ ...s, bookId: id, chapter: 0, msg: 0, paused: true });
  return { ok: true, book: metaOnly(meta) };
}

function removeBook(id) {
  const lib = loadLib();
  delete lib.books[id];
  lib.order = lib.order.filter((x) => x !== id);
  saveLib(lib);
  try { fs.unlinkSync(path.join(BOOKS, id + '.json')); } catch (_) {}
  const s = loadState();
  if (s.bookId === id) saveState({ ...s, bookId: null, chapter: 0, msg: 0 });
  return { ok: true };
}

function saveProgress(id, chapter, msg) {
  const lib = loadLib();
  const b = lib.books[id];
  if (b) {
    b.progress = { chapter: chapter | 0, msg: msg | 0 };
    b.last_read_at = new Date().toLocaleString('sv');   // 首页「最近阅读」/ 最近书籍排序用
    saveLib(lib);
  }
  return { ok: true };
}

function renameBook(id, title) {
  // 只改阅读器顶栏显示名（display_title），不动小说本身的书名
  const lib = loadLib();
  const b = lib.books[id];
  if (!b) return { ok: false, error: 'not found' };
  const t = String(title || '').trim().slice(0, 120);
  if (!t) return { ok: false, error: '标题不能为空' };
  b.display_title = t;
  saveLib(lib);
  return { ok: true, display_title: t };
}

function resetDisplayTitle(id) {
  const lib = loadLib();
  const b = lib.books[id];
  if (!b) return { ok: false, error: 'not found' };
  delete b.display_title;
  saveLib(lib);
  return { ok: true, display_title: '' };
}

/* ---------- 书库布局：文件夹 / 拖动排序 / 置顶 ----------
 * library.json 结构：
 *   books   : { id: meta }           meta.folder = 文件夹 id | null
 *   order   : [id...]                全局顺序（同容器内相对顺序据此推导）
 *   folders : [{ id, name, expanded }]
 * ============================================================ */
function fid() { return 'fd_' + Date.now() + '_' + Math.floor(Math.random() * 1e4); }

function listLayout() {
  const lib = loadLib();
  const folders = lib.folders.map((f) => ({ ...f }));
  const byFolder = {};
  for (const f of folders) byFolder[f.id] = [];
  const rootBooks = [];
  for (const id of lib.order) {
    const b = lib.books[id];
    if (!b) continue;
    const fidIn = b.folder || null;
    if (fidIn && byFolder[fidIn]) byFolder[fidIn].push(id);
    else rootBooks.push(id);
  }
  const books = {};
  for (const id of lib.order) {
    const b = lib.books[id];
    if (!b) continue;
    books[id] = { ...metaOnly(b), missing: !fs.existsSync(b.path || '') };
  }
  return { ok: true, folders, byFolder, rootBooks, books };
}

/* UI 计算好完整布局后一次性回写 */
function setLayout({ folders, byFolder, rootBooks }) {
  const lib = loadLib();
  if (Array.isArray(folders)) {
    const map = new Map(lib.folders.map((f) => [f.id, f]));
    const next = [];
    for (const id of folders) { const f = map.get(id); if (f) { next.push(f); map.delete(id); } }
    for (const f of map.values()) next.push(f);      // 未提及的文件夹补到末尾
    lib.folders = next;
  }
  const byF = byFolder || {};
  const newOrder = [];
  const seen = new Set();
  for (const f of lib.folders) {
    const ids = Array.isArray(byF[f.id]) ? byF[f.id] : [];
    for (const id of ids) {
      if (!lib.books[id] || seen.has(id)) continue;
      lib.books[id].folder = f.id;
      newOrder.push(id); seen.add(id);
    }
  }
  if (Array.isArray(rootBooks)) {
    for (const id of rootBooks) {
      if (!lib.books[id] || seen.has(id)) continue;
      lib.books[id].folder = null;
      newOrder.push(id); seen.add(id);
    }
  }
  // 布局里没提到的书：保持原有归属与原顺序补在末尾
  for (const id of lib.order) {
    if (!lib.books[id] || seen.has(id)) continue;
    newOrder.push(id); seen.add(id);
  }
  for (const id of Object.keys(lib.books)) {
    if (seen.has(id)) continue;
    newOrder.push(id); seen.add(id);
  }
  lib.order = newOrder;
  saveLib(lib);
  return { ok: true };
}

function createFolder(name) {
  const lib = loadLib();
  const n = String(name || '').trim().slice(0, 60) || '新建文件夹';
  const f = { id: fid(), name: n, expanded: true, created_at: new Date().toLocaleString('sv') };
  lib.folders.push(f);
  saveLib(lib);
  return { ok: true, folder: f };
}
function renameFolder(id, name) {
  const lib = loadLib();
  const f = lib.folders.find((x) => x.id === id);
  if (!f) return { ok: false, error: 'not found' };
  const n = String(name || '').trim().slice(0, 60);
  if (!n) return { ok: false, error: '名称不能为空' };
  f.name = n;
  saveLib(lib);
  return { ok: true, name: n };
}
function removeFolder(id) {
  const lib = loadLib();
  const i = lib.folders.findIndex((x) => x.id === id);
  if (i === -1) return { ok: false, error: 'not found' };
  lib.folders.splice(i, 1);
  // 文件夹里的书回到根目录（保留相对顺序）
  for (const bid of lib.order) {
    const b = lib.books[bid];
    if (b && b.folder === id) b.folder = null;
  }
  saveLib(lib);
  return { ok: true };
}
function toggleFolder(id, expanded) {
  const lib = loadLib();
  const f = lib.folders.find((x) => x.id === id);
  if (!f) return { ok: false, error: 'not found' };
  f.expanded = expanded === undefined ? !f.expanded : !!expanded;
  saveLib(lib);
  return { ok: true, expanded: f.expanded };
}

/* 置顶：标记 + 挪到所在容器最前 */
function pinBook(id, on) {
  const lib = loadLib();
  const b = lib.books[id];
  if (!b) return { ok: false, error: 'not found' };
  b.pinned = !!on;
  lib.order = lib.order.filter((x) => x !== id);
  if (on) {
    const container = b.folder || null;
    const insertAt = (() => {
      if (!container) {
        const firstRootIdx = lib.order.findIndex((x) => !lib.books[x] || !lib.books[x].folder);
        return firstRootIdx === -1 ? lib.order.length : firstRootIdx;
      }
      const idx = lib.order.findIndex((x) => lib.books[x] && lib.books[x].folder === container);
      return idx === -1 ? lib.order.length : idx;
    })();
    lib.order.splice(insertAt, 0, id);
  } else {
    lib.order.push(id);
  }
  saveLib(lib);
  return { ok: true, pinned: b.pinned };
}

/* 书库页改名：改真实书名（伪装名 display_title 保留不变） */
function renameBookTitle(id, title) {
  const lib = loadLib();
  const b = lib.books[id];
  if (!b) return { ok: false, error: 'not found' };
  const t = String(title || '').trim().slice(0, 120);
  if (!t) return { ok: false, error: '书名不能为空' };
  b.title = t;
  saveLib(lib);
  return { ok: true, title: t };
}

/* 伪装书名（阅读界面顶栏显示用）；置空即删除、回落到真实书名 */
function setDisplayTitle(id, title) {
  const lib = loadLib();
  const b = lib.books[id];
  if (!b) return { ok: false, error: 'not found' };
  const t = String(title || '').trim().slice(0, 120);
  if (!t) delete b.display_title;
  else b.display_title = t;
  saveLib(lib);
  return { ok: true, display_title: b.display_title || '' };
}

function moveBookToFolder(id, folderId) {
  const lib = loadLib();
  const b = lib.books[id];
  if (!b) return { ok: false, error: 'not found' };
  const target = folderId || null;
  if (target && !lib.folders.some((f) => f.id === target)) return { ok: false, error: 'folder not found' };
  b.folder = target;
  lib.order = lib.order.filter((x) => x !== id);
  let at = lib.order.length;
  if (target) {
    let last = -1;
    lib.order.forEach((x, i) => { if (lib.books[x] && lib.books[x].folder === target) last = i; });
    at = last === -1 ? lib.order.length : last + 1;
  } else {
    let last = -1;
    lib.order.forEach((x, i) => { if (!lib.books[x] || !lib.books[x].folder) last = i; });
    at = last === -1 ? lib.order.length : last + 1;
  }
  lib.order.splice(at, 0, id);
  saveLib(lib);
  return { ok: true, folder: target };
}

/* ---------- 划线 / 批注（存在书目 meta 里，随 library.json 持久化） ---------- */
function listNotes(bookId) {
  const lib = loadLib();
  const b = lib.books[bookId];
  return { ok: true, notes: (b && b.notes) || [] };
}
function addNote(bookId, note) {
  const lib = loadLib();
  const b = lib.books[bookId];
  if (!b) return { ok: false, error: 'not found' };
  if (!b.notes) b.notes = [];
  const rec = {
    id: 'nt_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
    chapter: note.chapter | 0,
    type: note.type === 'note' ? 'note' : 'hl',   // hl=划线 note=批注
    quote: String(note.quote || '').slice(0, 500),
    note: String(note.note || '').slice(0, 2000),
    created_at: new Date().toLocaleString('sv'),
  };
  b.notes.push(rec);
  saveLib(lib);
  return { ok: true, note: rec };
}
function removeNote(bookId, noteId) {
  const lib = loadLib();
  const b = lib.books[bookId];
  if (!b || !Array.isArray(b.notes)) return { ok: false, error: 'not found' };
  b.notes = b.notes.filter((n) => n.id !== noteId);
  saveLib(lib);
  return { ok: true };
}

function updateState(patch) {
  const s = { ...loadState(), ...patch };
  saveState(s);
  return s;
}

module.exports = {
  init, listBooks, getBook, addBook, removeBook, saveProgress,
  loadState, saveState, updateState, renameBook, resetDisplayTitle,
  listNotes, addNote, removeNote,
  listLayout, setLayout, createFolder, renameFolder, removeFolder, toggleFolder,
  pinBook, renameBookTitle, setDisplayTitle, moveBookToFolder,
  loadSettings, saveSettings,
};
