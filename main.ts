// mend: applies AI-written edits (unified diff, SEARCH/REPLACE, V4A, JSON)
// to a tree of text files. Written from SPEC.md. Node 22, stdlib only.
import { readFileSync, writeFileSync, mkdirSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

type Br = '\n' | '\r\n';
interface FileDoc { lines: string[]; br: Br; fin: boolean; }

class ParseErr extends Error {
  line: number;
  constructor(line: number) { super(`parse ${line}`); this.line = line; }
}
class Fail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) { super(`${code} ${path}`); this.code = code; this.path = path; }
}

const blank = (s: string): boolean => /^\s*$/.test(s);
const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };
const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// Patch lines: split at \n, one trailing \r removed, no empty piece after final \n.
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A file's line break is CRLF when its first LF follows a CR, else LF.
function parseDoc(text: string): FileDoc {
  const i = text.indexOf('\n');
  const br: Br = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.length > 0 && text.endsWith(br);
  let lines = text.split(br);
  if (fin) lines.pop();
  if (text === '') lines = [];
  return { lines, br, fin };
}
function serDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.fin ? d.br : '');
}

function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface Edit {
  paths: string[]; // paths the edit names, safety-checked in order before anything else
  apply(t: Tree): Fail | null;
}

class Tree {
  now = new Map<string, string | null>(); // paths touched by edits (null = deleted)
  private origCache = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null;
      try { v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p)!;
  }
  get(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p)!;
    return this.original(p);
  }
  exists(p: string): boolean { return this.get(p) !== null; }
  set(p: string, text: string): void { this.now.set(p, text); }
  del(p: string): void { this.now.set(p, null); }
  doc(p: string): FileDoc { return parseDoc(this.get(p)!); }
}

// ---- matching, section 5 ----
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}
function occs(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j], o[j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const oc = occs(lines, o, t);
    if (oc.length > 0) return { tier: t, occ: oc };
  }
  return null;
}

// One line of N: ctx >= 0 means a context line, written as the file's own
// matched line at that index into O; ctx -1 means a fresh new line.
interface NLine { text: string; ctx: number; }
function reindent(line: string, f: string, p: string): string {
  if (line === '' || blank(line) || !line.startsWith(p)) return line;
  return f + line.slice(p.length);
}
function spliceLines(lines: string[], pos: number, olen: number, n: NLine[], tier: number, o: string[]): string[] {
  const f = o.length > 0 ? lead(lines[pos]) : '';
  const p = o.length > 0 ? lead(o[0]) : '';
  const built = n.map((nl) => {
    if (nl.ctx >= 0) return lines[pos + nl.ctx];
    return tier === 2 ? reindent(nl.text, f, p) : nl.text;
  });
  return [...lines.slice(0, pos), ...built, ...lines.slice(pos + olen)];
}

// ---- applying edits, section 10 ----
function applyEdits(t: Tree, edits: Edit[]): Fail[] {
  const fails: Fail[] = [];
  for (const e of edits) {
    let f: Fail | null = null;
    for (const p of e.paths) {
      if (!safePath(p)) { f = new Fail('unsafe', p); break; }
    }
    if (!f) f = e.apply(t);
    if (f) fails.push(f);
  }
  return fails;
}
function outputRows(t: Tree): { key: string; line: string }[] {
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const [o, n] of t.moves) {
    if (t.original(o) !== null && t.get(o) === null && t.original(n) === null && t.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const p of [...t.now.keys()].sort(byteCmp)) {
    if (used.has(p)) continue;
    const was = t.original(p);
    const cur = t.now.get(p)!;
    if (was === cur) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : cur === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  return rows;
}
function writeTree(t: Tree): void {
  for (const p of [...t.now.keys()].sort(byteCmp)) {
    const was = t.original(p);
    const cur = t.now.get(p)!;
    if (was === cur) continue;
    if (cur === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, cur);
    }
  }
}

// ---- unified diff, section 6 ----
interface Hunk { a: number; o: string[]; n: NLine[]; noeol: boolean; lastIsNew: boolean; }
interface Section {
  hdrOld: string | null; hdrNew: string | null;
  renOld: string | null; renNew: string | null;
  dgOld: string | null; dgNew: string | null;
  isCreate: boolean; isDelete: boolean; hunks: Hunk[];
}
const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
const hdrPath = (l: string): string => l.slice(4).split('\t')[0].trim();

