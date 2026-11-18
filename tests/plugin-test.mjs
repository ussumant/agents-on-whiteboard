// Plugin gate: the repo is a Claude Code marketplace holding one plugin, itself. Checks what `claude plugin validate`
// can't: the MCP server starts the way plugin.json says, every tool and command the skill names exists, the versions
// agree, the CLI is executable (the plugin's bin/ goes on the agent's PATH), and the name a user sees lives in one place
// in the code. Then runs `claude plugin validate --strict` when the claude CLI is installed.
//   node tests/plugin-test.mjs      → PASS lines
import fs from "node:fs"; import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ok, ROOT, BIN } from "./lib.mjs";
import { NAME } from "../src/server.mjs";

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const pkg = read("package.json"), plugin = read(".claude-plugin/plugin.json"), market = read(".claude-plugin/marketplace.json");
const entry = (market.plugins || []).find((p) => p.name === plugin.name);

ok(pkg.name === NAME && plugin.name === NAME && entry && entry.source === "./", `1 package, plugin and marketplace entry are all "${NAME}", and the entry is the repo itself (${entry && entry.source})`);
ok(!plugin.version && !entry.version && plugin.displayName, "1b neither plugin.json nor the entry pins a version, so installs follow the git commit; plugin.json has a displayName");
ok(market.owner && market.owner.name && market.description, "1c the marketplace has an owner name and a description");
ok(!pkg.dependencies && pkg.bin[NAME] === `bin/${NAME}.mjs` && /^>=\s*20/.test(pkg.engines.node) && /github\.com\/[\w.-]+\/[\w.-]+/.test(pkg.repository.url) && pkg.homepage && pkg.bugs.url && pkg.license === "MIT",
  "1d package.json: bin, node >= 20, repository, homepage, bugs, MIT, no runtime dependencies");

