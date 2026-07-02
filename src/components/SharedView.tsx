// SharedView.tsx
// The "together" lens: strands co-authored with people you love, end-to-end
// encrypted. Each shared strand has its own key; the server only ever holds
// ciphertext. Now closer to personal strands — write pieces with words and
// photos together, edit them, arrange them, read them as one. No pings, no
// badges; it's there when someone visits.
import { useEffect, useMemo, useRef, useState } from "react";
import { sharedPieces, type SharedStrandView, type SharedPiece } from "../lib/journal";
import type { StrandMember } from "../lib/api";
import { MediaThumb } from "./EntryItem";

type Props = {
  sharedStrands: SharedStrandView[];
  account: string | null;
  myUserId: string | null;
  onCreate: (title: string) => Promise<string | null>;
  onInvite: (strandId: string, email: string) => Promise<string | null>;
  onAddPiece: (strandId: string, text: string, files: File[]) => Promise<string | null>;
  onEditPiece: (strandId: string, pieceId: string, text: string) => Promise<string | null>;
  onReorder: (strandId: string, entryIds: string[]) => Promise<string | null>;
  onMediaUrl: (strandId: string, mediaId: string) => Promise<string | null>;
  onRename: (strandId: string, title: string) => Promise<string | null>;
  onDeletePiece: (strandId: string, pieceId: string) => Promise<string | null>;
  onMembers: (strandId: string) => Promise<StrandMember[]>;
  onRemoveMember: (strandId: string, userId: string) => Promise<string | null>;
  onLeave: (strandId: string) => Promise<string | null>;
  onCreateLink: (strandId: string) => Promise<{ link: string } | { error: string }>;
  onRefresh: () => void;
};

