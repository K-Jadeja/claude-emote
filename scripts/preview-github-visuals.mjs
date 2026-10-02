#!/usr/bin/env node
// Local presentation wrapper around the unmodified, built desktop demo UI.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resources = resolve(root, "desktop/resources");
const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Claude Emote — demo gallery</title><style>
*{box-sizing:border-box}body{margin:0;background:#0c121c;color:#f8efd9;font-family:Segoe UI,system-ui,sans-serif}
main{width:1280px;margin:auto;padding:42px 48px 30px}
header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:22px}
h1{font-size:27px;font-weight:600;letter-spacing:-.7px;margin:0}
.eyebrow{font-family:Consolas,monospace;color:#f0b45a;font-size:12px;letter-spacing:2px;margin-bottom:9px}
.note{font-size:12px;color:#8793a8}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}
.tile{border:1px solid #273343;border-radius:10px;background:#111a27;overflow:hidden}
iframe{display:block;border:0;width:272px;height:324px;margin:10px auto 0}
.caption{padding:13px 17px 17px;border-top:1px solid #273343;font-size:12px;color:#a9b4c8}
.caption strong{display:block;color:#f8efd9;font-size:15px;margin-bottom:5px}
footer{margin-top:20px;color:#7c8ca4;font-size:11px;letter-spacing:.3px}
</style><main><header><div><div class="eyebrow">CLAUDE-EMOTE / IN MOTION</div><h1>A face for every part of the work.</h1></div><div class="note">Real application UI · synthetic demo events</div></header>
<section class="grid">
<article class="tile"><iframe title="Thinking demo" src="/app/"></iframe><div class="caption"><strong>Thinking</strong>Follow the session at a glance.</div></article>
<article class="tile"><iframe title="Reading demo" src="/app/"></iframe><div class="caption"><strong>Reading</strong>See when Claude opens a file.</div></article>
<article class="tile"><iframe title="Writing demo" src="/app/"></iframe><div class="caption"><strong>Writing</strong>A little focus while code takes shape.</div></article>
<article class="tile"><iframe title="Ready demo" src="/app/"></iframe><div class="caption"><strong>Ready</strong>Know when it is your turn.</div></article>
</section><footer>Windows desktop companion · Local lifecycle hooks · No extra model calls</footer></main></html>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
      return;
    }
    if (!pathname.startsWith("/app/")) { response.writeHead(404).end(); return; }
    const relative = decodeURIComponent(pathname.slice(5)) || "index.html";
    const path = resolve(resources, relative);
    if (!path.startsWith(resources + sep)) { response.writeHead(403).end(); return; }
    const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".ico": "image/x-icon" }[extname(path)] || "application/octet-stream";
    response.setHeader("content-type", mime);
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, "127.0.0.1", () => console.log(`VISUAL_PREVIEW http://127.0.0.1:${server.address().port}`));
