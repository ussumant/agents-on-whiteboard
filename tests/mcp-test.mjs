// MCP gate: the stdio server answers `initialize` from clients on either protocol revision with the pinned 2025-06-18
// (channels need it), lists the board tools, starts sketchcall's own board server, and pushes comments into the session
// only when started with --channels. Runs on a fresh copy of the sample board, on a spare port.
//   node tests/mcp-test.mjs [spare port 4900–4940]      → PASS lines
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ok, sleep, scratch, mcpSession, portArg } from "./lib.mjs";

const PORT = portArg(2, 4915), D = scratch("mcp"), U = `http://127.0.0.1:${PORT}`;
const listeners = () => { try { return execFileSync("lsof", ["-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"]).toString().split("\n").filter(Boolean); } catch { return []; } };
const comment = (text, name) => fetch(`${U}/api/comment`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, on: { id: "queue", label: "📬 Order queue" }, ...(name ? { name } : {}) }) }).then((r) => r.json());
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
  const want = ["board_open", "board_say", "board_focus", "board_note", "board_arrow", "board_edit", "board_delete", "board_tour", "board_tour_step", "board_point", "board_thread"];
  ok(want.every((n) => names.includes(n)), `2b tools/list has the board tools (${names.join(", ")})`);

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
} finally {
  for (const s of sessions) s.p.kill();
  for (const pid of listeners()) try { process.kill(Number(pid)); } catch {}
  await sleep(300);
  ok(!listeners().length, `7 no server left on ${PORT}`);
}
