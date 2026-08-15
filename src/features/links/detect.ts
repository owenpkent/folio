/**
 * Finding email addresses and web addresses in text pulled out of a page.
 *
 * A PDF has no notion of "this word is a link" unless the author added a `/Link`
 * annotation, and most documents that print an address do not. Selecting one by
 * hand across the text layer is fiddly and usually catches a stray character, so
 * the context menu offers to copy the address under the pointer instead.
 *
 * The matching is deliberately conservative. A false positive here is a menu
 * item offering to copy something that is not an address, which is worse than
 * missing an unusual one: it makes the feature look broken. Anything without a
 * scheme, a `www.`, or a well-known suffix is left alone. That last rule also
 * costs real addresses: a bare domain (no scheme, no `www.`) under a suffix
 * that reads as an ordinary English word, e.g. "example.co" or "example.at",
 * goes undetected too, on purpose. See COMMON_SUFFIXES for the trade.
 */

export type AddressKind = 'email' | 'url';

export interface DetectedAddress {
  kind: AddressKind;
  /** What goes on the clipboard, with any `mailto:` and wrapping punctuation gone. */
  value: string;
  /** Where the address sits in the text it was found in. */
  start: number;
  end: number;
}

/**
 * Suffixes a bare, schemeless address is accepted under.
 *
 * Bare domains are where false positives live: "Fig.2", "No.4", "vs.the", and
 * every abbreviation followed by a word. Requiring a suffix off this list is
 * what separates "example.com" from "etc.and", and it is why the list stays
 * short rather than tracking the full IANA set.
 *
 * Deliberately missing every two-letter suffix that is also a common English
 * word or abbreviation: "it", "at", "in", "us", "me", "be", "no", "co", "de",
 * and "ie" all used to be here, and each one turned an ordinary sentence
 * ("the total cost.It was high", "See the appendix.At the end", "File the
 * report.No changes are needed") into an offer to copy a link that was never
 * there. A capitalized version of this same problem ("cost.It", "agree.In")
 * was fixed once already; these are the lowercase remainder of it, and a
 * syntactic fix does not exist here because a run-together sentence and a
 * genuine bare domain are character-for-character identical. Trimming them
 * costs real addresses under those suffixes with no scheme and no `www.`
 * (see the module doc comment above), which is the accepted trade: a false
 * positive here reads as a broken feature, a false negative just means
 * typing `https://` or `www.` in front, both of which still detect fine.
 */
const COMMON_SUFFIXES = new Set([
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'mil',
  'int',
  'info',
  'biz',
  'io',
  'ai',
  'app',
  'dev',
  'uk',
  'ca',
  'au',
  'nz',
  'fr',
  'es',
  'nl',
  'ch',
  'se',
  'dk',
  'fi',
  'pl',
  'pt',
  'br',
  'mx',
  'jp',
  'cn',
  'za',
  'eu',
]);

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;
// A scheme alone is the signal: no requirement on what follows, so a port
// (example.com:8443), an IP host (192.168.0.1), or a single-label host
// (intranet) all still count.
const SCHEME_URL = /^https?:\/\/\S+$/i;
const WWW_URL = /^www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?:[/?#]\S*)?$/i;
const BARE_URL = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)\.([A-Za-z]{2,24})(?:[/?#]\S*)?$/;

/** Characters a document wraps an address in, which are not part of it. */
const OPENERS = '([{<"\'“‘«';
const CLOSERS = '.,;:!?)]}>"\'”’»';

/** Every address in a piece of text, in the order they appear. */
export function findAddresses(text: string): DetectedAddress[] {
  const found: DetectedAddress[] = [];
  const tokens = /\S+/g;

  for (let match = tokens.exec(text); match !== null; match = tokens.exec(text)) {
    const { text: trimmed, offset } = trimWrapping(match[0]);
    if (!trimmed) continue;

    const kind = classify(trimmed);
    if (!kind) continue;

    const start = match.index + offset;
    found.push({
      kind,
      value: kind === 'email' ? stripMailto(trimmed) : trimmed,
      start,
      end: start + trimmed.length,
    });
  }

  return found;
}

/** The address covering a character offset, if there is one. */
export function addressAt(text: string, offset: number): DetectedAddress | null {
  return findAddresses(text).find((a) => offset >= a.start && offset <= a.end) ?? null;
}

function classify(text: string): AddressKind | null {
  if (stripMailto(text) !== text) return EMAIL.test(stripMailto(text)) ? 'email' : null;
  if (EMAIL.test(text)) return 'email';
  if (SCHEME_URL.test(text) || WWW_URL.test(text)) return 'url';

  const bare = BARE_URL.exec(text);
  if (!bare) return null;
  const [, domain, suffix] = bare;
  if (!COMMON_SUFFIXES.has(suffix.toLowerCase())) return null;

  // A dropped space between two sentences reads the same as a bare domain:
  // "the total cost.It was high" tokenises to "cost.It", whose suffix is in the
  // list above. What separates the two is capitalisation -- a real domain's
  // suffix is never written the way a sentence's next word is, so a
  // lowercase-ending label immediately followed by a Capitalized one is read as
  // prose, not an address. OCR drops the space after a full stop routinely,
  // which is where this matters most.
  if (/[a-z]$/.test(domain) && /^[A-Z][a-z]*$/.test(suffix)) return null;

  return 'url';
}

function stripMailto(text: string): string {
  return text.toLowerCase().startsWith('mailto:') ? text.slice('mailto:'.length) : text;
}

/**
 * Strip the brackets and sentence punctuation a document wraps an address in,
 * and report how far in the address actually starts.
 */
function trimWrapping(token: string): { text: string; offset: number } {
  let start = 0;
  let end = token.length;

  while (start < end && OPENERS.includes(token[start])) start += 1;

  while (end > start && CLOSERS.includes(token[end - 1])) {
    // A closing bracket the address opened itself belongs to it, which is what
    // keeps the tail of ".../Folio_(disambiguation)" attached.
    if (
      token[end - 1] === ')' &&
      count(token, '(', start, end) > count(token, ')', start, end - 1)
    ) {
      break;
    }
    end -= 1;
  }

  return { text: token.slice(start, end), offset: start };
}

function count(text: string, char: string, from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i += 1) {
    if (text[i] === char) total += 1;
  }
  return total;
}
