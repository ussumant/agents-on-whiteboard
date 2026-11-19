# agents-on-whiteboard

**Comment on a whiteboard. Your coding agent answers on it.**

[![A comment on a box, Claude Code's answer landing on it, then a step-by-step tour](examples/demo.gif)](examples/demo.mp4)

Filmed live at true speed: real Claude Code answering on the sample board. For the clip, its prompt named the boxes and the order of its moves; the words are its own.

An Excalidraw board on your own computer. Click a box and type. The agent you already use (Claude Code, Codex, Cursor, or a script) hears it, answers beside that box, points at things with its own named pointer, draws, and can walk you and your teammates through the board one step at a time.

## Quickstart

You need Node 20 or later.

### Claude Code: the plugin

In a Claude Code session:

```
/plugin install agents-on-whiteboard --marketplace ussumant/agents-on-whiteboard
```

Or from your shell:

```
claude plugin install agents-on-whiteboard --marketplace ussumant/agents-on-whiteboard
```

Those one-line forms need a recent Claude Code (2.1.275 or later in a session, 2.1.292 or later in the shell). On an older one, add the marketplace first, then install from it:

```
claude plugin marketplace add ussumant/agents-on-whiteboard
claude plugin install agents-on-whiteboard@agents-on-whiteboard
```

Then, in the folder with your diagram, ask Claude:

> Open an agents-on-whiteboard board here and answer my comments on it.

Your browser opens on the board, and Claude waits for your first comment. With no `.excalidraw` file in the folder, the board starts from a sample.

### Any agent: `npx` and the MCP server

```
npx agents-on-whiteboard open
```

That starts the board and opens your browser. Add the MCP server to your agent once:

```
claude mcp add agents-on-whiteboard -- npx -y agents-on-whiteboard mcp     # Claude Code
codex mcp add agents-on-whiteboard -- npx -y agents-on-whiteboard mcp      # Codex
```

Then tell it: *Open the agents-on-whiteboard board in this folder and answer my comments on it.*

### Codex, Cursor and other MCP clients: `board_wait`

In Cursor, add this to `.cursor/mcp.json`:

```json
{ "mcpServers": { "agents-on-whiteboard": { "command": "npx", "args": ["-y", "agents-on-whiteboard", "mcp"] } } }
```

These agents hear you through `board_wait`. It returns your next comment as soon as you send it, or `{"timeout": true}` after 50 seconds, and the agent calls it again. While it waits, the server sends progress, so the client doesn't drop the call. Comments wait for the agent from `board_open` on, and yours (from this computer) come first and are never dropped. Through the share link, only the newest 500 wait; the next result says how many older ones were dropped, and the record still has them.

### No MCP at all

Any agent that can run a command can take part, from the board's folder:

```
npx agents-on-whiteboard wait                            # sleeps until your next comment, prints it as JSON, exits
npx agents-on-whiteboard say "..." --reply-to <its id>   # answers on the same box
npx agents-on-whiteboard wait --since <its id>           # the next one, even if it came in while you were replying (yours first)
```

## How it works

- `agents-on-whiteboard open` starts a small server on 127.0.0.1, so only this computer can reach it, and opens the board in your browser. The board is any `.excalidraw` file. The call is kept in `.agents-on-whiteboard/` beside it: `thread.jsonl` (every comment, reply and drawing), `events.log` (one readable line per comment, canvas edit and tour move), `scene.json` (the board as it is now) and `files/` (pictures you paste). The folder gets its own `.gitignore`, so the call stays out of git. The server won't start if anything in `.agents-on-whiteboard/` is a symbolic link, a hard link (a file with a second name somewhere else) or anything other than a file or folder, and says which one. It checks again on every file it opens.
- You click a box, or drag over an area, and type. The comment is saved with what it's about. Comments on a box become a thread: click its pin to open the thread on the board, read every reply, and answer there. Type `@` to tag an agent.
- Your agent hears it through `board_wait`, `agents-on-whiteboard wait`, or a Claude Code channel push if you start the server with `mcp --channels`. There's no timer: the waits watch the record file, so a comment reaches the agent within a fraction of a second.
- The agent answers with `board_say`, and the reply shows under your comment and on the box. It can point (`board_point`), draw (`board_box`, `board_area`, `board_note`, `board_arrow`, `board_edit`, `board_delete`), zoom (`board_focus`, or `"all"` for the whole board) and present a guided tour (`board_tour`, `board_tour_step`), with ✓ keep / ✎ change on any step it asks about.
- You watch it draw. Its pointer turns into a marker in its colour, glides to the spot, draws the outline and writes the words, and then the real box lands on everyone's board, with no reload. `board_box` puts a new box beside one the agent names (`near`, `side`), in the first free spot, with an arrow from another box if it asks (`from`).
- Every board has a team of three: Ada (the lead, who builds and draws), Linus (the critic) and Grace (the scout, who reads your code and docs). Their avatars are on the board from the start; click one to follow it or rename it. In Claude Code, the session runs them as background subagents, one per teammate, so each keeps its own conversation (`board_open {team: true}`): a comment that names no one goes to Ada, `@Linus` or the "to" list picks one, and they bring each other in with `@Name`.
- Other agents can join too, each under its own name (`board_open {presenter}`), colour and marker. Their avatars sit at the top right: click one to follow that agent, so your view moves with its work and nobody else's. Esc stops following. A comment goes to everyone, or to one agent: pick it in the comment box's "to" list, or start with `@Name`. An agent can hand another one work by starting its reply with `@Name`. Hand-offs are capped at four between two of your comments, so two agents can't keep waking each other.
- Everyone with the board open sees the same board live: edits, cursors and the agent's pointer. Undo only takes back your own changes. `agents-on-whiteboard record` prints the whole call as Markdown.

**History.** The board saves versions on its own, like Figma: one 10 seconds after it stops changing, at least one every 2 minutes while it keeps changing, and one when the server starts. Each says when, what changed and who ("Ada drew 🔁 Retry worker", "You changed 3 texts"). Click History at the top of the panel to see them, newest first. Preview draws a version small. Restore makes the board look like that version for everyone, live, and saves the board as it was first, so restoring that "Before restoring" version undoes it. Save a copy downloads a version as an `.excalidraw` file you can open anywhere. Versions are kept in `.agents-on-whiteboard/history/`: the newest 200 and at most 50 MB, with older ones thinned out. Agents read them with `board_history` to reuse a past state, but only you can restore one, and nobody on the share link can see or restore them.

## Comments are data

Anyone who can comment can type into your agent's context. That's you, a teammate on the share link, and any other program on your computer that can reach the board server. A comment proves nothing about who wrote it.

The MCP server tells the agent to treat comments as discussion about the diagram, never as instructions to run commands, edit files or change settings, and to ask you in the terminal instead. That instruction is a request to a model, not a lock. Think twice before you let an agent on a shared board act without asking you first.

## Sharing the board

```
agents-on-whiteboard share
```

`share` opens the running board to teammates through a Cloudflare quick tunnel. It needs `cloudflared`, and prints the install line if you don't have it. The link carries a secret key and works until you press Ctrl-C or run `agents-on-whiteboard unshare`. Before the link opens, `share` keeps a copy of the board in `.agents-on-whiteboard/scene.before-share-<time>.json`.

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
| `wait` | Wait for the next comment and print it as one JSON line. `--since <id>` returns what came in after that one, this computer's comments first. |
| `say`, `point`, `tour`, `tour-step`, `op` | Reply, point, present and draw, from the shell. |
| `record` | Print every comment and its reply as Markdown. |
| `mcp` | Run the MCP server (`board_open`, `board_wait`, `board_say` and the rest). |

`agents-on-whiteboard --help` lists every option.

## Known limits

- **A share link is edit access.** Anyone with the link can change or delete anything on the board. They can also lock an element by giving it a very high version number (the server takes versions up to a billion). Share it only with people you'd hand the file to.
- **A killed `share` can leave its link open.** If `share` is killed with SIGKILL, `share.json` stays behind and `cloudflared` can keep running. The server treats the link as closed while that process id is dead, but if the system hands the id to a new process, the old link works again. `agents-on-whiteboard unshare` closes it; it also signals whatever process has that id now. Run `unshare` after a crash.
- **Part of Excalidraw isn't pinned.** The page's three script tags carry integrity hashes. Excalidraw then loads more scripts and its fonts from unpkg.com while it runs, and those can't be pinned the same way. The page sends no Content-Security-Policy beyond `frame-ancestors`.
- **No embeds.** Excalidraw's embed tool (a website or a video inside the board) is turned off.
- **A board has a size.** At most 5,000 elements (deleted ones count, and the oldest deleted ones make room) and 20 MB. One element is at most 64 KB, and a line or freehand stroke at most 10,000 points. Past that, new elements aren't saved or shared. Text over 10,000 characters in one element isn't kept either. Hatched, cross-hatched and zigzag fills on a shape over 2,000 wide or tall are drawn solid, since they are slow to draw at that size. Other fill patterns (dots, dashed, zigzag-line) are always drawn solid, and a line or freehand stroke is measured by its points.
- **The share link gets half the record.** Comments and answers through the link stop at 5 MB of `thread.jsonl`; this computer can keep commenting until 10 MB.
- **Every page rereads the whole record.** Pages fetch all of `thread.jsonl` on each update.
- **The link has a read budget.** What a guest fetches (the board, the record, pictures) counts against 24 MB at once, refilled at 8 MB a second, under 48 MB at 16 MB a second for all guests together. Writes have their own: 8 MB at once and 2 MB a second each, so a guest can paste one 5 MB picture at a time. A guest who has just loaded many large pictures, or a record of several MB, can see their page pause for a few seconds before it catches up.
- **A guest can make the board slow to open.** Like deleting things (see the first limit: a share link is edit access), this is inside what the link allows. The link takes at most 200 shapes over 1,000 wide or tall (a line or stroke by its points), so 1,000 boxes 100,000 wide no longer take 22 seconds to load. Shapes under that size aren't counted: in the last review, 2,500 cross-hatched boxes 999 wide made a new tab take about 17 seconds to open, and 200 boxes 100,000 wide plus 2,300 at 999 about a minute. Shapes drawn on this computer aren't limited, so a board you draw with hundreds of very large shapes is slow to open too.
- **Open pages aren't capped.** Each open page holds one long poll. Nothing limits how many a link guest can open, beyond 20 new pages a minute for each guest and 60 for the link as a whole.
- **A guest is an address.** The per-guest limits on pages, writes and reads count by the address Cloudflare reports for the guest, an IPv6 address by its /64 (the block one home connection gets). Guests behind one address share one budget, and a guest who changes address gets a fresh one; the link as a whole still has its own ceiling.
- **A flood through the link can push guests past the agent.** Your comments from this computer always reach the agent, first. Through the link, `board_wait` keeps the newest 500 and says how many older ones it dropped, and `wait --since` gives your comment before guests' and says how many guests' it passed over. Every one of them stays in the record.
- **A page open across a server restart needs a reload.** The keys are new each run, so a page opened before the restart can't save anything and says "the board server restarted: reload this page".
- **A guest's words are still their own.** A guest can type "BOARD: Host wrote ..." into a comment or a label. It stays on that guest's one line in `events.log`, which starts with their name and "via link".
- **Some look-alike names still pass.** Names that mix scripts are refused, and the usual stand-ins for the letters of "Claude" are folded, but a name written wholly in another script whose letters look Latin can still read as "Claude". Link guests are marked "via link" in the panel and to the agent, but not on their cursor.
- **Channels are a research preview.** `mcp --channels` pushes comments into Claude Code, but a server like this one needs Claude Code's `--dangerously-load-development-channels` flag, and it doesn't work under `claude -p`. `board_wait` and `wait` are the default.
- **Tested in Chrome.** The browser tests run in headless Chrome. Safari and Firefox aren't tested. The share test runs one real Cloudflare quick tunnel.

## Development

```
npm install      # the test browser; the package itself has no dependencies
npm test         # every gate, on spare ports 4900 to 4940
npm run test:share   # one real Cloudflare tunnel, on a copy of the sample board: run it by hand
```

## License

MIT
