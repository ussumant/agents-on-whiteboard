// The board server and the record of the call. A person comments on an Excalidraw board in the browser; their coding agent
// answers on it (through the CLI in bin/sketchcall.mjs or the MCP tools in src/mcp.mjs), like a screen-share call.
//
// A board is a folder holding one .excalidraw file. The call lives in its live/ subfolder:
//   live/thread.jsonl   the record: every comment, reply and op, one JSON line each
//   live/events.log     one line per comment, per text someone writes or changes on the canvas, per picture and per
//                       tour move: what an agent watches
//   live/scene.json     the board as everyone sees it now (the .excalidraw file is only where it started)
//   live/files/         pictures pasted on the board, one image file each
//   live/share.json     the share link's key, only while `share` runs
// Multiplayer: the server holds the scene. Pages load it, send only the elements they changed, and get everyone else's
// changes and cursors by long-polling /api/changes. Per element, the higher `version` wins.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4900;
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'board.html');

// The record helpers, shared with mcp.mjs so both write exactly the same lines. `dir` is the board folder.
export const files = dir => ({ live: path.join(dir, 'live'), thread: path.join(dir, 'live', 'thread.jsonl'),
  events: path.join(dir, 'live', 'events.log'), scene: path.join(dir, 'live', 'scene.json'), share: path.join(dir, 'live', 'share.json') });
