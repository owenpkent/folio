import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { Button, IconButton } from '@/components/common';
import { useViewerStore } from '@/state/viewerStore';

import { useSignatureStore } from './store';

/** Sidebar panel listing placed signatures, with an entry point to add one. */
export function SignaturesPanel() {
  const signatures = useSignatureStore((s) => s.signatures);
  const remove = useSignatureStore((s) => s.remove);
  const goToPage = useViewerStore((s) => s.goToPage);

  return (
    <div className="folio-signatures-panel">
      <Button variant="primary" onClick={() => commandRegistry.execute('sign.addSignature')}>
        Add signature…
      </Button>

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
    </div>
  );
}
