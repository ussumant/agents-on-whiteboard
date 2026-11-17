// Multiplayer gate: two headless pages (the host, nameless at this computer, and ?name=Sam) on a fresh copy of the
// sample board, on a spare port. It edits, deletes and posts comments, so it never runs on a real board.
//   node tests/mp-test.mjs [spare port 4900–4940]      → 34 PASS lines
import fs from "fs"; import puppeteer from "puppeteer";
import { ok, sleep, cli, scratch, serveBoard, portArg } from "./lib.mjs";
const PORT = portArg(2, 4910), D = scratch("mp"), U = `http://localhost:${PORT}/`;
const srv = await serveBoard(D, PORT);
const b = await puppeteer.launch({ headless: true });
const open = async (q, w = 1280) => { const p = await b.newPage(); await p.setViewport({ width: w, height: 800 }); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(U + q, { waitUntil: "networkidle2" }); await p.waitForFunction("window.__board && window.__board.ready === true", { timeout: 30000 }); p.errs = errs; return p; };
const scene = (p) => p.evaluate(() => __excalidrawAPI.getSceneElementsIncludingDeleted().map((e) => ({ id: e.id, v: e.version, del: !!e.isDeleted, x: Math.round(e.x), text: e.text, c: e.containerId })));
const A = await open("");
await sleep(1500);
const srvScene = () => JSON.parse(fs.readFileSync(`${D}/live/scene.json`, "utf8")).elements;
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
await Promise.all([move(A, b1), move(B, b2)]); await sleep(1500);
for (const [n, p] of [["A", A], ["B", B]]) { const s = await scene(p); ok(s.find((e) => e.id === b1).x === x0[0] + 77 && s.find((e) => e.id === b2).x === x0[1] + 77, `4 both concurrent moves survive in ${n}`); }
// 5 delete in B shows in A
await B.evaluate((id) => { const api = __excalidrawAPI; api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => e.id === id ? ExcalidrawLib.newElementWith(e, { isDeleted: true }) : e) }); }, b2);
await sleep(1200);
ok((await scene(A)).find((e) => e.id === b2).del, "5 B's delete shows in A");
// 6 Claude note via the CLI: one label, on both pages and the server
cli(D, "op", JSON.stringify({ op: "note", ref: "n_mp", x: 0, y: -400, text: "a note from Claude" }));
await sleep(3500);
for (const [n, s] of [["A", await scene(A)], ["B", await scene(B)], ["server", srvScene().map((e) => ({ ...e, c: e.containerId, del: e.isDeleted }))]]) {
  const labs = s.filter((e) => e.c === "n_mp" && !e.del); ok(labs.length === 1 && labs[0].id === "n_mp__label", `6 Claude's note has exactly one label in ${n} (${labs.map((l) => l.id)})`); }
