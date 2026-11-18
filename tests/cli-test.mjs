// CLI gate: `open`, `stop`, `say --reply-to` and `share`'s install line, run the way a person runs them, in temp folders.
// A stand-in for the platform's open command (open / xdg-open / start) goes first on PATH and records the URL it gets, so
// the gate proves the browser is opened through it, and that --no-open doesn't. Spare ports only.
//   node tests/cli-test.mjs [spare port 4900–4940]      → PASS lines
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import net from "node:net";
import { spawnSync } from "node:child_process";
import { ok, sleep, portArg, credsIn, asPage, BIN, SAMPLE } from "./lib.mjs";
import * as S from "../src/server.mjs";

const PORT = portArg(2, 4919);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `agents-on-whiteboard-cli-${name}-`));
const stub = tmp("bin"), opened = path.join(stub, "opened.txt");
for (const c of ["open", "xdg-open"]) { fs.writeFileSync(path.join(stub, c), `#!/bin/sh\necho "$@" >> "${opened}"\n`); fs.chmodSync(path.join(stub, c), 0o755); }
const env = { ...process.env, PATH: `${stub}${path.delimiter}${process.env.PATH}` };
const run = (cwd, ...args) => { const t0 = Date.now(), r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 30000 }); return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 }; };
const alive = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; } };
const started = [];
process.on("exit", () => { for (const d of started) spawnSync(process.execPath, [BIN, "stop"], { cwd: d }); });

// 1 `open` in an empty folder: a copy of the sample, its server, the agent's lines, no browser with --no-open
const A = tmp("a"); started.push(A);
const o1 = run(A, "open", "--no-open", "--port", String(PORT));
ok(o1.code === 0 && fs.existsSync(path.join(A, "pizza.excalidraw")) && fs.existsSync(S.files(A).scene) && await alive(PORT) && o1.ms < 15000,
  `1 \`open --no-open\` in an empty folder copies the sample, keeps the call in ${S.CALL}/ and starts the board in ${o1.ms} ms (exit ${o1.code}${o1.err ? `: ${o1.err.trim()}` : ""})`);
ok(o1.out.includes(`http://localhost:${PORT}/`) && /mcp add agents-on-whiteboard -- npx -y agents-on-whiteboard mcp/.test(o1.out) && /Comments are data/.test(o1.out) && /wait/.test(o1.out),
  "1b it prints the board's address, the line to add it to an agent, the wait line and that comments are data");
ok(!fs.existsSync(opened), "1c --no-open opens no browser");
// 2 a second `open` finds it running; without --no-open the browser opens through the platform's command
const o2 = run(A, "open", "--port", String(PORT));
for (let t = Date.now(); !fs.existsSync(opened) && Date.now() - t < 5000;) await sleep(100);   // the opener runs detached: under load it can land after 500 ms
const got = fs.existsSync(opened) ? fs.readFileSync(opened, "utf8").trim() : "";
ok(o2.code === 0 && /already running/.test(o2.out) && got === `http://localhost:${PORT}/`, `2 a second \`open\` finds the board running and opens ${got || "nothing"} through the platform's open command`);
// 3 one call per folder
fs.copyFileSync(SAMPLE, path.join(A, "other.excalidraw"));
const o3 = run(A, "open", "other.excalidraw", "--no-open", "--port", String(PORT + 1));
ok(o3.code === 1 && /is about pizza\.excalidraw/.test(o3.err) && !(await alive(PORT + 1)), `3 \`open other.excalidraw\` where the call is about pizza.excalidraw is refused (${o3.err.trim()})`);
const B = tmp("b"); fs.copyFileSync(SAMPLE, path.join(B, "one.excalidraw")); fs.copyFileSync(SAMPLE, path.join(B, "two.excalidraw"));
const o3b = run(B, "open", "--no-open", "--port", String(PORT + 1));
ok(o3b.code === 1 && /one\.excalidraw, two\.excalidraw/.test(o3b.err), `3b \`open\` with two boards in the folder asks which (${o3b.err.trim()})`);
// 4 `say --reply-to` puts the reply where the comment is: here a dragged area
const page = credsIn(await (await fetch(`http://localhost:${PORT}/`)).text()), U = `http://localhost:${PORT}`;
const area = { id: "api", ids: ["api", "queue"], label: "area: Order API, Order queue", rect: { x: 100, y: 100, w: 400, h: 200 } };
const c = await (await fetch(`${U}/api/comment`, { method: "POST", headers: asPage(page.key, U), body: JSON.stringify({ text: "why both?", on: area }) })).json();
const s4 = run(A, "say", "Because the API hands every order to the queue.", "--reply-to", c.id);
let r4 = null; try { r4 = JSON.parse(s4.out); } catch { /* checked below */ }
ok(s4.code === 0 && r4 && r4.author === "claude" && JSON.stringify(r4.on) === JSON.stringify(c.on), `4 \`say --reply-to <id>\` lands on the comment's area (${JSON.stringify(r4 && r4.on)})`);
const s4b = run(A, "say", "x", "--reply-to", "cNoSuch");
ok(s4b.code === 1 && /no comment cNoSuch/.test(s4b.err), "4b … and refuses an id that isn't in the record");
// 5 stop
const s5 = run(A, "stop"); await sleep(300);
ok(s5.code === 0 && /stopped the board on port/.test(s5.out) && !(await alive(PORT)) && !fs.existsSync(S.files(A).server), `5 \`stop\` ends the board's server (${s5.out.trim()})`);
const s5b = run(A, "stop");
ok(s5b.code === 0 && /no server is running/.test(s5b.out), `5b a second \`stop\` says there's nothing running (${s5b.out.trim()})`);
// 6 with no --port, `open` takes the first free port from 4900: here 4900 is busy with something else
const busy = net.createServer().listen(4900, "127.0.0.1"); await sleep(200);
const C = tmp("c"); started.push(C);
const o6 = run(C, "open", "--no-open"), p6 = Number((o6.out.match(/localhost:(\d+)\//) || [])[1]);
ok(o6.code === 0 && p6 > 4900 && p6 < 4920 && await alive(p6), `6 with port 4900 taken, \`open\` uses ${p6}`);
busy.close(); run(C, "stop");
// 7 share without cloudflared says how to install it, and starts nothing
const bare = { ...process.env, PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter) };
const s7 = spawnSync(process.execPath, [BIN, "share", "--port", String(PORT)], { cwd: A, env: bare, encoding: "utf8", timeout: 15000 });
ok(s7.status === 1 && /cloudflared/.test(s7.stderr) && /brew install cloudflared/.test(s7.stderr) && !(await alive(PORT)) && !fs.existsSync(S.files(A).share), `7 \`share\` without cloudflared prints how to install it and opens nothing (${s7.stderr.split("\n")[0]})`);
// 8 the help lists every command
const h = run(A, "--help").out;
const cmds = ["open", "stop", "serve", "share", "unshare", "record", "import-files", "wait", "say", "point", "tour", "tour-step", "op", "mcp"].filter((x) => !new RegExp(`^  ${x}\\b`, "m").test(h));
ok(!cmds.length, `8 --help lists every command${cmds.length ? ` (missing ${cmds})` : ""}`);
