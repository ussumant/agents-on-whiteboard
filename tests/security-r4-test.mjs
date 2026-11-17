// Security gate, round 4: one named check per finding in the fourth review (N1 by fill style and by points, S2 by hard
// link, reads with no budget, S5 by IPv6 address, terminal escapes, and a guest's 5 MB picture), each replaying the
// attack from its proof script (r4-fills, r4-persist, r4-sym, r4-budget2, r4-shell). A link guest is simulated as in
// round 3. Fresh copies of the sample board, three spare ports.
//   node tests/security-r4-test.mjs [spare port 4900–4940] [second] [third]      → PASS lines
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { ok, sleep, scratch, portArg, poll, BIN, SAMPLE } from "./lib.mjs";
import { TUNNEL, guestAt, hit, json, alive, sceneOf, run, board as linkBoard, browsers, launch, kill, visit } from "./guest-lib.mjs";
import * as S from "../src/server.mjs";

const PORT = portArg(2, 4934), PORT2 = portArg(3, 4935), PORT3 = portArg(4, 4936);
process.setMaxListeners(80);
const board = (port, name, o = {}) => linkBoard(port, name, { prefix: "r4", ...o });
const base = { x: -50000, y: -50000, width: 1e5, height: 1e5, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "#ff8787", fillStyle: "solid", strokeWidth: 0.5, strokeStyle: "solid",
  roughness: 1, opacity: 30, groupIds: [], frameId: null, roundness: null, version: 2, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, locked: false };
const square = (n) => [[0, 0], [n, 0], [n, n], [0, n], [0, 0]];
// The fills rough.js draws that the round-3 cap didn't name, an unknown name (drawn as hachure), and no fill at all
const STYLES = ["dots", "dashed", "zigzag-line", "Hachure", undefined];
const box = (tag, i, fill) => { const e = { ...base, id: `${tag}${i}`, type: "rectangle", seed: i + 1 }; if (fill === undefined) delete e.fillStyle; else e.fillStyle = fill; return e; };
// A closed line that declares 10 × 10 while its points span `span`
const closed = (tag, i, span, extra = {}) => ({ ...base, id: `${tag}${i}`, type: "line", x: (i % 20) * 60, y: Math.floor(i / 20) * 60, width: 10, height: 10, points: square(span), fillStyle: "cross-hatch", strokeWidth: 1, seed: i + 1, ...extra });
// Each case on its own board, as in the proof script: 200 of one fill, or 200 closed lines
const CASES = [...STYLES.map((f, k) => [f === undefined ? "no fill named" : f, () => Array.from({ length: 200 }, (_, i) => box(`f${k}x`, i, f))]), ["closed lines", () => Array.from({ length: 200 }, (_, i) => closed("ln", i, 1e5))]];
// All of them at once, 200 in all, for the planted scene and the page's guard
const mix = () => [...STYLES.flatMap((f, k) => Array.from({ length: 34 }, (_, i) => box(`f${k}x`, i, f))), ...Array.from({ length: 30 }, (_, i) => closed("ln", i, 1e5))];
const ours = (e) => /^(f\dx|ln)\d+$/.test(e.id);
const fillsOf = (list) => list.reduce((m, e) => ((m[e.fillStyle ?? "(none)"] = (m[e.fillStyle ?? "(none)"] || 0) + 1), m), {});
// Solid, or no fill named (the page's default is solid): nothing patterned is left
const flat = (e) => e.fillStyle === "solid" || (e.fillStyle === undefined && e.id.startsWith("f4x"));

