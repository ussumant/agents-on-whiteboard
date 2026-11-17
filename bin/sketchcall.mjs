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

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}
console.error(`sketchcall ${args[0]}: not built yet`);
process.exit(1);
