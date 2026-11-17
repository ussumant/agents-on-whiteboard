// Security gate, round 3: one named check per finding in the third review (N1 by count, N11 by the board's own address,
// S1–S5), each replaying the attack from its proof script. A link guest is simulated as before (a share.json with a known
// key and this process's pid, a trycloudflare.com Host, a cf-connecting-ip header and the key cookie). Fresh copies of
// the sample board, three spare ports.
//   node tests/security-r3-test.mjs [spare port 4900–4940] [second] [third]      → PASS lines
import fs from "node:fs"; import http from "node:http"; import os from "node:os"; import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ok, sleep, scratch, mcpSession, portArg, poll, credsIn, BIN, SAMPLE } from "./lib.mjs";
import { TUNNEL, LINK, guestAt, guestHead, hit, json, alive, sceneOf, run, board as linkBoard, browsers, launch, kill, visit } from "./guest-lib.mjs";
import * as S from "../src/server.mjs";

const PORT = portArg(2, 4931), PORT2 = portArg(3, 4932), EVIL = portArg(4, 4933);
process.setMaxListeners(80);
const board = (port, name, o = {}) => linkBoard(port, name, { prefix: "r3", ...o });
const base = { x: 0, y: 0, width: 200, height: 120, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid",
  roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 3, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, locked: false };
const hatched = (i, w, extra = {}) => ({ ...base, id: `ch${i}`, type: "rectangle", x: (i % 20) * 60, y: Math.floor(i / 20) * 60, width: w, height: w, backgroundColor: "#ff8787", fillStyle: "cross-hatch", strokeWidth: 0.5, opacity: 30, seed: i + 1, version: 2, ...extra });

/* S2 (item 1): symlinks a cloned repo ships in .sketchcall/ (r3-sym.mjs, r3-open.mjs) */
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sketchcall-r3-sym-"));
  const victim = path.join(work, "victim-hook.sh"), dangling = path.join(work, "created-through-a-link.txt"), secret = path.join(work, "secret.txt");
  fs.writeFileSync(victim, 'echo "a script the owner runs"\n'); fs.writeFileSync(secret, "PRIVATE KEY MATERIAL\n");
  const cases = [["events.log -> a script", (c) => fs.symlinkSync(victim, path.join(c, "events.log"))], ["server.json -> a file", (c) => fs.symlinkSync(victim, path.join(c, "server.json"))],
    ["board.json -> a new file", (c) => fs.symlinkSync(dangling, path.join(c, "board.json"))], ["thread.jsonl -> a file", (c) => fs.symlinkSync(victim, path.join(c, "thread.jsonl"))],
    ["files/x.png -> a secret", (c) => { fs.mkdirSync(path.join(c, "files")); fs.symlinkSync(secret, path.join(c, "files", "x.png")); }],
    ["files/ -> another folder", (c) => fs.symlinkSync(work, path.join(c, "files"))], [".sketchcall -> another folder", null]];
  const res = [];
  for (const [name, plant] of cases) {
    const repo = scratch("r3-symrepo"), call = path.join(repo, S.CALL);
    if (plant) { fs.mkdirSync(call); plant(call); } else { const elsewhere = fs.mkdtempSync(path.join(work, "elsewhere-")); fs.symlinkSync(elsewhere, call); }
    const before = fs.readFileSync(victim, "utf8");
    const p = spawn(process.execPath, [BIN, "serve", "--port", String(PORT)], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }); let err = ""; p.stderr.on("data", (d) => (err += d));
    const code = await new Promise((r) => { const t = setTimeout(() => { p.kill(); r("still running"); }, 4000); p.on("exit", (c) => { clearTimeout(t); r(c); }); });
    if (code === "still running") await poll(async () => !(await alive(PORT)), 5000);
    res.push({ name, code, said: /symlink|symbolic link/i.test(err) && err.includes(path.basename(plant ? call : repo)) || /symlink/i.test(err), victim: fs.readFileSync(victim, "utf8") === before, created: fs.existsSync(dangling) });
  }
  ok(res.every((r) => r.code === 1 && r.said && r.victim && !r.created), `S2a the server refuses to start on a .sketchcall with a symlink in it, says so, and writes nothing through it (${JSON.stringify(res.map((r) => `${r.name}: ${r.code}${r.said ? "" : " (silent)"}${r.victim ? "" : " WROTE"}${r.created ? " CREATED" : ""}`))})`);
  // a link swapped in after the server started: a guest's comment must not land in the script
  const B = await board(PORT, "swap"), F = S.files(B.dir), before = fs.readFileSync(victim, "utf8");
  fs.rmSync(F.events, { force: true }); fs.symlinkSync(victim, F.events);
  const c = await B.post("guest", "/api/comment", { text: "looks good ; touch PWNED-sym", name: "Alex" });
  fs.rmSync(F.thread, { force: true }); fs.symlinkSync(victim, F.thread);
  const c2 = await B.post("guest", "/api/comment", { text: "second ; touch PWNED-sym", name: "Alex" });
  const sh = spawnSync("/bin/sh", [victim], { cwd: work, encoding: "utf8" });
  ok(fs.readFileSync(victim, "utf8") === before && !fs.existsSync(path.join(work, "PWNED-sym")) && await alive(PORT), `S2b a symlink swapped in after start is never written through: the comments get ${c.status} and ${c2.status}, the script is unchanged, the server stays up`);
  await B.stop();
  // the call folder: private, and kept out of git
  const R = scratch("r3-gitignore"); const o = run(R, ["open", "--no-open", "--port", String(PORT)]);
  const call = path.join(R, S.CALL), gi = path.join(call, ".gitignore");
  const modes = fs.existsSync(call) ? [call, ...fs.readdirSync(call).map((f) => path.join(call, f))].filter((f) => !f.endsWith(".gitignore")).map((f) => (fs.lstatSync(f).mode & 0o777).toString(8)) : [];
  ok(o.status === 0 && fs.existsSync(gi) && fs.readFileSync(gi, "utf8").trim() === "*" && modes[0] === "700" && modes.slice(1).every((m) => m === "600"), `S2c open keeps the call out of git (.gitignore "*") and readable by this account only (modes ${modes.join(" ")})`);
  run(R, ["stop"]);
}