// 7 presence: A moves the pointer, B sees a named cursor
await A.mouse.move(400, 400); await A.mouse.move(420, 430); await sleep(800);
const col = await B.evaluate(() => [...__excalidrawAPI.getAppState().collaborators.values()].map((c) => ({ n: c.username, p: !!c.pointer })));
ok(col.some((c) => c.n === "Host" && c.p), `7 B sees the host's cursor, named Host ${JSON.stringify(col)}`);
ok((await B.evaluate(() => __board.peers())).includes("Host") && (await A.evaluate(() => __board.peers())).includes("Sam"), "7b each page lists the other in the room");
ok((await A.evaluate(() => document.getElementById("conn").textContent)).includes("Sam"), "7c A's header shows Sam is here");
await B.screenshot({ path: `${D}/B-cursor.png` });
// 8 Sam comments: named in the thread, events.log, and A's panel
await B.evaluate(async () => { document.getElementById("box").value = "hi from Sam"; document.getElementById("send").click(); });
await sleep(2200);
const th = fs.readFileSync(`${D}/live/thread.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(th.some((i) => i.kind === "comment" && i.author === "sam" && i.text === "hi from Sam"), "8 comment recorded with author sam");
const ev = () => fs.existsSync(`${D}/live/events.log`) ? fs.readFileSync(`${D}/live/events.log`, "utf8") : "";
ok(/COMMENT by Sam: hi from Sam/.test(ev()), "8b events.log names Sam");
ok(await A.evaluate(() => [...document.querySelectorAll(".msg .meta b")].some((b) => b.textContent === "Sam")), "8c A's panel shows the comment as Sam");
ok(await B.evaluate(() => [...document.querySelectorAll(".msg .meta b")].some((b) => b.textContent === "You")), "8d B's panel shows its own comment as You");
// 9 Sam types on the board: exactly one BOARD line, named, after the pause
const before = ev().split("\n").filter((l) => l.startsWith("BOARD")).length;
for (const t of ["S", "Sa", "Sam", "Sam was here"]) { await B.evaluate((id, t) => __board.setLabel(id, t), `${ids[2]}__title`, t); await sleep(150); }
await sleep(3200);
const boards = ev().split("\n").filter((l) => l.startsWith("BOARD")).slice(before);
ok(boards.length === 1 && /^BOARD: Sam changed \S+ to "Sam was here"$/.test(boards[0]), `9 one named BOARD line for live typing ${JSON.stringify(boards)}`);
ok(!/a note from Claude/.test(ev()), "9b Claude's note never logged as someone's writing");
// 10 a probe page never writes
const v0 = fs.statSync(`${D}/live/scene.json`).mtimeMs; const P = await open("?probe=1");
await P.evaluate((id) => __board.setLabel(id, "probe edit"), `${b1}__title`); await sleep(1500);
ok(!srvScene().some((e) => e.text === "probe edit"), "10 ?probe edits stay out of the server");
// 11 a third tab with A's localStorage: still no duplicates
const C = await open(""); const sc = await scene(C), sa2 = await scene(A);
ok(sc.length === sa2.length, `11 a new tab in A's browser matches (${sc.length} vs ${sa2.length})`);
ok(await A.evaluate(() => !document.getElementById("resetBtn")), "12 no Reset on the live board (the server holds the board)");
for (const [n, p] of [["A", A], ["B", B], ["C", C]]) ok(!p.errs.length, `13 no console errors in ${n} ${JSON.stringify(p.errs.slice(0, 3))}`);
// 14 a new page replays the thread, but Claude's old edit must not put back text a person typed after it
cli(D, "op", JSON.stringify({ op: "edit", target: ids[3], text: "Claude's title" }));
await sleep(2500);
await B.evaluate((id) => __board.setLabel(id, "Sam retyped it"), `${ids[3]}__title`); await sleep(1500);
const N = await open("?name=Nina"); await sleep(3500);
const t14 = (s) => s.find((e) => e.id === `${ids[3]}__title`)?.text;
ok(t14(await scene(N)) === "Sam retyped it" && t14(await scene(A)) === "Sam retyped it" && t14(srvScene()) === "Sam retyped it", `14 a joining page doesn't replay Claude's edit over Sam's (${t14(srvScene())})`);
// 15 undo never takes back someone else's change; your next own change still undoes
const xA = () => A.evaluate((id) => Math.round(__excalidrawAPI.getSceneElements().find((e) => e.id === id).x), ids[4]);
const moveA = () => A.evaluate((id) => { const api = __excalidrawAPI; api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((e) => e.id === id ? ExcalidrawLib.newElementWith(e, { x: e.x + 50 }) : e), commitToHistory: true }); }, ids[4]);
const undoA = () => A.evaluate(() => document.querySelector('[aria-label="Undo"]').click());
await moveA(); await sleep(600);
await B.evaluate((id) => __board.setLabel(id, "Sam, before the host's undo"), `${ids[5]}__title`); await sleep(1500);
await undoA(); await sleep(1800);
const t15 = (s) => s.find((e) => e.id === `${ids[5]}__title`)?.text;
ok(t15(await scene(A)) === "Sam, before the host's undo" && t15(await scene(B)) === "Sam, before the host's undo" && t15(srvScene()) === "Sam, before the host's undo", "15 the host's undo leaves Sam's edit alone everywhere");
const x15 = await xA(); await moveA(); await sleep(600); await undoA(); await sleep(1500);
ok((await xA()) === x15 && t15(srvScene()) === "Sam, before the host's undo", "15b the host's next own change still undoes");
// 16 Claude's arrow runs edge to edge and lies under the boxes: a box the line crosses still takes the click, on both pages
// the sample board has six boxes (ids[0]…ids[5]); the arrow runs from the last one to the first
cli(D, "op", JSON.stringify({ op: "arrow", ref: "arr_mp", from: ids[5], to: ids[0], label: "crosses" }));
await sleep(3500);
const zOf = (p) => p.evaluate(() => { const els = __excalidrawAPI.getSceneElements(), i = (id) => els.findIndex((e) => e.id === id); return { arrow: i("arr_mp"), firstBox: Math.min(...__board.boxes().map(i).filter((n) => n >= 0)) }; });
const [zA, zB] = [await zOf(A), await zOf(B)];
ok(zA.arrow >= 0 && zA.arrow < zA.firstBox && zB.arrow >= 0 && zB.arrow < zB.firstBox, `16 Claude's arrow is under the boxes on A and B ${JSON.stringify([zA, zB])}`);
const geo = await A.evaluate((f) => { const els = __excalidrawAPI.getSceneElements(), a = els.find((e) => e.id === "arr_mp"), b = els.find((e) => e.id === f);
  const inside = (x, y) => x > b.x + 1 && x < b.x + b.width - 1 && y > b.y + 1 && y < b.y + b.height - 1; return !inside(a.x, a.y); }, ids[5]);
