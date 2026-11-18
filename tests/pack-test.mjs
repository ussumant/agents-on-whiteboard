// Package gate: the npm package holds only the CLI, the server, the page and the sample board, has no runtime
// dependencies, and `whiteboard-agents --help` lists the commands.
//   node tests/pack-test.mjs      → PASS lines
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const files = packed[0].files.map((f) => f.path).sort();
const ALLOWED = ["LICENSE", "README.md", "package.json", "bin/whiteboard-agents.mjs", "src/server.mjs", "src/mcp.mjs", "src/follow.mjs", "src/board.html", "examples/pizza.excalidraw"];
const extra = files.filter((f) => !ALLOWED.includes(f));
const missing = ALLOWED.filter((f) => f !== "README.md" && !files.includes(f));
ok(!extra.length && !missing.length, `1 npm pack lists only the package files (${files.join(", ")})${extra.length ? ` extra: ${extra}` : ""}${missing.length ? ` missing: ${missing}` : ""}`);
ok(!files.some((f) => f.startsWith("tests/")), "1b tests stay out of the package");
ok(!files.some((f) => /^examples\/demo/.test(f)), `1c the demo clip (examples/demo*) stays out of the package (${files.filter((f) => f.startsWith("examples/")).join(", ")})`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
ok(!pkg.dependencies || !Object.keys(pkg.dependencies).length, "2 no runtime dependencies");
ok(pkg.bin && pkg.bin["whiteboard-agents"] === "bin/whiteboard-agents.mjs" && /^>=\s*20/.test((pkg.engines || {}).node || ""), "2b bin is whiteboard-agents, Node >= 20");
ok(pkg.license === "MIT" && fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8").startsWith("MIT License"), "2c MIT licence");

const help = execFileSync(process.execPath, [path.join(ROOT, "bin/whiteboard-agents.mjs"), "--help"], { encoding: "utf8" });
const COMMANDS = ["open", "stop", "serve", "share", "unshare", "record", "import-files", "wait", "mcp", "say", "op", "point", "tour", "tour-step"];
const absent = COMMANDS.filter((c) => !new RegExp(`^  ${c}\\b`, "m").test(help));
ok(!absent.length, `3 --help lists every command${absent.length ? ` (missing: ${absent})` : ""}`);