function parseHunkBody(lines: string[], i: number, a: number): { hunk: Hunk; next: number } {
  const n = lines.length;
  const entries: Array<{ k: string; text: string }> = [];
  let j = i;
  while (j < n) {
    const l = lines[j];
    if (l.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
    if (l.startsWith('diff --git ')) break;
    if (l === '') entries.push({ k: 'ctx', text: '' });
    else if (l[0] === ' ') entries.push({ k: 'ctx', text: l.slice(1) });
    else if (l[0] === '-') entries.push({ k: 'old', text: l.slice(1) });
    else if (l[0] === '+') entries.push({ k: 'new', text: l.slice(1) });
    else if (l[0] === '\\') entries.push({ k: 'nl', text: '' });
    else break;
    j++;
  }
  while (entries.length > 0 && entries[entries.length - 1].k === 'ctx' && entries[entries.length - 1].text === '') entries.pop();
  const o: string[] = [];
  const nn: NLine[] = [];
  for (const e of entries) {
    if (e.k === 'ctx') { o.push(e.text); nn.push({ text: e.text, ctx: o.length - 1 }); }
    else if (e.k === 'old') o.push(e.text);
    else if (e.k === 'new') nn.push({ text: e.text, ctx: -1 });
  }
  let noeol = false;
  let lastIsNew = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k].k === 'ctx' || entries[k].k === 'new') {
      lastIsNew = entries[k].k === 'new';
      noeol = k + 1 < entries.length && entries[k + 1].k === 'nl';
      break;
    }
  }
  return { hunk: { a, o, n: nn, noeol, lastIsNew }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const secs: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  const finish = (): void => { if (sec) secs.push(sec); sec = null; };
  const newSec = (s: Section): void => { finish(); sec = s; inHeader = true; };
  let i = 0;
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new ParseErr(i + 1);
      newSec({ hdrOld: null, hdrNew: null, renOld: null, renNew: null, dgOld: m[1], dgNew: m[2], isCreate: false, isDelete: false, hunks: [] });
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (!sec) throw new ParseErr(i + 1);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) throw new ParseErr(i + 1);
      const r = parseHunkBody(lines, i + 1, Number(m[1]));
      sec.hunks.push(r.hunk);
      inHeader = false;
      i = r.next;
      continue;
    }
    if (sec && inHeader) {
      if (l.startsWith('--- ')) {
        if (i + 1 >= n || !lines[i + 1].startsWith('+++ ')) throw new ParseErr(i + 2);
        if (sec.hdrOld === null) sec.hdrOld = stripAB(hdrPath(l));
        if (sec.hdrNew === null) sec.hdrNew = stripAB(hdrPath(lines[i + 1]));
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) sec.renOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.isCreate = true;
      else if (l.startsWith('deleted file mode')) sec.isDelete = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      newSec({ hdrOld: stripAB(hdrPath(l)), hdrNew: stripAB(hdrPath(lines[i + 1])), renOld: null, renNew: null, dgOld: null, dgNew: null, isCreate: false, isDelete: false, hunks: [] });
      i += 2;
      continue;
    }
    i++;
  }
  finish();
  if (secs.length === 0) throw new ParseErr(1);
  return secs.map((s) => unifiedEdit(s, strict));
}