ok(geo, "16b the arrow starts outside its box, not at the centre");
// 17 pictures: a picture A pastes is saved on the server as a file, shows in B and in a page that joins later,
// survives A's reload, and a comment on it names the saved file (before this, a pasted picture lived in one tab only)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAKklEQVR4nO3NMQ0AAAgDsAmb/yALGXA06d9MeyJisVgsFovFYrFYLP4bL9HP3Ew1mJ9PAAAAAElFTkSuQmCC";
await A.mouse.click(640, 400);
await A.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), dt = new DataTransfer(); dt.items.add(new File([bin], "pic.png", { type: "image/png" }));
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); }, PNG);
// a pasted image exists before Excalidraw gives it a fileId (slower under load): wait for the id, then for the file
await A.waitForFunction(() => __excalidrawAPI.getSceneElements().some((x) => x.type === "image" && x.fileId), { timeout: 10000, polling: 250 }).catch(() => {});
const pic = await A.evaluate(() => { const e = __excalidrawAPI.getSceneElements().find((x) => x.type === "image" && x.fileId); return e ? { id: e.id, fileId: e.fileId } : null; });
for (let i = 0; i < 40 && pic && !(fs.existsSync(`${D}/live/files`) && fs.readdirSync(`${D}/live/files`).some((n) => n.startsWith(pic.fileId + "."))); i++) await sleep(250);
const hasPic = (p) => p.evaluate((f) => !!__excalidrawAPI.getFiles()[f], pic && pic.fileId);
ok(!!pic && fs.existsSync(`${D}/live/files`) && fs.readdirSync(`${D}/live/files`).some((n) => n.startsWith(pic.fileId + ".")), `17 A's pasted picture is saved on the server (${pic && pic.fileId})`);
// B learns of the picture from the server's "files" event after the upload lands: give it up to 8 s, polled
let bHas = false; for (let i = 0; i < 32 && pic && !(bHas = await hasPic(B)); i++) await sleep(250);
ok(!!pic && bHas, "17b B shows it");
const Late = await open("?name=Late"); await sleep(2000);
ok(!!pic && await hasPic(Late), "17c a page that joins later shows it");
await A.reload({ waitUntil: "load" });
const back = await A.waitForFunction("window.__board && window.__board.ready === true", { timeout: 30000, polling: 500 }).then(() => true, async () => console.log("A after reload:", await A.evaluate(() => JSON.stringify(window.__board && { ready: window.__board.ready, error: window.__board.error }))));
await sleep(2000);
ok(!!back && !!pic && await hasPic(A), "17d A still has it after a reload");
await fetch(U + "api/comment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "about the picture", on: pic && { id: pic.id, label: "area: image" } }) }); await sleep(300);
ok(/\[pictures: live\/files\/\w+\.png\]/.test(fs.readFileSync(`${D}/live/events.log`, "utf8").trim().split("\n").filter((l) => l.startsWith("COMMENT")).at(-1) || ""), "17e a comment on it names the saved file");
await b.close(); srv.kill();
console.log(`(board copy: ${D})`);
