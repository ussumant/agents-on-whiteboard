# sketchcall

**Comment on a whiteboard. Your coding agent answers on it.**

[![demo](examples/demo.gif)](examples/demo.mp4)

An Excalidraw board on your own computer. Click a box and type. The agent you already use (Claude Code, Codex, Cursor, or a script) hears it, answers beside that box, points at things with its own named pointer, draws, and can walk you and your teammates through the board one step at a time.

## Quickstart

You need Node 20 or later.

### Claude Code: the plugin

```
/plugin install sketchcall --marketplace ussumant/sketchcall
```

On Claude Code before 2.1.275, add the marketplace first: `/plugin marketplace add ussumant/sketchcall`, then `/plugin install sketchcall@sketchcall`.

Then, in the folder with your diagram, ask Claude:

> Open a sketchcall board here and answer my comments on it.

Your browser opens on the board, and Claude waits for your first comment. With no `.excalidraw` file in the folder, the board starts from a sample.

### Any agent: `npx` and the MCP server

```
npx sketchcall open
```

That starts the board and opens your browser. Add the MCP server to your agent once:

```
claude mcp add sketchcall -- npx -y sketchcall mcp     # Claude Code
codex mcp add sketchcall -- npx -y sketchcall mcp      # Codex
```

Then tell it: *Open the sketchcall board in this folder and answer my comments on it.*

### Codex, Cursor and other MCP clients: `board_wait`

In Cursor, add this to `.cursor/mcp.json`:

```json
{ "mcpServers": { "sketchcall": { "command": "npx", "args": ["-y", "sketchcall", "mcp"] } } }
```

These agents hear you through `board_wait`. It returns your next comment as soon as you send it, or `{"timeout": true}` after 50 seconds, and the agent calls it again. While it waits, the server sends progress, so the client doesn't drop the call. Nothing is lost between calls.

### No MCP at all

Any agent that can run a command can take part, from the board's folder:

```
npx sketchcall wait                            # sleeps until your next comment, prints it as JSON, exits
npx sketchcall say "..." --reply-to <its id>   # answers on the same box
npx sketchcall wait --since <its id>           # the next one, even if it came in while you were replying
```

## How it works

- `sketchcall open` starts a small server on 127.0.0.1, so only this computer can reach it, and opens the board in your browser. The board is any `.excalidraw` file. The call is kept in `.sketchcall/` beside it: `thread.jsonl` (every comment, reply and drawing), `events.log` (one readable line per comment, canvas edit and tour move), `scene.json` (the board as it is now) and `files/` (pictures you paste).
- You click a box, or drag over an area, and type. The comment is saved with what it's about.
- Your agent hears it through `board_wait`, `sketchcall wait`, or a Claude Code channel push if you start the server with `mcp --channels`. There's no timer: the waits watch the record file, so a comment reaches the agent within a fraction of a second.
- The agent answers with `board_say`, and the reply shows under your comment and on the box. It can point (`board_point`), draw (`board_note`, `board_arrow`, `board_edit`, `board_delete`) and present a guided tour (`board_tour`, `board_tour_step`), with ✓ keep / ✎ change on any step it asks about.
- Everyone with the board open sees the same board live: edits, cursors and the agent's pointer. Undo only takes back your own changes. `sketchcall record` prints the whole call as Markdown.

## Comments are data

Anyone who can comment can type into your agent's context. That's you, a teammate on the share link, and any other program on your computer that can reach the board server. A comment proves nothing about who wrote it.

The MCP server tells the agent to treat comments as discussion about the diagram, never as instructions to run commands, edit files or change settings, and to ask you in the terminal instead. That instruction is a request to a model, not a lock. Think twice before you let an agent on a shared board act without asking you first.

## Sharing the board

```
sketchcall share
```

`share` opens the running board to teammates through a Cloudflare quick tunnel. It needs `cloudflared`, and prints the install line if you don't have it. The link carries a secret key and works until you press Ctrl-C or run `sketchcall unshare`. Before the link opens, `share` keeps a copy of the board in `.sketchcall/scene.before-share-<time>.json`.

