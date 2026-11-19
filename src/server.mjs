// The board server and the record of the call. A person comments on an Excalidraw board in the browser; their coding agent
// answers on it (through the CLI in bin/agents-on-whiteboard.mjs or the MCP tools in src/mcp.mjs), like a screen-share call.
//
// A board is a folder holding one .excalidraw file. The call lives in its .agents-on-whiteboard/ subfolder (CALL below):
//   thread.jsonl   the record: every comment, reply and op, one JSON line each
//   events.log     one line per comment, per text someone writes or changes on the canvas, per picture and per tour
//                  move: what a person (or a grep) reads
//   canvas.jsonl   the canvas writing as records, which `wait`, board_wait and the channel push read
//   scene.json     the board as everyone sees it now (the .excalidraw file is only where it started)
//   files/         pictures pasted on the board, one image file each
//   board.json     which .excalidraw file the call started from; server.json the running server; share.json the
//                  share link's key, only while `share` runs
// Multiplayer: the server holds the scene. Pages load it, send only the elements they changed, and get everyone else's
// changes and cursors by long-polling /api/changes. Per element, the higher `version` wins.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// The name people see: the command, the page title, the MCP server, the call's folder. A rename changes it here and in
// package.json, the plugin files and the README.
export const NAME = 'agents-on-whiteboard';
export const CALL = `.${NAME}`;
export const DEFAULT_PORT = 4900;
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'board.html');
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', `${NAME}.mjs`);

// Text a person sent, kept on one line wherever it goes into a line of its own (events.log, a channel message): no control
// characters, no line or paragraph separators, no bidi overrides. Each could start a forged line, or flip how a line reads.
// Joiners stay: the sample's 👩‍🍳 is three characters held together by one.
export const BREAKS = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu;
export const oneLine = s => String(s ?? '').replace(BREAKS, ' ').replace(/\s+/g, ' ').trim();
// An element id as Excalidraw makes them (and as ops name them, like api__title): letters, digits, _ - . and :, nothing a
// line, an attribute or a channel tag could be broken with.
export const ID = /^[\w.:-]{1,128}$/;
// Where a comment sits, as a page sends it: {id, ids, label, rect, tour, step}. Ids must be ids (`known` also lets through
// an odd id the board itself already has), at most 50 of them; the label is one line of at most 80 characters.
export function cleanOn(on, known = id => ID.test(id)) {
  if (on == null) return null;
  const no = m => { throw Object.assign(new Error(m), { status: 400 }); };
  if (typeof on !== 'object' || Array.isArray(on)) no('on must be {id, ids, label, rect}');
  const isId = x => typeof x === 'string' && known(x), out = {};
  if (on.id != null) { if (!isId(on.id)) no('on.id is not an element id on this board'); out.id = on.id; }
  if (on.ids != null) { if (!Array.isArray(on.ids) || on.ids.length > 50 || !on.ids.every(isId)) no('on.ids: at most 50 element ids'); out.ids = on.ids; }
  if (on.label != null) out.label = oneLine(on.label).slice(0, 80);
  if (on.rect != null) { const q = on.rect; if (!q || !['x', 'y', 'w', 'h'].every(k => Number.isFinite(q[k]))) no('on.rect needs numbers x, y, w and h'); out.rect = { x: q.x, y: q.y, w: q.w, h: q.h }; }
  if (on.tour != null) { if (typeof on.tour !== 'string' || !ID.test(on.tour)) no('on.tour is not a tour id'); out.tour = on.tour; }
  if (on.step != null) { if (!Number.isInteger(on.step) || on.step < 1 || on.step > 1000) no('on.step is a step number'); out.step = on.step; }
  return Object.keys(out).length ? out : null;
}
// What a page may put on the board, by Excalidraw's own element types and the shape each field has there. Anything else
// in a POST is dropped, never saved or passed on: a text whose text was a number crashed the server on every restart, a
// version of 1e308 locked an element for good, and a boundElements of 5 or points that weren't points blanked every page.
// Embeds (embeddable, iframe) never come in: a guest could put any website, or a tweet whose script runs in the board's
// own origin, inside every open page.
export const TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image', 'frame', 'magicframe']);
const LINEAR = new Set(['arrow', 'line']);
const num = v => typeof v === 'number' && Number.isFinite(v);
const opt = (v, ok) => v === undefined || v === null || ok(v);
const str = n => v => typeof v === 'string' && v.length <= n;
// Every number has a size, not only a type. A finite but huge shape (an ellipse 1e15 wide, a hatched rectangle 1e12 wide)
// took Excalidraw's hand-drawn renderer forever and froze every page that showed it. Measured in a page: a hatched or
// cross-hatched shape 1e6 wide still blocks it for up to 1.7 s, and 1e5 wide for 0.2 s; so positions stay within ±1e6
// and sizes and points within 1e5.
const within = n => v => num(v) && Math.abs(v) <= n;
const range = (lo, hi) => v => num(v) && v >= lo && v <= hi;
const POS = 1e6, SIZE = 1e5;
const points = (p, min) => Array.isArray(p) && p.length >= min && p.length <= 10000 && p.every(q => Array.isArray(q) && q.length === 2 && within(SIZE)(q[0]) && within(SIZE)(q[1]));
// A value nested past `n` levels of objects or arrays (an element's points are 2: the list, then each point).
const deeper = (v, n) => !!v && typeof v === 'object' && (n <= 0 || Object.values(v).some(x => deeper(x, n - 1)));
export function shapeOk(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || !TYPES.has(e.type)) return false;
  if (!['x', 'y'].every(k => opt(e[k], within(POS))) || !['width', 'height', 'baseline'].every(k => opt(e[k], within(SIZE)))) return false;
  if (!opt(e.angle, within(1e4)) || !opt(e.strokeWidth, range(0.5, 100)) || !opt(e.roughness, range(0, 5)) || !opt(e.opacity, range(0, 100))) return false;
  if (!opt(e.fontSize, range(1, 1000)) || !opt(e.lineHeight, range(0.5, 5)) || !opt(e.fontFamily, range(0, 100)) || !['seed', 'updated'].every(k => opt(e[k], num))) return false;
  if (!opt(e.scale, q => Array.isArray(q) && q.length === 2 && q.every(within(10))) || !opt(e.lastCommittedPoint, q => Array.isArray(q) && q.length === 2 && q.every(within(SIZE)))) return false;
  if (!['text', 'originalText'].every(k => opt(e[k], str(10000)))) return false;
  if (!['strokeColor', 'backgroundColor', 'fillStyle', 'strokeStyle', 'textAlign', 'verticalAlign', 'status', 'startArrowhead', 'endArrowhead', 'frameId', 'name'].every(k => opt(e[k], str(200)))) return false;
  if (!['isDeleted', 'locked'].every(k => opt(e[k], v => typeof v === 'boolean')) || !opt(e.link, str(2000))) return false;
  if (!opt(e.groupIds, g => Array.isArray(g) && g.length <= 100 && g.every(str(128)))) return false;
  if (!opt(e.boundElements, b => Array.isArray(b) && b.length <= 1000 && b.every(x => x && typeof x === 'object' && str(128)(x.id) && str(32)(x.type)))) return false;
  if (!opt(e.roundness, q => typeof q === 'object' && num(q.type) && opt(q.value, num))) return false;
  if (!['startBinding', 'endBinding'].every(k => opt(e[k], q => typeof q === 'object' && str(128)(q.elementId) && within(10)(q.focus) && within(SIZE)(q.gap)))) return false;
  if (!opt(e.customData, c => typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length <= 16 && Object.values(c).every(v => v === null || typeof v === 'boolean' || num(v) || str(200)(v)))) return false;
  if (LINEAR.has(e.type) ? !points(e.points, 2) : e.type === 'freedraw' ? !points(e.points, 1) || !opt(e.pressures, q => Array.isArray(q) && q.length <= 10000 && q.every(num)) : e.points !== undefined) return false;
  if (e.containerId != null && (typeof e.containerId !== 'string' || e.containerId === e.id)) return false;
  return !Object.values(e).some(v => deeper(v, 2));
}
// From a page: the shape above, an id this board takes, a whole-number version under a billion, and ids it points at.
export const okElement = (e, known = id => ID.test(id)) => shapeOk(e) && typeof e.id === 'string' && known(e.id)
  && Number.isInteger(e.version) && e.version >= 0 && e.version < 1e9 && Number.isSafeInteger(e.versionNonce)
  && (e.containerId == null || known(e.containerId)) && (e.fileId == null || (typeof e.fileId === 'string' && /^[\w-]{1,128}$/.test(e.fileId)));
// A link is kept only when it is an absolute http(s) address with nothing hidden in it. Excalidraw cleans a link again in
// the page (it decodes &#47; and &tab;, and drops control, space and zero-width characters), so "/&#47;evil.test" became
// "//evil.test" there and opened another site in the board's own tab. A link that would change in that cleaning is
// dropped, along with relative links and every other scheme.
// A link guest, for the per-guest limits: the address Cloudflare reports (cf-connecting-ip), with an IPv6 address cut to
// its /64. A home connection gets a whole /64, so keying on the full address let one person be as many guests as they
// liked. IPv4 written as IPv6 (::ffff:a.b.c.d) is the IPv4 address.
export function guestKey(ip) {
  const a = String(ip || 'link').trim().toLowerCase().replace(/%.*$/, '').slice(0, 64);
  const v4 = a.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/); if (v4) return v4[1];
  if (!/^[\da-f:.]+$/.test(a) || a.split('::').length > 2) return a;
  const [head, tail] = a.split('::'), h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const all = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${all.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(':')}::/64`;
}
export const linkOk = l => typeof l === 'string' && l.length <= 2000 && !/[\p{Cc}\p{Cf}\p{Z}\s]|&[#\w]+;/u.test(l)
  && (() => { try { const u = new URL(l); return (u.protocol === 'https:' || u.protocol === 'http:') && l.toLowerCase().startsWith(`${u.protocol}//`) && !u.username && !u.password; } catch { return false; } })();
// What is kept of an element that passed: never `validated` (Excalidraw draws an embed that says so), and only a link
// that passes linkOk. A hatched, cross-hatched or zigzag fill costs drawing time by its size over its stroke: 200 boxes of
// 1e5, each in bounds, froze every page. So such a fill is drawn solid past 2,000 × 2,000, and with a stroke of at least
// 1 below it (measured: 200 boxes at the cap load in 1.2 s). Excalidraw's renderer also draws dots, dashed and
// zigzag-line fills, and any other name as hachure, so only the four fills its menu offers are kept: anything else is
// solid. A line, arrow or freehand stroke is measured by its points, which is how the page sizes it, not by the width and
// height it declares. (No fill named is drawn solid.)
export const FILLS = new Set(['solid', 'hachure', 'cross-hatch', 'zigzag']), HATCH = new Set(['hachure', 'cross-hatch', 'zigzag']), HATCH_MAX = 2000;
export const extent = e => {
  let w = e.width || 0, h = e.height || 0;
  if (Array.isArray(e.points) && e.points.length) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of e.points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    w = Math.max(w, x1 - x0); h = Math.max(h, y1 - y0);
  }
  return [w, h];
};
export const cleanElement = e => {
  const { validated, ...out } = e;
  if (out.link != null && !linkOk(out.link)) out.link = null;
  if (out.fillStyle != null && !FILLS.has(out.fillStyle)) out.fillStyle = 'solid';
  if (HATCH.has(out.fillStyle)) { const [w, h] = extent(out); if (w > HATCH_MAX || h > HATCH_MAX) out.fillStyle = 'solid'; else if (!(out.strokeWidth >= 1)) out.strokeWidth = 1; }
  return out;
};
// One element is at most 64 KB as JSON (a line or a freehand stroke, with up to 10,000 points, 256 KB).
export const ELEMENT_MAX = e => LINEAR.has(e.type) || e.type === 'freedraw' ? 256e3 : 64e3;
// A board file or scene.json as it starts the server: a person's own file may have odd ids or no versionNonce, so only
// what can crash the server or a page, or lock an element, is left out.
const loadable = e => !!e && typeof e === 'object' && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 128 && !/\p{Cc}/u.test(e.id)
  && (e.version === undefined || (Number.isFinite(e.version) && e.version < 1e9)) && shapeOk(e);