function applyHunk(doc: FileDoc, h: Hunk, d: number, strict: boolean): FileDoc | null {
  const lines = doc.lines;
  let fin = doc.fin;
  if (h.o.length > 0) {
    const f = findTier(lines, h.o, strict);
    if (!f) return null;
    const target = h.a - 1 + d;
    let best = f.occ[0];
    let bd = Math.abs(best - target);
    for (const p of f.occ) {
      const dd = Math.abs(p - target);
      if (dd < bd) { bd = dd; best = p; }
    }
    if (best + h.o.length === lines.length) fin = !h.noeol;
    return { lines: spliceLines(lines, best, h.o.length, h.n, f.tier, h.o), br: doc.br, fin };
  }
  const pos = Math.min(h.a + d, lines.length);
  if (pos === lines.length) fin = !h.noeol;
  return { lines: spliceLines(lines, pos, 0, h.n, 0, []), br: doc.br, fin };
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const rawOld = s.hdrOld ?? s.renOld ?? s.dgOld;
  const rawNew = s.hdrNew ?? s.renNew ?? s.dgNew;
  const oldP = rawOld === '/dev/null' ? null : rawOld;
  const newP = rawNew === '/dev/null' ? null : rawNew;
  const isCreate = s.isCreate || oldP === null;
  const isDelete = !isCreate && (s.isDelete || newP === null);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  const paths: string[] = [];
  if (isCreate && newP !== null) paths.push(newP);
  else if (isDelete && oldP !== null) paths.push(oldP);
  else if (isMove) { paths.push(oldP!); paths.push(newP!); }
  else if (oldP !== null) paths.push(oldP);
  return {
    paths,
    apply(t: Tree): Fail | null {
      if (isCreate) {
        if (newP === null) return new Fail('unsafe', '');
        if (t.exists(newP)) return new Fail('exists', newP);
        const plus: string[] = [];
        for (const h of s.hunks) for (const nl of h.n) if (nl.ctx === -1) plus.push(nl.text);
        let fin = true;
        for (let k = s.hunks.length - 1; k >= 0; k--) {
          const h = s.hunks[k];
          if (h.n.some((nl) => nl.ctx === -1)) { fin = !(h.noeol && h.lastIsNew); break; }
        }
        t.set(newP, serDoc({ lines: plus, br: '\n', fin: plus.length > 0 && fin }));
        return null;
      }
      if (isDelete) {
        if (oldP === null) return new Fail('unsafe', '');
        if (!t.exists(oldP)) return new Fail('missing', oldP);
        t.del(oldP);
        return null;
      }
      const src = oldP!;
      if (!t.exists(src)) return new Fail('missing', src);
      if (isMove && t.exists(newP!)) return new Fail('exists', newP!);
      let doc = t.doc(src);
      let d = 0;
      for (const h of s.hunks) {
        const r = applyHunk(doc, h, d, strict);
        if (!r) return new Fail('no-match', src);
        d += h.n.length - h.o.length;
        doc = r;
      }
      const text = serDoc(doc);
      if (isMove) {
        t.set(newP!, text);
        t.del(src);
        t.moves.push([src, newP!]);
      } else t.set(src, text);
      return null;
    },
  };
}

// ---- SEARCH/REPLACE, section 7 ----
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let prevEnd = 0; // line after previous block's >>>>>>> REPLACE
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i].replace(/\s+$/, '') !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < n; j++) {
      const t = lines[j].replace(/\s+$/, '');
      if (t === '=======') { if (eq === -1) eq = j; continue; }
      if (t === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (eq === -1 || rep === -1) throw new ParseErr(searchLine + 1);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseErr(searchLine + 1);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push({
      paths: [p],
      apply(t: Tree): Fail | null {
        if (oldLines.length === 0) {
          if (t.exists(p)) return new Fail('exists', p);
          t.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
          return null;
        }
        if (!t.exists(p)) return new Fail('missing', p);
        const doc = t.doc(p);
        const f = findTier(doc.lines, oldLines, strict);
        if (!f) return new Fail('no-match', p);
        if (f.occ.length > 1) return new Fail('ambiguous', p);
        const nl: NLine[] = newLines.map((text) => ({ text, ctx: -1 }));
        t.set(p, serDoc({ lines: spliceLines(doc.lines, f.occ[0], oldLines.length, nl, f.tier, oldLines), br: doc.br, fin: doc.fin }));
        return null;
      },
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---- V4A, section 8 ----
interface V4aChunk { anchor: string | null; o: string[]; n: NLine[]; eof: boolean; }
interface V4aSection { kind: 'add' | 'del' | 'upd'; path: string; moveTo: string | null; lines: string[]; chunks: V4aChunk[]; lineNo: number; }

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let k = 0; k < n; k++) {
    if (!blank(lines[k])) { if (first === -1) first = k; last = k; }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(n + 1);
  const secs: V4aSection[] = [];
  let cur: V4aSection | null = null;
  let chunk: V4aChunk | null = null;
  const closeChunk = (): void => { if (chunk && cur) cur.chunks.push(chunk); chunk = null; };
  const closeSec = (): void => {
    closeChunk();
    if (cur) {
      while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
      if (cur.kind === 'upd' && cur.chunks.length > 0) {
        const c = cur.chunks[cur.chunks.length - 1];
        while (c.o.length > 0 && c.o[c.o.length - 1] === '' && c.n.length > 0 && c.n[c.n.length - 1].ctx === c.o.length - 1) {
          c.o.pop();
          c.n.pop();
        }
      }
      secs.push(cur);
    }
    cur = null;
  };
  for (let i = first + 1; i < last; i++) {
    const l = lines[i];
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      closeSec();
      const kind = l.startsWith('*** Add') ? 'add' : l.startsWith('*** Delete') ? 'del' : 'upd';
      cur = { kind, path: l.slice(l.indexOf(': ') + 2).trim(), moveTo: null, lines: [], chunks: [], lineNo: i + 1 };
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new ParseErr(i + 1);
    }
    if (cur.kind === 'add') {
      if (l.startsWith('+')) cur.lines.push(l.slice(1));
      else if (l === '') cur.lines.push('');
      else throw new ParseErr(i + 1);
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(l)) continue;
      throw new ParseErr(i + 1);
    }
    // update section
    if (l.startsWith('*** Move to: ')) {
      if (cur.chunks.length > 0 || chunk !== null || cur.moveTo !== null) throw new ParseErr(i + 1);
      cur.moveTo = l.slice('*** Move to: '.length).trim();
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk();
      chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), o: [], n: [], eof: false };
      continue;
    }
    if (l === '*** End of File') {
      if (!chunk) throw new ParseErr(i + 1);
      chunk.eof = true;
      closeChunk();
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (!chunk) chunk = { anchor: null, o: [], n: [], eof: false };
      if (l === '') { chunk.o.push(''); chunk.n.push({ text: '', ctx: chunk.o.length - 1 }); }
      else if (l[0] === ' ') { chunk.o.push(l.slice(1)); chunk.n.push({ text: l.slice(1), ctx: chunk.o.length - 1 }); }
      else if (l[0] === '-') chunk.o.push(l.slice(1));
      else chunk.n.push({ text: l.slice(1), ctx: -1 });
      continue;
    }
    throw new ParseErr(i + 1);
  }
  closeSec();
  if (secs.length === 0) throw new ParseErr(1);
  for (const s of secs) {
    if (s.kind === 'upd' && s.chunks.length === 0 && s.moveTo === null) throw new ParseErr(s.lineNo);
  }
  return secs.map((s) => v4aEdit(s, strict));
}

