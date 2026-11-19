// Team gate: every board has three teammates (Ada the lead, Linus, Grace) with avatars from the start. A session that runs
// the team (board_open {team: true}) gets each comment marked `for` the teammate it is for, and speaks and draws as them
// with `as`. Teammates hand each other work with @Name. The person renames a teammate from its avatar (this computer only).
// An agent outside the team keeps the plain rules. Real MCP sessions over stdio, headless pages, a spare port.
//   node tests/team-test.mjs [spare port 4900–4940]      → PASS lines
import puppeteer from "puppeteer";
import { ok, sleep, scratch, serveBoard, mcpSession, portArg, settle, until, joined, pageKey, asPage } from "./lib.mjs";
const PORT = portArg(2, 4908), D = scratch("team"), U = `http://localhost:${PORT}/`;
const ARGS = { headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] };
const browsers = [], sessions = [], errs = [];
async function session(args) {
  const m = mcpSession(["--channels"]); sessions.push(m);
  await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "team-test", version: "0" } });
  m.notify("notifications/initialized");
  m.opened = await m.call("board_open", { dir: D, port: PORT, ...args });
  return m;
}
const open = async () => {
  const b = await puppeteer.launch(ARGS); browsers.push(b);
  const p = (await b.pages())[0] || await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(U, { waitUntil: "domcontentloaded" }); await until(p, () => window.__board && window.__board.ready, null, 30000); await joined(p);
  return p;
};
const comments = (s) => s.notes.filter((n) => n.meta && n.meta.kind === "comment");
const next = async (s, n0, ms = 5000) => { for (let i = 0; i < ms / 100 && comments(s).length <= n0; i++) await sleep(100); return comments(s)[n0] || null; };
const send = async (p, text, to = "") => { await p.select("#to", to); await p.type("#box", text); await p.click("#send"); };

