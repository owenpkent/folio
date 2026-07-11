import { useToastStore } from './toastStore';

/** Renders transient notifications in the corner of the window. */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="folio-toast-host" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={`folio-toast folio-toast--${toast.kind}`} role="status">
          <span className="folio-toast__message">{toast.message}</span>
          <button
            type="button"
            className="folio-toast__close"
            aria-label="Dismiss notification"
            onClick={() => dismiss(toast.id)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ))}
    </div>
  );
}