const now = () => new Date().toISOString();
const nextId = p => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
export const append = (dir, item) => { fs.mkdirSync(files(dir).live, { recursive: true }); fs.appendFileSync(files(dir).thread, JSON.stringify(item) + '\n'); return item; };
export const thread = dir => fs.existsSync(files(dir).thread) ? fs.readFileSync(files(dir).thread, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
// `by` is the presenting session's name: a reply from "Look session" says so in the panel and on the tour card.
export const say = (dir, text, on = null, by) => append(dir, withPresenter({ kind: 'comment', id: nextId('c'), ts: now(), author: 'claude', text, on }, by));
// Presenters: each agent session presents under its own name, set by board_open {presenter} or the CLI's --presenter,
// never by a page (pages can't write ops). An op without one is Claude's, so older records read as before.
export const presenterName = n => { const s = String(n ?? '').replace(/[<>"`\n\r\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32); return !s || s.toLowerCase() === 'claude' ? 'Claude' : s; };
export const presenterOf = o => presenterName(o && o.presenter);
export const samePresenter = (a, b) => presenterName(a).toLowerCase() === presenterName(b).toLowerCase();
function withPresenter(o, by) { const p = presenterName(by); return p === 'Claude' ? o : { ...o, presenter: p }; }
// Text the agent put on the board through ops: a note's or arrow's label (keyed by its container) and each edit's text.
// When a page saves the scene back, that text must not read as a person's writing.
export const flat = t => t.replace(/\s+/g, ' ').slice(0, 200);
export function claudeWrote(dir) {
  const mine = new Set(), edits = {};
  for (const i of thread(dir)) if (i.kind === 'op') {
    if (i.ref) mine.add(i.ref).add(`label:${i.ref}`);
    if (i.op === 'edit') edits[`label:${i.target}`] = edits[`${i.target}__title`] = edits[i.target] = flat(i.text);
  }
  return (id, t) => mine.has(id) || edits[id] === flat(t);
}
export const op = (dir, o) => append(dir, { ...o, kind: 'op', id: nextId('op'), ts: now() });   // element ids go in op.ref (note/arrow) or op.target
// Who wrote it: a name a person typed into the page. "claude" is reserved for the CLI and the MCP tools, so a page can
// never post as the agent.
export const nameOf = n => { const s = String(n || '').replace(/[<>"`\n\r\t]/g, '').trim().slice(0, 24); return s && s.toLowerCase() !== 'claude' ? s : null; };
// The person at this computer: a page with no name of its own. Recorded as "you"; everyone else (other pages, the agent's
// events) sees them as "Host". Their own page says "You".
export const HOME = 'you';
export const shown = a => !a || a === HOME ? 'Host' : a.replace(/(^|\s)\S/g, c => c.toUpperCase());
// The author a request writes as. From this computer a nameless page is the host; through the share link it is a guest,
// and anyone there calling themselves You or Host is "you (link)" or "host (link)", so the link can't pass as the host.
const RESERVED = new Set([HOME, 'host']);
export const authorOf = (name, far) => { const a = (nameOf(name) || (far ? 'guest' : HOME)).toLowerCase(); return far && RESERVED.has(a) ? `${a} (link)` : a; };
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
  const text = String(a.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (a.pick === 'change' && !text) throw new Error('say what to change');
  const tg = s.target, ids = typeof tg === 'string' ? [tg] : Array.isArray(tg) ? tg : [];
  const label = `step ${i}/${n} · ${String(s.title || s.text || '').replace(/\s+/g, ' ')}`.slice(0, 80);
  const on = { id: ids[0] || null, ids, label, tour: t.tour_id || t.id, step: i, ...(tg && tg.area ? { rect: tg.area } : {}) };
  return op(dir, { op: 'answer', tour_id: t.tour_id || t.id, step: i, pick: a.pick, text, question: s.ask.question,
    presenter: presenterOf(t), author, ...(via ? { via } : {}), on });
}
// The events.log line for an answer. It starts with COMMENT on purpose: a watcher that greps events.log for COMMENT wakes
// on it, as it does on a comment.
export const answerLine = (it, far) => `COMMENT by ${shown(it.author)}${far ? ' via link' : ''} [answer to ${it.on.label}]: ${it.pick === 'keep' ? `✓ keep${it.text ? ` · ${it.text}` : ''}` : `✎ change → ${it.text}`}\n`;
// Where people are in the tour: the last TOUR line in events.log (the page reports it; see /api/tour below).
export const tourWhere = dir => { try { return fs.readFileSync(files(dir).events, 'utf8').split('\n').filter(l => l.startsWith('TOUR: ')).at(-1) || null; } catch { return null; } };
// A TOUR line must never wake a watcher, which matches COMMENT, BOARD or EDIT anywhere in a line.
export const quiet = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/COMMENT|BOARD|EDIT/g, w => w[0] + w.slice(1).toLowerCase());

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

// Pictures from an .excalidraw file's `files` (a board's Export carries the tab's pictures) into live/files: each one an
// element on the board uses and the server lacks.
const PIC_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
function savePictures(dir, list, used) {
  const pics = path.join(files(dir).live, 'files'), saved = fs.existsSync(pics) ? fs.readdirSync(pics).map(f => f.replace(/\.\w+$/, '')) : [];
  const took = [];
  for (const f of Object.values(list || {})) {
    const m = String(f && f.dataURL || '').match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (!m || !PIC_TYPES[m[1]] || !used.has(f.id) || saved.includes(f.id) || !/^[\w-]{1,128}$/.test(f.id)) continue;
    fs.mkdirSync(pics, { recursive: true }); fs.writeFileSync(path.join(pics, `${f.id}.${PIC_TYPES[m[1]]}`), Buffer.from(m[2], 'base64')); took.push(`live/files/${f.id}.${PIC_TYPES[m[1]]}`);
  }
  return took;
}
export function importFiles(dir, file) {
  const used = new Set(JSON.parse(fs.readFileSync(files(dir).scene, 'utf8')).elements.filter(e => e.type === 'image' && !e.isDeleted).map(e => e.fileId));
  return { took: savePictures(dir, readBoard(file).files, used) };
}

// The board's record as Markdown: every comment word for word, in order, the reply to each, and the pictures it was
// left on, straight from live/thread.jsonl.
export function record(dir) {
  const { scene: SF, live: LV } = files(dir), PICS = path.join(LV, 'files');
  const items = thread(dir).filter(x => x.kind === 'comment');
  const els = fs.existsSync(SF) ? JSON.parse(fs.readFileSync(SF, 'utf8')).elements : [];
  const saved = fs.existsSync(PICS) ? fs.readdirSync(PICS) : [];
  const pics = c => [c.on && c.on.id, ...((c.on && c.on.ids) || [])].filter(Boolean)
    .map(id => els.find(e => e.id === id && e.type === 'image' && !e.isDeleted)).filter(Boolean)
    .map(e => { const f = saved.find(n => n.startsWith(e.fileId + '.')); return f ? `![picture](live/files/${f})` : null; }).filter(Boolean);
  const out = ['# The board\'s record', '', `> Every comment on this board, word for word, from \`live/thread.jsonl\`. ${items.length} comments.`, ''];
  let n = 0;
  items.forEach((c, i) => {
    if (c.author === 'claude') return;
    const reply = items.slice(i + 1).find(x => x.author === 'claude' && JSON.stringify(x.on) === JSON.stringify(c.on));
    out.push(`## ${++n}. ${(c.on && c.on.label) || 'the whole board'}`, '', `*${c.ts} · ${shown(c.author)}*`, '', ...pics(c).flatMap(p => [p, '']), `**${shown(c.author)}:** ${c.text}`, '');
    if (reply) out.push(...reply.text.split('\n').map((l, k) => (k ? '> ' : `> **${presenterOf(reply)}:** `) + l), '');
  });
  return out.join('\n') + '\n';
}

// The board server. Only this computer can reach it (it listens on 127.0.0.1); `share` opens it to teammates.
export function serve({ dir, port = DEFAULT_PORT, seed } = {}) {
  const DIR = path.resolve(dir || '.');
  const { live: LIVE, thread: THREAD, events: EVENTS, scene: SCENE, share: SHARE } = files(DIR);
  fs.mkdirSync(LIVE, { recursive: true });
  // Pasted pictures, one image file per Excalidraw fileId (see /api/files).
  const PICS = path.join(LIVE, 'files'), PIC_EXT = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg' };
  const picOf = id => { if (!/^[\w-]{1,128}$/.test(id || '')) return null; for (const x of Object.values(PIC_EXT)) { const p = path.join(PICS, `${id}.${x}`); if (fs.existsSync(p)) return p; } return null; };
  // The scene everyone shares, including deleted elements (a delete is a newer version of the element, not its absence).
  const els = new Map(), by = new Map();   // id → element; id → [author, came through the link] of whoever last changed it
  let start = null;
  try { start = seedFile(DIR, seed); } catch (e) { if (!fs.existsSync(SCENE)) throw e; }   // a call already under way doesn't need its seed
  if (fs.existsSync(SCENE)) for (const e of JSON.parse(fs.readFileSync(SCENE, 'utf8')).elements || []) { if (e && e.id) els.set(e.id, e); }
  else if (start) {
    // A new call starts from the .excalidraw file as it is, its pictures included.
    const b = readBoard(start);
    for (const e of b.elements) if (e && e.id) els.set(e.id, e);
    savePictures(DIR, b.files, new Set(b.elements.filter(e => e && e.type === 'image' && !e.isDeleted).map(e => e.fileId)));
    fs.writeFileSync(SCENE, JSON.stringify({ elements: [...els.values()] }));
  }
  // The page, with this board's name and storage key in it (a hash of the folder, so two boards never share a browser's
  // copy). JSON with < escaped, so a file name can't close the script.
  const BOARD = { key: crypto.createHash('sha1').update(fs.realpathSync(DIR)).digest('hex').slice(0, 12),
    name: start ? path.basename(start, '.excalidraw') : path.basename(DIR) };
  const page = () => fs.readFileSync(PAGE, 'utf8').replace('"__SKETCHCALL_BOARD__"', () => JSON.stringify(BOARD).replace(/</g, '\\u003c'));
  // A label bound to a box or arrow can get a fresh random id when a browser rebuilds it, so key it by its container:
  // otherwise every new tab reported the arrow labels as text someone "wrote".
  const textsOf = list => Object.fromEntries(list.filter(e => e.type === 'text' && !e.isDeleted).map(e => [e.containerId ? `label:${e.containerId}` : e.id, [e.text, e.id]]));
  let lastTexts = els.size ? textsOf([...els.values()]) : null;
  const body = req => new Promise((r, x) => { let b = ''; req.on('data', c => { b += c; if (b.length > 20e6) { x(new Error('too big')); req.destroy(); } }); req.on('end', () => r(b)); });
  const send = (res, code, data, type = 'application/json', head = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-board-live': MP, ...head }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };

  // Who is in the room and what changed. Every page long-polls /api/changes: the poll returns at once when something it
  // hasn't seen is waiting, else it waits up to 25 s. (A Cloudflare quick tunnel delivers the headers of server-sent
  // events and never their data, so it's a long poll.) Cursors live only in this log, never in the record.
  const clients = new Map();   // page id → { name, seen }
  const log = [], waiting = new Set();
  let seq = 0, flushTimer = null;
  const pending = (c, since) => log.filter(e => e.seq > since && e.from !== c).map(({ event, data }) => ({ event, data }));
  const roster = c => [...clients].filter(([id]) => id !== c).map(([id, v]) => ({ event: 'join', data: { id, name: v.name } }));
  // Answer the waiting polls 30 ms after a change, so a burst (a drag, a cursor sweep) goes out as one reply.
  const wake = () => { if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; for (const w of [...waiting]) { const evs = pending(w.c, w.since); if (evs.length) w.reply(evs); } }, 30); };
  const broadcast = (event, data, from) => { log.push({ seq: ++seq, from, event, data }); if (log.length > 3000) log.splice(0, log.length - 3000); wake(); };
  const touch = (c, name) => { const had = clients.has(c); clients.set(c, { name, seen: Date.now() }); if (!had) broadcast('join', { id: c, name }, c); };
  const leave = c => { if (clients.delete(c)) broadcast('leave', { id: c }, c); };
  setInterval(() => { for (const [c, v] of clients) if (Date.now() - v.seen > 40000) leave(c); }, 10000).unref();   // closed without saying so
  // An op the CLI or the MCP tools append to thread.jsonl nudges the room, so pages fetch it now, not on their next
  // 1.5 s poll: a tour step or a pointer move lands on every page together.
  fs.watchFile(THREAD, { interval: 150 }, (cur, prev) => { if (cur.size !== prev.size) broadcast('thread', {}, null); });
  // Where people are in a guided tour: one quiet line per page in events.log, 1.2 s after their last click. Never in the
  // thread, and quiet() keeps COMMENT, BOARD and EDIT out of it, so a watcher doesn't wake on a step change.
  const tourAt = new Map();

  let saveTimer = null, diffTimer = null;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFileSync(SCENE, JSON.stringify({ elements: [...els.values()] })), 300); };
  // Text people write reaches events.log once they pause (2.5 s), so a word typed live is one line, not one per key.
  const diffSoon = () => { clearTimeout(diffTimer); diffTimer = setTimeout(diffTexts, 2500); };
  function diffTexts() {
    const texts = textsOf([...els.values()]);
    // A fresh copy of the board (the first seed of an empty server) is nobody writing: stay quiet.
    const fresh = lastTexts ? Object.keys(texts).filter(id => !(id in lastTexts)).length : 0;
    if (!lastTexts || fresh > 12) { lastTexts = texts; return; }
    const byAgent = claudeWrote(DIR);
    for (const [key, [t, id]] of Object.entries(texts)) {
      if (byAgent(key, t)) continue;
      const [a, far] = by.get(id) || [HOME, false], who = shown(a) + (far ? ' via link' : '');
      if (!(key in lastTexts) && t.trim()) fs.appendFileSync(EVENTS, `BOARD: ${who} wrote "${flat(t)}" (${key})\n`);
      else if (key in lastTexts && lastTexts[key][0] !== t) fs.appendFileSync(EVENTS, `BOARD: ${who} changed ${key} to "${flat(t)}"\n`);
    }
    lastTexts = texts;
  }

  // The door. This computer (Host: localhost) walks in. Anyone else arrives through `share`'s tunnel, so their Host is the
  // tunnel's name (and Cloudflare adds cf-connecting-ip): they need the key from share.json, which exists only while
  // `share` runs. The link carries it once as ?k=; the page then keeps it as a cookie and drops it from the address bar.
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const remote = req => !LOCAL.test(req.headers.host || '') || !!req.headers['cf-connecting-ip'] || !!req.headers['x-forwarded-for'];
  const openShare = () => { try { const s = JSON.parse(fs.readFileSync(SHARE, 'utf8')); process.kill(s.pid, 0); return s; } catch { return null; } };
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x'), far = remote(req);
      let head = {};
      if (far) {
        const s = openShare(), k = url.searchParams.get('k') || ((req.headers.cookie || '').match(/(?:^|;\s*)bk=([^;]+)/) || [])[1];
        if (!s || !k || !same(k, s.key)) return send(res, 403, 'This board link is closed, or it is missing its key. Ask for a fresh link.', 'text/plain; charset=utf-8');
        if (url.searchParams.get('k')) head = { 'set-cookie': `bk=${k}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` };
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
        return send(res, 200, page(), 'text/html; charset=utf-8', head);
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      // Pictures people paste. An image element carries only a fileId; Excalidraw keeps the pixels in the page, so a
      // pasted screenshot would live in one tab's memory and be gone on reload. The page that has a picture sends it
      // here once; it is kept as a plain image file in live/files, and any page missing it (or the agent) reads it back.
      if (req.method === 'POST' && url.pathname === '/api/files') {
        const { files: list, c, name } = JSON.parse(await body(req)), took = [];
        for (const f of list || []) {
          const m = f && /^[\w-]{1,128}$/.test(f.id || '') && String(f.dataURL || '').match(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/);
          if (!m || picOf(f.id)) continue;
          fs.mkdirSync(PICS, { recursive: true });
          fs.writeFileSync(path.join(PICS, `${f.id}.${PIC_EXT[m[1]]}`), Buffer.from(m[2], 'base64'));
          took.push(f.id);
        }
        if (took.length) { broadcast('files', { ids: took }, c); fs.appendFileSync(EVENTS, `IMAGE: ${quiet(shown(authorOf(name, far)))} added ${took.map(id => `live/files/${path.basename(picOf(id))}`).join(', ')}\n`); }
        return send(res, 200, { ok: true, took });
      }
      if (req.method === 'GET' && url.pathname === '/api/files') {
        const out = (url.searchParams.get('ids') || '').split(',').map(picOf).filter(Boolean).map(p => {
          const ext = path.extname(p).slice(1), type = Object.keys(PIC_EXT).find(k => PIC_EXT[k] === ext);
          return { id: path.basename(p, '.' + ext), mimeType: `image/${type}`, dataURL: `data:image/${type};base64,${fs.readFileSync(p).toString('base64')}`, created: fs.statSync(p).mtimeMs };
        });
        return send(res, 200, { files: out });
      }
      // `answer`: pages show ✓ keep / ✎ change only to a server that takes them (an older one would 404).
      if (req.method === 'GET' && url.pathname === '/api/hello') return send(res, 200, { mp: MP, tour: 1, answer: 1, dir: DIR, here: [...clients.values()].map(c => c.name), sharing: !!openShare() });
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const a = JSON.parse(await body(req));
        if (a.probe) return send(res, 200, { ok: true, quiet: true });
        let item; try { item = answer(DIR, a, authorOf(a.name, far), far ? 'link' : null); } catch (e) { return send(res, 400, { error: e.message }); }
        fs.appendFileSync(EVENTS, answerLine(item, far));
        return send(res, 200, item);
      }
      if (req.method === 'POST' && url.pathname === '/api/tour') {
        const t = JSON.parse(await body(req)), i = Math.round(+t.index), n = Math.round(+t.total);
        if (t.probe) return send(res, 200, { ok: true, quiet: true });
        if (!['step', 'exit', 'done'].includes(t.action) || !(i >= 1 && n >= i && n < 1000)) return send(res, 400, { error: 'bad tour report' });
        const who = quiet(shown(authorOf(t.name, far)) + (far ? ' via link' : '')), title = quiet(t.title || 'tour');
        const line = t.action === 'step' ? `TOUR: ${who} at step ${i}/${n} (${title})` : t.action === 'done' ? `TOUR: ${who} finished (${title})` : `TOUR: ${who} exited at step ${i}/${n} (${title})`;
        const k = String(t.c || who);
        clearTimeout(tourAt.get(k));
        tourAt.set(k, setTimeout(() => { tourAt.delete(k); fs.appendFileSync(EVENTS, line + '\n'); }, 1200));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/thread') return send(res, 200, { items: thread(DIR) });
      if (req.method === 'POST' && url.pathname === '/api/comment') {
        const { text, on, name } = JSON.parse(await body(req));
        if (!text || !text.trim()) return send(res, 400, { error: 'empty' });
        const author = authorOf(name, far);
        const item = append(DIR, { kind: 'comment', id: nextId('c'), ts: now(), author, text: text.trim(), on: on || null, ...(far ? { via: 'link' } : {}) });
        // A comment on a pasted picture names its saved file, so the agent can open the picture it is about.
        const pics = [...new Set([on && on.id, ...((on && on.ids) || [])])].map(id => els.get(id)).filter(e => e && e.type === 'image' && !e.isDeleted).map(e => picOf(e.fileId)).filter(Boolean);
        fs.appendFileSync(EVENTS, `COMMENT by ${shown(author)}${far ? ' via link' : ''}${on ? ` [on: ${on.label || on.id}]` : ''}${pics.length ? ` [pictures: ${pics.map(p => 'live/files/' + path.basename(p)).join(', ')}]` : ''}: ${item.text.replace(/\s+/g, ' ')}\n`);
        return send(res, 200, item);
      }
      if (req.method === 'GET' && url.pathname === '/api/scene') return send(res, 200, { elements: [...els.values()] });
      if (req.method === 'POST' && url.pathname === '/api/scene') {
        const scene = JSON.parse(await body(req));
        if (scene.probe) return send(res, 200, { ok: true, quiet: true });   // a test load (?probe) never changes the board
        const who = [authorOf(scene.name, far), far], took = [];
        for (const e of scene.elements || []) if (e && e.id && newer(e, els.get(e.id))) took.push(e);
        // A page that sends its whole scene with no page id (an old copy of the page) keeps last-writer-wins.
        if (!scene.c) els.clear(), (scene.elements || []).forEach(e => e && e.id && els.set(e.id, e));
        else took.forEach(e => els.set(e.id, e));
        took.forEach(e => by.set(e.id, who));
        if (took.length) { broadcast('elements', { elements: took }, scene.c); saveSoon(); diffSoon(); }
        return send(res, 200, { ok: true, took: took.length });
      }
      if (req.method === 'GET' && url.pathname === '/api/changes') {
        const c = url.searchParams.get('c'), since = Number(url.searchParams.get('since') ?? -1);
        if (!c) return send(res, 400, { error: 'no page id' });
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
      if (req.method === 'POST' && url.pathname === '/api/leave') { const { c } = JSON.parse(await body(req) || '{}'); leave(c); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/presence') {
        const p = JSON.parse(await body(req)), c = clients.get(p.c);
        if (c) broadcast('presence', { id: p.c, name: c.name, pointer: p.pointer, button: p.button, selected: p.selected || {} }, p.c);
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { console.error('ERROR', e.message); if (!res.headersSent) send(res, 500, { error: e.message }); }
  });
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `port ${port} is taken: pass --port <another>` : e.message); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`board on http://localhost:${port} (only this computer can reach it)`));
  return server;
}

// Open the running board to teammates: a Cloudflare quick tunnel (no account, a random trycloudflare.com name) plus a
// fresh secret key. The key lives in live/share.json only while this process runs; the server checks that this process
// is alive, so a killed share closes the door even if the tunnel lingers.
export async function share({ dir, port = DEFAULT_PORT } = {}) {
  const DIR = path.resolve(dir || '.');
  const { live: LIVE, scene: SCENE, share: SHARE } = files(DIR);
  const hello = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null);
  if (!hello) serve({ dir: DIR, port });
  else if (hello.mp !== MP) { console.error(`port ${port} runs an older board server with no keys. Restart it first.`); process.exit(1); }
  else if (fs.realpathSync(hello.dir) !== fs.realpathSync(DIR)) { console.error(`port ${port} serves ${hello.dir}, not this board.`); process.exit(1); }
  fs.mkdirSync(LIVE, { recursive: true });
  if (fs.existsSync(SCENE)) fs.copyFileSync(SCENE, path.join(LIVE, `scene.before-share-${now().replace(/[:.]/g, '-')}.json`));   // anyone with the link can edit
  const key = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(SHARE, JSON.stringify({ key, pid: process.pid, port, started: now() }));
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
    fs.writeFileSync(SHARE, JSON.stringify({ key, pid: process.pid, port, started: now(), url: m[0] }));
    console.log(`share link: ${link}\nAnyone with this link can see and edit the board until you stop this (Ctrl-C, or sketchcall unshare).`);
  };
  cf.stdout.on('data', look); cf.stderr.on('data', look);
}

export function unshare({ dir } = {}) {
  const { share: SHARE } = files(path.resolve(dir || '.'));
  try { const s = JSON.parse(fs.readFileSync(SHARE, 'utf8')); try { process.kill(s.pid, 'SIGTERM'); } catch {} } catch { console.log('not shared'); }
  try { fs.unlinkSync(SHARE); } catch {}
  console.log('link closed');
}
