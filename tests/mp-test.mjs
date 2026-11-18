// Multiplayer gate: two headless pages (the host, nameless at this computer, and ?name=Sam) on a fresh copy of the
// sample board, on a spare port. It edits, deletes and posts comments, so it never runs on a real board.
//   node tests/mp-test.mjs [spare port 4900–4940]      → 37 PASS lines
import fs from "fs"; import puppeteer from "puppeteer";
import { ok, sleep, cli, scratch, serveBoard, portArg, poll, until, joined, pageKey, asPage } from "./lib.mjs";
const PORT = portArg(2, 4910), D = scratch("mp"), U = `http://localhost:${PORT}/`;
const srv = await serveBoard(D, PORT);
// the same flags as the other gates: a page in a background tab keeps its timers (the picture upload runs on one)
const b = await puppeteer.launch({ headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const open = async (q, w = 1280) => { const p = await b.newPage(); await p.setViewport({ width: w, height: 800 }); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(U + q, { waitUntil: "networkidle2" }); await p.waitForFunction("window.__board && window.__board.ready === true", { timeout: 30000 }); p.errs = errs; return p; };
const scene = (p) => p.evaluate(() => __excalidrawAPI.getSceneElementsIncludingDeleted().map((e) => ({ id: e.id, v: e.version, del: !!e.isDeleted, x: Math.round(e.x), text: e.text, c: e.containerId })));
const A = await open("");
const srvScene = () => JSON.parse(fs.readFileSync(`${D}/.agents-on-whiteboard/scene.json`, "utf8")).elements;
await joined(A); await poll(async () => srvScene().length === (await scene(A)).length);   // A seeded the server
const nA = (await scene(A)).length;
ok(srvScene().length === nA, `1 the server holds the board A shows (${srvScene().length}/${nA})`);
const B = await open("?name=Sam", 1000);
const sa = await scene(A), sb = await scene(B);
ok(sb.length === sa.length && sb.every((e) => sa.some((x) => x.id === e.id)), `2 B joined the server board, no reseed (${sb.length} vs ${sa.length})`);
const ids = await A.evaluate(() => __board.boxes());
const [b1, b2] = ids;
// 3 A edits text, B sees it
await A.evaluate((id) => __board.setLabel(id, "edited by A"), `${b1}__title`);
await sleep(1200);
ok((await scene(B)).find((e) => e.id === `${b1}__title`)?.text === "edited by A", "3 A's text edit shows in B within 1.2 s");
// 4 concurrent moves on different boxes
const move = (p, id) => p.evaluate((id) => { const api = __excalidrawAPI; api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => e.id === id ? ExcalidrawLib.newElementWith(e, { x: e.x + 77 }) : e) }); }, id);
const x0 = (await scene(A)).filter((e) => e.id === b1 || e.id === b2).map((e) => e.x);
await Promise.all([move(A, b1), move(B, b2)]);
for (const p of [A, B]) await poll(async () => { const s = await scene(p); return s.find((e) => e.id === b1).x === x0[0] + 77 && s.find((e) => e.id === b2).x === x0[1] + 77; });
for (const [n, p] of [["A", A], ["B", B]]) { const s = await scene(p); ok(s.find((e) => e.id === b1).x === x0[0] + 77 && s.find((e) => e.id === b2).x === x0[1] + 77, `4 both concurrent moves survive in ${n}`); }
// 5 delete in B shows in A
await B.evaluate((id) => { const api = __excalidrawAPI; api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => e.id === id ? ExcalidrawLib.newElementWith(e, { isDeleted: true }) : e) }); }, b2);
await poll(async () => (await scene(A)).find((e) => e.id === b2).del);
ok((await scene(A)).find((e) => e.id === b2).del, "5 B's delete shows in A");
// 6 Claude note via the CLI: one label, on both pages and the server
cli(D, "op", JSON.stringify({ op: "note", ref: "n_mp", x: 0, y: -400, text: "a note from Claude" }));
const hasLabel = (s) => s.some((e) => e.id === "n_mp__label" && !(e.del || e.isDeleted));
await poll(async () => hasLabel(await scene(A)) && hasLabel(await scene(B)) && hasLabel(srvScene())); await sleep(3500);   // it's in; then time for a second, wrong one
for (const [n, s] of [["A", await scene(A)], ["B", await scene(B)], ["server", srvScene().map((e) => ({ ...e, c: e.containerId, del: e.isDeleted }))]]) {
  const labs = s.filter((e) => e.c === "n_mp" && !e.del); ok(labs.length === 1 && labs[0].id === "n_mp__label", `6 Claude's note has exactly one label in ${n} (${labs.map((l) => l.id)})`); }
