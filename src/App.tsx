// App.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useJournal } from "./hooks/useJournal";
import { useSettings } from "./hooks/useSettings";
import { allTags, filterEntries, toMarkdown, type Entry, type Strand } from "./lib/journal";
import { LockScreen } from "./components/LockScreen";
import { Capture } from "./components/Capture";
import { Toolbar } from "./components/Toolbar";
import { TagBar } from "./components/TagBar";
import { Stream } from "./components/Stream";
import { OnThisDay } from "./components/OnThisDay";
import { Reader } from "./components/Reader";
import { Timeline } from "./components/Timeline";
import { StrandsView } from "./components/StrandsView";
import { SharedView } from "./components/SharedView";
import { HelpSheet } from "./components/HelpSheet";
import { InstallHint } from "./components/InstallHint";
import { Settings } from "./components/Settings";
import { Toast, type ToastData } from "./components/Toast";

function Clock() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const now = new Date();
  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="clock">
      <span className="clock-date">{date} · </span>
      <span className="now">{time}</span>
    </div>
  );
}

const PENDING_INVITE_KEY = "driftless-pending-invite";

// If the app was opened via an invite link (`#join=<id>.<secret>`), capture it,
// stash it (so it survives first-run setup / unlock), and strip the secret from
// the URL so it isn't left in history or accidentally re-shared.
function readPendingInvite(): { inviteId: string; secret: string } | null {
  try {
    const m = /^#join=([^.]+)\.(.+)$/.exec(location.hash);
    if (m) {
      const pi = { inviteId: m[1], secret: m[2] };
      localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify(pi));
      history.replaceState(null, "", location.pathname + location.search);
      return pi;
    }
    const stored = localStorage.getItem(PENDING_INVITE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const j = useJournal();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [view, setView] = useState<"stream" | "timeline" | "strands" | "shared">("stream");
  const [help, setHelp] = useState<null | "top" | "support">(null);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<ToastData>(null);
  const [veil, setVeil] = useState(0);
  const [reading, setReading] = useState<{ entries: Entry[]; label: string } | null>(null);
  const [pendingInvite, setPendingInvite] = useState(() => readPendingInvite());
  const toastTimer = useRef<number | null>(null);
  const joiningRef = useRef(false);
  const settings = useSettings();

  // Once we're open and connected, redeem any pending invite link and land the
  // person in the strand. If they're set up but haven't connected an account, a
  // banner (below) points them to it; the invite waits until then.
  useEffect(() => {
    if (!pendingInvite || j.vaultState !== "open" || !j.account || joiningRef.current) return;
    joiningRef.current = true;
    (async () => {
      const err = await j.joinViaInvite(pendingInvite.inviteId, pendingInvite.secret);
      joiningRef.current = false;
      localStorage.removeItem(PENDING_INVITE_KEY);
      setPendingInvite(null);
      if (err) {
        showToast({ msg: err });
      } else {
        setView("shared");
        showToast({ msg: "You've joined the shared strand." });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInvite, j.vaultState, j.account]);

  // Auto night-dimming: warm veil follows the local clock — 0 at midday,
  // deepest around 1am — so the app is never harsh at 3am. Off when disabled.
  useEffect(() => {
    if (!settings.nightDim) {
      setVeil(0);
      return;
    }
    const compute = () => {
      const now = new Date();
      const h = now.getHours() + now.getMinutes() / 60;
      const dayness = Math.cos(((h - 13) / 24) * 2 * Math.PI); // 1 at 13:00, -1 at 1:00
      setVeil(Math.max(0, (0.14 * (1 - dayness)) / 2));
    };
    compute();
    const id = window.setInterval(compute, 5 * 60 * 1000);
    const onVis = () => document.visibilityState === "visible" && compute();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [settings.nightDim]);

  function showToast(data: ToastData) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(data);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  }

  const tags = useMemo(() => allTags(j.entries), [j.entries]);
  const visible = useMemo(
    () => filterEntries(j.entries, query, tag),
    [j.entries, query, tag]
  );

  // Keep tag filter valid if the underlying tag disappears.
  useEffect(() => {
    if (tag && !tags.includes(tag)) setTag(null);
  }, [tags, tag]);

  // A failed save must never be silent — surface it with a retry.
  useEffect(() => {
    if (j.saveError) {
      showToast({
        msg: j.saveError.message,
        action: { label: "Retry", fn: j.saveError.retry },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j.saveError]);

  if (j.vaultState === "loading") {
    return (
      <div className="wrap">
        <div className="empty">
          <p>Opening…</p>
        </div>
      </div>
    );
  }

  if (j.vaultState !== "open") {
    return (
      <LockScreen
        mode={j.vaultState}
        enrolled={j.bioEnrolled}
        onCreate={j.createVault}
        onUnlock={j.unlock}
        onBiometric={j.biometricUnlock}
        onRestore={j.restoreBackup}
        onSignIn={j.connectSignIn}
      />
    );
  }

  function handleDelete(id: string) {
    const removed = j.entries.find((e) => e.id === id);
    if (!removed) return;
    j.removeEntry(removed);
    showToast({
      msg: "Thought removed.",
      action: { label: "Undo", fn: () => j.restoreEntry(removed) },
    });
  }

  function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const today = () => new Date().toISOString().slice(0, 10);

  function handleExport() {
    if (j.entries.length === 0) {
      showToast({ msg: "Nothing to export yet." });
      return;
    }
    download(
      new Blob([toMarkdown(j.entries)], { type: "text/markdown" }),
      "journal-" + today() + ".md"
    );
  }

  async function handleBiometricToggle() {
    if (j.bioEnrolled) {
      await j.disableBiometric();
      showToast({ msg: "Quick unlock turned off for this device." });
    } else {
      const ok = await j.enableBiometric();
      showToast({
        msg: ok
          ? "Quick unlock is on for this device."
          : "This device can't set up quick unlock — your passphrase still works.",
      });
    }
  }

  function handleToggleStrand(strandId: string, entryId: string, add: boolean) {
    if (add) j.addToStrand(strandId, entryId);
    else j.removeFromStrand(strandId, entryId);
  }

  async function handleCreateStrandWith(title: string, entryId: string) {
    const s = await j.createStrand(title);
    j.addToStrand(s.id, entryId);
    showToast({ msg: `Added to “${s.title || "Untitled"}”.` });
  }

  function handleExportStrand(strand: Strand, ordered: Entry[]) {
    let md = `# ${strand.title || "Untitled"}\n\n`;
    for (const e of ordered) md += `${e.text}\n\n`;
    download(new Blob([md], { type: "text/markdown" }), "strand-" + today() + ".md");
  }

  async function handleBackup() {
    const backup = await j.exportBackup();
    if (!backup || backup.entries.length === 0) {
      showToast({ msg: "Nothing to back up yet." });
      return;
    }
    download(
      new Blob([JSON.stringify(backup)], { type: "application/json" }),
      "driftless-backup-" + today() + ".json"
    );
    showToast({ msg: "Backup saved. Keep it somewhere safe." });
  }

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          Driftless<span className="dot">.</span>
        </div>
        <div className="top-right">
          <Clock />
          <button
            className="lock-link help-link"
            onClick={() => setHelp("top")}
            title="How Driftless works"
            aria-label="Help"
          >
            ?
          </button>
          <button
            className="lock-link heart-link"
            onClick={() => setHelp("support")}
            title="Support Driftless"
            aria-label="Support Driftless"
          >
            ♡
          </button>
          <button
            className="lock-link gear-link"
            onClick={() => setShowSettings(true)}
            title="Set the mood"
            aria-label="Settings"
          >
            ⚙
          </button>
          {j.bioSupported && (
            <button
              className="lock-link"
              onClick={handleBiometricToggle}
              title="Biometric unlock for this device"
            >
              {j.bioEnrolled ? "Quick unlock on" : "Quick unlock"}
            </button>
          )}
          <button className="lock-link" onClick={j.lock} title="Lock the journal">
            Lock
          </button>
        </div>
      </header>

      <InstallHint />

      {pendingInvite && !j.account && (
        <div className="join-banner">
          <span>You've been invited to a shared strand. Connect an account to join it.</span>
          <button className="install-btn" onClick={() => setShowSettings(true)}>
            Connect
          </button>
        </div>
      )}

      <Capture onKeep={j.addEntry} />

      <div className="viewtabs" role="tablist">
        <button
          role="tab"
          aria-selected={view === "stream"}
          className={"viewtab" + (view === "stream" ? " active" : "")}
          onClick={() => setView("stream")}
        >
          Stream
        </button>
        <button
          role="tab"
          aria-selected={view === "timeline"}
          className={"viewtab" + (view === "timeline" ? " active" : "")}
          onClick={() => setView("timeline")}
        >
          Timeline
        </button>
        <button
          role="tab"
          aria-selected={view === "strands"}
          className={"viewtab" + (view === "strands" ? " active" : "")}
          onClick={() => setView("strands")}
        >
          Strands
        </button>
        <button
          role="tab"
          aria-selected={view === "shared"}
          className={"viewtab" + (view === "shared" ? " active" : "")}
          onClick={() => setView("shared")}
        >
          Shared
        </button>
      </div>

      {view === "stream" && (
        <>
          {!query && !tag && <OnThisDay entries={j.entries} />}
          <Toolbar
            query={query}
            onQuery={setQuery}
            onExport={handleExport}
            onBackup={handleBackup}
          />
          <TagBar
            tags={tags}
            active={tag}
            onToggle={(t) => setTag((cur) => (cur === t ? null : t))}
          />
          <Stream
            entries={visible}
            totalCount={j.entries.length}
            onReadDay={(entries, label) => setReading({ entries, label })}
            onSave={j.updateEntry}
            onDelete={handleDelete}
            onAnchor={j.setAnchor}
            strands={j.strands}
            onToggleStrand={handleToggleStrand}
            onCreateStrandWith={handleCreateStrandWith}
            onAttachMedia={j.attachMedia}
            onRemoveMedia={j.removeMedia}

            onSetMediaConfig={j.setMediaConfig}
            getMediaUrl={j.getMediaUrl}
          />
        </>
      )}

      {view === "timeline" && (
        <Timeline
          entries={j.entries}
          onSave={j.updateEntry}
          onDelete={handleDelete}
          onAnchor={j.setAnchor}
          strands={j.strands}
          onToggleStrand={handleToggleStrand}
          onCreateStrandWith={handleCreateStrandWith}
          onAttachMedia={j.attachMedia}
          onRemoveMedia={j.removeMedia}

          onSetMediaConfig={j.setMediaConfig}
          getMediaUrl={j.getMediaUrl}
        />
      )}

      {view === "strands" && (
        <StrandsView
          strands={j.strands}
          entries={j.entries}
          onCreate={j.createStrand}
          onRename={j.renameStrand}
          onDelete={j.deleteStrand}
          onAddTo={j.addToStrand}
          onRemoveFrom={j.removeFromStrand}
          onReorder={j.reorderStrand}
          onWriteIn={j.writeInStrand}
          onAddPhoto={j.addPhotoToStrand}
          onSaveEntry={j.updateEntry}
          onDeleteEntry={handleDelete}
          onAnchor={j.setAnchor}
          onExport={handleExportStrand}
          onAttachMedia={j.attachMedia}
          onRemoveMedia={j.removeMedia}

          onSetMediaConfig={j.setMediaConfig}
          getMediaUrl={j.getMediaUrl}
        />
      )}

      {view === "shared" && (
        <SharedView
          sharedStrands={j.sharedStrands}
          account={j.account}
          myUserId={j.myUserId}
          onCreate={j.createSharedStrand}
          onInvite={j.inviteToSharedStrand}
          onAddPiece={j.addSharedPiece}
          onEditPiece={j.editSharedPiece}
          onReorder={j.reorderSharedStrand}
          onMediaUrl={j.getSharedMediaUrl}
          onRename={j.renameSharedStrand}
          onDeletePiece={j.deleteSharedPiece}
          onMembers={j.fetchStrandMembers}
          onRemoveMember={j.removeSharedMember}
          onLeave={j.leaveSharedStrand}
          onCreateLink={j.createInviteLink}
          onRefresh={j.refreshShared}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
      {reading && (
        <Reader
          title={reading.label}
          subtitle={reading.entries.length + (reading.entries.length === 1 ? " thought" : " thoughts")}
          entries={reading.entries}
          onClose={() => setReading(null)}
        />
      )}
      {help && <HelpSheet focus={help} onClose={() => setHelp(null)} />}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          mood={settings.mood}
          onMood={settings.setMood}
          nightDim={settings.nightDim}
          onNightDim={settings.setNightDim}
          account={j.account}
          onCreateAccount={j.connectCreateAccount}
          onDisconnect={j.disconnectAccount}
          onDeleteAccount={j.deleteAccount}
          onSyncNow={j.syncNow}
          onChangePassphrase={j.changePassphrase}
        />
      )}
      <div className="night-veil" style={{ opacity: veil }} aria-hidden="true" />
    </div>
  );
}
