#!/usr/bin/env node
// sketchcall: comment on a whiteboard, your coding agent answers on it.

const HELP = `sketchcall: comment on a whiteboard. Your coding agent answers on it.

Usage: sketchcall <command> [options]

The board
  serve [--port 4900] [--seed <file.excalidraw>]
                         Serve the board on http://localhost:<port>. Only this computer can reach it.
                         The first run starts from the folder's .excalidraw file.
  share [--port 4900]    Open the running board to teammates: a Cloudflare quick tunnel plus a
                         secret key in the link. Needs cloudflared. Ctrl-C closes the link.
  unshare                Close the share link.
  record                 Print every comment and its reply as Markdown.
  import-files <export.excalidraw>
                         Save the pictures in an exported board into the call's files.

The agent
  mcp [--channels]       Run the MCP server over stdio. --channels also pushes each comment into
                         Claude Code as a channel message (a research preview).
  say "<text>" [--on <id>]
                         Post a reply in the discussion.
  op '<json>'            Draw: note, arrow, focus, edit or delete.
  point <target> "<text>"
                         Glide the agent's pointer to a box and say a short line beside it.
  tour <steps.json> [--take-over]
                         Walk everyone through the board one step at a time.
  tour-step <n> [--tour <id>]
                         Move everyone following the tour to step n.

Options
  --dir <folder>         The board folder (default: the current folder). The call is kept in
                         its live/ subfolder.
  --presenter <name>     Who presents on point, tour and tour-step (default "Claude").
  --help                 Show this.
`;

// Flags with a value, and flags without one. Everything else is a positional argument.
const VAL = new Set(['--dir', '--port', '--seed', '--presenter', '--tour', '--on']);
const BOOL = new Set(['--channels', '--take-over', '--help', '-h']);
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

const fs = await import('node:fs');
const path = await import('node:path');
const S = await import('../src/server.mjs');
const dir = path.resolve(opts.dir || '.');
const port = () => { const p = Number(opts.port ?? (cmd === 'serve' || cmd === 'share' ? rest[0] : undefined) ?? S.DEFAULT_PORT); if (!Number.isInteger(p) || p < 1 || p > 65535) fail(`not a port: ${opts.port ?? rest[0]}`); return p; };
// Commands that write to the record need a board: a folder with an .excalidraw file or a call already under way.
const board = () => { if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`no folder ${dir}`); if (!S.isBoard(dir)) fail(`no board in ${dir}: put an .excalidraw file there (or pass --dir <board folder>)`); return dir; };
const print = o => console.log(JSON.stringify(o));

try {
  switch (cmd) {
    case 'serve': S.serve({ dir: board(), port: port(), seed: opts.seed }); break;
    case 'share': await S.share({ dir: board(), port: port() }); break;
    case 'unshare': S.unshare({ dir }); break;
    case 'record': process.stdout.write(S.record(board())); break;
    case 'import-files':
      if (!rest[0]) fail('usage: sketchcall import-files <export.excalidraw>');
      print(S.importFiles(board(), rest[0])); break;
    case 'mcp': (await import('../src/mcp.mjs')).runMcp({ channels: !!opts.channels }); break;
    case 'say':
      if (!rest.length) fail('usage: sketchcall say "text" [--on <element id>]');
      print(S.say(board(), rest.join(' '), opts.on ?? null)); break;
    case 'op':
      if (!rest.length) fail(`usage: sketchcall op '{"op":"note","ref":"n1","x":0,"y":0,"text":"..."}'`);
      print(S.op(board(), JSON.parse(rest.join(' ')))); break;
    case 'point':
      if (!rest[0]) fail('usage: sketchcall point <id | a,b | x,y | JSON> "text" [--presenter "Look session"]');
      print(S.point(board(), S.targetOf(rest[0]), rest.slice(1).join(' '), opts.presenter)); break;
    case 'tour':
      if (!rest[0]) fail('usage: sketchcall tour <steps.json> [--presenter "Look session"] [--take-over]   ({title, steps:[{target, title, text, points?, ask?}]})');
      print(S.tour(board(), JSON.parse(fs.readFileSync(rest[0], 'utf8')), opts.presenter, !!opts['take-over'])); break;
    case 'tour-step':
      if (!rest[0]) fail('usage: sketchcall tour-step <n> [--tour <id>] [--presenter "Look session"]');
      print({ ...S.tourStep(board(), rest[0], opts.tour, opts.presenter), where: S.tourWhere(dir) }); break;
    default: fail(`unknown command: ${cmd} (sketchcall --help lists them)`);
  }
} catch (e) { fail(e.message); }