// The record helpers, shared with mcp.mjs so both write exactly the same lines. `dir` is the board folder.
// canvas.jsonl holds the BOARD events as records ({id, ts, author, via, key, el, text, change}), which the MCP server
// pushes from, never by reading the words of a log line back.
export const files = dir => { const live = path.join(dir, CALL); return { live, thread: path.join(live, 'thread.jsonl'), canvas: path.join(live, 'canvas.jsonl'),
  events: path.join(live, 'events.log'), scene: path.join(live, 'scene.json'), agents: path.join(live, 'agents.json'), share: path.join(live, 'share.json'), server: path.join(live, 'server.json'), board: path.join(live, 'board.json') }; };
const now = () => new Date().toISOString();
const nextId = p => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
// No writes through symbolic links. A repo can ship its own .agents-on-whiteboard/, and a link in it (events.log pointing at a shell
// start-up file) put a link guest's words into a script the owner then ran. So the server won't start on a call folder
// holding a link anywhere in it, and every write opens its file without following a link at the last step (O_NOFOLLOW),
// after checking the folders between it and the call folder: a link swapped in later is caught too. The call folder is
// this account's only (700, files 600), and git ignores it.
// A hard link is another name for the same file, which lstat and O_NOFOLLOW can't tell apart (a tarball can ship one:
// events.log as the repo's setup.sh, a picture as its .env). So no file in the call folder may have more than one name,
// checked at start and on the open file itself before each write or read; and nothing in it may be other than a file or
// a folder (a named pipe would hang the first write).
const linkError = p => Object.assign(new Error(`${p} is a symbolic link. ${NAME} never writes through links: delete it (or the whole ${CALL} folder, if you didn't make it) and start again.`), { code: 'ESYMLINK' });
const hardError = (p, n) => Object.assign(new Error(`${p} is a hard link: the same file has ${n} names on disk. ${NAME} never writes or serves such a file: delete it (or the whole ${CALL} folder, if you didn't make it) and start again.`), { code: 'EHARDLINK' });
const oddError = p => Object.assign(new Error(`${p} is not a plain file or folder. ${NAME} only keeps files and folders there: delete it (or the whole ${CALL} folder, if you didn't make it) and start again.`), { code: 'ENOTFILE' });
const plain = (p, st) => { if (!st.isFile()) throw oddError(p); if (st.nlink > 1) throw hardError(p, st.nlink); };
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
function noLinks(p) {   // p, and each folder above it up to the call folder
  const parts = p.split(path.sep), at = parts.lastIndexOf(CALL);
  for (let i = parts.length; i > (at < 0 ? parts.length - 1 : at); i--) { const q = parts.slice(0, i).join(path.sep) || path.sep; if (isLink(q)) throw linkError(q); }
}
// (O_NONBLOCK: opening a named pipe returns at once instead of waiting for a reader; a plain file ignores it.)
const C = fs.constants, NOLINK = (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0), OPEN = C.O_WRONLY | C.O_CREAT | NOLINK;
// A file opened to write: truncated (`trunc`) only once it is known to be this call's own, so a hard link's other file
// is never emptied by the open itself.
export function openSafe(p, trunc = false) {
  noLinks(p);
  let fd; try { fd = fs.openSync(p, OPEN | (trunc ? 0 : C.O_APPEND), 0o600); } catch (e) { throw e.code === 'ELOOP' ? linkError(p) : e; }
  try { plain(p, fs.fstatSync(fd)); if (trunc) fs.ftruncateSync(fd, 0); try { fs.fchmodSync(fd, 0o600); } catch { /* a filesystem without modes */ } }
  catch (e) { fs.closeSync(fd); throw e; }
  return fd;
}
export const writeSafe = (p, data) => { const fd = openSafe(p, true); try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); } };
export const appendSafe = (p, data) => { const fd = openSafe(p); try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); } };
export const mkdirSafe = p => { noLinks(p); fs.mkdirSync(p, { recursive: true, mode: 0o700 }); noLinks(p); };
// A file read from the call folder: the same checks, on the file that was opened. `enc` null gives the bytes.
export function readSafe(p, enc = 'utf8') {
  noLinks(p);
  let fd; try { fd = fs.openSync(p, C.O_RDONLY | NOLINK); } catch (e) { throw e.code === 'ELOOP' ? linkError(p) : e; }
  try { plain(p, fs.fstatSync(fd)); return fs.readFileSync(fd, enc); } finally { fs.closeSync(fd); }
}
// The whole call folder, before anything reads or writes it: only folders, and files with one name each.
export function checkCall(dir) {
  const live = files(dir).live;
  if (isLink(live)) throw linkError(live);
  if (!fs.existsSync(live)) return;
  const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f), st = fs.lstatSync(p); if (st.isSymbolicLink()) throw linkError(p); if (st.isDirectory()) walk(p); else plain(p, st); } };
  walk(live);
}
export function makeCall(dir) {
  const live = files(dir).live;
  checkCall(dir); mkdirSafe(live);
  try { fs.chmodSync(live, 0o700); } catch { /* a filesystem without modes */ }
  const gi = path.join(live, '.gitignore'); if (!fs.existsSync(gi)) writeSafe(gi, '*\n');
}
export const append = (dir, item) => { mkdirSafe(files(dir).live); appendSafe(files(dir).thread, JSON.stringify(item) + '\n'); return item; };
export const thread = dir => fs.existsSync(files(dir).thread) ? readSafe(files(dir).thread).split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
// `by` is the presenting session's name: a reply from "Look session" says so in the panel and on the tour card.
// `replyTo` is the id of the comment it answers: the record pairs them by it, never by the box.
export const say = (dir, text, on = null, by, replyTo) => append(dir, withPresenter({ kind: 'comment', id: nextId('c'), ts: now(), author: 'claude', text, on, ...(replyTo ? { reply_to: replyTo } : {}) }, by));
// Comment threads. A reply names the comment it answers (reply_to); the thread is the comment at the end of that chain,
// its root. An agent answers the id it was handed, which for a person's reply is the reply's own id, so a chain can be
// several links long. At most 50 links and never the same comment twice, so a hand-edited record can't loop.
export function threadRoot(items, id) {
  const byId = new Map(items.filter(x => x && x.kind === 'comment').map(x => [x.id, x]));
  let at = byId.get(id); const been = new Set();
  while (at && at.reply_to && byId.has(at.reply_to) && !been.has(at.id) && been.size < 50) { been.add(at.id); at = byId.get(at.reply_to); }
  return at || null;
}
// Presenters: each agent session presents under its own name, set by board_open {presenter} or the CLI's --presenter,
// never by a page (pages can't write ops). An op without one is Claude's, so older records read as before.
export const presenterName = n => { const s = String(n ?? '').replace(/[<>"`\n\r\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32); return !s || s.toLowerCase() === 'claude' ? 'Claude' : s; };
export const presenterOf = o => presenterName(o && o.presenter);
export const samePresenter = (a, b) => presenterName(a).toLowerCase() === presenterName(b).toLowerCase();
// The team: three Claude subagents on every board, each with a job. The first is the lead: a comment that names no one is
// for it. The person renames them on the board (this computer only); the names live in agents.json.
export const DEFAULT_TEAM = [
  { name: 'Ada', role: 'builder', about: 'draws and changes the board' },
  { name: 'Linus', role: 'critic', about: 'pokes holes and asks what breaks first' },
  { name: 'Grace', role: 'scout', about: 'reads the code and docs so the answers are grounded' },
];
export const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,19}$/u;
const NOT_A_NAME = new Set(['you', 'host', 'everyone', 'anyone', 'claude', 'the team']);
export function team(dir) {
  let list = null;
  try {
    const j = JSON.parse(readSafe(files(dir).agents));
    if (Array.isArray(j.agents) && j.agents.length === DEFAULT_TEAM.length && j.agents.every(a => a && typeof a.name === 'string' && NAME_OK.test(a.name))) list = j.agents.map(a => a.name);
  } catch { /* no file yet: the default names */ }
  return DEFAULT_TEAM.map((a, i) => ({ ...a, name: list ? list[i] : a.name, ...(i === 0 ? { lead: true } : {}) }));
}
// Rename a teammate. A record line tells every page and agent; the old name's words stay under the old name.
export function renameAgent(dir, from, to) {
  const t = team(dir), i = t.findIndex(a => a.name.toLowerCase() === String(from ?? '').toLowerCase());
  if (i < 0) throw new Error(`no teammate ${from}`);
  const name = String(to ?? '').replace(/\s+/g, ' ').trim();
  if (!NAME_OK.test(name)) throw new Error('a name is 1 to 20 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit');
  if (NOT_A_NAME.has(name.toLowerCase()) || presenterName(name) === 'Claude') throw new Error(`"${name}" is taken`);
  if ([...agentsOn(dir).values(), ...t.map(a => a.name)].some(n => n.toLowerCase() === name.toLowerCase() && n.toLowerCase() !== t[i].name.toLowerCase())) throw new Error(`"${name}" is already on the board`);
  const names = t.map((a, k) => (k === i ? name : a.name));
  mkdirSafe(files(dir).live); writeSafe(files(dir).agents, JSON.stringify({ agents: names.map(n => ({ name: n })) }, null, 2) + '\n');
  return append(dir, { kind: 'team', id: nextId('t'), ts: now(), agents: names, renamed: { from: t[i].name, to: name } });
}
// The agents on a board: the team, everyone who has replied or drawn in its record, and Claude.
export function agentsOn(dir) {
  const m = new Map([['claude', 'Claude']]);
  for (const a of team(dir)) m.set(a.name.toLowerCase(), a.name);
  for (const i of thread(dir)) if (i && (i.author === 'claude' || i.kind === 'op') && i.op !== 'answer') { const p = presenterOf(i); m.set(p.toLowerCase(), p); }
  return m;
}
// Does `text` name agent `who` with an @ (not as part of a longer word)?
export function mentions(text, who) {
  const n = `@${presenterName(who).toLowerCase()}`, t = String(text ?? '').toLowerCase();
  for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + 1)) if (!/[\p{L}\p{N}_.]/u.test(t[i - 1] || '') && !/[\p{L}\p{N}_]/u.test(t[i + n.length] || '')) return true;
  return false;
}
// Who a person's comment is for: the agent picked in the page, or the one an @Name at its start names. Only an agent
// in this board's record; anything else (or "everyone") is every agent.
export function addressee(dir, picked, text) {
  const agents = agentsOn(dir);
  if (typeof picked === 'string' && picked.trim() && picked.trim().toLowerCase() !== 'everyone') return agents.get(presenterName(picked).toLowerCase()) || null;
  const t = String(text ?? '').trimStart().toLowerCase();
  const hit = [...agents.values()].filter(a => t.startsWith(`@${a.toLowerCase()}`) && !/[\p{L}\p{N}_]/u.test(t[a.length + 1] || '')).sort((a, b) => b.length - a.length);
  return hit[0] || null;
}
export function withPresenter(o, by) { const p = presenterName(by); return p === 'Claude' ? o : { ...o, presenter: p }; }
// Text the agent put on the board through ops: a note's or arrow's label (keyed by its container) and each edit's text.
// When a page saves the scene back, that text must not read as a person's writing.
export const flat = t => String(t ?? '').replace(BREAKS, ' ').replace(/\s+/g, ' ').slice(0, 200);
// It is the agent's only while the text is still what the agent wrote: a guest rewriting the agent's note is someone writing.
export function claudeWrote(dir) {
  const said = {};
  for (const i of thread(dir)) if (i.kind === 'op') {
    if (i.op === 'note' && i.ref) said[`label:${i.ref}`] = flat(i.text).trim();
    if (i.op === 'arrow' && i.ref && i.label) said[`label:${i.ref}`] = flat(i.label).trim();
    if (i.op === 'edit') said[`label:${i.target}`] = said[`${i.target}__title`] = said[i.target] = flat(i.text).trim();
    // a box's title and small line, the label on its arrow, an area's label: the agent's own words, not someone writing
    if (i.op === 'box' && i.ref) {
      said[`${i.ref}__title`] = flat(i.title).trim();
      if (i.sub) said[`${i.ref}__sub`] = flat(i.sub).trim();
      if (i.label) said[`label:${i.ref}__from`] = flat(i.label).trim();
    }
    if (i.op === 'area' && i.ref) said[`${i.ref}__label`] = flat(i.label).trim();
  }
  return (id, t) => said[id] !== undefined && said[id] === flat(t).trim();
}
// Element ids go in op.ref (note/arrow) or op.target. A new element's id must be one the server takes back from the pages
// (id-shaped, with room for its __label), and its text one it saves, or the note shows on every page and is never kept.
export const op = (dir, o) => {
  if (o.ref != null && !(typeof o.ref === 'string' && ID.test(o.ref) && o.ref.length <= 120)) throw new Error(`ref must be letters, digits, _ - . or : (at most 120), like "note-1" (got ${JSON.stringify(o.ref)})`);
  if (o.text != null && String(o.text).length > 10000) throw new Error('text is at most 10,000 characters');
  if (o.op === 'box') o = boxOp(dir, o);
  else if (o.op === 'area') o = areaOp(dir, o);
  return append(dir, { ...o, kind: 'op', id: nextId('op'), ts: now() });
};

