// journal.ts
// Pure, framework-free logic. Operates on decrypted entries held in memory
// after the vault is unlocked. No React, no IO here — easy to test and reason
// about.

// An optional anchor in *lived* time — when a thought actually happened — as
// opposed to createdAt (when it was written). Memory is fuzzy, so an anchor is
// either an approximate calendar point (with a precision) or a free-text era
// like "childhood". At least one of `time` / `label` is set.
export type Anchor = {
  time?: number; // epoch ms at the start of the period; the timeline sort key
  precision?: "year" | "month" | "day";
  label?: string; // free-text era / reference, when there's no clear date
};

export type MediaConfig = { size?: "s" | "m" | "l"; width?: number; tilt?: number };

export type Entry = {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  anchor?: Anchor;
  mediaIds?: string[]; // attached images (stored encrypted in the media store)
  mediaConfig?: Record<string, MediaConfig>; // per-photo size/tilt
};

// A gentle, stable default tilt derived from the media id, so polaroids look
// scattered but don't jump around when reordered.
export function defaultTilt(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 49) - 24) / 10; // ~[-2.4, 2.4] degrees
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function hasAnchor(a: Anchor | undefined): a is Anchor {
  return !!a && (a.time !== undefined || !!a.label);
}

// ---- Encrypted payload --------------------------------------------------
// What actually gets encrypted is a small JSON document, not the raw text, so
// the anchor travels inside the ciphertext (never plaintext). Legacy entries
// were the raw text string; decodePayload detects that and treats it as text.

type Payload = {
  __driftless: 1;
  text: string;
  anchor?: Anchor;
  mediaIds?: string[];
  mediaConfig?: Record<string, MediaConfig>;
  author?: string; // shared pieces only: the user id who wrote it
};

export function encodePayload(
  text: string,
  anchor?: Anchor,
  mediaIds?: string[],
  mediaConfig?: Record<string, MediaConfig>,
  author?: string
): string {
  const p: Payload = { __driftless: 1, text };
  if (hasAnchor(anchor)) p.anchor = anchor;
  if (mediaIds && mediaIds.length) p.mediaIds = mediaIds;
  if (mediaConfig && Object.keys(mediaConfig).length) p.mediaConfig = mediaConfig;
  if (author) p.author = author;
  return JSON.stringify(p);
}

export function decodePayload(decrypted: string): {
  text: string;
  anchor?: Anchor;
  mediaIds?: string[];
  mediaConfig?: Record<string, MediaConfig>;
  author?: string;
} {
  try {
    const obj = JSON.parse(decrypted) as Payload;
    if (obj && typeof obj === "object" && obj.__driftless === 1 && typeof obj.text === "string") {
      return {
        text: obj.text,
        anchor: hasAnchor(obj.anchor) ? obj.anchor : undefined,
        mediaIds: Array.isArray(obj.mediaIds) && obj.mediaIds.length ? obj.mediaIds : undefined,
        mediaConfig:
          obj.mediaConfig && typeof obj.mediaConfig === "object" ? obj.mediaConfig : undefined,
        author: typeof obj.author === "string" ? obj.author : undefined,
      };
    }
  } catch {
    // Not our JSON → a legacy plain-text entry.
  }
  return { text: decrypted };
}

// ---- Fuzzy anchor parsing + display -------------------------------------
// Recognizes years, months, and dates in a few common forms; anything else
// becomes a free-text era label. UTC throughout so sort keys don't drift.

export function parseAnchor(input: string): Anchor | null {
  const s = input.trim();
  if (!s) return null;
  const mon = (name: string) => MONTHS.findIndex((m) => m.toLowerCase() === name.slice(0, 3).toLowerCase());

  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})$/.exec(s))) {
    return { time: Date.UTC(+m[1], 0, 1), precision: "year" };
  }
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(s)) && +m[2] >= 1 && +m[2] <= 12) {
    return { time: Date.UTC(+m[1], +m[2] - 1, 1), precision: "month" };
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)) && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
    return { time: Date.UTC(+m[1], +m[2] - 1, +m[3]), precision: "day" };
  }
  if ((m = /^([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(s)) && mon(m[1]) >= 0) {
    return { time: Date.UTC(+m[2], mon(m[1]), 1), precision: "month" };
  }
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/.exec(s)) && mon(m[2]) >= 0 && +m[1] >= 1 && +m[1] <= 31) {
    return { time: Date.UTC(+m[3], mon(m[2]), +m[1]), precision: "day" };
  }
  if ((m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)) && mon(m[1]) >= 0 && +m[2] >= 1 && +m[2] <= 31) {
    return { time: Date.UTC(+m[3], mon(m[1]), +m[2]), precision: "day" };
  }
  return { label: s };
}

