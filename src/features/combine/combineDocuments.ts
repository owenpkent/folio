import {
  PDFArray,
  PDFBool,
  type PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
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
 * first and the later one is renamed, along with the links that use it, and a
 * link to a name its own file never defined stays unresolved.
 * Page labels (such as i, ii, iii for front matter) are carried too, so every
 * page keeps the label it had in its own file; an input without labels
 * restarts at 1 (see {@link writePageLabels}).
 * The document outline (bookmarks) of every input is carried too: the
 * combined top level is each input's top-level items, in input order, with
 * nothing added between them. An input without bookmarks contributes none, and
 * when no input has any the combined file has no outline (see
 * {@link writeOutlines}).
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
  const destinations: MergedDestinations = { entries: new Map(), used: new Set() };
  // Per input, and only written once the loop is done: whether any input has
  // labels decides whether the unlabelled ones need an explicit restart.
  const pageLabels: InputPageLabels[] = [];
  // Per input too, and joined at one level once the loop is done (see
  // writeOutlines): the top-level items of every input, in input order.
  const outlines: OutlineNode[] = [];

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
      // An input with no pages has no page to label, and its offset is the
      // next input's: a range for it would put two entries at one index.
      if (srcPages.length > 0) {
        pageLabels.push({
          offset: pagesCopied - srcPages.length,
          ranges: collectPageLabels(src, srcPages.length, out.context),
        });
      }
      const form = mergeAcroForm(out, src, copier, usedFieldNames);
      if (form.merged) formsMerged = true;
      if (form.degraded) formsDegraded = true;
      const pageRefs = new Set(srcPages.map((page) => page.ref.toString()));
      const renames = mergeNamedDestinations(src, copier, pageRefs, destinations, out.context);
      // Right after the destinations: a bookmark that jumps by name has to
      // follow the same renames this input's links just got.
      // A loop, not a spread: an outline can hold tens of thousands of
      // top-level items, and a spread passes each one as a call argument.
      for (const node of collectOutline(src, pageRefs, copier, renames, out.context)) {
        outlines.push(node);
      }
      // Every input, not only one that had renames: a link to a name this
      // input never defined has to be dealt with too (see DestinationRenames).
      const firstPage = pagesCopied - srcPages.length;
      rewriteDestinationReferences(
        out.getPages().slice(firstPage, firstPage + srcPages.length),
        renames,
      );
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
  writePageLabels(out, pageLabels);
  writeOutlines(out, outlines);
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
 * How named destinations are merged, in one place, because every part of it
 * was got wrong once.
 *
 * A reader finds a destination two ways. A strict one compares the BYTES of a
 * link's name with the bytes of a key. A lenient one (PDF.js, Folio's own
 * reader) decodes both and compares the TEXT, so `(intro)` and the UTF-16
 * spelling of `intro` are one name to it, and so are the name object `/x#80`
 * and the string `<7880>`. Neither notion is enough alone: by bytes, two
 * inputs spelling one name two ways are both kept and the reader sends one
 * file's links into the other; by text, two keys of ONE input that happen to
 * decode alike are taken for a duplicate and a destination is lost.
 *
 * So the two are kept apart:
 *
 * - Within an input, a definition is identified by its bytes. Every distinct
 *   key is kept, and a reference picks its definition the way a reader would:
 *   the same bytes first, then the same text (see {@link DestinationRenames}).
 * - In the merged file, a definition is identified by its OUTPUT NAME, a text
 *   that is unique among all of them. It starts as the definition's decoded
 *   text, and gets `~2`, `~3`, ... appended when that text is already taken,
 *   by another input or by another key of the same input.
 * - Each output name is written in one spelling (see {@link destinationBytes})
 *   as a key of one name tree, and every reference is rewritten to that same
 *   spelling. After that, bytes and text agree, and both kinds of reader land
 *   on the same destination.
 *
 * The older catalog `/Dests` dictionary (name-object keys) is read, and its
 * entries join the same name tree: one table and one namespace, with the
 * links that used a name object rewritten to the string that now finds it.
 */
interface MergedDestinations {
  /** Output name to destination, for the name tree written at the end. */
  entries: Map<string, PDFArray>;
  /** Every output name taken, including those reserved for dangling links. */
  used: Set<string>;
}

/**
 * How one input's references to named destinations resolve, each to the
 * output name of the definition a reader would have picked in that input.
 *
 * `strings` and `names` are exact matches: the raw bytes of a name-tree key,
 * or of a legacy name key, to its output name. `byText` is the lenient
 * fallback, by decoded text, with PDF.js's own precedence: the last name-tree
 * key with that text, and a legacy key only when no tree key has it.
 *
 * A reference that matches nothing was dangling in its own file, and has to
 * stay dangling. Left alone it would start resolving the moment any other
 * input defines that name: a file split out of a larger one commonly keeps
 * links to `section.1` with no destination behind them, and the next file's
 * own `section.1` would capture every one of them. So such a reference is
 * pointed at an `orphans` name instead, one that is reserved in the shared
 * namespace and that no input can ever define.
 */
