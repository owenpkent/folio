import type { ButtonHTMLAttributes, Ref } from 'react';

import { Icon, type IconName } from './Icon';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Accessible name; used for both aria-label and the tooltip. Required. */
  label: string;
  /** Renders a pressed/toggled state and sets aria-pressed. */
  active?: boolean;
  size?: number;
  // React 19 passes `ref` through as a plain prop; declared explicitly since
  // `ButtonHTMLAttributes` does not include it. Callers that need to manage
  // focus imperatively (e.g. the combine modal's row actions) attach it to
  // the underlying <button> via the `{...rest}` spread below.
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ icon, label, active, size, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={['folio-icon-button', active ? 'is-active' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
      title={label}
      aria-pressed={active}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
