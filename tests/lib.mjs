// Shared bits for the gates: a scratch copy of the sample board, the CLI, and a server on a spare port.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "sketchcall.mjs");
export const SAMPLE = path.join(ROOT, "examples", "pizza.excalidraw");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };

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
// The board server, started the way a person starts it; resolves once it answers.
export async function serveBoard(dir, port) {
  const srv = spawn(process.execPath, [BIN, "serve", "--port", String(port)], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; srv.stderr.on("data", (d) => { err += d; });
  for (let i = 0; i < 50; i++) {
    if (srv.exitCode !== null) throw new Error(`the server exited: ${err}`);
    try { await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(500) }); return srv; } catch { await sleep(100); }
  }
  srv.kill(); throw new Error(`no server on ${port}: ${err}`);
}
// The sketchcall MCP server over stdio, recording every channel message it pushes.
export function mcpSession(args = []) {
  const p = spawn(process.execPath, [BIN, "mcp", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map(), notes = []; let n = 0, buf = "";
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
      const m = JSON.parse(l);
      if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      else if (m.method === "notifications/claude/channel") notes.push(m.params);
    }
  });
  const rpc = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  const call = async (name, args) => { const m = await rpc("tools/call", { name, arguments: args }); const text = m.result.content[0].text; let json = null; try { json = JSON.parse(text); } catch {}
    return { err: !!m.result.isError, text, json }; };
  return { p, rpc, notify, call, notes };
}