interface DestinationRenames {
  strings: Map<string, string>;
  names: Map<string, string>;
  byText: Map<string, string>;
  orphans: Map<string, string>;
  /** The namespace shared by every input, where an orphan name is reserved. */
  used: Set<string>;
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
 * A hex string holding exactly `bytes`. Hex rather than a literal string, so
 * nothing in the bytes (a parenthesis, a backslash, a byte above 127) needs
 * escaping and the value comes back byte-for-byte.
 */
function hexFromBytes(bytes: Uint8Array): PDFHexString {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return PDFHexString.of(hex);
}

/**
 * Bytes as a string, one char per byte, to key a map by exact bytes. A loop,
 * like every conversion here: a name can be as long as its file allows, and
 * `String.fromCharCode(...bytes)` passes each byte as a call argument, which
 * overflowed the stack on a 200,000-byte name and failed the whole combine.
 */
function byteKey(bytes: Uint8Array): string {
  let key = '';
  for (const byte of bytes) key += String.fromCharCode(byte);
  return key;
}

/** Byte order, which is the order PDF 7.9.6 wants a name tree's keys in. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * The bytes a PDF string object stands for, read from how it is written.
 *
 * pdf-lib keeps a string as its source text and its own `asBytes()` does not
 * finish the job: for `<69 6e74726f>` it pairs the characters without first
 * dropping the white space the syntax allows, and for a literal it keeps the
 * line break of a backslash-newline continuation. Both are legal spellings of
 * `intro`, and a key read wrongly is a destination its own links cannot find.
 * This follows PDF 7.3.4.
 */
function stringBytes(value: PDFString | PDFHexString): Uint8Array {
  const raw = value.asString();
  if (value instanceof PDFHexString) {
    // White space may sit anywhere between the digits, and a final lone digit
    // stands for that digit followed by 0.
    const digits = raw.replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(Math.ceil(digits.length / 2));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2).padEnd(2, '0'), 16);
    }
    return bytes;
  }

  const CR = 0x0d;
  const LF = 0x0a;
  const ESCAPES: Record<string, number> = { n: LF, r: CR, t: 0x09, b: 0x08, f: 0x0c };
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i) & 0xff;
    if (code === CR) {
      // A bare line break is one LF however it was written.
      if (raw.charCodeAt(i + 1) === LF) i++;
      bytes.push(LF);
    } else if (code !== 0x5c) {
      bytes.push(code);
    } else if (++i < raw.length) {
      const next = raw[i];
      if (next in ESCAPES) {
        bytes.push(ESCAPES[next]);
      } else if (next >= '0' && next <= '7') {
        // Up to three octal digits; overflow is dropped, as the spec says.
        let octal = next;
        while (octal.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') octal += raw[++i];
        bytes.push(parseInt(octal, 8) & 0xff);
      } else if (next === '\r') {
        // A backslash before a line break continues the string: neither counts.
        if (raw[i + 1] === '\n') i++;
      } else if (next !== '\n') {
        // `\(`, `\)`, `\\`, and a backslash before anything else, which is ignored.
        bytes.push(next.charCodeAt(0) & 0xff);
      }
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * PDFDocEncoding where it differs from Latin-1, as PDF.js has it
 * (`PDFStringTranslateTable`): bytes 0x18 to 0x1F and 0x80 to 0xA0. A byte
 * with no entry stands for the character of the same number. pdf-lib's own
 * table is not used: it turns the undefined bytes into U+FFFD where PDF.js
 * keeps them, so two names PDF.js tells apart would look the same here.
 */
const PDF_DOC_ENCODING: Record<number, number> = {
  0x18: 0x2d8,
  0x19: 0x2c7,
  0x1a: 0x2c6,
  0x1b: 0x2d9,
  0x1c: 0x2dd,
  0x1d: 0x2db,
  0x1e: 0x2da,
  0x1f: 0x2dc,
  0x80: 0x2022,
  0x81: 0x2020,
  0x82: 0x2021,
  0x83: 0x2026,
  0x84: 0x2014,
  0x85: 0x2013,
  0x86: 0x192,
  0x87: 0x2044,
  0x88: 0x2039,
  0x89: 0x203a,
  0x8a: 0x2212,
  0x8b: 0x2030,
  0x8c: 0x201e,
  0x8d: 0x201c,
  0x8e: 0x201d,
  0x8f: 0x2018,
  0x90: 0x2019,
  0x91: 0x201a,
  0x92: 0x2122,
  0x93: 0xfb01,
  0x94: 0xfb02,
  0x95: 0x141,
  0x96: 0x152,
  0x97: 0x160,
  0x98: 0x178,
  0x99: 0x17d,
  0x9a: 0x131,
  0x9b: 0x142,
  0x9c: 0x153,
  0x9d: 0x161,
  0x9e: 0x17e,
  0xa0: 0x20ac,
};

/** UTF-16 after its two-byte mark, or undefined where a strict decoder would refuse it. */
function utf16Text(bytes: Uint8Array, bigEndian: boolean): string | undefined {
  let text = '';
  // An odd trailing byte is dropped, as PDF.js drops it.
  for (let i = 2; i + 1 < bytes.length; i += 2) {
    const unit = bigEndian ? (bytes[i] << 8) | bytes[i + 1] : (bytes[i + 1] << 8) | bytes[i];
    const high = unit >= 0xd800 && unit <= 0xdbff;
    const low = unit >= 0xdc00 && unit <= 0xdfff;
    if (low) return undefined;
    if (high) {
      const j = i + 2;
      if (j + 1 >= bytes.length) return undefined;
      const next = bigEndian ? (bytes[j] << 8) | bytes[j + 1] : (bytes[j + 1] << 8) | bytes[j];
      if (next < 0xdc00 || next > 0xdfff) return undefined;
      text += String.fromCharCode(unit, next);
      i = j;
    } else {
      text += String.fromCharCode(unit);
    }
  }
  return text;
}

/**
 * The text a name's bytes stand for, decoded the way PDF.js decodes it
 * (`stringToPDFString`), since PDF.js is the reader whose idea of "the same
 * name" has to be matched: UTF-16 after either byte-order mark, UTF-8 after
 * its own, and PDFDocEncoding otherwise, which is also the fallback when a
 * marked encoding does not decode. Used for string keys and for the bytes of
 * a legacy name key alike, as PDF.js uses it for both.
 *
 * Written out, with loops: pdf-lib's decoders spread every code point into
 * one call (see {@link byteKey}).
 */
function destinationText(bytes: Uint8Array): string {
  const [b0, b1, b2] = bytes;
  let marked: string | undefined;
  if (b0 === 0xfe && b1 === 0xff) {
    marked = utf16Text(bytes, true);
  } else if (b0 === 0xff && b1 === 0xfe) {
    marked = utf16Text(bytes, false);
  } else if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
    try {
      // Strict UTF-8 without TextDecoder, whose jsdom build rejects a
      // Uint8Array from another realm. A malformed sequence throws.
      let escaped = '';
      for (let i = 3; i < bytes.length; i++)
        escaped += `%${bytes[i].toString(16).padStart(2, '0')}`;
      marked = decodeURIComponent(escaped);
    } catch {
      // Not UTF-8 after all: PDFDocEncoding, as below.
    }
  }
  if (marked !== undefined) return marked;
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(PDF_DOC_ENCODING[byte] ?? byte);
  return text;
}

/**
 * The one spelling an output name is written in, for its key and for every
 * reference to it: plain bytes when the text is printable ASCII, UTF-16BE
 * with a byte-order mark otherwise. Both decode back to exactly the text they
 * were made from, so distinct names stay distinct for a reader that compares
 * bytes and for one that compares text. Derived from the text, so that a
 * suffix added to a name is encoded like the rest of it. (ASCII digits
 * appended to UTF-16 bytes decode as other characters, and `~10` and `~11`
 * came out as the same one.)
 */
function destinationBytes(text: string): Uint8Array {
  let ascii = true;
  for (let i = 0; i < text.length && ascii; i++) {
    const code = text.charCodeAt(i);
    ascii = code >= 0x20 && code <= 0x7e;
  }
  const bytes = new Uint8Array(ascii ? text.length : 2 + text.length * 2);
  if (ascii) {
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }
  bytes[0] = 0xfe;
  bytes[1] = 0xff;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code >> 8;
    bytes[3 + i * 2] = code & 0xff;
  }
  return bytes;
}