export function SharedView(props: Props) {
  const { sharedStrands, account, onRefresh } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull the latest whenever this lens opens (it's server-backed, not local).
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const selected = sharedStrands.find((s) => s.strandId === selectedId) ?? null;

  async function create() {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    const err = await props.onCreate(title);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setNewTitle("");
  }

  if (!account) {
    return (
      <main className="strands" aria-live="polite">
        <div className="empty">
          <div className="mark">❋</div>
          <p>
            Shared strands are woven with others.
            <br />
            Connect an account in Settings (⚙) first — then you can share a strand
            with someone by email, and write it together.
          </p>
        </div>
      </main>
    );
  }

  if (selected) {
    return (
      <SharedDetail
        {...props}
        strand={selected}
        onBack={() => setSelectedId(null)}
        onLeave={async (id) => {
          const err = await props.onLeave(id);
          if (!err) setSelectedId(null);
          return err;
        }}
      />
    );
  }

  return (
    <main className="strands" aria-live="polite">
      <div className="strand-new">
        <input
          className="anchor-input"
          placeholder="Name a strand to share — “Our summer”, “Grandpa's stories”…"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <button className="save-btn" disabled={!newTitle.trim() || busy} onClick={create}>
          {busy ? "…" : "Start"}
        </button>
      </div>
      {error && <p className="share-error">{error}</p>}

      {sharedStrands.length === 0 ? (
        <div className="empty">
          <div className="mark">❋</div>
          <p>
            No shared strands yet.
            <br />
            Start one, then invite someone by email — you'll write it together,
            and only the two of you can read it.
          </p>
        </div>
      ) : (
        <ul className="strand-list">
          {sharedStrands.map((s) => {
            const count = sharedPieces(s).length;
            return (
              <li key={s.strandId}>
                <button className="strand-card" onClick={() => setSelectedId(s.strandId)}>
                  <span className="strand-card-title">
                    {s.title || "Untitled"}
                    <span className="share-badge">{s.role === "owner" ? "yours" : "shared with you"}</span>
                  </span>
                  <span className="strand-card-count">
                    {count} {count === 1 ? "piece" : "pieces"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

type DetailProps = Omit<Props, "sharedStrands" | "account" | "onCreate" | "onRefresh"> & {
  strand: SharedStrandView;
  onBack: () => void;
};

function SharedDetail({
  strand,
  myUserId,
  onBack,
  onInvite,
  onAddPiece,
  onEditPiece,
  onReorder,
  onMediaUrl,
  onRename,
  onDeletePiece,
  onCreateLink,
  onMembers,
  onRemoveMember,
  onLeave,
}: DetailProps) {
  const isOwner = strand.role === "owner";
  const ordered = useMemo(() => sharedPieces(strand), [strand]);
  // You can edit/delete your own pieces; the owner can manage any. (A piece with
  // no recorded author is a legacy one — only the owner touches those.)
  const canEdit = (p: SharedPiece) => isOwner || (!!myUserId && p.author === myUserId);

  // compose
  const [compose, setCompose] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const composePhotoRef = useRef<HTMLInputElement>(null);

  // view + editing
  const [reading, setReading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // title
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(strand.title);

  // invite + link
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteNote, setInviteNote] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  // members
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState<StrandMember[] | null>(null);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberNote, setMemberNote] = useState<string | null>(null);

  async function addPiece() {
    if ((!compose.trim() && files.length === 0) || busy) return;
    setBusy(true);
    setNote(null);
    const err = await onAddPiece(strand.strandId, compose, files);
    setBusy(false);
    if (err) {
      setNote(err);
      return;
    }
    setCompose("");
    setFiles([]);
  }

  function move(index: number, dir: -1 | 1) {
    const ids = ordered.map((p) => p.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    onReorder(strand.strandId, ids);
  }

  async function deletePiece(pieceId: string) {
    if (!confirm("Remove this from the strand? This can't be undone.")) return;
    const err = await onDeletePiece(strand.strandId, pieceId);
    if (err) setNote(err);
  }

  function startEdit(p: SharedPiece) {
    setEditingId(p.id);
    setEditDraft(p.text);
  }
  async function saveEdit(p: SharedPiece) {
    setEditingId(null);
    if (editDraft.trim() !== p.text) {
      const err = await onEditPiece(strand.strandId, p.id, editDraft);
      if (err) setNote(err);
    }
  }

  function saveTitle() {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft.trim() !== strand.title) onRename(strand.strandId, titleDraft);
  }

  async function invite() {
    const em = email.trim();
    if (!em || inviteBusy) return;
    setInviteBusy(true);
    setInviteNote(null);
    const err = await onInvite(strand.strandId, em);
    setInviteBusy(false);
    if (err) {
      setInviteNote(err);
      return;
    }
    setEmail("");
    setInviteNote(`Shared with ${em}. It'll appear for them when they open Driftless.`);
  }
  async function createLink() {
    setLinkBusy(true);
    setLinkErr(null);
    const res = await onCreateLink(strand.strandId);
    setLinkBusy(false);
    if ("error" in res) setLinkErr(res.error);
    else setLink(res.link);
  }
  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — link is visible to copy by hand */
    }
  }
  async function shareLink() {
    if (!link) return;
    try {
      await navigator.share({ text: "Join me in a shared journal on Driftless:", url: link });
    } catch {
      /* dismissed */
    }
  }

  async function toggleMembers() {
    const next = !showMembers;
    setShowMembers(next);
    if (next && members === null) setMembers(await onMembers(strand.strandId));
  }
  async function remove(m: StrandMember) {
    if (!confirm(`Remove ${m.email}? The strand will be re-keyed so they can't read anything added afterwards.`)) return;
    setMemberBusy(true);
    setMemberNote(null);
    const err = await onRemoveMember(strand.strandId, m.userId);
    setMemberBusy(false);
    if (err) {
      setMemberNote(err);
      return;
    }
    setMembers(await onMembers(strand.strandId));
  }
  async function leave() {
    if (!confirm("Leave this strand? You'll no longer see it or its updates.")) return;
    setMemberBusy(true);
    setMemberNote(null);
    const err = await onLeave(strand.strandId);
    setMemberBusy(false);
    if (err) setMemberNote(err);
  }

  const photos = (p: SharedPiece) =>
    p.mediaIds && p.mediaIds.length > 0 ? (
      <div className="media-grid">
        {p.mediaIds.map((mid) => (
          <MediaThumb key={mid} mediaId={mid} getUrl={(id) => onMediaUrl(strand.strandId, id)} />
        ))}
      </div>
    ) : null;

  return (
    <main className="strands" aria-live="polite">
      <div className="strand-top">
        <button className="lock-link" onClick={onBack}>
          ‹ Shared
        </button>
        <div className="strand-top-actions">
          <button className="ghost-btn" onClick={() => setReading((r) => !r)}>
            {reading ? "Arrange" : "Read"}
          </button>
          <button className="ghost-btn" onClick={toggleMembers}>
            {showMembers ? "Close" : "People"}
          </button>
          <button className="ghost-btn" onClick={() => setInviting((v) => !v)}>
            {inviting ? "Close" : "Invite"}
          </button>
        </div>
      </div>

      {editingTitle && isOwner ? (
        <input
          className="anchor-input strand-title-input"
          autoFocus
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === "Enter" && saveTitle()}
        />
      ) : (
        <h2
          className="strand-title"
          title={isOwner ? "Rename" : undefined}
          onClick={() => {
            if (!isOwner) return;
            setTitleDraft(strand.title);
            setEditingTitle(true);
          }}
        >
          {strand.title || "Untitled"}
        </h2>
      )}

      {showMembers && (
        <div className="share-invite">
          {members === null ? (
            <p className="share-hint">Loading…</p>
          ) : (
            <ul className="member-list">
              {members.map((m) => (
                <li key={m.userId} className="member-row">
                  <span className="member-email">{m.email}</span>
                  <span className="member-role">{m.role === "owner" ? "owner" : "member"}</span>
                  {isOwner && m.role !== "owner" && (
                    <button className="act member-remove" disabled={memberBusy} onClick={() => remove(m)}>
                      {memberBusy ? "…" : "Remove"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!isOwner && (
            <button className="ghost-btn" disabled={memberBusy} onClick={leave}>
              Leave this strand
            </button>
          )}
          {memberNote && <p className="share-error">{memberNote}</p>}
          {isOwner && (
            <p className="share-hint">
              Removing someone re-keys the strand, so they can't read anything added
              afterward. What they've already seen, they've seen.
            </p>
          )}
        </div>
      )}

      {inviting && (
        <div className="share-invite">
          <input
            className="anchor-input"
            type="email"
            autoFocus
            placeholder="Their email (they need a Driftless account)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && invite()}
          />
          <button className="save-btn" disabled={!email.trim() || inviteBusy} onClick={invite}>
            {inviteBusy ? "…" : "Share"}
          </button>
          {inviteNote && <p className="share-error">{inviteNote}</p>}
          <p className="share-hint">
            Only people you invite can read this. It's encrypted end-to-end — the
            server can't.
          </p>

          <div className="share-or">— or share a link —</div>
          {!link ? (
            <button className="ghost-btn" onClick={createLink} disabled={linkBusy}>
              {linkBusy ? "Making a link…" : "Create an invite link"}
            </button>
          ) : (
            <div className="share-link-box">
              <input className="anchor-input share-link-input" readOnly value={link} onFocus={(e) => e.target.select()} />
              <div className="share-link-actions">
                <button className="save-btn" onClick={copyLink}>
                  {copied ? "Copied ✓" : "Copy link"}
                </button>
                {canShare && (
                  <button className="ghost-btn" onClick={shareLink}>
                    Share…
                  </button>
                )}
              </div>
              <p className="share-hint">
                Anyone with this link can join, so send it privately (a text, in
                person). It works for 7 days.
              </p>
            </div>
          )}
          {linkErr && <p className="share-error">{linkErr}</p>}
        </div>
      )}

      {reading ? (
        <div className="strand-read">
          {ordered.length === 0 ? (
            <p className="strand-read-empty">Nothing here yet.</p>
          ) : (
            ordered.map((p) => (
              <div key={p.id} className="read-piece">
                {p.text && <p>{p.text}</p>}
                {photos(p)}
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          {ordered.length === 0 && (
            <p className="strand-read-empty">
              Nothing here yet — write the first piece below, or invite someone to
              start it with you.
            </p>
          )}
          {ordered.map((p, i) => (
            <div key={p.id} className="strand-piece">
              <div className="strand-piece-ctl">
                {isOwner && (
                  <>
                    <button className="act" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                      ↑
                    </button>
                    <button className="act" disabled={i === ordered.length - 1} onClick={() => move(i, 1)} title="Move down">
                      ↓
                    </button>
                  </>
                )}
                {canEdit(p) && (
                  <button className="act" onClick={() => deletePiece(p.id)} title="Remove from strand">
                    ✕
                  </button>
                )}
              </div>
              <div className="shared-piece-body">
                {editingId === p.id ? (
                  <textarea
                    className="edit"
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onBlur={() => saveEdit(p)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        saveEdit(p);
                      }
                    }}
                  />
                ) : (
                  p.text &&
                  (canEdit(p) ? (
                    <p className="shared-piece-text" title="Tap to edit" onClick={() => startEdit(p)}>
                      {p.text}
                    </p>
                  ) : (
                    <p>{p.text}</p>
                  ))
                )}
                {photos(p)}
              </div>
            </div>
          ))}

          <div className="strand-compose">
            <textarea
              className="edit"
              placeholder="Write a piece — words, a photo, or both…"
              value={compose}
              onChange={(e) => setCompose(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  addPiece();
                }
              }}
            />
            <div className="edit-foot">
              <button className="save-btn" disabled={(!compose.trim() && files.length === 0) || busy} onClick={addPiece}>
                {busy ? "Adding…" : "Add piece"}
              </button>
              <button className="ghost-btn" onClick={() => composePhotoRef.current?.click()}>
                ＋ Photo
              </button>
              {files.length > 0 && (
                <span className="compose-photos">
                  {files.length} photo{files.length === 1 ? "" : "s"} ready
                  <button className="act" title="Clear photos" onClick={() => setFiles([])}>
                    ✕
                  </button>
                </span>
              )}
              <input
                ref={composePhotoRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  const fs = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (fs.length) setFiles((prev) => [...prev, ...fs]);
                }}
              />
              {note && <span className="share-error">{note}</span>}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
