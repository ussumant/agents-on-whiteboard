// Share gate: a real Cloudflare quick tunnel. The person's page on localhost, a teammate's phone through the link.
// The board's content goes through Cloudflare, so it runs ONLY on a fresh copy of the sample board, and only by hand:
//   node tests/share-test.mjs [spare port 4900–4940]      → PASS lines; then nothing of it is left running
// Needs cloudflared on PATH.
import fs from "node:fs"; import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import puppeteer from "puppeteer";
import { ok, sleep, scratch, portArg, poll, until, joined, credsIn, asPage, BIN } from "./lib.mjs";
import * as S from "../src/server.mjs";

const PORT = portArg(2, 4924), D = scratch("share"), F = S.files(D), U = `http://localhost:${PORT}`;
const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: D, encoding: "utf8", timeout: 30000 });
const tunnels = () => { try { return execFileSync("pgrep", ["-f", `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:${PORT}`]).toString().trim().split("\n").filter(Boolean); } catch { return []; } };
let sh = null, b = null;
const cleanup = () => { try { sh && sh.kill(); } catch {} run("unshare"); run("stop"); for (const p of tunnels()) try { process.kill(+p); } catch {} };
process.on("exit", cleanup);

ok(run("open", "--no-open", "--port", String(PORT)).status === 0, "0 the sample board is open locally");
const home = credsIn(await (await fetch(`${U}/`)).text());
b = await puppeteer.launch({ headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const L = await b.newPage(); await L.setViewport({ width: 1200, height: 800 });
await L.goto(`${U}/`, { waitUntil: "domcontentloaded" }); await L.waitForFunction("window.__board && window.__board.ready === true", { timeout: 60000 }); await joined(L);

sh = spawn(process.execPath, [BIN, "share"], { cwd: D }); let out = "";
sh.stdout.on("data", (d) => (out += d)); sh.stderr.on("data", (d) => (out += d));
await poll(() => /share link: (\S+)/.test(out), 45000);
const link = (out.match(/share link: (\S+)/) || [])[1];
ok(!!link && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/\?k=/.test(link), `1 share prints a link (${link ? link.replace(/k=.*/, "k=…") : out.slice(0, 200)})`);
if (!link) process.exit(1);
const base = link.split("/?")[0];
const status = async (u, headers = {}) => { try { return (await fetch(u, { headers, redirect: "manual", signal: AbortSignal.timeout(15000) })).status; } catch (e) { return e.cause?.code || e.name; } };
await poll(async () => typeof (await status(`${base}/`)) === "number", 90000);   // the quick tunnel's name takes a while to resolve
await sleep(2000);
ok(await status(`${base}/`) === 403, `2 the link without its key is refused (${await status(`${base}/`)})`);

// the teammate, on a phone
const ctx = await b.createBrowserContext(), R = await ctx.newPage(); await R.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
const errs = []; R.on("pageerror", (e) => errs.push(e.message)); R.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await R.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 }); await R.waitForFunction("window.__board && window.__board.ready === true", { timeout: 60000 });
ok(!(await R.evaluate(() => location.search)).includes("k="), "3 the key leaves the teammate's address bar");
const guestKey = await R.evaluate(() => window.__boardInfo.token);
ok(!!guestKey && guestKey !== home.key, "3b the teammate's page has the link's own write key, not this computer's");
ok(await R.evaluate(() => !!document.querySelector("form input[placeholder='your name']")), "4 the teammate is asked their name once");
await R.type("form input[placeholder='your name']", "Riya"); await R.click("form button");
ok(await until(L, () => __board.peers().includes("Riya"), null, 20000), "5 the person's page sees Riya join through the tunnel");
ok(await until(R, () => __board.peers().includes("Host"), null, 20000), "5b Riya's page hears the room through the tunnel");
await L.evaluate(() => __board.setLabel("api__title", "the host typed this"));
ok(await until(R, () => (__excalidrawAPI.getSceneElements().find((e) => e.id === "api__title") || {}).text === "the host typed this", null, 20000), "6 the person's edit reaches Riya over the internet");
await R.evaluate(() => __board.setLabel("queue__title", "Riya typed this"));
ok(await until(L, () => (__excalidrawAPI.getSceneElements().find((e) => e.id === "queue__title") || {}).text === "Riya typed this", null, 20000), "6b Riya's edit reaches the person");
await R.evaluate(() => { document.getElementById("box").value = "comment through the link"; document.getElementById("send").click(); });
await poll(() => S.thread(D).some((i) => i.text === "comment through the link"), 20000);
const it = S.thread(D).find((i) => i.text === "comment through the link");
ok(it && it.author === "riya" && it.via === "link", `7 the comment is Riya's, marked as via the link ${JSON.stringify(it && { a: it.author, v: it.via })}`);
await R.mouse.move(150, 300); await R.mouse.move(170, 330);
ok(await until(L, () => [...__excalidrawAPI.getAppState().collaborators.values()].some((c) => c.username === "Riya" && c.pointer), null, 20000), "8 Riya's cursor shows on the person's page");
// what the link can't do, seen through the real tunnel
const cookie = (await R.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
const hello = await (await fetch(`${base}/api/hello`, { headers: { cookie } })).json().catch(() => null);
ok(hello && !("dir" in hello), `9 through the link, /api/hello doesn't name the board's folder (${JSON.stringify(hello)})`);
const homeOnLink = await fetch(`${base}/api/comment`, { method: "POST", headers: { ...asPage(home.key, base), cookie }, body: JSON.stringify({ text: "with this computer's key" }) }).then((r) => r.status, () => 0);
ok(homeOnLink === 403, `9b this computer's key is refused through the link (${homeOnLink})`);
ok(!errs.length, `10 no errors on Riya's page ${JSON.stringify(errs.slice(0, 3))}`);
// unshare closes it
run("unshare"); await poll(() => sh.exitCode !== null, 10000); await sleep(1500);
const after = await status(link);
ok(after !== 200, `11 after unshare the link is dead (${after})`);
ok(!fs.existsSync(F.share), "11b share.json is gone");
ok(fs.readdirSync(F.live).some((f) => f.startsWith("scene.before-share-")), "11c a copy of the board was kept from before the link opened");
ok(!tunnels().length, `11d no cloudflared is left running (${tunnels().join(",")})`);
await b.close(); b = null;
run("stop");
console.log(`(board copy: ${path.basename(D)})`);
