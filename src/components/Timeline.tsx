// Timeline.tsx
// The "lived time" lens: thoughts that have been given an anchor, arranged by
// when they happened (not when they were written). Dated anchors group by year,
// ascending; era-labelled anchors collect at the end as "unplaced".
import { timelineGroups, type Entry, type Anchor, type Strand, type MediaConfig } from "../lib/journal";
import { EntryItem } from "./EntryItem";

type Props = {
  entries: Entry[];
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

export function Timeline({
  entries,
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
  const { dated, undated } = timelineGroups(entries);

  if (dated.length === 0 && undated.length === 0) {
    return (
      <div className="empty">
        <div className="mark">⟡</div>
        <p>
          Nothing placed in time yet.
          <br />
          Open a thought and “Place in time” to set when it happened.
        </p>
      </div>
    );
  }

  return (
    <main className="stream timeline" aria-live="polite">
      {dated.map((g) => (
        <section className="daygroup" key={g.key}>
          <div className="dayhead">
            <span className="label">{g.label}</span>
            <span className="rule" />
          </div>
          {g.entries.map((e) => (
            <EntryItem
              key={e.id}
              entry={e}
              recent={false}
              displayTime=""
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

      {undated.length > 0 && (
        <section className="daygroup">
          <div className="dayhead">
            <span className="label">Unplaced eras</span>
            <span className="rule" />
          </div>
          {undated.map((e) => (
            <EntryItem
              key={e.id}
              entry={e}
              recent={false}
              displayTime=""
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
      )}
    </main>
  );
}
