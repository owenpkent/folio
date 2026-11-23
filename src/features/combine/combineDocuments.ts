import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFObjectCopier,
  PDFPage,
  PDFPageLeaf,
  PDFRef,
  PDFString,
} from 'pdf-lib';

import { hasPdfHeader, MIN_PDF_BYTES } from '@/core/pdf/pdfHeader';

/** One PDF to fold into the combined document, in the order it should appear. */
export interface CombineInput {
  name: string;
  /**
   * The raw file. Optional because the combine modal drops its copy once
   * {@link stagePdf} has parsed it into `doc` (see `PendingFile.bytes`);
   * exactly one of `bytes` and `doc` has to be present.
   */
  bytes?: Uint8Array;
  /**
   * Already-parsed document, when a caller (the combine modal's staging
   * list, via {@link stagePdf}) parsed it earlier to read a page count.
   * Reused instead of parsing `bytes` a second time.
   */
  doc?: PDFDocument;
}

/**
 * Ceilings on what one merge will accept.
 *
 * Every input is held as a parsed object graph for the length of the run and
 * the merged document grows into a copy of all of them, so an unbounded
 * combine is a memory-exhaustion hang reachable through ordinary use (drop
 * forty large PDFs at once). The print feature already sets the convention of
 * refusing up front and saying how to proceed rather than falling over
 * halfway; these are the equivalent for combine. Generous enough that no
 * realistic merge meets them, low enough that a runaway one stops.
 */
export const MAX_COMBINE_INPUTS = 50;
export const MAX_COMBINE_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_COMBINE_PAGES = 10_000;

/** Progress and cancellation hooks for {@link combinePdfs}. */
export interface CombineOptions {
  /** Called after each input is folded in, with the count done so far. */
  onProgress?: (done: number, total: number) => void;
  /** Polled between inputs; a `true` stops the merge (see {@link CombineCancelledError}). */
  isCancelled?: () => boolean;
}

/**
 * Thrown by {@link combinePdfs} when `isCancelled` reports true mid-merge.
 * Not a failure: like the print and OCR features' own cancel, this is a user
 * action, and callers should stop quietly rather than surface it as an error.
 */
export class CombineCancelledError extends Error {
  constructor() {
    super('Combine cancelled');
    this.name = 'CombineCancelledError';
  }
}

export interface CombineResult {
  bytes: Uint8Array;
  /**
   * True when at least one input carried AcroForm fields. Fields are merged
   * best-effort (see {@link mergeAcroForm}): each input's own field tree,
   * default resources and default appearance are carried over, and a
   * top-level field name that collides with one already merged from an
   * earlier input is suffixed so the two do not silently fuse into one
   * field. True on every clean forms merge, not just a degraded one -- see
   * {@link formsDegraded} for the one worth telling the user about.
   */
  formsMerged: boolean;
  /**
   * True when the forms merge actually lost something. Either two inputs used
   * the same top-level `/DR` resource key (most commonly both having their
   * own `/Font` dict) for resources that are not the same, and the first
   * input's mapping won, so the later input's is not in the merged document;
   * or an input carried an `/XFA` packet, which is a second form definition
   * in its own right and cannot be merged with another at all. The `/DR` case
   * only changes a field's rendered appearance if it is regenerated later
   * (typically by re-editing the field after the combine), not how the
   * document first opens, but both are a real, if narrow, loss -- unlike
   * {@link formsMerged}, which is also true for a merge with nothing to warn
   * about, this is the flag that should actually trigger a warning.
   */
  formsDegraded: boolean;
}

/** Title set on the merged document when the first input has none of its own. */
const COMBINED_TITLE = 'Combined document';

/**
 * How many pages to copy between yields (and cancellation checks) inside one
 * input. A single large input is otherwise one uninterrupted task: the
 * per-input checks below run between files, which does nothing for a lone
 * 500-page document, and staging or combining several 50MB PDFs is exactly
 * the case finding this had no yield points at all was written about.
 */
const PAGES_PER_YIELD = 8;

/**
 * Merge PDFs into one document: every page of the first input, then every
 * page of the second, and so on, in input order. Metadata (title, author,
 * subject, keywords, creator, producer) is carried forward from the first
 * input, and each input's AcroForm fields, if any, are merged in
 * (best-effort; see {@link CombineResult.formsMerged} and
 * {@link CombineResult.formsDegraded}). Every input's named destinations are
 * carried over too, so links that jump by name still resolve (see
 * {@link mergeNamedDestinations}); a name two inputs share is kept for the
 * first and the later one is renamed, along with the links that use it.
 *
 * An input this function has to parse itself is validated with
 * {@link looksLikePdf} first; one that arrives already parsed (the modal's
 * staging list, which ran the same check through {@link stagePdf}) is taken
 * as given rather than re-validated against bytes it may no longer hold.
 * Either way `PDFDocument.load` is never called with `ignoreEncryption`, so a
 * corrupt or password-protected file fails loudly, naming the offending file,
 * rather than silently combining a document nobody could actually open.
 */
