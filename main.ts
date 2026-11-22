// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A file's lines with its line break and final-break flag (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Strip trailing spaces/tabs (tier 1) or leading and trailing spaces/tabs (tier 2). */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}
/** All 0-based positions where O occurs in fileLines at the given tier (overlapping allowed). */
function occurrencesAt(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > fileLines.length) return out;
  const on = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(fileLines[i + j]!, tier) !== on[j]!) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** First tier (0, then 1, then 2; strict: 0 only) with at least one occurrence, and its positions. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(fileLines, o, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}
/** Leading spaces and tabs of a line. */
function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/**
 * Build the lines replacing O at position pos in fileLines.
 * nCtx[j] is the O index of N[j] when N[j] is a context line, else -1.
 * Context lines are written as the file's own matched lines, never the patch's.
 * At tier 2 every other non-empty, non-whitespace-only N line starting with P has
 * that P replaced by F, where F is the leading whitespace of the file's first
 * matched line and P that of O's first line.
 */
function replacementLines(fileLines: string[], pos: number, o: string[], n: string[], nCtx: number[], tier: number): string[] {
  const out: string[] = [];
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(o[0] ?? '');
  for (let j = 0; j < n.length; j++) {
    const ctx = nCtx[j]!;
    if (ctx >= 0) {
      out.push(fileLines[pos + ctx]!);
      continue;
    }
    const line = n[j]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) {
      out.push(f + line.slice(p.length));
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Successful moves (old, new) in patch order, for R-line output; truncated on edit rollback. */
const moves: Array<[string, string]> = [];

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}
/** A parsed hunk: its old start line A and its body lines (trailing empty context lines removed). */
interface Hunk {
  a: number;
  body: BodyLine[];
}
/** Split a hunk/chunk body into O (context + old), N (context + new) and the context map for N. */
function hunkON(body: BodyLine[]): { o: string[]; n: string[]; nCtx: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      nCtx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      nCtx.push(-1);
      n.push(b.text);
    }
  }
  return { o, n, nCtx };
}
/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'backslash';
}

/** A parsed unified section: one edit. */
interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
/** The path after `--- ` / `+++ `: text after four chars, up to the first tab, trimmed, leading a/ or b/ removed. */
function unifiedPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    let kind: 'create' | 'delete' | 'move' | 'change';
    if ((s.oldPath === null || s.newFile) && s.newPath !== null) kind = 'create';
    else if ((s.newPath === null || s.deletedFile) && s.oldPath !== null) kind = 'delete';
    else if (s.oldPath !== null && s.newPath !== null && s.oldPath !== s.newPath) kind = 'move';
    else kind = 'change';
    if (kind === 'create') {
      const p = s.newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlus: { h: number; b: number } | null = null;
      s.hunks.forEach((h, hi) => {
        h.body.forEach((bl, bi) => {
          if (bl.kind === 'new') {
            plus.push(bl.text);
            lastPlus = { h: hi, b: bi };
          }
        });
      });
      let final = true;
      if (lastPlus) {
        const body = s.hunks[lastPlus.h]!.body;
        if (body[lastPlus.b + 1]?.kind === 'backslash') final = false;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const p = s.oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = s.oldPath ?? '';
    const dst = kind === 'move' ? s.newPath ?? '' : src;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (kind === 'move' && !safe(dst)) throw new Fail('unsafe', dst);
    const cur = tree.get(src);
    if (cur === null) throw new Fail('missing', src);
    if (kind === 'move' && tree.get(dst) !== null) throw new Fail('exists', dst);
    const f = splitFile(cur);
    let lines = f.lines;
    let final = f.final;
    let d = 0;
    for (const h of s.hunks) {
      const { o, n, nCtx } = hunkON(h.body);
      if (o.length === 0) {
        const beforeLen = lines.length;
        const ins = Math.min(Math.max(h.a + d, 0), lines.length);
        lines = [...lines.slice(0, ins), ...n, ...lines.slice(ins)];
        d += n.length;
        if (ins === beforeLen) final = !hunkNoEol(h.body);
        continue;
      }
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', src);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const rep = replacementLines(lines, best, o, n, nCtx, found.tier);
      const touchesEof = best + o.length === lines.length;
      lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
      d += n.length - o.length;
      if (touchesEof) final = !hunkNoEol(h.body);
    }
    tree.now.set(dst, joinFile({ lines, br: f.br, final }));
    if (kind === 'move') {
      tree.now.set(src, null);
      moves.push([src, dst]);
    }
  };
}

