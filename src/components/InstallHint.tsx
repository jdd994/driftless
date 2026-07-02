// InstallHint.tsx
// A gentle, dismissible nudge to install Driftless as a real app — shown only
// when it's running in a browser tab (not already installed). Many people don't
// know "add to home screen" exists, so we make it obvious and easy:
//  - Android / desktop Chrome: capture the native prompt → one-tap Install.
//  - iPhone (Safari): show the exact Share → Add to Home Screen steps (iOS has
//    no programmatic install).
// Dismissal is remembered so it never nags.
import { useEffect, useState } from "react";

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

const DISMISS_KEY = "driftless-install-dismissed";

export function InstallHint() {
  const [deferred, setDeferred] = useState<{ prompt: () => void; userChoice: Promise<unknown> } | null>(null);
  const [show, setShow] = useState(false);
  const [steps, setSteps] = useState(false);

  useEffect(() => {
    if (isStandalone()) return; // already installed — nothing to do
    if (isIOS()) return; // iOS is guided by IosSetupNote (order matters there)
    if (localStorage.getItem(DISMISS_KEY)) return;
    setShow(true);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as unknown as { prompt: () => void; userChoice: Promise<unknown> });
    };
    const onInstalled = () => {
      setShow(false);
      localStorage.setItem(DISMISS_KEY, "1");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!show) return null;

  function dismiss() {
    setShow(false);
    localStorage.setItem(DISMISS_KEY, "1");
  }

  async function primary() {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
      dismiss();
    } else {
      setSteps((v) => !v);
    }
  }

  const ios = isIOS();

  return (
    <div className="install-hint">
      <div className="install-row">
        <span className="install-text">Add Driftless to your home screen so it opens like an app.</span>
        <button className="install-btn" onClick={primary}>
          {deferred && !ios ? "Install" : steps ? "Hide" : "How?"}
        </button>
        <button className="install-x" onClick={dismiss} aria-label="Not now">
          ✕
        </button>
      </div>
      {steps && (
        <p className="install-steps">
          {ios ? (
            <>
              In <b>Safari</b>, tap the <b>Share</b> button (the square with an ↑ at
              the bottom of the screen), then scroll down and choose{" "}
              <b>Add to Home Screen</b>. Open Driftless from that icon from now on.
            </>
          ) : (
            <>
              Open your browser's menu (the <b>⋮</b> or <b>⋯</b>), then choose{" "}
              <b>Install app</b> or <b>Add to Home screen</b>.
            </>
          )}
        </p>
      )}
    </div>
  );
}
