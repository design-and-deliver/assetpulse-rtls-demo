import styles from './Panels.module.css';
import type { Toast } from './store';

/** Bottom-right stack. Errors are announced assertively; replay notices politely. */
export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className={styles.toasts}>
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={`${styles.toast} ${t.tone === 'error' ? styles.toastError : ''}`}
        >
          <span>{t.text}</span>
          <button
            type="button"
            className={styles.toastClose}
            aria-label="Dismiss"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
