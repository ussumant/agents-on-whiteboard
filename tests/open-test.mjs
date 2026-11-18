// Open gate: any .excalidraw file loads as it is. The sample board loads, says it's ready, logs no console errors, and
// its Export button downloads the same elements; that download loads back as a board; a board with frames gets one walk
// button per frame. Fresh copies only, two spare ports.
//   node tests/open-test.mjs [spare port 4900–4940] [second spare port]      → PASS lines
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import { ok, sleep, scratch, serveBoard, portArg, SAMPLE } from "./lib.mjs";

const P1 = portArg(2, 4913), P2 = portArg(3, 4914);
const sample = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
// What must survive a round trip: each element's id, type, place, size and text.
const shape = (els) => els.filter((e) => !e.isDeleted).map((e) => [e.id, e.type, Math.round(e.x), Math.round(e.y), Math.round(e.width), Math.round(e.height), e.text ?? null, e.containerId ?? null].join("|")).sort();
const same = (a, b) => JSON.stringify(shape(a)) === JSON.stringify(shape(b));

const b = await puppeteer.launch({ headless: true });
const open = async (port, q = "", w = 1440, h = 900) => {
  const p = await b.newPage(); await p.setViewport({ width: w, height: h }); const errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(`http://localhost:${port}/${q}`, { waitUntil: "networkidle2" });
  p.ready = await p.waitForFunction("window.__board && window.__board.ready === true", { timeout: 30000 }).then(() => true, () => false);
  p.errs = errs; return p;
};
const scene = (p) => p.evaluate(() => __excalidrawAPI.getSceneElementsIncludingDeleted());

// 1 the sample board
const D1 = scratch("open"), s1 = await serveBoard(D1, P1);
const A = await open(P1);
ok(A.ready, "1 the sample board loads and __board.ready is true");
ok(same(await scene(A), sample.elements), `1b it shows the file's elements as they are (${(await scene(A)).length} of ${sample.elements.length})`);
ok((await A.title()) === "pizza · whiteboard-agents", `1c the tab is named after the file ("${await A.title()}")`);
ok((await A.evaluate(() => __board.walkButtons())).length === 0, "1d no frames, no walk buttons");

// 2 Export, pressed like a person, through the browser's own download
const DL = fs.mkdtempSync(path.join(os.tmpdir(), "whiteboard-agents-download-"));
const cdp = await b.target().createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL, eventsEnabled: true });
await A.click("#exportBtn");
const file = path.join(DL, "pizza.excalidraw");
for (let i = 0; i < 50 && !fs.existsSync(file); i++) await sleep(200);
const exported = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
ok(!!exported && exported.type === "excalidraw", `2 Export downloads pizza.excalidraw (${fs.readdirSync(DL).join(", ") || "nothing"})`);
ok(!!exported && same(exported.elements, sample.elements), `2b the download holds the same elements as the file (${exported && exported.elements.length})`);
ok(!A.errs.length, `2c no console errors ${JSON.stringify(A.errs.slice(0, 3))}`);
s1.kill(); await sleep(300);

// 3 the download loads back as a board
const D2 = fs.mkdtempSync(path.join(os.tmpdir(), "whiteboard-agents-roundtrip-"));
if (exported) fs.copyFileSync(file, path.join(D2, "pizza.excalidraw"));
const s2 = await serveBoard(D2, P2);
const R = await open(P2);
ok(R.ready && !!exported && same(await scene(R), exported.elements), "3 the exported file opens as a board with the same elements");
ok(!R.errs.length, `3b no console errors ${JSON.stringify(R.errs.slice(0, 3))}`);
s2.kill(); await sleep(300);

// 4 a board with frames: one walk button per frame, in the file's order, and each frames its own part of the board
const base = sample.elements.find((e) => e.type === "rectangle");
const el = (o) => ({ ...base, groupIds: [], boundElements: [], frameId: null, seed: 7, versionNonce: 7, version: 1, ...o });
const framed = { type: "excalidraw", version: 2, source: "whiteboard-agents", files: {}, appState: { viewBackgroundColor: "#ffffff" }, elements: [
  el({ id: "f1", type: "frame", name: "Ordering", x: 0, y: 0, width: 400, height: 300, roundness: null, backgroundColor: "transparent" }),
  el({ id: "b1", x: 60, y: 80, width: 200, height: 100, frameId: "f1" }),
  el({ id: "f2", type: "frame", name: "Cooking", x: 1600, y: 900, width: 400, height: 300, roundness: null, backgroundColor: "transparent" }),
  el({ id: "b2", x: 1660, y: 980, width: 200, height: 100, frameId: "f2" }),
] };
const D3 = fs.mkdtempSync(path.join(os.tmpdir(), "whiteboard-agents-frames-"));
fs.writeFileSync(path.join(D3, "kitchen.excalidraw"), JSON.stringify(framed));
const s3 = await serveBoard(D3, P2);
const F = await open(P2);
const walk = await F.evaluate(() => __board.walkButtons());
ok(F.ready && JSON.stringify(walk.map((w) => w.text)) === JSON.stringify(["1", "2", "All"]) && walk[0].title === "Ordering" && walk[1].title === "Cooking",
  `4 two frames make walk buttons 1, 2, All ${JSON.stringify(walk)}`);
const inView = (id) => F.evaluate((id) => { const e = __excalidrawAPI.getSceneElements().find((x) => x.id === id), st = __excalidrawAPI.getAppState(),
  a = ExcalidrawLib.sceneCoordsToViewportCoords({ sceneX: e.x, sceneY: e.y }, st), c = ExcalidrawLib.sceneCoordsToViewportCoords({ sceneX: e.x + e.width, sceneY: e.y + e.height }, st),
  cv = document.querySelector(".excalidraw").getBoundingClientRect(); return a.x >= cv.left && a.y >= cv.top && c.x <= cv.right && c.y <= cv.bottom; }, id);
await F.click('#buttons .walk[data-frame="f2"]'); await sleep(400);
const f2 = await inView("f2"), f1 = await inView("f1");
ok(f2 && !f1, `4b button 2 frames "Cooking" and leaves "Ordering" out (${JSON.stringify({ f1, f2 })})`);
ok(!F.errs.length, `4c no console errors ${JSON.stringify(F.errs.slice(0, 3))}`);
s3.kill();
await b.close();
