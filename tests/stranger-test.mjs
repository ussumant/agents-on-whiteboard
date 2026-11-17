// A stranger's first run: the package as npm would ship it, installed into an empty project folder by someone with a
// fresh home folder, then the README's quickstart end to end through `npx`. Offline: the package has no dependencies.
//   node tests/stranger-test.mjs [spare port 4900–4940]      → PASS lines
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import puppeteer from "puppeteer";
import { ok, sleep, portArg, poll, credsIn, asPage, ROOT } from "./lib.mjs";

const PORT = portArg(2, 4927), U = `http://localhost:${PORT}`;
const T = fs.mkdtempSync(path.join(os.tmpdir(), "sketchcall-stranger-")), HOME = path.join(T, "home"), PROJ = path.join(T, "my-project"), DROP = path.join(T, "pack");
for (const d of [HOME, PROJ, DROP]) fs.mkdirSync(d);
// A fresh shell: an empty home, its own npm cache, and a PATH with node and the system tools only.
const env = { HOME, USERPROFILE: HOME, PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), npm_config_cache: path.join(HOME, ".npm"), npm_config_update_notifier: "false", LANG: "en_US.UTF-8" };
const npmCli = path.join(path.dirname(process.execPath), "npm");
const sh = (cwd, cmd, args, timeout = 60000) => { const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout }); return { code: r.status, out: r.stdout || "", err: r.stderr || "" }; };
const npx = (...args) => sh(PROJ, path.join(path.dirname(process.execPath), "npx"), ["--no-install", "sketchcall", ...args]);
process.on("exit", () => npx("stop"));