export async function combinePdfs(
  inputs: CombineInput[],
  options: CombineOptions = {},
): Promise<CombineResult> {
  if (inputs.length < 2) {
    throw new Error('Choose at least two PDFs to combine');
  }
  if (inputs.length > MAX_COMBINE_INPUTS) {
    throw new Error(
      `Combine takes up to ${MAX_COMBINE_INPUTS} files at once. Combine them in batches, then combine the results.`,
    );
  }

  // updateMetadata: false here as well as on every load() below. pdf-lib
  // stamps its own Producer and Creator onto a document at create() time and
  // again at save() time, and copyMetadata only overwrites them when the
  // first input has its own -- so without this the merged file claims pdf-lib
  // as its producer whenever the first input named none, which is exactly the
  // outcome loadInput's comment says this code prevents.
  const out = await PDFDocument.create({ updateMetadata: false });
  let firstSrc: PDFDocument | null = null;
  let formsMerged = false;
  let formsDegraded = false;
  let pagesCopied = 0;
  // Shared across every input, not reset per file: a top-level field name
  // from input 3 has to be checked against inputs 1 and 2 as well.
  const usedFieldNames = new Set<string>();
  // Likewise shared: a destination name from input 3 is checked against 1 and 2.
  const destinations: MergedDestinations = {
    strings: new Map(),
    names: new Map(),
    used: new Set(),
  };

  for (let i = 0; i < inputs.length; i++) {
    if (options.isCancelled?.()) throw new CombineCancelledError();

    const input = inputs[i];
    const src = await loadInput(input);
    if (!firstSrc) firstSrc = src;

    // pdf-lib's parser is lenient about malformed content: a corrupt file
    // often loads without `PDFDocument.load` itself throwing, then fails once
    // something walks its (missing or broken) page tree. Both stages are
    // wrapped the same way so either failure still names the offending file.
    try {
      await src.flush();
      // Our own copier, not `out.copyPages()`: that convenience method
      // builds a private copier internally and never hands it back, so a
      // second, separate copy pass for the AcroForm fields below would not
      // share its de-duplication cache. A widget annotation copied into a
      // page's /Annots and the same widget copied into the AcroForm's field
      // tree must land on the *same* destination object, or the two halves
      // of the field desync: filling it in one place would not show up in
      // the other.
      const copier = PDFObjectCopier.for(src.context, out.context);
      const srcPages = src.getPages();
      if (pagesCopied + srcPages.length > MAX_COMBINE_PAGES) {
        throw new Error(
          `These files add up to more than ${MAX_COMBINE_PAGES} pages, which is more than one combine can hold. Combine them in smaller groups.`,
        );
      }
      for (let p = 0; p < srcPages.length; p++) {
        // Checked per page, not just per input: a cancel requested partway
        // through one large document used to only be noticed after every one
        // of its pages had already been copied.
        if (options.isCancelled?.()) throw new CombineCancelledError();
        // Copied by *ref*, not by node. Passing the node object copies it
        // outside the copier's src-ref-to-dest-ref cache, so a widget
        // annotation's own /P (which is a ref) later drags in a second,
        // orphaned copy of the same page. Going through the ref puts one page
        // object in the cache for everything else that points at it.
        const pageRef = copier.copy(srcPages[p].ref);
        const pageNode = out.context.lookup(pageRef);
        // The copier copies a page leaf as a page leaf; `lookup` just has no
        // overload for that subclass of PDFDict. The check narrows the type
        // and would catch the copied graph not being what this assumes.
        if (!(pageNode instanceof PDFPageLeaf)) {
          throw new Error('the copied page is not a page object');
        }
        out.addPage(PDFPage.of(pageNode, pageRef, out));
        if ((p + 1) % PAGES_PER_YIELD === 0) await yieldToUi();
      }
      pagesCopied += srcPages.length;
      const form = mergeAcroForm(out, src, copier, usedFieldNames);
      if (form.merged) formsMerged = true;
      if (form.degraded) formsDegraded = true;
      const renames = mergeNamedDestinations(
        src,
        copier,
        new Set(srcPages.map((page) => page.ref.toString())),
        destinations,
      );
      if (renames.strings.size > 0 || renames.names.size > 0) {
        const firstPage = pagesCopied - srcPages.length;
        rewriteDestinationReferences(
          out.getPages().slice(firstPage, firstPage + srcPages.length),
          renames,
        );
      }
    } catch (error) {
      // Not wrapped with namedError below: a cancellation is not a failure of
      // this input, and namedError would bury CombineCancelledError's
      // identity inside a generic Error, which is exactly what callers use
      // instanceof on to tell "the user stopped this" from "this PDF is bad".
      if (error instanceof CombineCancelledError) throw error;
      throw namedError(input.name, error);
    }

    options.onProgress?.(i + 1, inputs.length);
    // Yield so the modal can repaint progress and the cancel button stays
    // clickable between files even when every individual input is small
    // enough that the per-page yields above never fire.
    await yieldToUi();
  }

  writeNamedDestinations(out, destinations);
  if (firstSrc) copyMetadata(out, firstSrc);

  // Checked here and again below, either side of save(). On a large output
  // save() is the single longest step and the only work left once the loop
  // above is done, so a cancel arriving during it used to be noticed by
  // nobody: the caller went straight on to load the result, replacing
  // whatever document the user was actually looking at.
  if (options.isCancelled?.()) throw new CombineCancelledError();
  const bytes = await out.save();
  if (options.isCancelled?.()) throw new CombineCancelledError();

  return { bytes, formsMerged, formsDegraded };
}

