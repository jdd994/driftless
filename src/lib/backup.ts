// backup.ts
// A restorable backup of the journal. Unlike the Markdown export (which is for
// reading), a backup is for *recovery and moving to a new device*: it contains
// only the encrypted vault metadata and the ciphertext entries — never
// plaintext. Restoring it writes those back to IndexedDB; the original
// passphrase then unlocks them. This keeps invariant #1 intact: only ciphertext
// ever leaves the device.

import type { CipherBlob } from "./crypto";
import type { StoredEntry, StoredStrand, VaultMeta } from "./db";

export const BACKUP_FORMAT = "driftless-backup";
// v2 adds strands. v1 backups (entries only) still restore — strands default
// to empty.
export const BACKUP_VERSION = 2;

export type BackupVault = {
  salt: number[];
  verifier: CipherBlob;
  iterations?: number;
  // Envelope: the wrapped DEK. REQUIRED for restoring an envelope vault — without
  // it the restored vault can't be opened (the passphrase-derived KEK is not the
  // data key). Absent only in backups of legacy pre-envelope vaults.
  wrappedDEK?: CipherBlob;
  createdAt: number;
};

type BackupRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  content: CipherBlob;
};

export type Backup = {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  vault: BackupVault;
  entries: BackupRecord[];
  strands: BackupRecord[];
};

const toRecord = (r: StoredEntry | StoredStrand): BackupRecord => ({
  id: r.id,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  content: r.content,
});

export function buildBackup(
  vault: VaultMeta,
  entries: StoredEntry[],
  strands: StoredStrand[]
): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    vault: {
      salt: vault.salt,
      verifier: vault.verifier,
      iterations: vault.iterations,
      wrappedDEK: vault.wrappedDEK,
      createdAt: vault.createdAt,
    },
    entries: entries.map(toRecord),
    strands: strands.map(toRecord),
  };
}

function isCipherBlob(x: unknown): x is CipherBlob {
  const b = x as CipherBlob;
  return !!b && Array.isArray(b.iv) && Array.isArray(b.data);
}

// Parse + validate untrusted file contents. Throws a friendly Error on anything
// that isn't a well-formed Driftless backup, so the UI can show what to do.
export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a valid backup (couldn't read it).");
  }
  const b = raw as Backup;
  if (!b || b.format !== BACKUP_FORMAT) {
    throw new Error("That doesn't look like a Driftless backup.");
  }
  if (typeof b.version !== "number" || b.version > BACKUP_VERSION) {
    throw new Error("This backup was made by a newer version of Driftless.");
  }
  if (
    !b.vault ||
    !Array.isArray(b.vault.salt) ||
    !isCipherBlob(b.vault.verifier) ||
    !Array.isArray(b.entries)
  ) {
    throw new Error("This backup is incomplete or corrupted.");
  }
  // Strands are optional (absent in v1 backups) — default to none.
  if (b.strands === undefined) b.strands = [];
  for (const r of [...b.entries, ...b.strands]) {
    if (!r || typeof r.id !== "string" || !isCipherBlob(r.content)) {
      throw new Error("This backup is incomplete or corrupted.");
    }
  }
  return b;
}
