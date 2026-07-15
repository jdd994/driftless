// Settings.tsx
// "Set the mood" — a calm sheet to pick a warm theme and toggle night-dimming.
// Same modal shape as HelpSheet. Preview swatches carry their own colors so you
// see each mood even while a different one is active.
import { useEffect, useState } from "react";
import type { Mood } from "../hooks/useSettings";

type MoodInfo = { id: Mood; name: string; desc: string; bg: string; ink: string; amber: string };

const MOODS: MoodInfo[] = [
  { id: "lamplight", name: "Lamplight", desc: "Warm amber, cozy", bg: "#14110B", ink: "#E7DCC7", amber: "#DBA14A" },
  { id: "ember", name: "Ember", desc: "Deeper, redder", bg: "#17100B", ink: "#EBD9C0", amber: "#E0954A" },
  { id: "candle", name: "Candle", desc: "Dim, hushed", bg: "#110E09", ink: "#D6CBB5", amber: "#CE9A50" },
  { id: "parchment", name: "Parchment", desc: "Soft daylight paper", bg: "#ECE3D1", ink: "#3A3121", amber: "#B67A2A" },
];

type Props = {
  onClose: () => void;
  mood: Mood;
  onMood: (m: Mood) => void;
  nightDim: boolean;
  onNightDim: (on: boolean) => void;
  account: string | null;
  onCreateAccount: (email: string, password: string) => Promise<string | null>;
  onDisconnect: () => void;
  onDeleteAccount: () => Promise<string | null>;
  onSyncNow: () => void;
  onChangePassphrase: (current: string, next: string) => Promise<string | null>;
};

