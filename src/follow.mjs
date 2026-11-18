// What wakes the agent: the person's comments, their answers on its tour steps, and text people write on the canvas, as
// events. One follower for all three ways an agent hears them: the channel push (mcp --channels), board_wait, and
// `whiteboard-agents wait`. It watches the call's folder (fs.watch, no polling) and reads only what was added.
//
// Never an event: the agent's own replies (author "claude"), its own note, arrow and edit text while unchanged (the server
// leaves those out of canvas.jsonl), TOUR lines (they are only in events.log, which isn't read here), and an answer on a
// tour another presenter runs.
import fs from 'node:fs';
import path from 'node:path';
import { files, samePresenter, shown, mkdirSafe, readSafe, HOME, BREAKS, ID } from './server.mjs';

// Everything in an event came from a commenter, so it is cleaned the way it reaches the agent's context: each field is one
// line of at most 120 characters with no quotes or angle brackets (they could break out of a <channel …> tag); the text
// keeps its line breaks, loses every other control character, and has < and > as ‹ and ›; ids pass only when id-shaped,
// and box_ids keeps every id whole (at most 50).
const field = (v, k) => { const t = String(v).replace(BREAKS, ' ').replace(/"/g, "'").replace(/</g, '‹').replace(/>/g, '›').replace(/\s+/g, ' ').trim(); return k === 'box_ids' ? t : t.slice(0, 120); };
const text = v => String(v ?? '').replace(BREAKS, b => b.replace(/[^\n]/g, ' ')).replace(/</g, '‹').replace(/>/g, '›');
const idOf = v => typeof v === 'string' && ID.test(v) ? v : undefined;
const idsOf = v => Array.isArray(v) ? v.slice(0, 50).map(idOf).filter(Boolean).join(',') : undefined;
const areaOf = on => on?.rect && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(on.rect[k])) ? ['x', 'y', 'w', 'h'].map(k => Math.round(on.rect[k])).join(',') : undefined;
const pack = (id, content, meta) => ({ id, content: text(content),
  meta: Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, field(v, k)]).filter(([, v]) => v !== '')) });

// One record line as an event for the session presenting as `me`, or null. `source` is "thread" or "canvas".
export function eventOf(source, it, board, me) {
  if (!it || typeof it !== 'object') return null;
  if (source === 'canvas') {
    const who = `${shown(it.author)}${it.via ? ' via link' : ''}`;
    // many changes from one person (or from the link) since the last check come as one, with the count and the last one
    const say = it.change === 'many' ? `${it.who || who} changed ${it.count} texts on the board, the last ${it.key} to "${it.text}"`
      : it.change === 'changed' ? `${who} changed ${it.key} to "${it.text}"` : `${who} wrote "${it.text}" (${it.key})`;
    return pack(idOf(it.id), say, { kind: 'board', board, element_id: idOf(it.el), author: it.author || HOME, via: it.via, count: it.change === 'many' ? it.count : undefined, ts: it.ts });
  }
  const on = it.on && typeof it.on === 'object' ? it.on : it.on ? { id: it.on } : null;
  if (it.kind === 'op' && it.op === 'answer') {
    if (!samePresenter(it.presenter, me)) return null;
    return pack(idOf(it.id), it.pick === 'keep' ? `✓ keep${it.text ? ` · ${it.text}` : ''}` : `✎ change → ${it.text}`, { kind: 'answer', board, answer_id: idOf(it.id),
      author: it.author || HOME, via: it.via, tour_id: idOf(it.tour_id), step: it.step, pick: it.pick, question: it.question, box_id: idOf(on?.id),
      box_label: on?.label, box_ids: idsOf(on?.ids), area: areaOf(on), ts: it.ts });
  }
  if (it.kind !== 'comment' || it.author === 'claude') return null;
  return pack(idOf(it.id), it.text, { kind: 'comment', board, comment_id: idOf(it.id), author: it.author || HOME, via: it.via, box_id: idOf(on?.id), box_label: on?.label,
    box_ids: idsOf(on?.ids), area: areaOf(on), tour_id: idOf(on?.tour), step: on?.step, ts: it.ts });
}
// The JSON an agent gets from `whiteboard-agents wait` and board_wait: the event's id, its fields, and the text.
export const flatEvent = ev => ({ id: ev.id, ...ev.meta, content: ev.content });

const linesOf = f => { try { return readSafe(f).split('\n'); } catch { return []; } };
// Where to start reading each file: their ends, or (with `since`, an event id) just after that event, so whatever came in
// after it is read first. Throws if `since` isn't in the record.
function startAt(f, since) {
  const end = p => { try { return fs.statSync(p).size; } catch { return 0; } };
  if (!since) return { thread: end(f.thread), canvas: end(f.canvas) };
  const pos = {}; let ts = null;
  for (const [k, p] of [['thread', f.thread], ['canvas', f.canvas]]) {
    let at = 0;
    for (const l of linesOf(p)) { at += Buffer.byteLength(l) + 1; try { const it = JSON.parse(l); if (it.id === since) { pos[k] = at; ts = it.ts; } } catch { /* a partial line */ } }
  }
  if (ts == null) throw new Error(`no event ${since} in the record`);
  // The other file: after its last line from no later than that event.
  for (const [k, p] of [['thread', f.thread], ['canvas', f.canvas]]) {
    if (pos[k] != null) continue;
    let at = 0; pos[k] = 0;
    for (const l of linesOf(p)) { at += Buffer.byteLength(l) + 1; try { if (JSON.parse(l).ts <= ts) pos[k] = at; } catch { /* a partial line */ } }
  }
  return pos;
}

// Follow a board's record: onEvent(event) for each new one. Returns stop(). `me` is the presenter whose answers count
// (a name, or a function returning the current one).
export function follow(dir, onEvent, { me = 'Claude', since } = {}) {
  const f = files(dir), board = path.basename(dir);
  mkdirSafe(f.live);
  const pos = startAt(f, since), rest = { thread: '', canvas: '' };
  const read = k => {
    const p = f[k]; let size; try { const st = fs.lstatSync(p); if (!st.isFile() || st.nlink > 1) return; size = st.size; } catch { return; }   // never through a link, nor a file with another name
    if (size < pos[k]) { pos[k] = 0; rest[k] = ''; }   // the file was replaced
    if (size === pos[k]) return;
    const fd = fs.openSync(p, 'r'), buf = Buffer.alloc(size - pos[k]);
    try { fs.readSync(fd, buf, 0, buf.length, pos[k]); } finally { fs.closeSync(fd); }
    pos[k] = size;
    const lines = (rest[k] + buf.toString('utf8')).split('\n'); rest[k] = lines.pop();
    for (const l of lines) { if (!l.trim()) continue; let ev = null; try { ev = eventOf(k, JSON.parse(l), board, typeof me === 'function' ? me() : me); } catch { /* not a record line */ } if (ev) onEvent(ev); }
  };
  const check = () => { read('thread'); read('canvas'); };
  // One watch on the folder catches both files, including one that doesn't exist yet. Where the platform has no folder
  // watch, both files are checked four times a second instead.
  let stop;
  try { const w = fs.watch(f.live, { persistent: true }, (_, name) => { if (!name || name === 'thread.jsonl' || name === 'canvas.jsonl') check(); }); stop = () => w.close(); }
  catch { for (const p of [f.thread, f.canvas]) fs.watchFile(p, { interval: 250 }, check); stop = () => { fs.unwatchFile(f.thread); fs.unwatchFile(f.canvas); }; }
  check();   // with `since`, whatever is already there after it
  return stop;
}
