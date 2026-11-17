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
const points = (p, min) => Array.isArray(p) && p.length >= min && p.length <= 10000 && p.every(q => Array.isArray(q) && q.length === 2 && num(q[0]) && num(q[1]));
// A value nested past `n` levels of objects or arrays (an element's points are 2: the list, then each point).
const deeper = (v, n) => !!v && typeof v === 'object' && (n <= 0 || Object.values(v).some(x => deeper(x, n - 1)));
export function shapeOk(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || !TYPES.has(e.type)) return false;
  if (!['x', 'y', 'width', 'height', 'angle', 'strokeWidth', 'roughness', 'opacity', 'seed', 'updated', 'baseline'].every(k => opt(e[k], num))) return false;
  if (!['fontSize', 'lineHeight'].every(k => opt(e[k], v => num(v) && v > 0)) || !opt(e.fontFamily, num)) return false;
  if (!['text', 'originalText'].every(k => opt(e[k], str(10000)))) return false;
  if (!['strokeColor', 'backgroundColor', 'fillStyle', 'strokeStyle', 'textAlign', 'verticalAlign', 'status', 'startArrowhead', 'endArrowhead', 'frameId', 'name'].every(k => opt(e[k], str(200)))) return false;
  if (!['isDeleted', 'locked'].every(k => opt(e[k], v => typeof v === 'boolean')) || !opt(e.link, str(2000))) return false;
  if (!opt(e.groupIds, g => Array.isArray(g) && g.length <= 100 && g.every(str(128)))) return false;
  if (!opt(e.boundElements, b => Array.isArray(b) && b.length <= 1000 && b.every(x => x && typeof x === 'object' && str(128)(x.id) && str(32)(x.type)))) return false;
  if (!opt(e.roundness, q => typeof q === 'object' && num(q.type) && opt(q.value, num))) return false;
  if (!['startBinding', 'endBinding'].every(k => opt(e[k], q => typeof q === 'object' && str(128)(q.elementId) && num(q.focus) && num(q.gap)))) return false;
  if (!opt(e.customData, c => typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length <= 16 && Object.values(c).every(v => v === null || typeof v === 'boolean' || num(v) || str(200)(v)))) return false;
  if (LINEAR.has(e.type) ? !points(e.points, 2) : e.type === 'freedraw' ? !points(e.points, 1) || !opt(e.pressures, q => Array.isArray(q) && q.length <= 10000 && q.every(num)) : e.points !== undefined) return false;
  if (e.containerId != null && (typeof e.containerId !== 'string' || e.containerId === e.id)) return false;
  return !Object.values(e).some(v => deeper(v, 2));
}
// From a page: the shape above, an id this board takes, a whole-number version under a billion, and ids it points at.
export const okElement = (e, known = id => ID.test(id)) => shapeOk(e) && typeof e.id === 'string' && known(e.id)
  && Number.isInteger(e.version) && e.version >= 0 && e.version < 1e9 && Number.isSafeInteger(e.versionNonce)
  && (e.containerId == null || known(e.containerId)) && (e.fileId == null || (typeof e.fileId === 'string' && /^[\w-]{1,128}$/.test(e.fileId)));
// What is kept of an element that passed: never `validated` (Excalidraw draws an embed that says so), and no link that
// starts // or /\ (Excalidraw opens those in the board's own tab, on another site).
export const cleanElement = e => { const { validated, ...out } = e; if (typeof out.link === 'string' && /^[\s\p{Cc}]*[/\\]{2}/u.test(out.link)) out.link = null; return out; };
// One element is at most 64 KB as JSON (a line or a freehand stroke, with up to 10,000 points, 256 KB).
export const ELEMENT_MAX = e => LINEAR.has(e.type) || e.type === 'freedraw' ? 256e3 : 64e3;
// A board file or scene.json as it starts the server: a person's own file may have odd ids or no versionNonce, so only
// what can crash the server or a page, or lock an element, is left out.
const loadable = e => !!e && typeof e === 'object' && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 128 && !/\p{Cc}/u.test(e.id)
  && (e.version === undefined || (Number.isFinite(e.version) && e.version < 1e9)) && shapeOk(e);

