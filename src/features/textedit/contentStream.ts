/**
 * Tokenizer and interpreter for the subset of PDF content-stream operators
 * needed to locate show-text operators (Tj / TJ / ' / "), plus the byte-level
 * splice that removes one from a stream. See features/textedit/types.ts for
 * the overall pipeline this participates in.
 *
 * No PDF object model here on purpose: streams arrive as already-decoded
 * bytes (see mutate.ts), and everything below operates on raw byte offsets so
 * spliceRun can make a surgical, otherwise byte-identical edit.
 */

import type { LocatedRun, PageTextItemRef, RunColor, ShowOp } from './types';

// ---------------------------------------------------------------------------
// Byte classification (ISO 32000-1 7.2.2/7.2.3)
// ---------------------------------------------------------------------------

function isWhitespaceByte(b: number): boolean {
  return b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}

function isDelimiterByte(b: number): boolean {
  return (
    b === 0x28 /* ( */ ||
    b === 0x29 /* ) */ ||
    b === 0x3c /* < */ ||
    b === 0x3e /* > */ ||
    b === 0x5b /* [ */ ||
    b === 0x5d /* ] */ ||
    b === 0x7b /* { */ ||
    b === 0x7d /* } */ ||
    b === 0x2f /* / */ ||
    b === 0x25 /* % */
  );
}

function isBoundaryByte(b: number): boolean {
  return isWhitespaceByte(b) || isDelimiterByte(b);
}

