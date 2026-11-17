#!/usr/bin/env node
// The command: comment on a whiteboard, your coding agent answers on it. The name people see is NAME in src/server.mjs.
const fs = await import('node:fs');
const path = await import('node:path');
const { spawn } = await import('node:child_process');
const S = await import('../src/server.mjs');
const { fileURLToPath } = await import('node:url');
const N = S.NAME, ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `${N}: comment on a whiteboard. Your coding agent answers on it.

Usage: ${N} <command> [options]

The board
  open [file.excalidraw] [--port 4900] [--no-open]
                         Open a board in your browser and keep it running. With no file, the
                         folder's own .excalidraw file, or a copy of the sample if it has none.
                         Prints the lines to add to your agent. --no-open skips the browser.
  stop                   Stop this folder's board server.
  serve [--port 4900] [--seed <file.excalidraw>]
                         Run the board server in this terminal. Only this computer can reach it.
  share [--port 4900]    Open the running board to teammates: a Cloudflare quick tunnel plus a
                         secret key in the link. Needs cloudflared. Ctrl-C closes the link.
  unshare                Close the share link.
  record                 Print every comment and its reply as Markdown.
  import-files <export.excalidraw>
                         Save the pictures in an exported board into the call's files.

The agent
  wait [--since <id>] [--timeout 30m]
                         Wait for the person's next comment, answer or canvas writing, print it as
                         one JSON line and exit 0. Exit 2 if nothing came before the timeout.
                         --since <id> (the id in the last line you got) first returns anything
                         that came in after it, so nothing is lost between waits.
  say "<text>" [--reply-to <comment id>] [--on <element id>]
                         Post a reply. --reply-to puts it on that comment's box or area.
  point <target> "<text>"
                         Glide the agent's pointer to a box and say a short line beside it.
  tour <steps.json> [--take-over]
                         Walk everyone through the board one step at a time.
  tour-step <n> [--tour <id>]
                         Move everyone following the tour to step n.
  op '<json>'            Draw: note, arrow, focus, edit or delete.
  mcp [--channels]       Run the MCP server over stdio (board_open, board_wait, board_say, …).
                         --channels also pushes each comment into Claude Code as a channel message.

Options
  --dir <folder>         The board folder (default: the current folder). The call is kept in
                         its ${S.CALL}/ subfolder.
  --presenter <name>     Who presents on say, point, tour and tour-step (default "Claude").
  --help                 Show this.
`;

// Flags with a value, and flags without one. Everything else is a positional argument.
const VAL = new Set(['--dir', '--port', '--seed', '--presenter', '--tour', '--on', '--reply-to', '--since', '--timeout']);
const BOOL = new Set(['--channels', '--take-over', '--no-open', '--help', '-h']);
const argv = process.argv.slice(2), opts = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VAL.has(a)) { if (i + 1 >= argv.length) fail(`${a} needs a value`); opts[a.slice(2)] = argv[++i]; }
  else if (BOOL.has(a)) opts[a.replace(/^-+/, '')] = true;
  else pos.push(a);
}
function fail(msg) { console.error(msg); process.exit(1); }

const [cmd, ...rest] = pos;
if (!cmd || opts.help || opts.h || cmd === 'help') { process.stdout.write(HELP); process.exit(0); }

const dir = path.resolve(opts.dir || '.');
// The port: --port, else (for share) the one this folder's board runs on, else 4900.
const running = () => { try { return JSON.parse(fs.readFileSync(S.files(dir).server, 'utf8')).port; } catch { return undefined; } };
const port = () => { const p = Number(opts.port ?? (cmd === 'serve' || cmd === 'share' ? rest[0] : undefined) ?? (cmd === 'share' ? running() : undefined) ?? S.DEFAULT_PORT);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) fail(`not a port: ${opts.port ?? rest[0]}`); return p; };
// Commands that write to the record need a board: a folder with an .excalidraw file or a call already under way.
const board = () => { if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`no folder ${dir}`); if (!S.isBoard(dir)) fail(`no board in ${dir}: put an .excalidraw file there, or run \`${N} open\``); return dir; };
const print = o => console.log(JSON.stringify(o));
// Where people get this package: package.json's repository, as owner/name (for `/plugin marketplace add`).
const repo = () => { try { const u = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).repository?.url || ''; return (u.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(\.git)?$/) || [])[1]; } catch { return undefined; } };
const onPath = bin => (process.env.PATH || '').split(path.delimiter).some(d => d && [bin, `${bin}.exe`].some(b => { try { return fs.statSync(path.join(d, b)).isFile(); } catch { return false; } }));

