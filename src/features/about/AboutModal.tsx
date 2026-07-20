import { useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '@/a11y/focus';
import { Button, IconButton } from '@/components/common';
import { isTauri } from '@/core/document/openDocument';
import { checkForUpdates } from '@/features/updates';
import { useViewerStore } from '@/state/viewerStore';

/** Format the ISO build timestamp for display; fall back to the raw value. */
function formatBuildDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** About dialog: version and build info, plus a manual "Check for updates". */
export function AboutModal() {
  const open = useViewerStore((s) => s.aboutModalOpen);
  const setOpen = useViewerStore((s) => s.setAboutModalOpen);
  const [checking, setChecking] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const close = () => setOpen(false);

  const onCheck = async () => {
    setChecking(true);
    try {
      // silent=false: report both "up to date" and errors via toast.
      await checkForUpdates(false);
    } finally {
      setChecking(false);
    }
  };

  // Rounded to 3 dp so fractional Windows scaling (1.25, 1.5) reads clearly.
  const dpr = Math.round((window.devicePixelRatio || 1) * 1000) / 1000;
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Version', value: __APP_VERSION__ },
    { label: 'Commit', value: __COMMIT_HASH__ },
    { label: 'Built', value: formatBuildDate(__BUILD_DATE__) },
    { label: 'Pixel ratio', value: `${dpr}× (${window.innerWidth}×${window.innerHeight})` },
  ];

  return (
    <div className="folio-modal-backdrop">
      <div
        ref={dialogRef}
        className="folio-modal folio-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label="About Folio"
      >
        <div className="folio-modal__header">
          <h2 className="folio-modal__title">About Folio</h2>
          <IconButton icon="x" label="Close" onClick={close} />
        </div>

        <div className="folio-modal__body">
          <dl className="folio-about">
            {rows.map((r) => (
              <div key={r.label} className="folio-about__row">
                <dt className="folio-about__label">{r.label}</dt>
                <dd className="folio-about__value">{r.value}</dd>
              </div>
            ))}
          </dl>
          {!isTauri() && (
            <p className="folio-modal__hint">
              Automatic updates are available in the desktop app.
            </p>
          )}
        </div>

        <div className="folio-modal__footer">
          {isTauri() && (
            <Button onClick={onCheck} disabled={checking}>
              {checking ? 'Checking…' : 'Check for updates'}
            </Button>
          )}
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