/* N1 (item 1): fill styles the cap didn't name, and closed lines sized by their points (r4-fills.mjs, r4-persist.mjs) */
{
  const E = await board(PORT, "n1base"), base0 = await visit(PORT); await E.stop();
  const res = [];
  for (const [name, make] of CASES) {
    const B = await board(PORT, "fills");
    const t = json(await B.scene("guest", make())); await sleep(800);
    const got = sceneOf(B.dir).filter(ours), v = await visit(PORT);
    res.push({ name, took: t && t.took, kept: fillsOf(got), flat: got.length === 200 && got.every(flat), ready: v.ready, gap: v.gap });
    await B.stop();
  }
  ok(res.every((x) => x.took === 200 && x.flat && x.ready > 0 && x.ready < base0.ready + 2000 && x.gap < 2000),
    `N1-r4a 200 boxes 1e5 wide filled with dots, dashed, zigzag-line, "Hachure" or no fill named, and 200 closed lines declaring 10 × 10 over points 1e5 apart, each case from a guest: all drawn solid, and a clean visitor loads each in under ${base0.ready + 2000} ms (an empty board: ${base0.ready} ms) ${JSON.stringify(res.map((x) => `${x.name}: ${JSON.stringify(x.kept)} ${x.ready} ms, block ${x.gap}`))}`);
  // the link's hatched-area budget measures lines by their points too: 300 closed lines 2,000 across, each declaring 10 × 10
  const A = await board(PORT, "area");
  await A.scene("guest", Array.from({ length: 300 }, (_, i) => closed("ar", i, 2000))); await sleep(800);
  const ar = sceneOf(A.dir).filter((e) => /^ar\d+$/.test(e.id)), arHatched = ar.filter((e) => e.fillStyle !== "solid").length, va = await visit(PORT);
  ok(ar.length === 300 && arHatched <= 200 && va.ready > 0 && va.ready < base0.ready + 2000,
    `N1-r4b the link's hatched-area budget counts a closed line by its points: of 300 lines 2,000 across that declare 10 × 10, ${arHatched} keep their hatching, and a clean visitor loads in ${va.ready} ms`);
  await A.stop();
  // planted in scene.json (or kept from before a restart): cleaned at startup; a small "dashed" box goes solid too
  const seed = S.readBoard(SAMPLE).elements;
  const P = await board(PORT, "planted", { planted: [...seed, ...mix(), { ...box("small", 0, "dashed"), x: 0, y: 0, width: 300, height: 200 }] });
  const pl = sceneOf(P.dir), plOurs = pl.filter(ours), small = pl.find((e) => e.id === "small0"), vp = await visit(PORT);
  ok(plOurs.length === 200 && plOurs.every(flat) && small && small.fillStyle === "solid" && vp.ready > 0 && vp.ready < base0.ready + 2000,
    `N1-r4c a scene.json planted with all of them (200 in all) is cleaned at startup (${JSON.stringify(fillsOf(plOurs))}; a small dashed box: ${small && small.fillStyle}), and a clean visitor loads in ${vp.ready} ms`);
  await P.stop();
  // the page's own guard, for elements that reach it some other way
  const Q = await board(PORT, "page"), b = await launch(), page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
  let pending = null; await page.setRequestInterception(true);
  page.on("request", (r) => { const u = new URL(r.url()); if (pending && u.pathname === "/api/changes") { const els = pending; pending = null; return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ seq: 0, events: [{ event: "elements", data: { elements: els } }] }) }); } r.continue(); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__board && window.__board.ready === true", { timeout: 45000 }); await sleep(1500);
  pending = mix(); await Q.post("home", "/api/comment", { text: "nudge" });
  await sleep(5000);
  const pg = await Promise.race([page.evaluate(() => { const els = window.__excalidrawAPI.getSceneElements().filter((e) => /^(f\dx|ln)\d+$/.test(e.id)); return { n: els.length, patterned: els.filter((e) => e.fillStyle !== "solid").length }; }).catch((e) => ({ error: e.message })), sleep(15000).then(() => "HUNG")]);
  ok(pg !== "HUNG" && pg.n === 200 && pg.patterned === 0, `N1-r4d an open page that gets 200 of them, every kind, draws each one solid and keeps answering (${JSON.stringify(pg)})`);
  await kill(b); await Q.stop();
}

