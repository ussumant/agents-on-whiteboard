// Live drawing gate: an agent's box, area, note and arrow are drawn in front of the person, with that agent's marker in its
// colour, and land on every open page with no reload, with ids every page agrees on. Two real MCP sessions ("Claude" and
// "Codex") drive headless pages over a fresh copy of the sample board, on a spare port.
//   node tests/draw-test.mjs [spare port 4900–4940] [shots dir]      → PASS lines
import fs from "fs"; import puppeteer from "puppeteer";
import { ok, sleep, scratch, serveBoard, mcpSession, portArg, settle, until, joined } from "./lib.mjs";
const PORT = portArg(2, 4937), SHOTS = process.argv[3], D = scratch("draw"), U = `http://localhost:${PORT}/`;
const LIVE = `${D}/.agents-on-whiteboard`, ev = () => fs.existsSync(`${LIVE}/events.log`) ? fs.readFileSync(`${LIVE}/events.log`, "utf8") : "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

async function session(presenter) {
  const m = mcpSession(["--channels"]);
  await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "draw-test", version: "0" } });
  m.notify("notifications/initialized");
  await m.call("board_open", { dir: D, port: PORT, ...(presenter ? { presenter } : {}) });
  return m;
}
const srv = await serveBoard(D, PORT);
// One browser per page: a headless tab that isn't in front gets no animation frames and reports itself hidden, and these
// two pages stand for two windows people are looking at.
const ARGS = { headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] };
const browsers = [];
const errs = [];
const open = async (w = 1440, h = 900) => {
  const b = await puppeteer.launch(ARGS); browsers.push(b);
  const p = (await b.pages())[0] || await b.newPage(); await p.setViewport({ width: w, height: h });
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(U, { waitUntil: "domcontentloaded" }); await until(p, () => window.__board && window.__board.ready, null, 30000); await joined(p);
  return p;
};
const ids = (p, pre) => p.evaluate((pre) => window.__board.elements().filter((e) => e.id.startsWith(pre)).map((e) => e.id).sort(), pre);
const el = (p, id) => p.evaluate((id) => { const e = window.__board.elements().find((x) => x.id === id); return e ? { type: e.type, x: e.x, y: e.y, w: e.width, h: e.height, text: e.text, stroke: e.strokeColor, bg: e.backgroundColor, dashed: e.strokeStyle, z: e.customData && e.customData.z, groups: e.groupIds } : null; }, id);
const ptr = (p, name) => p.evaluate((name) => { const s = window.__board.pointer(name); return s ? { drawing: s.drawing, shown: s.shown, ink: s.ink, at: s.at, talking: s.talking, text: s.text } : null; }, name);
const inkCount = (p) => p.evaluate(() => document.getElementById("penInk").children.length + document.getElementById("penText").children.length);
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png` }); };

try {
  const C = await session(), X = await session("Codex"); globalThis.C = C; globalThis.X = X;
  const A = await open(), B = await open();
  const hasPointer = await A.evaluate(() => typeof window.__board.pointer === "function");
  ok(hasPointer, "0 the page reports its pointers (window.__board.pointer)");

  // 1 a box near the queue, below, with an arrow from it: drawn in front of the person, then real
  const r1 = await C.call("board_box", { ref: "retry", title: "🔁 Retry worker", sub: "tries failed orders again", near: "queue", side: "below", from: "queue", label: "failed" });
  ok(!r1.err && r1.json && r1.json.x === 660 && r1.json.y === 230, `1a board_box places it under the queue, in the free spot (${r1.text.slice(0, 160)})`);
  const drew = await settle(A, () => { const s = window.__board.pointer("Claude"); return !!(s && s.drawing && s.shown); }, null, 4000);
  ok(drew >= 0, `1b Claude's pointer turns into its marker while it draws (${drew} ms)`);
  const mid = await settle(A, () => document.getElementById("penInk").children.length > 0 && !window.__board.elements().some((e) => e.id === "retry"), null, 3000);
  ok(mid >= 0, `1c mid-way it is ink on the page, not yet an element (${mid} ms)`);
  await sleep(900); await shot(A, "1-mid-draw");
  const landed = await settle(A, () => ["retry", "retry__title", "retry__sub", "retry__from"].every((id) => window.__board.elements().some((e) => e.id === id)), null, 9000);
  ok(landed >= 0, `1d the box, its title, its small line and its arrow land with no reload (${landed} ms after the marker)`);
  const box = await el(A, "retry"), title = await el(A, "retry__title"), arrow = await el(A, "retry__from"), lab = await el(A, "retry__from__label");
  ok(box && box.x === 660 && box.y === 230 && box.w === 236 && box.h === 104 && box.stroke === "#1e1e1e" && box.bg === "#ffffff" && box.groups.includes("retry__grp"),
    `1e in the board's own style, grouped (${JSON.stringify(box)})`);
  ok(title && title.text === "🔁 Retry worker" && title.groups.includes("retry__grp"), `1f the title is the agent's words (${JSON.stringify(title)})`);
  ok(arrow && arrow.type === "arrow" && arrow.z === "under" && lab && lab.text === "failed", `1g the arrow from the queue, labelled, under the boxes (${JSON.stringify(arrow)} ${JSON.stringify(lab)})`);
  const gone = await settle(A, () => document.getElementById("penInk").children.length + document.getElementById("penText").children.length === 0, null, 3000);
  ok(gone >= 0, "1h the ink is gone once the real lines are there");
  const pb = await settle(B, () => window.__board.elements().some((e) => e.id === "retry__from"), null, 9000);
  const [ia, ib] = [await ids(A, "retry"), await ids(B, "retry")];
  ok(pb >= 0 && JSON.stringify(ia) === JSON.stringify(ib) && ia.length === 5, `1i the second open page has the same elements, the same ids (${ia.join(",")} | ${ib.join(",")})`);
  await shot(A, "1-landed");

  // 2 a second agent draws in its own colour, at the same time as the first
  const before = await ptr(A, "Claude");
  const [r2, r3] = await Promise.all([
    X.call("board_box", { ref: "tips", title: "💸 Tips", sub: "added at checkout", near: "courier", side: "below", color: "green" }),
    C.call("board_note", { ref: "n1", x: 0, y: 400, text: "retries cap at 3" }),
  ]);
  ok(!r2.err && !r3.err, `2a both agents' calls go through (${r2.text.slice(0, 80)} | ${r3.text.slice(0, 80)})`);
  const both = await settle(A, () => { const c = window.__board.pointer("Claude"), x = window.__board.pointer("Codex"); return !!(c && x && c.drawing && x.drawing); }, null, 4000);
  const cx = await ptr(A, "Codex"), cc = await ptr(A, "Claude");
  ok(both >= 0 && cx.ink !== cc.ink, `2b two markers draw at once, each in its own colour (Claude ${cc.ink}, Codex ${cx.ink})`);
  const capInk = await A.evaluate(() => { const p = [...document.querySelectorAll(".cptr")].find((e) => e.querySelector(".tag").textContent === "Codex"); return p && p.querySelector(".pen .cap").getAttribute("fill"); });
  ok(capInk === cx.ink, `2c Codex's marker is in Codex's colour (${capInk})`);
  await sleep(700); await shot(A, "2-two-markers");
  const both2 = await settle(A, () => ["tips", "tips__title", "n1"].every((id) => window.__board.elements().some((e) => e.id === id)), null, 9000);
  const tips = await el(A, "tips");
  ok(both2 >= 0 && tips && tips.stroke === "#2f9e44" && tips.x === 1320 && tips.y === 230, `2d both land; Codex's green box under the courier (${JSON.stringify(tips)})`);
  ok(before && !before.drawing, "2e (the first drawing had ended before these began)");

  // 3 an area around the queue and the retry worker, then the whole board
  const r4 = await C.call("board_area", { ref: "v2", label: "v2: retries", target: ["queue", "retry"], color: "violet" });
  ok(!r4.err, `3a board_area takes the boxes (${r4.text.slice(0, 120)})`);
  const area = await settle(A, () => window.__board.elements().some((e) => e.id === "v2__label"), null, 9000);
  const v2 = await el(A, "v2"), v2l = await el(A, "v2__label");
  ok(area >= 0 && v2.dashed === "dashed" && v2.z === "under" && v2.stroke === "#7048e8" && v2l.text === "v2: retries", `3b a dashed frame under the boxes, with its label (${JSON.stringify(v2)})`);
  await C.call("board_focus", { target: "retry" }); await sleep(1200);
  const z0 = await A.evaluate(() => window.__board.zoomNow());
  await C.call("board_focus", { target: "all" });
  const every = ["app", "courier", "db", "retry", "tips", "n1", "v2"];
  const onScreen = (ids) => ids.every((id) => { const a = window.__board.screenPointFor(id, 0, 0), b = window.__board.screenPointFor(id, 1, 1);
    return a && b && a.x >= 0 && a.y >= 0 && b.x <= innerWidth && b.y <= innerHeight; });
  const zoomed = await settle(A, onScreen, every, 4000);
  ok(zoomed >= 0, `3c board_focus "all" zooms out until every box is on screen (${z0.toFixed(2)} → ${(await A.evaluate(() => window.__board.zoomNow())).toFixed(2)})`);
  await sleep(600); await shot(A, "3-whole-board");

  // 4 a gesture right after a drawing waits for it, then plays
  await C.call("board_box", { ref: "alerts", title: "🔔 Alerts", near: "kitchen", side: "above" });
  await C.call("board_point", { target: "alerts", text: "This pings the kitchen when a retry fails." });
  const order = await settle(A, () => { const s = window.__board.pointer("Claude"); return !!(s && s.talking && s.text.startsWith("This pings")); }, null, 12000);
  const hadBox = await A.evaluate(() => window.__board.elements().some((e) => e.id === "alerts"));
  ok(order >= 0 && hadBox, `4 the point waits for the box, then talks (box there when the words start: ${hadBox})`);

  // 5 a tab in the background gets the box at once, with no show
  await B.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
  await X.call("board_box", { ref: "hidden1", title: "🧊 Freezer", near: "db", side: "below" });
  const quick = await settle(B, () => window.__board.elements().some((e) => e.id === "hidden1"), null, 5000);
  const xb = await ptr(B, "Codex");
  ok(quick >= 0 && quick < 2500 && !(xb && xb.drawing), `5 a hidden tab lands it straight away, with no marker show (${quick} ms, ${JSON.stringify(xb && { drawing: xb.drawing })})`);

  // 6 a reload: everything is still there, and nothing is drawn again
  await A.reload({ waitUntil: "domcontentloaded" }); await until(A, () => window.__board && window.__board.ready, null, 30000); await joined(A);
  const kept = await settle(A, () => ["retry", "retry__from", "tips", "n1", "v2", "alerts", "hidden1"].every((id) => window.__board.elements().some((e) => e.id === id)), null, 8000);
  const re = await ptr(A, "Claude");
  ok(kept >= 0 && !(re && re.drawing) && (await inkCount(A)) === 0, `6 after a reload it is all there, and the record isn't drawn again (${JSON.stringify(re)})`);

  // 7 the agents don't hear their own drawing as someone writing
  await sleep(4000);
  const own = ev().split("\n").filter((l) => /BOARD:.*(Retry worker|tries failed|failed|Tips|added at checkout|v2: retries|Alerts|Freezer)/.test(l));
  const pushed = [...C.notes, ...X.notes].filter((n) => n.meta && n.meta.kind === "board");
  ok(own.length === 0 && pushed.length === 0, `7 no BOARD event for the agents' own words (${own.length} log lines, ${pushed.length} pushes)`);

  // 8 bad input is refused with a reason the agent can act on
  const bad = await Promise.all([
    C.call("board_box", { ref: "x1", title: "a", near: "nope" }), C.call("board_box", { ref: "retry", title: "again" }),
    C.call("board_box", { ref: "x2", title: "a", color: "pink" }), C.call("board_area", { ref: "x3", label: "a", target: ["zzz"] }),
  ]);
  ok(bad.every((r) => r.err), `8 a missing box, a used ref, an unknown colour and a missing area box are refused (${bad.map((r) => r.text.slice(0, 50)).join(" | ")})`);

  // 10 the agents on the board, top right: one avatar each, in its colour; the "to" picker once there are two
  const ag = await settle(A, () => { const a = window.__board.agents(); return a.avatars.length === 2; }, null, 5000);
  const a0 = await A.evaluate(() => window.__board.agents());
  ok(ag >= 0 && a0.avatars.map((x) => x.name).sort().join() === "Claude,Codex" && a0.avatars[0].ink !== a0.avatars[1].ink && a0.to === "",
    `10 an avatar per agent, each in its colour, and a "to" picker on everyone (${JSON.stringify(a0)})`);

  // 11 click Codex: follow it. Its drawing moves the camera; Claude's doesn't
  await A.click('#agents button[data-name="Codex"]');
  const f1 = await A.evaluate(() => window.__board.agents());
  const chip = await A.evaluate(() => getComputedStyle(document.getElementById("followChip")).display !== "none" && document.querySelector("#followChip span").textContent);
  ok(f1.following === "Codex" && f1.frame && f1.to === "Codex" && chip === "Following Codex", `11a clicking Codex follows it: the frame, "Following Codex", comments to Codex (${JSON.stringify(f1)} ${chip})`);
  await sleep(800);
  const app0 = await A.evaluate(() => window.__board.screenPointFor("app"));
  await C.call("board_box", { ref: "far-c", title: "🧾 Receipts", near: "app", side: "above" });
  await settle(A, () => window.__board.elements().some((e) => e.id === "far-c"), null, 9000);
  const app1 = await A.evaluate(() => window.__board.screenPointFor("app"));
  ok(Math.abs(app0.x - app1.x) < 1 && Math.abs(app0.y - app1.y) < 1, `11b Claude's drawing doesn't move the camera of someone following Codex (${JSON.stringify(app0)} → ${JSON.stringify(app1)})`);
  await X.call("board_box", { ref: "far-x", title: "📦 Packing", sub: "boxes the pizza", near: "app", side: "left" });
  const moved = await settle(A, (p0) => { const p = window.__board.screenPointFor("app"); return Math.abs(p.x - p0.x) > 5 || Math.abs(p.y - p0.y) > 5; }, app1, 6000);
  ok(moved >= 0, `11c Codex's drawing does (${moved} ms)`);
  await settle(A, () => window.__board.elements().some((e) => e.id === "far-x"), null, 9000); await sleep(400); await shot(A, "11-following-codex");
  await A.keyboard.press("Escape");
  const f2 = await A.evaluate(() => window.__board.agents());
  ok(f2.following === null && !f2.frame, `11d Esc stops following (${JSON.stringify(f2)})`);

  // 12 talking to one agent: the picker, or an @Name at the start; no name is everyone
  const notesOf = (s) => s.notes.filter((n) => n.meta && n.meta.kind === "comment");
  const [c0, x0] = [notesOf(C).length, notesOf(X).length];
  await A.select("#to", "Codex"); await A.type("#box", "Codex, how do tips get paid?"); await A.click("#send");
  for (let i = 0; i < 50 && notesOf(X).length === x0; i++) await sleep(100);
  const gotX = notesOf(X).length === x0 + 1;
  await sleep(800);
  ok(gotX && notesOf(C).length === c0, `12a a comment to Codex reaches Codex only (Codex ${notesOf(X).length - x0}, Claude ${notesOf(C).length - c0})`);
  const toLine = await A.evaluate(() => [...document.querySelectorAll("#thread .msg .meta")].map((m) => m.textContent).find((t) => t.includes("→")));
  ok(/You → Codex/.test(toLine || ""), `12b the panel says who it was for (${toLine})`);
  await A.select("#to", ""); await A.type("#box", "@Claude are retries capped?"); await A.click("#send");
  for (let i = 0; i < 50 && notesOf(C).length === c0; i++) await sleep(100);
  await sleep(800);
  ok(notesOf(C).length === c0 + 1 && notesOf(X).length === x0 + 1, `12c "@Claude …" reaches Claude only (Claude ${notesOf(C).length - c0}, Codex ${notesOf(X).length - x0})`);
  await A.type("#box", "Both of you: what's missing?"); await A.click("#send");
  for (let i = 0; i < 50 && notesOf(X).length < x0 + 2; i++) await sleep(100);
  await sleep(800);
  ok(notesOf(C).length === c0 + 2 && notesOf(X).length === x0 + 2, `12d a comment naming no one reaches both (Claude ${notesOf(C).length - c0}, Codex ${notesOf(X).length - x0})`);

  // 13 agents hand each other work with @Name; never their own words, and at most 4 between two of the person's comments
  const [c1, x1] = [notesOf(C).length, notesOf(X).length];
  await X.call("board_say", { text: "@Claude can you draw where a failed tip goes?" });
  for (let i = 0; i < 50 && notesOf(C).length === c1; i++) await sleep(100);
  const hand = notesOf(C).at(-1);
  ok(notesOf(C).length === c1 + 1 && hand.meta.via === "agent" && hand.meta.author === "Codex" && notesOf(X).length === x1,
    `13a Codex's "@Claude …" reaches Claude, from Codex, and not Codex itself (${JSON.stringify(hand && hand.meta)})`);
  await C.call("board_say", { text: "On it." });
  await sleep(600);
  ok(notesOf(X).length === x1, "13b a reply that names no one wakes no one");
  for (let i = 0; i < 6; i++) await X.call("board_say", { text: `@Claude ping ${i}` });
  await sleep(1500);
  ok(notesOf(C).length === c1 + 4, `13c at most 4 hand-offs reach an agent between two of the person's comments (${notesOf(C).length - c1})`);

  ok(errs.length === 0, `9 no page errors (${errs.slice(0, 3).join(" | ")})`);
} finally {
  for (const b of browsers) await b.close(); srv.kill(); for (const s of [globalThis.C, globalThis.X]) if (s) s.p.kill();
  process.exit(process.exitCode || 0);   // the MCP sessions' pipes would keep node running
}
