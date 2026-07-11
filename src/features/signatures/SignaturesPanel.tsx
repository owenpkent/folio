import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { Button, IconButton } from '@/components/common';
import { useSigningStore } from '@/features/signing';
import { useViewerStore } from '@/state/viewerStore';

import { useSignatureStore } from './store';

/** Sidebar panel listing placed signatures, with an entry point to add one. */
export function SignaturesPanel() {
  const signatures = useSignatureStore((s) => s.signatures);
  const remove = useSignatureStore((s) => s.remove);
  const goToPage = useViewerStore((s) => s.goToPage);

  return (
    <div className="folio-signatures-panel">
      <div className="folio-signatures-panel__actions">
        <Button variant="primary" onClick={() => commandRegistry.execute('sign.addSignature')}>
          Add signature…
        </Button>
        <Button onClick={() => commandRegistry.execute('sign.digitallySign')}>Digitally sign…</Button>
      </div>

      {signatures.length === 0 ? (
        <p className="folio-sidebar__empty">
          No signatures yet. Add one, then drag it into place on the page. Signatures are baked into
          the PDF when you save a copy.
        </p>
      ) : (
        <ul className="folio-signatures-list">
          {[...signatures]
            .sort((a, b) => a.pageNumber - b.pageNumber || a.createdAt - b.createdAt)
            .map((sig) => (
              <li key={sig.id} className="folio-signatures-list__item">
                <button
                  type="button"
                  className="folio-signatures-list__jump"
                  onClick={() => goToPage(sig.pageNumber)}
                >
                  <img className="folio-signatures-list__thumb" src={sig.dataUrl} alt="" />
                  <span className="folio-signatures-list__page">Page {sig.pageNumber}</span>
                </button>
                <IconButton
                  icon="trash"
                  label={`Delete signature on page ${sig.pageNumber}`}
                  onClick={() => {
                    remove(sig.id);
                    announce('Signature deleted');
                  }}
                />
              </li>
            ))}
        </ul>
      )}

      <DigitalSignatures />
    </div>
  );
}

function DigitalSignatures() {
  const detected = useSigningStore((s) => s.detected);
  if (detected.length === 0) return null;

  return (
    <div className="folio-digsig">
      <h3 className="folio-sidebar__heading">Digital signatures</h3>
      <ul className="folio-digsig__list">
        {detected.map((sig, i) => (
          <li key={i} className="folio-digsig__item">
            <span className="folio-digsig__signer">{sig.signerName ?? 'Unknown signer'}</span>
            {sig.signingTime && <span className="folio-digsig__time">{sig.signingTime}</span>}
            <span
              className={`folio-digsig__badge ${sig.coversWholeDocument ? 'is-ok' : 'is-warn'}`}
            >
              {sig.coversWholeDocument ? 'No changes after signing' : 'Changed after signing'}
            </span>
          </li>
        ))}
      </ul>
      <p className="folio-digsig__note">
        Certificate-chain trust is not yet validated; this shows the signer and whether the file was
        modified after signing.
      </p>
    </div>
  );
}
