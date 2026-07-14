# Strands, days, and reading — a design plan

Status: **"On this day" is built (2026-07-14).** Everything else here is a
considered design position, not yet code. This captures the thinking so it
survives, the way SYNC_PLAN.md and SHARING_PLAN.md do.

It answers three linked questions that came up together:

1. Should a day of notes become a "daily strand"?
2. Can we have book mode / chapters — and can a "trip" branch off a shared strand?
3. What's the smallest thing that makes both feel good?

The throughline: **give people hierarchy of *reading* without hierarchy of
*structure*.** Chapters, days, and trips are all ways of reading a sequence of
fragments as a larger whole. None of them needs the data model to grow a tree —
and a tree is exactly what would turn Driftless into a fiddly outliner and break
the "calm, easy, intuitive" pillar.

---

## The three axes today (don't muddy them)

Driftless organises entries on three clean axes (see CLAUDE.md):

- **Stream** — capture time. Automatic. "When I wrote it."
- **Timeline** — lived/anchor time. Semi-authored. "When it happened."
- **Strands** — narrative order. *Authored.* "I chose to put these together."

A Strand's whole meaning is that *you chose it*. That meaning is fragile:
anything that auto-creates strands dilutes it until the Strands list is noise.
Guard it.

---

## 1. The "daily strand" → a day is a VIEW, not a stored strand

The desire is real: a day should be a rememberable, revisitable unit, not just a
scatter of timestamps. But a day is **capture time** (the Stream's axis), and it
is automatic — the opposite of an authored Strand. Persisting a strand per day
would:

- dilute "a Strand is something I chose to weave",
- duplicate data (entries already carry `createdAt`; `dayKey`/`dayLabel` and
  `groupByDay` already exist in journal.ts),
- and add sync/reconciliation cost for an object nobody actually authored.

**Position:** a day is a **lens over existing entries**, never a stored object.

- **A "Days" reading view** (not yet built): scroll day by day; each day reads as
  one continuous flowing piece. Pure function over `entries` — reuses the reading
  engine below. Zero new data model, zero sync cost.
- **The one authored bit worth storing:** an optional **title or a line of
  reflection for a day** ("the day Mum called"). Store it *lightly*, keyed by
  `dayKey`, as a small day-note — **not** as a full Strand. Keeps Strands
  meaning what they mean.

### 1a. "On this day" — BUILT (2026-07-14)

The most magical slice of the day idea, and it needed no new stored shape, so it
shipped first (before sync).

- `onThisDay(entries, now)` in journal.ts groups entries written on this calendar
  day (month+day) in earlier years, buckets by years-ago, most-recent year first.
- `OnThisDay.tsx` shows a calm card at the top of the Stream — your own past
  voice in the serif, no count, no streak, no "you posted N times". Dismiss hides
  it for the day (remembered by `dayKey`), so it can never nag. Hidden entirely
  when searching/filtering.
- **Pull, never push.** It appears only when you happen to open the app; it never
  notifies. This is the same line the scheduling decision drew: pull surfaces
  welcome, push (reminders/notifications) refused. Presence shouldn't be nagged
  out of someone.
- Matched on `createdAt` (when written) — always present, unambiguous label.

**Open extensions for "on this day":**
- Surface on an **anchor's lived anniversary** too ("5 years ago *this happened*",
  from `anchor.time`), not only the writing date. Lovely; needs a clear label
  distinguishing "wrote" from "happened".
- Tap a memory to **jump to it in the stream** (needs stable DOM ids on stream
  items; deliberately skipped in v1 to avoid a dead affordance).
- Optionally include "a month ago", or "this week across the years".

---

## 2. Book mode / chapters / a trip off a shared strand

This is roadmap item 6. The concrete cases:

- a **book** with chapters (the whole, and its parts),
- a **shared trip** that sits inside an ongoing shared strand — visible at the
  high level, but also its own thing.

Both *feel* like nesting. Building actual nesting (strand-in-strand) is the trap:
it drifts toward an outliner and fights calm/easy/intuitive.

**Position:** a **section is a piece flagged as a heading.** Everything until the
next heading belongs to it. The data stays flat — one Strand, ordered entries,
some marked as headings — but the *experience* is chapters.

- **Book with chapters** → heading entries are chapter titles; the set of
  headings is the table of contents; read-as-one flows straight through. Solved.
- **Trip inside the family strand** → "Our week in Portugal" as a heading in the
  shared strand. It's *visible at the high level* (right there in the strand) and
  *its own thing* (a titled section you can jump to or collapse). Solved — with no
  nesting.

Why this is the right size:
- ~90% of the value, little of the risk (CLAUDE.md's own words).
- A heading is **still just an entry with a flag**, so sync needs almost nothing
  new — it already moves entries. Sub-strands would need real new sync + sharing
  design.
- Keeps "everything is a thought" and the flat model intact.

### The one case sections genuinely can't do

A section cannot have **different membership or sharing** than the strand it lives
in. If the family strand is you + your parents, but the trip also includes a
friend who came along, a heading can't give the trip its own guest list.

*That* — independent membership/sharing/identity — is the only real reason to
reach for true sub-strands. It's a **sharing-scope** problem, not a
books-and-chapters problem. So:

**Do not build the tree speculatively.** Ship sections-as-headings. Treat "one
level of real sub-strands" as a separate, later decision, taken only when a
concrete need for independent sharing appears — and even then, cap nesting at
exactly one level, never arbitrary recursion.

---

## 3. The reading engine (build once, reuse everywhere)

Days, books, and chaptered strands all need the same primitive: **render an
ordered sequence of fragments as one continuous, flowing piece**, with optional
headings breaking it into sections and a table of contents falling out of the
headings.

Build that as *one* thing:

```
readAsOne(entries: Entry[], opts?: { headings?: boolean })
  → { sections: { heading?: Entry; body: Entry[] }[] }
```

Then:
- **a day** = `readAsOne(that day's entries)`
- **a book / chaptered strand** = `readAsOne(strand entries, { headings: true })`
- **the whole Strands read view** uses the same renderer.

One reading surface, several lenses. This is the architectural payoff of keeping
everything flat.

---

## Sequencing

1. **On this day** — done. Pull-only, no new data model.
2. **Days reading view** + light per-day note — safe before sync (views over
   existing data; the day-note is a small new keyed store, design it to reconcile
   like entries).
3. **The reading engine** — extract once, use for days and strands.
4. **Sections-as-headings** — *after sync*, per CLAUDE.md. A heading is an entry
   flag, so it rides existing entry sync. This gives book mode and the
   trip-in-strand case.
5. **Sub-strands (one level)** — only if a real need for independent sharing
   appears. A sharing-scope feature, designed against SHARING_PLAN.md, not a
   general nesting feature. Probably never; that's fine.

## The north-star check

All of the above serve *remember, reflect, and build something together* — never
performance, comparison, or a metric. "On this day" is reflection; chapters are
"build a story together". The only risk any of them carries is complexity, so the
rule throughout is: **add reading richness, never structural weight.**
