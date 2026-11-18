// Guided-tour gate: the tour, the agent's pointer with cursor chat, and the person's TOUR lines, on headless pages over a
// fresh copy of the sample board, on a spare port. It posts tours, moves the pointer and writes comments.
//   node tests/tour-test.mjs [spare port 4900–4940] [shots dir]      → 48 PASS lines; screenshots of every step when a dir is given
import fs from "fs"; import puppeteer from "puppeteer";
import { ok, sleep, cli as run, scratch, serveBoard, portArg, poll, settle, until, joined } from "./lib.mjs";
const PORT = portArg(2, 4911), SHOTS = process.argv[3], D = scratch("tour"), U = `http://localhost:${PORT}/`;
const cli = (...a) => run(D, ...a);
const ev = () => fs.existsSync(`${D}/.whiteboard-agents/events.log`) ? fs.readFileSync(`${D}/.whiteboard-agents/events.log`, "utf8") : "";
const tourLines = () => ev().split("\n").filter((l) => l.startsWith("TOUR: "));
const WATCH = /COMMENT|BOARD|EDIT/;   // what a watcher greps events.log for
const thread = () => fs.readFileSync(`${D}/.whiteboard-agents/thread.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const STEPS = { title: "How the test BOARD fits together", steps: [
  { target: "app", title: "Box A starts it", text: "Everything begins in box A. It takes the request and hands it on." },
  { target: "api", title: "Box B finishes", text: "Box B does the work and writes the answer back.",
    points: [{ target: "api", text: "This is where the answer gets written." }, { target: { x: 560, y: 104 }, text: "And out it goes, bottom right." }] },
  { target: ["app", "api"], title: "Together", text: "A hands to B. That's the whole board: one request in, one answer out." },
  { target: { area: { x: -40, y: -40, w: 640, h: 184 } }, title: "The whole area", text: "Drag around an area to comment on it, the same way this step frames one." },
] };
fs.writeFileSync(`${D}/tour-steps.json`, JSON.stringify(STEPS));

const srv = await serveBoard(D, PORT);
// Several pages animate at once here: without these flags headless Chrome stops requestAnimationFrame in every tab but the
// front one, so a background page never glides (and a click on it hangs on scrollIntoView).
const b = await puppeteer.launch({ headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const open = async (q, w = 1440, h = 900, ctx = b) => {
  const p = await ctx.newPage(); await p.setViewport({ width: w, height: h }); const errs = [], posts = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  p.on("request", (r) => r.method() === "POST" && posts.push(new URL(r.url()).pathname));
  await p.goto(U + q, { waitUntil: "networkidle2" }); await p.waitForFunction("window.__board && window.__board.ready === true", { timeout: 30000 });
  p.errs = errs; p.posts = posts; return p; };
// A person clicks the window in front: bring the page forward and let it settle (a click right on the switch can miss).
const front = async (p) => { await p.bringToFront(); await sleep(150); };
// Click like a person: in front, and nothing (Claude's bubble, the card) covering the button's middle. A covered button is a FAIL.
const press = async (p, sel) => {
  await front(p);
  const top = await p.evaluate((q) => { const e = document.querySelector(q), r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !t || e === t || e.contains(t) ? null : t.id || t.className || t.tagName; }, sel);
  if (top) ok(false, `${sel} is covered by ${top}`);
  await p.click(sel);
};
const tour = (p) => p.evaluate(() => __board.tour());
const ptr = (p) => p.evaluate(() => __board.pointer());
// For a moment that passes (a beat's words while they're up, mid-typing): watched inside the page, which is in front then.
const untilIn = (p, fn, arg, ms = 15000) => p.waitForFunction(fn, { timeout: ms, polling: 100 }, arg).then(() => true, () => false);
// the beats of the step on screen (not a step left behind) have played to the end
const beatsDone = (p) => settle(p, () => { const b = __board.pointer().beats, t = __board.tour(); return !!b && b.done && (!t.active || b.step === t.at); }, null, 15000);
// Geometry measured independently of the tour code: Excalidraw's own bounds and scene→viewport mapping, against the DOM.
const geo = (p, target) => p.evaluate((t) => {
  const api = __excalidrawAPI, st = api.getAppState(), v = (x, y) => ExcalidrawLib.sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, st);
  let r;
  if (t && t.area) r = [t.area.x, t.area.y, t.area.x + t.area.w, t.area.y + t.area.h];
  else if (t && typeof t === "object" && !Array.isArray(t)) r = [t.x, t.y, t.x, t.y];
  else r = ExcalidrawLib.getCommonBounds(api.getSceneElements().filter((e) => [].concat(t).includes(e.id)));
  const a = v(r[0], r[1]), c = v(r[2], r[3]), dom = (id) => { const q = document.getElementById(id).getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; };
  const tip = document.querySelector("#cptr svg").getBoundingClientRect(), cv = document.querySelector(".excalidraw").getBoundingClientRect();
  return { box: { x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y }, anchor: t && typeof t === "object" && !Array.isArray(t) && !t.area ? a : { x: a.x, y: (a.y + c.y) / 2 },
    ring: dom("spotRing"), card: dom("tourCard"), bubble: dom("cchat"), tip: { x: tip.left + 3, y: tip.top + 2 }, canvas: { x: cv.left, y: cv.top, w: cv.width, h: cv.height },
    dim: ["x", "y", "width", "height"].map((k) => +document.getElementById("spotDim").getAttribute(k)), spot: getComputedStyle(document.getElementById("spot")).display };
}, target);
const near = (a, b, px = 3) => Math.abs(a - b) <= px;
// The camera's glide has ended: the cut-out and the card hold still for 400 ms with the cut-out on the box.
const steady = (p, target) => poll(async () => { const a = await geo(p, target); await sleep(400); const b = await geo(p, target);
  return ringOk(b) && JSON.stringify([a.ring, a.card]) === JSON.stringify([b.ring, b.card]); });
const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const ringOk = (g) => near(g.ring.x, g.box.x - 14) && near(g.ring.y, g.box.y - 14) && near(g.ring.w, g.box.w + 28) && near(g.ring.h, g.box.h + 28);
const gapOf = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const inside = (a, c) => a.x >= c.x - 1 && a.y >= c.y - 1 && a.x + a.w <= c.x + c.w + 1 && a.y + a.h <= c.y + c.h + 1;

const A = await open("");                       // the host, 1440×900
const B = await open("?name=Sam", 1280, 800);
await joined(A); await joined(B);
// 1 the tour op puts every open page into guided mode at step 1
cli("tour", "tour-steps.json");
const on1 = await until(A, () => __board.tour().active && __board.tour().at === 1) && await until(B, () => __board.tour().active && __board.tour().at === 1);
ok(on1, "1 a posted tour opens on both pages at step 1");
await steady(A, "app");   // the 450 ms glide
let g = await geo(A, "app");
ok(g.spot === "block" && ringOk(g), `1b A's cut-out matches app's viewport rect + 14 px (ring ${JSON.stringify(g.ring)} vs box ${JSON.stringify(g.box)})`);
ok(near(g.dim[0], g.canvas.x) && near(g.dim[2], g.canvas.w) && near(g.dim[3], g.canvas.h), "1c the dim covers the canvas only, not the panel");
ok(!hits(g.card, g.ring) && gapOf(g.card, g.ring) <= 40 && inside(g.card, g.canvas), `1d at 1440×900 the card sits beside the cut-out, not over it (gap ${Math.round(gapOf(g.card, g.ring))} px, side ${(await tour(A)).side})`);
ok((await A.evaluate(() => document.getElementById("on").textContent)).startsWith("on: step 1/4"), "1e the composer points at the step");
// 2 after zoom and scroll, the cut-out and the pointer stay on the box
await beatsDone(A);
await A.evaluate(() => { const st = __excalidrawAPI.getAppState(); __excalidrawAPI.updateScene({ appState: { zoom: { value: .7 }, scrollX: st.scrollX + 130, scrollY: st.scrollY - 70 } }); });
await poll(async () => ringOk(await geo(A, "app"))); g = await geo(A, "app");
ok(ringOk(g), `2 after zoom 70% + scroll the cut-out still matches (ring ${JSON.stringify(g.ring)} vs box ${JSON.stringify(g.box)})`);
ok(near(g.tip.x, g.anchor.x) && near(g.tip.y, g.anchor.y), `2b the pointer's tip is on app's centre-left edge after zoom (${Math.round(g.tip.x)},${Math.round(g.tip.y)} vs ${Math.round(g.anchor.x)},${Math.round(g.anchor.y)})`);
ok(!hits(g.bubble, g.box) && g.bubble.w > 0 && inside(g.bubble, g.canvas), `2c the bubble is up, inside the board, and doesn't cover app (${(await A.evaluate(() => document.getElementById("cchat").className))})`);
// 3 Next / Back / keys / dots / Done, and Next finishes the beats first
await press(A, "#tcNext");
await untilIn(A, () => { const b = __board.pointer().beats; return b && b.step === 2 && !b.done; });
await front(A); await A.keyboard.press("ArrowRight"); await sleep(150);
const p3 = await ptr(A);
ok((await tour(A)).at === 2 && p3.beats.done && p3.text === "And out it goes, bottom right." && p3.typed === p3.text.length, `3 → during step 2's beats finishes them and stays (at ${(await tour(A)).at}, "${p3.text}")`);
g = await geo(A, { x: 560, y: 104 });
ok(near(g.tip.x, g.anchor.x) && near(g.tip.y, g.anchor.y), "3b … with the pointer on the last beat's point");
await front(A); await A.keyboard.press("ArrowRight"); await sleep(200);
ok((await tour(A)).at === 3, "3c the next → moves on to step 3");
await press(A, "#tcBack"); await sleep(200); ok((await tour(A)).at === 2, "3d Back → 2");
await front(A); await A.keyboard.press("ArrowLeft"); await sleep(200); ok((await tour(A)).at === 1, "3e ← → 1");
// beats play in order: step 2's first beat on api, then its second on the point (560,104)
await A.evaluate(() => document.querySelectorAll("#tcDots button")[1].click());
const beat = (k, text) => untilIn(A, (a) => { const p = __board.pointer(), b = p.beats; return b && b.step === 2 && b.k === a[0] && p.talking && p.text === a[1]; }, [k, text]);
const b1 = await beat(0, "This is where the answer gets written."); g = await geo(A, "api");
ok(b1 && near(g.tip.x, g.anchor.x) && near(g.tip.y, g.anchor.y), `3e2 beat 1 of step 2 comes first, on api's centre-left edge (${Math.round(g.tip.x)},${Math.round(g.tip.y)})`);
const b2 = await beat(1, "And out it goes, bottom right."); g = await geo(A, { x: 560, y: 104 });
ok(b2 && near(g.tip.x, g.anchor.x) && near(g.tip.y, g.anchor.y), `3e3 then beat 2, on the point (560,104) (${Math.round(g.tip.x)},${Math.round(g.tip.y)})`);
await beatsDone(A);
await press(A, "#tcDots button:nth-child(3)"); await sleep(200); ok((await tour(A)).at === 3, "3f the third dot jumps to 3");
await A.evaluate(() => document.querySelectorAll("#tourSteps li")[3].click()); await sleep(200);
ok((await tour(A)).at === 4 && (await A.evaluate(() => document.querySelectorAll("#tourSteps li")[3].className)) === "cur", "3g the panel's step 4 jumps there and is highlighted");
ok((await A.evaluate(() => document.getElementById("tcNext").textContent)) === "Done", "3h Next reads Done on the last step");
await beatsDone(A); await front(A); await A.keyboard.press("ArrowRight"); await sleep(200);
ok((await tour(A)).at === 4 && (await tour(A)).active, "3i → on the last step stays put");
await press(A, "#tcNext"); await sleep(1500);   // its own quiet window, so the next move doesn't replace the "finished" line
const t3 = await tour(A);
ok(!t3.active && t3.resumable && await A.evaluate(() => getComputedStyle(document.getElementById("tourResume")).display !== "none"), "3j Done leaves the tour and shows ▶ Resume tour");
await press(A, "#tourResume"); await sleep(300); ok((await tour(A)).active, "3k Resume brings it back");
await front(A); await A.keyboard.press("Escape"); await sleep(300); ok(!(await tour(A)).active, "3l Esc leaves it");
// 4 the person's moves land in events.log as quiet TOUR lines (debounced, never in the thread, never matching the watcher)
await poll(() => tourLines().some((l) => l.startsWith("TOUR: Host exited at step")));
const tl = tourLines();
ok(tl.some((l) => /^TOUR: Host at step \d\/4 \(How the test B·oard fits together\)$/.test(l)) && tl.some((l) => l.startsWith("TOUR: Host finished")) && tl.some((l) => l.startsWith("TOUR: Host exited at step")),
  `4 TOUR lines name the host's step, finish and exit ${JSON.stringify(tl.slice(-3))}`);
ok(!ev().split("\n").some((l) => WATCH.test(l)), "4b no events.log line matches a watcher's COMMENT|BOARD|EDIT (the title's BOARD is defanged)");
ok(thread().every((i) => i.kind === "comment" || i.kind === "op") && !thread().some((i) => i.kind === "op" && !["tour", "tour_step", "point"].includes(i.op)), "4c the moves never reach thread.jsonl");
const n4 = tourLines().length; await press(A, "#tourResume");
for (const i of [1, 2, 3]) await A.evaluate((n) => document.querySelectorAll("#tcDots button")[n - 1].click(), i);
await poll(() => tourLines().length > n4); await sleep(1800);   // the line is in; then time for a second, wrong one
ok(tourLines().length === n4 + 1 && tourLines().at(-1).startsWith("TOUR: Host at step 3/4"), `4d four quick moves make one line, the last one (${JSON.stringify(tourLines().slice(n4))})`);
// 5 tour_step drives both pages; both see the same pointer
cli("tour-step", "3");
const d5 = await until(A, () => __board.tour().at === 3) && await until(B, () => __board.tour().at === 3);
ok(d5 && (await tour(A)).following && (await tour(B)).following, "5 tour-step 3 moves both following pages to step 3");
await beatsDone(A); await beatsDone(B);
const [pa, pb] = [await ptr(A), await ptr(B)];
ok(pa.shown && pb.shown && JSON.stringify(pa.at) === JSON.stringify(pb.at) && pa.text === pb.text && pa.text.startsWith("A hands to B"), `5b both pages show the pointer at the same spot saying the same words (${JSON.stringify(pa.at)})`);
ok(await A.evaluate(() => document.getElementById("tcFollow").textContent.includes("following Claude")), "5c the card says ● following Claude");
// 6 a viewer who wanders sees the chip; Claude moving on doesn't move them; the chip brings them back
await beatsDone(B);   // or the first Next only finishes Claude's beats (by design) and Sam stays on step 3
await press(B, "#tcNext");
const chip = () => B.evaluate(() => { const c = document.getElementById("tcRejoin"); return c ? c.textContent : null; });
const camOf = (p) => p.evaluate(() => { const s = __excalidrawAPI.getAppState(); return JSON.stringify([s.scrollX, s.scrollY, s.zoom.value]); });
await until(B, () => __board.tour().at === 4 && !__board.tour().following && /Claude is on 3\/4/.test((document.getElementById("tcRejoin") || {}).textContent || ""));
await poll(async () => { const c = await camOf(B); await sleep(300); return c === await camOf(B); });   // Sam's own glide has finished
ok((await tour(B)).at === 4 && !(await tour(B)).following && (await chip() || "").includes("Claude is on 3/4"), `6 Sam stepped ahead: chip "${await chip()}" ${JSON.stringify(await tour(B))}`);
const camB = await B.evaluate(() => { const s = __excalidrawAPI.getAppState(); return [s.scrollX, s.scrollY, s.zoom.value]; });
cli("tour-step", "2");
await until(A, () => __board.tour().at === 2); await until(B, () => /Claude is on 2\/4/.test((document.getElementById("tcRejoin") || {}).textContent || "")); await sleep(1500);   // then time for a wrong camera move
const camB2 = await B.evaluate(() => { const s = __excalidrawAPI.getAppState(); return [s.scrollX, s.scrollY, s.zoom.value]; });
ok((await tour(B)).at === 4 && JSON.stringify(camB) === JSON.stringify(camB2) && (await chip() || "").includes("Claude is on 2/4"), "6b tour-step 2 moves the host; Sam's step and camera stay, the chip updates");
ok((await ptr(B)).beats.step === 2, "6c … while Sam's pointer plays Claude's step 2");
await press(B, "#tcRejoin"); await until(B, () => __board.tour().at === 2 && __board.tour().following && !document.getElementById("tcRejoin"));
ok((await tour(B)).at === 2 && (await tour(B)).following && !(await chip()), "6d the chip takes Sam back to Claude's step 2, following again");
// 7 a comment during a step lands on the step's boxes
await beatsDone(B);
await B.evaluate(() => { document.getElementById("box").value = "why does B write back?"; document.getElementById("send").click(); });
await poll(() => thread().filter((i) => i.kind === "comment").at(-1).text === "why does B write back?" && /COMMENT by Sam \[on: step 2/.test(ev()));
const c7 = thread().filter((i) => i.kind === "comment").at(-1);
ok(c7 && c7.text === "why does B write back?" && c7.on && c7.on.ids.includes("api") && c7.on.label.startsWith("step 2/4") && /COMMENT by Sam \[on: step 2\/4 · Box B finishes\]/.test(ev()),
  `7 Sam's comment lands on step 2's box (${JSON.stringify(c7 && c7.on)})`);
// 8 the point op works outside a tour, on every page
await front(A); await A.keyboard.press("Escape"); await sleep(300);
cli("point", "api", "this is the box that writes back");
await until(A, () => __board.pointer().talking && __board.pointer().typed === __board.pointer().text.length && __board.pointer().text === "this is the box that writes back");
g = await geo(A, "api");
ok(!(await tour(A)).active && near(g.tip.x, g.anchor.x) && near(g.tip.y, g.anchor.y), `8 point api outside a tour: A's tip is on api's centre-left edge (${Math.round(g.tip.x)},${Math.round(g.tip.y)} vs ${Math.round(g.anchor.x)},${Math.round(g.anchor.y)})`);
ok(g.bubble.w > 0 && !hits(g.bubble, g.box) && inside(g.bubble, g.canvas), "8b the bubble shows the words, inside the board, and doesn't cover api");
await until(B, () => __board.pointer().text === "this is the box that writes back");
ok(JSON.stringify((await ptr(A)).at) === JSON.stringify((await ptr(B)).at), "8c B sees the same pointer");
if (SHOTS) await A.screenshot({ path: `${SHOTS}/point-outside-tour.png` });
// 9 a reload never restarts the tour: it waits behind Resume, which picks up Claude's step
await A.reload({ waitUntil: "networkidle2" }); await A.waitForFunction("window.__board && window.__board.ready === true", { timeout: 30000 }); await sleep(2500);
const t9 = await tour(A);
ok(!t9.active && t9.resumable && await A.evaluate(() => getComputedStyle(document.getElementById("tourResume")).display !== "none" && document.getElementById("tourGo").textContent.includes("Resume")), "9 after a reload the tour doesn't restart; ▶ Resume tour shows");
ok(!(await ptr(A)).shown, "9b … and no old gesture replays");
await press(A, "#tourResume"); await until(A, () => __board.tour().active && __board.tour().at === 2);
ok((await tour(A)).active && (await tour(A)).at === 2, "9c Resume opens at Claude's step (2)");
// 10 a ?probe page (its own browser profile) shows the tour but never writes
const ctx = await b.createBrowserContext(); const P = await open("?probe=1", 1200, 800, ctx); await joined(P); await sleep(1500);   // then time for a wrong auto-start
ok(!(await tour(P)).active, "10 a probe page doesn't auto-start the old tour");
const n10 = tourLines().length;
await press(P, "#tourResume"); await until(P, () => !!document.querySelector("#tcDots button:nth-child(4)")); await press(P, "#tcDots button:nth-child(4)"); await front(P); await P.keyboard.press("Escape"); await sleep(1800);
ok(tourLines().length === n10 && !P.posts.length, `10b its moves post nothing (${JSON.stringify(P.posts)})`);
ok(await P.evaluate(() => !Object.keys(localStorage).some((k) => k.endsWith(":tour"))), "10c and leave nothing in its localStorage");
// 11 the phone: card beside (below) the cut-out, inside the board
const Ph = await open("?name=Phone", 393, 852, ctx);
await joined(Ph); await until(Ph, () => __board.tour().resumable); await press(Ph, "#tourResume"); await steady(Ph, "api");
g = await geo(Ph, "api");
ok(ringOk(g) && !hits(g.card, g.ring) && inside(g.card, { x: 0, y: 0, w: 393, h: 852 }), `11 at 393×852 the card sits ${(await tour(Ph)).side} the cut-out, not over it (gap ${Math.round(gapOf(g.card, g.ring))} px)`);
if (SHOTS) {
  await untilIn(Ph, () => __board.pointer().talking); await sleep(900);
  await Ph.screenshot({ path: `${SHOTS}/phone-step2-beat.png` });
  // 12 screenshots: every step of a freshly posted tour, mid-beat and after, at 1440×900
  await front(A); cli("tour", "tour-steps.json"); await until(A, () => __board.tour().active && __board.tour().at === 1);
  for (let i = 1; i <= 4; i++) {
    if (i > 1) { await A.evaluate((n) => document.querySelectorAll("#tcDots button")[n - 1].click(), i); }
    await untilIn(A, () => { const p = __board.pointer(), b = p.beats; return b && b.step === __board.tour().at && !b.done && p.talking && p.typed > 6 && p.typed < p.text.length - 4; });
    await A.screenshot({ path: `${SHOTS}/step${i}-mid-beat.png` });
    await beatsDone(A); await sleep(300);
    await A.screenshot({ path: `${SHOTS}/step${i}.png` });
  }
}
for (const [n, p] of [["A", A], ["B", B], ["P", P], ["Phone", Ph]]) ok(!p.errs.length, `13 no console errors in ${n} ${JSON.stringify(p.errs.slice(0, 3))}`);
await b.close(); srv.kill();
console.log(`(board copy: ${D})`);
