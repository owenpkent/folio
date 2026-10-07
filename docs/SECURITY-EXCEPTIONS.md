# Security exceptions

Findings from automated security audits that have been reviewed and
knowingly skipped. Each entry records the finding, the reason it
isn't load-bearing for this project's threat model, and the trigger
that would warrant revisiting.

Triage agents should treat entries here as "known skipped, do not
re-flag" rather than as a free pass to ignore the underlying class of
finding.

## Dependabot alert #25: node-forge GHSA-86w9-cpqp-85rv (resolved)

- **Resolved:** 2026-10-07. PR #110 removed `node-forge`; the alert closed as
  fixed the same day. Kept as a record of the reasoning.
- **Finding:** `node-forge` <= 1.4.0 accepts a malformed DigestInfo when
  verifying a PKCS#1 v1.5 signature (GHSA-86w9-cpqp-85rv). There is no
  patched release.
- **Decided:** 2026-10-07. Tolerate until PR #110, which removes
  `node-forge`, merges.
- **Reason:** The flaw is in signature verification, and Folio never
  verifies an RSA signature with `node-forge`. It uses the library only to
  generate keys, self-signed certificates and PKCS#12 bundles, to sign (via
  `@signpdf/signer-p12`), and to parse the CMS envelope for the signer's
  name (`src/features/signing/cert.ts`, `src/features/signing/verify.ts`).
  `rg -n "\.verify\(|verifyCertificateChain" src` finds no call to
  `publicKey.verify`, `certificate.verify` or `pki.verifyCertificateChain`;
  the only hit is a comment in `verify.ts` warning future code not to use
  them.
- **Revisit when:** no longer applies; the dependency is gone.

## How to add an exception

Document the finding (rule ID + score), the date the decision was
made, the threat-model reasoning, and the concrete trigger that
would warrant revisiting. "Revisit when" should be observable, not
aspirational: "when X happens" not "eventually."