// 7 presence: A moves the pointer, B sees a named cursor
await A.mouse.move(400, 400); await A.mouse.move(420, 430);
await until(B, () => [...__excalidrawAPI.getAppState().collaborators.values()].some((c) => c.username === "Host" && c.pointer) && __board.peers().includes("Host"));
await until(A, () => __board.peers().includes("Sam") && document.getElementById("conn").textContent.includes("Sam"));
const col = await B.evaluate(() => [...__excalidrawAPI.getAppState().collaborators.values()].map((c) => ({ n: c.username, p: !!c.pointer })));
ok(col.some((c) => c.n === "Host" && c.p), `7 B sees the host's cursor, named Host ${JSON.stringify(col)}`);
ok((await B.evaluate(() => __board.peers())).includes("Host") && (await A.evaluate(() => __board.peers())).includes("Sam"), "7b each page lists the other in the room");
ok((await A.evaluate(() => document.getElementById("conn").textContent)).includes("Sam"), "7c A's header shows Sam is here");
await B.screenshot({ path: `${D}/B-cursor.png` });
// 8 Sam comments: named in the thread, events.log, and A's panel
await B.evaluate(async () => { document.getElementById("box").value = "hi from Sam"; document.getElementById("send").click(); });
await poll(() => /COMMENT by Sam: hi from Sam/.test(fs.readFileSync(`${D}/.agents-on-whiteboard/events.log`, "utf8")));
await until(A, () => [...document.querySelectorAll(".msg .meta b")].some((b) => b.textContent === "Sam")); await until(B, () => [...document.querySelectorAll(".msg .meta b")].some((b) => b.textContent === "You"));
const th = fs.readFileSync(`${D}/.agents-on-whiteboard/thread.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(th.some((i) => i.kind === "comment" && i.author === "sam" && i.text === "hi from Sam"), "8 comment recorded with author sam");
const ev = () => fs.existsSync(`${D}/.agents-on-whiteboard/events.log`) ? fs.readFileSync(`${D}/.agents-on-whiteboard/events.log`, "utf8") : "";
ok(/COMMENT by Sam: hi from Sam/.test(ev()), "8b events.log names Sam");
ok(await A.evaluate(() => [...document.querySelectorAll(".msg .meta b")].some((b) => b.textContent === "Sam")), "8c A's panel shows the comment as Sam");
ok(await B.evaluate(() => [...document.querySelectorAll(".msg .meta b")].some((b) => b.textContent === "You")), "8d B's panel shows its own comment as You");
// 9 Sam types on the board: exactly one BOARD line, named, after the pause
const before = ev().split("\n").filter((l) => l.startsWith("BOARD")).length;
for (const t of ["S", "Sa", "Sam", "Sam was here"]) { await B.evaluate((id, t) => __board.setLabel(id, t), `${ids[2]}__title`, t); await sleep(150); }
await poll(() => ev().split("\n").filter((l) => l.startsWith("BOARD")).length > before); await sleep(1000);   // then time for a second, wrong one
const boards = ev().split("\n").filter((l) => l.startsWith("BOARD")).slice(before);
ok(boards.length === 1 && /^BOARD: Sam changed \S+ to "Sam was here"$/.test(boards[0]), `9 one named BOARD line for live typing ${JSON.stringify(boards)}`);
ok(!/a note from Claude/.test(ev()), "9b Claude's note never logged as someone's writing");
// 10 a probe page never writes
const v0 = fs.statSync(`${D}/.agents-on-whiteboard/scene.json`).mtimeMs; const P = await open("?probe=1");
await P.evaluate((id) => __board.setLabel(id, "probe edit"), `${b1}__title`); await sleep(1500);
ok(!srvScene().some((e) => e.text === "probe edit"), "10 ?probe edits stay out of the server");
// 11 a third tab with A's localStorage: still no duplicates
const C = await open(""); const sc = await scene(C), sa2 = await scene(A);
ok(sc.length === sa2.length, `11 a new tab in A's browser matches (${sc.length} vs ${sa2.length})`);
ok(await A.evaluate(() => !document.getElementById("resetBtn")), "12 no Reset on the live board (the server holds the board)");
for (const [n, p] of [["A", A], ["B", B], ["C", C]]) ok(!p.errs.length, `13 no console errors in ${n} ${JSON.stringify(p.errs.slice(0, 3))}`);
// 14 a new page replays the thread, but Claude's old edit must not put back text a person typed after it
cli(D, "op", JSON.stringify({ op: "edit", target: ids[3], text: "Claude's title" }));
const t14 = (s) => s.find((e) => e.id === `${ids[3]}__title`)?.text;
for (const p of [A, B]) await poll(async () => t14(await scene(p)) === "Claude's title");
await B.evaluate((id) => __board.setLabel(id, "Sam retyped it"), `${ids[3]}__title`);
await poll(async () => t14(srvScene()) === "Sam retyped it" && t14(await scene(A)) === "Sam retyped it");
const N = await open("?name=Nina"); await joined(N); await sleep(3500);   // then time for a wrong replay
ok(t14(await scene(N)) === "Sam retyped it" && t14(await scene(A)) === "Sam retyped it" && t14(srvScene()) === "Sam retyped it", `14 a joining page doesn't replay Claude's edit over Sam's (${t14(srvScene())})`);
// 15 undo never takes back someone else's change; your next own change still undoes
const xA = () => A.evaluate((id) => Math.round(__excalidrawAPI.getSceneElements().find((e) => e.id === id).x), ids[4]);
const moveA = () => A.evaluate((id) => { const api = __excalidrawAPI; api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => e.id === id ? ExcalidrawLib.newElementWith(e, { x: e.x + 50 }) : e), commitToHistory: true }); }, ids[4]);
const undoA = () => A.evaluate(() => document.querySelector('[aria-label="Undo"]').click());
const t15 = (s) => s.find((e) => e.id === `${ids[5]}__title`)?.text, xSrv = () => Math.round(srvScene().find((e) => e.id === ids[4]).x);
const xB = () => B.evaluate((id) => Math.round(__excalidrawAPI.getSceneElements().find((e) => e.id === id).x), ids[4]);
const x15a = await xA(); await moveA(); await poll(() => xSrv() === x15a + 50);
await B.evaluate((id) => __board.setLabel(id, "Sam, before the host's undo"), `${ids[5]}__title`);
await poll(async () => t15(await scene(A)) === "Sam, before the host's undo" && t15(srvScene()) === "Sam, before the host's undo");   // Sam's edit is on the host's page
await undoA(); await poll(async () => xSrv() === x15a && (await xB()) === x15a);   // the host's undo has reached the server and Sam
ok(t15(await scene(A)) === "Sam, before the host's undo" && t15(await scene(B)) === "Sam, before the host's undo" && t15(srvScene()) === "Sam, before the host's undo", "15 the host's undo leaves Sam's edit alone everywhere");
const x15 = await xA(); await moveA(); await poll(() => xSrv() === x15 + 50); await undoA(); await poll(() => xSrv() === x15);
ok((await xA()) === x15 && t15(srvScene()) === "Sam, before the host's undo", "15b the host's next own change still undoes");
// 16 Claude's arrow runs edge to edge and lies under the boxes: a box the line crosses still takes the click, on both pages
// the sample board has six boxes (ids[0]…ids[5]); the arrow runs from the last one to the first
cli(D, "op", JSON.stringify({ op: "arrow", ref: "arr_mp", from: ids[5], to: ids[0], label: "crosses" }));
for (const p of [A, B]) await until(p, () => __excalidrawAPI.getSceneElements().some((e) => e.id === "arr_mp"));
const zOf = (p) => p.evaluate(() => { const els = __excalidrawAPI.getSceneElements(), i = (id) => els.findIndex((e) => e.id === id); return { arrow: i("arr_mp"), firstBox: Math.min(...__board.boxes().map(i).filter((n) => n >= 0)) }; });
const [zA, zB] = [await zOf(A), await zOf(B)];
ok(zA.arrow >= 0 && zA.arrow < zA.firstBox && zB.arrow >= 0 && zB.arrow < zB.firstBox, `16 Claude's arrow is under the boxes on A and B ${JSON.stringify([zA, zB])}`);
const geo = await A.evaluate((f) => { const els = __excalidrawAPI.getSceneElements(), a = els.find((e) => e.id === "arr_mp"), b = els.find((e) => e.id === f);
  const inside = (x, y) => x > b.x + 1 && x < b.x + b.width - 1 && y > b.y + 1 && y < b.y + b.height - 1; return !inside(a.x, a.y); }, ids[5]);