/** Parse a unified diff (SPEC.md section 6) into one Edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const startSection = (): Section => {
    const s: Section = { oldPath: null, newPath: null, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let cur: Section | null = null;
  let inHeader = false;
  let sawPaths = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const body: BodyLine[] = [];
      i++;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '' });
          i++;
        } else if (bl.startsWith(' ')) {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          i++;
        } else if (bl.startsWith('-')) {
          body.push({ kind: 'old', text: bl.slice(1) });
          i++;
        } else if (bl.startsWith('+')) {
          body.push({ kind: 'new', text: bl.slice(1) });
          i++;
        } else if (bl.startsWith('\\')) {
          body.push({ kind: 'backslash', text: bl.slice(1) });
          i++;
        } else break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a, body });
      inHeader = false;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      cur.oldPath = m[1]!;
      cur.newPath = m[2]!;
      inHeader = true;
      sawPaths = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = unifiedPath(line);
      const newP = unifiedPath(lines[i + 1]!);
      if (cur !== null && inHeader && !sawPaths) {
        cur.oldPath = oldP === '/dev/null' ? null : oldP;
        cur.newPath = newP === '/dev/null' ? null : newP;
        sawPaths = true;
      } else {
        cur = startSection();
        cur.oldPath = oldP === '/dev/null' ? null : oldP;
        cur.newPath = newP === '/dev/null' ? null : newP;
        inHeader = true;
        sawPaths = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const nCtx = newLines.map(() => -1);
    const rep = replacementLines(f.lines, pos, oldLines, newLines, nCtx, found.tier);
    const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7) into one Edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    let k = s + 1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        if (eq < 0) eq = k;
      } else if (t === '>>>>>>> REPLACE') {
        if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
        rep = k;
        break;
      } else if (t === '<<<<<<< SEARCH') {
        throw new Exit2(`error: parse ${s + 1}`);
      }
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: optional anchor, end-of-file flag, and body lines. */
interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}
/** A parsed V4A section: one edit. */
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: Chunk[];
}
const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(cur);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let foundIdx = -1;
        for (const tier of tiers) {
          const an = norm(ch.anchor, tier);
          for (let k = cursor; k < lines.length; k++) {
            if (norm(lines[k]!, tier) === an) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', s.path);
        cursor = foundIdx + 1;
      }
      const { o, n, nCtx } = hunkON(ch.body);
      if (o.length === 0) {
        const ins = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines = [...lines.slice(0, ins), ...n, ...lines.slice(ins)];
        cursor = ins + n.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let tier = -1;
      let positions: number[] = [];
      for (const t of tiers) {
        const occ = occurrencesAt(lines, o, t).filter((p) => p >= cursor);
        if (occ.length > 0) {
          tier = t;
          positions = occ;
          break;
        }
      }
      if (tier < 0) throw new Fail('no-match', s.path);
      let pos: number;
      if (ch.eof) {
        const eofPos = positions.filter((p) => p + o.length === lines.length);
        if (eofPos.length === 0) throw new Fail('no-match', s.path);
        pos = eofPos[0]!;
      } else {
        pos = positions[0]!;
      }
      const rep = replacementLines(lines, pos, o, n, nCtx, tier);
      lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
      cursor = pos + rep.length;
    }
    const dst = s.moveTo ?? s.path;
    tree.now.set(dst, joinFile({ lines, br: f.br, final: f.final }));
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      moves.push([s.path, s.moveTo]);
    }
  };
}

/** Parse a V4A patch (SPEC.md section 8) into one Edit per section. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i;
    i++;
    if (kind === 'add') {
      const addLines: string[] = [];
      while (i < end) {
        const l = lines[i]!;
        if (isV4aSectionStart(l)) break;
        if (l.startsWith('+')) {
          addLines.push(l.slice(1));
          i++;
        } else if (l === '') {
          addLines.push('');
          i++;
        } else if (blank(l)) {
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      edits.push(v4aEdit({ kind, path, moveTo: null, addLines, chunks: [] }, strict));
      continue;
    }
    if (kind === 'delete') {
      while (i < end && blank(lines[i]!)) i++;
      edits.push(v4aEdit({ kind, path, moveTo: null, addLines: [], chunks: [] }, strict));
      continue;
    }
    let moveTo: string | null = null;
    while (i < end && blank(lines[i]!)) i++;
    if (i < end && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    const chunks: Chunk[] = [];
    let firstChunk = true;
    while (i < end) {
      if (!firstChunk && blank(lines[i]!)) {
        i++;
        continue;
      }
      if (firstChunk) {
        let j = i;
        while (j < end && blank(lines[j]!)) j++;
        if (j >= end || isV4aSectionStart(lines[j]!)) {
          i = j;
          break;
        }
      }
      const l = lines[i]!;
      if (isV4aSectionStart(l)) break;
      let anchor: string | null = null;
      if (l.startsWith('@@')) {
        anchor = l.slice(2).trim();
        if (anchor === '') anchor = null;
        i++;
      } else if (!firstChunk) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const body: BodyLine[] = [];
      let eof = false;
      while (i < end) {
        const bl = lines[i]!;
        if (bl === '*** End of File') {
          eof = true;
          i++;
          break;
        }
        if (bl.startsWith('@@') || isV4aSectionStart(bl)) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '' });
          i++;
        } else if (bl.startsWith(' ')) {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          i++;
        } else if (bl.startsWith('-')) {
          body.push({ kind: 'old', text: bl.slice(1) });
          i++;
        } else if (bl.startsWith('+')) {
          body.push({ kind: 'new', text: bl.slice(1) });
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (body.length > 0) {
        const lastB = body[body.length - 1]!;
        if (lastB.kind === 'ctx' && lastB.text === '') body.pop();
        else break;
      }
      chunks.push({ anchor, eof, body });
      firstChunk = false;
    }
    if (chunks.length === 0 && moveTo === null) {
      throw new Exit2(`error: parse ${headerLine + 1}`);
    }
    edits.push(v4aEdit({ kind, path, moveTo, addLines: [], chunks }, strict));
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  moves.length = 0;
  for (const edit of edits) {
    const before = new Map(tree.now);
    const m0 = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = m0;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  // Pair successful moves into R lines (SPEC.md section 2): a move's old path
  // existed before and does not after, and its new path did not exist before and does after.
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const entries: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      movedOld.add(oldP);
      movedNew.add(newP);
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