// The agent's drawing: a box in the board's own style, or a labelled area around boxes. Where it goes is worked out here,
// once, from the board as everyone has it (scene.json, plus drawing still on its way to the pages), so every open page
// draws it in the same spot, and an agent that can't see coordinates still puts it next to the box it means. The MCP
// tools and the CLI's `op` both come through op() above, so both get the same checks.
export const BOX = { w: 230, h: 104, gapX: 100, gapY: 126 };
export const DRAW_COLORS = ['blue', 'orange', 'green', 'red', 'violet', 'gray'];
export const SIDES = ['right', 'below', 'left', 'above'];
function boardNow(dir) {
  let els = [];
  try { els = JSON.parse(readSafe(files(dir).scene)).elements || []; } catch { try { const f = seedFile(dir); if (f) els = readBoard(f).elements; } catch { /* no board yet */ } }
  els = els.filter(e => e && typeof e === 'object' && typeof e.id === 'string');
  const known = new Set(els.map(e => e.id)), live = new Map(els.filter(e => !e.isDeleted).map(e => [e.id, e]));
  // Drawing no page has saved yet (a box drawn a second ago is still being inked in): its spot is taken too. Anything the
  // scene already knows, deleted or not, is the scene's to say.
  const gone = new Set(), pending = new Map();
  for (const i of thread(dir)) if (i.kind === 'op') {
    if (i.op === 'delete') gone.add(String(i.target));
    else if (['box', 'area', 'note'].includes(i.op) && typeof i.ref === 'string' && [i.x, i.y].every(Number.isFinite)) pending.set(i.ref, { id: i.ref, type: 'rectangle', x: i.x, y: i.y,
      width: +i.w || (i.op === 'note' ? 260 : BOX.w), height: +i.h || (i.op === 'note' ? 90 : BOX.h), groupIds: i.op === 'box' ? [`${i.ref}__grp`] : [], ...(i.op === 'area' ? { customData: { z: 'under' } } : {}) });
  }
  for (const [id, e] of pending) if (!known.has(id) && !gone.has(id)) live.set(id, e);
  return live;
}
const boundsOf = e => {
  const pts = Array.isArray(e.points) && e.points.length ? e.points.map(p => [e.x + p[0], e.y + p[1]]) : [[e.x, e.y], [e.x + (+e.width || 0), e.y + (+e.height || 0)]];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
// A box on the board is its whole group (the rectangle, its title, its small line), found from any of its parts' ids.
function thingBounds(live, id) {
  const e = live.get(String(id)); if (!e) return null;
  const g = (e.groupIds || [])[0], parts = g ? [...live.values()].filter(x => (x.groupIds || []).includes(g)) : [e];
  const bs = parts.map(boundsOf).filter(b => b.every(Number.isFinite)); if (!bs.length) return null;
  return [Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.max(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3]))];
}
// The first free spot on that side of the anchor, stepping further out while something is there. Lines, labels inside
// shapes, locked backgrounds, the agent's own areas and anything drawn around the anchor never count as in the way.
function place(live, a, w, h) {
  const blocks = [...live.values()].filter(e => !e.containerId && !LINEAR.has(e.type) && e.type !== 'frame' && !e.locked && !(e.customData && e.customData.z === 'under'))
    .map(boundsOf).filter(b => b.every(Number.isFinite));
  const hits = (occ, x, y) => occ.some(r => r[0] < x + w + 20 && r[2] > x - 20 && r[1] < y + h + 20 && r[3] > y - 20);
  if (a.near != null) {
    const b = thingBounds(live, a.near); if (!b) throw new Error(`no box ${a.near} on the board`);
    const occ = blocks.filter(r => !(r[0] <= b[0] && r[1] <= b[1] && r[2] >= b[2] && r[3] >= b[3]));
    let x, y, dx = 0, dy = 0;
    const side = a.side || 'right';
    if (side === 'right') { x = b[2] + BOX.gapX; y = b[1]; dx = w + BOX.gapX; }
    else if (side === 'left') { x = b[0] - BOX.gapX - w; y = b[1]; dx = -(w + BOX.gapX); }
    else if (side === 'below') { x = b[0]; y = b[3] + BOX.gapY; dy = h + BOX.gapY; }
    else { x = b[0]; y = b[1] - BOX.gapY - h; dy = -(h + BOX.gapY); }
    for (let k = 0; k < 40 && hits(occ, x, y); k++) { x += dx; y += dy; }
    return { x: Math.round(x), y: Math.round(y) };
  }
  if (a.x != null) return { x: Math.round(a.x), y: Math.round(a.y) };
  // no anchor: a new row under everything, at the board's left edge
  return blocks.length ? { x: Math.round(Math.min(...blocks.map(r => r[0]))), y: Math.round(Math.max(...blocks.map(r => r[3])) + BOX.gapY) } : { x: 0, y: 0 };
}
const oneText = (v, max, what) => {
  if (v != null && typeof v !== 'string') throw new Error(`${what} is text`);
  const s = String(v ?? '').replace(BREAKS, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new Error(`${what} is at most ${max} characters`);
  return s;
};
function newRef(dir, live, ref, what) {
  if (typeof ref !== 'string') throw new Error(`${what} needs \`ref\`, its new id, like "retry"`);
  if (ref.length > 100) throw new Error('ref is at most 100 characters');
  if (live.has(ref) || thread(dir).some(i => i.kind === 'op' && i.ref === ref)) throw new Error(`${ref} is already on the board (or was): pick a new ref`);
}
const colorOf = c => { if (c != null && !DRAW_COLORS.includes(c)) throw new Error(`color is one of ${DRAW_COLORS.join(', ')}`); return c ? { color: c } : {}; };
const by = o => (o.presenter != null ? { presenter: presenterName(o.presenter) } : {});
function boxOp(dir, o) {
  const live = boardNow(dir); newRef(dir, live, o.ref, 'a box');
  const title = oneText(o.title, 80, 'title'), sub = oneText(o.sub, 120, 'sub'), label = oneText(o.label, 40, 'label');
  if (!title) throw new Error('a box needs a `title`');
  if (o.side != null && !SIDES.includes(o.side)) throw new Error(`side is one of ${SIDES.join(', ')}`);
  if (o.near != null && typeof o.near !== 'string') throw new Error('near is the id of a box on the board');
  if (o.from != null && (typeof o.from !== 'string' || !live.has(o.from))) throw new Error(`no box ${o.from} on the board to draw the arrow from`);
  if ((o.x != null || o.y != null) && !([o.x, o.y].every(v => Number.isFinite(v) && Math.abs(v) < 1e6))) throw new Error('x and y are numbers, together');
  // wide enough for its words (Virgil at 20 px is about 11 px a letter, the small line at 15 px about 8), never over 460
  const w = Math.round(Math.min(460, Math.max(BOX.w, 36 + Math.max([...title].length * 11, [...sub].length * 8)))), h = sub ? BOX.h : 70;
  return { op: 'box', ref: o.ref, title, ...(sub ? { sub } : {}), ...place(live, o, w, h), w, h, ...(o.near != null ? { near: o.near, side: o.side || 'right' } : {}),
    ...(o.from != null ? { from: o.from, ...(label ? { label } : {}) } : {}), ...colorOf(o.color), ...by(o) };
}
function areaOp(dir, o) {
  const live = boardNow(dir); newRef(dir, live, o.ref, 'an area');
  const label = oneText(o.label, 40, 'label'); if (!label) throw new Error('an area needs a `label`, like "v2"');
  const ids = [].concat(o.target ?? []).map(String);
  if (!ids.length || ids.length > 50) throw new Error('target is the ids of the boxes to draw the area around (1 to 50)');
  const bs = ids.map(id => thingBounds(live, id)), miss = ids.filter((id, k) => !bs[k]);
  if (miss.length) throw new Error(`no box ${miss.join(', ')} on the board`);
  // 30 px clear of the boxes, and 28 more at the top for the label
  const x0 = Math.min(...bs.map(b => b[0])) - 30, y0 = Math.min(...bs.map(b => b[1])) - 58, x1 = Math.max(...bs.map(b => b[2])) + 30, y1 = Math.max(...bs.map(b => b[3])) + 30;
  return { op: 'area', ref: o.ref, label, target: ids, x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), ...colorOf(o.color), ...by(o) };
}
// Who wrote it: a name a person typed into the page. "claude" is reserved for the CLI and the MCP tools, so a page can
// never post as the agent.
// A name is folded to its plain letters first (full-width letters, accents, zero-width marks and Cyrillic or Greek
// look-alikes), so "Claude" with a zero-width space or a Cyrillic С can't pass either.
// (UTS #39's full confusables table is thousands of lines; this folds the letters of claude, host and you and the usual
// stand-ins: I, 1 and | for l, 0 for o, Latin small capitals and alpha, Cyrillic, Greek and Cherokee look-alikes.)
const LOOKALIKE = { а: 'a', е: 'e', о: 'o', с: 'c', у: 'y', х: 'x', р: 'p', і: 'i', ӏ: 'l', ԁ: 'd', һ: 'h', н: 'h', ѕ: 's', т: 't', к: 'k', м: 'm',
  α: 'a', ο: 'o', υ: 'u', ε: 'e', ι: 'i', κ: 'k', ν: 'v', τ: 't', ℓ: 'l', ɑ: 'a', ɩ: 'i', ı: 'i', ɪ: 'i', ʟ: 'l', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ʜ: 'h', ᴏ: 'o', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ʏ: 'y', ʋ: 'u',
  ꮯ: 'c', ꮮ: 'l', ꭺ: 'a', ꭰ: 'd', ꭼ: 'e', ꮋ: 'h', ꮪ: 's', ꭲ: 't', ꮃ: 'w' };