/**
 * Carry title/author/subject/keywords/creator/producer and the two dates
 * forward from `first`.
 *
 * The dates are copied rather than left unset because `out` is created with
 * `updateMetadata: false` (see {@link combinePdfs}), which stops pdf-lib
 * stamping its own producer but also stops it filling in any dates at all.
 */
function copyMetadata(out: PDFDocument, first: PDFDocument): void {
  out.setTitle(first.getTitle() ?? COMBINED_TITLE);
  const author = first.getAuthor();
  if (author !== undefined) out.setAuthor(author);
  const subject = first.getSubject();
  if (subject !== undefined) out.setSubject(subject);
  const keywords = first.getKeywords();
  // A single-element array: setKeywords() joins with a space, and joining one
  // element is a no-op, so the original string round-trips unchanged rather
  // than being re-split on some assumed separator.
  if (keywords !== undefined) out.setKeywords([keywords]);
  const creator = first.getCreator();
  if (creator !== undefined) out.setCreator(creator);
  const producer = first.getProducer();
  if (producer !== undefined) out.setProducer(producer);
  const creationDate = first.getCreationDate();
  if (creationDate !== undefined) out.setCreationDate(creationDate);
  const modificationDate = first.getModificationDate();
  if (modificationDate !== undefined) out.setModificationDate(modificationDate);
}

/** Whether {@link mergeAcroForm} found fields at all, and whether merging
 * them lost anything (see {@link CombineResult.formsDegraded}). */
interface AcroFormMergeResult {
  merged: boolean;
  degraded: boolean;
}

/**
 * Best-effort merge of one input's AcroForm into the merged document's,
 * using the same {@link PDFObjectCopier} that just copied its pages (see the
 * comment in {@link combinePdfs}).
 */
function mergeAcroForm(
  out: PDFDocument,
  src: PDFDocument,
  copier: PDFObjectCopier,
  usedFieldNames: Set<string>,
): AcroFormMergeResult {
  // The low-level catalog accessor, not `src.getForm()`: the high-level
  // `PDFForm.getFields()` calls `PDFAcroForm.getAllFields()`, which flattens
  // every non-terminal field's `/Kids` into the result too. Adding those to
  // `outAcroForm` below as if they were top-level fields would duplicate them
  // -- once as their own `/Fields` entry, once already nested under the
  // parent this copies right along with it. `PDFAcroForm.getFields()` (this
  // one) returns only the immediate top-level entries, each still carrying
  // its whole `/Kids` subtree for the copier to bring along.
  const srcAcroForm = src.catalog.getAcroForm();
  if (!srcAcroForm) return { merged: false, degraded: false };

  const srcFields = srcAcroForm.getFields();
  if (srcFields.length === 0) return { merged: false, degraded: false };

  const outAcroForm = out.catalog.getOrCreateAcroForm();
  for (const [, ref] of srcFields) {
    // Copied by *ref*, and emphatically not `register(copier.copy(dict))`.
    // The copier is keyed by source ref, and the page loop above has already
    // copied and registered this very object as the page's widget annotation:
    // handing it the dict returns that same cached copy, but `register` never
    // checks whether an object already has a ref, so it minted a second one.
    // /AcroForm/Fields then pointed at an object no page referenced, which is
    // precisely the desync the copier is shared to prevent -- filling a
    // merged field wrote to the orphan while the viewer painted the widget.
    const copiedRef = copier.copy(ref);
    disambiguateFieldName(out.context.lookup(copiedRef, PDFDict), usedFieldNames);
    outAcroForm.addField(copiedRef);
  }

  const droppedResources = mergeDefaultResources(outAcroForm.dict, srcAcroForm.dict, copier);
  mergeDefaultAppearance(outAcroForm.dict, srcAcroForm.dict, copier);
  const droppedXfa = mergeAcroFormSettings(out, outAcroForm.dict, srcAcroForm.dict, copier);

  return { merged: true, degraded: droppedResources || droppedXfa };
}

