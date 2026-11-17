// Shared bits for the gates: a scratch copy of the sample board, the CLI, and a server on a spare port.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.setMaxListeners(50);   // every server, session and browser a gate starts stops itself on exit
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "sketchcall.mjs");
export const SAMPLE = path.join(ROOT, "examples", "pizza.excalidraw");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };
// Ask every 100 ms until fn (sync or async) holds; returns the wait in ms, or -1 after `ms`. A throw counts as "not yet"
// (a page mid-reload, a record file not written yet), and so does a try that takes over 5 s (an evaluate in a frame that
// never got a page never returns). The gates wait from here, not with a timer inside the page: a page in a background tab
// runs its timers and network callbacks late when the machine is busy (measured: an op landed 0.4–5 s after the tab in
// front showed it, at load 25–30 on 10 cores).
export async function poll(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    let y = false; try { y = await Promise.race([fn(), sleep(5000).then(() => false)]); } catch { /* not yet */ }
    if (y) return Date.now() - t0;
    if (Date.now() - t0 >= ms) return -1;
    await sleep(100);
  }
}
// The same for a page's own state: settle returns the ms, until returns true or false.
export const settle = (p, fn, arg, ms) => poll(() => p.evaluate(fn, arg), ms);
export const until = async (p, fn, arg, ms) => (await settle(p, fn, arg, ms)) >= 0;
// A page has its first copy of the record: the dot turns on in the same step that ends that fetch. An op that arrives in the
// first fetch is history (a tour waits behind Resume), so a gate posts nothing before this.
export const joined = (p) => until(p, () => document.getElementById("dot").classList.contains("on"));

// The gates run on ports 4900–4940 only, each on a fresh copy of a board in the system's temp folder.
export function portArg(i, fallback) {
  const p = Number(process.argv[i] || fallback);
  if (!(p >= 4900 && p <= 4940)) { console.error(`use a spare port in 4900–4940 (got ${process.argv[i]})`); process.exit(2); }
  return p;
}
export function scratch(name, board = SAMPLE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `sketchcall-${name}-`));
  fs.copyFileSync(board, path.join(d, path.basename(board)));
  return d;
}
// `sketchcall <args>` in the board folder, as an agent's shell would run it.
export const cli = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: dir }).toString();
// The write key a page gets in its HTML (a fresh one each time the server starts), for a gate that posts like a page.
// `headers` lets a gate ask as a link guest.
export async function pageKey(url, headers = {}) {
  const h = await (await fetch(url, { headers })).text(), m = h.match(/var BOARD = (\{[^\n]*\});\n/);
  return m ? JSON.parse(m[1]).token : undefined;
}
// Everything a page gets in its HTML: the write key, and its own page id with that page's secret (the server issues a new
// pair each time it serves the page). From an older server without page ids, `c` is a made-up id and there's no secret.
export const credsIn = (html) => { const m = String(html).match(/var BOARD = (\{[^\n]*\});\n/), b = m ? JSON.parse(m[1]) : {};
  return { key: b.token, c: b.page || `pg${Math.random().toString(36).slice(2, 8)}`, secret: b.pageKey }; };
// A page's write: JSON, its key, the board's own Origin (what a browser sends) and, for calls naming its page id, its secret.
export const asPage = (key, origin, secret) => ({ "content-type": "application/json", ...(key ? { "x-sketchcall-key": key } : {}), ...(origin ? { origin } : {}),
  ...(secret ? { "x-sketchcall-page": secret } : {}) });
// The board server, started the way a person starts it; resolves once it answers.
export async function serveBoard(dir, port) {
  // A server left on the port (a killed run) would answer for this board and the gate would test the wrong folder.
  const busy = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} already serves a board: stop it first (lsof -ti tcp:${port} -sTCP:LISTEN)`);
  const srv = spawn(process.execPath, [BIN, "serve", "--port", String(port)], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; srv.stderr.on("data", (d) => { err += d; });
  process.on("exit", () => srv.kill());   // a test that crashes still stops its server
  for (let i = 0; i < 50; i++) {
    if (srv.exitCode !== null) throw new Error(`the server exited: ${err}`);
    try { await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(500) }); return srv; } catch { await sleep(100); }
  }
  srv.kill(); throw new Error(`no server on ${port}: ${err}`);
}
// The sketchcall MCP server over stdio, recording every channel message it pushes.
export function mcpSession(args = []) {
  const p = spawn(process.execPath, [BIN, "mcp", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  process.on("exit", () => p.kill());
  // notes: channel messages; others: every other notification (progress), stamped with when it came; answered: every reply
  const waiting = new Map(), notes = [], others = [], answered = []; let n = 0, buf = "";
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
      const m = JSON.parse(l);
      if (m.id != null) answered.push(m.id);
      if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      else if (m.method === "notifications/claude/channel") notes.push(m.params);
      else if (m.method) others.push({ ...m, at: Date.now() });
    }
  });
  const send = (method, params) => { const id = ++n; const done = new Promise((r) => waiting.set(id, r)); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return { id, done }; };
  const rpc = (method, params) => send(method, params).done;
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  const parse = (m) => { const text = m.result.content[0].text; let json = null; try { json = JSON.parse(text); } catch {} return { err: !!m.result.isError, text, json }; };
  const call = async (name, args) => parse(await rpc("tools/call", { name, arguments: args }));
  // A tool call started now and read later: its request id, and `done` for the reply. `meta` goes in as _meta.
  const start = (name, args, meta) => { const r = send("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }); return { id: r.id, done: r.done.then(parse) }; };
  return { p, rpc, notify, call, start, notes, others, answered };
}