const srv = await serveBoard(D, PORT);
try {
  const A = await open();
  // 1 the team is on the board before anyone says a word
  const t0 = await settle(A, () => window.__board.agents().avatars.length >= 3, null, 5000);
  const a0 = await A.evaluate(() => window.__board.agents());
  const names = a0.avatars.map((x) => x.name);
  ok(t0 >= 0 && names.slice(0, 3).join() === "Ada,Linus,Grace" && new Set(a0.avatars.map((x) => x.ink)).size === 3, `1 Ada, Linus and Grace are on a new board, each in its own colour (${JSON.stringify(a0.avatars)})`);
  const lead = await A.evaluate(() => [...document.querySelectorAll("#to option")].map((o) => o.textContent));
  ok(lead[0] === "everyone · Ada leads" && lead.includes("Grace"), `1b the "to" list says Ada leads (${lead.join(" | ")})`);

  // 2 the session that runs the team
  const T = await session({ team: true });
  ok(/the team: Ada \(lead, builder/.test(T.opened.text) && /you run the team/.test(T.opened.text), `2 board_open {team: true} names the team (${T.opened.text.slice(0, 220)})`);
  const P = await session({ presenter: "Codex" });   // an agent outside the team

  // 3 routing: no name is Ada's, the picker and @Name pick one; the outside agent hears only what's not for a teammate
  let [nt, np] = [comments(T).length, comments(P).length];
  await send(A, "What happens if the kitchen goes offline?");
  const e1 = await next(T, nt), p1 = await next(P, np);
  ok(e1 && e1.meta.for === "Ada" && p1 && !p1.meta.for, `3a a comment that names no one is for Ada (team: ${e1 && e1.meta.for}; Codex gets it too, unmarked)`);
  [nt, np] = [comments(T).length, comments(P).length];
  await send(A, "What breaks first?", "Linus");
  const e2 = await next(T, nt); await sleep(700);
  ok(e2 && e2.meta.for === "Linus" && e2.meta.to === "Linus" && comments(P).length === np, `3b "to Linus" is for Linus, and Codex doesn't get it (${e2 && JSON.stringify(e2.meta)})`);
  [nt, np] = [comments(T).length, comments(P).length];
  await send(A, "@Grace how does the code retry today?");
  const e3 = await next(T, nt);
  ok(e3 && e3.meta.for === "Grace", `3c "@Grace …" is for Grace (${e3 && e3.meta.for})`);

  // 4 speaking and drawing as a teammate
  const r1 = await T.call("board_say", { as: "Ada", reply_to: e1.meta.comment_id, text: "Orders wait in the queue until it's back." });
  const said = await settle(A, () => [...document.querySelectorAll("#thread .msg .meta b")].some((b) => b.textContent === "Ada"), null, 5000);
  const inks = await A.evaluate(() => { const b = [...document.querySelectorAll("#thread .msg .meta b")].find((x) => x.textContent === "Ada"); return { said: b && getComputedStyle(b).color, ada: window.__board.agents().avatars[0].ink }; });
  ok(!r1.err && said >= 0 && inks.said === inks.ada, `4a Ada's reply shows under her name, in her colour (${JSON.stringify(inks)})`);
  await T.call("board_box", { as: "Linus", ref: "cap", title: "🧱 Queue cap", sub: "500 orders, then wait", near: "queue", side: "below" });
  const busy = await settle(A, () => { const s = window.__board.pointer("Linus"), a = window.__board.agents().avatars.find((x) => x.name === "Linus"); return !!(s && s.drawing && a && a.busy); }, null, 4000);
  const pen = await A.evaluate(() => ({ ptr: window.__board.pointer("Linus").ink, av: window.__board.agents().avatars.find((x) => x.name === "Linus").ink }));
  ok(busy >= 0, `4b Linus's marker draws, and his avatar shows he's busy (${busy} ms)`);
  const landed = await settle(A, () => window.__board.elements().some((e) => e.id === "cap"), null, 9000);
  ok(landed >= 0, "4c Linus's box lands");
  const bad = await T.call("board_say", { as: "Bob", text: "hi" });
  ok(bad.err && /teammate/.test(bad.text), `4d speaking as someone outside the team is refused (${bad.text.slice(0, 90)})`);

  // 5 hand-offs between teammates: an @ wakes the one it names, never the one who wrote it
  nt = comments(T).length;
  await T.call("board_say", { as: "Ada", text: "@Linus is a 500-order cap enough at rush hour?" });
  const h1 = await next(T, nt);
  ok(h1 && h1.meta.via === "agent" && h1.meta.for === "Linus" && h1.meta.author === "Ada", `5a Ada's "@Linus …" comes back for Linus, from Ada (${h1 && JSON.stringify(h1.meta)})`);
  nt = comments(T).length;
  await T.call("board_say", { as: "Linus", text: "Enough for now. Logged it on the cap box." });
  await sleep(800);
  ok(comments(T).length === nt, "5b a reply that names no one wakes no one");

  // 6 renaming Grace from her avatar: her colour stays, the new name is the one that works
  const g0 = a0.avatars.find((x) => x.name === "Grace").ink;
  await A.click('#agents button[data-name="Grace"]');
  await A.waitForSelector("#agentMenu:not([hidden]) button");
  const btns = await A.evaluate(() => [...document.querySelectorAll("#agentMenu button")].map((b) => b.textContent));
  ok(btns.join() === "Follow,Rename", `6a Grace's avatar opens Follow and Rename (${btns.join(", ")})`);
  await A.evaluate(() => [...document.querySelectorAll("#agentMenu button")].find((b) => b.textContent === "Rename").click());
  await A.waitForSelector("#agentMenu input");
  await A.evaluate(() => { document.querySelector("#agentMenu input").value = ""; });
  await A.type("#agentMenu input", "Hopper"); await A.keyboard.press("Enter");
  const renamed = await settle(A, () => window.__board.agents().avatars.some((x) => x.name === "Hopper"), null, 5000);
  const a1 = await A.evaluate(() => window.__board.agents());
  const h = a1.avatars.find((x) => x.name === "Hopper");
  ok(renamed >= 0 && h && h.ink === g0 && !a1.avatars.some((x) => x.name === "Grace"), `6b the avatar says Hopper now, in Grace's colour (${JSON.stringify(a1.avatars.map((x) => x.name))})`);
  nt = comments(T).length;
  await send(A, "@Hopper can you check the retry code?");
  const e4 = await next(T, nt);
  ok(e4 && e4.meta.for === "Hopper", `6c "@Hopper …" is for Hopper (${e4 && e4.meta.for})`);
  const old = await T.call("board_say", { as: "Grace", text: "x" }), now = await T.call("board_say", { as: "Hopper", text: "Reading it now." });
  ok(old.err && !now.err, `6d the old name no longer works, the new one does (${old.text.slice(0, 60)})`);
  const B = await open();
  const b1 = await settle(B, () => window.__board.agents().avatars.slice(0, 3).map((x) => x.name).join() === "Ada,Linus,Hopper", null, 5000);
  ok(b1 >= 0, "6e a page opened after the rename has the new name");

  // 7 renaming is for this computer: not through the link, and not to a name that's taken or isn't a name
  const key = await pageKey(U);
  const viaLink = await fetch(`${U}api/agents`, { method: "POST", headers: { ...asPage(key, `http://localhost:${PORT}`), "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ from: "Ada", to: "Mallory" }) });
  const taken = await fetch(`${U}api/agents`, { method: "POST", headers: asPage(key, `http://localhost:${PORT}`), body: JSON.stringify({ from: "Ada", to: "Linus" }) });
  const junk = await fetch(`${U}api/agents`, { method: "POST", headers: asPage(key, `http://localhost:${PORT}`), body: JSON.stringify({ from: "Ada", to: "<img src=x>" }) });
  ok(viaLink.status === 403 && taken.status === 400 && junk.status === 400, `7 the link can't rename (${viaLink.status}); a taken name (${taken.status}) and a non-name (${junk.status}) are refused`);

  ok(errs.length === 0, `8 no page errors (${errs.slice(0, 3).join(" | ")})`);
} finally {
  for (const b of browsers) await b.close(); srv.kill(); for (const s of sessions) s.p.kill();
  process.exit(process.exitCode || 0);
}
