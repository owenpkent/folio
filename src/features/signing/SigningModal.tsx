import { useEffect, useRef, useState } from 'react';

import { announce } from '@/a11y/announcer';
import { useFocusTrap } from '@/a11y/focus';
import { Button, IconButton } from '@/components/common';
import { exportDocument, saveBytes } from '@/features/export';
import { confirmIncompleteOcr } from '@/features/ocr';
import {
  DOCUMENT_MUTATION_BUSY_TITLE,
  useDocumentMutationBlocked,
  withDocumentMutation,
} from '@/state/documentMutationStore';
import { useDocumentStore } from '@/state/documentStore';

import { generateSelfSignedP12, parseP12 } from './cert';
import { signPdf } from './sign';
import { useSigningStore } from './store';

type AddMode = 'none' | 'generate' | 'import';

/** Modal for applying a cryptographic digital signature to the document. */
export function SigningModal() {
  const open = useSigningStore((s) => s.modalOpen);
  const setOpen = useSigningStore((s) => s.setModalOpen);
  const identities = useSigningStore((s) => s.identities);
  const addIdentity = useSigningStore((s) => s.addIdentity);
  const getP12 = useSigningStore((s) => s.getP12);
  // Some OTHER feature is mid-flight rewriting the document; signing reads
  // the same kind of snapshot Save does (see saveDocument.ts's identical
  // guard), so it waits for the same reason and under the same owner.
  const crossBusy = useDocumentMutationBlocked('export', 'content');

  const [selectedId, setSelectedId] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [reason, setReason] = useState('Signed with Folio');
  const [location, setLocation] = useState('');
  const [addMode, setAddMode] = useState<AddMode>('none');
  const [busy, setBusy] = useState(false);

  const [genName, setGenName] = useState('');
  const [genOrg, setGenOrg] = useState('');
  const [genPass, setGenPass] = useState('');
  const [importPass, setImportPass] = useState('');
  const [importLabel, setImportLabel] = useState('');
  const importFileRef = useRef<HTMLInputElement>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    setSelectedId((prev) => prev || identities[0]?.id || '');
    setAddMode(identities.length === 0 ? 'generate' : 'none');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, identities, setOpen]);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    setPassphrase('');
    setGenPass('');
    setImportPass('');
    setGenName('');
    setGenOrg('');
    setImportLabel('');
    setAddMode('none');
  };

  const onGenerate = () => {
    if (!genName.trim() || !genPass) {
      announce('Enter a name and a passphrase', true);
      return;
    }
    try {
      const { p12, summary } = generateSelfSignedP12({
        commonName: genName.trim(),
        organization: genOrg.trim() || undefined,
        passphrase: genPass,
      });
      const identity = addIdentity(genName.trim(), p12, summary);
      setSelectedId(identity.id);
      setPassphrase(genPass);
      setAddMode('none');
      announce(`Created a signing identity for ${summary.commonName}`);
    } catch {
      announce('Could not create the certificate', true);
    }
  };

  const onImport = async () => {
    const file = importFileRef.current?.files?.[0];
    if (!file || !importPass) {
      announce('Choose a .p12 file and enter its passphrase', true);
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const summary = parseP12(bytes, importPass);
      const identity = addIdentity(importLabel.trim() || file.name, bytes, summary);
      setSelectedId(identity.id);
      setPassphrase(importPass);
      setAddMode('none');
      announce(`Imported a signing identity for ${summary.commonName}`);
    } catch {
      announce('Could not import: wrong passphrase or invalid file', true);
    }
  };

  const onSign = async () => {
    const info = useDocumentStore.getState().info;
    if (!info) return;
    const p12 = getP12(selectedId);
    if (!p12) {
      announce('Choose a signing identity', true);
      return;
    }
    if (!passphrase) {
      announce('Enter your certificate passphrase', true);
      return;
    }
    // Before setBusy and before the lock: a recognition pass still filling in
    // the OCR sidecar would otherwise be baked half-done into a signed copy,
    // which is the worst of the three to get quietly wrong -- a signature says
    // these are the final bytes.
    if (!(await confirmIncompleteOcr('sign'))) return;

    setBusy(true);
    try {
      // The lock covers preparing the bytes and nothing past it: exportDocument
      // reads the same snapshot Save does (see saveDocument.ts's
      // exportUnderLock), while signPdf works from a private copy and saveBytes
      // opens a native dialog the user may sit on indefinitely. Holding the
      // lock across that froze every other feature for the duration.
      const prepared = await withDocumentMutation<Uint8Array | null>(
        { owner: 'export', scope: 'content' },
        exportDocument,
        () => null,
      );
      if (!prepared) {
        announce(DOCUMENT_MUTATION_BUSY_TITLE, true);
        return;
      }

      const signed = await signPdf(prepared, p12, passphrase, {
        reason: reason.trim() || undefined,
        location: location.trim() || undefined,
        name: identities.find((i) => i.id === selectedId)?.summary.commonName,
      });
      const suggested = `${info.name.replace(/\.pdf$/i, '')} (signed).pdf`;
      if (await saveBytes(signed, suggested)) close();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Signing failed';
      announce(`Could not sign the document: ${message}`, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="folio-modal-backdrop">
      <div
        ref={dialogRef}
        className="folio-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Digitally sign"
      >
        <div className="folio-modal__header">
          <h2 className="folio-modal__title">Digitally sign</h2>
          <IconButton icon="x" label="Close" onClick={close} />
        </div>

        <div className="folio-modal__body">
          {identities.length > 0 && addMode === 'none' && (
            <label className="folio-field">
              <span className="folio-field__label">Signing identity</span>
              <select
                className="folio-input"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label} ({i.summary.commonName})
                  </option>
                ))}
              </select>
            </label>
          )}

          {addMode === 'none' ? (
            <>
              <button
                type="button"
                className="folio-link-button"
                onClick={() => setAddMode('generate')}
              >
                + Add a signing identity
              </button>
              <label className="folio-field">
                <span className="folio-field__label">Certificate passphrase</span>
                <input
                  className="folio-input"
                  type="password"
                  autoComplete="off"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </label>
              <label className="folio-field">
                <span className="folio-field__label">Reason (optional)</span>
                <input
                  className="folio-input"
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label className="folio-field">
                <span className="folio-field__label">Location (optional)</span>
                <input
                  className="folio-input"
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
              </label>
            </>
          ) : (
            <div className="folio-add-identity">
              <div className="folio-modal__tabs" role="tablist" aria-label="Add identity">
                <button
                  type="button"
                  role="tab"
                  aria-selected={addMode === 'generate'}
                  className={`folio-modal__tab${addMode === 'generate' ? ' is-active' : ''}`}
                  onClick={() => setAddMode('generate')}
                >
                  Create self-signed
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={addMode === 'import'}
                  className={`folio-modal__tab${addMode === 'import' ? ' is-active' : ''}`}
                  onClick={() => setAddMode('import')}
                >
                  Import .p12
                </button>
              </div>

              {addMode === 'generate' ? (
                <>
                  <label className="folio-field">
                    <span className="folio-field__label">Name (Common Name)</span>
                    <input
                      className="folio-input"
                      value={genName}
                      onChange={(e) => setGenName(e.target.value)}
                    />
                  </label>
                  <label className="folio-field">
                    <span className="folio-field__label">Organization (optional)</span>
                    <input
                      className="folio-input"
                      value={genOrg}
                      onChange={(e) => setGenOrg(e.target.value)}
                    />
                  </label>
                  <label className="folio-field">
                    <span className="folio-field__label">Passphrase for the new key</span>
                    <input
                      className="folio-input"
                      type="password"
                      autoComplete="off"
                      value={genPass}
                      onChange={(e) => setGenPass(e.target.value)}
                    />
                  </label>
                  <p className="folio-modal__hint">
                    A self-signed certificate works for personal use and testing. For signatures
                    others can trust automatically, import a certificate from a CA.
                  </p>
                  <div className="folio-modal__row">
                    <Button onClick={() => setAddMode('none')}>Back</Button>
                    <Button variant="primary" onClick={onGenerate}>
                      Create identity
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <label className="folio-field">
                    <span className="folio-field__label">Certificate file (.p12 / .pfx)</span>
                    <input
                      ref={importFileRef}
                      className="folio-input"
                      type="file"
                      accept=".p12,.pfx,application/x-pkcs12"
                    />
                  </label>
                  <label className="folio-field">
                    <span className="folio-field__label">Passphrase</span>
                    <input
                      className="folio-input"
                      type="password"
                      autoComplete="off"
                      value={importPass}
                      onChange={(e) => setImportPass(e.target.value)}
                    />
                  </label>
                  <label className="folio-field">
                    <span className="folio-field__label">Label (optional)</span>
                    <input
                      className="folio-input"
                      value={importLabel}
                      onChange={(e) => setImportLabel(e.target.value)}
                    />
                  </label>
                  <div className="folio-modal__row">
                    <Button onClick={() => setAddMode('none')}>Back</Button>
                    <Button variant="primary" onClick={onImport}>
                      Import identity
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="folio-modal__footer">
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || identities.length === 0 || addMode !== 'none' || crossBusy}
            title={crossBusy ? DOCUMENT_MUTATION_BUSY_TITLE : undefined}
            onClick={onSign}
          >
            {busy ? 'Signing…' : 'Sign and save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
