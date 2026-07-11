import forge from 'node-forge';

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

function uint8ToBinary(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function binaryToUint8(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

function field(attrs: forge.pki.Certificate['subject'], shortName: string): string | undefined {
  const found = attrs.getField(shortName);
  return found?.value as string | undefined;
}

function summarize(cert: forge.pki.Certificate): IdentitySummary {
  return {
    commonName: field(cert.subject, 'CN') ?? '(unknown)',
    organization: field(cert.subject, 'O'),
    issuer: field(cert.issuer, 'CN') ?? '(unknown)',
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    serialNumber: cert.serialNumber,
    selfSigned:
      JSON.stringify(cert.subject.attributes) === JSON.stringify(cert.issuer.attributes),
  };
}

/**
 * Generate a self-signed signing certificate and return it as a passphrase
 * protected PKCS#12 (.p12). Useful for testing and for users who do not have a
 * certificate from a CA yet.
 */
export function generateSelfSignedP12(opts: {
  commonName: string;
  organization?: string;
  email?: string;
  days?: number;
  passphrase: string;
}): { p12: Uint8Array; summary: IdentitySummary } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '00' + forge.util.bytesToHex(forge.random.getBytesSync(16));

  const now = new Date();
  cert.validity.notBefore = now;
  const end = new Date(now.getTime());
  end.setDate(end.getDate() + (opts.days ?? 365));
  cert.validity.notAfter = end;

  const attrs: forge.pki.CertificateField[] = [{ name: 'commonName', value: opts.commonName }];
  if (opts.organization) attrs.push({ name: 'organizationName', value: opts.organization });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  const extensions: object[] = [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', clientAuth: true, emailProtection: true },
  ];
  if (opts.email) {
    extensions.push({ name: 'subjectAltName', altNames: [{ type: 1, value: opts.email }] });
  }
  cert.setExtensions(extensions);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], opts.passphrase, {
    algorithm: '3des',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return { p12: binaryToUint8(der), summary: summarize(cert) };
}

/**
 * Validate a passphrase against a .p12 and return the certificate summary.
 * Throws if the passphrase is wrong or no certificate is present.
 */
export function parseP12(p12Bytes: Uint8Array, passphrase: string): IdentitySummary {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(uint8ToBinary(p12Bytes)));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase);
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = bags[forge.pki.oids.certBag]?.[0];
  if (!certBag?.cert) throw new Error('No certificate found in the .p12 file');
  return summarize(certBag.cert);
}
