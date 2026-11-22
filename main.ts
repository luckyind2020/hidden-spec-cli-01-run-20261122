// mend — one patch tool for every AI edit format.
// Node 22, standard library only. Implements starter/SPEC.md v1.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, the trial runner takes over instead.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Entry dispatch lives at the end of the file: class declarations below are
// not hoisted, so calling runCli before they evaluate hits the TDZ.

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

function rtrimWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Patch lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

/** Lines of a new_str in a JSON insert: split at \n, one trailing \r removed each. */
function splitJsonLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

interface FileModel {
  brk: '\r\n' | '\n';
  lines: string[];
  ends: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { brk: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const brk: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(brk);
  const lines = text.split(brk);
  if (ends) lines.pop();
  return { brk, lines, ends };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.brk) + (m.ends ? m.brk : '');
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// Tier matching (SPEC section 5)
// ---------------------------------------------------------------------------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/** All 0-based positions where pat occurs in lines at tier, searching from `from`. */
function occurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = pat.length;
  if (n === 0) return out;
  for (let i = from; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!lineEq(lines[i + j], pat[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  positions: number[];
}

/** First tier (0, then 1, then 2) at which pat occurs at least once from `from`. */
function firstTier(lines: string[], pat: string[], from: number, maxTier: number): TierHit | null {
  for (let t = 0; t <= maxTier; t++) {
    const positions = occurrences(lines, pat, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/**
 * One line of N (the replacement lines). Context lines carry their index into O;
 * new lines carry oIndex -1.
 */
interface NItem {
  kind: 'ctx' | 'new';
  text: string;
  oIndex: number;
}

/**
 * Build the replacement lines: context lines are the file's own matched lines;
 * at tier 2 every other line is re-indented from O's first line to the file's
 * first matched line. `oldFirst` is O[0], or null when O is empty.
 */
function buildNewLines(
  items: NItem[],
  fileLines: string[],
  pos: number,
  tier: number,
  oldFirst: string | null,
): string[] {
  let p = '';
  let f = '';
  if (tier === 2 && oldFirst !== null) {
    p = leadingWs(oldFirst);
    f = leadingWs(fileLines[pos]);
  }
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + it.oIndex]);
    } else if (
      tier === 2 &&
      oldFirst !== null &&
      it.text !== '' &&
      !/^[ \t]+$/.test(it.text) &&
      it.text.startsWith(p)
    ) {
      out.push(f + it.text.slice(p.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory tree with atomicity: edits mutate the copy, disk only on exit 0.
// ---------------------------------------------------------------------------

type Fail = { code: string; path: string };

class Tree {
  private orig = new Map<string, string | null>();
  private cur = new Map<string, string | null>();

  get(path: string): string | null {
    if (this.cur.has(path)) return this.cur.get(path) as string | null;
    let text: string | null = null;
    try {
      text = readFileSync(join(process.cwd(), ...path.split('/')), 'utf8');
    } catch {
      text = null;
    }
    this.orig.set(path, text);
    this.cur.set(path, text);
    return text;
  }

  set(path: string, text: string): void {
    this.get(path);
    this.cur.set(path, text);
  }

  remove(path: string): void {
    this.get(path);
    this.cur.set(path, null);
  }

  flush(): void {
    for (const [path, text] of this.cur) {
      if (text === this.orig.get(path)) continue;
      const full = join(process.cwd(), ...path.split('/'));
      if (text === null) {
        rmSync(full, { force: true });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text, 'utf8');
      }
    }
  }

  /** Change lines for exit 0, sorted in UTF-8 byte order (R lines sort by <new>). */
  changes(moves: Array<[string, string]>): Array<{ key: string; line: string }> {
    const status = new Map<string, 'A' | 'D' | 'M'>();
    for (const [path, text] of this.cur) {
      const before = this.orig.get(path);
      if (text === null && before !== null && before !== undefined) status.set(path, 'D');
      else if (text !== null && (before === null || before === undefined)) status.set(path, 'A');
      else if (text !== null && before !== null && before !== undefined && text !== before) {
        status.set(path, 'M');
      }
    }
    const out: Array<{ key: string; line: string }> = [];
    const used = new Set<string>();
    for (const [oldP, newP] of moves) {
      if (status.get(oldP) === 'D' && status.get(newP) === 'A') {
        out.push({ key: newP, line: `R ${oldP} -> ${newP}` });
        used.add(oldP);
        used.add(newP);
      }
    }
    for (const [path, kind] of status) {
      if (used.has(path)) continue;
      out.push({ key: path, line: `${kind} ${path}` });
    }
    out.sort((a, b) => byteCompare(a.key, b.key));
    return out;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

type AnyEdit =
  | { kind: 'unified'; section: UniSection }
  | { kind: 'search-replace'; block: SRBlock }
  | { kind: 'v4a'; section: V4ASection }
  | { kind: 'json-create'; path: string; file_text: string }
  | { kind: 'json-str-replace'; path: string; old_str: string; new_str: string }
  | { kind: 'json-insert'; path: string; insert_line: number; new_str: string };

function detectFormat(lines: string[]): string | null {
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx === -1) return null;
  if (lines[firstIdx].trim() === '*** Begin Patch') return 'v4a';
  const firstChar = lines[firstIdx].trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (const l of lines) {
    if (rtrimWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

function parsePatch(fmt: string, patchText: string, lines: string[]): AnyEdit[] {
  if (fmt === 'unified') {
    return parseUnified(lines).map((section) => ({ kind: 'unified' as const, section }));
  }
  if (fmt === 'search-replace') {
    return parseSearchReplace(lines).map((block) => ({ kind: 'search-replace' as const, block }));
  }
  if (fmt === 'v4a') {
    return parseV4a(lines).map((section) => ({ kind: 'v4a' as const, section }));
  }
  return parseJson(patchText, lines);
}

// --- Unified diffs (SPEC section 6) ---------------------------------------

interface HunkItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  backslash: boolean;
}

interface Hunk {
  a: number;
  items: HunkItem[];
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let headerPair = false;

  const newSection = (gitOld: string | null, gitNew: string | null): UniSection => {
    const s: UniSection = {
      gitOld,
      gitNew,
      dashOld: undefined,
      dashNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    if (cur) sections.push(cur);
    cur = s;
    inHeader = true;
    headerPair = false;
    return s;
  };

  const headerPath = (line: string): string => {
    const after = line.slice(4);
    const tab = after.indexOf('\t');
    let p = (tab >= 0 ? after.slice(0, tab) : after).trim();
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
    return p;
  };
  const asPath = (raw: string): string | null => (raw === '/dev/null' ? null : raw);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new ParseFault(i + 1);
      newSection(m[1], m[2]);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const o = asPath(headerPath(line));
      const n = asPath(headerPath(lines[i + 1]));
      if (cur && inHeader && !headerPair) {
        cur.dashOld = o;
        cur.dashNew = n;
        headerPair = true;
      } else {
        const s = newSection(null, null);
        s.dashOld = o;
        s.dashNew = n;
        headerPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new ParseFault(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new ParseFault(i + 1);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), items: [] };
      i++;
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (b === '') {
          hunk.items.push({ kind: 'ctx', text: '', backslash: false });
          i++;
          continue;
        }
        const c = b[0];
        if (c === ' ') {
          hunk.items.push({ kind: 'ctx', text: b.slice(1), backslash: false });
          i++;
          continue;
        }
        if (c === '-') {
          hunk.items.push({ kind: 'old', text: b.slice(1), backslash: false });
          i++;
          continue;
        }
        if (c === '+') {
          hunk.items.push({ kind: 'new', text: b.slice(1), backslash: false });
          i++;
          continue;
        }
        if (c === '\\') {
          const last = hunk.items[hunk.items.length - 1];
          if (last) last.backslash = true;
          i++;
          continue;
        }
        break;
      }
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1];
        if (last.kind === 'ctx' && last.text === '') hunk.items.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur && inHeader) {
      if (line.startsWith('--- ')) throw new ParseFault(i + 2);
      if (line.startsWith('+++ ')) {
        cur.dashNew = asPath(headerPath(line));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (cur) sections.push(cur);
  if (sections.length === 0) throw new ParseFault(1);
  return sections;
}

function sectionPaths(sec: UniSection): { oldP: string | null | undefined; newP: string | null | undefined } {
  const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
  const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
  return { oldP, newP };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastCtxOrPlusBackslash(hunk: Hunk): boolean {
  for (let i = hunk.items.length - 1; i >= 0; i--) {
    const it = hunk.items[i];
    if (it.kind === 'ctx' || it.kind === 'new') return it.backslash;
  }
  return false;
}

function applyUnified(
  sec: UniSection,
  tree: Tree,
  strict: boolean,
  moves: Array<[string, string]>,
): Fail | null {
  const { oldP, newP } = sectionPaths(sec);
  for (const p of [oldP, newP]) {
    if (p !== null && p !== undefined && !isSafePath(p)) return { code: 'unsafe', path: p };
  }
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.deletedFile);
  if (isCreate) {
    if (newP === undefined || newP === null) return { code: 'missing', path: '' };
    if (tree.get(newP) !== null) return { code: 'exists', path: newP };
    const plus: string[] = [];
    let lastBs = false;
    for (const h of sec.hunks) {
      for (const it of h.items) {
        if (it.kind === 'new') {
          plus.push(it.text);
          lastBs = it.backslash;
        }
      }
    }
    tree.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n'));
    return null;
  }
  if (isDelete) {
    if (oldP === undefined || oldP === null) return { code: 'missing', path: '' };
    if (tree.get(oldP) === null) return { code: 'missing', path: oldP };
    tree.remove(oldP);
    return null;
  }
  const isMove = oldP !== newP;
  if (isMove) {
    if (oldP === undefined || oldP === null || newP === undefined || newP === null) {
      return { code: 'missing', path: '' };
    }
    if (tree.get(oldP) === null) return { code: 'missing', path: oldP };
    if (tree.get(newP) !== null) return { code: 'exists', path: newP };
  } else {
    if (oldP === undefined || oldP === null) return { code: 'missing', path: '' };
    if (tree.get(oldP) === null) return { code: 'missing', path: oldP };
  }
  const src = oldP as string;
  const model = parseFile(tree.get(src) as string);
  const lines = model.lines.slice();
  let ends = model.ends;
  let d = 0;
  const maxTier = strict ? 0 : 2;
  for (const hunk of sec.hunks) {
    const oItems = hunk.items.filter((it) => it.kind === 'ctx' || it.kind === 'old');
    const nItems: NItem[] = [];
    let oIdx = 0;
    for (const it of hunk.items) {
      if (it.kind === 'ctx') {
        nItems.push({ kind: 'ctx', text: it.text, oIndex: oIdx });
        oIdx++;
      } else if (it.kind === 'old') {
        oIdx++;
      } else {
        nItems.push({ kind: 'new', text: it.text, oIndex: -1 });
      }
    }
    const oTexts = oItems.map((it) => it.text);
    if (oTexts.length === 0) {
      const p = Math.min(Math.max(hunk.a + d, 0), lines.length);
      const atEnd = p === lines.length;
      const newLines = nItems.map((it) => it.text);
      lines.splice(p, 0, ...newLines);
      if (atEnd) ends = !lastCtxOrPlusBackslash(hunk);
      d += newLines.length;
    } else {
      const hit = firstTier(lines, oTexts, 0, maxTier);
      if (!hit) return { code: 'no-match', path: src };
      const target = hunk.a - 1 + d;
      let pos = hit.positions[0];
      let best = Math.abs(pos - target);
      for (const q of hit.positions) {
        const dist = Math.abs(q - target);
        if (dist < best) {
          best = dist;
          pos = q;
        }
      }
      const atEnd = pos + oTexts.length === lines.length;
      const newLines = buildNewLines(nItems, lines, pos, hit.tier, oTexts[0]);
      lines.splice(pos, oTexts.length, ...newLines);
      if (atEnd) ends = !lastCtxOrPlusBackslash(hunk);
      d += newLines.length - oTexts.length;
    }
  }
  const out = renderFile({ brk: model.brk, lines, ends });
  if (isMove) {
    tree.set(newP as string, out);
    tree.remove(src);
    moves.push([src, newP as string]);
  } else {
    tree.set(src, out);
  }
  return null;
}

// --- SEARCH/REPLACE blocks (SPEC section 7) -------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rtrimWs(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchIdx + 1);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (rtrimWs(lines[j]) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new ParseFault(searchIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (rtrimWs(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseFault(searchIdx + 1);
    blocks.push({
      path,
      oldLines: lines.slice(searchIdx + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseFault(1);
  return blocks;
}

function applySearchReplace(b: SRBlock, tree: Tree, strict: boolean): Fail | null {
  if (!isSafePath(b.path)) return { code: 'unsafe', path: b.path };
  if (b.oldLines.length === 0) {
    if (tree.get(b.path) !== null) return { code: 'exists', path: b.path };
    tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
    return null;
  }
  const cur = tree.get(b.path);
  if (cur === null) return { code: 'missing', path: b.path };
  const model = parseFile(cur);
  const hit = firstTier(model.lines, b.oldLines, 0, strict ? 0 : 2);
  if (!hit) return { code: 'no-match', path: b.path };
  if (hit.positions.length > 1) return { code: 'ambiguous', path: b.path };
  const pos = hit.positions[0];
  const nItems: NItem[] = b.newLines.map((t) => ({ kind: 'new' as const, text: t, oIndex: -1 }));
  const newLines = buildNewLines(nItems, model.lines, pos, hit.tier, b.oldLines[0]);
  const lines = model.lines.slice();
  lines.splice(pos, b.oldLines.length, ...newLines);
  tree.set(b.path, renderFile({ brk: model.brk, lines, ends: model.ends }));
  return null;
}

// --- V4A patches (SPEC section 8) -----------------------------------------

interface V4AChunk {
  anchor: string | null;
  items: Array<{ kind: 'ctx' | 'old' | 'new'; text: string }>;
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  fileLines: string[];
  chunks: V4AChunk[];
  lineNo: number;
}

function parseV4a(lines: string[]): V4ASection[] {
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx === -1) throw new ParseFault(1);
  if (lines[firstIdx].trim() !== '*** Begin Patch') throw new ParseFault(firstIdx + 1);
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      lastIdx = i;
      break;
    }
  }
  if (lines[lastIdx].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');

  const sections: V4ASection[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    } else {
      throw new ParseFault(i + 1);
    }
    const sectionLineNo = i + 1;
    const body: Array<{ text: string; no: number }> = [];
    i++;
    while (i < lastIdx && !isSectionStart(lines[i])) {
      body.push({ text: lines[i], no: i + 1 });
      i++;
    }
    while (body.length > 0 && body[body.length - 1].text.trim() === '') body.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new ParseFault(b.no);
      }
      sections.push({ kind, path, moveTo: null, fileLines, chunks: [], lineNo: sectionLineNo });
    } else if (kind === 'delete') {
      for (const b of body) throw new ParseFault(b.no);
      sections.push({ kind, path, moveTo: null, fileLines: [], chunks: [], lineNo: sectionLineNo });
    } else {
      let moveTo: string | null = null;
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let seen = 0;
      for (const b of body) {
        const t = b.text;
        if (seen === 0 && t.startsWith('*** Move to:')) {
          moveTo = t.slice('*** Move to:'.length).trim();
          seen++;
          continue;
        }
        if (t.startsWith('@@')) {
          const anchorText = t.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, items: [], eof: false };
          chunks.push(cur);
          seen++;
          continue;
        }
        if (t.trim() === '*** End of File' && t[0] !== ' ' && t[0] !== '-' && t[0] !== '+') {
          if (!cur) {
            cur = { anchor: null, items: [], eof: true };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          cur = null;
          seen++;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (!cur) {
            if (chunks.length > 0) throw new ParseFault(b.no);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          if (t === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (t[0] === ' ') cur.items.push({ kind: 'ctx', text: t.slice(1) });
          else if (t[0] === '-') cur.items.push({ kind: 'old', text: t.slice(1) });
          else cur.items.push({ kind: 'new', text: t.slice(1) });
          seen++;
          continue;
        }
        throw new ParseFault(b.no);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(sectionLineNo);
      sections.push({ kind, path, moveTo, fileLines: [], chunks, lineNo: sectionLineNo });
    }
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections;
}

function applyV4a(
  sec: V4ASection,
  tree: Tree,
  strict: boolean,
  moves: Array<[string, string]>,
): Fail | null {
  if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return { code: 'unsafe', path: sec.moveTo };
  const maxTier = strict ? 0 : 2;
  if (sec.kind === 'add') {
    if (tree.get(sec.path) !== null) return { code: 'exists', path: sec.path };
    tree.set(sec.path, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
    return null;
  }
  if (sec.kind === 'delete') {
    if (tree.get(sec.path) === null) return { code: 'missing', path: sec.path };
    tree.remove(sec.path);
    return null;
  }
  const cur = tree.get(sec.path);
  if (cur === null) return { code: 'missing', path: sec.path };
  if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) return { code: 'exists', path: sec.moveTo };
  const model = parseFile(cur);
  const lines = model.lines.slice();
  let cursor = 0;
  for (const chunk of sec.chunks) {
    if (chunk.anchor !== null) {
      const anchor = chunk.anchor;
      let foundIdx = -1;
      for (let t = 0; t <= maxTier; t++) {
        for (let j = cursor; j < lines.length; j++) {
          if (lineEq(lines[j], anchor, t)) {
            foundIdx = j;
            break;
          }
        }
        if (foundIdx >= 0) break;
      }
      if (foundIdx < 0) return { code: 'no-match', path: sec.path };
      cursor = foundIdx + 1;
    }
    const oItems = chunk.items.filter((it) => it.kind === 'ctx' || it.kind === 'old');
    const nItems: NItem[] = [];
    let oIdx = 0;
    for (const it of chunk.items) {
      if (it.kind === 'ctx') {
        nItems.push({ kind: 'ctx', text: it.text, oIndex: oIdx });
        oIdx++;
      } else if (it.kind === 'old') {
        oIdx++;
      } else {
        nItems.push({ kind: 'new', text: it.text, oIndex: -1 });
      }
    }
    const oTexts = oItems.map((it) => it.text);
    if (oTexts.length === 0) {
      const p = chunk.eof ? lines.length : cursor;
      const newLines = nItems.map((it) => it.text);
      lines.splice(p, 0, ...newLines);
      cursor = p + newLines.length;
    } else {
      let found: { tier: number; pos: number } | null = null;
      for (let t = 0; t <= maxTier; t++) {
        const occ = occurrences(lines, oTexts, t, cursor);
        if (chunk.eof) {
          const last = lines.length - oTexts.length;
          if (last >= cursor && occ.includes(last)) {
            found = { tier: t, pos: last };
            break;
          }
        } else if (occ.length > 0) {
          found = { tier: t, pos: occ[0] };
          break;
        }
      }
      if (!found) return { code: 'no-match', path: sec.path };
      const newLines = buildNewLines(nItems, lines, found.pos, found.tier, oTexts[0]);
      lines.splice(found.pos, oTexts.length, ...newLines);
      cursor = found.pos + newLines.length;
    }
  }
  const out = renderFile({ brk: model.brk, lines, ends: model.ends });
  if (sec.moveTo !== null) {
    tree.set(sec.moveTo, out);
    tree.remove(sec.path);
    moves.push([sec.path, sec.moveTo]);
  } else {
    tree.set(sec.path, out);
  }
  return null;
}

// --- JSON edits (SPEC section 9) ------------------------------------------

function validateJsonEdit(obj: unknown, lineNo: number): AnyEdit {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ParseFault(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseFault(lineNo);
  if (typeof o.command !== 'string') throw new ParseFault(lineNo);
  const path = o.path as string;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseFault(lineNo);
    return { kind: 'json-create', path, file_text: o.file_text as string };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string) === '') throw new ParseFault(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseFault(lineNo);
    return {
      kind: 'json-str-replace',
      path,
      old_str: o.old_str as string,
      new_str: (o.new_str as string | undefined) ?? '',
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) {
      throw new ParseFault(lineNo);
    }
    if (typeof o.new_str !== 'string') throw new ParseFault(lineNo);
    return { kind: 'json-insert', path, insert_line: o.insert_line as number, new_str: o.new_str as string };
  }
  throw new ParseFault(lineNo);
}

function parseJson(patchText: string, lines: string[]): AnyEdit[] {
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx === -1) throw new ParseFault(1);
  const firstChar = lines[firstIdx].trimStart()[0];
  if (firstChar === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseFault(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseFault(firstIdx + 1);
    if (arr.length === 0) throw new ParseFault(1);
    return arr.map((el) => validateJsonEdit(el, firstIdx + 1));
  }
  const edits: AnyEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseFault(i + 1);
    }
    edits.push(validateJsonEdit(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function applyJson(
  e: Extract<AnyEdit, { kind: 'json-create' | 'json-str-replace' | 'json-insert' }>,
  tree: Tree,
): Fail | null {
  if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
  if (e.kind === 'json-create') {
    if (tree.get(e.path) !== null) return { code: 'exists', path: e.path };
    tree.set(e.path, e.file_text);
    return null;
  }
  const cur = tree.get(e.path);
  if (cur === null) return { code: 'missing', path: e.path };
  if (e.kind === 'json-str-replace') {
    const model = parseFile(cur);
    const crlf = model.brk === '\r\n';
    const text = crlf ? cur.replace(/\r\n/g, '\n') : cur;
    const oldS = crlf ? e.old_str.replace(/\r\n/g, '\n') : e.old_str;
    const newS = crlf ? e.new_str.replace(/\r\n/g, '\n') : e.new_str;
    let count = 0;
    let first = -1;
    let from = 0;
    for (;;) {
      const j = text.indexOf(oldS, from);
      if (j < 0) break;
      count++;
      if (first < 0) first = j;
      from = j + 1;
    }
    if (count === 0) return { code: 'no-match', path: e.path };
    if (count > 1) return { code: 'ambiguous', path: e.path };
    let result = text.slice(0, first) + newS + text.slice(first + oldS.length);
    if (crlf) result = result.replace(/\n/g, '\r\n');
    tree.set(e.path, result);
    return null;
  }
  const model = parseFile(cur);
  if (e.insert_line < 0 || e.insert_line > model.lines.length) return { code: 'no-match', path: e.path };
  const ins = splitJsonLines(e.new_str);
  const lines = model.lines.slice();
  lines.splice(e.insert_line, 0, ...ins);
  tree.set(e.path, renderFile({ brk: model.brk, lines, ends: model.ends }));
  return null;
}

// ---------------------------------------------------------------------------
// Applying edits (SPEC section 10)
// ---------------------------------------------------------------------------

function applyEdit(
  e: AnyEdit,
  tree: Tree,
  strict: boolean,
  moves: Array<[string, string]>,
): Fail | null {
  switch (e.kind) {
    case 'unified':
      return applyUnified(e.section, tree, strict, moves);
    case 'search-replace':
      return applySearchReplace(e.block, tree, strict);
    case 'v4a':
      return applyV4a(e.section, tree, strict, moves);
    default:
      return applyJson(e, tree);
  }
}

// ---------------------------------------------------------------------------
// CLI entry (SPEC sections 1-2)
// ---------------------------------------------------------------------------

function runCli(argv: string[]): { code: number; out: string } {
  const usage = (): { code: number; out: string } => ({ code: 2, out: 'error: usage\n' });
  let format: string | null = null;
  let check = false;
  let strict = false;
  const seen = new Set<string>();
  const positional: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seen.has('check')) return usage();
        seen.add('check');
        check = true;
      } else if (a === '--strict') {
        if (seen.has('strict')) return usage();
        seen.add('strict');
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seen.has('format')) return usage();
        seen.add('format');
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') {
          return usage();
        }
        format = v;
      } else {
        return usage();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return usage();

  const patchArg = positional[0];
  let patchText: string;
  if (patchArg === undefined || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: 'error: no-patch\n' };
    }
  }

  const lines = patchLines(patchText);
  let fmt = format ?? 'auto';
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return { code: 2, out: 'error: format\n' };
    fmt = detected;
  }

  let edits: AnyEdit[];
  try {
    edits = parsePatch(fmt, patchText, lines);
  } catch (err) {
    if (err instanceof ParseFault) return { code: 2, out: `error: parse ${err.line}\n` };
    throw err;
  }

  const tree = new Tree();
  const failures: Fail[] = [];
  const moves: Array<[string, string]> = [];
  for (const e of edits) {
    const f = applyEdit(e, tree, strict, moves);
    if (f) failures.push(f);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    return { code: 1, out };
  }

  const changeLines = tree.changes(moves);
  if (!check) tree.flush();
  let out = '';
  for (const c of changeLines) out += c.line + '\n';
  out += `ok: ${changeLines.length} file${changeLines.length === 1 ? '' : 's'}\n`;
  return { code: 0, out };
}

// ---------------------------------------------------------------------------
// Entry dispatch (at the end: classes above must be evaluated first)
// ---------------------------------------------------------------------------

const ENV_URL = process.env.MAKEFUN_ENV_URL;
if (ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(ENV_URL);
} else {
  const outcome = runCli(process.argv.slice(2));
  process.stdout.write(outcome.out);
  process.exitCode = outcome.code;
}