function matchSingle(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i], anchor, t)) return i;
    }
  }
  return -1;
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  const paths: string[] = [s.path];
  if (s.moveTo !== null) paths.push(s.moveTo);
  return {
    paths,
    apply(t: Tree): Fail | null {
      if (s.kind === 'add') {
        if (t.exists(s.path)) return new Fail('exists', s.path);
        t.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
        return null;
      }
      if (s.kind === 'del') {
        if (!t.exists(s.path)) return new Fail('missing', s.path);
        t.del(s.path);
        return null;
      }
      if (!t.exists(s.path)) return new Fail('missing', s.path);
      if (s.moveTo !== null && t.exists(s.moveTo)) return new Fail('exists', s.moveTo);
      let doc = t.doc(s.path);
      let cursor = 0;
      for (const c of s.chunks) {
        let lines = doc.lines;
        if (c.anchor !== null) {
          const ai = matchSingle(lines, c.anchor, cursor, strict);
          if (ai === -1) return new Fail('no-match', s.path);
          cursor = ai + 1;
        }
        if (c.o.length === 0) {
          const pos = c.eof ? lines.length : cursor;
          lines = spliceLines(lines, pos, 0, c.n, 0, []);
          cursor = pos + c.n.length;
        } else {
          const tiers = strict ? [0] : [0, 1, 2];
          let found: { tier: number; pos: number } | null = null;
          for (const tier of tiers) {
            const oc = occs(lines, c.o, tier).filter((p) => p >= cursor && (!c.eof || p + c.o.length === lines.length));
            if (oc.length > 0) { found = { tier, pos: oc[0] }; break; }
          }
          if (!found) return new Fail('no-match', s.path);
          lines = spliceLines(lines, found.pos, c.o.length, c.n, found.tier, c.o);
          cursor = found.pos + c.n.length;
        }
        doc = { lines, br: doc.br, fin: doc.fin };
      }
      const text = serDoc(doc);
      if (s.moveTo !== null) {
        t.set(s.moveTo, text);
        t.del(s.path);
        t.moves.push([s.path, s.moveTo]);
      } else t.set(s.path, text);
      return null;
    },
  };
}