/** Skip whitespace and `%` comments (which run to end of line). */
function skipInsignificant(bytes: Uint8Array, pos: number): number {
  const len = bytes.length;
  while (pos < len) {
    const b = bytes[pos];
    if (isWhitespaceByte(b)) {
      pos++;
    } else if (b === 0x25 /* % */) {
      pos++;
      while (pos < len && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
    } else {
      break;
    }
  }
  return pos;
}

function decodeLatin1(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let i = start; i < end; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'number' | 'string' | 'name' | 'array' | 'dict' | 'operator';

interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** Parsed value for 'number' tokens. */
  num?: number;
  /** Unescaped name text (no leading slash) for 'name' tokens, or the raw text of 'operator' tokens. */
  text?: string;
}

/** A run of regular (non-whitespace, non-delimiter) characters: operators, true/false/null, BI/ID/EI. */
function readBareword(bytes: Uint8Array, pos: number): Token {
  const start = pos;
  const len = bytes.length;
  while (pos < len && !isBoundaryByte(bytes[pos])) pos++;
  return { kind: 'operator', start, end: pos, text: decodeLatin1(bytes, start, pos) };
}

/** A PDF number: optional sign, digits, optional decimal point. `pos` is at the first character. */
function readNumber(bytes: Uint8Array, pos: number): Token {
  const start = pos;
  const len = bytes.length;
  while (pos < len && !isBoundaryByte(bytes[pos])) pos++;
  const parsed = Number.parseFloat(decodeLatin1(bytes, start, pos));
  return { kind: 'number', start, end: pos, num: Number.isNaN(parsed) ? 0 : parsed };
}

/** `/Name`, unescaping `#xx` hex escapes per 7.3.5. `pos` is at the leading `/`. */
function readName(bytes: Uint8Array, pos: number): Token {
  const start = pos;
  const len = bytes.length;
  pos++; // consume '/'
  let text = '';
  while (pos < len && !isBoundaryByte(bytes[pos])) {
    if (bytes[pos] === 0x23 /* # */ && pos + 2 < len) {
      const code = Number.parseInt(decodeLatin1(bytes, pos + 1, pos + 3), 16);
      if (!Number.isNaN(code)) {
        text += String.fromCharCode(code);
        pos += 3;
        continue;
      }
    }
    text += String.fromCharCode(bytes[pos]);
    pos++;
  }
  return { kind: 'name', start, end: pos, text };
}

/** Literal string `(...)`, honoring nested parens and backslash escapes (7.3.4.2). */
function readLiteralString(bytes: Uint8Array, pos: number): Token {
  const start = pos;
  const len = bytes.length;
  pos++; // consume '('
  let depth = 1;
  while (pos < len && depth > 0) {
    const b = bytes[pos];
    if (b === 0x5c /* \ */) {
      pos += 2; // the escaped byte is never a paren that should affect depth
    } else if (b === 0x28) {
      depth++;
      pos++;
    } else if (b === 0x29) {
      depth--;
      pos++;
    } else {
      pos++;
    }
  }
  return { kind: 'string', start, end: Math.min(pos, len) };
}

/** Hex string `<...>` (single-level; a leading `<<` is a dict and handled by the caller). */
function readHexString(bytes: Uint8Array, pos: number): Token {
  const start = pos;
  const len = bytes.length;
  pos++; // consume '<'
  while (pos < len && bytes[pos] !== 0x3e /* > */) pos++;
  if (pos < len) pos++; // consume '>'
  return { kind: 'string', start, end: pos };
}

function readArray(bytes: Uint8Array, pos: number): Token {
  const start = pos;
  const len = bytes.length;
  pos++; // consume '['
  for (;;) {
    pos = skipInsignificant(bytes, pos);
    if (pos >= len) break;
    if (bytes[pos] === 0x5d /* ] */) {
      pos++;
      break;
    }
    pos = readValue(bytes, pos).end;
  }
  return { kind: 'array', start, end: pos };
}

function readDict(bytes: Uint8Array, pos: number): Token {
  const start = pos;
  const len = bytes.length;
  pos += 2; // consume '<<'
  for (;;) {
    pos = skipInsignificant(bytes, pos);
    if (pos >= len) break;
    if (bytes[pos] === 0x3e && bytes[pos + 1] === 0x3e) {
      pos += 2;
      break;
    }
    pos = readValue(bytes, pos).end; // key (a name in well-formed input)
    pos = skipInsignificant(bytes, pos);
    if (pos >= len) break;
    pos = readValue(bytes, pos).end; // value
  }
  return { kind: 'dict', start, end: pos };
}

/**
 * Read one PDF value: number, string (literal or hex), name, array, or dict,
 * recursing for nested composites. Anything else (a bareword, or a stray
 * unbalanced delimiter from malformed input) is returned as a lone 'operator'
 * token so callers always make forward progress.
 */
function readValue(bytes: Uint8Array, pos: number): Token {
  pos = skipInsignificant(bytes, pos);
  const b = bytes[pos];
  if (b === 0x28) return readLiteralString(bytes, pos);
  if (b === 0x2f) return readName(bytes, pos);
  if (b === 0x5b) return readArray(bytes, pos);
  if (b === 0x3c) return bytes[pos + 1] === 0x3c ? readDict(bytes, pos) : readHexString(bytes, pos);
  if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e)
    return readNumber(bytes, pos);
  if (isDelimiterByte(b)) {
    return { kind: 'operator', start: pos, end: pos + 1, text: decodeLatin1(bytes, pos, pos + 1) };
  }
  return readBareword(bytes, pos);
}

// ---------------------------------------------------------------------------
// Operation scanning: operator + the operand tokens since the previous operator
// ---------------------------------------------------------------------------

interface Operation {
  operator: string;
  /** Byte offset just past the operator token. */
  operatorEnd: number;
  operands: Token[];
  /** The first operand's start, or the operator's start when there are none. */
  start: number;
}

function scanOperations(bytes: Uint8Array, onOperation: (op: Operation) => void): void {
  const len = bytes.length;
  let pos = 0;
  let operands: Token[] = [];

  while (pos < len) {
    pos = skipInsignificant(bytes, pos);
    if (pos >= len) break;

    const token = readValue(bytes, pos);
    if (token.kind === 'operator') {
      if (token.text === 'BI') {
        pos = skipInlineImage(bytes, token.end);
        operands = [];
        continue;
      }
      const start = operands.length > 0 ? operands[0].start : token.start;
      onOperation({ operator: token.text ?? '', operatorEnd: token.end, operands, start });
      operands = [];
    } else {
      operands.push(token);
    }
    pos = token.end;
  }
}

