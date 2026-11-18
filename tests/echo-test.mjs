// Echo gate: text the agent puts on the board through its own tools (a note's label, an arrow's label, an edit) never
// comes back to it as someone's writing, through any of the three ways it hears the board: the channel push, board_wait
// and `agents-on-whiteboard wait`. Only the person's own note does. A fresh copy of the sample board, on a spare port.
//   node tests/echo-test.mjs [spare port 4900–4940]      → PASS lines
import { spawn } from "node:child_process";
import { ok, sleep, scratch, serveBoard, mcpSession, portArg, poll, credsIn, asPage, BIN } from "./lib.mjs";
import * as S from "../src/server.mjs";

const PORT = portArg(2, 4916), D = scratch("echo"), U = `http://localhost:${PORT}`;
const srv = await serveBoard(D, PORT);
const page = credsIn(await (await fetch(`${U}/`)).text());
const post = (elements) => fetch(`${U}/api/scene`, { method: "POST", headers: asPage(page.key, U, page.secret), body: JSON.stringify({ c: page.c, elements }) }).then((r) => r.json());
// The page posts text elements in this shape. Bound labels get fresh random ids, so the server keys them by container.
const t = (id, text, containerId = null, version = 2) => ({ id, type: "text", text, originalText: text, containerId, version, versionNonce: 1, x: 0, y: 0, width: 100, height: 20, fontSize: 16, fontFamily: 1 });
const pause = () => sleep(3200);   // the server writes canvas text 2.5 s after the last change

// The agent: one session with channel pushes on, one asking board_wait, and a `agents-on-whiteboard wait` running from the start.
const M = mcpSession(["--channels"]), W = mcpSession();
for (const s of [M, W]) { await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "echo-test", version: "0" } }); s.notify("notifications/initialized"); await s.call("board_open", { dir: D, port: PORT }); }
const cli = spawn(process.execPath, [BIN, "wait", "--timeout", "60s"], { cwd: D, stdio: ["ignore", "pipe", "pipe"] });
let cliOut = "", cliErr = "", cliCode = null; cli.stdout.on("data", (d) => (cliOut += d)); cli.stderr.on("data", (d) => (cliErr += d)); cli.on("exit", (c) => (cliCode = c));
process.on("exit", () => cli.kill());
await poll(() => /waiting/.test(cliErr), 5000);

// the agent draws and edits
const title = S.readBoard(`${D}/pizza.excalidraw`).elements.find((e) => e.id === "api__title");
await M.call("board_note", { ref: "n1", x: 0, y: -400, text: "card details live here" });
await M.call("board_arrow", { ref: "a1", from: "api", to: "queue", label: "feeds" });
await M.call("board_edit", { target: "api", text: "🧾 Order API v2" });
// what the page posts after applying those ops
await post([{ ...t("api__title", "🧾 Order API v2"), version: title.version + 1 }, t("r1", "card details live here", "n1"), t("r2", "feeds", "a1")]);
await pause();
ok(cliCode === null, `1 \`agents-on-whiteboard wait\` is still waiting after the agent's note, arrow and edit (${cliOut.trim() || "nothing printed"})`);
const w1 = await W.call("board_wait", { timeout_s: 1 });
ok(!w1.err && w1.json && w1.json.timeout === true, `2 board_wait has nothing either (${w1.text.slice(0, 80)})`);
// and then the person writes something
await post([t("h1", "my own note")]);
await pause();
const boards = M.notes.filter((x) => x.meta.kind === "board").map((x) => x.content);
ok(boards.length === 1 && boards[0] === 'Host wrote "my own note" (h1)', `3 the only canvas push is the person's own note: ${JSON.stringify(boards)}`);
const w2 = await W.call("board_wait", { timeout_s: 5 });
ok(!w2.err && w2.json && w2.json.kind === "board" && w2.json.content === 'Host wrote "my own note" (h1)' && w2.json.element_id === "h1", `4 board_wait returns the person's note (${w2.text.slice(0, 140)})`);
await poll(() => cliCode !== null, 5000);
let line = null; try { line = JSON.parse(cliOut.trim()); } catch { /* checked below */ }
ok(cliCode === 0 && line && line.content === w2.json.content && line.id === w2.json.id, `5 \`agents-on-whiteboard wait\` woke on the same note, as the same JSON (exit ${cliCode}: ${cliOut.trim().slice(0, 140)})`);
// the agent changing its own note again: still its own
await M.call("board_edit", { target: "api", text: "🧾 Order API v3" });
await post([{ ...t("api__title", "🧾 Order API v3"), version: title.version + 2 }]);
await pause();
ok(M.notes.filter((x) => x.meta.kind === "board").length === 1, "6 a second edit by the agent doesn't come back either");

M.p.kill(); W.p.kill(); cli.kill(); srv.kill();
console.log(`(board copy: ${D})`);
