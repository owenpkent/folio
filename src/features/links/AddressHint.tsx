import { useEffect } from 'react';

import { useAddressHover } from './store';

/**
 * The highlight over an address the pointer is on, with its target underneath.
 *
 * `aria-hidden` on purpose: there is no keyboard or screen-reader route to it
 * (a hover cannot be triggered without a pointer), and everything it says is
 * repeated in the context menu row, which is where assistive technology meets
 * this feature. Announcing a thing no AT user can summon would be noise.
 *
 * Anchored under the address rather than following the pointer, so it can be
 * moved onto without vanishing, and dismissible with Escape: WCAG 2.2 SC 1.4.13.
 */
export function AddressHint() {
  const hit = useAddressHover((s) => s.hit);
  const box = useAddressHover((s) => s.box);
  const dismissed = useAddressHover((s) => s.dismissed);
  const dismiss = useAddressHover((s) => s.dismiss);
  // The effect below only ever reads whether a hit exists, not what it is, so
  // it depends on this boolean rather than `hit` itself: `hit` gets a new
  // object identity every time the hovered address changes (a different
  // address, or the same one at a new point), which would otherwise tear the
  // listener down and re-register it on every one of those changes instead of
  // only on the transitions that matter.
  const hasHit = hit != null;

  useEffect(() => {
    if (!hasHit || dismissed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasHit, dismissed, dismiss]);

  if (!hit || !box || dismissed) return null;

  // Flipped per axis when the default below-and-right position would overhang
  // the page (see the flipX/flipY doc on HintBox): the class names, not the
  // position, are what changes -- overHint() measures the rendered rect
  // either way, so which side the label hangs from does not affect it.
  const labelClass = [
    'folio-address-hint__label',
    box.flipX && 'is-flipped-x',
    box.flipY && 'is-flipped-y',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="folio-address-hint"
      aria-hidden="true"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <span className={labelClass}>{hit.target.value}</span>
    </div>
  );
}
