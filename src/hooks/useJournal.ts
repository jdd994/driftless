// useJournal.ts
// The one stateful brain of the app. Holds the in-memory (decrypted) entries
// and the session key, and exposes actions. Nothing here persists plaintext.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deriveKeyFromSalt,
  makeVerifier,
  checkVerifier,
  encryptString,
  decryptString,
  newSalt,
  exportKeyRaw,
  importKeyRaw,
  PBKDF2_ITERATIONS,
} from "../lib/crypto";
import {
  biometricSupported,
  enrollBiometric,
  unlockBiometric,
} from "../lib/biometric";
import {
  getVault,
  saveVault,
  allStoredEntries,
  putStoredEntry,
  allStoredStrands,
  putStoredStrand,
  importData,
  getDevice,
  saveDevice,
  clearDevice,
  type StoredEntry,
  type StoredStrand,
  type VaultMeta,
} from "../lib/db";
import {
  uid,
  encodePayload,
  decodePayload,
  encodeStrand,
  decodeStrand,
  type Entry,
  type Anchor,
  type Strand,
} from "../lib/journal";
import { buildBackup, type Backup } from "../lib/backup";

export type SaveError = { message: string; retry: () => void } | null;

export type VaultState = "loading" | "needs-setup" | "locked" | "open";