ok(geo, "16b the arrow starts outside its box, not at the centre");
// 17 pictures: a picture A pastes is saved on the server as a file, shows in B and in a page that joins later,
// survives A's reload, and a comment on it names the saved file (before this, a pasted picture lived in one tab only)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAKklEQVR4nO3NMQ0AAAgDsAmb/yALGXA06d9MeyJisVgsFovFYrFYLP4bL9HP3Ew1mJ9PAAAAAElFTkSuQmCC";
// a person pastes into the page they are looking at
await A.bringToFront(); await A.mouse.click(640, 400);
await A.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), dt = new DataTransfer(); dt.items.add(new File([bin], "pic.png", { type: "image/png" }));
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); }, PNG);
// a pasted image exists before Excalidraw gives it a fileId (slower under load): wait for the id, then for the file
await until(A, () => __excalidrawAPI.getSceneElements().some((x) => x.type === "image" && x.fileId));
const pic = await A.evaluate(() => { const e = __excalidrawAPI.getSceneElements().find((x) => x.type === "image" && x.fileId); return e ? { id: e.id, fileId: e.fileId } : null; });
await poll(() => pic && fs.readdirSync(`${D}/.agents-on-whiteboard/files`).some((n) => n.startsWith(pic.fileId + ".")));
const hasPic = (p) => p.evaluate((f) => !!__excalidrawAPI.getFiles()[f], pic && pic.fileId);
ok(!!pic && fs.existsSync(`${D}/.agents-on-whiteboard/files`) && fs.readdirSync(`${D}/.agents-on-whiteboard/files`).some((n) => n.startsWith(pic.fileId + ".")), `17 A's pasted picture is saved on the server (${pic && pic.fileId})`);
// B learns of the picture from the server's "files" event after the upload lands: polled, up to 15 s
const bHas = (await poll(() => pic && hasPic(B))) >= 0;
ok(!!pic && bHas, "17b B shows it");
const Late = await open("?name=Late"); await poll(() => hasPic(Late));
ok(!!pic && await hasPic(Late), "17c a page that joins later shows it");
await A.reload({ waitUntil: "load" });
const back = await A.waitForFunction("window.__board && window.__board.ready === true", { timeout: 30000, polling: 500 }).then(() => true, async () => console.log("A after reload:", await A.evaluate(() => JSON.stringify(window.__board && { ready: window.__board.ready, error: window.__board.error }))));
await poll(() => hasPic(A));
ok(!!back && !!pic && await hasPic(A), "17d A still has it after a reload");
await fetch(U + "api/comment", { method: "POST", headers: asPage(await pageKey(U), U.slice(0, -1)), body: JSON.stringify({ text: "about the picture", on: pic && { id: pic.id, label: "area: image" } }) }); await sleep(300);
ok(/\[pictures: \.agents-on-whiteboard\/files\/\w+\.png\]/.test(fs.readFileSync(`${D}/.agents-on-whiteboard/events.log`, "utf8").trim().split("\n").filter((l) => l.startsWith("COMMENT")).at(-1) || ""), "17e a comment on it names the saved file");
// 18 what a person draws with each of Excalidraw's tools is saved and reaches the other page. The server checks every
// element's shape by type, and a shape it wrongly refused would never save or sync, so each tool is drawn with the mouse.
// A stroke the synthetic mouse loses (the editor still busy with the last one) is drawn again until it is on A: then a
// shape on A that never reaches the server can only be the server refusing it.
await A.bringToFront(); await sleep(300);
const had = new Set(srvScene().map((e) => e.id));
const tool = (t) => A.evaluate((t) => { __excalidrawAPI.setActiveTool({ type: t }); }, t);
const onA = (t) => A.evaluate((t) => __excalidrawAPI.getSceneElements().filter((e) => e.type === t && (t !== "text" || e.text === "typed on the board")).map((e) => e.id), t);
// whatever is on top where a stroke starts (a comment pin, a card): a covered start point is reported, never drawn through
const covers = {};
const topAt = (x, y) => A.evaluate((x, y) => { const t = document.elementFromPoint(x, y); return !t || t.classList.contains("interactive") ? null : `${t.tagName.toLowerCase()}${t.id ? "#" + t.id : ""}${typeof t.className === "string" && t.className ? "." + t.className.split(" ")[0] : ""}`; }, x, y);
const stroke = async (t, from, to, steps = 10) => {
  const c = await topAt(from.x, from.y); if (c) covers[t] = c;
  await tool(t); await A.mouse.move(from.x, from.y); await A.mouse.down();
  for (let k = 1; k <= steps; k++) await A.mouse.move(from.x + (to.x - from.x) * k / steps, from.y + (to.y - from.y) * k / steps + (t === "freedraw" ? 12 * Math.sin(k) : 0));
  await A.mouse.up(); await sleep(250); await A.keyboard.press("Escape"); await sleep(250);
};
const tries = {};
const draw = async (t, make, done = async (fresh) => fresh.length > 0) => {
  for (let k = 1; k <= 3; k++) { const was = new Set(await onA(t)); await make(); const fresh = (await onA(t)).filter((id) => !was.has(id)); if (await done(fresh)) { tries[t] = (tries[t] || 0) + k; return fresh; }
    await A.keyboard.press("Escape"); await sleep(500); }
  tries[t] = "lost"; return [];
};
// Excalidraw shows a tool's properties down the left edge and the discussion panel takes the right, so every stroke
// starts in the middle third. First an arrow from one box to another, so it carries both its bindings: the two boxes
// are framed there.
await A.evaluate((a, b) => { const api = __excalidrawAPI, els = api.getSceneElements(), p = els.find((e) => e.id === a), q = els.find((e) => e.id === b);
  const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x + p.width, q.x + q.width), y0 = Math.min(p.y, q.y), y1 = Math.max(p.y + p.height, q.y + q.height), z = Math.min(1, 480 / (x1 - x0), 500 / (y1 - y0));
  api.updateScene({ appState: { zoom: { value: z }, scrollX: 610 / z - (x0 + x1) / 2, scrollY: 400 / z - (y0 + y1) / 2 } }); }, ids[2], ids[3]); await sleep(700);   // (ids[1] was deleted in 5)
