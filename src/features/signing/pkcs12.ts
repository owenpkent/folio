/**
 * Minimal PKCS#12 (RFC 7292) reader and writer for signing identities.
 *
 * Writing produces what node-forge produced before: SHA-1 MAC and
 * pbeWithSHAAnd3-KeyTripleDES-CBC for the key and certificate, the variant every
 * PKCS#12 consumer (OpenSSL, Windows, macOS, Acrobat) reads. Reading accepts
 * that, plus the PBES2 (PBKDF2 + AES-CBC) form that OpenSSL 3 writes by default,
 * with the container MAC in any of SHA-1, SHA-256, SHA-384 or SHA-512.
 * The older RC2-40 certificate encryption is not supported and fails loudly.
 *
 * ASN.1 handling is asn1js, hashing/HMAC/PBKDF2/AES are WebCrypto. WebCrypto has
 * no 3DES, so the legacy cipher alone comes from des.js.
 */
import * as asn1js from 'asn1js';
import des from 'des.js';

const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  localKeyId: '1.2.840.113549.1.9.21',
  pbe3Des: '1.2.840.113549.1.12.1.3',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  hmacSha1: '1.2.840.113549.2.7',
  hmacSha256: '1.2.840.113549.2.9',
  hmacSha384: '1.2.840.113549.2.10',
  hmacSha512: '1.2.840.113549.2.11',
  aes128Cbc: '2.16.840.1.101.3.4.1.2',
  aes192Cbc: '2.16.840.1.101.3.4.1.22',
  aes256Cbc: '2.16.840.1.101.3.4.1.42',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
} as const;

const KDF_ITERATIONS = 2048;

/** Result of reading a .p12: DER certificates and the PKCS#8 private key, if any. */
export interface P12Contents {
  certificates: Uint8Array[];
  pkcs8: Uint8Array | null;
}

type Hash = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
type Node = asn1js.BaseBlock;

/** Digest output size u and input block size v (RFC 7292 Appendix B.2), in bytes. */
const KDF_SIZES: Record<Hash, { u: number; v: number }> = {
  'SHA-1': { u: 20, v: 64 },
  'SHA-256': { u: 32, v: 64 },
  'SHA-384': { u: 48, v: 128 },
  'SHA-512': { u: 64, v: 128 },
};

const MAC_HASH_BY_OID: Record<string, Hash> = {
  [OID.sha1]: 'SHA-1',
  [OID.sha256]: 'SHA-256',
  [OID.sha384]: 'SHA-384',
  [OID.sha512]: 'SHA-512',
};

// ---- small byte helpers -------------------------------------------------

