// SharedView.tsx
// The "together" lens: strands co-authored with people you love, end-to-end
// encrypted. Each shared strand has its own key; the server only ever holds
// ciphertext. v1 is text pieces — you and the people you invite write into the
// same strand, and it's there when either of you visits. No pings, no badges.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SharedStrandView } from "../lib/journal";

type Props = {
  sharedStrands: SharedStrandView[];
  account: string | null;
  onCreate: (title: string) => Promise<string | null>;
  onInvite: (strandId: string, email: string) => Promise<string | null>;
  onWrite: (strandId: string, text: string) => Promise<string | null>;
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

  // Not signed in → sharing needs an account (it's how "whose ciphertext is
  // this?" is answered). The passphrase still isn't sent anywhere.
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
        strand={selected}
        onBack={() => setSelectedId(null)}
        onInvite={props.onInvite}
        onWrite={props.onWrite}
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
            const count = s.entryIds.filter((id) => s.pieces[id]).length;
            return (
              <li key={s.strandId}>
                <button className="strand-card" onClick={() => setSelectedId(s.strandId)}>
                  <span className="strand-card-title">
                    {s.title || "Untitled"}
                    {s.role === "owner" && <span className="share-badge">yours</span>}
                    {s.role !== "owner" && <span className="share-badge">shared with you</span>}
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

function SharedDetail({
  strand,
  onBack,
  onInvite,
  onWrite,
}: {
  strand: SharedStrandView;
  onBack: () => void;
  onInvite: (strandId: string, email: string) => Promise<string | null>;
  onWrite: (strandId: string, text: string) => Promise<string | null>;
}) {
  const [compose, setCompose] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteNote, setInviteNote] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ordered = useMemo(
    () => strand.entryIds.map((id) => strand.pieces[id]).filter(Boolean),
    [strand.entryIds, strand.pieces]
  );

  async function write() {
    const text = compose.trim();
    if (!text || busy) return;
    setBusy(true);
    setNote(null);
    const err = await onWrite(strand.strandId, text);
    setBusy(false);
    if (err) {
      setNote(err);
      return;
    }
    setCompose("");
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

  return (
    <main className="strands" aria-live="polite">
      <div className="strand-top">
        <button className="lock-link" onClick={onBack}>
          ‹ Shared
        </button>
        <div className="strand-top-actions">
          <button className="ghost-btn" onClick={() => setInviting((v) => !v)}>
            {inviting ? "Close" : "Invite"}
          </button>
        </div>
      </div>

      <h2 className="strand-title">{strand.title || "Untitled"}</h2>

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
        </div>
      )}

      <div className="strand-read" ref={scrollRef}>
        {ordered.length === 0 ? (
          <p className="strand-read-empty">
            Nothing here yet — write the first piece below, or invite someone to
            start it with you.
          </p>
        ) : (
          ordered.map((p) => (
            <div key={p.id} className="read-piece">
              <p>{p.text}</p>
            </div>
          ))
        )}
      </div>

      <div className="strand-compose">
        <textarea
          className="edit"
          placeholder="Write a piece into this shared strand…"
          value={compose}
          onChange={(e) => setCompose(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              write();
            }
          }}
        />
        <div className="edit-foot">
          <button className="save-btn" disabled={!compose.trim() || busy} onClick={write}>
            {busy ? "Adding…" : "Add piece"}
          </button>
          {note && <span className="share-error">{note}</span>}
        </div>
      </div>
    </main>
  );
}