export function useJournal() {
  const [vaultState, setVaultState] = useState<VaultState>("loading");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [strands, setStrands] = useState<Strand[]>([]);
  const [saveError, setSaveError] = useState<SaveError>(null);
  const [bioSupported, setBioSupported] = useState(false);
  const [bioEnrolled, setBioEnrolled] = useState(false);
  const keyRef = useRef<CryptoKey | null>(null);

  // Decide on first paint whether we need setup or unlock.
  useEffect(() => {
    getVault().then((v) => setVaultState(v ? "locked" : "needs-setup"));
    biometricSupported().then(setBioSupported);
    getDevice().then((d) => setBioEnrolled(!!d));
  }, []);

  // Ask the browser to make this origin's storage persistent so the journal
  // isn't silently evicted under storage pressure (notably on iOS Safari,
  // which can clear IndexedDB after a stretch of non-use). Best-effort: it may
  // be denied, but for an installed PWA it's typically granted. Called once a
  // vault exists, so we only prompt when there's something worth keeping.
  const requestDurableStorage = useCallback(async () => {
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    } catch {
      // Older browsers / private mode may not support it — nothing to do.
    }
  }, []);

  const loadEntries = useCallback(async (key: CryptoKey) => {
    const stored = await allStoredEntries();
    const decrypted: Entry[] = [];
    for (const s of stored) {
      if (s.deleted) continue; // tombstones aren't shown
      try {
        const { text, anchor } = decodePayload(await decryptString(key, s.content));
        decrypted.push({ id: s.id, text, anchor, createdAt: s.createdAt, updatedAt: s.updatedAt });
      } catch {
        // Skip anything that won't decrypt rather than crash the whole list.
      }
    }
    setEntries(decrypted);
  }, []);

  const loadStrands = useCallback(async (key: CryptoKey) => {
    const stored = await allStoredStrands();
    const out: Strand[] = [];
    for (const s of stored) {
      if (s.deleted) continue;
      try {
        const { title, entryIds } = decodeStrand(await decryptString(key, s.content));
        out.push({ id: s.id, title, entryIds, createdAt: s.createdAt, updatedAt: s.updatedAt });
      } catch {
        // skip undecryptable
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    setStrands(out);
  }, []);

  // First run: choose a passphrase, create the vault.
  const createVault = useCallback(
    async (passphrase: string) => {
      const salt = newSalt();
      const key = await deriveKeyFromSalt(passphrase, salt, PBKDF2_ITERATIONS);
      const verifier = await makeVerifier(key);
      await saveVault({
        id: "vault",
        salt,
        verifier,
        createdAt: Date.now(),
        iterations: PBKDF2_ITERATIONS,
      });
      keyRef.current = key;
      setEntries([]);
      setStrands([]);
      setVaultState("open");
      void requestDurableStorage();
    },
    [requestDurableStorage]
  );

  // Returning: unlock with the passphrase. Returns false on a wrong one.
  const unlock = useCallback(
    async (passphrase: string): Promise<boolean> => {
      const v = await getVault();
      if (!v) return false;
      const key = await deriveKeyFromSalt(passphrase, v.salt, v.iterations ?? 250_000);
      const ok = await checkVerifier(key, v.verifier);
      if (!ok) return false;
      keyRef.current = key;
      await loadEntries(key);
      await loadStrands(key);
      setVaultState("open");
      void requestDurableStorage();
      return true;
    },
    [loadEntries, loadStrands, requestDurableStorage]
  );

  // Returning via biometrics: a passkey + PRF unwrap a device-stored copy of
  // the key — no passphrase typed. Returns false (caller keeps the passphrase
  // form) if there's no enrollment, the check is declined, or it doesn't
  // verify. The passphrase path is never affected by this.
  const biometricUnlock = useCallback(async (): Promise<boolean> => {
    const d = await getDevice();
    if (!d) return false;
    const raw = await unlockBiometric(d);
    if (!raw) return false;
    const key = await importKeyRaw(raw);
    const v = await getVault();
    if (!v || !(await checkVerifier(key, v.verifier))) return false;
    keyRef.current = key;
    await loadEntries(key);
    await loadStrands(key);
    setVaultState("open");
    void requestDurableStorage();
    return true;
  }, [loadEntries, loadStrands, requestDurableStorage]);

  // Opt in on this device (must be unlocked): wrap the in-memory key behind a
  // platform passkey. Returns false if the platform can't do PRF.
  const enableBiometric = useCallback(async (): Promise<boolean> => {
    const key = keyRef.current;
    if (!key) return false;
    const raw = await exportKeyRaw(key);
    const enr = await enrollBiometric(raw);
    if (!enr) return false;
    await saveDevice({ id: "device", ...enr });
    setBioEnrolled(true);
    return true;
  }, []);

  const disableBiometric = useCallback(async () => {
    await clearDevice();
    setBioEnrolled(false);
  }, []);

  const lock = useCallback(() => {
    keyRef.current = null;
    setEntries([]);
    setStrands([]);
    setVaultState("locked");
  }, []);

  // Writes a record as ciphertext, always marked `dirty` so the (future) sync
  // engine knows it has local changes to push. A deleted record is a tombstone:
  // we clear its plaintext (encrypt "") since the content is gone on purpose,
  // but keep the row so the deletion can propagate.
  const persist = useCallback(async (entry: Entry, deleted = false) => {
    const key = keyRef.current;
    if (!key) return;
    const content = await encryptString(
      key,
      deleted ? "" : encodePayload(entry.text, entry.anchor)
    );
    const record: StoredEntry = {
      id: entry.id,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      content,
      deleted,
      dirty: true,
    };
    await putStoredEntry(record);
  }, []);

  // The UI updates optimistically, then we persist. If that write fails (full
  // disk, private-mode quirks, a locked DB), the thought is still on screen but
  // NOT safely stored — so we surface it with a retry instead of failing
  // silently. Capture's whole promise is a safe landing; this keeps it honest.
  const guardedPersist = useCallback(
    async (entry: Entry, deleted = false) => {
      try {
        await persist(entry, deleted);
        setSaveError(null);
      } catch {
        setSaveError({
          message: deleted
            ? "Couldn't remove that on this device."
            : "Couldn't save that to this device. Your text is still here.",
          retry: () => void guardedPersist(entry, deleted),
        });
      }
    },
    [persist]
  );

  const createEntry = useCallback(
    async (text: string): Promise<Entry> => {
      const t = Date.now();
      const entry: Entry = { id: uid(), text, createdAt: t, updatedAt: t };
      setEntries((prev) => [...prev, entry]);
      await guardedPersist(entry);
      return entry;
    },
    [guardedPersist]
  );

  const addEntry = useCallback(
    async (text: string) => {
      await createEntry(text);
    },
    [createEntry]
  );

  const updateEntry = useCallback(
    async (id: string, text: string) => {
      let updated: Entry | null = null;
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== id) return e;
          updated = { ...e, text, updatedAt: Date.now() };
          return updated;
        })
      );
      if (updated) await guardedPersist(updated);
    },
    [guardedPersist]
  );

  // Attach / change / clear a thought's anchor in lived time. Pass null to
  // un-anchor it. Bumps updatedAt so the change syncs.
  const setAnchor = useCallback(
    async (id: string, anchor: Anchor | null) => {
      let updated: Entry | null = null;
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== id) return e;
          updated = { ...e, anchor: anchor ?? undefined, updatedAt: Date.now() };
          return updated;
        })
      );
      if (updated) await guardedPersist(updated);
    },
    [guardedPersist]
  );

  const removeEntry = useCallback(
    async (entry: Entry) => {
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      // Soft delete: write a tombstone (deleted + dirty, bumped updatedAt) so
      // the removal can sync and win last-write-wins on other devices.
      await guardedPersist({ ...entry, updatedAt: Date.now() }, true);
    },
    [guardedPersist]
  );

  // Used by Undo: re-insert a previously deleted entry. Bump updatedAt so this
  // revival out-dates the tombstone and wins last-write-wins once synced.
  const restoreEntry = useCallback(
    async (entry: Entry) => {
      const revived: Entry = { ...entry, updatedAt: Date.now() };
      setEntries((prev) => [...prev, revived]);
      await guardedPersist(revived);
    },
    [guardedPersist]
  );

  // A restorable, ciphertext-only backup of the whole vault. Returns null if
  // there's nothing to back up yet.
  const exportBackup = useCallback(async (): Promise<Backup | null> => {
    const v = await getVault();
    if (!v) return null;
    // A backup is a clean snapshot — leave tombstones out.
    const liveEntries = (await allStoredEntries()).filter((e) => !e.deleted);
    const liveStrands = (await allStoredStrands()).filter((s) => !s.deleted);
    return buildBackup(v, liveEntries, liveStrands);
  }, []);

  // Restore a parsed backup onto a fresh device. Writes the vault + ciphertext,
  // then drops to the locked screen so the user unlocks with the original
  // passphrase (which never travels in the backup).
  const restoreBackup = useCallback(async (backup: Backup) => {
    const vault: VaultMeta = {
      id: "vault",
      salt: backup.vault.salt,
      verifier: backup.vault.verifier,
      iterations: backup.vault.iterations,
      createdAt: backup.vault.createdAt,
    };
    const entries: StoredEntry[] = backup.entries.map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      content: e.content,
      deleted: false,
      dirty: true, // restored records should upload on first sync
    }));
    const strands: StoredStrand[] = backup.strands.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      content: s.content,
      deleted: false,
      dirty: true,
    }));
    await importData(vault, entries, strands);
    setVaultState("locked");
  }, []);

  // ---- Strands -----------------------------------------------------------

  const persistStrand = useCallback(async (strand: Strand, deleted = false) => {
    const key = keyRef.current;
    if (!key) return;
    const content = await encryptString(
      key,
      deleted ? "" : encodeStrand(strand.title, strand.entryIds)
    );
    const record: StoredStrand = {
      id: strand.id,
      createdAt: strand.createdAt,
      updatedAt: strand.updatedAt,
      content,
      deleted,
      dirty: true,
    };
    await putStoredStrand(record);
  }, []);

  const guardedStrandPersist = useCallback(
    async (strand: Strand, deleted = false) => {
      try {
        await persistStrand(strand, deleted);
        setSaveError(null);
      } catch {
        setSaveError({
          message: "Couldn't save that strand to this device.",
          retry: () => void guardedStrandPersist(strand, deleted),
        });
      }
    },
    [persistStrand]
  );

  // Apply a change to one strand (bumping updatedAt) and persist it.
  const mutateStrand = useCallback(
    async (id: string, change: (s: Strand) => Strand) => {
      let updated: Strand | null = null;
      setStrands((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          updated = { ...change(s), updatedAt: Date.now() };
          return updated;
        })
      );
      if (updated) await guardedStrandPersist(updated);
    },
    [guardedStrandPersist]
  );

  const createStrand = useCallback(
    async (title: string): Promise<Strand> => {
      const t = Date.now();
      const strand: Strand = { id: uid(), title: title.trim(), entryIds: [], createdAt: t, updatedAt: t };
      setStrands((prev) => [strand, ...prev]);
      await guardedStrandPersist(strand);
      return strand;
    },
    [guardedStrandPersist]
  );

  const renameStrand = useCallback(
    (id: string, title: string) => mutateStrand(id, (s) => ({ ...s, title: title.trim() })),
    [mutateStrand]
  );

  const deleteStrand = useCallback(
    async (strand: Strand) => {
      setStrands((prev) => prev.filter((s) => s.id !== strand.id));
      await guardedStrandPersist({ ...strand, updatedAt: Date.now() }, true);
    },
    [guardedStrandPersist]
  );

  // Add an existing thought to a strand (no-op if already a member).
  const addToStrand = useCallback(
    (strandId: string, entryId: string) =>
      mutateStrand(strandId, (s) =>
        s.entryIds.includes(entryId) ? s : { ...s, entryIds: [...s.entryIds, entryId] }
      ),
    [mutateStrand]
  );

  const removeFromStrand = useCallback(
    (strandId: string, entryId: string) =>
      mutateStrand(strandId, (s) => ({ ...s, entryIds: s.entryIds.filter((id) => id !== entryId) })),
    [mutateStrand]
  );

  const reorderStrand = useCallback(
    (strandId: string, entryIds: string[]) => mutateStrand(strandId, (s) => ({ ...s, entryIds })),
    [mutateStrand]
  );

  // Write a brand-new piece directly into a strand: it becomes an ordinary
  // thought (also in the Stream) and is appended to the strand's order.
  const writeInStrand = useCallback(
    async (strandId: string, text: string) => {
      const entry = await createEntry(text);
      await addToStrand(strandId, entry.id);
    },
    [createEntry, addToStrand]
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);

  return {
    vaultState,
    entries,
    saveError,
    clearSaveError,
    bioSupported,
    bioEnrolled,
    biometricUnlock,
    enableBiometric,
    disableBiometric,
    createVault,
    unlock,
    lock,
    addEntry,
    updateEntry,
    removeEntry,
    restoreEntry,
    setAnchor,
    strands,
    createStrand,
    renameStrand,
    deleteStrand,
    addToStrand,
    removeFromStrand,
    reorderStrand,
    writeInStrand,
    exportBackup,
    restoreBackup,
  };
}
