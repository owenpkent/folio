import { Button } from '@/components/common';
import {
  DOCUMENT_MUTATION_BUSY_TITLE,
  useDocumentMutationBlocked,
} from '@/state/documentMutationStore';

import { useLegacySidecarStore } from './legacyStore';

/**
 * Asks what to do with sidecar state saved under this document's old (up to 0.8.1) key.
 * Folio cannot tell which file from the template it was placed on, so the
 * choice is the user's each time; see legacyStore.ts for what each button does.
 */
export function LegacySidecarBanner() {
  const pending = useLegacySidecarStore((s) => s.pending);
  const apply = useLegacySidecarStore((s) => s.apply);
  const discard = useLegacySidecarStore((s) => s.discard);
  // Apply rewrites the page-keyed stores, so it waits for a page operation
  // the same way every other page-map change does; the store refuses it
  // anyway, this just says why up front. Discard only deletes the old entries
  // and conflicts with nothing.
  const blocked = useDocumentMutationBlocked('migration', 'pages');

  if (!pending) return null;

  return (
    <div className="folio-legacy-sidecar">
      {/* The live region is the message alone, as in PlacementHint: a status
          region holding the buttons would re-announce them on every change. */}
      <span role="status">
        Found edits saved for a document with the same PDF ID. They may belong to another file
        filled from the same form.
      </span>
      <Button
        variant="primary"
        onClick={apply}
        disabled={blocked}
        title={blocked ? DOCUMENT_MUTATION_BUSY_TITLE : undefined}
      >
        Apply to this file
      </Button>
      <Button onClick={discard}>Discard</Button>
    </div>
  );
}