/**
 * Carry the AcroForm-level entries that are not the field tree itself forward
 * from `srcDict`, and report whether anything had to be dropped.
 *
 * `getOrCreateAcroForm()` starts from a bare `{ Fields: [] }`, so every key
 * not handled here is simply lost. /NeedAppearances is the one with visible
 * consequences: a form whose fields carry no appearance streams relies on the
 * viewer to generate them, and nothing downstream compensates -- because this
 * merge only ever touches the low-level catalog AcroForm and never calls
 * `out.getForm()`, pdf-lib's own `updateFieldAppearances` pass at save time is
 * a no-op on an unpopulated form cache. Without the flag those fields render
 * blank in the merged document while still holding their values.
 */
function mergeAcroFormSettings(
  out: PDFDocument,
  outDict: PDFDict,
  srcDict: PDFDict,
  copier: PDFObjectCopier,
): boolean {
  // Any input needing generated appearances means the merged document does.
  if (srcDict.lookupMaybe(PDFName.of('NeedAppearances'), PDFBool)?.asBoolean()) {
    outDict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  }

  // Bit flags (1 = the document contains signature fields, 2 = append-only),
  // so they are OR-ed: a later input's flags must not clear an earlier one's.
  const sigFlags = srcDict.lookupMaybe(PDFName.of('SigFlags'), PDFNumber);
  if (sigFlags) {
    const existing = outDict.lookupMaybe(PDFName.of('SigFlags'), PDFNumber)?.asNumber() ?? 0;
    outDict.set(PDFName.of('SigFlags'), PDFNumber.of(existing | sigFlags.asNumber()));
  }

  // A single default quadding for the whole form, so the first input wins,
  // the same way /DA does.
  const quadding = srcDict.lookupMaybe(PDFName.of('Q'), PDFNumber);
  if (quadding && !outDict.has(PDFName.of('Q'))) {
    outDict.set(PDFName.of('Q'), PDFNumber.of(quadding.asNumber()));
  }

  // Calculation order: append this input's entries after any already carried
  // over, which preserves each input's own internal ordering.
  const srcCalcOrder = srcDict.lookupMaybe(PDFName.of('CO'), PDFArray);
  if (srcCalcOrder) {
    let outCalcOrder = outDict.lookupMaybe(PDFName.of('CO'), PDFArray);
    if (!outCalcOrder) {
      outCalcOrder = PDFArray.withContext(out.context);
      outDict.set(PDFName.of('CO'), outCalcOrder);
    }
    for (const entry of srcCalcOrder.asArray()) outCalcOrder.push(copier.copy(entry));
  }

  // /XFA is a whole second form definition (an XML packet describing its own
  // layout and logic) and two of them do not compose into one. Reported as a
  // degraded merge rather than dropped in silence.
  return srcDict.has(PDFName.of('XFA'));
}

/**
 * Rename `dict`'s top-level `/T` if it collides with a name already used by
 * an earlier input, so two unrelated fields (most commonly two same-named
 * radio groups) do not fuse into one shared field. A field's own nested
 * `/Kids` are left untouched: their names are already qualified by this
 * top-level name, so disambiguating it disambiguates the whole subtree.
 */
function disambiguateFieldName(dict: PDFDict, usedNames: Set<string>): void {
  const original = dict.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString)?.decodeText() ?? '';
  let name = original;
  for (let suffix = 2; usedNames.has(name); suffix += 1) {
    name = `${original} (${suffix})`;
  }
  usedNames.add(name);
  // PDFHexString.fromText, not PDFString.of. A literal PDF string is written
  // one byte per code unit, so `PDFString.of` truncates every non-Latin-1
  // character to 8 bits (a Japanese field name comes back as mojibake, and
  // pdf-lib stores /T as a hex string in the first place, so this would be
  // downgrading an encoding that was already correct). It also emits the text
  // unescaped, so a name containing `)` closed the string early and produced
  // a file that will not parse -- on the one path this function exists for.
  if (name !== original) dict.set(PDFName.of('T'), PDFHexString.fromText(name));
}