/**
 * Skip an inline image (`BI <dict entries> ID <binary data> EI`, 7.8.2). The
 * dict entries between BI and ID tokenize as ordinary values; the binary data
 * after ID does not, so it is never fed through the tokenizer.
 */
function skipInlineImage(bytes: Uint8Array, pos: number): number {
  const len = bytes.length;
  for (;;) {
    pos = skipInsignificant(bytes, pos);
    if (pos >= len) return len;
    const token = readValue(bytes, pos);
    pos = token.end;
    if (token.kind === 'operator' && token.text === 'ID') break;
  }
  // A single white-space byte separates ID from the binary data.
  if (pos < len && isWhitespaceByte(bytes[pos])) pos++;
  // EI delimited by whitespace on both sides; binary data essentially never
  // matches this by accident, which is the standard heuristic for this case.
  for (let i = pos; i < len - 1; i++) {
    const before = i === pos || isWhitespaceByte(bytes[i - 1]);
    const after = i + 2 >= len || isWhitespaceByte(bytes[i + 2]) || isDelimiterByte(bytes[i + 2]);
    if (bytes[i] === 0x45 /* E */ && bytes[i + 1] === 0x49 /* I */ && before && after) return i + 2;
  }
  return len;
}

function numericOperands(operands: Token[]): number[] {
  return operands.filter((t) => t.kind === 'number').map((t) => t.num ?? 0);
}

// ---------------------------------------------------------------------------
// Matrices (ISO 32000-1 8.3.4): [a b c d e f] applied as
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
// ---------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Compose `m1` then `m2` (a point transformed by `m1` and then by `m2`). */
function concatMatrix(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

function cmykToRgb(c: number, m: number, y: number, k: number): RunColor {
  return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) };
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

/**
 * State saved by q and restored by Q (ISO 32000-1 9.3.1). This covers not
 * just ctm and fill color but also the text state set by Tf (font resource,
 * size) and TL/TD (leading), since those are part of the graphics state too.
 * tm/tlm are deliberately excluded: the text matrix is not part of the
 * graphics state, it lives between BT/ET (9.4.2).
 */
interface GraphicsState {
  ctm: Matrix;
  fillColor: RunColor;
  fontResource: string;
  tfSize: number;
  tl: number;
}

interface InterpreterState {
  ctm: Matrix;
  fillColor: RunColor;
  stack: GraphicsState[];
  /** Text matrix and text line matrix (9.4.2); both reset to identity at BT. */
  tm: Matrix;
  tlm: Matrix;
  /** Leading, set by TL and by the ty operand of TD. */
  tl: number;
  fontResource: string;
  tfSize: number;
}

function initialState(): InterpreterState {
  return {
    ctm: IDENTITY,
    fillColor: { r: 0, g: 0, b: 0 },
    stack: [],
    tm: IDENTITY,
    tlm: IDENTITY,
    tl: 0,
    fontResource: '',
    tfSize: 0,
  };
}

/** Td's translation, shared by Td, TD, T*, and the implicit line advance in ' and ". */
function advanceLine(state: InterpreterState, tx: number, ty: number): void {
  state.tlm = concatMatrix([1, 0, 0, 1, tx, ty], state.tlm);
  state.tm = state.tlm;
}

const ROTATION_EPSILON = 1e-3;

