// db.ts
// Local-first storage. Everything lives in IndexedDB so a thought is saved
// instantly, with or without a network connection.
//
// Three stores:
//   - "vault": one record holding the salt + verifier (passphrase setup).
//   - "entries": one record per thought. Content is stored ONLY as ciphertext.
//     createdAt/updatedAt are kept in the clear so we can sort and group by
//     time without decrypting everything first. Each record also carries sync
//     bookkeeping (`deleted` tombstone + `dirty` outbox flag) — see SYNC_PLAN.md.
//   - "sync": one record of sync state (pull cursor + auth token). Unused until
//     the sync engine lands, but the store + migration exist now.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { CipherBlob } from "./crypto";

export const DB_VERSION = 5;

export type VaultMeta = {
  id: "vault";
  salt: number[];
  verifier: CipherBlob;
  createdAt: number;
  // PBKDF2 iteration count this vault's key was derived with. Stored so the
  // work factor can be raised for new vaults without locking out old ones.
  // Absent on vaults created before this field existed (treat as 250_000).
  iterations?: number;
  // Envelope encryption: the random data key (DEK), wrapped by the passphrase-
  // derived KEK. Present on vaults created or migrated under the envelope model;
  // ABSENT on older vaults (where the key was derived straight from the
  // passphrase) — those migrate on first unlock. Changing the passphrase re-wraps
  // this without re-encrypting any data. See crypto.ts wrapVaultKey.
  wrappedDEK?: CipherBlob;
};

export type StoredEntry = {
  id: string;
  createdAt: number;
  updatedAt: number;
  content: CipherBlob; // encrypted text
  // Sync bookkeeping (plaintext metadata, never secret):
  deleted: boolean; // tombstone — kept so a deletion can propagate on sync
  dirty: boolean; // has local changes not yet pushed to a server
};

// One-row store holding sync state. The token is an auth credential, NOT the
// encryption key — persisting it is fine (invariants #2 and #4).
export type SyncState = {
  id: "state";
  cursor: number; // highest server change-sequence pulled so far
  token?: string;
  accountEmail?: string;
};

// Per-device biometric enrollment: a passkey id + the vault key wrapped by its
// PRF secret. Device-local — never synced, never leaves this device.
export type DeviceEnrollment = {
  id: "device";
  credentialId: number[];
  prfSalt: number[];
  wrapped: CipherBlob;
};

// A named, ordered collection of entries. content encrypts { title, entryIds }.
// Mirrors StoredEntry's sync bookkeeping so it reconciles the same way.
export type StoredStrand = {
  id: string;
  createdAt: number;
  updatedAt: number;
  content: CipherBlob;
  deleted: boolean;
  dirty: boolean;
};

// An attached image, stored as encrypted raw bytes (local-first — not synced
// yet; that needs object storage, see SYNC_PLAN.md). `dirty`/`deleted` exist for
// when media sync lands.
export type StoredMedia = {
  id: string;
  type: string; // mime, e.g. image/jpeg
  createdAt: number;
  iv: Uint8Array;
  data: ArrayBuffer; // ciphertext
  deleted: boolean;
  dirty: boolean;
};

interface DriftlessDB extends DBSchema {
  vault: { key: string; value: VaultMeta };
  entries: { key: string; value: StoredEntry; indexes: { byCreated: number } };
  sync: { key: string; value: SyncState };
  device: { key: string; value: DeviceEnrollment };
  strands: { key: string; value: StoredStrand };
  media: { key: string; value: StoredMedia };
}