/** A fresh, exactly-sized ArrayBuffer copy, which is what WebCrypto's types want. */
function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function digest(name: Hash, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(name, ab(data)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- password and key derivation (RFC 7292 Appendix B) --------------------

/** BMPString (UTF-16BE), optionally with the trailing NUL character. */
function bmpPassword(password: string, terminated: boolean): Uint8Array {
  const out = new Uint8Array(password.length * 2 + (terminated ? 2 : 0));
  for (let i = 0; i < password.length; i++) {
    const c = password.charCodeAt(i);
    out[i * 2] = c >> 8;
    out[i * 2 + 1] = c & 0xff;
  }
  return out;
}

/**
 * Password encodings to try. The spec and OpenSSL use a NUL terminator, even for
 * an empty password; other writers (including node-forge) left an empty one empty.
 */
function passwordCandidates(password: string): Uint8Array[] {
  const terminated = bmpPassword(password, true);
  return password === '' ? [terminated, new Uint8Array(0)] : [terminated];
}

/**
 * PBKDF2 password bytes to try for PBES2. The standard (and OpenSSL) encoding is
 * UTF-8. node-forge, which wrote this app's .p12 files before, fed PBKDF2 its
 * JavaScript "binary string" instead: one byte per character, the low byte of
 * the code unit. The two agree for ASCII, so the fallback is only tried when a
 * password actually contains a non-ASCII character.
 */
function pbes2PasswordCandidates(password: string): Uint8Array[] {
  const utf8 = new TextEncoder().encode(password);
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(password)) return [utf8];
  return [utf8, Uint8Array.from(password, (c) => c.charCodeAt(0) & 0xff)];
}

function repeatTo(src: Uint8Array, blockSize: number): Uint8Array {
  if (src.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(blockSize * Math.ceil(src.length / blockSize));
  for (let i = 0; i < out.length; i++) out[i] = src[i % src.length];
  return out;
}

async function pkcs12Kdf(
  hash: Hash,
  password: Uint8Array,
  salt: Uint8Array,
  id: number,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const { u, v } = KDF_SIZES[hash];
  const D = new Uint8Array(v).fill(id);
  const I = concat(repeatTo(salt, v), repeatTo(password, v));
  const out = new Uint8Array(Math.ceil(length / u) * u);
  for (let block = 0; block * u < length; block++) {
    let A = await digest(hash, concat(D, I));
    for (let r = 1; r < iterations; r++) A = await digest(hash, A);
    out.set(A, block * u);
    if ((block + 1) * u >= length) break;
    // I_j = (I_j + B + 1) mod 2^(8v) for each v-byte chunk of I.
    const B = repeatTo(A, v);
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return out.slice(0, length);
}

// ---- legacy 3DES (pbeWithSHAAnd3-KeyTripleDES-CBC) ------------------------

// des.js builds a mode from a base cipher; CBC over EDE is 3-key triple DES.
const edeCbc = des.CBC.instantiate(des.EDE);

function tripleDes(
  mode: 'encrypt' | 'decrypt',
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const cipher = edeCbc.create({ type: mode, key: Array.from(key), iv: Array.from(iv) });
  return Uint8Array.from([...cipher.update(Array.from(data)), ...cipher.final()]);
}

async function legacyKeyAndIv(password: Uint8Array, salt: Uint8Array, iterations: number) {
  return {
    key: await pkcs12Kdf('SHA-1', password, salt, 1, iterations, 24),
    iv: await pkcs12Kdf('SHA-1', password, salt, 2, iterations, 8),
  };
}

// ---- ASN.1 helpers ------------------------------------------------------

function children(node: Node | undefined): Node[] {
  const value = (node as { valueBlock?: { value?: unknown } } | undefined)?.valueBlock?.value;
  if (!Array.isArray(value)) throw new Error('Malformed PKCS#12 structure');
  return value as Node[];
}

function parse(bytes: Uint8Array): Node {
  const result = asn1js.fromBER(ab(bytes));
  if (result.offset === -1) throw new Error('Not a valid PKCS#12 file');
  return result.result as Node;
}

function oidOf(node: Node | undefined): string {
  const oid = (
    node as { valueBlock?: { toString?: () => string } } | undefined
  )?.valueBlock?.toString?.();
  if (!oid) throw new Error('Malformed PKCS#12 structure');
  return oid;
}

function intOf(node: Node | undefined): number {
  const n = (node as { valueBlock?: { valueDec?: number } } | undefined)?.valueBlock?.valueDec;
  if (typeof n !== 'number') throw new Error('Malformed PKCS#12 structure');
  return n;
}

/**
 * Octets of an OCTET STRING, primitive or constructed (BER chunked), or of an
 * implicit [0]. The construction flag lives on the identifier: asn1js gives a
 * chunked universal OCTET STRING a valueBlock with `isConstructed`, but a
 * chunked implicit [0] is a generic Constructed node whose valueBlock has
 * neither that flag nor any octets, only the children.
 */
function octetsOf(node: Node | undefined): Uint8Array {
  if (!node) throw new Error('Malformed PKCS#12 structure');
  if (node.idBlock.isConstructed) return concat(...children(node).map((c) => octetsOf(c)));
  const block = node.valueBlock as { valueHexView?: Uint8Array };
  if (!block.valueHexView) throw new Error('Malformed PKCS#12 structure');
  return new Uint8Array(block.valueHexView);
}

function der(node: Node): Uint8Array {
  return new Uint8Array(node.toBER());
}

function algId(oid: string, params?: Node): asn1js.Sequence {
  return new asn1js.Sequence({
    value: [new asn1js.ObjectIdentifier({ value: oid }), params ?? new asn1js.Null()],
  });
}

function explicit0(content: Node): asn1js.Constructed {
  return new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [content] });
}

// ---- decryption ---------------------------------------------------------

const AES_BY_OID: Record<string, number> = {
  [OID.aes128Cbc]: 16,
  [OID.aes192Cbc]: 24,
  [OID.aes256Cbc]: 32,
};
type Prf = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
const PRF_BY_OID: Record<string, Prf> = {
  [OID.hmacSha1]: 'SHA-1',
  [OID.hmacSha256]: 'SHA-256',
  [OID.hmacSha384]: 'SHA-384',
  [OID.hmacSha512]: 'SHA-512',
};

/** Decrypt data protected by a PKCS#12 PBE or PBES2 AlgorithmIdentifier. */
async function decryptWith(
  algorithm: Node,
  data: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const parts = children(algorithm);
  const oid = oidOf(parts[0]);

  if (oid === OID.pbe3Des) {
    const [saltNode, iterNode] = children(parts[1]);
    const salt = octetsOf(saltNode);
    const iterations = intOf(iterNode);
    let lastError: unknown;
    for (const pw of passwordCandidates(password)) {
      try {
        const { key, iv } = await legacyKeyAndIv(pw, salt, iterations);
        return tripleDes('decrypt', key, iv, data);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  if (oid === OID.pbes2) {
    const [kdf, enc] = children(parts[1]);
    const kdfParts = children(kdf);
    if (oidOf(kdfParts[0]) !== OID.pbkdf2) throw new Error('Unsupported PKCS#12 key derivation');
    const kdfParams = children(kdfParts[1]);
    const salt = octetsOf(kdfParams[0]);
    const iterations = intOf(kdfParams[1]);
    let prf: Prf = 'SHA-1';
    for (const extra of kdfParams.slice(2)) {
      // Either keyLength (INTEGER) or prf (AlgorithmIdentifier, a SEQUENCE).
      if (extra.idBlock.tagNumber === 16) prf = PRF_BY_OID[oidOf(children(extra)[0])] ?? prf;
    }
    const encParts = children(enc);
    const keyLength = AES_BY_OID[oidOf(encParts[0])];
    if (!keyLength) throw new Error('Unsupported PKCS#12 cipher');
    const iv = octetsOf(encParts[1]);
    let lastError: unknown;
    for (const pw of pbes2PasswordCandidates(password)) {
      const base = await crypto.subtle.importKey('raw', ab(pw), 'PBKDF2', false, ['deriveKey']);
      const aesKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: ab(salt), iterations, hash: prf },
        base,
        { name: 'AES-CBC', length: keyLength * 8 },
        false,
        ['decrypt'],
      );
      try {
        return new Uint8Array(
          await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ab(iv) }, aesKey, ab(data)),
        );
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  throw new Error('Unsupported PKCS#12 encryption algorithm (only 3DES and AES are supported)');
}

// ---- reading ------------------------------------------------------------

async function collectBags(safeContents: Node, password: string, out: P12Contents): Promise<void> {
  for (const bag of children(safeContents)) {
    const [bagIdNode, valueNode] = children(bag);
    const bagId = oidOf(bagIdNode);
    const value = children(valueNode)[0]; // [0] EXPLICIT
    if (bagId === OID.certBag) {
      const [certId, certValue] = children(value);
      if (oidOf(certId) === OID.x509Certificate) {
        out.certificates.push(octetsOf(children(certValue)[0]));
      }
    } else if (bagId === OID.keyBag) {
      out.pkcs8 ??= der(value);
    } else if (bagId === OID.shroudedKeyBag) {
      const [algorithm, encrypted] = children(value);
      out.pkcs8 ??= await decryptWith(algorithm, octetsOf(encrypted), password);
    }
  }
}

async function verifyMac(
  pfx: Node[],
  authSafeContent: Uint8Array,
  password: string,
): Promise<void> {
  const macData = pfx[2];
  if (!macData) return; // No password-based integrity to check.
  const [digestInfo, saltNode, iterNode] = children(macData);
  const [macAlg, macValue] = children(digestInfo);
  const hash = MAC_HASH_BY_OID[oidOf(children(macAlg)[0])];
  if (!hash) throw new Error('Unsupported PKCS#12 MAC algorithm');
  const salt = octetsOf(saltNode);
  const iterations = iterNode ? intOf(iterNode) : 1;
  const expected = octetsOf(macValue);
  for (const pw of passwordCandidates(password)) {
    const macKey = await pkcs12Kdf(hash, pw, salt, 3, iterations, KDF_SIZES[hash].u);
    const key = await crypto.subtle.importKey('raw', ab(macKey), { name: 'HMAC', hash }, false, [
      'sign',
    ]);
    const actual = new Uint8Array(await crypto.subtle.sign('HMAC', key, ab(authSafeContent)));
    if (constantTimeEqual(actual, expected)) return;
  }
  throw new Error('PKCS#12 MAC could not be verified. Invalid password?');
}

/**
 * Read certificates and the private key out of a .p12.
 * Throws on a wrong passphrase (the MAC check fails) or an unsupported cipher.
 */
export async function readPkcs12(bytes: Uint8Array, password: string): Promise<P12Contents> {
  const pfx = children(parse(bytes));
  const [contentType, content] = children(pfx[1]);
  if (oidOf(contentType) !== OID.data) throw new Error('Unsupported PKCS#12 integrity mode');
  const authSafeContent = octetsOf(children(content)[0]);

  await verifyMac(pfx, authSafeContent, password);

  const out: P12Contents = { certificates: [], pkcs8: null };
  for (const info of children(parse(authSafeContent))) {
    const [type, body] = children(info);
    const inner = children(body)[0];
    if (oidOf(type) === OID.data) {
      await collectBags(parse(octetsOf(inner)), password, out);
    } else if (oidOf(type) === OID.encryptedData) {
      const [, encryptedContentInfo] = children(inner);
      const [, algorithm, encrypted] = children(encryptedContentInfo);
      const plain = await decryptWith(algorithm, octetsOf(encrypted), password);
      await collectBags(parse(plain), password, out);
    }
  }
  return out;
}

// ---- writing ------------------------------------------------------------

function pbeParams(salt: Uint8Array): asn1js.Sequence {
  return new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: ab(salt) }),
      new asn1js.Integer({ value: KDF_ITERATIONS }),
    ],
  });
}