export const skeleton = s => String(s).normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').replace(/[I1|ǀ]/g, 'l').replace(/0/g, 'o').toLowerCase().replace(/./gu, c => LOOKALIKE[c] || c).replace(/[^a-z]/g, '');
// A name's letters come from one script, as in UTS #39's "highly restrictive" level: Latin, Cyrillic, Greek or Cherokee
// letters don't mix, so "Ꮯlaude" can't pass. Chinese, Japanese and Korean names keep their usual mixes with Han and Latin.
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana', 'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya',
  'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Khmer', 'Mongolian', 'Ethiopic', 'Cherokee', 'Canadian_Aboriginal',
  'Hangul', 'Hiragana', 'Katakana', 'Bopomofo', 'Han'].map(n => [n, new RegExp(`\\p{Script=${n}}`, 'u')]);
const MIXES = [['Han', 'Hiragana', 'Katakana', 'Latin'], ['Han', 'Hangul', 'Latin'], ['Han', 'Bopomofo', 'Latin']];
export const oneScript = s => {
  const used = new Set([...s].filter(c => /\p{L}/u.test(c) && !/[\p{Script=Common}\p{Script=Inherited}]/u.test(c)).map(c => (SCRIPTS.find(([, re]) => re.test(c)) || ['other'])[0]));
  return used.size <= 1 || MIXES.some(m => [...used].every(x => m.includes(x)));
};
export const nameOf = n => { const s = String(n || '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>"`]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return s && oneScript(s) && skeleton(s) !== 'claude' ? s : null; };
// The person at this computer: a page with no name of its own. Recorded as "you"; everyone else (other pages, the agent's
// events) sees them as "Host". Their own page says "You".
export const HOME = 'you';
export const shown = a => !a || a === HOME ? 'Host' : a.replace(/(^|\s)\S/g, c => c.toUpperCase());
// The author a request writes as. From this computer a nameless page is the host; through the share link it is a guest,
// and anyone there calling themselves You or Host is "you (link)" or "host (link)", so the link can't pass as the host.
const RESERVED = new Set([HOME, 'host']);
export const authorOf = (name, far) => { const a = (nameOf(name) || (far ? 'guest' : HOME)).toLowerCase(); return far && (RESERVED.has(a) || RESERVED.has(skeleton(a))) ? `${a} (link)` : a; };
// Excalidraw's own rule for two copies of one element: the higher version wins, and a tie goes to the lower versionNonce.
export const newer = (a, b) => !b || a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);
const MP = 2;   // what /api/hello reports: `share` refuses to open a tunnel to a server without keys

// The guided tour and the agent's pointer. Ops like the others: a line in thread.jsonl that every open page applies.
// A target is a box id, a list of ids, {area:{x,y,w,h}} or a scene point {x,y}. Step numbers are 1-based, as on the card.
const isTarget = t => typeof t === 'string' ? !!t.trim() : Array.isArray(t) ? t.length > 0 && t.every(x => typeof x === 'string' && x)
  : !!t && typeof t === 'object' && (t.area ? ['x', 'y', 'w', 'h'].every(k => Number.isFinite(t.area[k])) : Number.isFinite(t.x) && Number.isFinite(t.y));
const TARGET = 'a box id, [ids], {area:{x,y,w,h}} or {x,y}';
// The CLI's target: JSON, "x,y" (a scene point), "a,b,c" (ids) or one id.
export const targetOf = s => { s = String(s ?? '').trim(); if (/^[[{]/.test(s)) return JSON.parse(s);
  const xy = s.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/); return xy ? { x: +xy[1], y: +xy[2] } : s.includes(',') ? s.split(',').map(x => x.trim()).filter(Boolean) : s; };
// `by` is the presenter posting it. A step may carry `ask: {question}`: the card then shows ✓ keep / ✎ change.
// While another presenter's tour is live (a move in the last TOUR_HOLD_MIN minutes), posting a new one would yank every
// page out of it, so it throws naming them; `takeOver` is for when the person asked this session to present now.
export const TOUR_HOLD_MIN = 10;
export function tour(dir, t, by, takeOver) {
  let steps = Array.isArray(t) ? t : t && t.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error('a tour needs steps: [{target, title, text, points?, ask?}, …]');
  steps = steps.map((s, i) => {
    if (!s || !isTarget(s.target)) throw new Error(`step ${i + 1}: target must be ${TARGET}`);
    if (!s.title && !s.text) throw new Error(`step ${i + 1}: give it a title or text`);
    if (s.points != null && !Array.isArray(s.points)) throw new Error(`step ${i + 1}: points must be a list of {target, text}`);
    (s.points || []).forEach((p, j) => { if (!p || !isTarget(p.target) || !String(p.text || '').trim()) throw new Error(`step ${i + 1}, point ${j + 1}: needs a target (${TARGET}) and text`); });
    if (s.ask == null) return s;
    const q = String((typeof s.ask === 'string' ? s.ask : s.ask.question) ?? '').replace(/\s+/g, ' ').trim();
    if (!q) throw new Error(`step ${i + 1}: ask needs a question, {question: "…"}`);
    return { ...s, ask: { question: q.slice(0, 300) } };
  });
  if (!Array.isArray(t) && t.tour_id != null && !(typeof t.tour_id === 'string' && ID.test(t.tour_id))) throw new Error(`tour_id must be letters, digits, _ - . or : (got ${JSON.stringify(t.tour_id)})`);
  const me = presenterName(by), held = heldBy(dir, me);
  if (held && !takeOver) throw new Error(`${held.who} is presenting "${held.title}" (last move ${held.ago} min ago). Wait until they finish: the board frees up after ${TOUR_HOLD_MIN} min with no move. If the person asked you to present now, pass take_over: true.`);
  return op(dir, withPresenter({ op: 'tour', tour_id: (!Array.isArray(t) && t.tour_id) || nextId('t'), title: String((!Array.isArray(t) && t.title) || 'Tour').slice(0, 120), steps }, me));
}
// The latest tour in the record (or the one named). A tour posted through the raw `op` CLI has no tour_id: pages key it by its op id.
export const lastTour = (dir, id) => thread(dir).filter(i => i.kind === 'op' && i.op === 'tour' && (!id || (i.tour_id || i.id) === id)).at(-1) || null;
// Someone else's live tour: the latest tour is theirs and they moved it (posted it or drove a step) in the hold window.
function heldBy(dir, me) {
  const items = thread(dir), t = items.filter(i => i.kind === 'op' && i.op === 'tour').at(-1);
  if (!t || samePresenter(presenterOf(t), me)) return null;
  const id = t.tour_id || t.id, last = items.filter(i => i.kind === 'op' && (i === t || (i.op === 'tour_step' && i.tour_id === id))).at(-1);
  const ago = (Date.now() - Date.parse(last.ts)) / 60000;
  return ago < TOUR_HOLD_MIN ? { who: presenterOf(t), title: t.title, ago: Math.max(0, Math.round(ago)) } : null;
}
export function tourStep(dir, index, id, by) {
  const t = lastTour(dir, id);
  if (!t) throw new Error(id ? `no tour ${id} in the record` : 'no tour in the record yet: post one with `tour` first');
  // Only the presenter who posted a tour drives it. Two sessions moving one tour would fight over every page.
  if (!samePresenter(presenterOf(t), by)) throw new Error(`${presenterOf(t)} is presenting "${t.title}": only they can move it. Post your own tour once theirs is over.`);
  const i = Number(index), n = (t.steps || []).length;
  if (!Number.isInteger(i) || i < 1 || i > n) throw new Error(`index must be 1…${n} (1-based, the number on the card)`);
  return op(dir, withPresenter({ op: 'tour_step', tour_id: t.tour_id || t.id, index: i }, by));
}
export function point(dir, target, text, by) {
  if (!isTarget(target)) throw new Error(`point: target must be ${TARGET}`);
  return op(dir, withPresenter({ op: 'point', target, text: String(text ?? '').slice(0, 400) }, by));
}
// A ✓ keep / ✎ change on a step that asks. The page sends only which tour, which step, the pick and the person's words;
// the question, the presenter and the step's boxes come from the tour op in the record, never from the request.
export function answer(dir, a, author, via) {
  const t = a && a.tour_id ? lastTour(dir, String(a.tour_id)) : null;
  if (!t) throw new Error('no such tour');
  const i = Number(a.step), n = (t.steps || []).length, s = Number.isInteger(i) && i >= 1 ? t.steps[i - 1] : null;
  if (!s || !s.ask) throw new Error(`step ${a.step} doesn't ask anything`);
  if (!['keep', 'change'].includes(a.pick)) throw new Error('pick is keep or change');
  const text = oneLine(a.text).slice(0, 400);
  if (a.pick === 'change' && !text) throw new Error('say what to change');
  const tg = s.target, ids = typeof tg === 'string' ? [tg] : Array.isArray(tg) ? tg : [];
  const label = `step ${i}/${n} · ${String(s.title || s.text || '').replace(/\s+/g, ' ')}`.slice(0, 80);
  const on = { id: ids[0] || null, ids, label, tour: t.tour_id || t.id, step: i, ...(tg && tg.area ? { rect: tg.area } : {}) };
  return op(dir, { op: 'answer', tour_id: t.tour_id || t.id, step: i, pick: a.pick, text, question: s.ask.question,
    presenter: presenterOf(t), author, ...(via ? { via } : {}), on });
}
// The events.log line for an answer. It starts with COMMENT on purpose: a watcher that greps events.log for COMMENT wakes
// on it, as it does on a comment.
export const answerLine = (it, far) => `COMMENT by ${oneLine(shown(it.author))}${far ? ' via link' : ''} [answer to ${oneLine(it.on.label)}]: ${it.pick === 'keep' ? `✓ keep${it.text ? ` · ${oneLine(it.text)}` : ''}` : `✎ change → ${oneLine(it.text)}`}\n`;
// Where people are in the tour: the last TOUR line in events.log (the page reports it; see /api/tour below).
export const tourWhere = dir => { try { return readSafe(files(dir).events).split('\n').filter(l => l.startsWith('TOUR: ')).at(-1) || null; } catch { return null; } };
// A TOUR line must never wake a watcher, which matches COMMENT, BOARD or EDIT anywhere in a line.
// In any case ("comment" too): a watcher may grep without -i or with it. The word is split by a middle dot.
export const quiet = s => oneLine(s).slice(0, 80).replace(/comment|board|edit/gi, w => `${w[0]}·${w.slice(1).toLowerCase()}`);

// The board's starting point: the .excalidraw file given, else the only one in the folder.
export function seedFile(dir, seed) {
  if (seed) { const f = path.resolve(dir, seed); if (!fs.existsSync(f)) throw new Error(`no file ${f}`); return f; }
  const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.excalidraw')).sort() : [];
  if (all.length > 1) throw new Error(`${dir} holds ${all.length} .excalidraw files (${all.join(', ')}): pass --seed <file>`);
  return all.length ? path.join(dir, all[0]) : null;
}
export function readBoard(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j || !Array.isArray(j.elements)) throw new Error(`${file} is not an .excalidraw file: it has no elements`);
  return j;
}
// A folder this CLI can write a record into: it already has a call, or a board to start one from.
export const isBoard = dir => fs.existsSync(files(dir).live) || fs.readdirSync(dir).some(f => f.endsWith('.excalidraw'));

// Start a board's server, or find it already running: what `open` and board_open both do. The server runs detached, so
// the board outlives the command or the agent session; `stop` ends it. A server is this board's when its /api/hello
// names this folder (it tells only this computer). With `pick`, the first port from 4900 to 4919 that is free or
// already this board's.
const helloAt = port => fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null);
const portTaken = port => new Promise(done => { const c = net.createConnection({ port, host: '127.0.0.1' }, () => { c.destroy(); done(true); }); c.on('error', () => done(false)); });
export async function startBoard({ dir, seed, port = DEFAULT_PORT, pick = false }) {
  const real = fs.realpathSync(dir), ports = pick ? Array.from({ length: 20 }, (_, i) => DEFAULT_PORT + i) : [port];
  for (const p of ports) {
    const h = await helloAt(p), url = `http://localhost:${p}/`;
    if (h && h.dir && fs.realpathSync(h.dir) === real) return { url, port: p, started: false };
    if (h || await portTaken(p)) { if (pick) continue; throw new Error(`port ${p} already serves ${h ? 'a different board' : 'something else'}; pass another port`); }
    makeCall(dir);
    const log = openSafe(path.join(files(dir).live, 'server.log'));
    spawn(process.execPath, [BIN, 'serve', '--dir', dir, '--port', String(p), ...(seed ? ['--seed', seed] : [])], { cwd: dir, detached: true, stdio: ['ignore', log, log] }).unref();
    for (let i = 0; i < 40; i++) { const x = await helloAt(p); if (x && x.dir && fs.realpathSync(x.dir) === real) return { url, port: p, started: true }; await new Promise(r => setTimeout(r, 150)); }
    throw new Error(`the board server did not start on ${p}; see ${path.join(files(dir).live, 'server.log')}`);
  }
  throw new Error(`ports ${DEFAULT_PORT}–${DEFAULT_PORT + 19} are all taken: pass --port`);
}
// Stop this board's server: the process in server.json, once its port answers for this folder (a pid alone could be
// another program's by now).
export async function stopBoard({ dir }) {
  let s; try { s = JSON.parse(readSafe(files(dir).server)); } catch { return { stopped: false, why: 'no server is running for this board' }; }
  const h = await helloAt(s.port);
  if (!(h && h.dir && fs.realpathSync(h.dir) === fs.realpathSync(dir))) { try { fs.unlinkSync(files(dir).server); } catch {} return { stopped: false, why: 'its server had already stopped' }; }
  process.kill(s.pid, 'SIGTERM');
  for (let i = 0; i < 40 && await helloAt(s.port); i++) await new Promise(r => setTimeout(r, 100));
  return { stopped: true, port: s.port };
}