export function formatAnchor(a: Anchor): string {
  if (a.time !== undefined && a.precision) {
    const d = new Date(a.time);
    const y = d.getUTCFullYear();
    if (a.precision === "year") return String(y);
    if (a.precision === "month") return `${MONTHS[d.getUTCMonth()]} ${y}`;
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${y}`;
  }
  return a.label ?? "";
}

const TAG_RE = /(^|\s)#([a-z0-9_-]{1,40})/gi;

export function extractTags(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) out.push(m[2].toLowerCase());
  return [...new Set(out)];
}

export function allTags(entries: Entry[]): string[] {
  const counts = new Map<string, number>();
  for (const e of entries)
    for (const t of extractTags(e.text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.keys()].sort(
    (a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b)
  );
}

export function filterEntries(
  entries: Entry[],
  query: string,
  tag: string | null
): Entry[] {
  const q = query.trim().toLowerCase();
  return entries
    .filter((e) => {
      if (tag && !extractTags(e.text).includes(tag)) return false;
      if (q && !e.text.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type DayGroup = { key: string; label: string; entries: Entry[] };

export function groupByDay(entries: Entry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const e of entries) {
    const k = dayKey(e.createdAt);
    if (!current || current.key !== k) {
      current = { key: k, label: dayLabel(e.createdAt), entries: [] };
      groups.push(current);
    }
    current.entries.push(e);
  }
  return groups;
}

// ---- On this day --------------------------------------------------------
// Resurface what you wrote on this calendar day (month + day) in earlier years.
// This is Driftless's whole purpose pointed backwards: not "look how much you
// posted", but "here is your own past self, for you to sit with."
//
// Deliberately PULL, never push. It appears when you happen to open the app; it
// never notifies, buzzes, or emails. (See the scheduling-decision memory:
// future anchors and other pull surfaces are welcome; reminders/notifications
// are push, and Driftless says no to push — presence shouldn't be nagged out of
// someone.) It also never counts or ranks; it just quietly hands you the page.
//
// Matched on createdAt — when the thought was written — which is always present
// and gives an unambiguous "a year ago today you wrote this". Surfacing on an
// anchor's *lived* anniversary is a lovely future extension; see STRANDS_PLAN.md.

export type OnThisDayBucket = { yearsAgo: number; entries: Entry[] };

export function onThisDay(entries: Entry[], now: number): OnThisDayBucket[] {
  const today = new Date(now);
  const month = today.getMonth();
  const date = today.getDate();
  const thisYear = today.getFullYear();

  const byYearsAgo = new Map<number, Entry[]>();
  for (const e of entries) {
    const t = new Date(e.createdAt);
    if (t.getMonth() !== month || t.getDate() !== date) continue;
    const yearsAgo = thisYear - t.getFullYear();
    if (yearsAgo <= 0) continue; // only earlier years, never today itself
    const list = byYearsAgo.get(yearsAgo) ?? [];
    list.push(e);
    byYearsAgo.set(yearsAgo, list);
  }

  return [...byYearsAgo.entries()]
    .sort((a, b) => a[0] - b[0]) // most recent year first: "a year ago" leads
    .map(([yearsAgo, es]) => ({
      yearsAgo,
      entries: es.sort((a, b) => b.createdAt - a.createdAt),
    }));
}

export function yearsAgoLabel(yearsAgo: number): string {
  return yearsAgo === 1 ? "A year ago today" : `${yearsAgo} years ago today`;
}

// ---- Strands ------------------------------------------------------------
// A Strand is a named, ordered collection of entries — the "narrative order"
// axis (memory pieced together, a song's verses, a book's sections). It only
// references entries by id and holds the order; the pieces themselves are
// ordinary thoughts. Title + order are content, so they're stored encrypted.

export type Strand = {
  id: string;
  title: string;
  entryIds: string[]; // the composed order
  createdAt: number;
  updatedAt: number;
};

export function encodeStrand(title: string, entryIds: string[]): string {
  return JSON.stringify({ __strand: 1, title, entryIds });
}

export function decodeStrand(decrypted: string): { title: string; entryIds: string[] } {
  try {
    const o = JSON.parse(decrypted);
    if (o && o.__strand === 1) {
      return {
        title: typeof o.title === "string" ? o.title : "",
        entryIds: Array.isArray(o.entryIds) ? o.entryIds : [],
      };
    }
  } catch {
    // fall through
  }
  return { title: "", entryIds: [] };
}

// ---- Shared strands (co-authored, E2E) ----
// A shared strand's pieces are their own text records encrypted with the strand
// key. Kept simple for v1: text only (no anchors/media/reorder yet).
export type SharedPiece = {
  id: string;
  text: string;
  mediaIds?: string[]; // photos, encrypted with the strand DEK (M2)
  author?: string; // user id who wrote it (for edit/delete permissions)
  createdAt: number;
  updatedAt: number;
};
export type SharedStrandView = {
  strandId: string;
  role: string; // 'owner' | 'member'
  title: string;
  entryIds: string[];
  pieces: Record<string, SharedPiece>;
};

// Resolve a shared strand's pieces into display order. The order lives in a
// single last-write-wins "meta" record, so two members writing at nearly the
// same time can race — one meta wins and could omit the other's brand-new
// piece. To guarantee a co-author's thought is *never* silently dropped, any
// piece not named by the order still appears, appended by creation time.
export function sharedPieces(view: {
  entryIds: string[];
  pieces: Record<string, SharedPiece>;
}): SharedPiece[] {
  const seen = new Set<string>();
  const out: SharedPiece[] = [];
  for (const id of view.entryIds) {
    const p = view.pieces[id];
    if (p) {
      out.push(p);
      seen.add(id);
    }
  }
  const extras = Object.values(view.pieces)
    .filter((p) => !seen.has(p.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  return [...out, ...extras];
}

// Resolve a strand's ordered entry ids into entries, skipping any that no
// longer exist (e.g. deleted thoughts) so dangling references are harmless.
export function strandEntries(entryIds: string[], byId: Map<string, Entry>): Entry[] {
  const out: Entry[] = [];
  for (const id of entryIds) {
    const e = byId.get(id);
    if (e) out.push(e);
  }
  return out;
}

// The "lived time" view: anchored thoughts arranged chronologically. Dated
// anchors group by year (ascending); label-only anchors collect in `undated`.
export function timelineGroups(entries: Entry[]): {
  dated: DayGroup[];
  undated: Entry[];
} {
  const anchored = entries.filter((e) => hasAnchor(e.anchor));
  const dated = anchored
    .filter((e) => e.anchor!.time !== undefined)
    .sort((a, b) => a.anchor!.time! - b.anchor!.time!);
  const undated = anchored.filter((e) => e.anchor!.time === undefined);

  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const e of dated) {
    const key = String(new Date(e.anchor!.time!).getUTCFullYear());
    if (!current || current.key !== key) {
      current = { key, label: key, entries: [] };
      groups.push(current);
    }
    current.entries.push(e);
  }
  return { dated: groups, undated };
}

export function toMarkdown(entries: Entry[]): string {
  const ordered = [...entries].sort((a, b) => a.createdAt - b.createdAt);
  let md = "# Journal\n\n";
  let curDay: string | null = null;
  for (const e of ordered) {
    const k = dayKey(e.createdAt);
    if (k !== curDay) {
      curDay = k;
      const full = new Date(e.createdAt).toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      md += `\n## ${full}\n\n`;
    }
    md += `**${timeLabel(e.createdAt)}** — ${e.text.replace(/\n/g, "\n  ")}\n\n`;
  }
  return md;
}
