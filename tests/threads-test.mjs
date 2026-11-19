// Comment threads gate: a pin opens a thread card on the board, a reply from the card joins that thread, agents answer in it
// live on every open page, @ lists the agents to tag, and the agent hears the person's reply with the thread it is in.
// Two real MCP sessions ("Claude" and "Codex") and two headless pages (the host, and ?name=Sam), each page in its own
// browser (a background headless tab gets no animation frames), on a fresh copy of the sample board, on a spare port.
//   node tests/threads-test.mjs [spare port 4900–4940] [shots dir]      → PASS lines
import fs from "fs"; import puppeteer from "puppeteer";
import { ok, sleep, scratch, serveBoard, mcpSession, portArg, poll, until, joined, credsIn, asPage } from "./lib.mjs";
const PORT = portArg(2, 4940), D = scratch("threads"), SHOTS = process.argv[3] || D, U = `http://localhost:${PORT}/`;
const LIVE = `${D}/.agents-on-whiteboard`;
fs.mkdirSync(SHOTS, { recursive: true });
const record = () => fs.existsSync(`${LIVE}/thread.jsonl`) ? fs.readFileSync(`${LIVE}/thread.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const comments = () => record().filter((i) => i.kind === "comment");

async function session(presenter) {
  const m = mcpSession(["--channels"]);
  await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "threads-test", version: "0" } });
  m.notify("notifications/initialized");
  await m.call("board_open", { dir: D, port: PORT, ...(presenter ? { presenter } : {}) });
  return m;
}
const srv = await serveBoard(D, PORT);
const ARGS = { headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] };
const browsers = [], errs = [];
const open = async (q = "", w = 1440, h = 900) => {
  const b = await puppeteer.launch(ARGS); browsers.push(b);
  const p = (await b.pages())[0] || await b.newPage(); await p.setViewport({ width: w, height: h });
  p.on("pageerror", (e) => errs.push(`${q || "host"}: ${e.message}`)); p.on("console", (m) => m.type() === "error" && errs.push(`${q || "host"}: ${m.text()}`));
  await p.goto(U + q, { waitUntil: "domcontentloaded" }); await until(p, () => window.__board && window.__board.ready, null, 30000); await joined(p);
  return p;
};
const card = (p) => p.evaluate(() => window.__board.threadCard());
const pinOf = (p, id) => p.evaluate((id) => window.__board.pinOf(id), id);
// a real click on the pin's middle, only when nothing covers it there (a person can't click a pin under a card either)
const clickPin = async (p, id) => {
  const r = await pinOf(p, id); if (!r) return false;
  const [x, y] = [r.x + r.w / 2, r.y + r.h / 2];
  if (!(await p.evaluate((x, y) => { const t = document.elementFromPoint(x, y); return !!t && t.classList.contains("pin"); }, x, y))) return false;
  await p.mouse.click(x, y); return true;
};
const hit = (a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a, c) => !!a && a.x >= c.x - 1 && a.y >= c.y - 1 && a.x + a.w <= c.x + c.w + 1 && a.y + a.h <= c.y + c.h + 1;
const canvas = (p) => p.evaluate(() => { const q = (document.querySelector(".excalidraw") || document.getElementById("root")).getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; });
const notesOf = (s) => s.notes.filter((n) => n.meta && n.meta.kind === "comment");
const heard = (s, id) => notesOf(s).find((n) => n.meta.comment_id === id);
const page = credsIn(await (await fetch(U)).text());
const postAs = (body) => fetch(`${U}api/comment`, { method: "POST", headers: asPage(page.key, U.slice(0, -1)), body: JSON.stringify(body) });

try {
  const C = await session(), X = await session("Codex"); globalThis.C = C; globalThis.X = X;
  const A = await open(), B = await open("?name=Sam");

  // 1 the host comments on the queue from the panel; both agents hear it, as a comment that starts a thread
  await A.evaluate(() => window.__excalidrawAPI.updateScene({ appState: { selectedElementIds: { queue: true } } }));
  await until(A, () => document.getElementById("on").textContent.includes("Order queue"), null, 3000);
  await A.evaluate(() => { document.getElementById("box").value = "Why does the queue sit between the app and the kitchen?"; document.getElementById("send").click(); });
  await poll(() => comments().some((c) => c.text.startsWith("Why does the queue")));
  const R1 = comments().find((c) => c.text.startsWith("Why does the queue"));
  await A.evaluate(() => window.__excalidrawAPI.updateScene({ appState: { selectedElementIds: {} } }));
  await poll(() => heard(C, R1.id) && heard(X, R1.id), 8000);
  ok(R1 && R1.on && R1.on.id === "queue" && heard(C, R1.id) && heard(X, R1.id) && !heard(C, R1.id).meta.reply_to,
    `1 the host's comment on the queue reaches both agents, with no reply_to (on ${JSON.stringify(R1 && R1.on)})`);

  // 2 Claude answers it; a click on the pin opens the card with the first comment and the answer
  const r2 = await C.call("board_say", { text: "Because the kitchen is slower than the app.", reply_to: R1.id });
  const R2 = r2.json;
  await until(A, (id) => !!window.__board.pinOf(id), R1.id, 8000);
  await until(A, (id) => window.__board.threadOf(id) !== null, R2.id, 8000);
  await A.bringToFront();
  const clicked = await clickPin(A, R1.id);
  await until(A, () => window.__board.threadCard().open, null, 3000);
  const c2 = await card(A);
  ok(clicked && c2.open && c2.shown && c2.items[0] && c2.items[0].id === R1.id && c2.items[0].who === "You" && c2.items[0].text === R1.text && c2.root === R1.id,
    `2a a click on the pin opens the card with the first comment (${JSON.stringify(c2.items.map((i) => [i.who, i.text.slice(0, 30)]))})`);
  ok(c2.items[1] && c2.items[1].id === R2.id && c2.items[1].who === "Claude", "2b and Claude's reply under it");
  const cv = await canvas(A);
  ok(!hit(c2.card, c2.pin) && inside(c2.card, cv), `2c the card sits beside its pin, not over it, inside the board (card ${JSON.stringify(c2.card)}, pin ${JSON.stringify(c2.pin)})`);
  ok(c2.label.includes("Order queue"), `2d the card says what it is on (${c2.label})`);

  // 3 Sam opens the same thread; Codex answers in it, and both open cards show it at once, in Codex's colour
  await B.bringToFront(); await until(B, (id) => !!window.__board.pinOf(id), R1.id, 8000);
  await clickPin(B, R1.id); await until(B, () => window.__board.threadCard().open, null, 3000);
  const r3 = await X.call("board_say", { text: "I can add a retry worker for failed orders.", reply_to: R1.id });
  const R3 = r3.json;
  const live = async (p) => (await poll(async () => (await card(p)).items.some((i) => i.id === R3.id), 8000));
  const [la, lb] = [await live(A), await live(B)];
  const codexInk = await A.evaluate(() => window.__board.pointer("Codex").ink);
  const row3 = (await card(A)).items.find((i) => i.id === R3.id), row3b = (await card(B)).items.find((i) => i.id === R3.id);
  const rgb = (hex) => `rgb(${hex.slice(1).match(/../g).map((x) => parseInt(x, 16)).join(", ")})`;
  ok(la >= 0 && lb >= 0 && row3.who === "Codex" && row3b.who === "Codex", `3a Codex's board_say reply_to shows in the open card on both pages, live (${la} ms, ${lb} ms)`);
  ok(row3.ink === rgb(codexInk) && row3.ink !== (await card(A)).items[1].ink, `3b Codex's name is in its colour (${row3.ink} for ${codexInk})`);

  // 4 @ in the card's reply box lists the agents on the board, narrows as you type, and Enter puts "@Codex " in
  await A.bringToFront(); await A.focus("#thReply");
  await A.keyboard.type("@");
  await until(A, () => window.__board.mentions().open, null, 2000);
  const m1 = await A.evaluate(() => window.__board.mentions());
  await A.keyboard.type("Co");
  const m2 = await A.evaluate(() => window.__board.mentions());
  await A.keyboard.press("Enter");
  const v4 = await A.evaluate(() => document.getElementById("thReply").value);
  ok(m1.open && m1.names.join() === "Ada,Linus,Grace,Claude,Codex" && m2.names.join() === "Codex", `4a @ lists the agents on the board (${m1.names}), "@Co" narrows to Codex (${m2.names})`);
  ok(v4 === "@Codex " && !(await A.evaluate(() => window.__board.mentions().open)) && (await card(A)).open, `4b Enter puts "@Codex " in the box and leaves the card open (${JSON.stringify(v4)})`);

  // 5 the reply from the card is saved with reply_to and the first comment's place, and goes to Codex only
  const n5 = comments().length, [c5, x5] = [notesOf(C).length, notesOf(X).length];
  await A.keyboard.type("can you draw it next to the queue?"); await A.keyboard.press("Enter");
  await poll(() => comments().length > n5);
  const R4 = comments().at(-1);
  ok(R4.text === "@Codex can you draw it next to the queue?" && R4.reply_to === R1.id && R4.thread_id === R1.id && JSON.stringify(R4.on) === JSON.stringify(R1.on) && R4.author === "you",
    `5a a reply from the card is saved with reply_to and the first comment's on (${JSON.stringify({ reply_to: R4.reply_to, thread_id: R4.thread_id, on: R4.on })})`);
  await until(A, (id) => window.__board.threadCard().items.some((i) => i.id === id), R4.id, 5000);
  ok((await A.evaluate(() => document.getElementById("thReply").value)) === "" && (await card(A)).items.at(-1).id === R4.id, "5b the box empties and the reply shows at the end of the card");
  await poll(() => heard(X, R4.id), 8000); await sleep(800);
  const ev5 = heard(X, R4.id);
  ok(ev5 && ev5.meta.reply_to === R1.id && ev5.meta.thread_id === R1.id && ev5.meta.box_id === "queue" && ev5.meta.to === "Codex",
    `5c Codex gets the reply as an event with reply_to and thread_id (${JSON.stringify(ev5 && ev5.meta)})`);
  ok(notesOf(C).length === c5 && notesOf(X).length === x5 + 1, `5d the @Codex reply reaches Codex only (Claude ${notesOf(C).length - c5}, Codex ${notesOf(X).length - x5})`);

  // 6 Codex answers the reply's own id, as an agent does: the answer still lands in this thread's card, on both pages
  const r6 = await X.call("board_say", { text: "Drawing it now, under the queue.", reply_to: R4.id });
  const R5 = r6.json;
  const [l6a, l6b] = [await poll(async () => (await card(A)).items.some((i) => i.id === R5.id), 8000), await poll(async () => (await card(B)).items.some((i) => i.id === R5.id), 8000)];
  ok(l6a >= 0 && l6b >= 0 && (await A.evaluate((id) => window.__board.threadOf(id), R5.id)) === R1.id, `6 a reply to a reply (reply_to the person's reply) lands in the same thread card on both pages (${l6a} ms, ${l6b} ms)`);

  // 7 Sam replies with no name: it reaches both agents, with the thread it is in
  await B.bringToFront(); await B.focus("#thReply"); await B.keyboard.type("Does the retry worker need its own queue?"); await B.keyboard.press("Enter");
  await poll(() => comments().some((c) => c.text.startsWith("Does the retry worker")));
  const R6 = comments().find((c) => c.text.startsWith("Does the retry worker"));
  await poll(() => heard(C, R6.id) && heard(X, R6.id), 8000);
  ok(R6.author === "sam" && R6.reply_to === R1.id && !R6.to && heard(C, R6.id) && heard(X, R6.id) && heard(C, R6.id).meta.thread_id === R1.id,
    `7 Sam's reply with no @ reaches both agents, each with the thread (${JSON.stringify(heard(C, R6.id) && heard(C, R6.id).meta)})`);

  // 8 a thread with one agent stays with it: a reply with no @ to a comment for Codex goes to Codex
  const t8 = await (await postAs({ text: "@Codex how do tips get paid?", on: { id: "courier", label: "Courier" } })).json();
  const r8 = await (await postAs({ text: "and refunds?", reply_to: t8.id })).json();
  await poll(() => heard(X, r8.id), 8000); await sleep(800);
  ok(t8.to === "Codex" && r8.to === "Codex" && JSON.stringify(r8.on) === JSON.stringify(t8.on) && heard(X, r8.id) && !heard(C, r8.id),
    `8 a reply in a thread for Codex goes to Codex, not every agent (to ${r8.to}; Claude heard it: ${!!heard(C, r8.id)})`);

  // 8b a thread Codex started (its board_say names the box by id): a reply with no @ goes back to Codex, pinned on that box
  const t8b = (await X.call("board_say", { text: "The kitchen screen could show the retry count.", on: "kitchen" })).json;
  await poll(() => record().some((i) => i.id === t8b.id));
  const r8b = await (await postAs({ text: "yes, show it", reply_to: t8b.id })).json();
  await poll(() => heard(X, r8b.id), 8000); await sleep(800);
  const log8b = fs.readFileSync(`${LIVE}/events.log`, "utf8").split("\n").find((l) => l.endsWith(": yes, show it")) || "";
  const pin8b = await poll(() => A.evaluate((ids) => { const a = window.__board.pinOf(ids[0]), b = window.__board.pinOf(ids[1]); return !!a && !!b && a.x === b.x && a.y === b.y; }, [t8b.id, r8b.id]), 8000);
  ok(r8b.to === "Codex" && r8b.on && r8b.on.id === "kitchen" && heard(X, r8b.id) && !heard(C, r8b.id) && /to Codex \[on: kitchen\]/.test(log8b) && pin8b >= 0,
    `8b a reply in a thread Codex started goes to Codex and pins on its box (to ${r8b.to}, on ${JSON.stringify(r8b.on)}, log "${log8b.replace(/^.*?COMMENT/, "COMMENT")}")`);

  // 9 the panel keeps the whole log in order, and a reply there says who it answers
  const reA = await A.evaluate(() => [...document.querySelectorAll("#thread .msg")].map((m) => ({ re: (m.querySelector(".re") || {}).textContent || "", text: m.querySelector(".body").textContent })));
  const reB = await B.evaluate(() => [...document.querySelectorAll("#thread .msg")].map((m) => ({ re: (m.querySelector(".re") || {}).textContent || "", text: m.querySelector(".body").textContent })));
  const reOf = (l, t) => (l.find((m) => m.text === t) || {}).re;
  ok(reOf(reA, R1.text) === "" && reOf(reA, R2.text) === "↳ reply to You" && reOf(reA, R5.text) === "↳ reply to You" && reOf(reA, R6.text) === "↳ reply to You",
    `9a on the host's page, replies read "↳ reply to You" and the first comment has no such line (${JSON.stringify(reA.slice(0, 7).map((m) => m.re))})`);
  ok(reOf(reB, R2.text) === "↳ reply to Host" && reOf(reB, R5.text) === "↳ reply to Host" && reOf(reB, R6.text) === "↳ reply to Host", `9b on Sam's page they read "↳ reply to Host"`);

  // 10 @ in the panel's comment box too, and Enter picks the name instead of sending
  await A.bringToFront(); await A.focus("#box");
  const n10 = comments().length;
  await A.keyboard.type("@Cl");
  const m10 = await A.evaluate(() => window.__board.mentions());
  await A.keyboard.press("Enter"); await sleep(600);
  const v10 = await A.evaluate(() => document.getElementById("box").value);
  ok(m10.open && m10.names.join() === "Claude" && v10 === "@Claude " && comments().length === n10, `10 "@Cl" in the panel lists Claude, Enter inserts "@Claude " and sends nothing (${JSON.stringify(v10)}, ${comments().length - n10} sent)`);
  await A.evaluate(() => { document.getElementById("box").value = ""; });

  // 11 a bad reply_to is refused, and nothing is written
  const n11 = record().length;
  const note = await C.call("board_note", { ref: "n_thr", x: 0, y: 400, text: "a note" });
  const opId = record().filter((i) => i.kind === "op").at(-1).id;
  const n11b = record().length;
  const bad = [];
  for (const rt of ["c-nope", {}, opId, "<img src=x>", 42]) { const r = await postAs({ text: "should not land", reply_to: rt }); bad.push(r.status); }
  ok(!note.err && n11b === n11 + 1 && bad.every((s) => s === 400) && record().length === n11b && !comments().some((c) => c.text === "should not land"),
    `11 reply_to naming no comment (missing, {}, an op's id, not an id, a number) gets 400 and writes nothing (${bad.join(", ")})`);
  // Claude draws that note in front of the person, gliding the camera there: let it land before clicking pins again
  for (const p of [A, B]) await until(p, () => window.__board.elements().some((e) => e.id === "n_thr") && !window.__board.pointer("Claude").drawing, null, 12000);
  await sleep(600);

  // 12 untrusted names and text render as text, in the panel and the card
  const evil = '<img src=x onerror="window.__x=1">';
  const t12 = await (await postAs({ text: evil, name: '<img src=x onerror=window.__x=1>', on: { id: "db", label: '<b>db</b><img src=x onerror="window.__x=1">' } })).json();
  await (await postAs({ text: evil + " again", name: "<svg onload=window.__x=1>", reply_to: t12.id })).json();
  await until(A, (id) => !!window.__board.pinOf(id), t12.id, 8000);
  await A.keyboard.press("Escape");   // the queue's card is open: close it first, as a person would, so it covers no pin
  const c12 = await clickPin(A, t12.id); await until(A, (id) => window.__board.threadCard().root === id && window.__board.threadCard().items.length === 2, t12.id, 5000);
  const x12 = await A.evaluate(() => ({ imgs: document.querySelectorAll("#threadCard img, #threadCard svg, #thread .msg img, #thread .msg svg, #mentions img").length, x: window.__x, card: window.__board.threadCard() }));
  ok(c12 && x12.imgs === 0 && x12.x === undefined && x12.card.items.length === 2 && x12.card.items[0].text === evil && x12.card.items[1].text === evil + " again" && x12.card.label.includes("<b>db</b>"),
    `12 a comment, name and label made of HTML show as text: no element made, no script run (pin clickable: ${c12}; ${JSON.stringify(x12.card.items.map((i) => [i.who, i.text]))})`);

  // 13 one card at a time: clicking another pin moves the card to that thread
  const c13 = await clickPin(A, R1.id); await until(A, (id) => window.__board.threadCard().root === id, R1.id, 3000);
  const one = await A.evaluate(() => document.querySelectorAll("#threadCard.show").length);
  ok(c13 && one === 1 && (await card(A)).root === R1.id, `13 clicking another pin moves the one card to that thread (pin clickable: ${c13})`);

  // 14 the card follows the board when the camera moves: level with its pin, never over it, hidden while the pin is off
  // the board. (Claude's note in 11 glided the camera to where it drew, so the queue is put back in the middle first.)
  const camera = (dx, dy) => A.evaluate((dx, dy) => { const api = window.__excalidrawAPI, st = api.getAppState(); api.updateScene({ appState: { scrollX: st.scrollX + dx / st.zoom.value, scrollY: st.scrollY + dy / st.zoom.value } }); }, dx, dy);
  const level = (c) => !!c.card && c.card.y <= c.pin.y + c.pin.h && c.card.y + c.card.h >= c.pin.y;
  await A.evaluate(() => window.__board.frameRect(660, 0, 230, 104, 0.8)); await A.mouse.move(5, 5); await sleep(400);
  const before = await card(A);
  await camera(-140, -40);
  await poll(async () => { const c = await card(A); return Math.abs(c.pin.x - before.pin.x + 140) < 2; }, 3000);
  const after = await card(A), dx = after.card.x - before.card.x;
  ok(before.shown && after.shown && Math.abs(dx + 140) < 2 && level(before) && level(after) && !hit(before.card, before.pin) && !hit(after.card, after.pin),
    `14a the card moves with the board (${Math.round(dx)} px as the pin moves -140), level with its pin and off it`);
  await camera(-1400, 0); await sleep(300);
  const off = await card(A);
  await camera(1400, 0); await sleep(300);
  const back = await card(A);
  ok(off.open && !off.shown && back.shown && !hit(back.card, back.pin), `14b with its pin off the board the card hides, and comes back with it (off: shown ${off.shown}; back: shown ${back.shown})`);

  // the open card, at 1440×900, for a person to look at (Sam's page too, its card left of a pin near the edge)
  await camera(140, 40); await sleep(300); await A.screenshot({ path: `${SHOTS}/thread-card.png` });
  await B.screenshot({ path: `${SHOTS}/thread-card-sam.png` });

  // 15 Esc closes the @ list first, then the card
  await A.focus("#thReply"); await A.keyboard.type("@");
  const listed = await until(A, () => window.__board.mentions().open, null, 2000);
  await A.keyboard.press("Escape");
  const e1 = { list: (await A.evaluate(() => window.__board.mentions())).open, card: (await card(A)).open };
  await A.keyboard.press("Escape");
  const e2 = (await card(A)).open;
  ok(listed && !e1.list && e1.card && !e2, `15 Esc closes the @ list, then the card (list opened: ${listed}; after one Esc ${JSON.stringify(e1)}; after two, open: ${e2})`);

  // 16 a click outside closes it; a click on its own pin closes it too
  const o1 = await clickPin(A, R1.id) && await until(A, () => window.__board.threadCard().open, null, 3000);
  const cv16 = await canvas(A);
  await A.mouse.click(cv16.x + 60, cv16.y + cv16.h - 60); await sleep(300);
  const out = (await card(A)).open;
  const o2 = await clickPin(A, R1.id) && await until(A, () => window.__board.threadCard().open, null, 3000);
  await clickPin(A, R1.id); await sleep(300);
  ok(o1 && o2 && !out && !(await card(A)).open, `16 a click on the board outside the open card closes it, and so does its own pin (opened: ${o1}, ${o2}; open after the outside click: ${out})`);

  ok(errs.length === 0, `17 no page errors on either page (${errs.slice(0, 3).join(" | ")})`);
} catch (e) {
  ok(false, `the gate stopped: ${e && e.stack ? e.stack : e}`);   // a throw fails the gate, never exits 0
} finally {
  for (const b of browsers) await b.close(); srv.kill(); for (const s of [globalThis.C, globalThis.X]) if (s) s.p.kill();
  console.log(`(board copy and screenshots: ${SHOTS})`);
  process.exit(process.exitCode || 0);   // the MCP sessions' pipes would keep node running
}
