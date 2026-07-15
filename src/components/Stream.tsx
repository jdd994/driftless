// Stream.tsx
import { groupByDay, type Entry, type Anchor, type Strand, type MediaConfig } from "../lib/journal";
import { EntryItem } from "./EntryItem";

type Props = {
  entries: Entry[]; // already filtered + sorted (newest first)
  totalCount: number; // unfiltered count, to tell the two empty states apart
  onReadDay: (entries: Entry[], label: string) => void; // open a day as one flowing read
  onSave: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onAnchor: (id: string, anchor: Anchor | null) => void;
  strands: Strand[];
  onToggleStrand: (strandId: string, entryId: string, add: boolean) => void;
  onCreateStrandWith: (title: string, entryId: string) => void;
  onAttachMedia: (entryId: string, file: File) => void;
  onRemoveMedia: (entryId: string, mediaId: string) => void;
  onSetMediaConfig: (entryId: string, mediaId: string, partial: MediaConfig) => void;
  getMediaUrl: (id: string) => Promise<string | null>;
};

const RECENT_WINDOW = 1000 * 60 * 60 * 6; // glow ticks from the last 6 hours

export function Stream({
  entries,
  totalCount,
  onReadDay,
  onSave,
  onDelete,
  onAnchor,
  strands,
  onToggleStrand,
  onCreateStrandWith,
  onAttachMedia,
  onRemoveMedia,
  onSetMediaConfig,
  getMediaUrl,
}: Props) {
  if (totalCount === 0) {
    return (
      <div className="empty">
        <div className="mark">⌇</div>
        <p>
          Nothing kept yet.
          <br />
          The next thought that drifts by — catch it above.
        </p>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="empty">
        <p>
          No thoughts match that.
          <br />
          Clear the search or tag to see everything.
        </p>
      </div>
    );
  }

  const groups = groupByDay(entries);
  const now = Date.now();

  return (
    <main className="stream" aria-live="polite">
      {groups.map((g) => (
        <section className="daygroup" key={g.key}>
          <div className="dayhead">
            <span className="label">{g.label}</span>
            <span className="rule" />
            {/* Read the day as one flowing piece. Entries reversed so the day
                reads forward in time (morning → night), not newest-first. */}
            {g.entries.length > 1 && (
              <button
                className="dayread"
                onClick={() => onReadDay([...g.entries].reverse(), g.label)}
                title="Read this day as one"
              >
                read
              </button>
            )}
          </div>
          {g.entries.map((e) => (
            <EntryItem
              key={e.id}
              entry={e}
              recent={now - e.createdAt < RECENT_WINDOW}
              onSave={onSave}
              onDelete={onDelete}
              onAnchor={onAnchor}
              strands={strands}
              onToggleStrand={onToggleStrand}
              onCreateStrandWith={onCreateStrandWith}
              onAttachMedia={onAttachMedia}
              onRemoveMedia={onRemoveMedia}
              onSetMediaConfig={onSetMediaConfig}
              getMediaUrl={getMediaUrl}
            />
          ))}
        </section>
      ))}
    </main>
  );
}
