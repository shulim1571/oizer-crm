import { useState, type ReactNode } from 'react';

// One settings topic: a title, a line about it, its fields, and one Save that says what it saves.

export default function SettingsSection({ title, description, children, saveLabel, onSave, disabled, footer }: {
  title: ReactNode; description?: ReactNode; children: ReactNode;
  /** e.g. "Save footer". Omit for a section with nothing to save. */
  saveLabel?: string;
  /** Returns an error message, or nothing when saved. */
  onSave?: () => Promise<string | null | void> | string | null | void;
  disabled?: boolean;
  footer?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save() {
    if (!onSave) return;
    setBusy(true);
    setMsg(null);
    try {
      const err = await onSave();
      setMsg(err ? { ok: false, text: err } : { ok: true, text: 'Saved.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(false);
  }
  return (
    <section className="settings-section">
      <header><h2>{title}</h2>{description && <p className="muted small">{description}</p>}</header>
      <div className="settings-body">{children}</div>
      {(saveLabel || footer) && (
        <div className="form-actions">
          {footer}
          <div className="spacer" />
          {msg && <span className={msg.ok ? 'saved-note' : 'error small'}>{msg.text}</span>}
          {saveLabel && <button type="button" className="btn primary" disabled={busy || disabled} onClick={save}>{busy ? 'Saving…' : saveLabel}</button>}
        </div>
      )}
    </section>
  );
}
