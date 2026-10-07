// tsyringe, used inside @peculiar/x509, needs this polyfill loaded before it.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';

import { readPkcs12, writePkcs12 } from './pkcs12';

/** Human-readable summary of a signing certificate. */
export interface IdentitySummary {
  commonName: string;
  organization?: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  serialNumber: string;
  selfSigned: boolean;
}

/** Key and signature algorithm for every identity Folio creates. */
const RSA_SHA256 = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
} as const;

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function summarize(cert: x509.X509Certificate): IdentitySummary {
  return {
    commonName: cert.subjectName.getField('CN')[0] ?? '(unknown)',
    organization: cert.subjectName.getField('O')[0],
    issuer: cert.issuerName.getField('CN')[0] ?? '(unknown)',
    validFrom: cert.notBefore.toISOString(),
    validTo: cert.notAfter.toISOString(),
    serialNumber: cert.serialNumber,
    selfSigned: cert.subject === cert.issuer,
  };
}

/**
 * Generate a self-signed signing certificate and return it as a passphrase
 * protected PKCS#12 (.p12). Useful for testing and for users who do not have a
 * certificate from a CA yet.
 */
export async function generateSelfSignedP12(opts: {
  commonName: string;
  organization?: string;
  email?: string;
  days?: number;
  passphrase: string;
}): Promise<{ p12: Uint8Array; summary: IdentitySummary }> {
  const keys = await crypto.subtle.generateKey(RSA_SHA256, true, ['sign', 'verify']);

  // 16 random bytes, positive and always 16 bytes long: the top bit is cleared
  // so DER needs no sign padding, and bit 6 is set so the first byte is never
  // zero. A zero first byte would be dropped from the INTEGER encoding and the
  // serial would come back from the certificate shorter than it went in.
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0] & 0x7f) | 0x40;

  // X.509 times have one-second resolution; drop the milliseconds up front so the
  // summary and the certificate agree.
  const notBefore = new Date(Math.floor(Date.now() / 1000) * 1000);
  const notAfter = new Date(notBefore.getTime());
  notAfter.setDate(notAfter.getDate() + (opts.days ?? 365));

  // Built from a JSON name rather than a "CN=..." string so that commas and
  // other specials in a user-typed name need no escaping, and as UTF8String
  // because the default PrintableString cannot hold a comma or non-ASCII text.
  const nameParams: x509.JsonNameParams = [{ CN: [{ utf8String: opts.commonName }] }];
  if (opts.organization) nameParams.push({ O: [{ utf8String: opts.organization }] });
  const name = new x509.Name(nameParams);

  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(
      x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.nonRepudiation,
      true,
    ),
    new x509.ExtendedKeyUsageExtension([
      x509.ExtendedKeyUsage.clientAuth,
      x509.ExtendedKeyUsage.emailProtection,
    ]),
  ];
  if (opts.email) {
    extensions.push(
      new x509.SubjectAlternativeNameExtension([{ type: 'email', value: opts.email }]),
    );
  }

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: Array.from(serial, (b) => b.toString(16).padStart(2, '0')).join(''),
    subject: name,
    issuer: name,
    notBefore,
    notAfter,
    signingAlgorithm: RSA_SHA256,
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    extensions,
  });

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const p12 = await writePkcs12(new Uint8Array(cert.rawData), pkcs8, opts.passphrase);
  return { p12, summary: summarize(cert) };
}

/**
 * Validate a passphrase against a .p12 and return the certificate summary.
 * Throws if the passphrase is wrong or no certificate is present.
 */
export async function parseP12(p12Bytes: Uint8Array, passphrase: string): Promise<IdentitySummary> {
  const { certificates } = await readPkcs12(p12Bytes, passphrase);
  if (certificates.length === 0) throw new Error('No certificate found in the .p12 file');
  return summarize(new x509.X509Certificate(toArrayBuffer(certificates[0])));
}

/** A signing identity unpacked from a .p12, ready for use with WebCrypto. */
export interface SigningIdentity {
  /** Private key, RSASSA-PKCS1-v1_5 with SHA-256. */
  privateKey: CryptoKey;
  /** DER certificates, the one matching the private key first. */
  certificates: Uint8Array[];
}

function modulusOf(jwk: JsonWebKey): string {
  if (!jwk.n) throw new Error('Only RSA keys are supported');
  return jwk.n;
}

/** Unpack a .p12 into a signing key and the certificate that belongs to it. */
export async function loadSigningIdentity(
  p12Bytes: Uint8Array,
  passphrase: string,
): Promise<SigningIdentity> {
  const { certificates, pkcs8 } = await readPkcs12(p12Bytes, passphrase);
  if (!pkcs8) throw new Error('No private key found in the .p12 file');
  if (certificates.length === 0) throw new Error('No certificate found in the .p12 file');

  const algorithm = { name: RSA_SHA256.name, hash: RSA_SHA256.hash };
  const privateKey = await crypto.subtle.importKey('pkcs8', toArrayBuffer(pkcs8), algorithm, true, [
    'sign',
  ]);
  const modulus = modulusOf(await crypto.subtle.exportKey('jwk', privateKey));

  // The .p12 may carry a chain; the signer certificate is the one whose public
  // key is the private key's counterpart.
  let matched = -1;
  for (let i = 0; i < certificates.length && matched === -1; i++) {
    const cert = new x509.X509Certificate(toArrayBuffer(certificates[i]));
    const pub = await cert.publicKey.export(algorithm, ['verify']);
    if (modulusOf(await crypto.subtle.exportKey('jwk', pub)) === modulus) matched = i;
  }
  if (matched === -1) {
    throw new Error('Failed to find a certificate that matches the private key.');
  }
  return {
    privateKey,
    certificates: [certificates[matched], ...certificates.filter((_, i) => i !== matched)],
  };
}
