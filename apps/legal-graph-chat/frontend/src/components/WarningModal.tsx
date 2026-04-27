import type { ReactNode } from 'react';

interface WarningModalProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function WarningModal({ title, children, confirmLabel, cancelLabel = '취소', onConfirm, onCancel }: WarningModalProps) {
  return (
    <div className="lg-modal-backdrop" role="presentation">
      <section className="lg-modal" role="dialog" aria-modal="true" aria-labelledby="lg-modal-title">
        <header className="lg-modal__header">
          <span className="lg-modal__mark" aria-hidden="true">!</span>
          <h2 id="lg-modal-title">{title}</h2>
        </header>
        <div className="lg-modal__body">{children}</div>
        <footer className="lg-modal__footer">
          <button type="button" className="lg-button" onClick={onCancel} aria-label={cancelLabel}>
            {cancelLabel}
          </button>
          <button type="button" className="lg-button" data-variant="primary" onClick={onConfirm} aria-label={confirmLabel}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
