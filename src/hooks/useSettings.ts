// useSettings.ts
// UI preferences (mood theme + auto night-dimming). Stored in localStorage —
// these are cosmetic, non-sensitive, and never touch entry content.
import { useCallback, useEffect, useState } from "react";

export type Mood = "lamplight" | "ember" | "candle" | "parchment";

const MOOD_KEY = "driftless-mood";
const DIM_KEY = "driftless-nightdim";

function readMood(): Mood {
  const m = (typeof localStorage !== "undefined" && localStorage.getItem(MOOD_KEY)) || "";
  return (["lamplight", "ember", "candle", "parchment"] as string[]).includes(m)
    ? (m as Mood)
    : "lamplight";
}

export function useSettings() {
  const [mood, setMoodState] = useState<Mood>(readMood);
  const [nightDim, setNightDimState] = useState<boolean>(
    () => typeof localStorage === "undefined" || localStorage.getItem(DIM_KEY) !== "off"
  );

  // Apply the mood to <html> so the whole token palette re-tints.
  useEffect(() => {
    document.documentElement.setAttribute("data-mood", mood);
  }, [mood]);

  const setMood = useCallback((m: Mood) => {
    setMoodState(m);
    try {
      localStorage.setItem(MOOD_KEY, m);
    } catch {
      /* private mode — preference just won't persist */
    }
  }, []);

  const setNightDim = useCallback((on: boolean) => {
    setNightDimState(on);
    try {
      localStorage.setItem(DIM_KEY, on ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, []);

  return { mood, setMood, nightDim, setNightDim };
}