// Pictures from an .excalidraw file's `files` (a board's Export carries the tab's pictures) into the call's files/: each one an
// element on the board uses and the server lacks.
// No SVG: it can carry script, which runs if someone opens the file itself.
const PIC_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function savePictures(dir, list, used) {
  const pics = path.join(files(dir).live, 'files'), saved = fs.existsSync(pics) ? fs.readdirSync(pics).map(f => f.replace(/\.\w+$/, '')) : [];
  const took = [];
  for (const f of Object.values(list || {})) {
    const m = String(f && f.dataURL || '').match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (!m || !PIC_TYPES[m[1]] || !used.has(f.id) || saved.includes(f.id) || !/^[\w-]{1,128}$/.test(f.id)) continue;
    mkdirSafe(pics); writeSafe(path.join(pics, `${f.id}.${PIC_TYPES[m[1]]}`), Buffer.from(m[2], 'base64')); took.push(`${CALL}/files/${f.id}.${PIC_TYPES[m[1]]}`);
  }
  return took;
}
export function importFiles(dir, file) {
  const used = new Set(JSON.parse(readSafe(files(dir).scene)).elements.filter(e => e.type === 'image' && !e.isDeleted).map(e => e.fileId));
  return { took: savePictures(dir, readBoard(file).files, used) };
}

// The board's record as Markdown: every comment word for word, in order, the reply to each, and the pictures it was
// left on, straight from thread.jsonl.
// Only this code writes the record's structure: the headings and the time, author and reply lines. A comment's or a
// reply's text goes in as a quote, every line of it, with HTML escaped and a leading # escaped, so a commenter's
// "## 7. …" or "**Host:** Approved" stays inside their own quote and can't read as an entry or a reply.
// Every Markdown mark in someone's words is escaped too: a "[docs]: https://…" line in a guest's comment is a link
// definition for the whole document (CommonMark collects them from inside quotes), so it rewrote the owner's [docs] link
// elsewhere in the record, and "![x](…)" showed a remote image to whoever read it.
const mdText = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\](){}#|!~+]/g, '\\$&');
const mdName = s => mdText(oneLine(s));
const quoted = t => String(t ?? '').split(/\r\n|\r|\n|\u2028|\u2029/).map(l => `> ${mdText(l)}`).join('\n');
export function record(dir) {
  const { scene: SF, live: LV } = files(dir), PICS = path.join(LV, 'files');
  const items = thread(dir).filter(x => x.kind === 'comment');
  const els = fs.existsSync(SF) ? JSON.parse(readSafe(SF)).elements : [];
  const saved = fs.existsSync(PICS) ? fs.readdirSync(PICS) : [];
  const pics = c => [c.on && c.on.id, ...((c.on && c.on.ids) || [])].filter(Boolean)
    .map(id => els.find(e => e.id === id && e.type === 'image' && !e.isDeleted)).filter(Boolean)
    .map(e => { const f = saved.find(n => n.startsWith(e.fileId + '.')); return f ? `![picture](${CALL}/files/${f})` : null; }).filter(Boolean);
  const out = ['# The board\'s record', '', `> Every comment on this board, word for word, from \`${CALL}/thread.jsonl\`. ${items.length} comments.`, ''];
  // Each reply goes under the comment it answers (reply_to). An older reply without one goes under the latest comment on
  // the same box before it, and nowhere else: pairing by box put the agent's answer to the owner under a guest's question.
  const replies = new Map();
  items.forEach((x, i) => {
    if (x.author !== 'claude') return;
    const to = x.reply_to ? items.find(c => c.id === x.reply_to && c.author !== 'claude')
      : items.slice(0, i).reverse().find(c => c.author !== 'claude' && x.on && JSON.stringify(c.on) === JSON.stringify(x.on));
    if (to) { if (!replies.has(to.id)) replies.set(to.id, []); replies.get(to.id).push(x); }
  });
  let n = 0;
  items.forEach(c => {
    if (c.author === 'claude') return;
    out.push(`## ${++n}. ${mdName((c.on && c.on.label) || 'the whole board')}`, '', `*${mdName(c.ts)} · ${mdName(shown(c.author))}*`, '', ...pics(c).flatMap(p => [p, '']),
      `**${mdName(shown(c.author))}:**`, '', quoted(c.text), '');
    for (const reply of replies.get(c.id) || []) out.push(`**${mdName(presenterOf(reply))} replied:**`, '', quoted(reply.text), '');
  });
  return out.join('\n') + '\n';
}

