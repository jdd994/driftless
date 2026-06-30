// EntryItem.tsx
import { useState } from "react";
import {
  timeLabel,
  formatAnchor,
  parseAnchor,
  type Entry,
  type Anchor,
  type Strand,
} from "../lib/journal";

type Props = {
  entry: Entry;
  recent: boolean;
  displayTime?: string; // timeline view shows the anchor here instead of capture time
  onSave: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onAnchor: (id: string, anchor: Anchor | null) => void;
  // Optional: when provided, the entry can be added to / removed from strands.
  strands?: Strand[];
  onToggleStrand?: (strandId: string, entryId: string, add: boolean) => void;
  onCreateStrandWith?: (title: string, entryId: string) => void;
};

// Render text with #tags tinted, safely (React escapes by default).
function Body({ text }: { text: string }) {
  const parts = text.split(/(\s#[a-z0-9_-]{1,40})/gi);
  return (
    <>
      {parts.map((p, i) =>
        /^\s#[a-z0-9_-]+$/i.test(p) ? (
          <span key={i}>
            {p.charAt(0)}
            <span className="htag">{p.trim()}</span>
          </span>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

export function EntryItem({
  entry,
  recent,
  displayTime,
  onSave,
  onDelete,
  onAnchor,
  strands,
  onToggleStrand,
  onCreateStrandWith,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [anchoring, setAnchoring] = useState(false);
  const [anchorDraft, setAnchorDraft] = useState("");
  const [addingStrand, setAddingStrand] = useState(false);
  const [newStrand, setNewStrand] = useState("");
  const edited = entry.updatedAt !== entry.createdAt;
  const canStrand = strands && onToggleStrand && onCreateStrandWith;

  function createStrandWith() {
    const title = newStrand.trim();
    if (!title) return;
    onCreateStrandWith!(title, entry.id);
    setNewStrand("");
  }

  function commit() {
    const text = draft.trim();
    if (!text) {
      onDelete(entry.id);
    } else {
      onSave(entry.id, text);
    }
    setEditing(false);
  }

  function openAnchor() {
    setAnchorDraft(entry.anchor ? formatAnchor(entry.anchor) : "");
    setAnchoring(true);
  }

  function saveAnchor() {
    onAnchor(entry.id, parseAnchor(anchorDraft));
    setAnchoring(false);
  }

  const preview = parseAnchor(anchorDraft);

  return (
    <div className={"entry" + (recent ? " recent" : "")}>
      <span className="time">{displayTime ?? timeLabel(entry.createdAt)}</span>
      {editing ? (
        <>
          <textarea
            className="edit"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") {
                setDraft(entry.text);
                setEditing(false);
              }
            }}
          />
          <div className="edit-foot">
            <button className="save-btn" onClick={commit}>
              Save
            </button>
            <button
              className="ghost-btn"
              onClick={() => {
                setDraft(entry.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="body">
            <Body text={entry.text} />
          </div>

          {entry.anchor && !anchoring && !addingStrand && (
            <button className="anchor-chip" onClick={openAnchor} title="Edit when this happened">
              <span className="anchor-mark">⟡</span> {formatAnchor(entry.anchor)}
            </button>
          )}

          {addingStrand && canStrand ? (
            <div className="strand-add">
              <div className="strand-add-list">
                {strands!.length === 0 && (
                  <span className="strand-add-hint">No strands yet — name one below.</span>
                )}
                {strands!.map((s) => {
                  const inIt = s.entryIds.includes(entry.id);
                  return (
                    <button
                      key={s.id}
                      className={"chip strand-add-chip" + (inIt ? " active" : "")}
                      onClick={() => onToggleStrand!(s.id, entry.id, !inIt)}
                    >
                      {inIt ? "✓ " : ""}
                      {s.title || "Untitled"}
                    </button>
                  );
                })}
              </div>
              <input
                className="anchor-input"
                placeholder="…or start a new strand"
                value={newStrand}
                onChange={(e) => setNewStrand(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createStrandWith()}
              />
              <div className="edit-foot">
                <button className="ghost-btn" onClick={() => setAddingStrand(false)}>
                  Done
                </button>
              </div>
            </div>
          ) : anchoring ? (
            <div className="anchor-editor">
              <input
                className="anchor-input"
                autoFocus
                placeholder="When was this? — 1998, Jun 2015, or “childhood”"
                value={anchorDraft}
                onChange={(e) => setAnchorDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveAnchor();
                  if (e.key === "Escape") setAnchoring(false);
                }}
              />
              <div className="anchor-preview">
                {!preview
                  ? "Leave empty and save to remove the anchor."
                  : preview.time !== undefined
                  ? `→ ${formatAnchor(preview)} · placed on the timeline`
                  : `→ “${preview.label}” · an era (unplaced on the dated timeline)`}
              </div>
              <div className="edit-foot">
                <button className="save-btn" onClick={saveAnchor}>
                  Save
                </button>
                {entry.anchor && (
                  <button className="ghost-btn" onClick={() => { onAnchor(entry.id, null); setAnchoring(false); }}>
                    Remove
                  </button>
                )}
                <button className="ghost-btn" onClick={() => setAnchoring(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="meta">
              {edited && <span className="edited">edited</span>}
              <button className="act" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button className="act" onClick={openAnchor}>
                {entry.anchor ? "Re-place in time" : "Place in time"}
              </button>
              {canStrand && (
                <button className="act" onClick={() => setAddingStrand(true)}>
                  Add to strand
                </button>
              )}
              <button className="act del" onClick={() => onDelete(entry.id)}>
                Delete
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