// Change the passphrase (only while unlocked). Thanks to envelope encryption this
// is instant and doesn't re-encrypt anything; the copy explains it won't lock out
// other devices — they just ask for the new passphrase next time they sign in.
function ChangePassphraseSection({
  onChangePassphrase,
}: Pick<Props, "onChangePassphrase">) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function reset() {
    setCurrent(""); setNext(""); setConfirm(""); setError(null);
  }

  async function submit() {
    setError(null);
    if (next.length < 8) return setError("Use at least 8 characters — a few plain words you'll remember.");
    if (next !== confirm) return setError("The new passphrases don't match.");
    setBusy(true);
    const err = await onChangePassphrase(current, next);
    setBusy(false);
    if (err) return setError(err);
    reset();
    setOpen(false);
    setDone(true);
    setTimeout(() => setDone(false), 4000);
  }

  return (
    <section>
      <h3>Passphrase</h3>
      {done ? (
        <p className="account-status">Passphrase changed. Your notes never left this device.</p>
      ) : !open ? (
        <>
          <p className="account-blurb">
            Change the passphrase that unlocks this vault. It happens on your device — nothing is
            re-uploaded, and your other signed-in devices simply ask for the new one next time.
          </p>
          <button className="ghost-btn" onClick={() => setOpen(true)}>
            Change passphrase
          </button>
        </>
      ) : (
        <div className="account-form">
          {error && <p className="lock-error">{error}</p>}
          <input
            className="anchor-input" type="password" placeholder="Current passphrase"
            autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)}
          />
          <input
            className="anchor-input" type="password" placeholder="New passphrase"
            autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
          />
          <input
            className="anchor-input" type="password" placeholder="New passphrase again"
            autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
          />
          <div className="edit-foot">
            <button className="ghost-btn" onClick={() => { reset(); setOpen(false); }}>Cancel</button>
            <button className="ghost-btn" disabled={busy || !current || !next} onClick={submit}>
              {busy ? "Changing…" : "Change it"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function AccountSection({
  account,
  onCreateAccount,
  onDisconnect,
  onDeleteAccount,
  onSyncNow,
}: Pick<Props, "account" | "onCreateAccount" | "onDisconnect" | "onDeleteAccount" | "onSyncNow">) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  async function create() {
    setError(null);
    if (!email.trim() || password.length < 8) {
      setError("Enter an email and an account password of at least 8 characters.");
      return;
    }
    setBusy(true);
    const err = await onCreateAccount(email, password);
    setBusy(false);
    if (err) setError(err);
    else {
      setOpen(false);
      setEmail("");
      setPassword("");
    }
  }

  if (account) {
    return (
      <section>
        <h3>Sync</h3>
        <p className="account-status">
          Syncing as <b>{account}</b>. Your journal follows you to any device you sign in on.
        </p>
        <div className="edit-foot">
          <button className="ghost-btn" onClick={onSyncNow}>
            Sync now
          </button>
          <button className="ghost-btn" onClick={onDisconnect}>
            Disconnect this device
          </button>
        </div>

        {/* Deleting the account is quiet and deliberate — below the everyday
            controls, behind a confirm. It removes only the copy on the server;
            the journal on this device is untouched. */}
        <div className="danger-zone">
          {deleteErr ? <p className="lock-error">{deleteErr}</p> : null}
          {confirmDelete ? (
            <>
              <p className="account-hint">
                This permanently removes your synced copy from the server. Everything on{" "}
                <b>this device</b> stays exactly as it is. It can't be undone.
              </p>
              <div className="edit-foot">
                <button className="ghost-btn" onClick={() => { setConfirmDelete(false); setDeleteErr(null); }}>
                  Keep it
                </button>
                <button
                  className="ghost-btn danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const err = await onDeleteAccount();
                    setBusy(false);
                    if (err) setDeleteErr(err);
                  }}
                >
                  {busy ? "Deleting…" : "Delete from server"}
                </button>
              </div>
            </>
          ) : (
            <button className="linklike danger" onClick={() => setConfirmDelete(true)}>
              Delete this account from the server
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section>
      <h3>Sync across devices</h3>
      <p className="account-blurb">
        Create an account to carry your journal to your other devices. The account is only a
        login — separate from your passphrase, which never leaves your device. We still can't
        read a word.
      </p>
      {!open ? (
        <button className="ghost-btn" onClick={() => setOpen(true)}>
          Create an account
        </button>
      ) : (
        <div className="account-form">
          <input
            className="anchor-input"
            type="email"
            placeholder="Email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="anchor-input"
            type="password"
            placeholder="Account password (not your passphrase)"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          {error && <p className="lock-error">{error}</p>}
          <div className="edit-foot">
            <button className="save-btn" disabled={busy} onClick={create}>
              {busy ? "Working…" : "Create account"}
            </button>
            <button className="ghost-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <p className="account-hint">
        Already have an account? Sign in on a <i>new</i> device from its welcome screen.
      </p>
    </section>
  );
}

export function Settings({
  onClose,
  mood,
  onMood,
  nightDim,
  onNightDim,
  account,
  onCreateAccount,
  onDisconnect,
  onDeleteAccount,
  onSyncNow,
  onChangePassphrase,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="help-scrim" onClick={onClose}>
      <div
        className="help-card"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <span className="brand">
            Set the mood
          </span>
          <button className="help-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="help-body">
          <section>
            <h3>Mood</h3>
            <div className="mood-grid">
              {MOODS.map((m) => (
                <button
                  key={m.id}
                  className={"mood-swatch" + (mood === m.id ? " active" : "")}
                  onClick={() => onMood(m.id)}
                  aria-pressed={mood === m.id}
                >
                  <span className="mood-chip" style={{ background: m.bg }}>
                    <span className="mood-line" style={{ background: m.ink }} />
                    <span className="mood-dot" style={{ background: m.amber }} />
                  </span>
                  <span className="mood-name">{m.name}</span>
                  <span className="mood-desc">{m.desc}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3>Night dimming</h3>
            <button
              className={"toggle-row" + (nightDim ? " on" : "")}
              onClick={() => onNightDim(!nightDim)}
              role="switch"
              aria-checked={nightDim}
            >
              <span className="toggle-text">
                Gently dim and warm the app late at night, so it's never harsh at 3am.
              </span>
              <span className="toggle-switch" aria-hidden="true">
                <span className="toggle-knob" />
              </span>
            </button>
          </section>

          <AccountSection
            account={account}
            onCreateAccount={onCreateAccount}
            onDisconnect={onDisconnect}
            onDeleteAccount={onDeleteAccount}
            onSyncNow={onSyncNow}
          />

          <ChangePassphraseSection onChangePassphrase={onChangePassphrase} />
        </div>
      </div>
    </div>
  );
}