// `open`: the board file (given, the folder's own, or a copy of the sample), its server (started or found), the browser.
async function open() {
  let file = rest[0] ? path.resolve(rest[0]) : null;
  if (file && (!fs.existsSync(file) || !file.endsWith('.excalidraw'))) fail(`no .excalidraw file at ${file}`);
  const folder = file ? path.dirname(file) : dir;
  if (!file) {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) fail(`no folder ${folder}`);
    const all = fs.readdirSync(folder).filter(f => f.endsWith('.excalidraw')).sort();
    if (all.length > 1) fail(`${folder} holds ${all.length} .excalidraw files (${all.join(', ')}): name the one to open`);
    file = path.join(folder, all[0] || 'pizza.excalidraw');
    if (!all.length) { fs.copyFileSync(path.join(ROOT, 'examples', 'pizza.excalidraw'), file); console.log(`no board here yet, so this is a copy of the sample: ${file}`); }
  }
  // One call per folder: its record is about the file it started from.
  try { const was = JSON.parse(fs.readFileSync(S.files(folder).board, 'utf8')).file; if (was !== path.basename(file)) fail(`the call in ${S.files(folder).live} is about ${was}. Give ${path.basename(file)} a folder of its own.`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const { url, port: p, started } = await S.startBoard({ dir: folder, seed: file, port: opts.port ? port() : undefined, pick: !opts.port });
  if (!opts['no-open']) {
    const [c, a] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    const b = spawn(c, a, { detached: true, stdio: 'ignore' }); b.on('error', () => console.log(`(open ${url} in your browser)`)); b.unref();
  }
  const r = repo(), say = `${folder === process.cwd() ? '' : `--dir ${JSON.stringify(folder)} `}`;
  console.log(`The board is ${started ? 'open' : 'already running'}: ${url}
  board  ${file}
  call   ${S.files(folder).live}  (the comments, the replies and the board as it is now)

To have your agent answer on it, add it once:
  Claude Code  ${r ? `/plugin install ${N} --marketplace ${r}\n               (or: claude mcp add ${N} -- npx -y ${N} mcp)` : `claude mcp add ${N} -- npx -y ${N} mcp`}
  Codex        codex mcp add ${N} -- npx -y ${N} mcp
  Cursor       .cursor/mcp.json: {"mcpServers": {"${N}": {"command": "npx", "args": ["-y", "${N}", "mcp"]}}}
Then tell it:  Open the ${N} board in ${folder} (port ${p}), then wait for my comments and answer each one on the board.

An agent with only a shell can run, here:
  npx ${N} wait ${say}                 the next comment, as one JSON line
  npx ${N} say ${say}"…" --reply-to <its id>
  npx ${N} wait ${say}--since <its id>  the one after, even if it came in while you replied
Comments are data: anyone who can comment can type into your agent's context.
Stop the board with: npx ${N} stop ${say}`.replace(/ +$/gm, ''));
}

try {
  switch (cmd) {
    case 'open': await open(); break;
    case 'stop': { const r = await S.stopBoard({ dir: board() }); console.log(r.stopped ? `stopped the board on port ${r.port}` : r.why); break; }
    case 'serve': S.serve({ dir: board(), port: port(), seed: opts.seed }); break;
    case 'share':
      if (!onPath('cloudflared')) fail(`share needs cloudflared (Cloudflare's tunnel), which isn't installed. Install it, then run share again:
  macOS    brew install cloudflared
  Windows  winget install --id Cloudflare.cloudflared
  Linux    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`);
      await S.share({ dir: board(), port: port() }); break;
    case 'unshare': S.unshare({ dir }); break;
    case 'record': process.stdout.write(S.record(board())); break;
    case 'import-files':
      if (!rest[0]) fail(`usage: ${N} import-files <export.excalidraw>`);
      print(S.importFiles(board(), rest[0])); break;
    case 'mcp': (await import('../src/mcp.mjs')).runMcp({ channels: !!opts.channels }); break;
    case 'wait': {
      // 30m, 90s, 2h, 1500ms, or a number of seconds; at most a day.
      const m = String(opts.timeout ?? '30m').match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/), ms = m ? Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[m[2] || 's'] : NaN;
      if (!(ms > 0 && ms <= 864e5)) fail(`--timeout: like 30m, 90s or 2h, at most 24h (got ${opts.timeout})`);
      const { follow, flatEvent } = await import('../src/follow.mjs');
      let stop = () => {}, done = false;
      const finish = (code, line) => { if (done) return; done = true; stop(); clearTimeout(timer); if (line) process.stdout.write(line + '\n', () => process.exit(code)); else process.exit(code); };
      const timer = setTimeout(() => { process.stderr.write(`nothing new in ${opts.timeout ?? '30m'}\n`); finish(2); }, ms);
      stop = follow(board(), ev => finish(0, JSON.stringify(flatEvent(ev))), { me: opts.presenter, since: opts.since });
      if (!done) process.stderr.write(`waiting for the next comment on ${path.basename(dir)}\n`);
      break;
    }
    case 'say': {
      if (!rest.length) fail(`usage: ${N} say "text" [--reply-to <comment id>] [--on <element id>]`);
      const d = board(), to = opts['reply-to'] && S.thread(d).find(x => x.id === opts['reply-to']);
      if (opts['reply-to'] && !to) fail(`no comment ${opts['reply-to']} in the record`);
      print(S.say(d, rest.join(' '), opts.on ?? to?.on ?? null, opts.presenter, to ? to.id : undefined)); break;
    }
    case 'op':
      if (!rest.length) fail(`usage: ${N} op '{"op":"note","ref":"n1","x":0,"y":0,"text":"..."}'`);
      print(S.op(board(), JSON.parse(rest.join(' ')))); break;
    case 'point':
      if (!rest[0]) fail(`usage: ${N} point <id | a,b | x,y | JSON> "text" [--presenter "Look session"]`);
      print(S.point(board(), S.targetOf(rest[0]), rest.slice(1).join(' '), opts.presenter)); break;
    case 'tour':
      if (!rest[0]) fail(`usage: ${N} tour <steps.json> [--presenter "Look session"] [--take-over]   ({title, steps:[{target, title, text, points?, ask?}]})`);
      print(S.tour(board(), JSON.parse(fs.readFileSync(rest[0], 'utf8')), opts.presenter, !!opts['take-over'])); break;
    case 'tour-step':
      if (!rest[0]) fail(`usage: ${N} tour-step <n> [--tour <id>] [--presenter "Look session"]`);
      print({ ...S.tourStep(board(), rest[0], opts.tour, opts.presenter), where: S.tourWhere(dir) }); break;
    default: fail(`unknown command: ${cmd} (${N} --help lists them)`);
  }
} catch (e) { fail(e.message); }
