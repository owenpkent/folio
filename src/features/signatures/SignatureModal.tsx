import { useEffect, useRef, useState } from 'react';

import { announce } from '@/a11y/announcer';
import { useFocusTrap } from '@/a11y/focus';
import { Button, IconButton } from '@/components/common';
import { useViewerStore } from '@/state/viewerStore';

import { beginSignaturePlacement } from './commands';
import {
  getRecentSignatureNames,
  rememberSignatureName,
  type RecentSignatureName,
} from './recents';
import { loadImageFile, renderTypedSignature } from './render';
import { SignaturePad, type SignaturePadHandle } from './SignaturePad';
import { SIGNATURE_FONTS, type CreatedSignature, type SignatureSource } from './types';

const TAB_LABELS: Record<SignatureSource, string> = { draw: 'Draw', type: 'Type', upload: 'Upload' };

/** Modal for creating a signature by drawing, typing, or uploading an image. */
export function SignatureModal() {
  const open = useViewerStore((s) => s.signatureModalOpen);
  const setOpen = useViewerStore((s) => s.setSignatureModalOpen);
  const [tab, setTab] = useState<SignatureSource>('draw');
  const [typed, setTyped] = useState('');
  const [font, setFont] = useState(SIGNATURE_FONTS[0].value);
  const [upload, setUpload] = useState<CreatedSignature | null>(null);
  const [recents, setRecents] = useState<RecentSignatureName[]>([]);
  const padRef = useRef<SignaturePadHandle>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open);

  // Prefill with the name last signed with, so a returning user can go
  // straight to "Place on page" without retyping it.
  useEffect(() => {
    if (!open) return;
    const list = getRecentSignatureNames();
    setRecents(list);
    if (list.length > 0) {
      setTyped(list[0].name);
      setFont(list[0].font);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    setTyped('');
    setUpload(null);
  };

  const onAdd = () => {
    let created: CreatedSignature | null = null;
    if (tab === 'draw') created = padRef.current?.export() ?? null;
    else if (tab === 'type') created = renderTypedSignature(typed, font);
    else created = upload;

    if (!created) {
      announce('Create a signature first', true);
      return;
    }
    if (tab === 'type') setRecents(rememberSignatureName(typed, font));
    // The modal gets out of the way; the next click on a page places it.
    beginSignaturePlacement(created.dataUrl, created.aspect);
    close();
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    try {
      setUpload(await loadImageFile(file));
    } catch {
      announce('Could not load that image', true);
    }
  };

  return (
    <div className="folio-modal-backdrop">
      <div ref={dialogRef} className="folio-modal" role="dialog" aria-modal="true" aria-label="Add signature">
        <div className="folio-modal__header">
          <h2 className="folio-modal__title">Add signature</h2>
          <IconButton icon="x" label="Close" onClick={close} />
        </div>

        <div className="folio-modal__tabs" role="tablist" aria-label="Signature type">
          {(Object.keys(TAB_LABELS) as SignatureSource[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`folio-modal__tab${tab === t ? ' is-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        <div className="folio-modal__body">
          {tab === 'draw' && (
            <>
              <SignaturePad ref={padRef} />
              <div className="folio-modal__row">
                <span className="folio-modal__hint">Sign above using your mouse, pen, or finger.</span>
                <Button onClick={() => padRef.current?.clear()}>Clear</Button>
              </div>
            </>
          )}

          {tab === 'type' && (
            <div className="folio-sig-type">
              {recents.length > 0 && (
                <div className="folio-sig-recents">
                  <span className="folio-modal__hint">Recent</span>
                  {recents.map((r) => (
                    <button
                      key={r.name}
                      type="button"
                      className={`folio-sig-recent${typed === r.name && font === r.font ? ' is-active' : ''}`}
                      style={{ fontFamily: r.font }}
                      onClick={() => {
                        setTyped(r.name);
                        setFont(r.font);
                      }}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              )}
              <input
                className="folio-input"
                type="text"
                placeholder="Type your name"
                value={typed}
                aria-label="Signature text"
                onChange={(e) => setTyped(e.target.value)}
              />
              <div className="folio-sig-fonts">
                {SIGNATURE_FONTS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    className={`folio-sig-font${font === f.value ? ' is-active' : ''}`}
                    style={{ fontFamily: f.value }}
                    // Once a name is typed it replaces the font's own name as
                    // the label, so the tooltip is the only thing identifying
                    // which font this swatch is.
                    title={f.name}
                    aria-label={f.name}
                    onClick={() => setFont(f.value)}
                  >
                    {typed || f.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === 'upload' && (
            <div className="folio-sig-upload">
              <input
                className="folio-input"
                type="file"
                accept="image/png,image/jpeg"
                aria-label="Signature image"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              {upload && <img className="folio-sig-preview" src={upload.dataUrl} alt="Signature preview" />}
            </div>
          )}
        </div>

        <div className="folio-modal__footer">
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={onAdd}>
            Place on page
          </Button>
        </div>
      </div>
    </div>
  );
}