/**
 * Fold `src`'s /DR into `out`'s, keeping the first input's mapping on a
 * colliding key. Returns true if a key collided: `/DR`'s own keys are broad
 * categories (`/Font`, `/ColorSpace`, ...), each holding a whole dict of its
 * own, so a collision here means one input's entire category -- not merged
 * key by key below that -- was dropped in favor of the earlier input's,
 * which is the one gap in this merge worth telling the user about.
 */
function mergeDefaultResources(
  outDict: PDFDict,
  srcDict: PDFDict,
  copier: PDFObjectCopier,
): boolean {
  const srcDR = srcDict.lookupMaybe(PDFName.of('DR'), PDFDict);
  if (!srcDR) return false;
  const copiedDR = copier.copy(srcDR);

  const outDR = outDict.lookupMaybe(PDFName.of('DR'), PDFDict);
  if (!outDR) {
    outDict.set(PDFName.of('DR'), copiedDR);
    return false;
  }
  let collided = false;
  for (const [key, value] of copiedDR.entries()) {
    if (!outDR.has(key)) outDR.set(key, value);
    else collided = true;
  }
  return collided;
}

/** Carry `src`'s /DA forward if `out` does not already have one from an earlier input. */
function mergeDefaultAppearance(outDict: PDFDict, srcDict: PDFDict, copier: PDFObjectCopier): void {
  if (outDict.has(PDFName.of('DA'))) return;
  const da = srcDict.lookupMaybe(PDFName.of('DA'), PDFString, PDFHexString);
  if (da) outDict.set(PDFName.of('DA'), copier.copy(da));
}

/**
 * Ceilings on the walks over an untrusted input's destinations. A name tree
 * is attacker-shaped (a kid can point back at an ancestor, a node can nest
 * without end, a table can hold millions of pairs), so every walk is bounded
 * rather than trusted to terminate.
 */
const MAX_NAMED_DESTINATIONS_PER_INPUT = 100_000;
const MAX_NAME_TREE_DEPTH = 32;
const MAX_ACTION_CHAIN_DEPTH = 16;
/** PDF 7.9.6 leaves no size; 64 keeps each node small and is what readers expect. */
const NAME_TREE_LEAF_SIZE = 64;

/**
 * Named destinations merged so far. Keys are identities: the raw bytes of a
 * string key (one char per byte), or the decoded text of a name key. `used`
 * holds both kinds, so one namespace covers them.
 */
interface MergedDestinations {
  strings: Map<string, PDFArray>;
  names: Map<string, PDFArray>;
  used: Set<string>;
}

/** Original identity to new identity, for the names one input had to rename. */
interface DestinationRenames {
  strings: Map<string, string>;
  names: Map<string, string>;
}

/**
 * Typed reads for the destination walks. `lookupMaybe` returns undefined for a
 * missing entry but throws for one of another type. That suits the AcroForm
 * merge, which depends on what it reads, and is wrong here: carrying
 * destinations over is best-effort, and a malformed table should cost that
 * input its named links, not fail a combine that worked before this existed.
 */
function dictOf(value: PDFObject | undefined): PDFDict | undefined {
  return value instanceof PDFDict ? value : undefined;
}

function arrayOf(value: PDFObject | undefined): PDFArray | undefined {
  return value instanceof PDFArray ? value : undefined;
}

/**
 * A name object for already-decoded text. `PDFName.of` reads `#xx` in its
 * argument as an escape, so a literal `#` is escaped first; otherwise a
 * destination called `a#41` would be written back as `aA` and its links,
 * which still say `a#41`, would dangle.
 */
