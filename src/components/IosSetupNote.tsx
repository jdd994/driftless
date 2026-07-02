// IosSetupNote.tsx
// iPhone/iPad only, and only while running in Safari (not yet installed). On
// iOS a home-screen app can get its own storage, separate from the Safari tab —
// so if someone sets up their journal in Safari and *then* adds it to the Home
// Screen, the installed app may start empty. To spare anyone that scramble, we
// say plainly on the setup screens: add to the Home Screen first, then set up.
// Renders nothing on any other platform, or once installed.
import { isIOS, isStandalone } from "./InstallHint";

export function IosSetupNote() {
  if (!isIOS() || isStandalone()) return null;
  return (
    <div className="ios-note">
      <p className="ios-note-title">On iPhone, add to your Home Screen first</p>
      <p className="ios-note-body">
        Tap the <b>Share</b> button (the square with an ↑, at the bottom of
        Safari), then <b>Add to Home Screen</b>. Open Driftless from that new icon
        and set up there — it keeps your journal saved inside the app.
      </p>
    </div>
  );
}
