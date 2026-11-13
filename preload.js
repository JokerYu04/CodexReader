'use strict';
/* ============================================================
 *  preload.js — Codex 阅读器（独立项目）
 *  暴露 window.novelApi（与 engine.js 期望的接口一致）
 * ============================================================ */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('novelApi', {
  list: () => ipcRenderer.invoke('books:list'),
  state: () => ipcRenderer.invoke('state:get'),
  setState: (patch) => ipcRenderer.invoke('state:set', patch),
  import: () => ipcRenderer.invoke('books:importDialog'),
  importPath: (p) => ipcRenderer.invoke('books:importPath', p),
  remove: (id) => ipcRenderer.invoke('books:remove', id),
  log: (msg) => ipcRenderer.send('app:log', msg),
  getBook: (id) => ipcRenderer.invoke('books:get', id),
  saveProgress: (id, ch, msg) => ipcRenderer.invoke('progress:save', id, ch, msg),
  listNotes: (id) => ipcRenderer.invoke('books:notes:list', id),
  addNote: (id, note) => ipcRenderer.invoke('books:notes:add', id, note),
  removeNote: (id, noteId) => ipcRenderer.invoke('books:notes:remove', id, noteId),
  winControl: (action) => ipcRenderer.send('win:control', action),   // min | max | close
  onMaxState: (cb) => ipcRenderer.on('win:maxstate', (_e, v) => cb(v)),   // true=已最大化
  onControl: (cb) => ipcRenderer.on('control', (_e, payload) => cb(payload)),
  onStateChange: (cb) => ipcRenderer.on('state-change', (_e, s) => cb(s)),
  pathForFile: (file) => {
    try { if (webUtils && file && webUtils.getPathForFile(file)) return webUtils.getPathForFile(file); } catch (_) {}
    try { return (file && file.path) || ''; } catch (_) { return ''; }
  },
});