/* S2 (item 2): hard links in .sketchcall/ (r4-sym.mjs) */
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sketchcall-r4-hard-"));
  const res = [];
  const plants = [["events.log = the repo's setup.sh", (repo, call) => { fs.writeFileSync(path.join(repo, "setup.sh"), 'echo "setting up"\n'); fs.linkSync(path.join(repo, "setup.sh"), path.join(call, "events.log")); return path.join(repo, "setup.sh"); }],
    ["files/p1.png = the repo's .env", (repo, call) => { fs.writeFileSync(path.join(repo, ".env"), "API_KEY=sk-live-0123456789\n"); fs.mkdirSync(path.join(call, "files")); fs.linkSync(path.join(repo, ".env"), path.join(call, "files", "p1.png")); return path.join(repo, ".env"); }],
    ["thread.jsonl = a file elsewhere", (repo, call) => { const v = path.join(work, "notes.txt"); fs.writeFileSync(v, "my notes\n"); fs.linkSync(v, path.join(call, "thread.jsonl")); return v; }],
    ["events.log is a named pipe", (repo, call) => { execFileSync("mkfifo", [path.join(call, "events.log")]); return null; }]];
  for (const [name, plant] of plants) {
    const repo = scratch("r4-hardrepo"), call = path.join(repo, S.CALL); fs.mkdirSync(call);
    const victim = plant(repo, call), before = victim && fs.readFileSync(victim, "utf8");
    const p = spawn(process.execPath, [BIN, "serve", "--port", String(PORT)], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }); let err = ""; p.stderr.on("data", (d) => (err += d));
    const code = await new Promise((r) => { const t = setTimeout(() => { p.kill("SIGKILL"); r("still running"); }, 4000); p.on("exit", (c) => { clearTimeout(t); r(c); }); });
    if (code === "still running") await poll(async () => !(await alive(PORT)), 5000);
    res.push({ name, code, said: /hard link|names on disk|not a plain file/i.test(err), victim: !victim || fs.readFileSync(victim, "utf8") === before });
  }
  ok(res.every((r) => r.code === 1 && r.said && r.victim), `S2-r4a the server refuses to start on a .sketchcall holding a hard link or a pipe, says what it found, and writes nothing (${JSON.stringify(res.map((r) => `${r.name}: ${r.code}${r.said ? "" : " (silent)"}${r.victim ? "" : " WROTE"}`))})`);
  // after start: events.log and scene.json swapped for hard links to the repo's scripts; a guest's comment and edit follow
  const B = await board(PORT, "hardswap"), F = S.files(B.dir), hook = path.join(B.dir, "setup.sh"), cfg = path.join(B.dir, "deploy.sh");
  fs.writeFileSync(hook, 'echo "setting up"\n'); fs.writeFileSync(cfg, 'echo "deploying"\n');
  fs.rmSync(F.events, { force: true }); fs.linkSync(hook, F.events);
  const c = await B.post("guest", "/api/comment", { text: "nice ; touch PWNED-hard", name: "Alex" });
  fs.rmSync(F.scene, { force: true }); fs.linkSync(cfg, F.scene);
  const e = await B.scene("guest", [{ ...box("hs", 0, "solid"), x: 0, y: 0, width: 100, height: 100 }]); await sleep(1500);
  const sh = spawnSync("/bin/sh", [hook], { cwd: work, encoding: "utf8" });
  ok(fs.readFileSync(hook, "utf8") === 'echo "setting up"\n' && fs.readFileSync(cfg, "utf8") === 'echo "deploying"\n' && !fs.existsSync(path.join(work, "PWNED-hard")) && await alive(PORT),
    `S2-r4b hard links swapped in after start are never written: a guest's comment (${c.status}) and edit (${e.status}) leave both scripts byte for byte as they were, and the server stays up`);
  // a picture hard-linked to a secret after start is never served
  fs.writeFileSync(path.join(B.dir, ".env"), "API_KEY=sk-live-0123456789\n"); fs.mkdirSync(path.join(F.live, "files"), { recursive: true }); fs.linkSync(path.join(B.dir, ".env"), path.join(F.live, "files", "p1.png"));
  const r = await hit(PORT, "/api/files?ids=p1", { host: TUNNEL, headers: guestAt("203.0.113.7") }), rh = await hit(PORT, "/api/files?ids=p1");
  const leaked = [r, rh].some((x) => (json(x)?.files || []).length > 0);
  ok(!leaked, `S2-r4c a picture hard-linked to the repo's .env after start is served to no one (guest ${r.status}, this computer ${rh.status}: ${leaked ? "LEAKED" : "nothing"})`);
  await B.stop();
}