/** The views PDF 12.3.2.2 defines for an explicit destination. */
const DESTINATION_FITS = new Set(['XYZ', 'Fit', 'FitH', 'FitV', 'FitR', 'FitB', 'FitBH', 'FitBV']);
/** `/FitR` takes the most: left, bottom, right, top. */
const MAX_DESTINATION_OPERANDS = 4;

/**
 * A destination array for the merged file, built from a name-tree or `/Dests`
 * value: the array itself, or the `/D` of a dictionary wrapping it. Undefined
 * unless it leads with one of this input's pages, names a view the spec
 * defines, and carries only numbers or nulls after that.
 *
 * Built, never copied. The copier follows every reference it is handed, with
 * no limit of its own, so copying the source array would walk whatever an
 * extra element points at: a file with one such destination failed the whole
 * combine with a stack overflow. Here only the page reference goes through
 * the copier, and that page is already copied. A destination aimed anywhere
 * else was dangling to begin with.
 */
function sanitizedDestination(
  value: PDFObject | undefined,
  pageRefs: Set<string>,
  copier: PDFObjectCopier,
  context: PDFContext,
): PDFArray | undefined {
  const source = value instanceof PDFDict ? value.lookup(PDFName.of('D')) : value;
  if (!(source instanceof PDFArray)) return undefined;
  if (source.size() > 2 + MAX_DESTINATION_OPERANDS) return undefined;
  const target = source.get(0);
  if (!(target instanceof PDFRef) || !pageRefs.has(target.toString())) return undefined;
  // A lone page reference is not valid, but its meaning is plain enough.
  const fit = source.size() > 1 ? source.lookup(1) : PDFName.of('Fit');
  if (!(fit instanceof PDFName) || !DESTINATION_FITS.has(fit.decodeText())) return undefined;

  const destination = PDFArray.withContext(context);
  destination.push(copier.copy(target));
  destination.push(fit);
  for (let i = 2; i < source.size(); i++) {
    // `lookup` resolves one reference and stops: a number behind a reference
    // is still a number, and anything else is refused without being walked.
    const operand = source.lookup(i);
    if (operand instanceof PDFNumber) destination.push(PDFNumber.of(operand.asNumber()));
    else if (operand === PDFNull) destination.push(PDFNull);
    else return undefined;
  }
  return destination;
}

/** One definition read from an input, already rebuilt for the merged file. */
interface CollectedDestination {
  /** A name-tree key (`string`) or a key of the legacy `/Dests` dictionary (`name`). */
  kind: 'string' | 'name';
  /** The key's exact bytes (see {@link byteKey}): what makes it this definition and no other. */
  bytes: string;
  /** The key as a lenient reader sees it. */
  text: string;
  destination: PDFArray;
}

/**
 * Read one input's named destinations from both places they live: the
 * `/Names` `/Dests` name tree, in tree order, then the older catalog `/Dests`
 * dictionary. Every key with bytes of its own is a definition of its own, even
 * when two of them decode to the same text; only a key repeated byte for byte
 * is a duplicate, and the first is kept. Each destination is returned already
 * rebuilt for the merged file (see {@link sanitizedDestination}). The walk is
 * bounded by depth, by a visited set of nodes (cycles) and by a cap on pairs
 * examined.
 */
