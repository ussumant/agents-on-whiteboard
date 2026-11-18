// Wait gate: `agents-on-whiteboard wait` and board_wait wake the agent on the person's next comment, without a timer.
//   - a comment wakes both within 1 s, as the same JSON
//   - a TOUR line, the agent's own reply and its own note's label wake neither
//   - `wait --timeout` exits 2, board_wait returns {timeout: true}
//   - nothing is lost between waits: board_wait queues from board_open on, and `wait --since <id>` returns what came after
//   - an answer reaches only the session presenting that tour; a cancelled board_wait doesn't swallow the next comment
//   - board_wait sends a progress notification at least once a minute while it waits (its own board, run alongside)
// Fresh copies of the sample board, on two spare ports.
//   node tests/wait-test.mjs [spare port 4900–4940] [second spare port]      → PASS lines
import fs from "node:fs";
import { spawn } from "node:child_process";
import { ok, sleep, scratch, serveBoard, mcpSession, portArg, poll, credsIn, asPage, BIN } from "./lib.mjs";
import * as S from "../src/server.mjs";

const PORT = portArg(2, 4917), PORT2 = portArg(3, 4918), D = scratch("wait"), D2 = scratch("wait-progress"), U = `http://localhost:${PORT}`;
const srv = await serveBoard(D, PORT), srv2 = await serveBoard(D2, PORT2);
const page = credsIn(await (await fetch(`${U}/`)).text());
const post = (pth, body, withPage) => fetch(`${U}${pth}`, { method: "POST", headers: asPage(page.key, U, withPage ? page.secret : undefined), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
const comment = (text) => post("/api/comment", { text, on: { id: "queue", label: "📬 Order queue" } });
const events = () => fs.existsSync(S.files(D).events) ? fs.readFileSync(S.files(D).events, "utf8") : "";

// `agents-on-whiteboard wait` as an agent runs it in the background: resolves with its exit code, its line and how long it took.
function cliWait(...args) {
  const p = spawn(process.execPath, [BIN, "wait", ...args], { cwd: D, stdio: ["ignore", "pipe", "pipe"] });
  process.on("exit", () => p.kill());
  let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  const exit = new Promise((r) => p.on("exit", (code) => r({ code, out: out.trim(), err: err.trim(), at: Date.now() })));
  return { p, exit, ready: () => poll(() => /waiting/.test(err) || p.exitCode !== null, 5000), running: () => p.exitCode === null };
}
const session = async (presenter) => { const m = mcpSession(); await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wait-test", version: "0" } });
  m.notify("notifications/initialized"); await m.call("board_open", { dir: D, port: PORT, ...(presenter ? { presenter } : {}) }); return m; };

// The progress check runs on its own board alongside everything else: one board_wait for 45 s, nothing posted.
const P = mcpSession();
await P.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wait-test", version: "0" } }); P.notify("notifications/initialized");
await P.call("board_open", { dir: D2, port: PORT2 });
const P0 = Date.now(), long = P.start("board_wait", { timeout_s: 45 }, { progressToken: "tok-1" });

const A = await session(), B = await session("Look session"), G = await session("Other session");

// 1 a comment wakes `wait` and board_wait within 1 s
const w1 = cliWait("--timeout", "30s"); await w1.ready();
const b1 = A.start("board_wait", { timeout_s: 20 });
await sleep(300);
const t1 = Date.now(), c1 = await comment("why a queue?");
const [e1, r1] = await Promise.all([w1.exit, b1.done]), r1at = Date.now();
let j1 = null; try { j1 = JSON.parse(e1.out); } catch { /* checked below */ }
ok(e1.code === 0 && j1 && j1.kind === "comment" && j1.content === "why a queue?" && j1.id === c1.json.id && j1.box_id === "queue" && e1.at - t1 <= 1000,
  `1 a comment wakes \`agents-on-whiteboard wait\` in ${e1.at - t1} ms, exit 0, one JSON line (${e1.out.slice(0, 120)})`);
ok(!r1.err && r1.json && r1.json.id === c1.json.id && r1at - t1 <= 1000, `1b … and board_wait in ${r1at - t1} ms`);
ok(r1.json && JSON.stringify(r1.json) === JSON.stringify(j1), "1c both return the same JSON");

// 2 what never wakes them: a TOUR line, the agent's own reply, its own note's label
const w2 = cliWait("--timeout", "20s"); await w2.ready();
const b2 = A.start("board_wait", { timeout_s: 8 });
const steps = `${D}/steps.json`; fs.writeFileSync(steps, JSON.stringify({ title: "Check", steps: [{ target: "api", title: "The API", text: "It checks the cart.", ask: { question: "Keep it?" } }] }));
const tourOp = JSON.parse(await new Promise((r) => { let o = ""; const x = spawn(process.execPath, [BIN, "tour", steps, "--presenter", "Look session"], { cwd: D }); x.stdout.on("data", (d) => (o += d)); x.on("exit", () => r(o)); }));
const tr = await post("/api/tour", { c: page.c, name: "", tour_id: tourOp.tour_id, action: "step", index: 1, total: 1 }, true);
await A.call("board_say", { text: "Because the kitchen is slower than the app.", reply_to: c1.json.id });
await A.call("board_note", { ref: "n1", x: 0, y: -400, text: "a note from the agent" });
const n1 = { id: "lab1", type: "text", text: "a note from the agent", originalText: "a note from the agent", containerId: "n1", version: 2, versionNonce: 1, x: 0, y: -400, width: 100, height: 20, fontSize: 16, fontFamily: 1 };
await post("/api/scene", { c: page.c, elements: [n1] }, true);
await poll(() => /^TOUR: Host at step 1\/1/m.test(events()), 5000); await sleep(3500);   // the TOUR line, then past the 2.5 s canvas check
ok(tr.status === 200 && /^TOUR: Host at step 1\/1/m.test(events()) && w2.running(), `2 a TOUR line, the agent's tour, its reply and its note's label don't wake \`wait\` (still waiting: ${w2.running()})`);
const r2 = await b2.done;
ok(!r2.err && r2.json && r2.json.timeout === true, `2b … nor board_wait, which times out (${r2.text.slice(0, 80)})`);
// …and the person's comment after all that is what wakes it
const c2 = await comment("is the queue per store?"); const e2 = await w2.exit;
ok(e2.code === 0 && JSON.parse(e2.out).id === c2.json.id, "2c the next comment wakes it");
await A.call("board_wait", { timeout_s: 2 });   // A takes c2 off its queue

// 3 a timeout exits 2; board_wait returns {timeout: true}
const t3 = Date.now(), e3 = await cliWait("--timeout", "2s").exit;
ok(e3.code === 2 && e3.out === "" && e3.at - t3 >= 1900 && e3.at - t3 < 6000, `3 \`wait --timeout 2s\` exits 2 after ${e3.at - t3} ms, printing nothing on stdout (${e3.err})`);
const r3 = await A.call("board_wait", { timeout_s: 1 });
ok(!r3.err && r3.json && r3.json.timeout === true, `3b board_wait {timeout_s: 1} returns {timeout: true} (${r3.text})`);
const bad = await A.call("board_wait", { timeout_s: 0 }), e3c = await cliWait("--timeout", "soon").exit;
ok(bad.err && e3c.code === 1, `3c a bad timeout is refused (board_wait: ${bad.text.slice(0, 60)}; wait exit ${e3c.code})`);

// 4 nothing lost between waits
const c4a = await comment("first, while nobody waits"), c4b = await comment("second, right after");
await sleep(500);
const q1 = await A.call("board_wait", { timeout_s: 2 }), q2 = await A.call("board_wait", { timeout_s: 2 });
ok(q1.json && q1.json.id === c4a.json.id && q2.json && q2.json.id === c4b.json.id, `4 two comments sent while no board_wait ran come back in order on the next two calls (${q1.json && q1.json.content} | ${q2.json && q2.json.content})`);
const t4 = Date.now(), e4 = await cliWait("--since", c4a.json.id, "--timeout", "10s").exit;
ok(e4.code === 0 && JSON.parse(e4.out).id === c4b.json.id && e4.at - t4 < 3000, `4b \`wait --since <first>\` returns the second at once (${e4.at - t4} ms)`);
const e4c = await cliWait("--since", "cNoSuchId", "--timeout", "5s").exit;
ok(e4c.code === 1 && /no event cNoSuchId/.test(e4c.err), `4c \`wait --since\` an id not in the record fails, saying so (exit ${e4c.code}: ${e4c.err})`);

// 5 an answer wakes only the session presenting that tour
for (const s of [B, G]) await s.call("board_wait", { timeout_s: 1 });   // clear what they queued so far
await sleep(300); while (!(await B.call("board_wait", { timeout_s: 1 })).json.timeout); while (!(await G.call("board_wait", { timeout_s: 1 })).json.timeout);
const ans = await post("/api/answer", { tour_id: tourOp.tour_id, step: 1, pick: "keep", text: "fine" });
const rb = await B.call("board_wait", { timeout_s: 5 }), rg = await G.call("board_wait", { timeout_s: 2 });
ok(ans.status === 200 && rb.json && rb.json.kind === "answer" && rb.json.pick === "keep" && rb.json.answer_id === ans.json.id && rg.json && rg.json.timeout === true,
  `5 a ✓ keep on Look session's step wakes Look session's board_wait (${rb.text.slice(0, 90)}), not Other session's (${rg.text.slice(0, 40)})`);

// 6 a cancelled board_wait gets no answer and doesn't swallow the next comment
const x6 = A.start("board_wait", { timeout_s: 20 }); await sleep(300);
A.notify("notifications/cancelled", { requestId: x6.id, reason: "test" }); await sleep(300);
const c6 = await comment("after the cancel"); await sleep(500);
const r6 = await A.call("board_wait", { timeout_s: 3 });
ok(!A.answered.includes(x6.id) && r6.json && r6.json.id === c6.json.id, `6 a cancelled board_wait never answers, and the next call gets the comment (${r6.text.slice(0, 60)})`);

// 7 progress while it waits (the 45 s board_wait started at the top, on its own board)
const rl = await long.done, ps = P.others.filter((x) => x.method === "notifications/progress" && x.params.progressToken === "tok-1"), at = ps.map((x) => Math.round((x.at - P0) / 1000));
const gaps = [at[0], ...at.slice(1).map((x, k) => x - at[k])];
ok(rl.json && rl.json.timeout === true && ps.length >= 2 && gaps.every((g) => g <= 60) && ps.every((x, k) => x.params.progress === k + 1),
  `7 board_wait sends progress at least once a minute while it waits: ${ps.length} notifications at ${JSON.stringify(at)} s, then {timeout: true}`);

for (const s of [A, B, G, P]) s.p.kill(); srv.kill(); srv2.kill();
console.log(`(board copies: ${D}, ${D2})`);
