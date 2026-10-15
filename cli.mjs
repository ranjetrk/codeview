#!/usr/bin/env node
// codeview CLI — start the viewer (foreground) and open it in the browser.
//   codeview [folder]           open with that folder as the root
//   codeview --port 8910        pick a port (default 8910)
//   codeview --no-open          don't auto-open the browser
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let port = process.env.PORT || '8910', root = '', open = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--port' || a === '-p') port = args[++i];
  else if (a === '--no-open') open = false;
  else if (a === '-h' || a === '--help') { console.log('Usage: codeview [folder] [--port N] [--no-open]'); process.exit(0); }
  else if (!a.startsWith('-')) root = path.resolve(a);
}

const env = { ...process.env, PORT: port };
if (root) env.ROOT = root;
const srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, stdio: 'inherit' });

if (open) {
  const url = 'http://localhost:' + port + '/';
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  setTimeout(() => { try { execFile(cmd, [url]); } catch (e) {} }, 700);
}

const bye = () => { try { srv.kill(); } catch (e) {} process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
srv.on('exit', c => process.exit(c || 0));