// The board server. Only this computer can reach it (it listens on 127.0.0.1); `share` opens it to teammates.
export function serve({ dir, port = DEFAULT_PORT, seed } = {}) {
  const DIR = path.resolve(dir || '.');
  const { live: LIVE, thread: THREAD, events: EVENTS, scene: SCENE, share: SHARE, canvas: CANVAS } = files(DIR);
  makeCall(DIR);   // throws, before anything is read or written, on a call folder holding a link
  // Pasted pictures, one image file per Excalidraw fileId (see /api/files).
  // No SVG (it can carry script); at most 200 pictures and 200 MB per board, 5 MB each.
  const PICS = path.join(LIVE, 'files'), PIC_EXT = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' }, PIC_MAX = 5e6, PICS_MAX = 200, PICS_BYTES = 200e6;
  const picsNow = () => { try { const l = fs.readdirSync(PICS); return { n: l.length, bytes: l.reduce((t, f) => t + fs.statSync(path.join(PICS, f)).size, 0) }; } catch { return { n: 0, bytes: 0 }; } };
  const picOf = id => { if (!/^[\w-]{1,128}$/.test(id || '') || isLink(PICS)) return null; for (const x of Object.values(PIC_EXT)) { const p = path.join(PICS, `${id}.${x}`); try { const st = fs.lstatSync(p); if (st.isFile() && st.nlink === 1) return p; } catch { /* not this type */ } } return null; };
  // The scene everyone shares, including deleted elements (a delete is a newer version of the element, not its absence).
  const els = new Map(), by = new Map();   // id → element; id → [author, came through the link] of whoever last changed it
  // The scene's size: at most 5,000 elements (deleted ones too) and 20 MB. When it's full, the oldest deleted elements make
  // room; past that, new elements aren't taken.
  // The share link gets half of each (elements last changed through it, and their bytes), so a guest who fills the board
  // still leaves this computer room to draw.
  const SCENE_MAX = 5000, SCENE_BYTES = 20e6, LINK_MAX = SCENE_MAX / 2, LINK_BYTES = SCENE_BYTES / 2, sizes = new Map(), linkSide = new Set();
  let sceneBytes = 0, linkBytes = 0;
  // The link's hatched fills together: at most 200 at the largest size (2,000 × 2,000); past that its new ones are solid.
  const HATCH_AREA = 200 * HATCH_MAX * HATCH_MAX, hatchArea = new Map();
  let hatchSum = 0;
  const hatchOf = (e, far) => { if (!far || !HATCH.has(e.fillStyle)) return 0; const [w, h] = extent(e); return w * h; };
  // The link's very large shapes (over 1,000 wide or tall; a line by its points): at most 200, and past that its new ones
  // aren't taken. Shapes drawn on this computer aren't counted. Many of the largest shapes slowed every new tab, solid or
  // not: 1,000 boxes 100,000 wide took 22 s to load; with the cap, 200. Shapes under the line aren't counted, so a guest
  // can still make a new tab slow: 2,500 cross-hatched boxes 999 wide took 16.9 s, and 200 boxes 100,000 wide with 2,300
  // at 999 took 59.9 s (measured in the final review). That is left as it is: the link already lets a guest delete the
  // whole board (README, Known limits).
  const BIG = 1000, BIG_MAX = 200, bigLink = new Set();
  const isBig = e => !e.isDeleted && extent(e).some(v => v > BIG);
  const put = (e, size, far = false) => {
    const old = sizes.get(e.id) || 0, a = hatchOf(e, far);
    hatchSum += a - (hatchArea.get(e.id) || 0); if (a) hatchArea.set(e.id, a); else hatchArea.delete(e.id);
    if (far && isBig(e)) bigLink.add(e.id); else bigLink.delete(e.id);
    sceneBytes += size - old;
    if (linkSide.has(e.id)) linkBytes -= old;
    if (far) { linkSide.add(e.id); linkBytes += size; } else linkSide.delete(e.id);
    sizes.set(e.id, size); els.set(e.id, e);
  };
  const drop = id => { const sz = sizes.get(id) || 0; sceneBytes -= sz; hatchSum -= hatchArea.get(id) || 0; hatchArea.delete(id); bigLink.delete(id); if (linkSide.delete(id)) linkBytes -= sz; sizes.delete(id); els.delete(id); };
  // Room for one element of a post. The oldest deleted elements make room, listed once per post (listing them for every
  // element of a 100,000-element post on a full board held the server for seconds).
  const roomFor = () => {
    let evict = null, at = 0;
    return (id, size, far) => {
      const isNew = !els.has(id), old = sizes.get(id) || 0, mine = linkSide.has(id);
      if (far && ((!mine && linkSide.size >= LINK_MAX) || linkBytes - (mine ? old : 0) + size > LINK_BYTES)) return false;
      const fits = () => (!isNew || els.size < SCENE_MAX) && sceneBytes - old + size <= SCENE_BYTES;
      if (fits()) return true;
      if (!evict) evict = [...els.values()].filter(e => e.isDeleted).sort((a, b) => (a.updated || 0) - (b.updated || 0)).map(e => e.id);
      while (at < evict.length) { const d = evict[at++]; if (d !== id && els.has(d)) { drop(d); if (fits()) return true; } }
      return false;
    };
  };
  let cleaned = 0;   // elements load() changed (a fill made solid, a link dropped): scene.json is written back
  const load = e => { if (!loadable(e)) return false; const c = cleanElement(e); if (JSON.stringify(c) !== JSON.stringify(e)) cleaned++; put(c, JSON.stringify(c).length); return true; };
  let start = null;
  try { start = seedFile(DIR, seed); } catch (e) { if (!fs.existsSync(SCENE)) throw e; }   // a call already under way doesn't need its seed
  if (fs.existsSync(SCENE)) {
    // An element that could crash the server or lock itself (saved before these checks) is left behind, with a note.
    const all = JSON.parse(readSafe(SCENE)).elements || [], kept = all.filter(load).length;
    if (kept < all.length || cleaned) { console.error(`left out ${all.length - kept} broken element(s) and cleaned ${cleaned} from ${SCENE}`); writeSafe(SCENE, JSON.stringify({ elements: [...els.values()] })); }
  } else if (start) {
    // A new call starts from the .excalidraw file as it is, its pictures included.
    const b = readBoard(start);
    b.elements.forEach(load);
    savePictures(DIR, b.files, new Set(b.elements.filter(e => e && e.type === 'image' && !e.isDeleted).map(e => e.fileId)));
    writeSafe(SCENE, JSON.stringify({ elements: [...els.values()] }));
    writeSafe(files(DIR).board, JSON.stringify({ file: path.basename(start), started: now() }));   // one call per folder: `open` checks it
  }
  // The page, with this board's name and storage key in it (a hash of the folder, so two boards never share a browser's
  // copy). JSON with < escaped, so a file name can't close the script.
  const BOARD = { key: crypto.createHash('sha1').update(fs.realpathSync(DIR)).digest('hex').slice(0, 12),
    name: start ? path.basename(start, '.excalidraw') : path.basename(DIR), app: NAME };
  // The write keys, new each run. A page gets one in its HTML, and sends it with every write; another website can't read
  // the page (no CORS), so it can't send it. A page that came through the share link gets a different key from a page on
  // this computer, so one can't stand in for the other.
  const KEYS = { home: crypto.randomBytes(18).toString('base64url'), link: crypto.randomBytes(18).toString('base64url') };
  // Each page served gets its own page id and a secret that goes with it, issued here and never sent to anyone else. The
  // id is how the room knows a page (other pages see it); the secret is what lets a call act as that page, so a guest who
  // learns the owner's page id from the room still can't post, point, leave or rename as it. Each side keeps its own 500
  // (the least recently heard from go first, and never one heard from in the last minute), so page loads through the link
  // can only push out link pages. The link gets at most 20 new pages a minute per guest and 60 for all of them, so one
  // guest can't keep teammates out. A page the server forgot asks to be reloaded.
  const pages = { home: new Map(), link: new Map() }, minted = new Map();   // page id → {secret, seen}; guest → when it minted pages
  const recent = key => { const t = Date.now(), list = (minted.get(key) || []).filter(x => t - x < 60000); minted.set(key, list); if (minted.size > 5000) minted.delete(minted.keys().next().value); return list; };
  const issue = (far, guest) => {
    const side = far ? pages.link : pages.home, t = Date.now(), mine = far && recent(`g:${guest}`), all = far && recent('*');
    if (far && (mine.length >= 20 || all.length >= 60)) return null;
    if (side.size >= 500) { const [oldest, p] = side.entries().next().value; if (t - p.seen < 60000) return null; side.delete(oldest); }
    if (far) { mine.push(t); all.push(t); }
    const c = crypto.randomBytes(9).toString('base64url'), secret = crypto.randomBytes(18).toString('base64url');
    side.set(c, { secret, seen: t });
    return { page: c, pageKey: secret };
  };
  const pageOk = (req, c, far) => {
    const side = far ? pages.link : pages.home, p = typeof c === 'string' && side.get(c);
    if (!p || !same(req.headers['x-agents-on-whiteboard-page'] || '', p.secret)) return false;
    side.delete(c); side.set(c, { secret: p.secret, seen: Date.now() }); return true;   // most recently heard from
  };
  const page = (far, ids) => fs.readFileSync(PAGE, 'utf8').replace('"__AGENTS_ON_WHITEBOARD_BOARD__"', () => JSON.stringify({ ...BOARD, token: far ? KEYS.link : KEYS.home, ...ids }).replace(/</g, '\\u003c'));
  // Element ids a page may send: id-shaped ones, or an odd one the board's own file already has.
  const known = id => ID.test(id) || els.has(id);
  // A label bound to a box or arrow can get a fresh random id when a browser rebuilds it, so key it by its container:
  // otherwise every new tab reported the arrow labels as text someone "wrote".
  const textsOf = list => Object.fromEntries(list.filter(e => e.type === 'text' && !e.isDeleted).map(e => [e.containerId ? `label:${e.containerId}` : e.id, [e.originalText ?? e.text, e.id]]));
  let lastTexts = els.size ? textsOf([...els.values()]) : null;
  // A request body, at most `cap` bytes (1 MB; a scene 10 MB; pictures 30 MB). Past the cap the rest is read and thrown
  // away, and the request gets 413. A body must be one JSON object.
  const fail = (status, m) => Object.assign(new Error(m), { status });
  // A link guest pays for the bytes as they arrive (a chunked upload has no length to charge in advance): past its budget
  // the rest is thrown away too, and the request gets 429.
  // A body whose declared length is already past the cap is refused before a byte of it is read or paid for.
  const body = (req, cap = 1e6) => new Promise((r, x) => {
    let b = '', n = 0;
    const stop = e => { req.off('data', take); req.resume(); x(e); };
    const take = c => { n += c.length; if (n > cap) stop(fail(413, `too big: at most ${cap / 1e6} MB`)); else if (req.guest && !spend(req.guest, c.length)) stop(fail(429, 'too much at once through the link: wait a moment')); else b += c; };
    if (+req.headers['content-length'] > cap) return stop(fail(413, `too big: at most ${cap / 1e6} MB`));
    req.on('data', take); req.on('end', () => r(b)); req.on('error', x);
  });
  // Nested more than 64 deep is refused before parsing: one value nested 200,000 deep parsed fine and then broke every save
  // and every answer that had to send it.
  const tooDeep = (t, max = 64) => { let d = 0, inStr = false, esc = false;
    for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i);
      if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; }
      else if (c === 34) inStr = true; else if (c === 123 || c === 91) { if (++d > max) return true; } else if (c === 125 || c === 93) d--; }
    return false; };
  const json = async (req, cap) => { let o; try { const t = await body(req, cap) || 'null'; if (tooDeep(t)) throw fail(400, 'nested too deep'); o = JSON.parse(t); } catch (e) { throw e.status ? e : fail(400, 'not JSON'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw fail(400, 'send one JSON object'); return o; };
  // Every answer: never inside another website's frame (clickjacking), no referrer (the first request carries ?k=).
  // The body is built before the headers go out, so one that can't be built is a 500, never headers and then a hang.
  const heads = (type, head) => ({ 'content-type': type, 'cache-control': 'no-store', 'x-board-live': MP,
    'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...head });
  const send = (res, code, data, type = 'application/json', head = {}) => {
    let out; try { out = typeof data === 'string' ? data : JSON.stringify(data); } catch (e) { code = 500; type = 'application/json'; out = JSON.stringify({ error: `could not answer: ${e.message}` }); }
    res.writeHead(code, heads(type, head));
    res.end(out); };
  // A timer's work never takes the server down: one bad element used to, 2.5 s after it arrived.
  const safe = (what, fn) => (...a) => { try { return fn(...a); } catch (e) { console.error(`ERROR in ${what}: ${e.message}`); } };
  const pageId = c => typeof c === 'string' && /^[\w-]{1,64}$/.test(c);
  // The record stops taking comments and answers from pages at 10 MB (the agent's own lines still go in), and from the
  // share link at half that, so a guest can't fill it and lock this computer out.
  const recordFull = () => { try { return fs.statSync(THREAD).size >= 10e6; } catch { return false; } };
  let linkRecordBytes = 0;
  try { for (const l of readSafe(THREAD).split('\n')) if (l.includes('"via":"link"')) try { if (JSON.parse(l).via === 'link') linkRecordBytes += Buffer.byteLength(l) + 1; } catch {} } catch {}
  const linkFull = far => far && linkRecordBytes >= 5e6;
  // Through the link, each guest (guestKey: their address, an IPv6 one by its /64) has a budget under one all guests share,
  // and going past it gets 429 while other guests and this computer go on.
  // - Writes: each guest 8 MB at once, refilled at 2 MB a second (a 5 MB picture fits when the guest has been idle), and
  //   all together 16 MB at 6 MB a second. Charged as the bytes arrive.
  // - Reads: each guest 24 MB at once, refilled at 8 MB a second, and all together 48 MB at 16 MB a second. An answer is
  //   charged before it is built, from sizes already known; one bigger than what is left still goes out while the guest
  //   has any left (a 20 MB board has to load), and the guest waits it off. Guests fetching every picture or the whole
  //   record pushed this computer's own requests past 1 s.
  const refill = (b, size, rate) => { const t = Date.now(); b.tokens = Math.min(size, b.tokens + (t - b.at) * rate / 1000); b.at = t; return b; };
  const budget = (size, rate, allSize, allRate, owe) => {
    const each = new Map(), all = { tokens: allSize, at: Date.now() };
    return (guest, n) => {
      let g = each.get(guest); if (!g) { g = { tokens: size, at: Date.now() }; each.set(guest, g); if (each.size > 5000) each.delete(each.keys().next().value); }
      refill(g, size, rate); refill(all, allSize, allRate);
      if (owe ? g.tokens <= 0 || all.tokens <= 0 : n > g.tokens || n > all.tokens) return false;
      g.tokens -= n; all.tokens -= n; return true;
    };
  };
  const spend = budget(8e6, 2e6, 16e6, 6e6, false), spendRead = budget(24e6, 8e6, 48e6, 16e6, true);
  const SLOW = { connection: 'close', 'retry-after': '2' };
  const readOk = (req, res, n) => { if (!req.guest || spendRead(req.guest, n)) return true; send(res, 429, { error: 'too much at once through the link: wait a moment' }, 'application/json', SLOW); return false; };
  const appended = (item, far) => { if (far) linkRecordBytes += Buffer.byteLength(JSON.stringify(item)) + 1; return item; };

  // Who is in the room and what changed. Every page long-polls /api/changes: the poll returns at once when something it
  // hasn't seen is waiting, else it waits up to 25 s. (A Cloudflare quick tunnel delivers the headers of server-sent
  // events and never their data, so it's a long poll.) Cursors live only in this log, never in the record.
  const clients = new Map();   // page id → { name, seen }
  const log = [], waiting = new Set();
  let seq = 0, flushTimer = null;
  const pending = (c, since) => log.filter(e => e.seq > since && e.from !== c).map(({ event, data }) => ({ event, data }));
  const roster = c => [...clients].filter(([id]) => id !== c).map(([id, v]) => ({ event: 'join', data: { id, name: v.name } }));
  // Answer the waiting polls 30 ms after a change, so a burst (a drag, a cursor sweep) goes out as one reply.
  const wake = () => { if (!flushTimer) flushTimer = setTimeout(safe('wake', () => { flushTimer = null; for (const w of [...waiting]) { const evs = pending(w.c, w.since); if (evs.length) w.reply(evs); } }), 30); };
  // The log keeps at most 3,000 events and 25 MB: a page further behind than that starts again from the scene.
  let logBytes = 0;
  const broadcast = (event, data, from, bytes = JSON.stringify(data).length) => {
    log.push({ seq: ++seq, from, event, data, bytes }); logBytes += bytes;
    while (log.length > 1 && (log.length > 3000 || logBytes > 25e6)) logBytes -= log.shift().bytes;
    wake(); };
  const touch = (c, name) => { const had = clients.has(c); clients.set(c, { name, seen: Date.now() }); if (!had) broadcast('join', { id: c, name }, c); };
  const leave = c => { if (clients.delete(c)) broadcast('leave', { id: c }, c); };
  setInterval(safe('room', () => { for (const [c, v] of clients) if (Date.now() - v.seen > 40000) leave(c); }), 10000).unref();   // closed without saying so
  // An op the CLI or the MCP tools append to thread.jsonl nudges the room, so pages fetch it now, not on their next
  // 1.5 s poll: a tour step or a pointer move lands on every page together.
  fs.watchFile(THREAD, { interval: 150 }, safe('thread watch', (cur, prev) => { if (cur.size !== prev.size) broadcast('thread', {}, null); }));
  // Where people are in a guided tour: one quiet line per page in events.log, 1.2 s after their last click. Never in the
  // thread, and quiet() keeps COMMENT, BOARD and EDIT out of it, so a watcher doesn't wake on a step change.
  const tourAt = new Map();

  let saveTimer = null, diffTimer = null;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(safe('save', () => writeSafe(SCENE, JSON.stringify({ elements: [...els.values()] }))), 300); };
  // Text people write reaches events.log once they pause (2.5 s), so a word typed live is one line, not one per key.
  // (Never more than 10 s late: someone posting without a pause doesn't put everyone's lines off for good.)
  let diffFirst = 0;
  const diffSoon = () => { const t = Date.now(); if (!diffTimer) diffFirst = t; clearTimeout(diffTimer); diffTimer = setTimeout(() => { diffTimer = null; safe('text check', diffTexts)(); }, t - diffFirst > 7500 ? 0 : 2500); };
  function diffTexts() {
    const texts = textsOf([...els.values()]);
    // The first seed of a server that had no board is nobody writing: stay quiet. After that, every new text is someone's.
    if (!lastTexts) { lastTexts = texts; return; }
    const byAgent = claudeWrote(DIR), changes = new Map();   // who → their changes since the last check
    for (const [key, [t, id]] of Object.entries(texts)) {
      if (byAgent(key, t)) continue;
      const [a, far] = by.get(id) || [HOME, false];
      const change = !(key in lastTexts) && t.trim() ? 'wrote' : key in lastTexts && lastTexts[key][0] !== t ? 'changed' : null;
      if (!change) continue;
      const g = far ? 'link' : `home:${a}`;   // everyone on the link together: a guest can post under any name
      if (!changes.has(g)) changes.set(g, []);
      changes.get(g).push({ a, far, key, id, t, change });
    }
    lastTexts = texts;
    // Up to three changes from one person (or from the link) are three lines; more become one line with the count and the
    // last change, so ten thousand edits through the link reach the agent as one message per check, not ten thousand.
    for (const list of changes.values()) {
      const one = ({ a, far, key, id, t, change }) => {
        const who = shown(a) + (far ? ' via link' : '');
        appendSafe(EVENTS, change === 'wrote' ? `BOARD: ${oneLine(who)} wrote "${flat(t)}" (${oneLine(key)})\n` : `BOARD: ${oneLine(who)} changed ${oneLine(key)} to "${flat(t)}"\n`);
        appendSafe(CANVAS, JSON.stringify({ id: nextId('b'), ts: now(), author: a, ...(far ? { via: 'link' } : {}), key, el: id, text: flat(t), change }) + '\n');
      };
      if (list.length <= 3) { list.forEach(one); continue; }
      const last = list.at(-1), names = [...new Set(list.map(x => shown(x.a)))], who = `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}${last.far ? ' via link' : ''}`;
      appendSafe(EVENTS, `BOARD: ${oneLine(who)} changed ${list.length} texts, the last ${oneLine(last.key)} to "${flat(last.t)}"\n`);
      appendSafe(CANVAS, JSON.stringify({ id: nextId('b'), ts: now(), author: last.a, ...(last.far ? { via: 'link' } : {}), key: last.key, el: last.id, text: flat(last.t), change: 'many', count: list.length, who }) + '\n');
    }
  }

  // The door. This computer (Host: localhost) walks in. Anyone else arrives through `share`'s tunnel, so their Host is the
  // tunnel's name (and Cloudflare adds cf-connecting-ip): they need the key from share.json, which exists only while
  // `share` runs. The link carries it once as ?k=; the page then keeps it as a cookie and drops it from the address bar.
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const remote = req => !LOCAL.test(req.headers.host || '') || !!req.headers['cf-connecting-ip'] || !!req.headers['x-forwarded-for'];
  const openShare = () => { try { const s = JSON.parse(readSafe(SHARE)); process.kill(s.pid, 0); return s; } catch { return null; } };
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  // A write's Origin, when a browser sends one, is the board's own: the Host it asked for, or (through the link) the
  // tunnel's address in share.json, in case the tunnel hands the server its own Host. "null" (a sandboxed frame, a file)
  // is never the board. No Origin at all is a script on this computer, and it still needs the key.
  const ownOrigin = (req, far) => {
    const o = req.headers.origin; if (o === undefined) return true;
    try { const u = new URL(o); if (!['http:', 'https:'].includes(u.protocol)) return false; if (u.host === req.headers.host) return true;
      const s = far && openShare(); return !!(s && s.url && new URL(s.url).host === u.host); } catch { return false; }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x'), far = remote(req);
      req.guest = far ? guestKey(req.headers['cf-connecting-ip']) : null;   // who pays for a link request
      let head = {};
      if (far) {
        const s = openShare(), k = url.searchParams.get('k') || ((req.headers.cookie || '').match(/(?:^|;\s*)bk=([^;]+)/) || [])[1];
        if (!s || !k || !same(k, s.key)) return send(res, 403, 'This board link is closed, or it is missing its key. Ask for a fresh link.', 'text/plain; charset=utf-8');
        if (url.searchParams.get('k')) head = { 'set-cookie': `bk=${k}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` };
      }
      // Every write, and the room's long poll (it puts a name in the room), needs the board's own page: its Origin, its key,
      // and JSON. A website can send a simple text/plain POST to 127.0.0.1 without asking first; this is what stops it.
      if (req.method !== 'GET' || url.pathname === '/api/changes') {
        if (!ownOrigin(req, far)) return send(res, 403, { error: 'not from this board\'s page' });
        if (!same(req.headers['x-agents-on-whiteboard-key'] || '', far ? KEYS.link : KEYS.home)) return send(res, 403, { error: 'no board key, or an old one: reload the page' });
        if (req.method !== 'GET' && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'send JSON (content-type: application/json)' });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const ids = issue(far, req.guest);
        if (!ids) return send(res, 429, 'Too many pages were opened on this board in the last minute. Wait a minute, then reload.', 'text/plain; charset=utf-8', { 'retry-after': '60' });
        return send(res, 200, page(far, ids), 'text/html; charset=utf-8', head);
      }
      // A call that names a page id (c) is that page's own: its secret, and from the same side of the link it was served to.
      const notMine = c => { if (pageOk(req, c, far)) return false; send(res, 403, { error: 'this page was signed out: the board server restarted or no longer knows it. Reload the page.' }); return true; };
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      // Pictures people paste. An image element carries only a fileId; Excalidraw keeps the pixels in the page, so a
      // pasted screenshot would live in one tab's memory and be gone on reload. The page that has a picture sends it
      // here once; it is kept as a plain image file in the call's files/, and any page missing it (or the agent) reads it back.
      if (req.method === 'POST' && url.pathname === '/api/files') {
        const { files: list, c, name } = await json(req, far ? 8e6 : 30e6), took = [];
        if (c != null && notMine(c)) return;
        let { n, bytes } = picsNow();
        for (const f of Array.isArray(list) ? list : []) {
          const m = f && typeof f.id === 'string' && /^[\w-]{1,128}$/.test(f.id) && typeof f.dataURL === 'string' && f.dataURL.match(/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
          if (!m || picOf(f.id)) continue;
          const pic = Buffer.from(m[2], 'base64');
          if (pic.length > PIC_MAX || n >= PICS_MAX || bytes + pic.length > PICS_BYTES) continue;
          mkdirSafe(PICS);
          writeSafe(path.join(PICS, `${f.id}.${PIC_EXT[m[1]]}`), pic);
          n++; bytes += pic.length; took.push(f.id);
        }
        if (took.length) { broadcast('files', { ids: took }, c ?? null); appendSafe(EVENTS, `IMAGE: ${quiet(shown(authorOf(name, far)))}${far ? ' via link' : ''} added ${took.map(id => `${CALL}/files/${path.basename(picOf(id))}`).join(', ')}\n`); }
        return send(res, 200, { ok: true, took });
      }
      // At most 10 pictures an answer (the page asks in tens), sent one at a time rather than built as one string. Through
      // the link the answer is paid for first, by the pictures' sizes.
      if (req.method === 'GET' && url.pathname === '/api/files') {
        const want = [...new Set((url.searchParams.get('ids') || '').split(','))].slice(0, 10).map(picOf).filter(Boolean);
        if (!readOk(req, res, want.reduce((t, p) => { try { return t + Math.ceil(fs.statSync(p).size * 4 / 3) + 200; } catch { return t; } }, 0))) return;
        res.writeHead(200, heads('application/json', {})); res.write('{"files":[');
        let first = true;
        for (const p of want) {
          const ext = path.extname(p).slice(1), type = Object.keys(PIC_EXT).find(k => PIC_EXT[k] === ext);
          let bytes; try { bytes = readSafe(p, null); } catch { continue; }   // gone, or no longer a plain file with one name
          res.write(`${first ? '' : ','}${JSON.stringify({ id: path.basename(p, '.' + ext), mimeType: `image/${type}`, dataURL: `data:image/${type};base64,${bytes.toString('base64')}`, created: fs.statSync(p).mtimeMs })}`);
          first = false;
        }
        return res.end(']}');
      }
      // `answer`: pages show ✓ keep / ✎ change only to a server that takes them (an older one would 404).
      // The folder's path (it names this computer's user) only to this computer: `share` reads it from here.
      if (req.method === 'GET' && url.pathname === '/api/hello') return send(res, 200, { mp: MP, tour: 1, answer: 1, ...(far ? {} : { dir: DIR }), here: [...clients.values()].map(c => c.name), sharing: !!openShare() });
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const a = await json(req);
        if (a.probe) return send(res, 200, { ok: true, quiet: true });
        if (recordFull()) return send(res, 413, { error: 'the record is full (10 MB): start a new call' });
        if (linkFull(far)) return send(res, 413, { error: 'the share link has used its half of the record (5 MB)' });
        let item; try { item = appended(answer(DIR, a, authorOf(a.name, far), far ? 'link' : null), far); } catch (e) { return send(res, 400, { error: e.message }); }
        appendSafe(EVENTS, answerLine(item, far));
        return send(res, 200, item);
      }
      if (req.method === 'POST' && url.pathname === '/api/tour') {
        const t = await json(req);
        if (t.probe) return send(res, 200, { ok: true, quiet: true });
        if (notMine(t.c)) return;
        // Only a tour in the record, and its title and length come from there: the page says which tour and which step.
        const tr = typeof t.tour_id === 'string' && t.tour_id ? lastTour(DIR, t.tour_id) : null, n = tr ? (tr.steps || []).length : 0, i = Math.round(+t.index);
        if (!tr) return send(res, 400, { error: 'no such tour in the record' });
        if (!['step', 'exit', 'done'].includes(t.action) || !(i >= 1 && i <= n)) return send(res, 400, { error: 'bad tour report' });
        const who = quiet(shown(authorOf(t.name, far)) + (far ? ' via link' : '')), title = quiet(tr.title || 'tour');
        const line = t.action === 'step' ? `TOUR: ${who} at step ${i}/${n} (${title})` : t.action === 'done' ? `TOUR: ${who} finished (${title})` : `TOUR: ${who} exited at step ${i}/${n} (${title})`;
        // A page here: its last move, 1.2 s after its clicks stop. The link: one line at most every 1.2 s for all its pages
        // together, the latest (a guest can hold many page ids).
        if (far) {
          const w = tourAt.get('link');
          if (w) w.line = line;
          else { const x = { line }; x.timer = setTimeout(safe('tour line', () => { tourAt.delete('link'); appendSafe(EVENTS, x.line + '\n'); }), 1200); tourAt.set('link', x); }
          return send(res, 200, { ok: true });
        }
        const k = t.c;
        clearTimeout(tourAt.get(k)?.timer);
        tourAt.set(k, { timer: setTimeout(safe('tour line', () => { tourAt.delete(k); appendSafe(EVENTS, line + '\n'); }), 1200) });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/thread') { if (!readOk(req, res, fs.existsSync(THREAD) ? fs.statSync(THREAD).size : 0)) return; return send(res, 200, { items: thread(DIR) }); }
      // The team's names, for the avatars. Renaming one is for the person at this computer, never the share link.
      if (req.method === 'GET' && url.pathname === '/api/agents') { if (!readOk(req, res, 600)) return; return send(res, 200, { agents: team(DIR) }); }
      if (req.method === 'POST' && url.pathname === '/api/agents') {
        if (far) return send(res, 403, { error: 'only the person at this computer renames the team' });
        const { from, to } = await json(req);
        let it; try { it = renameAgent(DIR, from, to); } catch (e) { return send(res, 400, { error: e.message }); }
        appendSafe(EVENTS, `TEAM: ${oneLine(it.renamed.from)} is now ${oneLine(it.renamed.to)}\n`);
        return send(res, 200, it);
      }
      if (req.method === 'POST' && url.pathname === '/api/comment') {
        const { text, on: sent, name, to: picked, reply_to: replyTo } = await json(req);
        if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'empty' });
        if (text.length > 4000) return send(res, 400, { error: 'a comment is at most 4,000 characters' });
        if (recordFull()) return send(res, 413, { error: 'the record is full (10 MB): start a new call' });
        if (linkFull(far)) return send(res, 413, { error: 'the share link has used its half of the record (5 MB)' });
        // A reply in a thread: reply_to names a comment already in the record (an op, a made-up id or anything not
        // id-shaped is refused). It pins where the thread's first comment pinned, whatever `on` the page sent, and with
        // no agent picked and no @Name at its start it goes to whoever the thread was with: the agent the first comment was
        // for, or the agent who started it. A reply in a thread with Codex doesn't wake every other agent (a paid turn each).
        // (An agent's board_say can name its box as a bare id; the reply keeps it as {id}, the shape every comment has.)
        let root = null;
        if (replyTo !== undefined && replyTo !== null) {
          const items = thread(DIR);
          if (typeof replyTo !== 'string' || !ID.test(replyTo) || !items.some(x => x && x.kind === 'comment' && x.id === replyTo)) return send(res, 400, { error: 'reply_to must name a comment in the record' });
          root = threadRoot(items, replyTo);
        }
        const chose = typeof picked === 'string' && picked.trim(), inherit = root && !chose ? (root.author === 'claude' ? presenterOf(root) : root.to) : null;
        const on = root ? (typeof root.on === 'string' ? { id: root.on } : root.on ?? null) : cleanOn(sent, known), author = authorOf(name, far), to = addressee(DIR, picked, text) || (inherit ? addressee(DIR, inherit, '') : null);
        const item = appended(append(DIR, { kind: 'comment', id: nextId('c'), ts: now(), author, text: text.trim(), on, ...(to ? { to } : {}), ...(root ? { reply_to: replyTo, thread_id: root.id } : {}), ...(far ? { via: 'link' } : {}) }), far);
        // A comment on a pasted picture names its saved file, so the agent can open the picture it is about.
        const pics = [...new Set([on && on.id, ...((on && on.ids) || [])])].map(id => els.get(id)).filter(e => e && e.type === 'image' && !e.isDeleted).map(e => picOf(e.fileId)).filter(Boolean);
        appendSafe(EVENTS, `COMMENT by ${oneLine(shown(author))}${far ? ' via link' : ''}${to ? ` to ${oneLine(to)}` : ''}${on ? ` [on: ${oneLine(on.label || on.id)}]` : ''}${pics.length ? ` [pictures: ${pics.map(p => `${CALL}/files/` + path.basename(p)).join(', ')}]` : ''}: ${oneLine(item.text)}\n`);
        return send(res, 200, item);
      }
      if (req.method === 'GET' && url.pathname === '/api/scene') { if (!readOk(req, res, sceneBytes)) return; return send(res, 200, { elements: [...els.values()] }); }
      if (req.method === 'POST' && url.pathname === '/api/scene') {
        // A page sends at most 10 MB and 2,000 elements at a time (the page splits a bigger change); a guest 2 MB.
        const scene = await json(req, far ? 2e6 : 10e6);
        if (scene.probe) return send(res, 200, { ok: true, quiet: true });   // a test load (?probe) never changes the board
        // Every page names itself (c). The old whole-scene overwrite with no page id is gone: one request could wipe the board.
        if (!pageId(scene.c)) return send(res, 400, { error: 'no page id' });
        if (notMine(scene.c)) return;
        const list = Array.isArray(scene.elements) ? scene.elements : [];
        if (list.length > 2000) return send(res, 413, { error: 'at most 2,000 elements at a time' });
        const who = [authorOf(scene.name, far), far], took = [], room = roomFor();
        let bytes = 0;
        for (const e of list) {
          if (!okElement(e, known) || !newer(e, els.get(e.id))) continue;
          let c = cleanElement(e);
          if (far && hatchOf(c, true) && hatchSum - (hatchArea.get(c.id) || 0) + hatchOf(c, true) > HATCH_AREA) c = { ...c, fillStyle: 'solid' };
          if (far && isBig(c) && !bigLink.has(c.id) && bigLink.size >= BIG_MAX) continue;
          const size = JSON.stringify(c).length;
          if (size > ELEMENT_MAX(c) || !room(c.id, size, far)) continue;
          put(c, size, far); by.set(c.id, who); took.push(c); bytes += size;
        }
        if (took.length) { broadcast('elements', { elements: took }, scene.c, bytes); saveSoon(); diffSoon(); }
        return send(res, 200, { ok: true, took: took.length });
      }
      if (req.method === 'GET' && url.pathname === '/api/changes') {
        const c = url.searchParams.get('c'), since = Number(url.searchParams.get('since') ?? -1);
        if (!pageId(c)) return send(res, 400, { error: 'no page id' });
        if (notMine(c)) return;
        touch(c, shown(authorOf(url.searchParams.get('name'), far)));
        // First poll, a restarted server, or a page too far behind the log: start from the room, and say "reload the scene".
        if (since < 0 || since > seq || (log.length && since < log[0].seq - 1)) return send(res, 200, { seq, reset: since >= 0, events: roster(c) });
        const now = pending(c, since);
        if (now.length) return send(res, 200, { seq, events: now });
        const w = { c, since };
        w.reply = evs => { waiting.delete(w); clearTimeout(w.t); if (!res.writableEnded) send(res, 200, { seq, events: evs }); };
        w.t = setTimeout(() => w.reply([]), 25000);
        waiting.add(w); res.on('close', () => { waiting.delete(w); clearTimeout(w.t); });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/leave') { const { c } = await json(req); if (notMine(c)) return; leave(c); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/presence') {
        // Passed to every other page as Excalidraw collaborator data, so only the shapes Excalidraw expects.
        const p = await json(req);
        if (notMine(p.c)) return;
        const c = clients.get(p.c), q = p.pointer;
        const pointer = q && Number.isFinite(q.x) && Number.isFinite(q.y) ? { x: q.x, y: q.y, tool: q.tool === 'laser' ? 'laser' : 'pointer' } : null;
        const selected = Object.fromEntries(Object.keys(p.selected && typeof p.selected === 'object' ? p.selected : {}).filter(k => ID.test(k)).slice(0, 500).map(k => [k, true]));
        if (c) broadcast('presence', { id: p.c, name: c.name, pointer, button: p.button === 'down' ? 'down' : 'up', selected }, p.c);
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { if (!e.status) console.error('ERROR', e.message); if (!res.headersSent) send(res, e.status || 500, { error: e.message }, 'application/json', e.status === 413 ? { connection: 'close' } : e.status === 429 ? { connection: 'close', 'retry-after': '2' } : {}); }
  });
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `port ${port} is taken: pass --port <another>` : e.message); process.exit(1); });
  // server.json says which process serves this call, so `stop` can stop it; it goes when the server does.
  const SERVER = files(DIR).server, gone = () => { try { if (JSON.parse(readSafe(SERVER)).pid === process.pid) fs.unlinkSync(SERVER); } catch { /* not ours */ } };
  // (A signal ends the server only when nothing else listens for it: `share` runs this server in its own process and
  // must close its link first.)
  process.on('exit', gone); for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { if (process.listenerCount(sig) === 1) process.exit(0); });
  server.listen(port, '127.0.0.1', () => { writeSafe(SERVER, JSON.stringify({ pid: process.pid, port, started: now() })); console.log(`board on http://localhost:${port} (only this computer can reach it)`); });
  return server;
}

