// LockScreen.tsx
import { useEffect, useRef, useState } from "react";
import { parseBackup, type Backup } from "../lib/backup";
import { Welcome } from "./Welcome";
import { IosSetupNote } from "./IosSetupNote";

type Props = {
  mode: "needs-setup" | "locked";
  enrolled: boolean; // this device has biometric unlock set up
  onCreate: (
    passphrase: string,
    account?: { email: string; password: string }
  ) => Promise<string | null>;
  onUnlock: (passphrase: string) => Promise<boolean>;
  onBiometric: () => Promise<boolean>;
  onRestore: (backup: Backup) => Promise<void>;
  onSignIn: (email: string, password: string) => Promise<string | null>;
};

export function LockScreen({ mode, enrolled, onCreate, onUnlock, onBiometric, onRestore, onSignIn }: Props) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [siEmail, setSiEmail] = useState("");
  const [siPass, setSiPass] = useState("");
  // First run only: show the warm intro before the passphrase step.
  const [showIntro, setShowIntro] = useState(mode === "needs-setup");
  // First-run setup is a small wizard: passphrase, then an optional account.
  const [setupStep, setSetupStep] = useState<"pass" | "account">("pass");
  const [acctEmail, setAcctEmail] = useState("");
  const [acctPass, setAcctPass] = useState("");

  async function signIn() {
    setError(null);
    if (!siEmail.trim() || !siPass) {
      setError("Enter your account email and password.");
      return;
    }
    setBusy(true);
    const err = await onSignIn(siEmail, siPass);
    setBusy(false);
    // On success the vault is written and mode flips to "locked" (unlock with
    // your passphrase). On failure, show why.
    if (err) setError(err);
  }

  const setup = mode === "needs-setup";

  async function biometric() {
    setError(null);
    setBusy(true);
    try {
      const ok = await onBiometric();
      if (!ok) {
        setError("Quick unlock didn't work — enter your passphrase instead.");
        setBusy(false);
      }
    } catch {
      setError("Quick unlock didn't work — enter your passphrase instead.");
      setBusy(false);
    }
  }

  // If this device has quick unlock, prompt for it automatically on open.
  // Some browsers require a tap first; if the auto-attempt is blocked or
  // declined, the button below stays so it can be triggered by hand.
  const autoTried = useRef(false);
  useEffect(() => {
    if (mode === "locked" && enrolled && !autoTried.current) {
      autoTried.current = true;
      biometric();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, enrolled]);

  async function restoreFile(file: File) {
    setError(null);
    try {
      const backup = parseBackup(await file.text());
      await onRestore(backup);
      // The vault is now written; the screen switches to "locked" so the user
      // can unlock with the backup's original passphrase.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that backup.");
    }
  }

  // Returning: unlock with the passphrase.
  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const ok = await onUnlock(pass);
      if (!ok) {
        setError("That passphrase didn't open the journal.");
        setBusy(false);
        return;
      }
    } catch {
      setError("Something went wrong. Try again.");
      setBusy(false);
    }
  }

  // First-run step 1 → 2: validate the passphrase, then offer the account step.
  function continueToAccount() {
    setError(null);
    if (pass.length < 12) {
      setError("Use at least 12 characters — a few words you'll remember works well.");
      return;
    }
    if (pass !== confirm) {
      setError("The two passphrases don't match.");
      return;
    }
    setSetupStep("account");
  }

  // First-run finish: create the vault, optionally with a sync/sharing account.
  // On an account error we stay put so the email/password can be fixed; on
  // success the app opens and this screen goes away.
  async function finishSetup(withAccount: boolean) {
    setError(null);
    if (withAccount) {
      if (!acctEmail.trim() || !acctPass) {
        setError("Enter an email and a password — or skip this for now.");
        return;
      }
      if (acctPass.length < 8) {
        setError("Use at least 8 characters for the account password.");
        return;
      }
    }
    setBusy(true);
    try {
      const err = await onCreate(pass, withAccount ? { email: acctEmail.trim(), password: acctPass } : undefined);
      if (err) {
        setError(err);
        setBusy(false);
      }
    } catch {
      setError("Something went wrong. Try again.");
      setBusy(false);
    }
  }

  if (setup && showIntro) {
    return <Welcome onBegin={() => setShowIntro(false)} />;
  }

  // Setup, step 2: the optional account.
  if (setup && setupStep === "account") {
    return (
      <div className="lock">
        <div className="lock-card">
          <div className="brand">
            Driftless<span className="dot">.</span>
          </div>
          <IosSetupNote />
          <p className="lock-lead">
            One more, optional step: an account, so your journal can{" "}
            <b>sync across your devices</b> and you can <b>share strands</b> with
            family. Skip it and Driftless stays entirely on this device.
          </p>
          <p className="lock-sub">
            This is <b>separate from your passphrase</b>. Your passphrase unlocks
            your writing and never leaves this device. This email &amp; password
            just let the server recognize you — it only ever sees scrambled text,
            never anything you write.
          </p>
          <input
            className="lock-input"
            type="email"
            autoFocus
            placeholder="Email"
            autoComplete="email"
            value={acctEmail}
            onChange={(e) => setAcctEmail(e.target.value)}
          />
          <input
            className="lock-input"
            type="password"
            placeholder="Account password (not your passphrase)"
            autoComplete="new-password"
            value={acctPass}
            onChange={(e) => setAcctPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && finishSetup(true)}
          />
          {error && <p className="lock-error">{error}</p>}
          <button className="save-btn lock-btn" disabled={busy} onClick={() => finishSetup(true)}>
            {busy ? "Working…" : "Finish setup"}
          </button>
          <button className="lock-restore" disabled={busy} onClick={() => finishSetup(false)}>
            Skip — keep it on this device only
          </button>
          <button
            className="lock-restore"
            disabled={busy}
            onClick={() => {
              setSetupStep("pass");
              setError(null);
            }}
          >
            ‹ Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lock">
      <div className="lock-card">
        <div className="brand">
          Driftless<span className="dot">.</span>
        </div>
        {setup ? (
          <>
            <IosSetupNote />
            <p className="lock-lead">
              Choose a passphrase — a few unrelated words are stronger and easier
              to remember than one short password. It encrypts everything you
              write, so only you can open it.
            </p>
            <input
              className="lock-input"
              type="password"
              autoFocus
              placeholder="Passphrase"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirm && continueToAccount()}
            />
            <input
              className="lock-input"
              type="password"
              placeholder="Type it again"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && continueToAccount()}
            />
            <p className="lock-warn">
              There's no reset. If you forget it, the entries can't be recovered —
              not by anyone. Keep it somewhere safe.
            </p>
            {error && <p className="lock-error">{error}</p>}
            <button className="save-btn lock-btn" disabled={busy} onClick={continueToAccount}>
              Continue
            </button>

            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) restoreFile(f);
                e.target.value = "";
              }}
            />
            <button className="lock-restore" onClick={() => fileRef.current?.click()}>
              Have a backup? Restore it
            </button>

            {!signingIn ? (
              <button
                className="lock-restore"
                onClick={() => {
                  setSigningIn(true);
                  setError(null);
                }}
              >
                Joining from another device? Sign in
              </button>
            ) : (
              <div className="signin-form">
                <input
                  className="lock-input"
                  type="email"
                  placeholder="Account email"
                  autoComplete="email"
                  value={siEmail}
                  onChange={(e) => setSiEmail(e.target.value)}
                />
                <input
                  className="lock-input"
                  type="password"
                  placeholder="Account password"
                  autoComplete="current-password"
                  value={siPass}
                  onChange={(e) => setSiPass(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && signIn()}
                />
                <button className="save-btn lock-btn" disabled={busy} onClick={signIn}>
                  {busy ? "Working…" : "Sign in & sync"}
                </button>
                <button className="lock-restore" onClick={() => setSigningIn(false)}>
                  Cancel
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            {enrolled && (
              <button className="save-btn lock-btn bio-btn" disabled={busy} onClick={biometric}>
                Quick unlock
              </button>
            )}
            <p className="lock-lead">
              {enrolled ? "…or enter your passphrase." : "Enter your passphrase to open your journal."}
            </p>
            <input
              className="lock-input"
              type="password"
              autoFocus={!enrolled}
              placeholder="Passphrase"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            {error && <p className="lock-error">{error}</p>}
            <button className="save-btn lock-btn" disabled={busy} onClick={submit}>
              {busy ? "Working…" : "Unlock"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
