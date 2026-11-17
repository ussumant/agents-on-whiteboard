// Presenter gate: named presenters, each with its own pointer, name and colour; the tour presenter's pointer and name on
// screen for the whole tour; ✓ keep / ✎ change answers on the card; the card's feedback loop. Two real MCP sessions
// (sketchcall mcp --channels over stdio, "Look session" and "Plugin session") drive headless pages over a fresh copy of the
// sample board, on a spare port.
//   node tests/presenter-test.mjs [spare port 4900–4940] [shots dir]      → PASS lines; screenshots at 1440×900 and 393×852
// It waits ~65 s at the end for the 60 s park-then-fade.
import fs from "fs"; import puppeteer from "puppeteer";
import { ok, sleep, cli as run, scratch, serveBoard, mcpSession, portArg, poll, settle, until, joined } from "./lib.mjs";
const PORT = portArg(2, 4912), SHOTS = process.argv[3], D = scratch("presenter"), U = `http://localhost:${PORT}/`;
const cli = (...a) => run(D, ...a);
const ev = () => fs.existsSync(`${D}/live/events.log`) ? fs.readFileSync(`${D}/live/events.log`, "utf8") : "";
const thread = () => fs.readFileSync(`${D}/live/thread.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const answers = () => thread().filter((i) => i.kind === "op" && i.op === "answer");
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// An MCP session with channel push on, recording every channel message it pushes.
async function session(presenter) {
  const m = mcpSession(["--channels"]);
  await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "presenter-test", version: "0" } });
  m.notify("notifications/initialized");
  const opened = await m.call("board_open", { dir: D, port: PORT, ...(presenter ? { presenter } : {}) });
  return { p: m.p, call: m.call, notes: m.notes, opened };
}

const srv = await serveBoard(D, PORT);
const b = await puppeteer.launch({ headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const open = async (q, w = 1440, h = 900, ctx = b) => {
  const p = await ctx.newPage(); await p.setViewport({ width: w, height: h }); const errs = [], posts = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  p.on("request", (r) => r.method() === "POST" && posts.push(new URL(r.url()).pathname));
  await p.goto(U + q, { waitUntil: "networkidle2" }); await p.waitForFunction("window.__board && window.__board.ready === true", { timeout: 30000 });
  p.errs = errs; p.posts = posts; return p; };
const front = async (p) => { await p.bringToFront(); await sleep(150); };
// Click like a person: in front, and nothing (a bubble, the card) covering the button's middle. A covered button is a FAIL.
const press = async (p, sel) => {
  await front(p);
  const top = await p.evaluate((q) => { const e = document.querySelector(q), r = e.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !t || e === t || e.contains(t) ? null : t.id || t.className || t.tagName; }, sel);
  if (top) ok(false, `${sel} is covered by ${top}`);
  await p.click(sel);
};
const tour = (p) => p.evaluate(() => __board.tour());
const ptrs = (p) => p.evaluate(() => __board.pointers());
const beatsDone = (p) => settle(p, () => { const b = __board.pointer().beats, t = __board.tour(); return !!b && b.done && (!t.active || b.step === t.at); }, null, 15000);
const hits = (a, c) => !!a && !!c && a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
const inside = (a, c) => a.x >= c.x - 1 && a.y >= c.y - 1 && a.x + a.w <= c.x + c.w + 1 && a.y + a.h <= c.y + c.h + 1;
const rectOf = (p, sel) => p.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel);
const textOf = (p, sel) => p.evaluate((q) => { const e = document.querySelector(q); return e ? e.textContent : null; }, sel);
const visible = (p, sel) => p.evaluate((q) => { const e = document.querySelector(q); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; }, sel);
const waitFor = async (fn, ms) => (await poll(fn, ms)) >= 0;

// The sampler: every 50 ms while a tour is on, is the presenter's pointer showing, is its name tag showing its name, is
// anything covering that tag (a bubble, another pointer's tag), and is it inside the board? Talking and between-beats
// ticks are counted per step. (The pointers take no clicks, so elementFromPoint can't see them: overlap is geometric.)
const sampler = (p) => p.evaluate(() => {
  window.__samp = [];
  const hit = (a, c) => a && c && a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
  window.__sampT = setInterval(() => {
    const t = __board.tour(); if (!t.active) return;
    const me = __board.pointer(), all = __board.pointers(), cv = document.querySelector(".excalidraw").getBoundingClientRect(), r = me.tag.rect;
    // covered: a bubble (z above the pointers) or another pointer's name tag on top of this one's
    const by = all.filter((q) => (q.bubble && hit(q.bubble, r)) || (q.name !== me.name && q.shown && hit(q.tag.rect, r))).map((q) => `${q.bubble && hit(q.bubble, r) ? "bubble" : "tag"} of ${q.name}`);
    const covered = by.length > 0;
    __samp.push({ step: t.at, name: me.name, shown: me.shown && !me.fading, tag: me.tag.shown && me.tag.text === me.name, covered, by: by.join(", "), k: me.beats && me.beats.k,
      on: r.x >= cv.left && r.y >= cv.top && r.x + r.w <= cv.right && r.y + r.h <= cv.bottom, talking: me.talking, between: !!(me.beats && !me.beats.done && !me.talking) });
  }, 50);
});
const samples = (p) => p.evaluate(() => { clearInterval(__sampT); return __samp; });

const STEPS = { title: "How the test board fits together", steps: [
  { target: "app", title: "Box A starts it", text: "Everything begins in box A. It takes the request and hands it on." },
  { target: "api", title: "Box B finishes", text: "Box B does the work and writes the answer back.",
    points: [{ target: "api", text: "This is where the answer gets written." }, { target: { x: 560, y: 104 }, text: "And out it goes, bottom right." }] },
  { target: ["app", "api"], title: "One hand-off", text: "A hands to B. That's the whole board.", ask: { question: "Keep it as one hand-off?" } },
] };

const A = await open("");                                 // the host, 1440×900
const B = await open("?name=Sam", 1280, 800);
const Ph = await open("?name=Phone", 393, 852);
// Each page's first fetch of the record has to be in before the tour is posted: a tour that arrives in the first fetch is
// history (it waits behind Resume) and never opens. The dot turns on in the same step that ends that fetch.
for (const p of [A, B, Ph]) await joined(p);
const L = await session("Look session"), G = await session("Plugin session");
ok(!L.opened.err && L.opened.text.includes('present as "Look session"') && !G.opened.err && G.opened.text.includes('present as "Plugin session"'), `1 board_open takes a presenter (${L.opened.text.slice(-120)})`);
for (const p of [A, B, Ph]) await sampler(p);

// 2 Look session posts a tour; every page opens it, and the card and the pointer say who presents
const posted = await L.call("board_tour", STEPS);
ok(!posted.err && posted.json.presenter === "Look session" && posted.json.steps[2].ask.question === "Keep it as one hand-off?", "2 board_tour writes the presenter and the step's ask");
const on2 = await until(A, () => __board.tour().active && __board.tour().at === 1) && await until(B, () => __board.tour().active) && await until(Ph, () => __board.tour().active);
ok(on2 && (await tour(A)).presenter === "Look session", "2b the tour opens on all three pages, presented by Look session");
const p2 = await A.evaluate(() => __board.pointer());
ok(p2.shown && p2.tag.shown && p2.tag.text === "Look session" && p2.id !== "cptr", `2c the pointer is up at once with its own name tag (${p2.id}, "${p2.tag.text}")`);
ok((await textOf(A, "#tcFollow")).includes("presented by Look session"), `2d the card says who presents ("${await textOf(A, "#tcFollow")}")`);
const inkL = p2.ink;
ok(/^#[0-9a-f]{6}$/i.test(inkL) && inkL.toLowerCase() !== "#7048e8" && (await A.evaluate(() => getComputedStyle(document.querySelector(`#${__board.pointer().id} .tag`)).backgroundColor)) !== "rgb(112, 72, 232)",
  `2e Look session has its own colour, not Claude's purple (${inkL})`);

// 3 Look session drives every step; the sampler watches the pointer through glides, talking and the pauses between beats
for (const i of [1, 2, 3]) {
  const r = await L.call("board_tour_step", { index: i });
  ok(!r.err && r.json.presenter === "Look session", `3.${i} board_tour_step ${i} by Look session`);
  await until(A, (n) => __board.tour().at === n, i);
  await beatsDone(A); await beatsDone(B); await beatsDone(Ph);   // every page finishes the step before the next one comes
  // …and its sampler has caught the pointer talking on it: the last beat's words stay up until the next step, but the
  // sampler's 50 ms timer runs late on a busy machine (12 ticks in a step instead of 65, at load 44).
  for (const p of [A, B, Ph]) await until(p, (n) => __samp.some((x) => x.step === n && x.talking), i);
  if (SHOTS && i === 2) await A.screenshot({ path: `${SHOTS}/1440-step2-look-session.png` });
  await sleep(400);
}
ok((await textOf(A, "#tcFollow")).includes("following Look session") && (await textOf(A, "#tourSteps .who")) === "Look session", "3b the card reads ● following Look session, the panel tags the step with the name");
for (const [n, p] of [["A 1440×900", A], ["Phone 393×852", Ph], ["Sam 1280×800", B]]) {
  const s = await p.evaluate(() => __samp.slice());
  const bad = s.filter((x) => !x.shown || !x.tag || x.covered || x.name !== "Look session"), off = s.filter((x) => !x.on);
  const per = [1, 2, 3].map((k) => { const st = s.filter((x) => x.step === k); return { step: k, ticks: st.length, talking: st.filter((x) => x.talking).length, between: st.filter((x) => x.between).length }; });
  const why = {}; for (const x of bad) { const k = `step ${x.step} beat ${x.k}: ${!x.shown ? "hidden" : !x.tag ? "tag hidden" : x.by}`; why[k] = (why[k] || 0) + 1; }
  ok(s.length > 60 && !bad.length && per.every((x) => x.ticks > 5 && x.talking > 0), `3c ${n}: pointer and its name tag showing, uncovered, on every tick of every step (${s.length} ticks, ${bad.length} bad ${JSON.stringify(why)}, per step ${JSON.stringify(per)})`);
  ok(per[1].between > 0, `3d ${n}: … including between step 2's beats (${per[1].between} ticks)`);
  ok(!off.length, `3e ${n}: … and inside the board on every tick (${off.length} off)`);
}

// 4 a second session can't drive Look session's tour, or post one over it
const s4 = await G.call("board_tour_step", { index: 1 });
ok(s4.err && s4.text.startsWith("Look session is presenting"), `4 Plugin session's board_tour_step fails naming Look session ("${s4.text}")`);
const t4 = await G.call("board_tour", { title: "mine", steps: [{ target: "app", text: "x" }] });
ok(t4.err && t4.text.startsWith("Look session is presenting") && t4.text.includes("take_over"), "4b … and so does posting its own tour over it");
ok((await tour(A)).at === 3 && (await tour(A)).id === posted.json.tour_id, "4c the pages never moved");

// 5 two presenters' pointers on two pages: Plugin session points while Look session's tour is on
const cam = () => A.evaluate(() => { const s = __excalidrawAPI.getAppState(); return [s.scrollX, s.scrollY, s.zoom.value].map((v) => Math.round(v * 100)); });
const cam5 = await cam();
const pt = await G.call("board_point", { target: "app", text: "Plugin session here: this is the box I changed." });
ok(!pt.err && pt.json.presenter === "Plugin session", "5 board_point writes Plugin session as the presenter");
for (const [n, p] of [["A", A], ["Sam", B], ["Phone", Ph]]) {
  await until(p, () => { const q = __board.pointer("Plugin session"); return q.talking && q.typed === q.text.length; });
  const all = (await ptrs(p)).filter((q) => q.shown), look = all.find((q) => q.name === "Look session"), plug = all.find((q) => q.name === "Plugin session");
  ok(look && plug && look.tag.shown && plug.tag.shown && look.tag.text === "Look session" && plug.tag.text === "Plugin session" && look.ink !== plug.ink,
    `5b ${n}: two pointers, "Look session" ${look && look.ink} and "Plugin session" ${plug && plug.ink}, each with its name showing`);
  ok(look && plug && !all.some((q) => q.bubble && (hits(q.bubble, look.tag.rect) || hits(q.bubble, plug.tag.rect))) && !hits(look.tag.rect, plug.tag.rect),
    `5c ${n}: no bubble covers either name tag, and the two tags don't overlap (${JSON.stringify([look && look.tag.rect, plug && plug.tag.rect])})`);
}
ok(JSON.stringify(await cam()) === JSON.stringify(cam5) && (await A.evaluate(() => __board.pointer("Look session").beats.done)), "5d a guest pointer neither pans the host's camera nor stops Look session's step");
if (SHOTS) { await front(A); await A.screenshot({ path: `${SHOTS}/1440-two-presenters.png` }); await front(Ph);
  await until(Ph, () => __board.pointer("Plugin session").talking); await Ph.screenshot({ path: `${SHOTS}/393-two-presenters.png` }); }

// 6 the step's question: ✓ keep from the host
ok(await visible(A, "#tcAsk") && (await textOf(A, "#tcQ")) === "Keep it as one hand-off?" && await visible(A, "#tcKeep") && await visible(A, "#tcWhat"), "6 step 3's card shows the question, ✓ keep, ✎ change and the field");
const n6 = L.notes.length, g6 = G.notes.length;
await press(A, "#tcKeep");
const a6 = await waitFor(() => answers().length === 1) && answers()[0];
ok(a6 && a6.pick === "keep" && a6.step === 3 && a6.author === "you" && a6.presenter === "Look session" && a6.tour_id === posted.json.tour_id && a6.on.ids.join() === "app,api",
  `6b the answer lands in the thread: ${JSON.stringify(a6 && { op: a6.op, pick: a6.pick, step: a6.step, author: a6.author, presenter: a6.presenter, on: a6.on && a6.on.ids })}`);
ok(/COMMENT by Host \[answer to step 3\/3 · One hand-off\]: ✓ keep/.test(ev()), "6c … and in events.log as a line a watcher wakes on");
const c6 = await waitFor(() => L.notes.slice(n6).some((x) => x.meta.kind === "answer")) && L.notes.slice(n6).find((x) => x.meta.kind === "answer");
ok(c6 && c6.content === "✓ keep" && c6.meta.pick === "keep" && c6.meta.step === "3" && c6.meta.box_ids === "app,api" && c6.meta.author === "you" && c6.meta.answer_id === a6.id,
  `6d Look session gets it as a channel message: ${JSON.stringify(c6)}`);
await sleep(800);
ok(!G.notes.slice(g6).some((x) => x.meta.kind === "answer"), "6e Plugin session, not presenting, gets no answer");
for (const [n, p] of [["A", A], ["Sam", B]]) {
  await until(p, () => __board.tour().answered.includes(3));
  ok(await p.evaluate(() => document.querySelectorAll("#tcDots button")[2].classList.contains("ans") && !document.querySelectorAll("#tcDots button")[0].classList.contains("ans")
    && document.querySelectorAll("#tourSteps li")[2].querySelector(".ans") !== null), `6f ${n}: step 3 is ticked in the dots and the panel, step 1 isn't`);
}
// 7 ✎ change from Sam: nothing goes with an empty field; with words it does, and Look session hears it
const a7 = answers().length;
await press(B, "#tcChange"); await sleep(700);   // long enough for a wrong send to land
ok(answers().length === a7 && await until(B, () => document.getElementById("tcWhat").classList.contains("want") && document.activeElement.id === "tcWhat"), "7 ✎ change with an empty field sends nothing and asks for words");
await B.type("#tcWhat", "make it two steps"); await B.keyboard.press("Enter");
const c7 = await waitFor(() => L.notes.some((x) => x.meta.kind === "answer" && x.meta.pick === "change")) && L.notes.find((x) => x.meta.kind === "answer" && x.meta.pick === "change");
ok(answers().length === a7 + 1 && answers().at(-1).author === "sam" && answers().at(-1).text === "make it two steps" && c7 && c7.content === "✎ change → make it two steps" && c7.meta.author === "sam",
  `7b Enter sends ✎ change → "make it two steps" from Sam; Look session gets "${c7 && c7.content}"`);

// 8 the feedback loop on the card: the person's note reaches the presenter, the reply comes back under it
ok(await visible(A, "#tcFbOpen") && !(await visible(A, "#tcFbText")), "8 the card has a 💬 Feedback button, field closed");
await press(A, "#tcFbOpen");
ok(await visible(A, "#tcFbText") && await A.evaluate(() => document.activeElement.id === "tcFbText"), "8b it opens a one-line field, focused");
const n8 = L.notes.length;
await A.type("#tcFbText", "why does A hand off at all?"); await press(A, "#tcFbSend");
const c8 = await waitFor(() => L.notes.slice(n8).some((x) => x.meta.kind === "comment")) && L.notes.slice(n8).find((x) => x.meta.kind === "comment");
const fb = thread().filter((i) => i.kind === "comment").at(-1);
ok(fb && fb.text === "why does A hand off at all?" && fb.on.tour === posted.json.tour_id && fb.on.step === 3 && c8 && c8.meta.tour_id === posted.json.tour_id && c8.meta.step === "3" && c8.meta.box_ids === "app,api",
  `8c the note lands on step 3's boxes and reaches Look session (${JSON.stringify(c8 && c8.meta)})`);
const r8 = await L.call("board_say", { text: "Because B can't start until A has the request.", reply_to: fb.id });
ok(!r8.err && r8.json.presenter === "Look session", "8d Look session replies to it with board_say reply_to");
const loop = () => A.evaluate(() => [...document.querySelectorAll("#tcLoop .m")].map((m) => m.textContent));
const l8 = await until(A, () => [...document.querySelectorAll("#tcLoop .m")].some((m) => m.textContent.startsWith("Look session") && m.textContent.includes("Because B")));
ok(l8, `8e the reply shows under the note on the card: ${JSON.stringify(await loop())}`);
const r8b = await L.call("board_say", { text: "Two steps it is: I'll split it.", reply_to: c7.meta.answer_id });
await until(A, () => [...document.querySelectorAll("#tcLoop .m")].some((m) => m.textContent.includes("I'll split it")));
const l8b = await loop();
ok(!r8b.err && l8b[0] === "You✓ keep" && l8b[1] === "Sam✎ change → make it two steps" && l8b.some((t) => t === "Look sessionTwo steps it is: I'll split it."),
  `8f answers and a reply to an answer join the same loop, in order: ${JSON.stringify(l8b)}`);
ok(await A.evaluate(() => [...document.querySelectorAll("#thread .msg .meta b")].some((b) => b.textContent === "Look session")), "8g the panel names the reply Look session, not Claude");
const g8 = await A.evaluate(() => { const c = document.getElementById("tourCard").getBoundingClientRect(), cv = document.querySelector(".excalidraw").getBoundingClientRect(); return { c: { x: c.left, y: c.top, w: c.width, h: c.height }, cv: { x: cv.left, y: cv.top, w: cv.width, h: cv.height } }; });
ok(inside(g8.c, g8.cv), `8h the card, ask and loop included, stays inside the board at 1440×900 (${JSON.stringify(g8.c)})`);
await front(A); await sleep(300);
// elementFromPoint skips anything with pointer-events: none (the pointers, the dim), so for a moment everything takes
// clicks: whatever is painted over the button row then shows up. (The sample board has no frames, so no walk buttons:
// the row is checked at its Export button.)
const walk = await A.evaluate(() => { const w = document.querySelector("#exportBtn"), r = w.getBoundingClientRect(), st = document.createElement("style");
  st.textContent = "* { pointer-events: auto !important; }"; document.head.appendChild(st);
  const all = document.elementsFromPoint(r.left + 6, r.top + 6).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : ""}`);
  const t = document.elementFromPoint(r.left + 6, r.top + 6); st.remove();
  return { ok: t === w, display: getComputedStyle(document.getElementById("chrome")).display, stack: all, at: [Math.round(r.left), Math.round(r.top)], vp: [innerWidth, innerHeight] }; });
ok(walk.ok, `8i the button row is still on screen with the loop open (${JSON.stringify(walk)})`);
// …and painted: a screenshot of the button row's strip, decoded in the page, has its white buttons in it (a headless shot
// once showed the strip empty while the DOM had the buttons on top)
const painted = async () => { const r = await rectOf(A, "#buttons"), png = await A.screenshot({ encoding: "base64", clip: { x: r.x, y: r.y, width: r.w, height: r.h } });
  return A.evaluate(async (b64) => { const im = new Image(); im.src = `data:image/png;base64,${b64}`; await im.decode(); const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
    const x = c.getContext("2d"); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let w = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) w++; return w; }, png); };
const paint = [await painted()]; await sleep(1000); paint.push(await painted()); await sleep(2000); paint.push(await painted());
ok(paint.every((w) => w > 1000), `8j … and painted in a screenshot: white pixels in its strip at 0 s, 1 s, 3 s = ${JSON.stringify(paint)}`);
if (SHOTS) await A.screenshot({ path: `${SHOTS}/1440-step3-ask-and-loop.png` });

// 9 the phone: the card with its question stays on screen and its buttons work
await front(Ph); await sleep(300);
const g9 = await rectOf(Ph, "#tourCard");
ok(inside(g9, { x: 0, y: 0, w: 393, h: 852 }) && await visible(Ph, "#tcKeep"), `9 at 393×852 the card with the question sits on screen (${JSON.stringify(g9)})`);
if (SHOTS) await Ph.screenshot({ path: `${SHOTS}/393-step3-ask.png` });
await press(Ph, "#tcKeep");
ok(await waitFor(() => answers().at(-1).author === "phone"), "9b ✓ keep works on the phone");

// 10 ticks survive a reload; a probe page shows the question but can't answer or send feedback
// The host reloads the page they are looking at (a tab in the background loads late when the machine is busy).
await front(A); await A.reload({ waitUntil: "networkidle2" }); await A.waitForFunction("window.__board && window.__board.ready === true", { timeout: 30000 });
await until(A, () => __board.tour().answered.includes(3)); await sleep(2000);   // the record is in; then time for a wrong restart to show
ok(!(await tour(A)).active && (await tour(A)).answered.includes(3), "10 after a reload the tour waits behind Resume and still knows step 3 is answered");
await press(A, "#tourResume");
ok(await until(A, () => { const d = document.querySelectorAll("#tcDots button")[2]; return !!d && d.classList.contains("ans") && document.querySelectorAll("#tcLoop .m").length >= 4; }), `10b Resume shows the tick and the whole loop (${(await loop()).length} lines)`);
const ctx = await b.createBrowserContext(); const P = await open("?probe=1", 1200, 800, ctx); await until(P, () => __board.tour().resumable);
await press(P, "#tourResume"); await until(P, () => !!document.querySelector("#tcDots button:nth-child(3)")); await press(P, "#tcDots button:nth-child(3)");
await sleep(600);   // long enough for a wrong post to go out
ok(await until(P, () => { const e = document.getElementById("tcQ"); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; }) && !(await visible(P, "#tcKeep")) && !(await visible(P, "#tcFbOpen")) && !P.posts.length, `10c a probe page shows the question, no buttons, posts nothing (${JSON.stringify(P.posts)})`);

// 11 a pointer with no presenter is still Claude's, purple; the default stays the default
cli("point", "api", "plain Claude, no presenter");
await until(B, () => __board.pointer("Claude").talking);
const cl = await B.evaluate(() => __board.pointer("Claude"));
ok(cl.shown && cl.id === "cptr" && cl.tag.text === "Claude" && cl.ink === "#7048e8", "11 the CLI's point with no --presenter is Claude's own purple pointer (#cptr)");

// 12 outside a tour a pointer stays parked 60 s, then fades
await front(A); await A.keyboard.press("Escape"); const t12 = Date.now();
await until(A, () => { const q = __board.pointer("Look session"); return !__board.tour().active && q.shown && !q.talking; });
const p12 = await A.evaluate(() => __board.pointer("Look session"));
ok(!(await tour(A)).active && p12.shown && !p12.talking, "12 after the host leaves the tour, Look session's pointer stays parked, words gone");
await sleep(Math.max(0, t12 + 55000 - Date.now()));
ok((await A.evaluate(() => __board.pointer("Look session").shown)), "12b … still there at 55 s");
await sleep(Math.max(0, t12 + 62500 - Date.now()));
const p12c = await A.evaluate(() => __board.pointers().filter((q) => q.shown).map((q) => q.name));
ok(!p12c.includes("Look session"), `12c … and gone by 62 s (still up: ${JSON.stringify(p12c)})`);

// 14 take_over, and following follows whoever drove last
const t14 = await G.call("board_tour", { title: "Plugin's turn", take_over: true, steps: [{ target: "api", title: "Plugin's turn", text: "The host asked me to show B." }] });
ok(!t14.err && t14.json.presenter === "Plugin session", "14 with take_over, Plugin session can post its own tour over Look session's");
const on14 = await settle(B, (id) => __board.tour().id === id && __board.tour().presenter === "Plugin session" && document.getElementById("tcFollow").textContent.includes("presented by Plugin session"), t14.json && t14.json.tour_id);
ok(on14 >= 0, `14b Sam's page moves to it; the card says "${await textOf(B, "#tcFollow")}" (${on14} ms)`);
const s14 = await L.call("board_tour_step", { index: 2, tour_id: posted.json.tour_id });
const back14 = await settle(B, (id) => { const t = __board.tour(); return t.id === id && t.at === 2 && t.presenter === "Look session" && document.getElementById("tcFollow").textContent.includes("following Look session"); }, posted.json.tour_id);
ok(!s14.err && back14 >= 0, `14c Look session drives its own tour again: following pages go back to it, at step 2 (${back14} ms; the card says "${await textOf(B, "#tcFollow")}")`);

for (const [n, p] of [["A", A], ["Sam", B], ["Phone", Ph], ["Probe", P]]) ok(!p.errs.length,`13 no console errors in ${n} ${JSON.stringify(p.errs.slice(0, 3))}`);
L.p.kill(); G.p.kill(); await b.close(); srv.kill();
console.log(`(board copy: ${D})`);