// Open the running board to teammates: a Cloudflare quick tunnel (no account, a random trycloudflare.com name) plus a
// fresh secret key. The key lives in share.json only while this process runs; the server checks that this process
// is alive, so a killed share closes the door even if the tunnel lingers.
// share.json holds the link's key: readable by its owner only, even where an older copy was looser.
export function writeShare(file, data) { writeSafe(file, JSON.stringify(data)); }
export async function share({ dir, port = DEFAULT_PORT } = {}) {
  const DIR = path.resolve(dir || '.');
  const { live: LIVE, scene: SCENE, share: SHARE } = files(DIR);
  const hello = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null);
  if (!hello) serve({ dir: DIR, port });
  else if (hello.mp !== MP) { console.error(`port ${port} runs an older board server with no keys. Restart it first.`); process.exit(1); }
  else if (fs.realpathSync(hello.dir) !== fs.realpathSync(DIR)) { console.error(`port ${port} serves ${hello.dir}, not this board.`); process.exit(1); }
  checkCall(DIR); mkdirSafe(LIVE);
  if (fs.existsSync(SCENE)) writeSafe(path.join(LIVE, `scene.before-share-${now().replace(/[:.]/g, '-')}.json`), readSafe(SCENE));   // anyone with the link can edit
  const key = crypto.randomBytes(18).toString('base64url');
  writeShare(SHARE, { key, pid: process.pid, port, started: now() });
  const cf = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const close = code => { try { fs.unlinkSync(SHARE); } catch {} try { cf.kill(); } catch {} process.exit(code); };
  process.on('SIGINT', () => close(0)); process.on('SIGTERM', () => close(0));
  cf.on('error', e => { console.error(`cloudflared did not start: ${e.message}`); close(1); });
  cf.on('exit', c => { console.error(`tunnel closed (cloudflared exit ${c})`); close(1); });
  let printed = false;
  const look = d => {
    const m = !printed && String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m) return;
    printed = true;
    const link = `${m[0]}/?k=${key}`;
    writeShare(SHARE, { key, pid: process.pid, port, started: now(), url: m[0] });
    console.log(`share link: ${link}\nAnyone with this link can see and edit the board until you stop this (Ctrl-C, or ${NAME} unshare).`);
  };
  cf.stdout.on('data', look); cf.stderr.on('data', look);
}

export function unshare({ dir } = {}) {
  const { share: SHARE } = files(path.resolve(dir || '.'));
  try { const s = JSON.parse(readSafe(SHARE)); try { process.kill(s.pid, 'SIGTERM'); } catch {} } catch { console.log('not shared'); }
  try { fs.unlinkSync(SHARE); } catch {}
  console.log('link closed');
}
