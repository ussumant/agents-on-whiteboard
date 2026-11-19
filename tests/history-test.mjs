// History gate: the board keeps versions on its own, like Figma's version history. Versions appear after the person's
// edits and after an agent's drawing, each label naming who did what; board_history lists them over MCP; a restore from
// the panel converges on two open pages (one browser each) with no reload, and survives a reload; the board just before
// a restore is a version, so a restore can be undone; agents get no BOARD event for a restore; a guest on the share link
// gets 403; Save a copy is a real .excalidraw file. The quiet window is 3 s here (BOARD_HISTORY_QUIET_MS) and the
// every-so-often cap 9 s (BOARD_HISTORY_EVERY_MS), so the gate runs in about a minute; the defaults are checked as numbers.
//   node tests/history-test.mjs [spare port 4900–4940]      → PASS lines
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import puppeteer from "puppeteer";
import { ok, sleep, scratch, serveBoard, mcpSession, portArg, until, joined, poll } from "./lib.mjs";
import { hit, json, TUNNEL, LINK, guestHead } from "./guest-lib.mjs";
import * as S from "../src/server.mjs";

const PORT = portArg(2, 4939), D = scratch("history"), U = `http://localhost:${PORT}`;
const LIVE = `${D}/.agents-on-whiteboard`, ev = () => fs.existsSync(`${LIVE}/events.log`) ? fs.readFileSync(`${LIVE}/events.log`, "utf8") : "";
process.env.BOARD_HISTORY_QUIET_MS = "3000"; process.env.BOARD_HISTORY_EVERY_MS = "9000";   // for the server this gate starts
const srv = await serveBoard(D, PORT);
const ARGS = { headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] };
const browsers = [], sessions = [], errs = [];
const versions = async () => (await (await fetch(`${U}/api/history`)).json()).versions;
const version = async (id) => (await fetch(`${U}/api/history/${id}`)).json();
const textOf = (els, id) => (els.find((e) => e.id === id && !e.isDeleted) || {}).text;
const open = async () => {
  const b = await puppeteer.launch(ARGS); browsers.push(b);
  const p = (await b.pages())[0] || await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(`${U}/`, { waitUntil: "domcontentloaded" }); await until(p, () => window.__board && window.__board.ready, null, 30000); await joined(p);
  return p;
};
async function session(presenter) {
  const m = mcpSession(["--channels"]); sessions.push(m);
  await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "history-test", version: "0" } });
  m.notify("notifications/initialized");
  await m.call("board_open", { dir: D, port: PORT, presenter });
  return m;
}
// A version whose label matches, newer than the versions in `after` (ids), within `ms`.
const waitFor = async (re, after, ms = 20000) => { let hit = null; await poll(async () => { hit = (await versions()).find((v) => !after.includes(v.id) && re.test(v.label)); return !!hit; }, ms); return hit; };
const live = (p) => p.evaluate(() => window.__board.elements());
const has = (els, id) => els.some((e) => e.id === id);
// The restore button on a version's row, pressed twice (it asks once more on the button itself).
async function uiRestore(p, id) {
  if (!(await p.evaluate(() => window.__board.history().open))) await p.click("#historyBtn");
  const there = await until(p, (id) => !!document.querySelector(`#histList .hv[data-id="${id}"] button[data-act="restore"]`), id, 10000);
  if (!there) return false;
  return p.evaluate((id) => { const b = document.querySelector(`#histList .hv[data-id="${id}"] button[data-act="restore"]`); b.click(); const armed = b.textContent; b.click(); return armed; }, id);
}