// The record helpers, shared with mcp.mjs so both write exactly the same lines. `dir` is the board folder.
// live/canvas.jsonl: the BOARD events as records ({id, ts, author, via, key, el, text, change}), which the MCP server pushes
// from, never by reading the words of a log line back.
export const files = dir => ({ live: path.join(dir, 'live'), thread: path.join(dir, 'live', 'thread.jsonl'), canvas: path.join(dir, 'live', 'canvas.jsonl'),
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
export const flat = t => String(t ?? '').replace(BREAKS, ' ').replace(/\s+/g, ' ').slice(0, 200);
// It is the agent's only while the text is still what the agent wrote: a guest rewriting the agent's note is someone writing.
export function claudeWrote(dir) {
  const said = {};
  for (const i of thread(dir)) if (i.kind === 'op') {
    if (i.op === 'note' && i.ref) said[`label:${i.ref}`] = flat(i.text).trim();
    if (i.op === 'arrow' && i.ref && i.label) said[`label:${i.ref}`] = flat(i.label).trim();
    if (i.op === 'edit') said[`label:${i.target}`] = said[`${i.target}__title`] = said[i.target] = flat(i.text).trim();
  }
  return (id, t) => said[id] !== undefined && said[id] === flat(t).trim();
}
// Element ids go in op.ref (note/arrow) or op.target. A new element's id must be one the server takes back from the pages
// (id-shaped, with room for its __label), and its text one it saves, or the note shows on every page and is never kept.
export const op = (dir, o) => {
  if (o.ref != null && !(typeof o.ref === 'string' && ID.test(o.ref) && o.ref.length <= 120)) throw new Error(`ref must be letters, digits, _ - . or : (at most 120), like "note-1" (got ${JSON.stringify(o.ref)})`);
  if (o.text != null && String(o.text).length > 10000) throw new Error('text is at most 10,000 characters');
  return append(dir, { ...o, kind: 'op', id: nextId('op'), ts: now() });
};
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
export const tourWhere = dir => { try { return fs.readFileSync(files(dir).events, 'utf8').split('\n').filter(l => l.startsWith('TOUR: ')).at(-1) || null; } catch { return null; } };
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

// Pictures from an .excalidraw file's `files` (a board's Export carries the tab's pictures) into live/files: each one an
// element on the board uses and the server lacks.
// No SVG: it can carry script, which runs if someone opens the file itself.
const PIC_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
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
// Only this code writes the record's structure: the headings and the time, author and reply lines. A comment's or a
// reply's text goes in as a quote, every line of it, with HTML escaped and a leading # escaped, so a commenter's
// "## 7. …" or "**Host:** Approved" stays inside their own quote and can't read as an entry or a reply.
const mdText = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mdName = s => mdText(oneLine(s)).replace(/[\\`*_[\]]/g, '\\$&');
const quoted = t => String(t ?? '').split(/\r\n|\r|\n|\u2028|\u2029/).map(l => `> ${mdText(l).replace(/^(\s*)#/, '$1\\#')}`).join('\n');
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
    out.push(`## ${++n}. ${mdName((c.on && c.on.label) || 'the whole board')}`, '', `*${mdName(c.ts)} · ${mdName(shown(c.author))}*`, '', ...pics(c).flatMap(p => [p, '']),
      `**${mdName(shown(c.author))}:**`, '', quoted(c.text), '');
    if (reply) out.push(`**${mdName(presenterOf(reply))} replied:**`, '', quoted(reply.text), '');
  });
  return out.join('\n') + '\n';
}

// The board server. Only this computer can reach it (it listens on 127.0.0.1); `share` opens it to teammates.
export function serve({ dir, port = DEFAULT_PORT, seed } = {}) {
  const DIR = path.resolve(dir || '.');
  const { live: LIVE, thread: THREAD, events: EVENTS, scene: SCENE, share: SHARE, canvas: CANVAS } = files(DIR);
  fs.mkdirSync(LIVE, { recursive: true });
  // Pasted pictures, one image file per Excalidraw fileId (see /api/files).
  // No SVG (it can carry script); at most 200 pictures and 200 MB per board, 5 MB each.
  const PICS = path.join(LIVE, 'files'), PIC_EXT = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' }, PIC_MAX = 5e6, PICS_MAX = 200, PICS_BYTES = 200e6;
  const picsNow = () => { try { const l = fs.readdirSync(PICS); return { n: l.length, bytes: l.reduce((t, f) => t + fs.statSync(path.join(PICS, f)).size, 0) }; } catch { return { n: 0, bytes: 0 }; } };
  const picOf = id => { if (!/^[\w-]{1,128}$/.test(id || '')) return null; for (const x of Object.values(PIC_EXT)) { const p = path.join(PICS, `${id}.${x}`); if (fs.existsSync(p)) return p; } return null; };
  // The scene everyone shares, including deleted elements (a delete is a newer version of the element, not its absence).
  const els = new Map(), by = new Map();   // id → element; id → [author, came through the link] of whoever last changed it
  // The scene's size: at most 5,000 elements (deleted ones too) and 20 MB. When it's full, the oldest deleted elements make
  // room; past that, new elements aren't taken.
  const SCENE_MAX = 5000, SCENE_BYTES = 20e6, sizes = new Map();
  let sceneBytes = 0;
  const put = (e, size) => { sceneBytes += size - (sizes.get(e.id) || 0); sizes.set(e.id, size); els.set(e.id, e); };
  const room = (id, size) => {
    const fits = () => (els.has(id) || els.size < SCENE_MAX) && sceneBytes - (sizes.get(id) || 0) + size <= SCENE_BYTES;
    if (fits()) return true;
    for (const d of [...els.values()].filter(e => e.isDeleted && e.id !== id).sort((a, b) => (a.updated || 0) - (b.updated || 0))) {
      sceneBytes -= sizes.get(d.id) || 0; sizes.delete(d.id); els.delete(d.id);
      if (fits()) return true;
    }
    return false;
  };
  const load = e => { if (!loadable(e)) return false; const c = cleanElement(e); put(c, JSON.stringify(c).length); return true; };
  let start = null;
  try { start = seedFile(DIR, seed); } catch (e) { if (!fs.existsSync(SCENE)) throw e; }   // a call already under way doesn't need its seed
  if (fs.existsSync(SCENE)) {
    // An element that could crash the server or lock itself (saved before these checks) is left behind, with a note.
    const all = JSON.parse(fs.readFileSync(SCENE, 'utf8')).elements || [], kept = all.filter(load).length;
    if (kept < all.length) { console.error(`left out ${all.length - kept} broken element(s) from ${SCENE}`); fs.writeFileSync(SCENE, JSON.stringify({ elements: [...els.values()] })); }
  } else if (start) {
    // A new call starts from the .excalidraw file as it is, its pictures included.
    const b = readBoard(start);
    b.elements.forEach(load);
    savePictures(DIR, b.files, new Set(b.elements.filter(e => e && e.type === 'image' && !e.isDeleted).map(e => e.fileId)));
    fs.writeFileSync(SCENE, JSON.stringify({ elements: [...els.values()] }));
  }
  // The page, with this board's name and storage key in it (a hash of the folder, so two boards never share a browser's
  // copy). JSON with < escaped, so a file name can't close the script.
  const BOARD = { key: crypto.createHash('sha1').update(fs.realpathSync(DIR)).digest('hex').slice(0, 12),
    name: start ? path.basename(start, '.excalidraw') : path.basename(DIR) };
  // The write keys, new each run. A page gets one in its HTML, and sends it with every write; another website can't read
  // the page (no CORS), so it can't send it. A page that came through the share link gets a different key from a page on
  // this computer, so one can't stand in for the other.
  const KEYS = { home: crypto.randomBytes(18).toString('base64url'), link: crypto.randomBytes(18).toString('base64url') };
  // Each page served gets its own page id and a secret that goes with it, issued here and never sent to anyone else. The
  // id is how the room knows a page (other pages see it); the secret is what lets a call act as that page, so a guest who
  // learns the owner's page id from the room still can't post, point, leave or rename as it. Each side keeps its own 500
  // (the least recently heard from go first), so page loads through the link can only push out link pages, and the link
  // gets at most 60 new pages a minute. A page the server forgot asks to be reloaded.
  const pages = { home: new Map(), link: new Map() }, minted = [];   // page id → secret; when the link last minted pages
  const issue = far => {
    const side = far ? pages.link : pages.home, t = Date.now();
    if (far) { while (minted.length && t - minted[0] > 60000) minted.shift(); if (minted.length >= 60) return null; minted.push(t); }
    const c = crypto.randomBytes(9).toString('base64url'), secret = crypto.randomBytes(18).toString('base64url');
    side.set(c, secret); if (side.size > 500) side.delete(side.keys().next().value);
    return { page: c, pageKey: secret };
  };
  const pageOk = (req, c, far) => {
    const side = far ? pages.link : pages.home, secret = typeof c === 'string' && side.get(c);
    if (!secret || !same(req.headers['x-sketchcall-page'] || '', secret)) return false;
    side.delete(c); side.set(c, secret); return true;   // most recently heard from
  };
  const page = (far, ids) => fs.readFileSync(PAGE, 'utf8').replace('"__SKETCHCALL_BOARD__"', () => JSON.stringify({ ...BOARD, token: far ? KEYS.link : KEYS.home, ...ids }).replace(/</g, '\\u003c'));
  // Element ids a page may send: id-shaped ones, or an odd one the board's own file already has.
  const known = id => ID.test(id) || els.has(id);
  // A label bound to a box or arrow can get a fresh random id when a browser rebuilds it, so key it by its container:
  // otherwise every new tab reported the arrow labels as text someone "wrote".
  const textsOf = list => Object.fromEntries(list.filter(e => e.type === 'text' && !e.isDeleted).map(e => [e.containerId ? `label:${e.containerId}` : e.id, [e.originalText ?? e.text, e.id]]));
  let lastTexts = els.size ? textsOf([...els.values()]) : null;
  // A request body, at most `cap` bytes (1 MB; a scene 10 MB; pictures 30 MB). Past the cap the rest is read and thrown
  // away, and the request gets 413. A body must be one JSON object.
  const fail = (status, m) => Object.assign(new Error(m), { status });
  const body = (req, cap = 1e6) => new Promise((r, x) => {
    let b = '', n = 0;
    const take = c => { n += c.length; if (n > cap) { req.off('data', take); req.resume(); x(fail(413, `too big: at most ${cap / 1e6} MB`)); } else b += c; };
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
  const send = (res, code, data, type = 'application/json', head = {}) => {
    let out; try { out = typeof data === 'string' ? data : JSON.stringify(data); } catch (e) { code = 500; type = 'application/json'; out = JSON.stringify({ error: `could not answer: ${e.message}` }); }
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-board-live': MP,
      'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...head });
    res.end(out); };
  // A timer's work never takes the server down: one bad element used to, 2.5 s after it arrived.
  const safe = (what, fn) => (...a) => { try { return fn(...a); } catch (e) { console.error(`ERROR in ${what}: ${e.message}`); } };
  const pageId = c => typeof c === 'string' && /^[\w-]{1,64}$/.test(c);
  // The record stops taking comments and answers from pages at 10 MB (the agent's own lines still go in), and from the
  // share link at half that, so a guest can't fill it and lock this computer out.
  const recordFull = () => { try { return fs.statSync(THREAD).size >= 10e6; } catch { return false; } };
  let linkBytes = 0;
  try { for (const l of fs.readFileSync(THREAD, 'utf8').split('\n')) if (l.includes('"via":"link"')) try { if (JSON.parse(l).via === 'link') linkBytes += Buffer.byteLength(l) + 1; } catch {} } catch {}
  const linkFull = far => far && linkBytes >= 5e6;
  const appended = (item, far) => { if (far) linkBytes += Buffer.byteLength(JSON.stringify(item)) + 1; return item; };

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
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(safe('save', () => fs.writeFileSync(SCENE, JSON.stringify({ elements: [...els.values()] }))), 300); };
  // Text people write reaches events.log once they pause (2.5 s), so a word typed live is one line, not one per key.
  const diffSoon = () => { clearTimeout(diffTimer); diffTimer = setTimeout(safe('text check', diffTexts), 2500); };
  function diffTexts() {
    const texts = textsOf([...els.values()]);
    // The first seed of a server that had no board is nobody writing: stay quiet. After that, every new text is someone's.
    if (!lastTexts) { lastTexts = texts; return; }
    const byAgent = claudeWrote(DIR);
    for (const [key, [t, id]] of Object.entries(texts)) {
      if (byAgent(key, t)) continue;
      const [a, far] = by.get(id) || [HOME, false], who = shown(a) + (far ? ' via link' : '');
      const change = !(key in lastTexts) && t.trim() ? 'wrote' : key in lastTexts && lastTexts[key][0] !== t ? 'changed' : null;
      if (!change) continue;
      fs.appendFileSync(EVENTS, change === 'wrote' ? `BOARD: ${oneLine(who)} wrote "${flat(t)}" (${oneLine(key)})\n` : `BOARD: ${oneLine(who)} changed ${oneLine(key)} to "${flat(t)}"\n`);
      fs.appendFileSync(CANVAS, JSON.stringify({ id: nextId('b'), ts: now(), author: a, ...(far ? { via: 'link' } : {}), key, el: id, text: flat(t), change }) + '\n');
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
        if (!same(req.headers['x-sketchcall-key'] || '', far ? KEYS.link : KEYS.home)) return send(res, 403, { error: 'no board key, or an old one: reload the page' });
        if (req.method !== 'GET' && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'send JSON (content-type: application/json)' });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const ids = issue(far);
        if (!ids) return send(res, 429, 'Too many pages opened through this link in the last minute. Wait a minute, then reload.', 'text/plain; charset=utf-8', { 'retry-after': '60' });
        return send(res, 200, page(far, ids), 'text/html; charset=utf-8', head);
      }
      // A call that names a page id (c) is that page's own: its secret, and from the same side of the link it was served to.
      const notMine = c => { if (pageOk(req, c, far)) return false; send(res, 403, { error: 'not this page\'s id, or the server restarted: reload the page' }); return true; };
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      // Pictures people paste. An image element carries only a fileId; Excalidraw keeps the pixels in the page, so a
      // pasted screenshot would live in one tab's memory and be gone on reload. The page that has a picture sends it
      // here once; it is kept as a plain image file in live/files, and any page missing it (or the agent) reads it back.
      if (req.method === 'POST' && url.pathname === '/api/files') {
        const { files: list, c, name } = await json(req, 30e6), took = [];
        if (c != null && notMine(c)) return;
        let { n, bytes } = picsNow();
        for (const f of Array.isArray(list) ? list : []) {
          const m = f && typeof f.id === 'string' && /^[\w-]{1,128}$/.test(f.id) && typeof f.dataURL === 'string' && f.dataURL.match(/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
          if (!m || picOf(f.id)) continue;
          const pic = Buffer.from(m[2], 'base64');
          if (pic.length > PIC_MAX || n >= PICS_MAX || bytes + pic.length > PICS_BYTES) continue;
          fs.mkdirSync(PICS, { recursive: true });
          fs.writeFileSync(path.join(PICS, `${f.id}.${PIC_EXT[m[1]]}`), pic);
          n++; bytes += pic.length; took.push(f.id);
        }
        if (took.length) { broadcast('files', { ids: took }, c ?? null); fs.appendFileSync(EVENTS, `IMAGE: ${quiet(shown(authorOf(name, far)))}${far ? ' via link' : ''} added ${took.map(id => `live/files/${path.basename(picOf(id))}`).join(', ')}\n`); }
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
      // The folder's path (it names this computer's user) only to this computer: `share` reads it from here.
      if (req.method === 'GET' && url.pathname === '/api/hello') return send(res, 200, { mp: MP, tour: 1, answer: 1, ...(far ? {} : { dir: DIR }), here: [...clients.values()].map(c => c.name), sharing: !!openShare() });
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const a = await json(req);
        if (a.probe) return send(res, 200, { ok: true, quiet: true });
        if (recordFull()) return send(res, 413, { error: 'the record is full (10 MB): start a new call' });
        if (linkFull(far)) return send(res, 413, { error: 'the share link has used its half of the record (5 MB)' });
        let item; try { item = appended(answer(DIR, a, authorOf(a.name, far), far ? 'link' : null), far); } catch (e) { return send(res, 400, { error: e.message }); }
        fs.appendFileSync(EVENTS, answerLine(item, far));
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
        const k = t.c;
        clearTimeout(tourAt.get(k));
        tourAt.set(k, setTimeout(safe('tour line', () => { tourAt.delete(k); fs.appendFileSync(EVENTS, line + '\n'); }), 1200));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/thread') return send(res, 200, { items: thread(DIR) });
      if (req.method === 'POST' && url.pathname === '/api/comment') {
        const { text, on: sent, name } = await json(req);
        if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'empty' });
        if (text.length > 4000) return send(res, 400, { error: 'a comment is at most 4,000 characters' });
        if (recordFull()) return send(res, 413, { error: 'the record is full (10 MB): start a new call' });
        if (linkFull(far)) return send(res, 413, { error: 'the share link has used its half of the record (5 MB)' });
        const on = cleanOn(sent, known), author = authorOf(name, far);
        const item = appended(append(DIR, { kind: 'comment', id: nextId('c'), ts: now(), author, text: text.trim(), on, ...(far ? { via: 'link' } : {}) }), far);
        // A comment on a pasted picture names its saved file, so the agent can open the picture it is about.
        const pics = [...new Set([on && on.id, ...((on && on.ids) || [])])].map(id => els.get(id)).filter(e => e && e.type === 'image' && !e.isDeleted).map(e => picOf(e.fileId)).filter(Boolean);
        fs.appendFileSync(EVENTS, `COMMENT by ${oneLine(shown(author))}${far ? ' via link' : ''}${on ? ` [on: ${oneLine(on.label || on.id)}]` : ''}${pics.length ? ` [pictures: ${pics.map(p => 'live/files/' + path.basename(p)).join(', ')}]` : ''}: ${oneLine(item.text)}\n`);
        return send(res, 200, item);
      }
      if (req.method === 'GET' && url.pathname === '/api/scene') return send(res, 200, { elements: [...els.values()] });
      if (req.method === 'POST' && url.pathname === '/api/scene') {
        const scene = await json(req, 10e6);
        if (scene.probe) return send(res, 200, { ok: true, quiet: true });   // a test load (?probe) never changes the board
        // Every page names itself (c). The old whole-scene overwrite with no page id is gone: one request could wipe the board.
        if (!pageId(scene.c)) return send(res, 400, { error: 'no page id' });
        if (notMine(scene.c)) return;
        const who = [authorOf(scene.name, far), far], took = [];
        let bytes = 0;
        for (const e of Array.isArray(scene.elements) ? scene.elements : []) {
          if (!okElement(e, known) || !newer(e, els.get(e.id))) continue;
          const c = cleanElement(e), size = JSON.stringify(c).length;
          if (size > ELEMENT_MAX(c) || !room(c.id, size)) continue;
          put(c, size); by.set(c.id, who); took.push(c); bytes += size;
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
    } catch (e) { if (!e.status) console.error('ERROR', e.message); if (!res.headersSent) send(res, e.status || 500, { error: e.message }, 'application/json', e.status === 413 ? { connection: 'close' } : {}); }
  });
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `port ${port} is taken: pass --port <another>` : e.message); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`board on http://localhost:${port} (only this computer can reach it)`));
  return server;
}

// Open the running board to teammates: a Cloudflare quick tunnel (no account, a random trycloudflare.com name) plus a
// fresh secret key. The key lives in live/share.json only while this process runs; the server checks that this process
// is alive, so a killed share closes the door even if the tunnel lingers.
// share.json holds the link's key: readable by its owner only, even where an older copy was looser.
export function writeShare(file, data) { fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); fs.chmodSync(file, 0o600); }
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