function buildRun(
  state: InterpreterState,
  streamIndex: number,
  op: ShowOp,
  start: number,
  end: number,
): LocatedRun {
  const combined = concatMatrix(state.tm, state.ctm);
  const [a, b, c, d] = combined;

  // Applying a matrix to the text-space origin (0, 0) yields just its
  // translation: this run's baseline origin in (pre-viewport) PDF user space.
  const x = combined[4];
  const y = combined[5];

  // (a, b) is where the text-space vector (1, 0) lands, and (c, d) is where
  // (0, 1) lands (translation dropped in both). Their lengths are the
  // matrix's horizontal and vertical scale; glyph height tracks the vertical
  // one, matching how PDF.js derives a text item's height from this matrix.
  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  const scale = Math.max(scaleX, scaleY) || 1;

  // A pure translation + uniform-scale matrix has b === c === 0. Anything
  // else rotates or skews the glyphs, which this feature does not edit (the
  // splice draws replacement text upright at the same origin).
  const rotatedOrSkewed =
    Math.abs(b) > ROTATION_EPSILON * scale || Math.abs(c) > ROTATION_EPSILON * scale;

  const run: LocatedRun = {
    streamIndex,
    start,
    end,
    op,
    x,
    y,
    fontSize: state.tfSize * scaleY,
    fontResource: state.fontResource,
    color: { ...state.fillColor },
    editable: !rotatedOrSkewed,
  };
  if (rotatedOrSkewed) run.blockedReason = 'Rotated or skewed text is not supported yet';
  return run;
}

/**
 * A `Do` operator the parser did not descend into because `resolveForm`
 * (see below) returned undefined for it: an Image XObject is the common
 * case, but this also fires for a name the resolver could not place at all.
 * Reported to the optional `onImageOp` sink (see parseContentStreams), which
 * is how features/imageedit enumerates image draws without this file
 * knowing anything about the PDF object model (see the file header): the
 * sink's caller is the one that resolves `name` against Resources/XObject
 * and decides whether it is actually an image.
 */
export interface LocatedImageOp {
  /** Index into the page's Contents array, or a resolved form's assigned streamId. */
  streamIndex: number;
  /** Byte offset of the operator's first operand (the name token). */
  start: number;
  /** Byte offset just past the operator token. */
  end: number;
  /** XObject resource name, e.g. "Im1". */
  name: string;
  /**
   * CTM in effect at the Do, as [a, b, c, d, e, f]. An image XObject paints
   * the unit square, so this matrix alone is the image's position and size
   * on the page; unlike buildRun's runs, there is no text matrix involved.
   */
  ctm: [number, number, number, number, number, number];
}

/** Reports one image-painting `Do` (see {@link LocatedImageOp}). */
export type ImageOpSink = (op: LocatedImageOp) => void;

/** A Form XObject resolved by the caller-supplied FormResolver; see below. */
export interface ResolvedForm {
  /** Caller-assigned opaque id, used as LocatedRun.streamIndex. */
  streamId: number;
  bytes: Uint8Array;
  /** The form's own /Matrix, or undefined when absent (defaults to identity). */
  matrix?: [number, number, number, number, number, number];
}

/**
 * Resolve an XObject resource name to a Form XObject, scoped to the stream
 * that invoked it (so the same name can mean different things in different
 * forms' resource dictionaries). Returns undefined for anything that is not
 * a form (an Image XObject, most commonly) or that cannot be resolved at
 * all; parseContentStreams treats that exactly like Do always used to be
 * treated, i.e. it skips the operator. Owned by the caller (see mutate.ts)
 * because resolving a name requires walking the PDF object model, which this
 * file deliberately has none of (see the file header).
 */
export type FormResolver = (name: string, fromStreamId: number) => ResolvedForm | undefined;

/**
 * Forms nested this many levels deep are not descended into. A defensive cap
 * against pathological or maliciously self-referential PDFs; legitimate
 * nesting (a stamp inside a letterhead inside a watermark, say) is nowhere
 * near this deep.
 */
const MAX_FORM_DEPTH = 8;

/**
 * Total form descents allowed per parse, across the whole traversal.
 *
 * MAX_FORM_DEPTH alone does not bound the work: a form is re-entered whenever
 * it is reached down a different branch (only the *current* path is checked
 * for cycles), so a PDF whose forms each invoke the next one F times costs
 * F^MAX_FORM_DEPTH stream traversals. At F=10 that is 100 million, which
 * hangs the tab on a file the user only meant to open. Content streams are
 * untrusted input, so bound the total instead of trusting the shape. Real
 * documents come nowhere near this: a form per page region, each drawn once
 * or twice, is a few dozen at most.
 */