// ---- JSON, section 9 ----
type JsonEdit = { command: string; path: string; file_text?: string; old_str?: string; new_str?: string; insert_line?: number };
function validJsonEdit(v: unknown): JsonEdit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { command: 'str_replace', path: o.path, old_str: o.old_str, new_str: o.new_str === undefined ? '' : o.new_str };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { command: 'insert', path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}
function countOcc(text: string, sub: string): number {
  let n = 0;
  let i = text.indexOf(sub);
  while (i !== -1) { n++; i = text.indexOf(sub, i + 1); }
  return n;
}
function jsonEditToEdit(e: JsonEdit): Edit {
  return {
    paths: [e.path],
    apply(t: Tree): Fail | null {
      if (e.command === 'create') {
        if (t.exists(e.path)) return new Fail('exists', e.path);
        t.set(e.path, e.file_text!);
        return null;
      }
      if (!t.exists(e.path)) return new Fail('missing', e.path);
      if (e.command === 'str_replace') {
        const raw = t.get(e.path)!;
        const crlf = parseDoc(raw).br === '\r\n';
        const norm = (s: string): string => (crlf ? s.replace(/\r\n/g, '\n') : s);
        const text = norm(raw);
        const oldS = norm(e.old_str!);
        const newS = norm(e.new_str!);
        const n = countOcc(text, oldS);
        if (n === 0) return new Fail('no-match', e.path);
        if (n > 1) return new Fail('ambiguous', e.path);
        const out = text.replace(oldS, newS);
        t.set(e.path, crlf ? out.replace(/\n/g, '\r\n') : out);
        return null;
      }
      // insert
      const doc = t.doc(e.path);
      const ins = e.insert_line!;
      if (ins < 0 || ins > doc.lines.length) return new Fail('no-match', e.path);
      const parts = e.new_str!.split('\n');
      if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
      const insLines = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
      const lines = [...doc.lines.slice(0, ins), ...insLines, ...doc.lines.slice(ins)];
      t.set(e.path, serDoc({ lines, br: doc.br, fin: doc.fin }));
      return null;
    },
  };
}
function parseJson(text: string): Edit[] {
  const lines = splitPatch(text);
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!blank(lines[k])) { first = k; break; }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trimStart().startsWith('[')) {
    let arr: unknown;
    try { arr = JSON.parse(text); } catch { throw new ParseErr(first + 1); }
    if (!Array.isArray(arr)) throw new ParseErr(first + 1);
    const edits: Edit[] = [];
    for (const v of arr) {
      const e = validJsonEdit(v);
      if (!e) throw new ParseErr(first + 1);
      edits.push(jsonEditToEdit(e));
    }
    if (edits.length === 0) throw new ParseErr(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (blank(lines[k])) continue;
    let v: unknown;
    try { v = JSON.parse(lines[k]); } catch { throw new ParseErr(k + 1); }
    const e = validJsonEdit(v);
    if (!e) throw new ParseErr(k + 1);
    edits.push(jsonEditToEdit(e));
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---- format detection, section 4 ----
function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!blank(lines[k])) { first = k; break; }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (l.replace(/\s+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---- invocation, sections 1-2 ----
const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'];
interface Args { format: string; check: boolean; strict: boolean; patch: string | null; }
function parseArgs(argv: string[]): Args | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let noMoreOpts = false;
  for (const a of argv) {
    if (!noMoreOpts && a === '--') { noMoreOpts = true; continue; }
    if (!noMoreOpts && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        format = a.slice('--format='.length);
        if (!FORMATS.includes(format)) return null;
      } else if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else return null;
      continue;
    }
    if (patch !== null) return null;
    patch = a;
  }
  return { format, check, strict, patch };
}

function run(argv: string[]): { code: number; out: string[] } {
  const args = parseArgs(argv);
  if (!args) return { code: 2, out: ['error: usage'] };
  let patchText: string;
  try {
    patchText = args.patch === null || args.patch === '-' ? readFileSync(0, 'utf8') : readFileSync(args.patch, 'utf8');
  } catch {
    return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(patchText);
  let format = args.format;
  if (format === 'auto') {
    const d = detectFormat(lines);
    if (!d) return { code: 2, out: ['error: format'] };
    format = d;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines, args.strict);
    else if (format === 'search-replace') edits = parseSearchReplace(lines, args.strict);
    else if (format === 'v4a') edits = parseV4a(lines, args.strict);
    else edits = parseJson(patchText);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails = applyEdits(tree, edits);
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = outputRows(tree);
  if (!args.check) writeTree(tree);
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
