// sync.ts
// The reconcile engine. Moves ciphertext between the device and the server —
// it never needs the passphrase or key (that's the point of the design in
// SYNC_PLAN.md). Pull applies remote records with last-write-wins by updatedAt;
// push uploads dirty records. Strands and entries flow through one path.
import { pushChanges, pullChanges, uploadMedia, type SyncRecord } from "./api";
import {
  dirtyEntries,
  dirtyStrands,
  dirtyMedia,
  clearEntryDirty,
  clearStrandDirty,
  clearMediaDirty,
  getStoredEntry,
  getStoredStrand,
  putStoredEntry,
  putStoredStrand,
  getSyncState,
  saveSyncState,
  type StoredEntry,
  type StoredStrand,
} from "./db";

const entryToRecord = (e: StoredEntry): SyncRecord => ({
  kind: "entry",
  id: e.id,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
  deleted: e.deleted,
  content: e.content,
});
const strandToRecord = (s: StoredStrand): SyncRecord => ({
  kind: "strand",
  id: s.id,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  deleted: s.deleted,
  content: s.content,
});

// Apply one remote record locally, last-write-wins. Returns true if it changed
// anything (so the caller knows to refresh the decrypted view).
async function applyRemote(rec: SyncRecord): Promise<boolean> {
  if (rec.kind === "entry") {
    const local = await getStoredEntry(rec.id);
    if (local && rec.updatedAt <= local.updatedAt) return false;
    await putStoredEntry({
      id: rec.id,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      content: rec.content,
      deleted: rec.deleted,
      dirty: false,
    });
    return true;
  }
  const local = await getStoredStrand(rec.id);
  if (local && rec.updatedAt <= local.updatedAt) return false;
  await putStoredStrand({
    id: rec.id,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    content: rec.content,
    deleted: rec.deleted,
    dirty: false,
  });
  return true;
}

// Pull everything past the cursor, apply it, advance the cursor. Returns true
// if any local data actually changed.
export async function pull(token: string): Promise<boolean> {
  const st = await getSyncState();
  let cursor = st?.cursor ?? 0;
  let changed = false;
  for (;;) {
    const res = await pullChanges(token, cursor);
    for (const rec of res.changes) {
      if (await applyRemote(rec)) changed = true;
    }
    cursor = res.cursor;
    if (!res.more) break;
  }
  await saveSyncState({ ...(st ?? { id: "state" }), id: "state", cursor, token });
  return changed;
}

// Upload dirty records, then clear their flags.
export async function push(token: string): Promise<void> {
  const entries = await dirtyEntries();
  const strands = await dirtyStrands();
  const changes = [...entries.map(entryToRecord), ...strands.map(strandToRecord)];
  if (changes.length === 0) return;
  // Chunk to stay under the server's per-push cap.
  for (let i = 0; i < changes.length; i += 500) {
    await pushChanges(token, changes.slice(i, i + 500));
  }
  for (const e of entries) await clearEntryDirty(e.id, e.updatedAt);
  for (const s of strands) await clearStrandDirty(s.id, s.updatedAt);
}

// Upload dirty photo blobs (already encrypted) to R2, clearing each flag on
// success. Best-effort per item — one failure leaves that photo dirty to retry
// and never blocks the rest.
export async function pushMedia(token: string): Promise<void> {
  for (const m of await dirtyMedia()) {
    try {
      await uploadMedia(token, m.id, m.iv, m.data, m.type);
      await clearMediaDirty(m.id);
    } catch {
      // leave dirty; a later sync retries
    }
  }
}

// Full sync. Pull first (get others' changes), then push local dirty. Returns
// true if the pull changed local data (caller should re-decrypt the view).
export async function syncNow(token: string): Promise<boolean> {
  const changed = await pull(token);
  await push(token);
  await pushMedia(token);
  return changed;
}
