// Reader.tsx
// The reading engine: render an ordered sequence of fragments as one continuous,
// flowing piece — not a feed of cards, but a page you read.
//
// This is deliberately generic (a title + ordered entries), because the same
// primitive serves several lenses (STRANDS_PLAN §3): a *day* read as one is the
// first use; a *book / chaptered strand* is the same component later, once a
// piece can be flagged as a heading. Keep it lens-agnostic.
//
// Read-only and calm. No edit chrome, no per-card actions — this is a place to
// sit with what you wrote, so the words carry it and everything else recedes. A
// faint timestamp before each fragment gives the day its rhythm without breaking
// the flow.

import { useEffect } from "react";
import { timeLabel, type Entry } from "../lib/journal";

export function Reader({
  title,
  subtitle,
  entries,
  onClose,
}: {
  title: string;
  subtitle?: string;
  entries: Entry[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // Lock background scroll while the reader is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="reader-backdrop" onClick={onClose}>
      <div
        className="reader"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="reader-bar">
          <button className="reader-close" onClick={onClose} aria-label="Close">
            Done
          </button>
        </div>

        <article className="reader-page">
          <header className="reader-head">
            <h1 className="reader-title">{title}</h1>
            {subtitle ? <p className="reader-sub">{subtitle}</p> : null}
          </header>

          {entries.map((e) => (
            <section className="reader-frag" key={e.id}>
              <span className="reader-time">{timeLabel(e.createdAt)}</span>
              {paragraphs(e.text).map((para, i) => (
                <p className="reader-para" key={i}>
                  {para}
                </p>
              ))}
              {e.mediaIds && e.mediaIds.length > 0 ? (
                <p className="reader-photo">
                  {e.mediaIds.length === 1 ? "a photo" : `${e.mediaIds.length} photos`} here
                </p>
              ) : null}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}

// Split an entry's text into paragraphs on blank lines (and single newlines),
// so a multi-line thought reads as prose rather than one run-on block. Empties
// are dropped.
function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .flatMap((block) => block.split(/\n/))
    .map((s) => s.trim())
    .filter(Boolean);
}
