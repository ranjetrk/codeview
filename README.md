# CodeView

A dead-simple **local content viewer**. Open a folder and browse code with syntax highlighting — but also render **images, PDFs, Excel, Word, CSV and Markdown**, paste anything from your clipboard, and search every file instantly. Built to run on your own machine (it serves your filesystem, so it's **local-only by design**), with a one-line integration so **Claude Code can push code straight into it**.

No accounts, no cloud, no build step. One `node` process, zero runtime dependencies.

---

## ✨ What it does

- **Universal viewer** — code (highlight.js), **images**, **PDF**, **Excel `.xlsx`** (multi-sheet tables), **Word `.docx`**, **CSV/TSV** tables, and **Markdown** (rendered, with a *Source* toggle).
- **Paste anything** — `⌘/Ctrl + V` anywhere shows a pasted image, a copied table, or text (auto-detected as a table or code).
- **Instant global search** — `⌘/Ctrl + F` opens a floating search popup over all your files, with match highlighting. Uses [ripgrep](https://github.com/BurntSushi/ripgrep) when available.
- **Curated projects** — pin the folders you care about (＋ in the sidebar); the sidebar is hidden by default and reveals with `⌘/Ctrl + B`.
- **Automatic backups** — every file you open is snapshotted (deduped by content) into `_backups/`, giving you a quiet version history. Clear it anytime from the sidebar footer.
- **Claude Code push** — ask Claude to "show this file" and it appears here instantly (see below).
- **Dark, modern UI.**

---

## 🚀 Quick start

```bash
git clone <your-repo-url> codeview
cd codeview
./install.sh
```

That's it — open **http://localhost:8910**.

`install.sh` is safe to re-run. It:
- provisions **ripgrep** (uses one on your `PATH`, or borrows a bundled one, or falls back to `grep`),
- on **Linux + systemd**, installs an always-on user service (auto-starts on login),
- links a **`codeview`** command into `~/.local/bin`.

### Run on demand (no service)
```bash
codeview               # start + open the browser
codeview ~/my/project  # open with that folder as the root
codeview --port 9000   # custom port
```
or plainly: `node server.mjs [folder]`.

**Requirements:** Node.js ≥ 18. ripgrep optional (recommended for fast search).

---

## 🤖 Claude Code integration

Add this to your global `~/.claude/CLAUDE.md` so Claude pushes code into CodeView when you ask it to *show / preview / open* something:

````md
# CodeView (local preview)
A local viewer runs at http://localhost:8910. When asked to show/preview/open code, push it:

Existing file:
```bash
curl -s -X POST http://localhost:8910/api/open -H "Content-Type: application/json" \
  -d '{"path":"<ABSOLUTE_PATH>","line":<LINE_OR_0>}'
```
New/untitled snippet (no file needed):
```bash
curl -s -X POST http://localhost:8910/api/open -H "Content-Type: application/json" \
  -d '{"content":"<CODE>","title":"example.ts","lang":"ts"}'
```
````

The open tab polls and renders whatever was pushed.

---

## 🔌 HTTP API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/tree?dir=` | list a directory |
| `GET` | `/api/file?path=` | text file content |
| `GET` | `/api/raw?path=` | raw bytes (images/xlsx/docx/pdf) |
| `GET` | `/api/search?q=` | global search |
| `GET` | `/api/current` | what was last pushed (UI polls this) |
| `POST` | `/api/open` | push a file `{path,line}` or inline `{content,title,lang}` |
| `GET`/`POST` | `/api/projects` · `/api/projects/add` · `/api/projects/remove` | curated folder list |
| `POST` | `/api/root` | set the browse root |
| `GET` | `/api/backups` · `POST /api/backups/clear` | backup history |

---

## ⚙️ Config

Environment variables (set in the service file or when running):

- `PORT` — default `8910`
- `ROOT` — default browse folder

Runtime data lives alongside the app and is **git-ignored**: `_backups/` (snapshots), `projects.json` (your pinned folders).

---

## 🔒 Note on safety

CodeView serves files from your machine over `localhost`. **Don't expose it to a public network** — keep it bound to `127.0.0.1` (the default).

---

## 🧹 Uninstall

```bash
./uninstall.sh
```
Removes the service and the `codeview` symlink. Your files and backups are left in place.

---

MIT © built with Claude Code