/* Reads (item 3): pictures and the record fetched by a guest as fast as they can (r4-budget2.mjs b, c) */
{
  const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  async function flood(B, pth, loops, seconds) {
    let stop = false; const lat = [], codes = {}; let bytes = 0;
    const guest = async () => { while (!stop) { const r = await hit(B.port, pth, { host: TUNNEL, headers: guestAt("203.0.113.7"), wait: 20000 }); codes[r.status] = (codes[r.status] || 0) + 1; if (r.status === 200) bytes += r.bytes; } };
    const owner = async () => { while (!stop) { const t = Date.now(); await B.post("home", "/api/comment", { text: "owner ping" }); lat.push(Date.now() - t); await sleep(250); } };
    const t0 = Date.now(), runs = [...Array.from({ length: loops }, guest), owner()];
    await sleep(seconds * 1000); stop = true; await Promise.all(runs);
    return { codes, mbps: +(bytes / 1e6 / ((Date.now() - t0) / 1000)).toFixed(1), p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.max(...lat), n: lat.length };
  }
  const B = await board(PORT2, "reads"), pics = path.join(S.files(B.dir).live, "files"); fs.mkdirSync(pics, { recursive: true, mode: 0o700 });
  const ids = []; for (let i = 0; i < 20; i++) { ids.push(`shot${i}`); fs.writeFileSync(path.join(pics, `shot${i}.png`), crypto.randomBytes(5e6), { mode: 0o600 }); }
  const a = await flood(B, `/api/files?ids=${ids.join(",")}`, 3, 15);
  ok(a.p95 < 1000 && a.mbps <= 16 && a.codes[429] > 0 && a.codes[200] > 0,
    `T1a with 20 five-MB pictures on the board and a guest fetching all of them in 3 loops for 15 s, this computer's comments answer at p95 ${a.p95} ms (p50 ${a.p50}, max ${a.max}, ${a.n} sent); the guest got ${a.mbps} MB/s (${JSON.stringify(a.codes)})`);
  const lines = []; for (let i = 0; i < 2000; i++) lines.push(JSON.stringify({ kind: "comment", id: `cx${i}`, ts: new Date().toISOString(), author: "you", text: "y".repeat(4000), on: null }));
  fs.appendFileSync(S.files(B.dir).thread, lines.join("\n") + "\n");
  const c = await flood(B, "/api/thread", 8, 15);
  ok(c.p95 < 1000 && c.mbps <= 16 && c.codes[429] > 0 && c.codes[200] > 0,
    `T1b with an 8 MB record and a guest fetching it in 8 loops for 15 s, this computer's comments answer at p95 ${c.p95} ms (p50 ${c.p50}, max ${c.max}); the guest got ${c.mbps} MB/s (${JSON.stringify(c.codes)})`);
  await B.stop();
}

/* S5 (item 4): one person on many IPv6 addresses (r4-budget2.mjs a) */
{
  const B = await board(PORT2, "ipv6"), served = {};
  for (const ip of ["2001:db8::1", "2001:db8::2", "2001:0DB8:0:0::3"]) { served[ip] = 0; for (let i = 0; i < 22; i++) if ((await hit(PORT2, "/", { host: TUNNEL, headers: guestAt(ip) })).status === 200) served[ip]++; }
  const mate6 = await hit(PORT2, "/", { host: TUNNEL, headers: guestAt("2001:db8:1::9") }), mate4 = await hit(PORT2, "/", { host: TUNNEL, headers: guestAt("198.51.100.9") });
  const total = Object.values(served).reduce((t, n) => t + n, 0), K = typeof S.guestKey === "function" ? S.guestKey : null;
  const keys = K && { same: K("2001:db8::1") === K("2001:0db8:0:0::2") && K("2001:db8::1") === K("2001:DB8::ffff:1%en0"), other: K("2001:db8::1") !== K("2001:db8:1::1"), v4: K("::ffff:203.0.113.7") === "203.0.113.7" && K("203.0.113.7") === "203.0.113.7" };
  ok(total <= 20 && mate6.status === 200 && mate4.status === 200 && keys && keys.same && keys.other && keys.v4,
    `S5-r4 one person on three addresses in one IPv6 /64 gets ${total} pages in all (${JSON.stringify(served)}), and teammates in another /64 and on IPv4 still get in (${mate6.status}, ${mate4.status}); keys ${JSON.stringify(keys)}`);
  await B.stop();
}