try {
  // 1 a version of the board at the start of the call
  const v0 = await versions();
  ok(v0.length === 1 && v0[0].kind === "start" && v0[0].count === 30 && fs.existsSync(`${LIVE}/history/${v0[0].id}.json`) && fs.existsSync(`${LIVE}/history/index.jsonl`),
    `1 the board at the start of the call is a version (${JSON.stringify(v0)})`);
  const START = v0[0].id;

  const Ada = await session("Ada"), Codex = await session("Codex");
  const A = await open(), B = await open();
  const ha = await A.evaluate(() => window.__board.history());
  const head = await A.evaluate(() => [...document.getElementById("panelHead").children].map((e) => e.id || e.tagName));
  ok(ha.button && !ha.open && head.indexOf("historyBtn") === head.indexOf("panelToggle") - 1, `1b this computer's page has a History button beside "hide" (${head.join(", ")})`);
  await sleep(4500);
  ok((await versions()).length === 1, "1c opening two pages makes no version: nothing anyone sees changed");

  // 2 the person changes a text: a version, after the board is quiet, naming them
  await A.evaluate(() => window.__board.setLabel("queue__title", "📬 Orders in"));
  const v1 = await waitFor(/Orders in/, [START]);
  ok(v1 && v1.label === 'You changed a text to "📬 Orders in"' && JSON.stringify(v1.by) === '["You"]' && v1.kind === "auto",
    `2 the person's edit is a version: "${v1 && v1.label}" by ${JSON.stringify(v1 && v1.by)}`);

  // 3 two agents draw at once: the version names each of them, never the page that put their drawing on the board
  const seen3 = (await versions()).map((v) => v.id);
  await Promise.all([
    Ada.call("board_box", { ref: "retry", title: "🔁 Retry worker", sub: "tries failed orders again", near: "queue", side: "below" }),
    Codex.call("board_note", { ref: "n1", x: 0, y: 420, text: "retries cap at 3" }),
  ]);
  await until(A, () => ["retry", "n1"].every((id) => window.__board.elements().some((e) => e.id === id)), null, 15000);
  const vBox = await waitFor(/Ada drew 🔁 Retry worker/, seen3), vNote = await waitFor(/Codex added a note/, seen3);
  const since3 = (await versions()).filter((v) => !seen3.includes(v.id));
  ok(vBox && vNote && vBox.by.includes("Ada") && vNote.by.includes("Codex"), `3a the agents' drawing is a version naming each agent ("${vBox && vBox.label}" | "${vNote && vNote.label}")`);
  ok(since3.length && since3.every((v) => !/You/.test(v.label) && !v.by.includes("You")), `3b the page that drew it for them isn't named (${since3.map((v) => `${v.label} [${v.by}]`).join(" | ")})`);

  // 4 board_history over MCP: the list, newest first, in the agents' words; and one version's shapes
  const h4 = await Ada.call("board_history", {});
  const l4 = h4.json && h4.json.versions;
  ok(!h4.err && l4 && l4.length === h4.json.total && l4[0].id === (await versions())[0].id && l4.at(-1).id === START && l4.some((v) => v.label === 'Host changed a text to "📬 Orders in"' && v.by.includes("Host")),
    `4a board_history lists the versions newest first, the person as "Host" (${l4 && l4.map((v) => v.label).join(" | ")})`);
  const h4b = await Codex.call("board_history", { id: vBox.id });
  const box4 = h4b.json && h4b.json.elements.find((e) => e.id === "retry");
  ok(!h4b.err && box4 && box4.text === "🔁 Retry worker / tries failed orders again" && h4b.json.types.rectangle >= 7 && fs.existsSync(h4b.json.file) && !h4b.json.elements.some((e) => e.id === "retry__title"),
    `4b board_history {id} gives that version's shapes with their words (${JSON.stringify(box4)}, ${JSON.stringify(h4b.json && h4b.json.types)})`);
  const bad4 = await Ada.call("board_history", { id: "../scene" });
  ok(bad4.err && /no version/.test(bad4.text), `4c an unknown id is refused (${bad4.text.slice(0, 80)})`);

  // 5 an agent edits a box; the person edits a text and restores at once, inside the quiet window
  await Ada.call("board_edit", { target: "api", text: "🧾 Order API v2" });
  await until(A, () => window.__board.elements().some((e) => e.id === "api__title" && e.text === "🧾 Order API v2"), null, 10000);
  await A.evaluate(() => window.__board.setLabel("db__title", "🗄️ Orders DB"));
  await poll(async () => textOf((await (await fetch(`${U}/api/scene`)).json()).elements, "db__title") === "🗄️ Orders DB", 5000);
  const boardsBefore = Ada.notes.filter((n) => n.meta.kind === "board").length, logBefore = ev().split("\n").filter((l) => l.startsWith("BOARD:")).length;
  const before5 = (await versions()).map((v) => v.id);
  const armed = await uiRestore(A, v1.id);
  ok(armed === "Restore for everyone?", `5a Restore asks once more on the button itself, no dialog ("${armed}")`);
  const vAfter = await waitFor(/^You restored the \d\d:\d\d version$/, before5, 8000);
  const now5 = await versions(), vBefore = now5.find((v) => v.kind === "before-restore" && !before5.includes(v.id));
  ok(vAfter && vBefore && now5[0].id === vAfter.id && now5[1].id === vBefore.id && /^Before restoring the \d\d:\d\d version$/.test(vBefore.label) && vBefore.by.includes("You"),
    `5b the board just before the restore is a version, then the restore (${now5.slice(0, 3).map((v) => `${v.kind}: ${v.label}`).join(" | ")})`);
  const eb = (await version(vBefore.id)).elements;
  ok(textOf(eb, "db__title") === "🗄️ Orders DB" && textOf(eb, "api__title") === "🧾 Order API v2" && has(eb, "retry") && has(eb, "n1"),
    "5c that version holds the edit made a moment before the restore, and the agents' box, note and edit");

  // 6 every open page converges on the version, with no reload
  const want = (await version(v1.id)).elements, wantIds = want.map((e) => e.id).sort().join();
  const same = (els) => els.map((e) => e.id).sort().join() === wantIds && els.find((e) => e.id === "api__title").text === "🧾 Order API"
    && els.find((e) => e.id === "db__title").text === "🗄️ Orders database" && els.find((e) => e.id === "queue__title").text === "📬 Orders in";
  const conv = await Promise.all([A, B].map((p) => poll(async () => same(await live(p)), 8000)));
  ok(conv.every((t) => t >= 0), `6a both open pages look like the ${v1.id} version, no reload (${conv.join(" ms, ")} ms; ${want.length} elements)`);
  // (the line comes with the page's next read of the record, up to 1.5 s after the elements)
  const histLines = (p) => p.evaluate(() => [...document.querySelectorAll("#thread .histline")].map((d) => d.textContent));
  await Promise.all([A, B].map((p) => poll(async () => (await histLines(p)).length === 1, 6000)));
  const lines = await Promise.all([A, B].map(histLines));
  ok(lines.every((l) => l.length === 1 && /^You restored the board to the \d\d:\d\d version$/.test(l[0])), `6b the discussion says so on every page (${JSON.stringify(lines)})`);
  const sc = (await (await fetch(`${U}/api/scene`)).json()).elements.filter((e) => !e.isDeleted);
  ok(same(sc), "6c the server's board is the version too");

  // 7 a reload keeps the restore: the agent's edit and drawing aren't replayed from the record
  await B.reload({ waitUntil: "domcontentloaded" }); await until(B, () => window.__board && window.__board.ready, null, 30000); await joined(B);
  await sleep(2500);
  ok(same(await live(B)), "7 after a reload the board is still the version (the agent's edit isn't put back, its box isn't drawn again)");

  // 8 agents hear nothing of the restore's words: no BOARD event, no BOARD line (the person's own edit before it is one)
  await sleep(4000);
  const boards8 = Ada.notes.filter((n) => n.meta.kind === "board").slice(boardsBefore).map((n) => n.content), log8 = ev().split("\n").filter((l) => l.startsWith("BOARD:")).slice(logBefore);
  ok(boards8.length === 1 && /Orders DB/.test(boards8[0]) && !boards8.concat(log8).some((t) => /Order API"|Orders database/.test(t)) && log8.length === 1,
    `8a no BOARD event for the restore, only the person's edit just before it (${JSON.stringify(boards8)} | ${JSON.stringify(log8)})`);
  const th = await Ada.call("board_thread", {}), rec = th.json.filter((i) => i.kind === "history");
  ok(rec.length === 1 && rec[0].action === "restore" && rec[0].version === v1.id && rec[0].before === vBefore.id && rec[0].author === "you", `8b the record says the person restored it, for agents to read (${JSON.stringify(rec[0])})`);
  const hl = ev().split("\n").filter((l) => l.startsWith("HISTORY:"));
  ok(hl.length === 1 && !/comment|board|edit/i.test(hl[0]), `8c events.log has one HISTORY line no watcher wakes on (${hl[0]})`);
  const ag = await A.evaluate(() => window.__board.agents().avatars.map((a) => a.name).sort().join());
  ok(ag === "Ada,Codex", `8d the restore isn't an agent on the board (avatars ${ag})`);

  // 9 nothing changes after it: no more versions
  const n9 = (await versions()).length; await sleep(7000);
  ok((await versions()).length === n9, `9 two quiet windows after the restore, no new version (${n9})`);

  // 10 undo the restore: restore the version saved just before it
  const before10 = (await versions()).map((v) => v.id);
  await uiRestore(A, vBefore.id);
  const undone = await Promise.all([A, B].map((p) => poll(async () => { const e = await live(p); return has(e, "retry") && has(e, "n1") && e.find((x) => x.id === "db__title").text === "🗄️ Orders DB" && e.find((x) => x.id === "api__title").text === "🧾 Order API v2"; }, 8000)));
  const v10 = await waitFor(/^You undid the restore$/, before10, 5000);
  await poll(async () => (await histLines(B)).at(-1) === "You undid the last restore", 6000);
  const l10 = (await histLines(B)).at(-1);
  ok(undone.every((t) => t >= 0) && v10 && l10 === "You undid the last restore", `10 restoring "Before restoring…" undoes it on both pages, and says so (${undone.join(" ms, ")} ms; "${v10 && v10.label}"; "${l10}")`);

  // 11 a guest on the share link: no history, no restore, and the board doesn't change
  fs.writeFileSync(S.files(D).share, JSON.stringify({ key: LINK, pid: process.pid, port: PORT, url: `https://${TUNNEL}` }), { mode: 0o600 });
  const gh = (await hit(PORT, "/", { host: TUNNEL, headers: guestHead })).body, gb = JSON.parse(gh.match(/var BOARD = (\{[^\n]*\});\n/)[1]);
  const gHead = { "content-type": "application/json", "x-agents-on-whiteboard-key": gb.token, "x-agents-on-whiteboard-page": gb.pageKey, origin: `https://${TUNNEL}`, ...guestHead };
  const scene0 = JSON.stringify((await (await fetch(`${U}/api/scene`)).json()).elements);
  const g1 = await hit(PORT, "/api/history/restore", { method: "POST", host: TUNNEL, headers: gHead, body: { id: v1.id, c: gb.page } });
  const g2 = await hit(PORT, "/api/history", { host: TUNNEL, headers: guestHead }), g3 = await hit(PORT, `/api/history/${v1.id}/excalidraw`, { host: TUNNEL, headers: guestHead });
  const only = (r) => r.status === 403 && /only for the person at this computer/.test((json(r) || {}).error || "");
  await sleep(500);
  ok(only(g1) && only(g2) && only(g3) && JSON.stringify((await (await fetch(`${U}/api/scene`)).json()).elements) === scene0,
    `11a a link guest gets 403 on restore, on the list and on a copy, and the board is unchanged (${g1.status} ${g1.body.slice(0, 70)} | ${g2.status} | ${g3.status})`);
  // a guest's own edit is still a version, and says it came through the link
  const before11 = (await versions()).map((v) => v.id), sub = (await (await fetch(`${U}/api/scene`)).json()).elements.find((e) => e.id === "courier__sub");
  const g4 = await hit(PORT, "/api/scene", { method: "POST", host: TUNNEL, headers: gHead, body: { c: gb.page, name: "Alex", elements: [{ ...sub, text: "pings twice", originalText: "pings twice", version: sub.version + 1 }] } });
  const v11 = await waitFor(/pings twice/, before11, 10000);
  ok(g4.status === 200 && v11 && v11.label === 'Alex via link changed a text to "pings twice"' && v11.by.includes("Alex via link"), `11b a link guest's edit is a version that says so ("${v11 && v11.label}" by ${JSON.stringify(v11 && v11.by)})`);
  fs.unlinkSync(S.files(D).share);
  const info = await A.evaluate(() => window.__boardInfo);
  const homePost = (body, secret) => fetch(`${U}/api/history/restore`, { method: "POST", headers: { "content-type": "application/json", "x-agents-on-whiteboard-key": info.token, origin: U, ...(secret ? { "x-agents-on-whiteboard-page": secret } : {}) }, body: JSON.stringify(body) });
  const h1 = await homePost({ id: v1.id, c: info.page }), h2 = await homePost({ id: "vnope", c: info.page }, info.pageKey), h3 = await homePost({ id: "../scene", c: info.page }, info.pageKey);
  ok(h1.status === 403 && h2.status === 404 && h3.status === 404, `11c on this computer, a restore needs the page's secret, and an unknown version is 404 (${h1.status}, ${h2.status}, ${h3.status})`);

  // 12 Save a copy: a real .excalidraw file, named after the board and the version's time
  const cp = await fetch(`${U}/api/history/${vBox.id}/excalidraw`), cd = cp.headers.get("content-disposition") || "", txt = await cp.text();
  const f12 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "history-copy-")), "copy.excalidraw"); fs.writeFileSync(f12, txt);
  let file = null; try { file = S.readBoard(f12); } catch { /* checked below */ }
  ok(cp.status === 200 && /^attachment; filename="pizza-\d{4}-\d\d-\d\d-\d{4}\.excalidraw"/.test(cd) && file && file.type === "excalidraw" && file.elements.length === vBox.count && file.elements.every(S.shapeOk) && has(file.elements, "retry"),
    `12a Save a copy is an .excalidraw file of that version (${cd}; ${file && file.elements.length} elements)`);
  const loaded = await A.evaluate(async (t) => { const r = await ExcalidrawLib.loadFromBlob(new Blob([t], { type: "application/json" }), null, null); return r.elements.filter((e) => !e.isDeleted).length; }, txt);
  ok(loaded === vBox.count, `12b Excalidraw itself opens it (${loaded} elements)`);
  const copyBtn = await A.evaluate((id) => !!document.querySelector(`#histList .hv[data-id="${id}"] button[data-act="copy"]`), vBox.id);
  ok(copyBtn, "12c every version in the list has Save a copy");
  // a picture on the board goes inside the copy, so the file opens anywhere with it
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", page = { "content-type": "application/json", "x-agents-on-whiteboard-key": info.token, "x-agents-on-whiteboard-page": info.pageKey, origin: U };
  const pf = await fetch(`${U}/api/files`, { method: "POST", headers: page, body: JSON.stringify({ c: info.page, files: [{ id: "pic-1", mimeType: "image/png", dataURL: `data:image/png;base64,${PNG}` }] }) }).then((r) => r.json());
  const before12 = (await versions()).map((v) => v.id);
  const img = { id: "img1", type: "image", fileId: "pic-1", status: "saved", scale: [1, 1], x: 1200, y: 600, width: 80, height: 80, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], seed: 1, version: 1, versionNonce: 7, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false };
  await fetch(`${U}/api/scene`, { method: "POST", headers: page, body: JSON.stringify({ c: info.page, elements: [img] }) });
  const v12 = await waitFor(/added a picture/, before12, 10000);
  const pic = v12 && JSON.parse(await (await fetch(`${U}/api/history/${v12.id}/excalidraw`)).text()).files["pic-1"];
  ok(pf.took && pf.took.includes("pic-1") && v12 && pic && pic.dataURL === `data:image/png;base64,${PNG}` && pic.mimeType === "image/png", `12d a picture on the board is inside the copy ("${v12 && v12.label}"; ${pic ? pic.dataURL.slice(0, 30) : "no picture"})`);

  // 13 the list in the panel: newest first, time, who and what; Preview draws a version small
  await poll(async () => (await A.evaluate(() => window.__board.history().rows.map((r) => r.id).join())) === (await versions()).map((v) => v.id).join(), 8000);
  const rows = await A.evaluate(() => window.__board.history().rows), all13 = await versions();
  ok(rows.map((r) => r.id).join() === all13.map((v) => v.id).join() && rows.every((r) => /\d\d:\d\d/.test(r.time)) && rows.find((r) => r.id === vBox.id).who.includes("Ada") && rows.find((r) => r.id === vBox.id).label === vBox.label,
    `13a the panel lists every version newest first, with its time, who and what (${rows.slice(0, 4).map((r) => `${r.time} ${r.who}: ${r.label}`).join(" | ")})`);
  await A.click(`#histList .hv[data-id="${START}"] button[data-act="preview"]`);
  const pv = await until(A, (id) => { const c = document.querySelector(`#histList .hv[data-id="${id}"] .hv-pic canvas`); return !!c && c.width > 100 && c.height > 50; }, START, 8000);
  ok(pv, "13b Preview draws the version small, in its row");
  await A.click("#historyBtn");
  const shut = await A.evaluate(() => ({ h: window.__board.history().open, thread: getComputedStyle(document.getElementById("thread")).display, compose: getComputedStyle(document.getElementById("compose")).display }));
  ok(!shut.h && shut.thread !== "none" && shut.compose !== "none", `13c History again closes it, and the discussion is back (${JSON.stringify(shut)})`);

  // 14 while the board keeps changing, a version at least every so often (9 s here, 2 minutes by default)
  const before14 = (await versions()).map((v) => v.id), t14 = Date.now(); let lastEdit = 0;
  for (let i = 0; i < 14; i++) { await A.evaluate((i) => window.__board.setLabel("kitchen__sub", `ticket ${i}`), i); lastEdit = Date.now(); await sleep(1000); }
  const mid = (await versions()).filter((v) => !before14.includes(v.id));
  ok(mid.length >= 1 && Date.parse(mid.at(-1).ts) < lastEdit && Date.parse(mid.at(-1).ts) - t14 < 12000, `14a a version while the edits kept coming (${mid.map((v) => `${Math.round((Date.parse(v.ts) - t14) / 1000)} s: ${v.label}`).join(" | ")})`);
  ok(S.historyWait(0, 0) === 10000 && S.historyWait(0, 115000) === 5000 && S.historyWait(0, 125000) === 0, "14b by default: 10 s after the last change, and never later than 2 minutes after the first");

  // 15 the cap: at most 200 versions, the first and the newest 50 kept, the rest thinned evenly
  let t15 = Date.UTC(2026, 0, 1);
  const fake = Array.from({ length: 260 }, (_, i) => ({ id: `v${i}`, ts: new Date(t15 += 60000 * (i % 3 === 0 ? 5 : 1)).toISOString(), bytes: 1000 }));
  const kept = S.historyThin(fake), keptB = S.historyThin(fake, 1000, 60 * 1000);
  ok(kept.length === 200 && kept[0].id === "v0" && fake.slice(-50).every((v) => kept.includes(v)) && keptB.length === 60, `15 thinning keeps 200 (the first and the newest 50), and a byte cap too (${kept.length}, ${keptB.length})`);

  ok(errs.length === 0, `16 no page errors (${errs.slice(0, 3).join(" | ")})`);
} finally {
  for (const b of browsers) await b.close(); srv.kill(); for (const s of sessions) s.p.kill();
  process.exit(process.exitCode || 0);
}