/* N1 by count (item 2): 200 in-bounds cross-hatched boxes (r3-n1c-many.mjs, r3-n1d-persist.mjs) */
{
  const base0 = await visit(await (async () => { const B = await board(PORT, "n1base"); globalThis.__b0 = B; return PORT; })()); await globalThis.__b0.stop();
  const B = await board(PORT, "n1count");
  const t = json(await B.scene("guest", Array.from({ length: 200 }, (_, i) => hatched(i, 1e5))));
  await sleep(800);
  const got = sceneOf(B.dir).filter((e) => /^ch\d+$/.test(e.id)), stillHatched = got.filter((e) => e.fillStyle !== "solid").length;
  const v = await visit(PORT);
  ok(t && t.took === 200 && stillHatched === 0 && v.ready > 0 && v.ready < base0.ready + 2000 && v.gap < 2000,
    `N1-r3a 200 cross-hatched boxes 1e5 wide from a guest are taken as solid fills (${stillHatched} still hatched), and a clean visitor loads in ${v.ready} ms (an empty board: ${base0.ready} ms; longest block ${v.gap} ms)`);
  await B.stop();
  // at the cap: 2,500 boxes of 2,000 × 2,000 cross-hatched, the most the link may hold
  const C = await board(PORT, "n1cap");
  for (let k = 0; k < 2500; k += 1250) { await C.scene("guest", Array.from({ length: 1250 }, (_, i) => hatched(k + i, 2000, { strokeWidth: 1 }))); await sleep(400); }
  await sleep(800);
  const capGot = sceneOf(C.dir).filter((e) => /^ch\d+$/.test(e.id)), capHatched = capGot.filter((e) => e.fillStyle !== "solid").length;
  const vc = await visit(PORT);
  ok(capGot.length === 2500 && capHatched <= 200 && vc.ready > 0 && vc.ready < base0.ready + 2000 && vc.gap < 2000,
    `N1-r3b 2,500 cross-hatched boxes at 2,000 × 2,000 from the link: ${capHatched} keep their hatching, and a clean visitor loads in ${vc.ready} ms (longest block ${vc.gap} ms)`);
  await C.stop();
  // a scene.json planted with them is cleaned at startup; small hatched shapes keep their fill, with a stroke of at least 1
  const seed = S.readBoard(SAMPLE).elements;
  const P = await board(PORT, "n1planted", { planted: [...seed, ...Array.from({ length: 200 }, (_, i) => hatched(i, 1e5)), { ...hatched(999, 800), id: "small" }] });
  const pl = sceneOf(P.dir), big = pl.filter((e) => /^ch\d+$/.test(e.id)), small = pl.find((e) => e.id === "small");
  const vp = await visit(PORT);
  ok(big.length === 200 && big.every((e) => e.fillStyle === "solid") && small && small.fillStyle === "cross-hatch" && small.strokeWidth >= 1 && vp.ready > 0 && vp.ready < base0.ready + 2000,
    `N1-r3c a planted scene.json is cleaned at startup (big boxes solid, a small one keeps cross-hatch with stroke ${small && small.strokeWidth}), and a clean visitor loads in ${vp.ready} ms`);
  await P.stop();
  // the page's own guard, for shapes that got past a server
  const Q = await board(PORT, "n1page"), b = await launch(), page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
  let pending = null; await page.setRequestInterception(true);
  page.on("request", (r) => { const u = new URL(r.url()); if (pending && u.pathname === "/api/changes") { const els = pending; pending = null; return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ seq: 0, events: [{ event: "elements", data: { elements: els } }] }) }); } r.continue(); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__board && window.__board.ready === true", { timeout: 45000 }); await sleep(1500);
  pending = Array.from({ length: 200 }, (_, i) => hatched(i, 1e5)); await Q.post("home", "/api/comment", { text: "nudge" });
  await sleep(5000);
  const pg = await Promise.race([page.evaluate(() => { const els = window.__excalidrawAPI.getSceneElements().filter((e) => /^ch\d+$/.test(e.id)); return { n: els.length, hatched: els.filter((e) => e.fillStyle !== "solid").length }; }).catch((e) => ({ error: e.message })), sleep(15000).then(() => "HUNG")]);
  ok(pg !== "HUNG" && pg.n === 200 && pg.hatched === 0, `N1-r3d an open page that gets 200 big hatched boxes draws them solid and keeps answering (${JSON.stringify(pg)})`);
  await kill(b); await Q.stop();
}