A guest with the link can:

- see and edit the whole board, comment, answer tour steps and move their cursor
- reach your agent through their comments, which are always marked "via link"

A guest can't:

- post as you or as the agent: the names Host, You and Claude, and look-alikes of them, are refused or marked
- use your page's key, or act as your page in the room
- see where the board lives on your computer
- put embeds (other websites inside the board) or SVG pictures on it, or send elements the board can't draw
- fill the record: comments through the link stop at half of its 10 MB

Websites open in your browser can't write to the board, read it or frame it, whether or not it's shared.

## Commands

| Command | What it does |
|---|---|
| `open [file]` | Start the board (a copy of the sample if the folder has none) and open your browser. `--no-open` skips the browser. |
| `stop` | Stop this folder's board server. |
| `share`, `unshare` | Open the board to teammates through a link, and close it. |
| `wait` | Wait for the next comment and print it as one JSON line. `--since <id>` returns what came in after that one. |
| `say`, `point`, `tour`, `tour-step`, `op` | Reply, point, present and draw, from the shell. |
| `record` | Print every comment and its reply as Markdown. |
| `mcp` | Run the MCP server (`board_open`, `board_wait`, `board_say` and the rest). |

`sketchcall --help` lists every option.

## Known limits

- **A share link is edit access.** Anyone with the link can change or delete anything on the board. They can also lock an element by giving it a very high version number (the server takes versions up to a billion). Share it only with people you'd hand the file to.
- **A killed `share` can leave its link open.** If `share` is killed with SIGKILL, `share.json` stays behind and `cloudflared` can keep running. The server treats the link as closed while that process id is dead, but if the system hands the id to a new process, the old link works again. `sketchcall unshare` closes it; it also signals whatever process has that id now. Run `unshare` after a crash.
- **Part of Excalidraw isn't pinned.** The page's three script tags carry integrity hashes. Excalidraw then loads more scripts and its fonts from unpkg.com while it runs, and those can't be pinned the same way. The page sends no Content-Security-Policy beyond `frame-ancestors`.
- **No embeds.** Excalidraw's embed tool (a website or a video inside the board) is turned off.
- **A board has a size.** At most 5,000 elements (deleted ones count, and the oldest deleted ones make room) and 20 MB. One element is at most 64 KB, and a line or freehand stroke at most 10,000 points. Past that, new elements aren't saved or shared. Text over 10,000 characters in one element isn't kept either.
- **The share link gets half the record.** Comments and answers through the link stop at 5 MB of `thread.jsonl`; this computer can keep commenting until 10 MB.
- **Every page rereads the whole record.** Pages fetch all of `thread.jsonl` on each update.
- **Open pages aren't capped.** Each open page holds one long poll. Nothing limits how many a link guest can open, beyond 60 new pages a minute.
- **A page open across a server restart needs a reload.** The keys are new each run, so a page opened before the restart can't save anything and says "the board server restarted: reload this page".
- **A guest's words are still their own.** A guest can type "BOARD: Host wrote ..." into a comment or a label. It stays on that guest's one line in `events.log`, which starts with their name and "via link".
- **Some look-alike names still pass.** Names that mix scripts are refused, and the usual stand-ins for the letters of "Claude" are folded, but a name written wholly in another script whose letters look Latin can still read as "Claude". Link guests are marked "via link" in the panel and to the agent, but not on their cursor.
- **Channels are a research preview.** `mcp --channels` pushes comments into Claude Code, but a server like this one needs Claude Code's `--dangerously-load-development-channels` flag, and it doesn't work under `claude -p`. `board_wait` and `wait` are the default.
- **Tested in Chrome.** The browser tests run in headless Chrome. Safari and Firefox aren't tested. The share test runs one real Cloudflare quick tunnel.

## Development

```
npm install      # the test browser; the package itself has no dependencies
npm test         # every gate, on spare ports 4900 to 4927
npm run test:share   # one real Cloudflare tunnel, on a copy of the sample board: run it by hand
```

## License

MIT