function collectNamedDestinations(
  src: PDFDocument,
  pageRefs: Set<string>,
  copier: PDFObjectCopier,
  context: PDFContext,
): CollectedDestination[] {
  const found: CollectedDestination[] = [];
  const seen = { string: new Set<string>(), name: new Set<string>() };
  let examined = 0;
  const add = (kind: 'string' | 'name', raw: Uint8Array, value: PDFObject | undefined): void => {
    const bytes = byteKey(raw);
    if (seen[kind].has(bytes)) return;
    const destination = sanitizedDestination(value, pageRefs, copier, context);
    if (!destination) return;
    seen[kind].add(bytes);
    found.push({ kind, bytes, text: destinationText(raw), destination });
  };

  const root = dictOf(dictOf(src.catalog.lookup(PDFName.of('Names')))?.lookup(PDFName.of('Dests')));
  const visited = new Set<PDFDict>();
  const stack: Array<{ node: PDFDict; depth: number }> = root ? [{ node: root, depth: 0 }] : [];
  walk: while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry || visited.has(entry.node)) continue;
    visited.add(entry.node);
    const pairs = arrayOf(entry.node.lookup(PDFName.of('Names')));
    for (let i = 0; pairs && i + 1 < pairs.size(); i += 2) {
      if (++examined > MAX_NAMED_DESTINATIONS_PER_INPUT) break walk;
      const key = pairs.lookup(i);
      if (!(key instanceof PDFString || key instanceof PDFHexString)) continue;
      add('string', stringBytes(key), pairs.lookup(i + 1));
    }
    const kids = arrayOf(entry.node.lookup(PDFName.of('Kids')));
    if (!kids || entry.depth >= MAX_NAME_TREE_DEPTH) continue;
    for (let i = kids.size() - 1; i >= 0; i--) {
      const kid = dictOf(kids.lookup(i));
      if (kid) stack.push({ node: kid, depth: entry.depth + 1 });
    }
  }

  const dests = dictOf(src.catalog.lookup(PDFName.of('Dests')));
  if (dests) {
    for (const [key, value] of dests.entries()) {
      if (++examined > MAX_NAMED_DESTINATIONS_PER_INPUT) break;
      add('name', key.asBytes(), value instanceof PDFRef ? src.context.lookup(value) : value);
    }
  }
  return found;
}

/**
 * Carry one input's named destinations into `merged`, using the copier that
 * just copied its pages so each destination's page ref lands on the
 * already-copied page, and return how this input's references resolve (see
 * {@link MergedDestinations} for the model, {@link DestinationRenames} for
 * the result).
 *
 * Each definition gets an output name: its decoded text, or that text with
 * `~2`, `~3`, ... appended when the text is already taken, by an earlier
 * input or by another key of this one that decodes the same.
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
  context: PDFContext,
): DestinationRenames {
  const found = collectNamedDestinations(src, pageRefs, copier, context);
  const renames: DestinationRenames = {
    strings: new Map(),
    names: new Map(),
    byText: new Map(),
    orphans: new Map(),
    used: merged.used,
  };
  // The texts this input uses itself, so that a suffixed name made for one of
  // its keys cannot take the name another of its keys has by right.
  const own = new Set(found.map((definition) => definition.text));

  for (const { kind, bytes, text, destination } of found) {
    let output = text;
    for (let n = 2; merged.used.has(output); n++) {
      const candidate = `${text}~${n}`;
      if (!own.has(candidate)) output = candidate;
    }
    merged.used.add(output);
    merged.entries.set(output, destination);
    if (kind === 'string') {
      renames.strings.set(bytes, output);
      // PDF.js's decoded table takes the last tree key with a given text.
      renames.byText.set(text, output);
    } else {
      renames.names.set(bytes, output);
      // ...and a legacy key only where no tree key supplied that text.
      if (!renames.byText.has(text)) renames.byText.set(text, output);
    }
  }
  return renames;
}

/**
 * The replacement for a reference to a named destination: a name object or a
 * string, on a link or a bookmark. Undefined for anything else.
 *
 * The reference resolves the way a reader would resolve it in its own file:
 * a key with the same bytes, of its own kind and then of the other (a lenient
 * reader looks in both tables), and failing that a key with the same decoded
 * text. What it resolves to is that definition's output name. A reference
 * that resolves to nothing gets a reserved orphan name (see
 * {@link DestinationRenames}): `~0` appended until it is free, then taken out
 * of the shared namespace so no later input can define it either.
 *
 * Always a string in the output name's one spelling (see
 * {@link destinationBytes}), whatever the reference was written as, so it
 * matches its key for a reader that compares bytes.
 */
function renamedTarget(
  value: PDFObject | undefined,
  renames: DestinationRenames,
): PDFHexString | undefined {
  let raw: Uint8Array;
  let sameKind: Map<string, string>;
  let otherKind: Map<string, string>;
  if (value instanceof PDFName) {
    raw = value.asBytes();
    [sameKind, otherKind] = [renames.names, renames.strings];
  } else if (value instanceof PDFString || value instanceof PDFHexString) {
    raw = stringBytes(value);
    [sameKind, otherKind] = [renames.strings, renames.names];
  } else {
    return undefined;
  }
  const bytes = byteKey(raw);
  let output = sameKind.get(bytes) ?? otherKind.get(bytes);
  if (output === undefined) {
    const text = destinationText(raw);
    output = renames.byText.get(text) ?? renames.orphans.get(text);
    if (output === undefined) {
      output = `${text}~0`;
      while (renames.used.has(output)) output += '~0';
      renames.used.add(output);
      renames.orphans.set(text, output);
    }
  }
  return hexFromBytes(destinationBytes(output));
}