/* N11 (item 3): links that contain the board's own address (r3-b8-originlink.mjs) */
{
  const hits = [];
  const evil = http.createServer((q, s) => { hits.push(q.url); s.writeHead(200, { "content-type": "text/html" }); s.end("<h1>Your session expired. Sign in again.</h1>"); }).listen(EVIL, "127.0.0.1");
  const B = await board(PORT, "n11"), E = `http://127.0.0.1:${EVIL}`, O = `http://localhost:${PORT}`;
  const variants = [["control: plain link", `${E}/control`], ["origin in the query", `${E}/query?u=${O}`], ["origin in the hash", `${E}/hash#${O}`], ["origin as user:pass", `http://localhost:${PORT}@127.0.0.1:${EVIL}/userinfo`]];
  await B.scene("guest", variants.map(([, link], i) => ({ ...base, id: `ol${i}`, type: "rectangle", x: 100 + i * 180, y: 650, width: 140, height: 80, link })));
  await sleep(600);
  const stored = Object.fromEntries(sceneOf(B.dir).filter((e) => /^ol/.test(e.id)).map((e) => [e.id, e.link ?? null]));
  ok(stored.ol3 === null && stored.ol0 === variants[0][1], `N11-r3a a link with a user:pass part is dropped, a plain one kept (${JSON.stringify(stored)})`);
  const b = await launch(), out = [];
  for (const i of [0, 1, 2]) {
    const before = hits.length, tabsBefore = (await b.pages()).length;
    const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.goto(`${O}/?probe`, { waitUntil: "domcontentloaded" }); await p.waitForFunction("window.__board && window.__board.ready === true", { timeout: 45000 }); await sleep(1200);
    const icon = await p.evaluate((id) => { const api = window.__excalidrawAPI, st = api.getAppState(), z = st.zoom.value, e = api.getSceneElements().find((x) => x.id === id);
      return e ? ExcalidrawLib.sceneCoordsToViewportCoords({ sceneX: e.x + e.width + 4 / z - 3 / z + 7 / z, sceneY: e.y - 4 / z - 14 / z + 3 / z + 5.6 / z }, st) : null; }, `ol${i}`);
    let done = false;
    if (icon) for (const dx of [-6, -3, 0, 3, 6]) { for (const dy of [-6, -3, 0, 3, 6]) { await p.mouse.click(icon.x + dx, icon.y + dy).catch(() => {}); await sleep(150); if (hits.length > before) { done = true; break; } } if (done) break; }
    await sleep(1000);
    const tabs = await b.pages();
    out.push({ v: variants[i][0], board: p.url().startsWith(O), newTabs: tabs.length - tabsBefore - 1, reached: hits.length > before });
    for (const t of tabs.slice(tabsBefore)) await t.close().catch(() => {});
  }
  ok(out.every((x) => x.board && x.newTabs === 1 && x.reached), `N11-r3b every link click opens a new tab and the board's tab stays on the board, even for links holding the board's address (${JSON.stringify(out)})`);
  await kill(b); evil.close(); await B.stop();
}

