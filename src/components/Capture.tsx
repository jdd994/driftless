// Capture.tsx
import { useEffect, useRef, useState } from "react";

type Props = { onKeep: (text: string) => void };

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Capture({ onKeep }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  function grow() {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.5) + "px";
  }

  function keep() {
    const text = value.trim();
    if (!text) return;
    onKeep(text);
    setValue("");
    requestAnimationFrame(() => {
      grow();
      ref.current?.focus();
    });
    setFlash(true);
    setTimeout(() => setFlash(false), 1100);
  }

  return (
    <section className="capture">
      <textarea
        ref={ref}
        className="capture-input"
        rows={1}
        aria-label="Write a thought"
        placeholder="What's surfacing? Catch it here…"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          grow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            keep();
          }
        }}
      />
      <div className="capture-foot">
        <span className="hint">
          <kbd>{isMac ? "⌘" : "Ctrl"}</kbd> + <kbd>Enter</kbd> to keep · Enter for a new line
        </span>
        <div className="capture-actions">
          <span className={"saved" + (flash ? " show" : "")}>kept ✓</span>
          <button className="save-btn" disabled={!value.trim()} onClick={keep}>
            Keep thought
          </button>
        </div>
      </div>
    </section>
  );
}