/* T2 (item 5): terminal escapes in what the CLI prints (r4-shell.mjs) */
{
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sketchcall-r4-esc-")), marks = ["PWNED-q", "PWNED-nl"].map((m) => path.join(parent, m));
  const CTRL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;   // every control character but the line break
  const names = [["terminal escapes", "ok\x1b[2K\x1b[1A\x1b]0;HACKED\x07\x1b]52;c;ZWNobyBwd25lZA==\x07"], ["newline then $()", "a\n$(touch PWNED-nl)"], ["quote and $()", "x'$(touch PWNED-q)'y"]];
  const res = [];
  for (const [label, name] of names) {
    const weird = path.join(parent, name); fs.mkdirSync(weird);
    const o = run(parent, ["open", "--dir", weird, "--no-open", "--port", String(PORT3)]), out = o.stdout + o.stderr;
    const line = o.stdout.split(/\n(?=  npx|Stop|Then)/).find((l) => /npx sketchcall wait --dir/.test(l)) || "";
    const cmd = line.trim().replace(/\s{2,}the next comment.*$/s, "").replace("npx sketchcall", "printf '%s\\n'");
    const sh = spawnSync("/bin/sh", ["-c", cmd], { cwd: parent, encoding: "utf8" });
    res.push({ label, exit: o.status, raw: (out.match(CTRL) || []).length, path: sh.stdout.split("\n").includes(weird) || sh.stdout.replace(/\n$/, "").endsWith(weird), ran: marks.some((m) => fs.existsSync(m)) });
    run(parent, ["stop", "--dir", weird]);
  }
  ok(res.every((r) => r.exit === 0 && r.raw === 0 && r.path && !r.ran), `T2a \`open\` prints no control character from a folder's name, and its pasted lines still name the exact folder with nothing run (${JSON.stringify(res)})`);
  // a guest's comment with escapes, printed by `record`; and an error that names files with escapes
  const B = await board(PORT3, "record");
  await B.post("guest", "/api/comment", { text: "hi\x1b]52;c;ZWNobyBwd25lZA==\x07\x1b[2J there", name: "Alex\x1b[31m" });
  const rec = run(B.dir, ["record"]);
  // the JSON lines the CLI prints, for text kept as typed (an agent's reply holding DEL and C1 characters, which
  // JSON.stringify leaves raw): still JSON, the same text back, and nothing raw in them
  const odd = "del\x7f nel\u0085 csi\u009b[2J end", said = run(B.dir, ["say", odd]); let item = null; try { item = JSON.parse(said.stdout); } catch { /* not JSON */ }
  await B.stop();
  const two = fs.mkdtempSync(path.join(os.tmpdir(), "sketchcall-r4-two-")); for (const f of ["one\x1b[2K.excalidraw", "two\x07.excalidraw"]) fs.copyFileSync(SAMPLE, path.join(two, f));
  const err = run(two, ["open", "--no-open", "--port", String(PORT3)]);
  ok(rec.status === 0 && /there/.test(rec.stdout) && !(rec.stdout + rec.stderr).match(CTRL) && err.status === 1 && /\\x1b/.test(err.stderr) && !(err.stdout + err.stderr).match(CTRL),
    `T2b \`record\` prints a guest's escape codes as text, and so does an error naming two boards (${(rec.stdout.match(/hi.*there/) || [""])[0]} | ${err.stderr.trim().slice(0, 90)})`);
  ok(said.status === 0 && item && item.text === odd && !said.stdout.match(CTRL),
    `T2c \`say\` with DEL and C1 characters in its text prints one JSON line that parses back to the same text, with none of them raw (${item ? "parsed" : `not JSON: ${JSON.stringify(said.stdout.slice(70, 140))}`})`);
}

/* Item 6: a guest's picture up to the 5 MB cap goes through when their budget is idle */
{
  const B = await board(PORT2, "pic"), png = (n) => `data:image/png;base64,${crypto.randomBytes(n).toString("base64")}`;
  const one = await B.post("guest", "/api/files", { c: B.guest.c, name: "Alex", files: [{ id: "big1", dataURL: png(5e6) }] });
  const two = await B.post("guest", "/api/files", { c: B.guest.c, name: "Alex", files: [{ id: "big2", dataURL: png(5e6) }] });
  let kept = []; try { kept = fs.readdirSync(path.join(S.files(B.dir).live, "files")); } catch { /* none kept */ }
  ok(one.status === 200 && (json(one)?.took || []).includes("big1") && kept.includes("big1.png") && two.status === 429,
    `P1 a guest's 5 MB picture goes through when their budget is idle (${one.status}, kept: ${kept.join(", ") || "none"}), and a second one straight after is told to wait (${two.status})`);
  await B.stop();
}

for (const b of browsers) await kill(b);
console.log("(done)");
