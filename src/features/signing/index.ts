export { SigningModal } from './SigningModal';
export { registerSigningCommands } from './commands';
export { useSigningStore } from './store';
// Types only. cert.ts and sign.ts pull in the crypto stack (pkijs, x509), so
// SigningModal loads them on demand rather than through this barrel.
export type { IdentitySummary } from './cert';
export type { SignMetadata } from './sign';
export { detectSignatures, type DetectedSignature } from './verify';
