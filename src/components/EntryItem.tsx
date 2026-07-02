// EntryItem.tsx
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  timeLabel,
  formatAnchor,
  parseAnchor,
  defaultTilt,
  type Entry,
  type Anchor,
  type Strand,
  type MediaConfig,
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
  // Optional: photo attachments.
  onAttachMedia?: (entryId: string, file: File) => void;
  onRemoveMedia?: (entryId: string, mediaId: string) => void;
  onSetMediaConfig?: (entryId: string, mediaId: string, partial: MediaConfig) => void;
  getMediaUrl?: (id: string) => Promise<string | null>;
};

// One attached photo: decrypts to an in-memory URL on mount. Shows a gentle
// note if the image lives on another device (media isn't synced yet).
export function MediaThumb({
  mediaId,
  getUrl,
  onRemove,
  config,
  onConfig,
}: {
  mediaId: string;
  getUrl: (id: string) => Promise<string | null>;
  onRemove?: () => void;
  config?: MediaConfig;
  onConfig?: (partial: MediaConfig) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let alive = true;
    getUrl(mediaId).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setGone(true);
    });
    return () => {
      alive = false;
    };
  }, [mediaId, getUrl]);

  const PRESET = { s: 150, m: 240, l: 340 } as const;
  const baseWidth = config?.width ?? (config?.size ? PRESET[config.size] : 240);
  const tilt = config?.tilt ?? defaultTilt(mediaId);
  const [dragW, setDragW] = useState<number | null>(null);
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  const width = dragW ?? baseWidth;
  const nudge = (delta: number) => onConfig?.({ tilt: Math.round((tilt + delta) * 10) / 10 });

  function onResizeDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { x: e.clientX, w: width };
    setDragW(width);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onResizeMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    setDragW(Math.max(90, Math.min(680, dragRef.current.w + (e.clientX - dragRef.current.x))));
  }
  function onResizeUp() {
    if (dragRef.current && dragW != null) onConfig?.({ width: Math.round(dragW) });
    dragRef.current = null;
    setDragW(null);
  }

  if (gone) return <div className="media-missing">Photo added on another device</div>;
  if (!url) return <div className="media-loading" />;

  return (
    <div
      className="media-thumb"
      style={{ transform: `rotate(${tilt}deg)`, width: `${width}px`, maxWidth: "100%" }}
    >
      <img src={url} alt="" loading="lazy" />
      {onRemove && (
        <button className="media-remove" onClick={onRemove} title="Remove photo" aria-label="Remove photo">
          ✕
        </button>
      )}
      {onConfig && (
        <>
          <div className="media-ctl">
            {(["s", "m", "l"] as const).map((sz) => (
              <button
                key={sz}
                className={"media-ctl-btn" + (Math.abs(width - PRESET[sz]) < 8 ? " on" : "")}
                onClick={() => onConfig({ width: PRESET[sz] })}
              >
                {sz.toUpperCase()}
              </button>
            ))}
            <span className="media-ctl-sep" />
            <button className="media-ctl-btn" onClick={() => nudge(-1.5)} title="Tilt left">↺</button>
            <button className="media-ctl-btn" onClick={() => onConfig({ tilt: 0 })} title="Straighten">▯</button>
            <button className="media-ctl-btn" onClick={() => nudge(1.5)} title="Tilt right">↻</button>
          </div>
          <div
            className="media-resize"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            title="Drag to resize"
            aria-hidden="true"
          />
        </>
      )}
    </div>
  );
}

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
  onAttachMedia,
  onRemoveMedia,
  onSetMediaConfig,
  getMediaUrl,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [anchoring, setAnchoring] = useState(false);
  const [anchorDraft, setAnchorDraft] = useState("");
  const [addingStrand, setAddingStrand] = useState(false);
  const [newStrand, setNewStrand] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const edited = entry.updatedAt !== entry.createdAt;
  const canStrand = strands && onToggleStrand && onCreateStrandWith;
  const media = entry.mediaIds ?? [];

  // Grow the edit box to fit the whole thought (up to ~60vh, then scroll), so
  // editing shows full context instead of a few cramped lines.
  function growEdit() {
    const ta = editRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.6) + "px";
  }
  useEffect(() => {
    if (editing) growEdit();
  }, [editing]);

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
            ref={editRef}
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              growEdit();
            }}
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

          {media.length > 0 && getMediaUrl && (
            <div className="media-grid">
              {media.map((mid) => (
                <MediaThumb
                  key={mid}
                  mediaId={mid}
                  getUrl={getMediaUrl}
                  onRemove={onRemoveMedia ? () => onRemoveMedia(entry.id, mid) : undefined}
                  config={entry.mediaConfig?.[mid]}
                  onConfig={
                    onSetMediaConfig ? (partial) => onSetMediaConfig(entry.id, mid, partial) : undefined
                  }
                />
              ))}
            </div>
          )}

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
              {onAttachMedia && (
                <>
                  <button className="act" onClick={() => mediaInputRef.current?.click()}>
                    Add photo
                  </button>
                  <input
                    ref={mediaInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onAttachMedia(entry.id, f);
                      e.target.value = "";
                    }}
                  />
                </>
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