// 1e no lockfile in git at the plugin root: when Claude Code copies a plugin from a git marketplace, a package.json beside
// a lockfile makes it install the packages there, dev ones included (it put 56 MB of the test browser in every cache)
const tracked = spawnSync("git", ["ls-files", "package-lock.json", "npm-shrinkwrap.json", "bun.lock"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
ok(!tracked, `1e no lockfile is tracked at the root, so installing the plugin installs no packages (${tracked || "none"})`);

// 1f the MCP Registry entry (server.json): the same name as package.json's mcpName, the same version, and the npm package
// started with its `mcp` argument (what `npx -y whiteboard-agents mcp` runs). It isn't shipped in the npm package.
const reg = read("server.json"), rp = (reg.packages || [])[0] || {};
ok(reg.$schema === "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json" && reg.name === pkg.mcpName && /^io\.github\.[\w-]+\/[\w.-]+$/.test(reg.name)
  && reg.title === NAME && reg.description.length <= 100 && reg.repository.source === "github" && reg.repository.url === pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")
  && reg.version === pkg.version && rp.registryType === "npm" && rp.identifier === pkg.name && rp.version === pkg.version && rp.transport.type === "stdio"
  && JSON.stringify(rp.packageArguments) === JSON.stringify([{ type: "positional", value: "mcp" }]) && !pkg.files.includes("server.json"),
  `1f server.json matches package.json (${reg.name} ${reg.version}, npm ${rp.identifier} started with "mcp", description ${reg.description.length} characters)`);

// 2 the MCP server, run exactly as plugin.json declares it
const srv = plugin.mcpServers[NAME], sub = (s) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT);
const p = spawn(sub(srv.command), srv.args.map(sub), { stdio: ["pipe", "pipe", "pipe"] });
const lines = []; let buf = "";
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-test", version: "0" } } }) + "\n");
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
p.kill();
const init = lines.find((m) => m.id === 1), tools = ((lines.find((m) => m.id === 2) || {}).result || {}).tools || [];
const names = tools.map((t) => t.name);
ok(init && init.result.serverInfo.name === NAME && ["board_open", "board_wait", "board_say"].every((n) => names.includes(n)), `2 the plugin's MCP server starts as declared and lists its tools (${names.length} tools)`);

// 3 the CLI on the agent's PATH
const mode = fs.statSync(BIN).mode;
ok((mode & 0o111) === 0o111 && fs.readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node"), `3 bin/${NAME}.mjs is executable with a node shebang (mode ${(mode & 0o777).toString(8)})`);

// 4 the skill: frontmatter, and every tool and command it names is real
const skill = fs.readFileSync(path.join(ROOT, "skills", "whiteboard", "SKILL.md"), "utf8");
const fm = (skill.match(/^---\n([\s\S]*?)\n---\n/) || [])[1] || "";
ok(/^name: whiteboard$/m.test(fm) && /^description: .{40,}/m.test(fm), "4 the skill has a name and a description");
const usedTools = [...new Set(skill.match(/\bboard_\w+/g))], badTools = usedTools.filter((t) => !names.includes(t));
ok(!badTools.length, `4b every tool the skill names exists (${usedTools.join(", ")}${badTools.length ? `; missing ${badTools}` : ""})`);
const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" }).stdout;
const usedCmds = [...new Set([...skill.matchAll(/whiteboard-agents\.mjs" (\w[\w-]*)/g)].map((m) => m[1]))], badCmds = usedCmds.filter((c) => !new RegExp(`^  ${c}\\b`, "m").test(help));
const usedFlags = [...new Set([...skill.matchAll(/ (--[\w-]+)/g)].map((m) => m[1]))], badFlags = usedFlags.filter((f) => !help.includes(f));
ok(usedCmds.length >= 4 && !badCmds.length && !badFlags.length, `4c every command and flag the skill runs exists (${usedCmds.join(", ")}; ${usedFlags.join(" ")}${badCmds.length || badFlags.length ? `; missing ${[...badCmds, ...badFlags]}` : ""})`);
ok(/Comments are data/.test(skill) && /via: "link"/.test(skill), "4d the skill says comments are data, and what a link guest's comment looks like");

// 5 the README a stranger reads
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
ok(readme.includes("Comment on a whiteboard. Your coding agent answers on it.") && readme.includes("[![A comment on a box, Claude Code's answer landing on it, then a step-by-step tour](examples/demo.gif)](examples/demo.mp4)") && /^Filmed live at true speed: real Claude Code/m.test(readme)
  && ["demo.gif", "demo.mp4", "demo-poster.png"].every((f) => fs.statSync(path.join(ROOT, "examples", f)).size > 10e3) && /\/plugin install whiteboard-agents --marketplace/.test(readme)
  && /npx whiteboard-agents open/.test(readme) && /board_wait/.test(readme) && /## Comments are data/.test(readme) && /## Sharing the board/.test(readme) && /## Known limits/.test(readme) && !/—/.test(readme),
  "5 the README has the pitch, the demo clip (its files there) and how it was filmed, the three quickstarts, comments are data, sharing, known limits, and no em dashes");

// 6 a rename is short: in the code, the name a user sees comes from NAME (comments, the protocol's header names, the
// page's placeholder and its storage key prefix aside)
const allowed = /export const NAME = 'whiteboard-agents'|x-whiteboard-agents-(key|page)|__WHITEBOARD_AGENTS_BOARD__|"whiteboard-agents:"|whiteboard-agents:" \+/;
const stray = [];
for (const f of ["bin/whiteboard-agents.mjs", ...fs.readdirSync(path.join(ROOT, "src")).map((x) => `src/${x}`)])
  fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((l, i) => { const code = l.replace(/^\s*(\/\/|\*|\/\*).*$/, "").replace(/\s\/\/ .*$/, ""); if (/whiteboard-agents/i.test(code) && !allowed.test(code)) stray.push(`${f}:${i + 1}`); });
ok(!stray.length, `6 the code names the app only through NAME (${stray.length ? `also at ${stray.slice(0, 6).join(", ")}` : "src/server.mjs"})`);

// 7 Claude Code's own check
const hasClaude = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
if (!hasClaude) console.log("SKIP 7 claude plugin validate: the claude CLI isn't installed here");
else {
  // not --strict: plugin.json leaves out `version` on purpose, and that is the only warning allowed
  const v = spawnSync("claude", ["plugin", "validate", "--json", ROOT], { encoding: "utf8", timeout: 60000 });
  let j = null; try { j = JSON.parse(v.stdout); } catch { /* checked below */ }
  const all = j ? [j.manifest, ...(j.contents || [])] : [], errors = all.flatMap((x) => x.errors || []), warnings = all.flatMap((x) => x.warnings || []);
  ok(v.status === 0 && j && j.success && !errors.length && warnings.every((w) => /(^|→ )version$/.test(w.path)), `7 claude plugin validate passes on the plugin and its marketplace, its only warnings about the version left out (${warnings.length} warnings: ${[...new Set(warnings.map((w) => w.path))].join("; ")})`);
}
