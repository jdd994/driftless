// Settings.tsx
// "Set the mood" — a calm sheet to pick a warm theme and toggle night-dimming.
// Same modal shape as HelpSheet. Preview swatches carry their own colors so you
// see each mood even while a different one is active.
import { useEffect } from "react";
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
};

export function Settings({ onClose, mood, onMood, nightDim, onNightDim }: Props) {
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
        </div>
      </div>
    </div>
  );
}
