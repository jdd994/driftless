// Welcome.tsx
// The warm first-run screen — Driftless's in-app "landing page". Shown once,
// before a passphrase is chosen, so a newcomer (often someone a friend just
// sent the link to) understands what this is, why it's private, and the one
// honest trade: the passphrase has no reset. Presentational only.
import { InstallHint } from "./InstallHint";
import { IosSetupNote } from "./IosSetupNote";

type Props = {
  onBegin: () => void;
};

export function Welcome({ onBegin }: Props) {
  return (
    <div className="lock welcome-screen">
      <div className="welcome">
        <div className="brand welcome-brand">
          Driftless<span className="dot">.</span>
        </div>
        <p className="welcome-tagline">A quiet place for your thoughts.</p>

        <p className="welcome-lead">
          Open it and the cursor is already waiting. Write a line — a worry, a
          memory, a small joy — and it's kept, timestamped, and threaded onto
          your own timeline. Nothing to set up, nothing to perform.
        </p>

        <ul className="welcome-points">
          <li>
            <span className="welcome-mark">❋</span>
            <div>
              <strong>The opposite of a feed.</strong> No likes, no followers, no
              scrolling. Just your inner life — and, when you want, the people you
              love. Love is the point.
            </div>
          </li>
          <li>
            <span className="welcome-mark">✦</span>
            <div>
              <strong>Private by design.</strong> Everything is encrypted on your
              device before it's saved. No ads, no tracking, no one reading over
              your shoulder — not even us. It works offline, and it's open source.
            </div>
          </li>
          <li>
            <span className="welcome-mark">☾</span>
            <div>
              <strong>Yours to keep.</strong> Write for yourself, or weave a story
              together with family in a shared, private strand. Calm at any hour,
              including 3am.
            </div>
          </li>
        </ul>

        <p className="welcome-warn">
          Next you'll choose a <strong>passphrase</strong>. It's the only key to
          your journal — there's no reset and no back door. If you forget it, not
          even we can recover what you wrote. That's the trade for real privacy:
          pick a few words you'll remember, and keep them somewhere safe.
        </p>

        <IosSetupNote />
        <InstallHint />

        <button className="save-btn lock-btn welcome-begin" onClick={onBegin}>
          Begin
        </button>
        <button className="lock-restore" onClick={onBegin}>
          Restoring a backup, or joining from another device?
        </button>
      </div>
    </div>
  );
}
