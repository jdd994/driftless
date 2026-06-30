// HelpSheet.tsx
// A quiet in-app guide. Opened from the “?” in the header; dismissed by the ✕,
// a tap outside, or Escape. Calm, second-person copy that matches the app.
import { useEffect } from "react";

export function HelpSheet({ onClose }: { onClose: () => void }) {
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
            <h3>Your privacy</h3>
            <p>
              Everything is end-to-end encrypted with your passphrase. It never leaves your device,
              and no one — not even us — can read your journal. There's no password reset: if you
              forget the passphrase, the entries can't be recovered by anyone. Keep it somewhere
              safe.
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
        </div>
      </div>
    </div>
  );
}
