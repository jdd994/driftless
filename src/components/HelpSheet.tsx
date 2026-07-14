// HelpSheet.tsx
// A quiet in-app guide. Opened from the “?” in the header; dismissed by the ✕,
// a tap outside, or Escape. Calm, second-person copy that matches the app.
import { useEffect, useRef, useState } from "react";
import { sendFeedback } from "../lib/api";

// Tip / support options. A card link (Ko-fi, PayPal underneath) leads, since it's
// the welcoming front door for most people; crypto follows as the quiet
// zero-paperwork alternative. Just an outbound link + copyable addresses — no
// processor or widget in the app, no tracker, no CSP change (privacy-safe). Add
// more crypto addresses by extending `crypto` — one line.
const SUPPORT = {
  fiatUrl: "https://ko-fi.com/johnny65449", // card / PayPal, via Ko-fi
  crypto: [
    { label: "Bitcoin", value: "bc1qvhzyyhjngwyc02p5ska0pk33tvn6dnq06vacgv" }, // device-verified on Trezor
    { label: "Ethereum", value: "0x6857f91F7Fcd7B45a3ab3A51D2CdC47E23FE8c75" },
  ],
};

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — the address is still visible to copy by hand
    }
  }
  return (
    <div className="support-row">
      <span className="support-label">{label}</span>
      <button className="support-addr" onClick={copy} title={`Copy ${label} address`}>
        <span className="support-addr-text">{value}</span>
        <span className="support-copy">{copied ? "copied ✓" : "copy"}</span>
      </button>
    </div>
  );
}

// A calm note to the maker. Plainly separate from the journal (not encrypted,
// not an entry) — just a message you chose to send. No obligation either way.
function NoteToMaker() {
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const m = message.trim();
    if (!m || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendFeedback(m, contact.trim() || undefined);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that just now — try again in a bit.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <section className="note-maker">
        <h3>Thank you</h3>
        <p>Got it. I read these when I can — no rush, no obligation. It means a lot.</p>
      </section>
    );
  }

  return (
    <section className="note-maker">
      <h3>Tell me what's clunky</h3>
      <p>
        Something confusing, missing, or just a thought? Send it my way. This is a
        plain note to me — kept separate from your journal, not part of your
        private, encrypted writing. I read these when I can, no rush.
      </p>
      <textarea
        className="note-input"
        rows={3}
        placeholder="What's on your mind about Driftless?"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <input
        className="note-contact"
        placeholder="Email, if you'd like a reply (optional)"
        value={contact}
        onChange={(e) => setContact(e.target.value)}
      />
      {error && <p className="note-error">{error}</p>}
      <button className="save-btn note-send" disabled={!message.trim() || busy} onClick={send}>
        {busy ? "Sending…" : "Send"}
      </button>
    </section>
  );
}

export function HelpSheet({
  onClose,
  focus,
}: {
  onClose: () => void;
  focus?: "top" | "support";
}) {
  const supportRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Opened via the heart → jump straight to Support.
  useEffect(() => {
    if (focus === "support") supportRef.current?.scrollIntoView({ block: "start" });
  }, [focus]);

  return (
    <div className="help-scrim" onClick={onClose}>
      <div
        className="help-card"
        role="dialog"
        aria-label="How Driftless works"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <span className="brand">
            Driftless<span className="dot">.</span>
          </span>
          <button className="help-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="help-body">
          <section>
            <h3>Catch a thought</h3>
            <p>
              The cursor is already waiting. Type, then keep it — it's saved on your device the
              moment you do, online or off.
            </p>
          </section>

          <section>
            <h3>Three ways to see your thoughts</h3>
            <p>
              <b>Stream</b> — everything in the order you wrote it.
            </p>
            <p>
              <b>Timeline</b> — give a thought a <b>Place in time</b> (a year, a date, or an era like
              “childhood”) and it appears here, arranged by when it actually happened.
            </p>
            <p>
              <b>Strands</b> — gather pieces into a named, ordered whole: a memory, a song, a
              chapter. Pull in thoughts you've written, or compose new ones in place, then arrange
              and read them as one.
            </p>
          </section>

          <section>
            <h3>Tags</h3>
            <p>Start a word with # to tag it. Tap a tag to filter your Stream.</p>
          </section>

          <section>
            <h3>Install it as an app</h3>
            <p>
              Driftless runs in your browser, but you can add it to your home
              screen so it opens on its own, full-screen, like any app.
            </p>
            <p>
              <b>iPhone / iPad:</b> in Safari, tap the <b>Share</b> button (the
              square with an ↑), then <b>Add to Home Screen</b>.
            </p>
            <p>
              <b>Android / computer:</b> open the browser menu (<b>⋮</b>) and
              choose <b>Install app</b> or <b>Add to Home screen</b>.
            </p>
          </section>

          <section>
            <h3>Your privacy</h3>
            <p>
              Everything is end-to-end encrypted with your passphrase. It never leaves your device,
              and no one — not even us — can read your journal. There's no password reset: if you
              forget the passphrase, the entries can't be recovered by anyone. Keep it somewhere
              safe.
            </p>
          </section>

          <section>
            <h3>Staying safe</h3>
            <p>
              There are two separate secrets: your <b>passphrase</b> unlocks your
              writing and never leaves your device — there's no reset, so keep it
              in a password manager and on paper somewhere safe. Your <b>account
              password</b> (for syncing) is a different thing; make it its own
              strong password, and turn on two-factor login on your email.
            </p>
            <p>
              Lock your devices, and treat any <b>invite link</b> like a house key
              — share it privately, and if it might have leaked, remove that person
              (the strand re-keys itself). Never screenshot or text your passphrase.
            </p>
          </section>

          <section>
            <h3>Quick unlock</h3>
            <p>
              If your device supports it, turn on <b>Quick unlock</b> to open with your fingerprint
              or face instead of typing. Your passphrase still works, and is still what you'll use on
              a new device.
            </p>
          </section>

          <section>
            <h3>Keeping it safe</h3>
            <p>
              <b>Back up</b> saves an encrypted file you can restore later or on another device.{" "}
              <b>Export</b> saves a plain, readable copy. Your thoughts live on this device for now,
              so back up now and then.
            </p>
          </section>

          <NoteToMaker />

          <section className="support" ref={supportRef}>
            <h3>Support Driftless</h3>
            <p>
              Driftless is free, forever — no ads, no tracking, no one reading your words. If it's
              meaningful to you, a small tip helps keep it alive.
            </p>
            {/* Card first — the front door (Ko-fi, PayPal underneath; works from
                anywhere, in any currency). */}
            <a className="support-card" href={SUPPORT.fiatUrl} target="_blank" rel="noopener noreferrer">
              Leave a tip with a card &nbsp;→
            </a>
            {/* Crypto — the quiet zero-paperwork alternative. */}
            <div className="support-crypto">
              <span className="support-crypto-label">or, if you prefer crypto</span>
              {SUPPORT.crypto.map((c) => (
                <CopyRow key={c.label} label={c.label} value={c.value} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
