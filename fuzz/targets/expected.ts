// Which exceptions are the code's documented answer to bad input, and so not
// findings. Everything else (TypeError, RangeError, a stack overflow, and so
// on) propagates to Jazzer.js and is reported as a crash.

/**
 * pkcs12.ts reports a bad container with plain Errors whose messages all name
 * PKCS#12 ("Malformed PKCS#12 structure", "Not a valid PKCS#12 file",
 * "Unsupported PKCS#12 ...", "PKCS#12 MAC could not be verified").
 */
export function isExpectedPkcs12Error(err: unknown): boolean {
  return err instanceof Error && /PKCS#12/.test(err.message);
}

/**
 * combineDocuments.ts rejects an input with a message that names it:
 * `"<name>" does not look like a PDF` or `Could not read "<name>": ...`
 * (pdf-lib's own error is folded into the message and kept as `cause`), or a
 * password-protected notice.
 */
export function isExpectedStageError(err: unknown, name: string): boolean {
  return (
    err instanceof Error &&
    (err.message.startsWith(`Could not read "${name}"`) ||
      err.message.startsWith(`"${name}" does not look like a PDF`) ||
      err.message.startsWith(`"${name}" is password-protected`))
  );
}