const MAX_FORM_DESCENTS = 512;

export function parseContentStreams(
  streams: Uint8Array[],
  resolveForm?: FormResolver,
  onImageOp?: ImageOpSink,
): LocatedRun[] {
  const runs: LocatedRun[] = [];
  const state = initialState();

  // The most recently emitted run that has not yet been proven safe from the
  // advance-dependency hazard: a following Tj/TJ with no repositioning op in
  // between would inherit this run's glyph advance, so deleting this run
  // would shift that neighbor. Resolved (cleared, optionally marked blocked)
  // by whatever operator comes next; see the operator switch below.
  let pending: LocatedRun | null = null;

  function resolvePending(blockedByAdvance: boolean): void {
    if (pending && blockedByAdvance && pending.editable) {
      pending.editable = false;
      pending.blockedReason = 'This text shares positioning with adjacent text';
    }
    pending = null;
  }

  // How many times each resolved form (keyed by ResolvedForm.streamId) was
  // descended into. A form invoked more than once, whether by two Do's
  // naming it directly or by two different ancestors, has all of its runs
  // blocked after the fact (the sweep below): splicing text out of its bytes
  // would remove it from every invocation, while mutate.ts only ever draws
  // the replacement once. This is scoped to one parseContentStreams call, so
  // it does not penalize the same form being used once each on several
  // different pages.
  const invocationCounts = new Map<number, number>();

  /** Descents made so far, against MAX_FORM_DESCENTS. */
  let descents = 0;

  function interpretStream(bytes: Uint8Array, streamIndex: number, path: readonly number[]): void {
    scanOperations(bytes, ({ operator, operatorEnd, operands, start }) => {
      switch (operator) {
        case 'q':
          state.stack.push({
            ctm: state.ctm,
            fillColor: state.fillColor,
            fontResource: state.fontResource,
            tfSize: state.tfSize,
            tl: state.tl,
          });
          break;
        case 'Q': {
          const restored = state.stack.pop();
          if (restored) {
            state.ctm = restored.ctm;
            state.fillColor = restored.fillColor;
            state.fontResource = restored.fontResource;
            state.tfSize = restored.tfSize;
            state.tl = restored.tl;
          }
          break;
        }
        case 'cm': {
          const n = numericOperands(operands);
          if (n.length === 6) {
            state.ctm = concatMatrix([n[0], n[1], n[2], n[3], n[4], n[5]], state.ctm);
          }
          break;
        }
        case 'rg': {
          const n = numericOperands(operands);
          if (n.length === 3) state.fillColor = { r: n[0], g: n[1], b: n[2] };
          break;
        }
        case 'g': {
          const n = numericOperands(operands);
          if (n.length === 1) state.fillColor = { r: n[0], g: n[0], b: n[0] };
          break;
        }
        case 'k': {
          const n = numericOperands(operands);
          if (n.length === 4) state.fillColor = cmykToRgb(n[0], n[1], n[2], n[3]);
          break;
        }
        case 'sc':
        case 'scn': {
          if (operands.length > 0 && operands.every((t) => t.kind === 'number')) {
            const n = numericOperands(operands);
            if (n.length === 1) state.fillColor = { r: n[0], g: n[0], b: n[0] };
            else if (n.length === 3) state.fillColor = { r: n[0], g: n[1], b: n[2] };
            else if (n.length === 4) state.fillColor = cmykToRgb(n[0], n[1], n[2], n[3]);
          }
          break;
        }
        case 'cs':
          state.fillColor = { r: 0, g: 0, b: 0 };
          break;
        case 'BT':
          state.tm = IDENTITY;
          state.tlm = IDENTITY;
          resolvePending(false);
          break;
        case 'ET':
          resolvePending(false);
          break;
        case 'Tf': {
          const nameTok = operands.find((t) => t.kind === 'name');
          const sizeTok = operands.find((t) => t.kind === 'number');
          if (nameTok) state.fontResource = nameTok.text ?? '';
          if (sizeTok) state.tfSize = sizeTok.num ?? 0;
          break;
        }
        case 'TL': {
          const n = numericOperands(operands);
          if (n.length === 1) state.tl = n[0];
          break;
        }
        case 'Td': {
          const n = numericOperands(operands);
          if (n.length === 2) advanceLine(state, n[0], n[1]);
          resolvePending(false);
          break;
        }
        case 'TD': {
          const n = numericOperands(operands);
          if (n.length === 2) {
            state.tl = -n[1];
            advanceLine(state, n[0], n[1]);
          }
          resolvePending(false);
          break;
        }
        case 'T*':
          advanceLine(state, 0, -state.tl);
          resolvePending(false);
          break;
        case 'Tm': {
          const n = numericOperands(operands);
          if (n.length === 6) {
            state.tm = [n[0], n[1], n[2], n[3], n[4], n[5]];
            state.tlm = state.tm;
          }
          resolvePending(false);
          break;
        }
        case 'Tj':
        case 'TJ': {
          // A plain show op inherits wherever the previous one left the text
          // position, so it depends on the pending run's advance.
          resolvePending(true);
          const run = buildRun(state, streamIndex, operator as ShowOp, start, operatorEnd);
          runs.push(run);
          pending = run;
          break;
        }
        case "'":
        case '"': {
          // ' and " always reposition themselves (the T* below), so whatever
          // was pending is safe: this op does not inherit its advance.
          resolvePending(false);
          advanceLine(state, 0, -state.tl);
          const run = buildRun(state, streamIndex, operator as ShowOp, start, operatorEnd);
          runs.push(run);
          pending = run;
          break;
        }
        case 'Do': {
          // Only a Form XObject is worth descending into; an Image XObject,
          // or a name the resolver cannot place at all, is left alone
          // exactly as Do always used to be. resolveForm is the only thing
          // that knows the difference, since this file has no PDF object
          // model of its own (see the file header) and cannot resolve the
          // name itself.
          const nameTok = operands.find((t) => t.kind === 'name');
          const resolved =
            nameTok && resolveForm ? resolveForm(nameTok.text ?? '', streamIndex) : undefined;
          if (!resolved) {
            // Exactly the case Do always used to be left alone in: most
            // often an Image XObject, occasionally a name the resolver
            // could not place at all. Either way this file has no way to
            // tell the difference (see the file header), so it just reports
            // the geometry and lets the sink's caller resolve the name.
            if (nameTok && onImageOp) {
              onImageOp({
                streamIndex,
                start,
                end: operatorEnd,
                name: nameTok.text ?? '',
                ctm: [...state.ctm],
              });
            }
            break;
          }

          // Counted before the guards below, not after: an invocation this
          // parse declines to descend into is still an invocation, and the
          // sweep at the end of this function only knows a form is drawn more
          // than once if every Do naming it was counted. Counting after the
          // guards would leave a form drawn twice -- once shallow, once past
          // MAX_FORM_DEPTH or the descent budget -- recorded as drawn once, so
          // its runs would stay editable and splicing one would silently
          // change both draws while the replacement is only drawn at one.
          // Over-counting can only block an edit; under-counting corrupts one.
          invocationCounts.set(
            resolved.streamId,
            (invocationCounts.get(resolved.streamId) ?? 0) + 1,
          );

          // Depth, cycle, and total-work guards. None throws: they simply
          // decline to descend, so any text inside is never located at all (a
          // click on it falls back to the generic "could not find that text"
          // case, rather than this parse blowing up over a pathological PDF).
          if (path.length >= MAX_FORM_DEPTH || path.includes(resolved.streamId)) break;
          if (descents >= MAX_FORM_DESCENTS) break;
          descents++;

          // Do does not itself depend on text position, but entering a form
          // resets tm/tlm to identity (below) and leaving it restores
          // whatever they were before, so the run right before this Do and
          // the one right after it are never positionally dependent on one
          // another (nor is the form's own first or last run on whichever
          // neighbor sits just across this boundary). Without this, such a
          // pair could be wrongly blocked as sharing positioning even though
          // the reset/restore already makes that impossible.
          resolvePending(false);

          // 8.10.2: invoking a form is equivalent to `q <Matrix> cm ... Q`.
          // tm/tlm are not part of the graphics state, so q/Q would not
          // otherwise save and restore them, but they must not leak into the
          // form (it starts with a fresh text object, the same as a nested
          // BT would give it) or back out of it once the form returns.
          // Swapping in a fresh stack (rather than pushing onto the outer
          // one) means an unbalanced q left inside the form cannot corrupt
          // the outer stream's later Q handling either.
          const savedCtm = state.ctm;
          const savedFillColor = state.fillColor;
          const savedFontResource = state.fontResource;
          const savedTfSize = state.tfSize;
          const savedTl = state.tl;
          const savedTm = state.tm;
          const savedTlm = state.tlm;
          const savedStack = state.stack;

          state.ctm = concatMatrix(resolved.matrix ?? IDENTITY, state.ctm);
          state.tm = IDENTITY;
          state.tlm = IDENTITY;
          state.stack = [];

          interpretStream(resolved.bytes, resolved.streamId, [...path, resolved.streamId]);
          resolvePending(false);

          state.ctm = savedCtm;
          state.fillColor = savedFillColor;
          state.fontResource = savedFontResource;
          state.tfSize = savedTfSize;
          state.tl = savedTl;
          state.tm = savedTm;
          state.tlm = savedTlm;
          state.stack = savedStack;
          break;
        }
        default:
          // Any other operator outside this feature's scope (painting,
          // clipping, marked content, compatibility operators, and so on).
          break;
      }
    });
  }

  streams.forEach((bytes, streamIndex) => interpretStream(bytes, streamIndex, []));

  // A form invoked more than once cannot be safely spliced (see
  // invocationCounts above); block every run found inside one, without
  // clobbering a more specific reason (rotated text, say) already set.
  if (invocationCounts.size > 0) {
    for (const run of runs) {
      if (run.editable && (invocationCounts.get(run.streamIndex) ?? 0) > 1) {
        run.editable = false;
        run.blockedReason = 'This text is part of a template used more than once on the page';
        run.blockedCode = 'run-in-shared-xobject';
      }
    }
  }

  return runs;
}