let dbPromise: Promise<IDBPDatabase<DriftlessDB>> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB<DriftlessDB>("driftless", DB_VERSION, {
      async upgrade(database, oldVersion, _newVersion, tx) {
        // v1: original vault + entries stores.
        if (oldVersion < 1) {
          database.createObjectStore("vault", { keyPath: "id" });
          const entries = database.createObjectStore("entries", { keyPath: "id" });
          entries.createIndex("byCreated", "createdAt");
        }
        // v2: add the sync store and backfill sync fields on existing entries.
        // Pre-v2 entries are marked dirty so they upload on first sync.
        if (oldVersion < 2) {
          database.createObjectStore("sync", { keyPath: "id" });
          let cursor = await tx.objectStore("entries").openCursor();
          while (cursor) {
            const v = cursor.value;
            if (v.deleted === undefined || v.dirty === undefined) {
              await cursor.update({
                ...v,
                deleted: v.deleted ?? false,
                dirty: v.dirty ?? true,
              });
            }
            cursor = await cursor.continue();
          }
        }
        // v3: per-device biometric enrollment store.
        if (oldVersion < 3) {
          database.createObjectStore("device", { keyPath: "id" });
        }
        // v4: strands (named, ordered collections).
        if (oldVersion < 4) {
          database.createObjectStore("strands", { keyPath: "id" });
        }
        // v5: media (encrypted image bytes, local-first).
        if (oldVersion < 5) {
          database.createObjectStore("media", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export async function getVault(): Promise<VaultMeta | undefined> {
  return (await db()).get("vault", "vault");
}

export async function saveVault(meta: VaultMeta): Promise<void> {
  await (await db()).put("vault", meta);
}

export async function allStoredEntries(): Promise<StoredEntry[]> {
  return (await db()).getAllFromIndex("entries", "byCreated");
}

export async function putStoredEntry(entry: StoredEntry): Promise<void> {
  await (await db()).put("entries", entry);
}

export async function deleteStoredEntry(id: string): Promise<void> {
  await (await db()).delete("entries", id);
}

export async function getSyncState(): Promise<SyncState | undefined> {
  return (await db()).get("sync", "state");
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await (await db()).put("sync", state);
}

export async function allStoredStrands(): Promise<StoredStrand[]> {
  return (await db()).getAll("strands");
}

export async function putStoredStrand(strand: StoredStrand): Promise<void> {
  await (await db()).put("strands", strand);
}

export async function getStoredEntry(id: string): Promise<StoredEntry | undefined> {
  return (await db()).get("entries", id);
}

export async function getStoredStrand(id: string): Promise<StoredStrand | undefined> {
  return (await db()).get("strands", id);
}

// Records needing upload (includes dirty tombstones).
export async function dirtyEntries(): Promise<StoredEntry[]> {
  return (await allStoredEntries()).filter((e) => e.dirty);
}
export async function dirtyStrands(): Promise<StoredStrand[]> {
  return (await allStoredStrands()).filter((s) => s.dirty);
}

// Clear the dirty flag after a successful push — but only if the record hasn't
// changed since we pushed it (updatedAt still matches), so we never drop an edit
// made mid-sync.
export async function clearEntryDirty(id: string, updatedAt: number): Promise<void> {
  const d = await db();
  const e = await d.get("entries", id);
  if (e && e.dirty && e.updatedAt === updatedAt) await d.put("entries", { ...e, dirty: false });
}
export async function clearStrandDirty(id: string, updatedAt: number): Promise<void> {
  const d = await db();
  const s = await d.get("strands", id);
  if (s && s.dirty && s.updatedAt === updatedAt) await d.put("strands", { ...s, dirty: false });
}

// Mark every local record dirty — used when connecting a NEW account, so the
// whole journal uploads even if it was previously synced to a different one.
export async function markAllDirty(): Promise<void> {
  const d = await db();
  for (const e of await d.getAll("entries")) if (!e.dirty) await d.put("entries", { ...e, dirty: true });
  for (const s of await d.getAll("strands")) if (!s.dirty) await d.put("strands", { ...s, dirty: true });
  for (const m of await d.getAll("media")) if (!m.dirty && !m.deleted) await d.put("media", { ...m, dirty: true });
}

export async function putMedia(media: StoredMedia): Promise<void> {
  await (await db()).put("media", media);
}
export async function getMedia(id: string): Promise<StoredMedia | undefined> {
  return (await db()).get("media", id);
}
export async function deleteMedia(id: string): Promise<void> {
  await (await db()).delete("media", id);
}

// Media needing upload to R2 (the encrypted image bytes). See MEDIA_PLAN.md.
export async function dirtyMedia(): Promise<StoredMedia[]> {
  return (await (await db()).getAll("media")).filter((m) => m.dirty && !m.deleted);
}
export async function clearMediaDirty(id: string): Promise<void> {
  const d = await db();
  const m = await d.get("media", id);
  if (m && m.dirty) await d.put("media", { ...m, dirty: false });
}

export async function getDevice(): Promise<DeviceEnrollment | undefined> {
  return (await db()).get("device", "device");
}

export async function saveDevice(enrollment: DeviceEnrollment): Promise<void> {
  await (await db()).put("device", enrollment);
}

export async function clearDevice(): Promise<void> {
  await (await db()).delete("device", "device");
}

// Restore a backup: write the vault and its entries in one transaction. Used on
// a fresh device (no existing vault). Entries are upserted by id, so re-running
// a restore is idempotent.
export async function importData(
  vault: VaultMeta,
  entries: StoredEntry[],
  strands: StoredStrand[]
): Promise<void> {
  const d = await db();
  const tx = d.transaction(["vault", "entries", "strands"], "readwrite");
  await tx.objectStore("vault").put(vault);
  const entryStore = tx.objectStore("entries");
  for (const e of entries) await entryStore.put(e);
  const strandStore = tx.objectStore("strands");
  for (const s of strands) await strandStore.put(s);
  await tx.done;
}
