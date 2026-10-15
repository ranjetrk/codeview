#!/usr/bin/env node
// CodeView — a dead-simple local code viewer.
//   - Open a folder, browse the tree, view files with syntax highlighting
//   - Global search (ripgrep, grep fallback)
//   - Claude Code can push a file to preview:  POST /api/open {path}
// Run:  node server.mjs [rootFolder]     (default root = ~/my-projects)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8899);
let ROOT = path.resolve(process.env.ROOT || process.argv[2] || path.join(os.homedir(), 'my-projects'));
if (!fs.existsSync(ROOT)) ROOT = os.homedir();
let current = { path: '', content: null, title: '', ext: '', line: 0, v: 0 };   // what Claude pushed, polled by the UI (file OR inline snippet)

const IGNORE = new Set(['.git', 'node_modules', '.next', '_next', 'dist', 'build', 'out', 'vendor', '.cache', '.turbo', 'venv', '.venv', '__pycache__', 'coverage', '.idea', '.vscode', '_backups']);
const TEXT_MAX = 2 * 1024 * 1024;
const RAW_MAX = 40 * 1024 * 1024;   // cap for raw byte serving (images / xlsx / docx / pdf)
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8'
};

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

function listDir(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  return ents
    .filter(e => !(e.isDirectory() && IGNORE.has(e.name)) && e.name !== '.DS_Store')
    .map(e => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
}
function looksBinary(buf) { const n = Math.min(buf.length, 1000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }

// ── Backups: snapshot every file opened in CodeView, deduped by content hash, into _backups/.
// One copy per distinct (path + content) → a version history of everything you've viewed. Clearable.
const BK_DIR = path.join(DIR, '_backups');
const BK_INDEX = path.join(BK_DIR, 'index.json');
const BK_MAX = 10 * 1024 * 1024;
let bkIndex = null;
function bkLoad() { if (bkIndex) return bkIndex; try { bkIndex = JSON.parse(fs.readFileSync(BK_INDEX, 'utf8')); } catch { bkIndex = { items: {} }; } if (!bkIndex.items) bkIndex.items = {}; return bkIndex; }
function bkSave() { try { fs.mkdirSync(BK_DIR, { recursive: true }); fs.writeFileSync(BK_INDEX, JSON.stringify(bkIndex)); } catch (e) {} }
function backupFile(fp) {
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size > BK_MAX) return;
    if (path.resolve(fp).startsWith(BK_DIR)) return;                 // never back up our own backups
    const idx = bkLoad();
    const buf = fs.readFileSync(fp);
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const key = fp + '@' + hash;
    if (idx.items[key]) { idx.items[key].lastSeen = Date.now(); idx.items[key].count = (idx.items[key].count || 1) + 1; bkSave(); return; }
    const ext = path.extname(fp);
    const base = path.basename(fp, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = base + '__' + stamp + '__' + hash + ext;
    fs.mkdirSync(BK_DIR, { recursive: true });
    fs.writeFileSync(path.join(BK_DIR, fname), buf);
    idx.items[key] = { orig: fp, file: fname, size: st.size, hash, first: Date.now(), lastSeen: Date.now(), count: 1 };
    bkSave();
  } catch (e) {}
}

// User-curated project list (persisted) — NOT auto-scanned.
const PROJ_FILE = path.join(DIR, 'projects.json');
function loadProjects() { try { const a = JSON.parse(fs.readFileSync(PROJ_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function saveProjects(a) { try { fs.writeFileSync(PROJ_FILE, JSON.stringify(a, null, 2)); } catch (e) {} }
function projName(fp) { const base = path.join(os.homedir(), 'my-projects'); const rel = path.relative(base, fp); return (rel && !rel.startsWith('..')) ? rel : path.basename(fp); }

const SEARCH_IGNORE = ['node_modules', '.git', 'dist', '.next', '_next', 'build', 'out', 'vendor', 'coverage', '.cache', '.turbo', 'venv', '.venv', '__pycache__', '_backups', '.idea', '.vscode'];
// Prefer our bundled ripgrep (the systemd PATH has no rg); fall back to PATH rg, then grep.
const RG = fs.existsSync(path.join(DIR, 'bin', 'rg')) ? path.join(DIR, 'bin', 'rg') : 'rg';
function searchRepo(q, root, cb) {
  const rgArgs = ['-n', '-S', '--no-heading', '--color=never', '--max-count', '200', '--max-filesize', '1M'];
  SEARCH_IGNORE.forEach(d => { rgArgs.push('-g', '!**/' + d + '/**'); });
  ['!*.min.js', '!*.min.css', '!*.map', '!*.lock', '!*.bundle.js'].forEach(g => { rgArgs.push('-g', g); });
  rgArgs.push('--', q, root);
  execFile(RG, rgArgs, { maxBuffer: 8 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
    if ((err && err.code === 'ENOENT')) {
      const grepArgs = ['-rniI', '-m', '200'];
      SEARCH_IGNORE.forEach(d => grepArgs.push('--exclude-dir=' + d));
      ['*.min.js', '*.min.css', '*.map'].forEach(g => grepArgs.push('--exclude=' + g));
      grepArgs.push('--', q, root);
      execFile('grep', grepArgs, { maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (e2, out2) => cb(parseMatches(out2 || '', root)));
      return;
    }
    cb(parseMatches(stdout || '', root));
  });
}
function parseMatches(out, root) {
  return out.split('\n').filter(Boolean).slice(0, 200).map(l => {
    const m = l.match(/^(.*?):(\d+):(.*)$/); if (!m) return null;
    return { path: m[1], rel: path.relative(root, m[1]), line: +m[2], text: m[3].slice(0, 300) };
  }).filter(Boolean);
}
function readBody(req, cb) { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { cb({}); } }); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(DIR, 'index.html')));
  if (p === '/favicon.svg' || p === '/favicon.ico') {
    try { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' }); res.end(fs.readFileSync(path.join(DIR, 'favicon.svg'))); } catch (e) { send(res, 404, 'text/plain', 'not found'); }
    return;
  }
  if (p === '/api/config') return json(res, 200, { root: ROOT, home: os.homedir() });
  if (p === '/api/projects') return json(res, 200, { projects: loadProjects() });
  if (p === '/api/projects/add' && req.method === 'POST') {
    return readBody(req, b => {
      const abs = path.resolve(b.path || '');
      if (!(fs.existsSync(abs) && fs.statSync(abs).isDirectory())) return json(res, 404, { error: 'folder not found' });
      const list = loadProjects();
      if (!list.some(x => x.path === abs)) { list.push({ name: projName(abs), path: abs }); list.sort((a, b) => a.name.localeCompare(b.name)); saveProjects(list); }
      json(res, 200, { ok: true, projects: list });
    });
  }
  if (p === '/api/projects/remove' && req.method === 'POST') {
    return readBody(req, b => {
      const abs = path.resolve(b.path || '');
      const list = loadProjects().filter(x => x.path !== abs);
      saveProjects(list);
      json(res, 200, { ok: true, projects: list });
    });
  }
  if (p === '/api/tree') {
    const dir = u.searchParams.get('dir') ? path.resolve(u.searchParams.get('dir')) : ROOT;
    return json(res, 200, { dir, entries: listDir(dir) });
  }
  if (p === '/api/file') {
    const fp = path.resolve(u.searchParams.get('path') || '');
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) return json(res, 400, { error: 'not a file' });
      if (st.size > TEXT_MAX) return json(res, 200, { path: fp, content: '(file too large to preview — ' + st.size + ' bytes)', ext: '' });
      const buf = fs.readFileSync(fp);
      if (looksBinary(buf)) return json(res, 200, { path: fp, content: '(binary file)', ext: '' });
      backupFile(fp);
      return json(res, 200, { path: fp, content: buf.toString('utf8'), ext: path.extname(fp).slice(1).toLowerCase() });
    } catch (e) { return json(res, 404, { error: 'not found' }); }
  }
  // Raw bytes with a real content-type — the browser renders images/xlsx/docx/pdf from this.
  if (p === '/api/raw') {
    const fp = path.resolve(u.searchParams.get('path') || '');
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) return send(res, 400, 'text/plain', 'not a file');
      if (st.size > RAW_MAX) return send(res, 413, 'text/plain', 'file too large');
      const ext = path.extname(fp).slice(1).toLowerCase();
      backupFile(fp);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': st.size });
      fs.createReadStream(fp).pipe(res);
    } catch (e) { send(res, 404, 'text/plain', 'not found'); }
    return;
  }
  if (p === '/api/search') {
    const q = u.searchParams.get('q') || '';
    if (q.trim().length < 2) return json(res, 200, { results: [] });
    return searchRepo(q, ROOT, results => json(res, 200, { results }));
  }
  if (p === '/api/backups') {
    const items = Object.values(bkLoad().items).sort((a, b) => b.lastSeen - a.lastSeen);
    return json(res, 200, { dir: BK_DIR, count: items.length, items });
  }
  if (p === '/api/backups/clear' && req.method === 'POST') {
    try { fs.rmSync(BK_DIR, { recursive: true, force: true }); } catch (e) {}
    bkIndex = { items: {} };
    return json(res, 200, { ok: true });
  }
  if (p === '/api/current') return json(res, 200, current);
  if (p === '/api/open' && req.method === 'POST') {
    return readBody(req, b => {
      // (1) Inline / untitled code — Claude pushes raw content with no file on disk.
      if (typeof b.content === 'string' && b.content.length) {
        const ext = (b.lang || b.ext || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
        current = { path: '', content: b.content.slice(0, TEXT_MAX), title: (b.title || b.name || 'Untitled').toString().slice(0, 120), ext, line: b.line || 0, v: current.v + 1 };
        return json(res, 200, { ok: true, untitled: true });
      }
      // (2) Existing file on disk.
      const abs = path.resolve(b.path || '');
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        current = { path: abs, content: null, title: '', ext: '', line: b.line || 0, v: current.v + 1 };
        if (!abs.startsWith(ROOT)) ROOT = path.dirname(abs);   // widen root so the tree shows it
        return json(res, 200, { ok: true, path: abs });
      }
      json(res, 404, { error: 'file not found' });
    });
  }
  if (p === '/api/root' && req.method === 'POST') {
    return readBody(req, b => {
      const abs = path.resolve(b.path || '');
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { ROOT = abs; return json(res, 200, { ok: true, root: ROOT }); }
      json(res, 404, { error: 'folder not found' });
    });
  }
  send(res, 404, 'text/plain', 'not found');
});
server.listen(PORT, '127.0.0.1', () => console.log('CodeView → http://127.0.0.1:' + PORT + '  root=' + ROOT));