/**
 * Point a `/GoTo` action (and the actions chained after it through `/Next`) at
 * the name its destination has in the merged file. Depth-capped, with a
 * visited set, since `/Next` is attacker-shaped and can loop.
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
 * destination: an annotation's `/Dest`, its `/A` action chain and its `/AA`
 * additional actions. Each is pointed at its destination's output name, and a
 * link to a name this input never defined is kept dangling (see
 * {@link renamedTarget}). Run over each input's own pages only, so another
 * input's links, which name their own destinations, are never touched.
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
 * Write the merged destinations into `out`'s catalog as one `/Names` `/Dests`
 * name tree. Per PDF 7.9.6 its keys are sorted by raw byte order; up to
 * {@link NAME_TREE_LEAF_SIZE} entries sit in the root's `/Names`, and more go
 * in leaf kids, each with `/Limits`, so no node grows without bound.
 */
function writeNamedDestinations(out: PDFDocument, merged: MergedDestinations): void {
  if (merged.entries.size === 0) return;
  const context = out.context;
  const entries = [...merged.entries]
    .map(([name, destination]) => ({ key: destinationBytes(name), destination }))
    .sort((a, b) => compareBytes(a.key, b.key));
  const leaf = (chunk: typeof entries): PDFDict => {
    const names = PDFArray.withContext(context);
    for (const { key, destination } of chunk) {
      names.push(hexFromBytes(key));
      names.push(destination);
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
        context.obj([hexFromBytes(chunk[0].key), hexFromBytes(chunk[chunk.length - 1].key)]),
      );
      kids.push(context.register(kid));
    }
    tree = context.obj({ Kids: kids });
  }
  out.catalog.set(PDFName.of('Names'), context.obj({ Dests: tree }));
}

/** One labelling range: the 0-based page index it starts at, and its label dictionary. */
interface LabelRange {
  index: number;
  label: PDFDict;
}

/** One input's ranges (indices local to that input) and where its pages start in the output. */
interface InputPageLabels {
  offset: number;
  ranges: LabelRange[];
}

/** The numbering styles PDF 12.4.2 allows in a label's `/S`. */
const LABEL_STYLES = new Set(['D', 'R', 'r', 'A', 'a']);
/** Ceiling on the pairs examined in one input's page-label tree (see {@link MAX_NAMED_DESTINATIONS_PER_INPUT}). */
const MAX_PAGE_LABEL_PAIRS_PER_INPUT = 100_000;
/** Ranges per node of the written number tree. */
const PAGE_LABEL_LEAF_SIZE = 64;

/** The value as an integer, or undefined for anything else (including NaN-like numbers). */
function integerOf(value: PDFObject | undefined): number | undefined {
  if (!(value instanceof PDFNumber)) return undefined;
  const number = value.asNumber();
  return Number.isInteger(number) ? number : undefined;
}

/**
 * A fresh label dictionary in `context` holding only the parts of `source`
 * that are well-formed: `/S` if it is one of the five styles, `/P` if it is a
 * string (copied byte-exact), `/St` if it is an integer of at least 1. The
 * source dictionary is never copied: it is untrusted, and a reader should not
 * meet whatever else it carries, or a bad entry that fails a strict reader.
 * PDF.js is one: a single malformed entry makes it drop every label in the
 * document, so what is written here has to be valid entry by entry.
 */
function sanitizedLabel(source: PDFDict, context: PDFContext): PDFDict {
  const label = context.obj({});
  const style = source.lookup(PDFName.of('S'));
  if (style instanceof PDFName && LABEL_STYLES.has(style.decodeText())) {
    label.set(PDFName.of('S'), style);
  } else if (style !== undefined && style !== PDFNull) {
    // A style that is there but is not one the spec defines becomes decimal,
    // the plain numbering a reader falls back to. Left out it would mean "no
    // number at all", and every page of the range would show a blank label.
    label.set(PDFName.of('S'), PDFName.of('D'));
  }
  const prefix = source.lookup(PDFName.of('P'));
  if (prefix instanceof PDFString || prefix instanceof PDFHexString) {
    label.set(PDFName.of('P'), hexFromBytes(stringBytes(prefix)));
  }
  const start = integerOf(source.lookup(PDFName.of('St')));
  if (start !== undefined && start >= 1) label.set(PDFName.of('St'), PDFNumber.of(start));
  return label;
}

/**
 * Read one input's page-label ranges from the catalog's `/PageLabels` number
 * tree (`/Nums` pairs, and `/Kids` below them), keeping a pair only if its
 * index is a page of this input and its value is a dictionary; the later of
 * two pairs for one index wins, as it does in PDF.js. Bounded like {@link collectNamedDestinations}: by
 * depth, by a visited set (cycles) and by a cap on pairs examined. A malformed
 * tree costs this input its labels and nothing else.
 */