/* S1 (item 4): a guest's comment flood and the owner's comment (r3-wait.mjs) */
{
  const B = await board(PORT, "s1");
  const owner = async (text) => json(await B.post("home", "/api/comment", { text }));
  const flood = async (n) => { let okN = 0; for (let i = 0; i < n; i++) { const r = await B.post("guest", "/api/comment", { text: `g${i}`, name: "Alex" }); if (r.status === 200) okN++; else if (r.status === 429) { await sleep(300); i--; } } return okN; };
  const M = mcpSession(); await M.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r3", version: "0" } }); M.notify("notifications/initialized");
  await M.call("board_open", { dir: B.dir, port: PORT });
  const o1 = await owner("OWNER: please look at the payment flow first");
  const sent = await flood(600); await sleep(1500);
  const got = []; for (;;) { const r = await M.call("board_wait", { timeout_s: 1 }); if (!r.json || r.json.timeout) break; got.push(r.json); if (got.length > 700) break; }
  const first = got[0] || {}, dropped = got.reduce((s, e) => s + (e.dropped_guest_comments || 0), 0), guests = got.filter((e) => e.via === "link").length;
  ok(first.id === o1.id && guests + dropped === sent, `S1a after ${sent} guest comments, board_wait returns the owner's comment first (${JSON.stringify(first.content)}), then ${guests} guest comments, reporting the ${dropped} it dropped`);
  M.p.kill();
  const marker = await owner("marker"), sent2 = await flood(300), o2 = await owner("OWNER: the second question");
  const w = run(B.dir, ["wait", "--since", marker.id, "--timeout", "3s"]); let e = null; try { e = JSON.parse(w.stdout); } catch { /* checked below */ }
  ok(w.status === 0 && e && e.id === o2.id && e.skipped_guest_comments === sent2, `S1b \`wait --since\` returns the owner's comment on the first call, saying it passed ${e && e.skipped_guest_comments} guest comments (of ${sent2})`);
  await B.stop();
}