async function encryptLegacy(
  plain: Uint8Array,
  password: Uint8Array,
): Promise<{ algorithm: asn1js.Sequence; data: Uint8Array }> {
  const salt = randomBytes(8);
  const { key, iv } = await legacyKeyAndIv(password, salt, KDF_ITERATIONS);
  return {
    algorithm: algId(OID.pbe3Des, pbeParams(salt)),
    data: tripleDes('encrypt', key, iv, plain),
  };
}

function bagAttributes(localKeyId: Uint8Array): asn1js.Set {
  return new asn1js.Set({
    value: [
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: OID.localKeyId }),
          new asn1js.Set({ value: [new asn1js.OctetString({ valueHex: ab(localKeyId) })] }),
        ],
      }),
    ],
  });
}

function contentInfoData(content: Uint8Array): asn1js.Sequence {
  return new asn1js.Sequence({
    value: [
      new asn1js.ObjectIdentifier({ value: OID.data }),
      explicit0(new asn1js.OctetString({ valueHex: ab(content) })),
    ],
  });
}

/**
 * Build a password-protected .p12 holding one certificate and its PKCS#8 key.
 * `certificate` is DER; `pkcs8` is the DER PrivateKeyInfo.
 */
export async function writePkcs12(
  certificate: Uint8Array,
  pkcs8: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const pw = bmpPassword(password, true);
  const localKeyId = await digest('SHA-1', certificate);

  // Private key, in a shrouded key bag inside a plain `data` SafeContents.
  const encKey = await encryptLegacy(pkcs8, pw);
  const keyBag = new asn1js.Sequence({
    value: [
      new asn1js.ObjectIdentifier({ value: OID.shroudedKeyBag }),
      explicit0(
        new asn1js.Sequence({
          value: [encKey.algorithm, new asn1js.OctetString({ valueHex: ab(encKey.data) })],
        }),
      ),
      bagAttributes(localKeyId),
    ],
  });
  const keySafe = contentInfoData(der(new asn1js.Sequence({ value: [keyBag] })));

  // Certificate, in a cert bag inside an encryptedData SafeContents.
  const certBag = new asn1js.Sequence({
    value: [
      new asn1js.ObjectIdentifier({ value: OID.certBag }),
      explicit0(
        new asn1js.Sequence({
          value: [
            new asn1js.ObjectIdentifier({ value: OID.x509Certificate }),
            explicit0(new asn1js.OctetString({ valueHex: ab(certificate) })),
          ],
        }),
      ),
      bagAttributes(localKeyId),
    ],
  });
  const encCerts = await encryptLegacy(der(new asn1js.Sequence({ value: [certBag] })), pw);
  const certSafe = new asn1js.Sequence({
    value: [
      new asn1js.ObjectIdentifier({ value: OID.encryptedData }),
      explicit0(
        new asn1js.Sequence({
          value: [
            new asn1js.Integer({ value: 0 }),
            new asn1js.Sequence({
              value: [
                new asn1js.ObjectIdentifier({ value: OID.data }),
                encCerts.algorithm,
                new asn1js.Primitive({
                  idBlock: { tagClass: 3, tagNumber: 0 },
                  valueHex: ab(encCerts.data),
                }),
              ],
            }),
          ],
        }),
      ),
    ],
  });

  const authSafe = der(new asn1js.Sequence({ value: [certSafe, keySafe] }));

  // MAC over the AuthenticatedSafe: SHA-1 HMAC with a PKCS#12-derived key.
  const macSalt = randomBytes(8);
  const macKey = await pkcs12Kdf('SHA-1', pw, macSalt, 3, KDF_ITERATIONS, 20);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    ab(macKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, ab(authSafe)));

  const pfx = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 3 }),
      contentInfoData(authSafe),
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({
            value: [algId(OID.sha1), new asn1js.OctetString({ valueHex: ab(mac) })],
          }),
          new asn1js.OctetString({ valueHex: ab(macSalt) }),
          new asn1js.Integer({ value: KDF_ITERATIONS }),
        ],
      }),
    ],
  });
  return der(pfx);
}