function collectPageLabels(src: PDFDocument, pageCount: number, context: PDFContext): LabelRange[] {
  const root = dictOf(src.catalog.lookup(PDFName.of('PageLabels')));
  if (!root) return [];
  const found = new Map<number, LabelRange>();
  const visited = new Set<PDFDict>();
  const stack: Array<{ node: PDFDict; depth: number }> = [{ node: root, depth: 0 }];
  let examined = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry || visited.has(entry.node)) continue;
    visited.add(entry.node);
    const pairs = arrayOf(entry.node.lookup(PDFName.of('Nums')));
    for (let i = 0; pairs && i + 1 < pairs.size(); i += 2) {
      if (++examined > MAX_PAGE_LABEL_PAIRS_PER_INPUT) return sortedRanges(found);
      const index = integerOf(pairs.lookup(i));
      const source = dictOf(pairs.lookup(i + 1));
      if (index === undefined || index < 0 || index >= pageCount || !source) continue;
      // Set, not set-if-absent: PDF.js keeps the later of two entries for one
      // page, and the combined file should number as the input did there.
      found.set(index, { index, label: sanitizedLabel(source, context) });
    }
    const kids = arrayOf(entry.node.lookup(PDFName.of('Kids')));
    if (!kids || entry.depth >= MAX_NAME_TREE_DEPTH) continue;
    for (let i = kids.size() - 1; i >= 0; i--) {
      const kid = dictOf(kids.lookup(i));
      if (kid) stack.push({ node: kid, depth: entry.depth + 1 });
    }
  }
  return sortedRanges(found);
}

function sortedRanges(found: Map<number, LabelRange>): LabelRange[] {
  return [...found.values()].sort((a, b) => a.index - b.index);
}

/**
 * Write the merged page labels into `out`'s catalog so every page keeps the
 * label it had in its own file. If no input had any, nothing is written and
 * the viewer shows plain 1..N, as before. Otherwise each input's ranges move
 * to its offset in the output, and each input gets a decimal range at its
 * first page when it has none there: the spec requires a range at page 0 and
 * readers carry the previous range on, so without it an input with no labels
 * would continue the previous file's numbering instead of restarting at 1.
 * The tree follows 12.4.2: up to {@link PAGE_LABEL_LEAF_SIZE} ranges in the
 * root's `/Nums`, more in leaf kids each with `/Limits`.
 */
function writePageLabels(out: PDFDocument, inputs: InputPageLabels[]): void {
  if (!inputs.some((input) => input.ranges.length > 0)) return;
  const context = out.context;
  const entries: Array<[number, PDFDict]> = [];
  for (const input of inputs) {
    if (input.ranges[0]?.index !== 0) entries.push([input.offset, context.obj({ S: 'D' })]);
    for (const range of input.ranges) entries.push([input.offset + range.index, range.label]);
  }
  const leaf = (chunk: Array<[number, PDFDict]>): PDFDict => {
    const nums = PDFArray.withContext(context);
    for (const [index, label] of chunk) {
      nums.push(PDFNumber.of(index));
      nums.push(label);
    }
    return context.obj({ Nums: nums });
  };
  let tree: PDFDict;
  if (entries.length <= PAGE_LABEL_LEAF_SIZE) {
    tree = leaf(entries);
  } else {
    const kids = PDFArray.withContext(context);
    for (let i = 0; i < entries.length; i += PAGE_LABEL_LEAF_SIZE) {
      const chunk = entries.slice(i, i + PAGE_LABEL_LEAF_SIZE);
      const kid = leaf(chunk);
      kid.set(
        PDFName.of('Limits'),
        context.obj([PDFNumber.of(chunk[0][0]), PDFNumber.of(chunk[chunk.length - 1][0])]),
      );
      kids.push(context.register(kid));
    }
    tree = context.obj({ Kids: kids });
  }
  out.catalog.set(PDFName.of('PageLabels'), tree);
}

/** Ceilings on the walk over an untrusted input's outline (see {@link collectOutline}). */
const MAX_OUTLINE_DEPTH = 32;
const MAX_OUTLINE_ITEMS_PER_INPUT = 50_000;

/** An outline item as the merged file will have it, with every value already validated. */
interface OutlineNode {
  title: string;
  /** An explicit destination array, or a name or string naming one; none when unresolved. */
  target?: PDFObject;
  color?: [number, number, number];
  /** Bit 1 italic, bit 2 bold (PDF 12.3.3); zero when neither. */
  flags: number;
  /** Whether the item showed its children in its own file. */
  open: boolean;
  children: OutlineNode[];
}

/** What one outline walk has seen: items already visited (cycles) and the running total (cap). */
interface OutlineWalk {
  visited: Set<PDFDict>;
  count: number;
}

/** `/C` as three numbers in 0..1, or undefined for any other shape. */
function outlineColor(value: PDFObject | undefined): [number, number, number] | undefined {
  if (!(value instanceof PDFArray) || value.size() !== 3) return undefined;
  const parts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const part = value.lookup(i);
    if (!(part instanceof PDFNumber)) return undefined;
    const number = part.asNumber();
    if (!(number >= 0 && number <= 1)) return undefined;
    parts.push(number);
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * Where a bookmark jumps, rebuilt for the merged file: an explicit destination
 * goes through {@link sanitizedDestination}, and a name or string follows the
 * renames its input's links got (see {@link renamedTarget}), so a bookmark to a
 * destination that was renamed still lands in its own file and one to a name
 * its file never defined stays unresolved.
 */
function outlineTarget(
  value: PDFObject | undefined,
  pageRefs: Set<string>,
  copier: PDFObjectCopier,
  renames: DestinationRenames,
  context: PDFContext,
): PDFObject | undefined {
  if (value instanceof PDFArray || value instanceof PDFDict) {
    return sanitizedDestination(value, pageRefs, copier, context);
  }
  if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
    return renamedTarget(value, renames);
  }
  return undefined;
}

/**
 * One item's own values, validated. The item is kept whatever is wrong with
 * it: a bad title becomes empty and an unusable target is left out. Its action
 * is read only when it is a `/GoTo`; every other kind (URI, GoToR, Launch,
 * JavaScript, Named, anything else) is dropped, because actions out of an
 * untrusted file are not carried into the combined one.
 */
