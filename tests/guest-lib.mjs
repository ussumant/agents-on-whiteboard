// Helpers shared by the security gates from round 3 on: raw HTTP requests, a board with a simulated share link (a
// share.json with a known key and this process's pid, a trycloudflare.com Host, a cf-connecting-ip header and the key
// cookie), headless browsers that are always killed, and a clean visitor's load time.
import fs from "node:fs"; import http from "node:http";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer";
import { sleep, scratch, serveBoard, poll, credsIn, asPage, BIN } from "./lib.mjs";
import * as S from "../src/server.mjs";

export const TUNNEL = "quiet-test-guest.trycloudflare.com", LINK = "a-test-link-key-0123456789abcdef";
export const guestAt = (ip) => ({ "cf-connecting-ip": ip, cookie: `bk=${LINK}` });
export const guestHead = guestAt("203.0.113.7");
export function hit(port, pth, { method = "GET", host, headers = {}, body, wait = 30000, chunked = false } = {}) {
  return new Promise((done) => {
    const data = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const h = { host: host || `localhost:${port}`, ...headers }; if (data && !chunked) h["content-length"] = data.length;
    const r = http.request({ host: "127.0.0.1", port, path: pth, method, headers: h, setHost: false, agent: false }, (s) => {
      const parts = []; s.on("data", (c) => parts.push(c)); s.on("end", () => done({ status: s.statusCode, body: Buffer.concat(parts).toString(), bytes: parts.reduce((t, c) => t + c.length, 0), headers: s.headers }));
      s.on("error", (e) => done({ status: 0, body: e.code || e.message, bytes: 0 }));
    });
    r.on("error", (e) => done({ status: 0, body: e.code || e.message, bytes: 0 })); r.setTimeout(wait, () => r.destroy(new Error("no answer")));
    if (data) { if (chunked) { for (let i = 0; i < data.length; i += 65536) r.write(data.subarray(i, i + 65536)); } else r.write(data); }
    r.end();
  });
}
export const json = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
export const alive = async (port) => (await hit(port, "/api/hello", { wait: 3000 })).status === 200;
export const sceneOf = (dir) => JSON.parse(fs.readFileSync(S.files(dir).scene, "utf8")).elements;
export const run = (cwd, args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", timeout: 30000, ...extra });

// A board on `port` with the link open. `planted` is a scene.json written before the server starts; `before(dir)` runs then too.
export async function board(port, name, { planted, before, prefix = "sec" } = {}) {
  const dir = scratch(`${prefix}-${name}`);
  if (planted) { fs.mkdirSync(S.files(dir).live, { recursive: true }); fs.writeFileSync(S.files(dir).scene, JSON.stringify({ elements: planted })); }
  if (before) before(dir);
  const srv = await serveBoard(dir, port);
  fs.writeFileSync(S.files(dir).share, JSON.stringify({ key: LINK, pid: process.pid, port, url: `https://${TUNNEL}` }), { mode: 0o600 });
  const home = credsIn((await hit(port, "/")).body), guest = credsIn((await hit(port, "/", { host: TUNNEL, headers: guestHead })).body);
  const head = (who, g = guest, ip = "203.0.113.7") => who === "guest" ? { ...asPage(g.key, `https://${TUNNEL}`, g.secret), ...guestAt(ip) } : asPage(home.key, `http://localhost:${port}`, home.secret);
  const post = (who, pth, body, g, ip, opts = {}) => hit(port, pth, { method: "POST", host: who === "guest" ? TUNNEL : undefined, body, headers: head(who, g, ip), ...opts });
  const scene = (who, elements) => post(who, "/api/scene", { c: (who === "guest" ? guest : home).c, name: who === "guest" ? "Alex" : undefined, elements });
  return { dir, srv, port, home, guest, head, post, scene, stop: async () => { srv.kill(); await poll(async () => !(await alive(port)), 5000); } };
}

export const browsers = [];
export const launch = async () => { const b = await puppeteer.launch({ headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] }); browsers.push(b); return b; };
export const kill = async (b) => { const p = b.process(); await Promise.race([b.close().catch(() => {}), sleep(3000)]); try { p && p.kill("SIGKILL"); } catch {} };
process.on("exit", () => { for (const b of browsers) try { b.process() && b.process().kill("SIGKILL"); } catch {} });
// A clean visitor: how long until the board says it's ready, and the longest its main thread was blocked. A page that
// stops answering for `hang` ms counts as hung (ready -1).
export async function visit(port, hang = 10000) {
  const b = await launch(), p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
  await p.evaluateOnNewDocument(() => { window.__gap = 0; let last = performance.now(); setInterval(() => { const t = performance.now(); window.__gap = Math.max(window.__gap, t - last); last = t; }, 20); });
  const t0 = Date.now(); p.goto(`http://localhost:${port}/?probe`, { waitUntil: "domcontentloaded" }).catch(() => {});
  let ready = -1; for (let i = 0; i < 160; i++) { const r = await Promise.race([p.evaluate(() => window.__board && window.__board.ready).catch(() => false), sleep(hang).then(() => "HUNG")]); if (r === true) { ready = Date.now() - t0; break; } if (r === "HUNG") break; await sleep(250); }
  await sleep(2000); const gap = await Promise.race([p.evaluate(() => window.__gap).catch(() => -1), sleep(Math.min(15000, hang)).then(() => -2)]);
  await kill(b); return { ready, gap: Math.round(gap) };
}
