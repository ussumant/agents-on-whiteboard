// MCP gate: the stdio server answers `initialize` from clients on either protocol revision with the pinned 2025-06-18
// (channels need it), lists the board tools, starts sketchcall's own board server, and pushes comments into the session
// only when started with --channels. Runs on a fresh copy of the sample board, on a spare port.
//   node tests/mcp-test.mjs [spare port 4900–4940]      → PASS lines
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ok, sleep, scratch, mcpSession, portArg, pageKey, asPage } from "./lib.mjs";

const PORT = portArg(2, 4915), D = scratch("mcp"), U = `http://127.0.0.1:${PORT}`;
const listeners = () => { try { return execFileSync("lsof", ["-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"]).toString().split("\n").filter(Boolean); } catch { return []; } };
// A comment the way the board's page sends it: with the key the server put in the page (a new one each time it starts).
const comment = async (text, name) => fetch(`${U}/api/comment`, { method: "POST", headers: asPage(await pageKey(`${U}/`), U), body: JSON.stringify({ text, on: { id: "queue", label: "📬 Order queue" }, ...(name ? { name } : {}) }) }).then((r) => r.json());
if (listeners().length) { console.error(`port ${PORT} is taken`); process.exit(2); }

const sessions = [];
try {
  // 1 a client on the older revision, no flag
  const A = mcpSession(); sessions.push(A);
  const iA = (await A.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-test", version: "0" } })).result;
  A.notify("notifications/initialized");
  ok(iA.protocolVersion === "2025-06-18" && iA.serverInfo.name === "sketchcall", `1 initialize at 2025-06-18 answers 2025-06-18 (${iA.protocolVersion}, ${iA.serverInfo.name})`);
  ok(!(iA.capabilities.experimental || {})["claude/channel"] && !/<channel/.test(iA.instructions), "1b without --channels: no claude/channel capability, and the instructions don't promise pushes");
  ok(/the person/.test(iA.instructions), "1c the instructions talk about \"the person\"");

  // 2 a client on the newer revision gets the pin too, and the tools
  const B = mcpSession(); sessions.push(B);
  const iB = (await B.rpc("initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "mcp-test", version: "0" } })).result;
  B.notify("notifications/initialized");
  ok(iB.protocolVersion === "2025-06-18", `2 initialize at 2026-07-28 also answers 2025-06-18 (${iB.protocolVersion})`);
  const names = (await B.rpc("tools/list", {})).result.tools.map((t) => t.name);
  const want = ["board_open", "board_say", "board_focus", "board_note", "board_arrow", "board_edit", "board_delete", "board_tour", "board_tour_step", "board_point", "board_wait", "board_thread"];
  ok(want.every((n) => names.includes(n)), `2b tools/list has the board tools (${names.join(", ")})`);
  // every string the agent reads is filled in: no \${…} left from a string that should have been a template, in either mode
  const C0 = mcpSession(["--channels"]); sessions.push(C0);
  const iC0 = (await C0.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-test", version: "0" } })).result, tC0 = (await C0.rpc("tools/list", {})).result.tools;
  const texts = [iB.instructions, iC0.instructions, ...(await B.rpc("tools/list", {})).result.tools.map((t) => t.description), ...tC0.map((t) => t.description)];
  ok(texts.every((t) => !t.includes("${")), `2c no unfilled \${…} in the instructions or tool descriptions (${texts.filter((t) => t.includes("\${")).map((t) => t.slice(0, 50))})`);

  // 3 board_open starts sketchcall's own server for the folder, on the port given
  const o = await A.call("board_open", { dir: D, port: PORT });
  ok(!o.err && o.text.startsWith(`http://localhost:${PORT}/`) && listeners().length === 1, `3 board_open starts the board server (${o.text.slice(0, 120)})`);
  const page = await (await fetch(`${U}/`)).text();
  ok(page.includes('"name":"pizza"') && !page.includes("__SKETCHCALL_BOARD__"), "3b the server it started serves the package's page, named after the board's file");
  const ob = await B.call("board_open", { dir: D, port: PORT });
  ok(!ob.err && listeners().length === 1, "3c a second session attaches to the same server");
  const bad = await B.call("board_open", { dir: fs.mkdtempSync(D + "-empty"), port: PORT });
  ok(bad.err && /no \.excalidraw file/.test(bad.text), `3d a folder with no board is refused (${bad.text.slice(0, 80)})`);

  // 4 without --channels, a comment is in the thread but nothing is pushed
  const c4 = await comment("why a queue?");
  await sleep(1500);
  const th = await A.call("board_thread", {});
  ok(!A.notes.length && !B.notes.length && th.json.some((i) => i.id === c4.id && i.author === "you"), `4 no push without --channels; board_thread has the comment, author "you" (${A.notes.length + B.notes.length} pushes)`);

  // 5 with --channels: the capability, and a comment arrives as a channel message
  const C = mcpSession(["--channels"]); sessions.push(C);
  const iC = (await C.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-test", version: "0" } })).result;
  C.notify("notifications/initialized");
  ok(iC.protocolVersion === "2025-06-18" && !!(iC.capabilities.experimental || {})["claude/channel"] && /<channel source="sketchcall"/.test(iC.instructions), "5 with --channels: the claude/channel capability and the push in the instructions");
  await C.call("board_open", { dir: D, port: PORT });
  const c5 = await comment("and why one per store?", "Maya");
  for (let i = 0; i < 30 && !C.notes.length; i++) await sleep(100);
  const n5 = C.notes[0];
  ok(n5 && n5.content === "and why one per store?" && n5.meta.kind === "comment" && n5.meta.comment_id === c5.id && n5.meta.author === "maya" && n5.meta.box_id === "queue",
    `5b the comment arrives as a channel message ${JSON.stringify(n5 && n5.meta)}`);
  // 6 the reply lands on the same box
  const r6 = await C.call("board_say", { text: "Because the kitchen is slower than the app.", reply_to: c5.id });
  ok(!r6.err && r6.json.author === "claude" && r6.json.on && r6.json.on.id === "queue", "6 board_say reply_to puts the reply on the comment's box");
  await sleep(600);
  ok(C.notes.length === 1, `6b the agent's own reply never comes back to it (${C.notes.length} pushes)`);
  // 6c the agent's new elements get ids and text the server takes back from the pages: an odd ref would show on every page
  // and never be saved
  const n1 = await C.call("board_note", { ref: "note 1", x: 0, y: -500, text: "x" });
  const n2 = await C.call("board_note", { ref: "n-long", x: 0, y: -500, text: "t".repeat(10001) });
  const n3 = await C.call("board_tour", { title: "t", tour_id: "bad id", steps: [{ target: "api", text: "x" }] });
  const n4 = await C.call("board_note", { ref: "n-ok", x: 0, y: -500, text: "a note the server keeps" });
  ok(n1.err && /ref must be/.test(n1.text) && n2.err && /10,000/.test(n2.text) && n3.err && /tour_id must be/.test(n3.text) && !n4.err,
    `6c a ref like "note 1", text over 10,000 characters and a tour_id like "bad id" are refused; ref "n-ok" is fine (${[n1, n2, n3].map((x) => x.text.slice(0, 40)).join(" | ")})`);
} finally {
  for (const s of sessions) s.p.kill();
  for (const pid of listeners()) try { process.kill(Number(pid)); } catch {}
  await sleep(300);
  ok(!listeners().length, `7 no server left on ${PORT}`);
}
