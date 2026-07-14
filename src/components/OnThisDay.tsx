// OnThisDay.tsx
// A quiet card at the top of the Stream that hands you what you wrote on this
// calendar day in earlier years. Reflection, not a feed: no count, no streak, no
// "you're on fire" — just your own past voice, offered gently.
//
// It is a PULL surface. It only appears when you happen to open Driftless today,
// and it never notifies you. Dismissing it hides it for the rest of the day
// (remembered by date, so it comes back tomorrow if there's something new), so it
// can never become a nag. If there's nothing from a past year, it renders nothing.
//
// Read-only on purpose. This is a place to remember, not another place to edit.
// The preview shows most thoughts whole; the full entry always lives in the
// stream just below. (Tap-to-jump is an easy future add — see STRANDS_PLAN.md.)

import { useMemo, useState } from "react";
import { onThisDay, yearsAgoLabel, dayKey, timeLabel, type Entry } from "../lib/journal";

const DISMISS_KEY = "driftless-onthisday-dismissed";

function dismissedToday(now: number): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === dayKey(now);
  } catch {
    return false;
  }
}

export function OnThisDay({ entries }: { entries: Entry[] }) {
  const now = Date.now();
  const buckets = useMemo(() => onThisDay(entries, now), [entries, now]);
  const [hidden, setHidden] = useState(() => dismissedToday(now));

  if (hidden || buckets.length === 0) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, dayKey(now));
    } catch {
      // storage blocked — hide for this session anyway
    }
    setHidden(true);
  }

  return (
    <section className="onthisday" aria-label="On this day">
      <div className="otd-head">
        <span className="otd-title">On this day</span>
        <button className="otd-x" onClick={dismiss} aria-label="Hide until tomorrow">
          ✕
        </button>
      </div>

      {buckets.map((bucket) => (
        <div className="otd-bucket" key={bucket.yearsAgo}>
          <div className="otd-when">{yearsAgoLabel(bucket.yearsAgo)}</div>
          {bucket.entries.map((e) => (
            <article key={e.id} className="otd-entry">
              <p className="otd-text">{preview(e.text)}</p>
              <span className="otd-meta">
                {timeLabel(e.createdAt)}
                {e.mediaIds && e.mediaIds.length > 0 ? (
                  <span className="otd-photo"> · {photoLabel(e.mediaIds.length)}</span>
                ) : null}
              </span>
            </article>
          ))}
        </div>
      ))}
    </section>
  );
}

// A gentle preview — enough to recognise the memory without reprinting a long
// entry. Full text lives one tap away in the stream.
function preview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 240) return trimmed;
  return trimmed.slice(0, 237).trimEnd() + "…";
}

function photoLabel(n: number): string {
  return n === 1 ? "photo" : `${n} photos`;
}