function sanitizedOutlineItem(
  item: PDFDict,
  pageRefs: Set<string>,
  copier: PDFObjectCopier,
  renames: DestinationRenames,
  context: PDFContext,
): OutlineNode {
  const title = item.lookup(PDFName.of('Title'));
  let destination = item.lookup(PDFName.of('Dest'));
  const action = dictOf(item.lookup(PDFName.of('A')));
  if (destination === undefined || destination === PDFNull) {
    destination =
      action && action.lookup(PDFName.of('S')) === PDFName.of('GoTo')
        ? action.lookup(PDFName.of('D'))
        : undefined;
  }
  // A tagged bookmark may have only `/SE`. A reader falls back on it when
  // nothing else gave the bookmark somewhere to go, so it is tried last, and
  // not for a bookmark whose action did something else (a web link, say),
  // which never pointed at the element's page.
  const otherAction = action && action.lookup(PDFName.of('S')) !== PDFName.of('GoTo');
  const count = item.lookup(PDFName.of('Count'));
  return {
    title:
      title instanceof PDFString || title instanceof PDFHexString
        ? destinationText(stringBytes(title))
        : '',
    target:
      outlineTarget(destination, pageRefs, copier, renames, context) ??
      (otherAction ? undefined : structElementDestination(item, pageRefs, copier, context)),
    color: outlineColor(item.lookup(PDFName.of('C'))),
    flags: (integerOf(item.lookup(PDFName.of('F'))) ?? 0) & 3,
    open: count instanceof PDFNumber && count.asNumber() > 0,
    children: [],
  };
}

/**
 * Ceilings on the search for the page a structure element is on (see
 * {@link structElementDestination}). The budget counts `/K` entries read, not
 * elements found: elements can share one child array, and a cap on distinct
 * elements alone let a 75 KB file make each of 6,000 elements re-read the
 * same 6,000-entry array, 36 million lookups in the renderer.
 */
const MAX_STRUCT_ENTRIES_EXAMINED = 20_000;
const MAX_STRUCT_PARENT_DEPTH = 40;

/** A structure element's `/Pg`, when it is one of this input's pages. */
function pageOf(element: PDFDict, pageRefs: Set<string>): PDFRef | undefined {
  const page = element.get(PDFName.of('Pg'));
  return page instanceof PDFRef && pageRefs.has(page.toString()) ? page : undefined;
}

/**
 * The page a tagged bookmark lands on when all it has is `/SE`, a structure
 * element, as a fresh explicit destination. PDF.js, Folio's reader, follows
 * these, so a bookmark that worked in its own file must keep working.
 *
 * The same search PDF.js makes (`#getDestFromStructElement`): the element's
 * own `/Pg`; failing that the first `/Pg` among its descendants (`/K`,
 * breadth first, including marked-content references); failing that the
 * nearest ancestor's (`/P`, stopping at the structure tree root). The place on
 * the page is the top left of the element's `/BBox` attribute when it has
 * one. Bounded, unlike a structure tree: visited sets for elements and for
 * child arrays (one array shared by many elements is read once), a budget of
 * entries read that is checked entry by entry, and a cap on ancestors. The page has to be one of this input's,
 * and only that page reference goes through the copier.
 */
function structElementDestination(
  item: PDFDict,
  pageRefs: Set<string>,
  copier: PDFObjectCopier,
  context: PDFContext,
): PDFArray | undefined {
  if (!(item.get(PDFName.of('SE')) instanceof PDFRef)) return undefined;
  const element = dictOf(item.lookup(PDFName.of('SE')));
  if (!element) return undefined;

  let page = pageOf(element, pageRefs);
  const visited = new Set<PDFDict>([element]);
  const expanded = new Set<PDFArray>();
  const queue: PDFDict[] = [element];
  let budget = MAX_STRUCT_ENTRIES_EXAMINED;
  // One child, read lazily: the budget is spent before its lookup, never after.
  const visit = (kid: PDFObject | undefined): boolean => {
    const child = dictOf(kid);
    if (!child || visited.has(child)) return false;
    visited.add(child);
    page = pageOf(child, pageRefs);
    if (!page) queue.push(child);
    return page !== undefined;
  };
  for (let next = 0; !page && next < queue.length && budget > 0; next++) {
    const kids = queue[next].lookup(PDFName.of('K'));
    if (!(kids instanceof PDFArray)) {
      budget--;
      visit(kids);
      continue;
    }
    if (expanded.has(kids)) continue;
    expanded.add(kids);
    for (let i = 0; i < kids.size() && budget > 0; i++) {
      budget--;
      if (visit(kids.lookup(i))) break;
    }
  }
  let current = element;
  for (let depth = 0; !page && depth < MAX_STRUCT_PARENT_DEPTH; depth++) {
    const parent = dictOf(current.lookup(PDFName.of('P')));
    if (!parent || parent.lookup(PDFName.of('Type')) === PDFName.of('StructTreeRoot')) break;
    page = pageOf(parent, pageRefs);
    current = parent;
  }
  if (!page) return undefined;

  // `/A` is an attribute dictionary here, not an action. PDF.js reads one
  // dictionary and ignores the array form, and so does this.
  const corner: [PDFObject, PDFObject] = [PDFNull, PDFNull];
  const bbox = arrayOf(dictOf(element.lookup(PDFName.of('A')))?.lookup(PDFName.of('BBox')));
  if (bbox && bbox.size() === 4) {
    const numbers = bbox.asArray().map((_, i) => bbox.lookup(i));
    if (numbers.every((value) => value instanceof PDFNumber)) {
      corner[0] = PDFNumber.of((numbers[0] as PDFNumber).asNumber());
      corner[1] = PDFNumber.of((numbers[3] as PDFNumber).asNumber());
    }
  }
  const destination = PDFArray.withContext(context);
  destination.push(copier.copy(page));
  destination.push(PDFName.of('XYZ'));
  destination.push(corner[0]);
  destination.push(corner[1]);
  destination.push(PDFNull);
  return destination;
}

