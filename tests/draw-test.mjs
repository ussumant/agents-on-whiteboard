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

  ok(errs.length === 0, `9 no page errors (${errs.slice(0, 3).join(" | ")})`);
} finally {
  for (const b of browsers) await b.close(); srv.kill(); for (const s of [globalThis.C, globalThis.X]) if (s) s.p.kill();
  process.exit(process.exitCode || 0);   // the MCP sessions' pipes would keep node running
}
