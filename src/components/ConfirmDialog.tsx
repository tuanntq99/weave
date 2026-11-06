import { Modal } from "./Modal";

/** Asks before something that cannot be taken back. Cancel holds the focus,
 *  so Enter alone never confirms: reaching the confirming button takes a
 *  Tab or the pointer. Escape cancels. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = "danger",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Modal open={open} label={confirmLabel} className="confirm" onClose={onCancel}>
      <h2 className="confirm__title">{title}</h2>
      {body ? <p className="confirm__body">{body}</p> : null}
      <div className="confirm__actions">
        <button type="button" className="btn" autoFocus onClick={onCancel}>Cancel</button>
        <button type="button" className={`btn ${tone === "danger" ? "btn--danger" : "btn--primary"}`} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