/** The siblings starting at `first`, each with its subtree, bounded by depth, cycles and total. */
function collectOutlineLevel(
  first: PDFDict | undefined,
  depth: number,
  walk: OutlineWalk,
  pageRefs: Set<string>,
  copier: PDFObjectCopier,
  renames: DestinationRenames,
  context: PDFContext,
): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  let item = first;
  while (item && !walk.visited.has(item) && walk.count < MAX_OUTLINE_ITEMS_PER_INPUT) {
    walk.visited.add(item);
    walk.count++;
    const node = sanitizedOutlineItem(item, pageRefs, copier, renames, context);
    if (depth + 1 < MAX_OUTLINE_DEPTH) {
      const child = dictOf(item.lookup(PDFName.of('First')));
      node.children = collectOutlineLevel(
        child,
        depth + 1,
        walk,
        pageRefs,
        copier,
        renames,
        context,
      );
    }
    nodes.push(node);
    item = dictOf(item.lookup(PDFName.of('Next')));
  }
  return nodes;
}

/**
 * Read one input's outline (the catalog's `/Outlines`: items linked by
 * `/First` and `/Next`) into a plain tree. The source objects are never
 * copied: the copier follows every reference with no limit, and an item's
 * `/Parent`, `/Prev` and `/Next` lead to the whole tree (a hostile file
 * overflowed the stack that way). Every value is rebuilt from validated
 * scalars instead, and a malformed outline costs this input its bookmarks and
 * nothing else. Past a cap the walk stops and keeps what it has.
 */
function collectOutline(
  src: PDFDocument,
  pageRefs: Set<string>,
  copier: PDFObjectCopier,
  renames: DestinationRenames,
  context: PDFContext,
): OutlineNode[] {
  const root = dictOf(src.catalog.lookup(PDFName.of('Outlines')));
  const first = dictOf(root?.lookup(PDFName.of('First')));
  const walk: OutlineWalk = { visited: new Set(), count: 0 };
  return collectOutlineLevel(first, 0, walk, pageRefs, copier, renames, context);
}

/** What writing one level produced: its ends, and how many items it shows when expanded. */
interface WrittenOutlineLevel {
  first: PDFRef;
  last: PDFRef;
  visible: number;
}

/**
 * Write `nodes` as one sibling list under `parent`, with `/Prev`, `/Next`,
 * `/First`, `/Last` and `/Count` set the way PDF 12.3.3 defines them: an open
 * item's `/Count` is how many descendants show beneath it, a closed item's is
 * that number negated, and an item with no children has none.
 */
function writeOutlineLevel(
  nodes: OutlineNode[],
  parent: PDFRef,
  context: PDFContext,
): WrittenOutlineLevel | undefined {
  if (nodes.length === 0) return undefined;
  const dicts: PDFDict[] = [];
  const refs: PDFRef[] = [];
  let visible = 0;
  for (const node of nodes) {
    const dict = context.obj({});
    const ref = context.register(dict);
    dict.set(PDFName.of('Title'), hexFromBytes(destinationBytes(node.title)));
    dict.set(PDFName.of('Parent'), parent);
    if (node.target) dict.set(PDFName.of('Dest'), node.target);
    if (node.color) dict.set(PDFName.of('C'), context.obj(node.color));
    if (node.flags !== 0) dict.set(PDFName.of('F'), PDFNumber.of(node.flags));
    const children = writeOutlineLevel(node.children, ref, context);
    visible += 1;
    if (children) {
      dict.set(PDFName.of('First'), children.first);
      dict.set(PDFName.of('Last'), children.last);
      dict.set(PDFName.of('Count'), PDFNumber.of(node.open ? children.visible : -children.visible));
      if (node.open) visible += children.visible;
    }
    dicts.push(dict);
    refs.push(ref);
  }
  for (let i = 0; i < dicts.length; i++) {
    if (i > 0) dicts[i].set(PDFName.of('Prev'), refs[i - 1]);
    if (i + 1 < dicts.length) dicts[i].set(PDFName.of('Next'), refs[i + 1]);
  }
  return { first: refs[0], last: refs[refs.length - 1], visible };
}

/**
 * Write the merged outline into `out`'s catalog. `nodes` is every input's
 * top-level items in input order, so the combined top level is those items
 * side by side: nothing is invented, no wrapper item and no file name. With no
 * items at all there is no `/Outlines`, and a viewer shows no bookmark panel
 * as before.
 */
function writeOutlines(out: PDFDocument, nodes: OutlineNode[]): void {
  if (nodes.length === 0) return;
  const context = out.context;
  const root = context.obj({ Type: 'Outlines' });
  const rootRef = context.register(root);
  const level = writeOutlineLevel(nodes, rootRef, context);
  if (!level) return;
  root.set(PDFName.of('First'), level.first);
  root.set(PDFName.of('Last'), level.last);
  root.set(PDFName.of('Count'), PDFNumber.of(level.visible));
  out.catalog.set(PDFName.of('Outlines'), rootRef);
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