const centre = (id) => A.evaluate((id) => { const api = __excalidrawAPI, e = api.getSceneElements().find((x) => x.id === id); return ExcalidrawLib.sceneCoordsToViewportCoords({ sceneX: e.x + e.width / 2, sceneY: e.y + e.height / 2 }, api.getAppState()); }, id);
const [c0, c2] = [await centre(ids[2]), await centre(ids[3])];
const boundIds = await draw("arrow", () => stroke("arrow", c0, c2), async (fresh) => fresh.length > 0 && await A.evaluate((ids) => ids.some((id) => { const e = __excalidrawAPI.getSceneElements().find((x) => x.id === id); return e.startBinding && e.endBinding; }), fresh));
// then an empty stretch below the board at 100%, one of each tool
await A.evaluate(() => { const api = __excalidrawAPI, els = api.getSceneElements(), x0 = Math.min(...els.map((e) => e.x)), y0 = Math.max(...els.map((e) => e.y + e.height)) + 300;
  api.updateScene({ appState: { zoom: { value: 1 }, scrollX: 120 - x0, scrollY: 140 - y0 } }); }); await sleep(500);
const at = (i) => ({ x: 330 + i * 90, y: 160 });
for (const [i, t] of ["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw"].entries()) await draw(t, () => stroke(t, at(i), { x: at(i).x + 70, y: at(i).y + 70 }));
await draw("text", async () => { const c = await topAt(340, 330); if (c) covers.text = c; await tool("text"); await A.mouse.click(340, 330); await sleep(400); await A.keyboard.type("typed on the board"); await A.keyboard.press("Escape"); await sleep(400); });
await draw("frame", () => stroke("frame", { x: 340, y: 420 }, { x: 760, y: 560 }));
const want = ["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "frame"];
const fresh = () => srvScene().filter((e) => !had.has(e.id) && !e.isDeleted);
await poll(() => want.every((t) => fresh().some((e) => e.type === t)) && fresh().some((e) => boundIds.includes(e.id) && e.startBinding && e.endBinding));
const got = fresh(), missing = want.filter((t) => !got.some((e) => e.type === t)), bound = got.find((e) => boundIds.includes(e.id) && e.startBinding && e.endBinding);
const onB = await poll(async () => { const b = new Set((await scene(B)).map((e) => e.id)); return got.every((e) => b.has(e.id)); }) >= 0;
ok(!missing.length && !!bound && onB && got.some((e) => e.type === "text" && e.text === "typed on the board") && !Object.values(tries).includes("lost"),
  `18 every tool drawn with the mouse is saved and reaches B (${got.length} new: ${[...new Set(got.map((e) => e.type))].join(", ")}${missing.length ? `; missing ${missing}` : ""}; bound arrow ${!!bound}; on B ${onB}; strokes per tool ${JSON.stringify(tries)}${Object.keys(covers).length ? `; covered: ${JSON.stringify(covers)}` : ""})`);
// 19 no console errors from start to finish: check 13 runs before the agent's arrow, the pictures and the drawing
for (const [n, p] of [["A", A], ["B", B]]) ok(!p.errs.length, `19 no console errors in ${n} over the whole run ${JSON.stringify(p.errs.slice(0, 3))}`);
await b.close(); srv.kill();
console.log(`(board copy: ${D})`);
