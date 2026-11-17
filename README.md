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
- **Every page rereads the whole record.** Pages fetch all of `live/thread.jsonl` on each update. The record stops taking
  comments from pages at 10 MB.
- **Open pages aren't capped.** Each open page holds one long poll. Nothing limits how many a link guest can open.
- **`record` prints comments as they were written.** HTML in a comment stays HTML in the Markdown, so render it with raw
  HTML turned off.
- **Tested in Chrome only.** The cross-site tests run in headless Chrome. Safari and Firefox aren't tested, and neither is
  a real Cloudflare tunnel: the tests simulate a link guest the way the server sees one.
