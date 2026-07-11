import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost';
}

export function Button({ variant = 'ghost', className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={['folio-button', `folio-button--${variant}`, className ?? '']
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}