function nameFromText(text: string): PDFName {
  return PDFName.of(text.replace(/#/g, '#23'));
}

/** Bytes to a string with one char per byte, so JS string order is byte order. */
function bytesToIdentity(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** The inverse of {@link bytesToIdentity}; identities only hold chars 0-255. */
function identityToHex(identity: string): PDFHexString {
  let hex = '';
  for (let i = 0; i < identity.length; i++) {
    hex += (identity.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
  }
  return PDFHexString.of(hex);
}

/**
 * The destination array a name-tree or /Dests value stands for: the array
 * itself, or the `/D` of a dictionary wrapping it. Undefined for anything
 * else, and for an array that does not lead with one of this input's pages.
 * A destination aimed anywhere else was already dangling, and copying an
 * arbitrary object graph through the copier on its behalf is not acceptable.
 */
function validDestination(
  value: PDFObject | undefined,
  pageRefs: Set<string>,
): PDFArray | undefined {
  const array = value instanceof PDFDict ? value.lookup(PDFName.of('D')) : value;
  if (!(array instanceof PDFArray)) return undefined;
  const target = array.get(0);
  return target instanceof PDFRef && pageRefs.has(target.toString()) ? array : undefined;
}

interface CollectedDestinations {
  strings: Map<string, PDFArray>;
  names: Map<string, PDFArray>;
}

/**
 * Read one input's named destinations from both places they live: the
 * `/Names` `/Dests` name tree (string keys) and the older catalog `/Dests`
 * dictionary (name keys). The first definition of an identity wins. The walk
 * is bounded by depth, by a visited set of node refs (cycles) and by a cap on
 * pairs examined.
 */
function collectNamedDestinations(src: PDFDocument, pageRefs: Set<string>): CollectedDestinations {
  const found: CollectedDestinations = { strings: new Map(), names: new Map() };
  let examined = 0;

  const dests = dictOf(src.catalog.lookup(PDFName.of('Dests')));
  if (dests) {
    for (const [key, value] of dests.entries()) {
      if (++examined > MAX_NAMED_DESTINATIONS_PER_INPUT) break;
      const array = validDestination(
        value instanceof PDFRef ? src.context.lookup(value) : value,
        pageRefs,
      );
      const id = key.decodeText();
      if (array && !found.names.has(id)) found.names.set(id, array);
    }
  }

  const root = dictOf(dictOf(src.catalog.lookup(PDFName.of('Names')))?.lookup(PDFName.of('Dests')));
  if (!root) return found;
  const visited = new Set<PDFDict>();
  const stack: Array<{ node: PDFDict; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry || visited.has(entry.node)) continue;
    visited.add(entry.node);
    const pairs = arrayOf(entry.node.lookup(PDFName.of('Names')));
    for (let i = 0; pairs && i + 1 < pairs.size(); i += 2) {
      if (++examined > MAX_NAMED_DESTINATIONS_PER_INPUT) return found;
      const key = pairs.lookup(i);
      if (!(key instanceof PDFString || key instanceof PDFHexString)) continue;
      const array = validDestination(pairs.lookup(i + 1), pageRefs);
      const id = bytesToIdentity(key.asBytes());
      if (array && !found.strings.has(id)) found.strings.set(id, array);
    }
    const kids = arrayOf(entry.node.lookup(PDFName.of('Kids')));
    if (!kids || entry.depth >= MAX_NAME_TREE_DEPTH) continue;
    for (let i = kids.size() - 1; i >= 0; i--) {
      const kid = dictOf(kids.lookup(i));
      if (kid) stack.push({ node: kid, depth: entry.depth + 1 });
    }
  }
  return found;
}

/**
 * Carry one input's named destinations into `merged`, using the copier that
 * just copied its pages so each destination's page ref lands on the
 * already-copied page. Names stay unique across inputs: a name an earlier
 * input already owns is renamed for this (later) input by appending `~2`,
 * `~3`, and so on, which needs no escaping in a name or a string. Returns the
 * renames, so the links that use them can follow.
 *
 * Only destinations are carried. Nothing else under an input's `/Names`
 * (embedded files, JavaScript, and so on) is copied: each is its own feature
 * with its own risks and none is what a dangling link needs.
 */
function mergeNamedDestinations(
  src: PDFDocument,
  copier: PDFObjectCopier,
  pageRefs: Set<string>,
  merged: MergedDestinations,
): DestinationRenames {
  const found = collectNamedDestinations(src, pageRefs);
  const renames: DestinationRenames = { strings: new Map(), names: new Map() };
  // This input's own identities, so a renamed entry cannot land on a sibling.
  const taken = new Set<string>([...found.strings.keys(), ...found.names.keys()]);
  const placed: string[] = [];

  const place = (
    from: Map<string, PDFArray>,
    into: Map<string, PDFArray>,
    renamed: Map<string, string>,
  ): void => {
    for (const [id, array] of from) {
      let finalId = id;
      if (merged.used.has(id)) {
        for (let n = 2; ; n++) {
          const candidate = `${id}~${n}`;
          if (!merged.used.has(candidate) && !taken.has(candidate)) {
            finalId = candidate;
            break;
          }
        }
        renamed.set(id, finalId);
        taken.add(finalId);
      }
      into.set(finalId, copier.copy(array));
      placed.push(finalId);
    }
  };
  place(found.strings, merged.strings, renames.strings);
  place(found.names, merged.names, renames.names);
  // Added after both kinds are placed: a name and a string of the same text in
  // one input are separate destinations and must not rename each other.
  for (const id of placed) merged.used.add(id);
  return renames;
}

/** The replacement for a destination reference naming a renamed destination. */
function renamedTarget(
  value: PDFObject | undefined,
  renames: DestinationRenames,
): PDFObject | undefined {
  if (value instanceof PDFName) {
    const next = renames.names.get(value.decodeText());
    return next === undefined ? undefined : nameFromText(next);
  }
  if (value instanceof PDFString || value instanceof PDFHexString) {
    const next = renames.strings.get(bytesToIdentity(value.asBytes()));
    return next === undefined ? undefined : identityToHex(next);
  }
  return undefined;
}

/**
 * Point a `/GoTo` action (and the actions chained after it through `/Next`) at
 * a renamed destination. Depth-capped, with a visited set, since `/Next` is
 * attacker-shaped and can loop.
 */
function rewriteAction(
  action: PDFDict,
  renames: DestinationRenames,
  depth: number,
  visited: Set<PDFDict>,
): void {
  if (depth > MAX_ACTION_CHAIN_DEPTH || visited.has(action)) return;
  visited.add(action);
  // PDFName instances are interned, so identity is equality.
  if (action.lookup(PDFName.of('S')) === PDFName.of('GoTo')) {
    const next = renamedTarget(action.lookup(PDFName.of('D')), renames);
    if (next) action.set(PDFName.of('D'), next);
  }
  const chained = action.lookup(PDFName.of('Next'));
  if (chained instanceof PDFDict) {
    rewriteAction(chained, renames, depth + 1, visited);
  } else if (chained instanceof PDFArray) {
    for (let i = 0; i < chained.size(); i++) {
      const item = dictOf(chained.lookup(i));
      if (item) rewriteAction(item, renames, depth + 1, visited);
    }
  }
}

/**
 * Update the links on `pages` (this input's copied pages) that name a
 * destination which had to be renamed: an annotation's `/Dest`, its `/A`
 * action chain and its `/AA` additional actions. Only run for an input that
 * had renames, and only over its own pages, so another input's links, which
 * name their own destinations, are never touched.
 */
function rewriteDestinationReferences(pages: PDFPage[], renames: DestinationRenames): void {
  const visited = new Set<PDFDict>();
  for (const page of pages) {
    const annots = arrayOf(page.node.lookup(PDFName.of('Annots')));
    for (let i = 0; annots && i < annots.size(); i++) {
      const annot = dictOf(annots.lookup(i));
      if (!annot) continue;
      const dest = renamedTarget(annot.lookup(PDFName.of('Dest')), renames);
      if (dest) annot.set(PDFName.of('Dest'), dest);
      const action = dictOf(annot.lookup(PDFName.of('A')));
      if (action) rewriteAction(action, renames, 0, visited);
      const additional = dictOf(annot.lookup(PDFName.of('AA')));
      if (!additional) continue;
      for (const [key] of additional.entries()) {
        const extra = dictOf(additional.lookup(key));
        if (extra) rewriteAction(extra, renames, 0, visited);
      }
    }
  }
}

/**
 * Write the merged destinations into `out`'s catalog: string keys as a
 * `/Names` `/Dests` name tree, name keys as a `/Dests` dictionary. Per PDF
 * 7.9.6 the tree's keys are sorted by raw byte order; up to
 * {@link NAME_TREE_LEAF_SIZE} entries sit in the root's `/Names`, and more go
 * in leaf kids, each with `/Limits`, so no node grows without bound.
 */
function writeNamedDestinations(out: PDFDocument, merged: MergedDestinations): void {
  const context = out.context;
  if (merged.strings.size > 0) {
    const entries = [...merged.strings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const leaf = (chunk: Array<[string, PDFArray]>): PDFDict => {
      const names = PDFArray.withContext(context);
      for (const [id, array] of chunk) {
        names.push(identityToHex(id));
        names.push(array);
      }
      return context.obj({ Names: names });
    };
    let tree: PDFDict;
    if (entries.length <= NAME_TREE_LEAF_SIZE) {
      tree = leaf(entries);
    } else {
      const kids = PDFArray.withContext(context);
      for (let i = 0; i < entries.length; i += NAME_TREE_LEAF_SIZE) {
        const chunk = entries.slice(i, i + NAME_TREE_LEAF_SIZE);
        const kid = leaf(chunk);
        kid.set(
          PDFName.of('Limits'),
          context.obj([identityToHex(chunk[0][0]), identityToHex(chunk[chunk.length - 1][0])]),
        );
        kids.push(context.register(kid));
      }
      tree = context.obj({ Kids: kids });
    }
    out.catalog.set(PDFName.of('Names'), context.obj({ Dests: tree }));
  }
  if (merged.names.size > 0) {
    const dests = context.obj({});
    for (const [id, array] of merged.names) dests.set(nameFromText(id), array);
    out.catalog.set(PDFName.of('Dests'), dests);
  }
}

export interface StagedPdf {
  pageCount: number;
  doc: PDFDocument;
}

/**
 * Parse one input and read its page count, for the combine modal's per-row
 * display. Shares {@link loadInput}'s validation, so a file the modal cannot
 * even stage is one {@link combinePdfs} would also reject later. The parsed
 * document comes back too, so the caller can cache it on the pending file
 * and hand it to {@link combinePdfs} via {@link CombineInput.doc}, instead of
 * parsing the same bytes a second time when the merge actually runs.
 */
export async function stagePdf(bytes: Uint8Array, name: string): Promise<StagedPdf> {
  const doc = await loadInput({ name, bytes });
  try {
    return { pageCount: doc.getPageCount(), doc };
  } catch (error) {
    throw namedError(name, error);
  }
}

// The spec (ISO 32000, section 7.5.2 note) allows up to 1024 bytes of junk
// before the `%PDF-` header, and such files exist in the wild; pdf-lib loads
// them. So unlike the export feature's `isPlausiblePdf`, which validates our
// own output and can insist the header comes first, this scan has to be
// lenient about where the header sits.
const HEADER_SEARCH_LIMIT = 1024;

function looksLikePdf(bytes: Uint8Array): boolean {
  // Same floor the export feature checks its own output against: a file
  // under it cannot be a real PDF regardless of what bytes happen to appear
  // in it, so there is no point scanning for a header at all.
  if (bytes.length < MIN_PDF_BYTES) return false;
  return hasPdfHeader(bytes, HEADER_SEARCH_LIMIT);
}

async function loadInput(input: CombineInput): Promise<PDFDocument> {
  if (input.doc) return input.doc;
  if (!input.bytes) {
    throw new Error(`"${input.name}" has not been read yet`);
  }
  if (input.bytes.byteLength > MAX_COMBINE_INPUT_BYTES) {
    throw new Error(
      `"${input.name}" is too large to combine (over ${Math.round(MAX_COMBINE_INPUT_BYTES / (1024 * 1024))}MB).`,
    );
  }
  if (!looksLikePdf(input.bytes)) {
    throw new Error(`"${input.name}" does not look like a PDF`);
  }
  try {
    // updateMetadata: false, or pdf-lib stamps its own Producer and
    // modification date onto this document the moment it is parsed --
    // before copyMetadata ever gets to read the input's real ones. Without
    // this, every merged document would carry pdf-lib's signature as its
    // Producer regardless of what the first input's actually was.
    return await PDFDocument.load(input.bytes, { updateMetadata: false });
  } catch (error) {
    if (isEncryptedPdfError(error)) {
      throw errorWithCause(
        `"${input.name}" is password-protected; remove the password and try again.`,
        error,
      );
    }
    throw namedError(input.name, error);
  }
}

/**
 * Whether `error` is pdf-lib's `EncryptedPDFError`, thrown by `PDFDocument.load`
 * when a document's trailer carries an `/Encrypt` entry.
 *
 * Not an `instanceof EncryptedPDFError` check: pdf-lib is compiled down with
 * tslib's ES5 `__extends`, and subclassing the built-in `Error` through that
 * pattern is a well-known TypeScript/V8 gap -- `Error`'s own constructor
 * returns a fresh object rather than initializing `this`, so the subclass's
 * prototype never actually ends up on the thrown instance. Verified directly:
 * a freshly thrown `EncryptedPDFError` fails `instanceof EncryptedPDFError`
 * and even reports `constructor.name === 'Error'`, reproducibly, with no
 * bundler or test runner involved. The message is the only reliable signal
 * pdf-lib gives for this specific failure.
 */
function isEncryptedPdfError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('is encrypted');
}

/** Wrap a lower-level failure so it names which input caused it. */
function namedError(name: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return errorWithCause(`Could not read "${name}": ${reason}`, error);
}

/**
 * `new Error(message)` with `.cause` set to the lower-level error, so the
 * original is still reachable (devtools, error-reporting tools) even though
 * the message above already folds its text in for a human reading it.
 *
 * A cast, not `new Error(message, { cause })` directly: this project's `lib`
 * target is ES2021, which predates the `cause` option TypeScript added to the
 * `Error` constructor's types in ES2022. The option itself is a plain runtime
 * property that every engine Folio targets already supports; only the type
 * declaration is missing at this `lib` level.
 */
function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

/** Give the event loop a turn between inputs (see the call site in {@link combinePdfs}). */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