export function matchRunToItem(
  runs: LocatedRun[],
  item: PageTextItemRef,
  opts?: { op?: ShowOp },
): LocatedRun | undefined {
  let best: LocatedRun | undefined;
  let bestDistance = Infinity;

  for (const run of runs) {
    if (opts?.op && run.op !== opts.op) continue;
    const distance = Math.hypot(run.x - item.x, run.y - item.y);
    const tolerance = Math.max(2, 0.25 * Math.abs(run.fontSize));
    if (distance <= tolerance && distance < bestDistance) {
      best = run;
      bestDistance = distance;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// spliceRun
// ---------------------------------------------------------------------------

const EMPTY_BYTES = new Uint8Array(0);
const SPACE_BYTE = new Uint8Array([0x20]);
const textEncoder = new TextEncoder();

/**
 * Replace stream[start:end] with `replacement`, otherwise byte-identical.
 * Callers replacing a whole operator should prefer spliceOperatorBytes below,
 * which adds the token-boundary glue this one deliberately leaves out.
 */
export function spliceBytes(
  stream: Uint8Array,
  start: number,
  end: number,
  replacement: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(stream.length - (end - start) + replacement.length);
  out.set(stream.subarray(0, start), 0);
  out.set(replacement, start);
  out.set(stream.subarray(end), start + replacement.length);
  return out;
}

/**
 * Remove an operator's bytes outright: closes the gap when the bytes on
 * either side are already token boundaries, otherwise leaves a single space
 * so closing the gap does not glue two tokens together (e.g. a preceding
 * number's last digit with the next operator's first letter). Used below for
 * a plain Tj/TJ, and by features/imageedit to delete a `/Name Do` image draw
 * the same way: neither operator has a side effect worth preserving once
 * removed, unlike ' and " below.
 */
export function removeOperatorBytes(stream: Uint8Array, start: number, end: number): Uint8Array {
  const before = start > 0 ? stream[start - 1] : 0x20;
  const after = end < stream.length ? stream[end] : 0x20;
  const glue = isBoundaryByte(before) && isBoundaryByte(after) ? EMPTY_BYTES : SPACE_BYTE;
  return spliceBytes(stream, start, end, glue);
}

/**
 * Replace an operator's bytes with a different, already well-formed operator,
 * keeping the result tokenizing the same way.
 *
 * spliceBytes alone is not enough. A located operator's `start` is the offset
 * of its first operand, with no guarantee of preceding whitespace: `/` is
 * self-delimiting, so `Q/Im1 Do` is legal and a writer can emit it. Splicing
 * `q 2 0 0 2 0 0 cm /Im1 Do Q` in at that offset would produce `Qq 2 ...`,
 * gluing the previous operator to the replacement's first token. The same
 * applies at the trailing edge. Two adjacent bytes only tokenize apart when at
 * least one of them is a boundary byte, so a single space goes in on whichever
 * side does not already have one.
 *
 * Used by features/imageedit for the `q <matrix> cm /Name Do Q` a move emits
 * and the `/Name Do` a replace emits.
 */
export function spliceOperatorBytes(
  stream: Uint8Array,
  start: number,
  end: number,
  replacement: Uint8Array,
): Uint8Array {
  if (replacement.length === 0) return removeOperatorBytes(stream, start, end);

  const before = start > 0 ? stream[start - 1] : 0x20;
  const after = end < stream.length ? stream[end] : 0x20;
  const needsLeading = !isBoundaryByte(before) && !isBoundaryByte(replacement[0]);
  const needsTrailing = !isBoundaryByte(after) && !isBoundaryByte(replacement[replacement.length - 1]);
  if (!needsLeading && !needsTrailing) return spliceBytes(stream, start, end, replacement);

  const padded = new Uint8Array(replacement.length + (needsLeading ? 1 : 0) + (needsTrailing ? 1 : 0));
  if (needsLeading) padded[0] = 0x20;
  padded.set(replacement, needsLeading ? 1 : 0);
  if (needsTrailing) padded[padded.length - 1] = 0x20;
  return spliceBytes(stream, start, end, padded);
}

export function spliceRun(stream: Uint8Array, run: LocatedRun): Uint8Array {
  if (run.op === 'Tj' || run.op === 'TJ') {
    return removeOperatorBytes(stream, run.start, run.end);
  }

  if (run.op === "'") {
    // ' is defined as T* followed by showing the string; keep the T* so
    // whatever follows still gets the line advance it was written expecting.
    return spliceBytes(stream, run.start, run.end, textEncoder.encode('T*'));
  }

  // '"': `aw ac string "` is defined as `aw Tw ac Tc string '`, i.e. it also
  // sets word and character spacing before advancing and showing. Keep those
  // two side effects (verbatim operand bytes, no reformatting) plus the line
  // advance; only the string-showing part is dropped.
  const awStart = skipInsignificant(stream, run.start);
  const aw = readNumber(stream, awStart);
  const acStart = skipInsignificant(stream, aw.end);
  const ac = readNumber(stream, acStart);
  const awText = decodeLatin1(stream, aw.start, aw.end);
  const acText = decodeLatin1(stream, ac.start, ac.end);
  const replacement = textEncoder.encode(`${awText} Tw ${acText} Tc T*`);
  return spliceBytes(stream, run.start, run.end, replacement);
}