// 1 the package
const packed = sh(ROOT, npmCli, ["pack", "--pack-destination", DROP, "--json"], 120000);
let tgz = null; try { tgz = path.join(DROP, JSON.parse(packed.out)[0].filename); } catch { /* checked below */ }
ok(packed.code === 0 && tgz && fs.existsSync(tgz), `1 npm pack makes ${tgz ? path.basename(tgz) : "nothing"} (${packed.err.trim().split("\n").at(-1) || "ok"})`);
fs.writeFileSync(path.join(PROJ, "package.json"), JSON.stringify({ name: "my-project", private: true }));
const inst = sh(PROJ, npmCli, ["install", "--offline", "--no-audit", "--no-fund", tgz], 120000);
ok(inst.code === 0 && fs.existsSync(path.join(PROJ, "node_modules", "sketchcall", "bin", "sketchcall.mjs")), `1b it installs into an empty project with no network (exit ${inst.code}${inst.code ? `: ${inst.err.slice(0, 200)}` : ""})`);
const shipped = []; (function walk(d, rel = "") { for (const f of fs.readdirSync(d)) { const p = path.join(d, f), r = rel ? `${rel}/${f}` : f; fs.statSync(p).isDirectory() ? walk(p, r) : shipped.push(r); } })(path.join(PROJ, "node_modules", "sketchcall"));
ok(!shipped.some((f) => /^(tests|\.claude-plugin|skills|node_modules)\//.test(f)) && shipped.includes("README.md") && shipped.includes("examples/pizza.excalidraw"), `1c the installed package holds only what ships (${shipped.length} files: ${shipped.sort().join(", ")})`);

// 2 the quickstart: open, with no browser
const help = npx("--help");
ok(help.code === 0 && /open \[file\.excalidraw\]/.test(help.out), "2 `npx sketchcall --help` runs from the installed package");
const o = npx("open", "--no-open", "--port", String(PORT));
ok(o.code === 0 && fs.existsSync(path.join(PROJ, "pizza.excalidraw")) && o.out.includes(`${U}/`) && /\/plugin install sketchcall --marketplace/.test(o.out), `2b \`npx sketchcall open --no-open\` starts the sample board on ${U}/ and prints the agent lines (exit ${o.code}${o.err ? `: ${o.err.trim()}` : ""})`);
const page = await (await fetch(`${U}/`)).text();
ok(/var BOARD = \{"key":/.test(page) && page.includes('"name":"pizza"'), "2c the board page is served");
// …and loads in a browser, on a laptop and on a phone, with nothing in the console
const b = await puppeteer.launch({ headless: true }); const loads = [];
for (const [w, h] of [[1440, 900], [393, 852]]) {
  const pg = await b.newPage(); await pg.setViewport({ width: w, height: h }); const errs = [];
  pg.on("pageerror", (e) => errs.push(e.message)); pg.on("console", (x) => x.type() === "error" && errs.push(x.text()));
  await pg.goto(`${U}/?probe`, { waitUntil: "domcontentloaded" }); const ready = await pg.waitForFunction("window.__board && window.__board.ready === true", { timeout: 45000 }).then(() => true, () => false);
  await sleep(1500); loads.push({ size: `${w}x${h}`, ready, boxes: await pg.evaluate(() => __board.boxes().length).catch(() => 0), errs });
}
await b.close();
ok(loads.every((l) => l.ready && l.boxes === 6 && !l.errs.length), `2d the board loads at 1440×900 and 393×852 with its six boxes and no console errors (${JSON.stringify(loads)})`);

// 3 a comment wakes `wait`; the reply lands
const w = spawn(path.join(path.dirname(process.execPath), "npx"), ["--no-install", "sketchcall", "wait", "--timeout", "60s"], { cwd: PROJ, env, stdio: ["ignore", "pipe", "pipe"] });
let wout = "", werr = "", wcode = null; w.stdout.on("data", (d) => (wout += d)); w.stderr.on("data", (d) => (werr += d)); w.on("exit", (c) => (wcode = c));
process.on("exit", () => w.kill());
await poll(() => /waiting/.test(werr), 20000);
const c = credsIn(page), t0 = Date.now();
const posted = await (await fetch(`${U}/api/comment`, { method: "POST", headers: asPage(c.key, U), body: JSON.stringify({ text: "why does the queue sit between the API and the kitchen?", on: { id: "queue", label: "📬 Order queue" } }) })).json();
await poll(() => wcode !== null, 20000);
let ev = null; try { ev = JSON.parse(wout.trim()); } catch { /* checked below */ }
ok(wcode === 0 && ev && ev.id === posted.id && ev.box_id === "queue", `3 a comment wakes \`npx sketchcall wait\` (${Date.now() - t0} ms, exit ${wcode}: ${wout.trim().slice(0, 100)})`);
const s = npx("say", "So the kitchen takes orders at its own pace during the rush.", "--reply-to", ev && ev.id);
let reply = null; try { reply = JSON.parse(s.out); } catch { /* checked below */ }
const th = fs.readFileSync(path.join(PROJ, ".sketchcall", "thread.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(s.code === 0 && reply && th.some((i) => i.id === reply.id && i.author === "claude" && i.on && i.on.id === "queue"), "3b `npx sketchcall say --reply-to` puts the reply on the same box");
const shown = await (await fetch(`${U}/api/thread`)).json();
ok(shown.items.some((i) => i.id === reply.id), "3c … and the board serves it to every page");

// 4 the MCP path: board_open attaches to the running board, board_wait hears the next comment
const m = spawn(path.join(path.dirname(process.execPath), "npx"), ["--no-install", "sketchcall", "mcp"], { cwd: PROJ, env, stdio: ["pipe", "pipe", "pipe"] });
process.on("exit", () => m.kill());
const replies = new Map(); let buf = "";
m.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const x = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (x.id != null) replies.set(x.id, x); } });
let n = 0; const rpc = async (method, params) => { const id = ++n; m.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); await poll(() => replies.has(id), 30000); return replies.get(id); };
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stranger", version: "0" } });
const opened = await rpc("tools/call", { name: "board_open", arguments: { dir: PROJ, port: PORT } });
const waiting = rpc("tools/call", { name: "board_wait", arguments: { timeout_s: 20 } });
await sleep(500);
const second = await (await fetch(`${U}/api/comment`, { method: "POST", headers: asPage(c.key, U), body: JSON.stringify({ text: "and what if the kitchen screen is offline?" }) })).json();
const got = await waiting; let gj = null; try { gj = JSON.parse(got.result.content[0].text); } catch { /* checked below */ }
ok(opened && !opened.result.isError && gj && gj.id === second.id, `4 through the MCP server, board_open attaches to the board and board_wait returns the next comment (${gj && gj.content})`);
m.kill();

// 5 stop
const st = npx("stop"); await sleep(300);
let up = true; try { await fetch(`${U}/api/hello`, { signal: AbortSignal.timeout(800) }); } catch { up = false; }
ok(st.code === 0 && /stopped the board/.test(st.out) && !up, `5 \`npx sketchcall stop\` ends it (${st.out.trim()})`);
console.log(`(stranger's folder: ${path.basename(T)})`);