/* S3 (item 5): chunked uploads and the link's write budget (r3-budget.mjs) */
{
  const B = await board(PORT, "s3"); let ver = 1;
  const rect = (id, v) => ({ id, type: "rectangle", x: (v % 50) * 3, y: 0, width: 10, height: 10, version: v, versionNonce: 1, strokeColor: "a".repeat(190), backgroundColor: "b".repeat(190), name: "c".repeat(190), groupIds: ["g".repeat(120)] });
  const res = {};
  for (const chunked of [false, true]) {
    const codes = {}; let taken = 0; const t0 = Date.now();
    await Promise.all([0, 1, 2, 3].map(async () => { while (Date.now() - t0 < 8000) { ver++; const body = { c: B.guest.c, name: "Alex", elements: Array.from({ length: 2000 }, (_, i) => rect(`f${i}`, ver)) };
      const r = await B.post("guest", "/api/scene", body, undefined, undefined, { chunked }); codes[r.status] = (codes[r.status] || 0) + 1; if (r.status === 200) taken += JSON.stringify(body).length; else await sleep(200); } }));
    res[chunked ? "chunked" : "with length"] = { codes, mbps: +(taken / 1e6 / ((Date.now() - t0) / 1000)).toFixed(1) };
  }
  ok(res.chunked.mbps <= 4 && res["with length"].mbps <= 4 && res.chunked.codes[429] > 0, `S3 chunked uploads pay the link's write budget like any other (${JSON.stringify(res)})`);
  await B.stop();
}

/* S4 (item 6): the shell lines `open` prints (r3-open.mjs) */
{
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sketchcall-r3-open-")), mark = path.join(parent, "PWNED");
  const weird = path.join(parent, `a b "q" $(touch PWNED) \`touch PWNED2\` a'b`);   // pasted lines run in the parent folder, so a $() would make PWNED there
  fs.mkdirSync(weird);
  const o = run(parent, ["open", "--dir", weird, "--no-open", "--port", String(PORT)]);
  const lines = o.stdout.split("\n").filter((l) => /npx sketchcall (wait|say|stop)/.test(l)).map((l) => l.slice(l.indexOf("npx sketchcall")).trim().replace(/\s{2,}\S.*$/, "").replace(/^npx sketchcall/, "printf '%s\\n'"));   // "Stop the board with: npx …" too
  const echoed = lines.map((l) => spawnSync("/bin/sh", ["-c", l], { cwd: parent, encoding: "utf8" }).stdout.split("\n"));
  const tell = o.stdout.split("\n").find((l) => /Then tell it/.test(l)) || "";
  ok(o.status === 0 && lines.length >= 3 && !fs.existsSync(mark) && !fs.existsSync(`${mark}2`) && echoed.every((a) => a.includes(weird)) && tell.includes(`'${weird.replace(/'/g, "'\\''")}'`),
    `S4 every shell line \`open\` prints keeps the folder name one quoted word: pasted, nothing runs and the exact path comes through (${lines.length} lines; ran: ${fs.existsSync(mark) || fs.existsSync(`${mark}2`)})`);
  run(parent, ["stop", "--dir", weird]);
}

/* S5 (item 7): one guest starving the others (r3-misc.mjs) */
{
  const B = await board(PORT, "s5");
  let served = 0, last; for (let i = 0; i < 70; i++) { last = await hit(PORT, "/", { host: TUNNEL, headers: guestAt("203.0.113.7") }); if (last.status === 200) served++; }
  const mate = await hit(PORT, "/", { host: TUNNEL, headers: guestAt("198.51.100.9") });
  ok(last.status === 429 && mate.status === 200, `S5a one guest loading the page 70 times is stopped (${served} served, then ${last.status}), and a teammate at another address still gets in (${mate.status})`);
  // writes: one guest floods; another guest's comment still goes through
  const mateCreds = credsIn(mate.body); let n429 = 0; const t0 = Date.now();
  while (Date.now() - t0 < 4000) { const r = await B.post("guest", "/api/scene", { c: B.guest.c, name: "Alex", elements: Array.from({ length: 1900 }, (_, i) => ({ ...base, id: `w${i}`, type: "rectangle", strokeColor: "#".padEnd(190, "a"), version: 2 + Math.floor((Date.now() - t0) / 10) })) }); if (r.status === 429) n429++; }
  const c = await B.post("guest", "/api/comment", { text: "can I still comment?", name: "Sam" }, mateCreds, "198.51.100.9");
  ok(n429 > 0 && c.status === 200, `S5b while one guest is told to slow down (${n429} times), a guest at another address still comments (${c.status})`);
  await B.stop();
}
for (const b of browsers) await kill(b);
console.log("(done)");
