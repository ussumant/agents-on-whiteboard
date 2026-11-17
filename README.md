# sketchcall

Comment on a whiteboard. Your coding agent answers on it.

> Work in progress. Not published yet; the full README comes with the first release.

## Known limits

The safety checks done before the first release are in `tests/security-test.mjs` and `tests/xsite-test.mjs`. This is what
they leave open.

- **A share link is edit access.** Anyone with the link can change or delete anything on the board. They can also lock an
  element by giving it a very high version number (the server takes versions up to a billion). `share` copies the board to
  `live/scene.before-share-<time>.json` before it opens the link. Share it only with people you would hand the file to.
- **A killed `share` can leave its link open.** If `share` is killed with SIGKILL, `live/share.json` stays behind and
  `cloudflared` can keep running. The server treats the link as closed while that process id is dead, but if the system
  hands the id to a new process, the old link works again. `sketchcall unshare` closes it; it also signals whatever process
  has that id now. Run `unshare` after a crash.
- **Part of Excalidraw isn't pinned.** The page's three script tags carry integrity hashes. Excalidraw then loads more
  scripts and its fonts from unpkg.com while it runs, and those can't be pinned the same way. The page sends no
  Content-Security-Policy beyond `frame-ancestors`. Serving Excalidraw from the package itself comes with the move to
  Excalidraw 0.18.
- **No embeds.** Excalidraw's embed tool (a website or a video inside the board) is turned off, and the server refuses
  embed elements: a guest could otherwise show any website, or a tweet whose script runs with the board's own access,
  inside every open page.
- **A board has a size.** At most 5,000 elements (deleted ones count, and the oldest deleted ones make room) and 20 MB. One
  element is at most 64 KB, and a line or freehand stroke at most 10,000 points and 256 KB. Past that, new elements aren't
  saved or shared.
- **The share link gets half the record.** Comments and answers through the link stop at 5 MB of `live/thread.jsonl`;
  this computer can keep commenting until 10 MB.
- **A page open across a server restart needs a reload.** The keys are new each run, so a page opened before the restart
  can't save anything and says "the board server restarted: reload this page".
- **A guest's words are still their own.** A guest can type "BOARD: Host wrote …" into a comment or a label. It stays on
  that guest's one line in `events.log`, which starts with their name and "via link".
- **Some look-alike names still pass.** Names that mix scripts are refused, and the usual stand-ins for the letters of
  "Claude" are folded, but a name written wholly in another script whose letters look Latin (Cherokee capitals, say) can
  still read as "Claude". Link guests are marked "via link" in the panel and to the agent, but not on their cursor.
- **Very long canvas text isn't kept.** Text over 10,000 characters in one element on the board isn't saved or shared with
  the other pages (the agent's tools refuse it up front).
- **Every page rereads the whole record.** Pages fetch all of `live/thread.jsonl` on each update. The record stops taking
  comments from pages at 10 MB.
- **Open pages aren't capped.** Each open page holds one long poll. Nothing limits how many a link guest can open.
- **Tested in Chrome only.** The cross-site tests run in headless Chrome. Safari and Firefox aren't tested, and neither is
  a real Cloudflare tunnel: the tests simulate a link guest the way the server sees one.
