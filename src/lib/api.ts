// api.ts
// Client for the Driftless sync server. Thin, typed fetch wrappers — it moves
// ciphertext + non-secret metadata only, never plaintext or the passphrase.
// See ../SYNC_PLAN.md. Nothing here runs until the sync engine (Phase 4) wires
// it in.
import type { CipherBlob, WrappedKey } from "./crypto";

// The sync server. (Swap for a custom domain later; also update connect-src in
// public/_headers if this origin changes.)
export const API_BASE = "https://driftless-server.jdd994.workers.dev";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type SyncKind = "entry" | "strand";

// One record as it travels to/from the server (the content stays ciphertext).
export type SyncRecord = {
  kind: SyncKind;
  id: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  content: CipherBlob;
};

export type VaultMetaDTO = {
  salt: number[];
  verifier: CipherBlob;
  iterations?: number;
  identityPublicKey?: string | null;
  identityPrivWrapped?: WrappedKey | null;
  // Envelope encryption: the DEK wrapped by the passphrase-derived KEK. Opaque —
  // the server stores and returns it, never reads it. Absent for legacy vaults.
  wrappedDEK?: CipherBlob;
};

type ReqOpts = { method?: string; token?: string; body?: unknown };

async function req<T>(path: string, opts: ReqOpts = {}): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

// ---- auth + account ----

export function register(
  email: string,
  password: string,
  vault: VaultMetaDTO,
  identityPublicKey: string,
  identityPrivWrapped: WrappedKey
): Promise<{ token: string; userId: string }> {
  return req("/auth/register", {
    method: "POST",
    body: { email, password, vault, identityPublicKey, identityPrivWrapped },
  });
}

// Set/update this account's identity keypair (migrate old accounts + rotation).
export function setIdentity(
  token: string,
  identityPublicKey: string,
  identityPrivWrapped: WrappedKey
): Promise<{ ok: boolean }> {
  return req("/identity", { method: "POST", token, body: { identityPublicKey, identityPrivWrapped } });
}

export function login(
  email: string,
  password: string
): Promise<{ token: string; userId: string }> {
  return req("/auth/login", { method: "POST", body: { email, password } });
}

// Fetch the vault metadata so a new device can re-derive the key from the
// passphrase.
export function fetchVault(token: string): Promise<VaultMetaDTO> {
  return req("/vault", { token });
}

// Update the vault record after a passphrase change: new salt, verifier, and
// re-wrapped DEK. Only these envelope fields move; the ciphertext is untouched,
// so other devices keep reading their data and just need the new wrap to unlock.
export function updateVault(
  token: string,
  vault: { salt: number[]; verifier: CipherBlob; iterations?: number; wrappedDEK: CipherBlob }
): Promise<{ ok: boolean }> {
  return req("/vault", { method: "PUT", token, body: vault });
}

// This account's own user id (for authorship of shared pieces).
export function fetchMe(token: string): Promise<{ userId: string }> {
  return req("/me", { token });
}

// Permanently delete the account and everything the server holds for it —
// private entries, the vault record, photos in R2, and shared-strand
// membership. Local data on the device is untouched. The server refuses (409)
// if the user still owns a shared strand that other people are in. Irreversible.
export function deleteAccount(token: string): Promise<{ ok: boolean }> {
  return req("/me", { method: "DELETE", token });
}

// Public-key directory (for future sharing).
export function fetchKeys(
  token: string,
  email: string
): Promise<{ identityPublicKey: string | null }> {
  return req(`/keys?email=${encodeURIComponent(email)}`, { token });
}

// ---- sync ----

// Push a batch of changed records (any mix of kinds). Server applies LWW.
export function pushChanges(
  token: string,
  changes: SyncRecord[]
): Promise<{ applied: number; cursor: number }> {
  return req("/sync/push", { method: "POST", token, body: { changes } });
}

// Pull everything with seq greater than the cursor (all kinds).
export function pullChanges(
  token: string,
  since: number
): Promise<{ changes: SyncRecord[]; cursor: number; more: boolean }> {
  return req(`/sync/pull?since=${since}`, { token });
}

// ---- media (M1: encrypted photo blobs over R2) ----
// Binary, not JSON. The object is iv(12) || ciphertext — already encrypted on
// the device; the server just stores/returns it. Type is non-secret metadata.

export async function uploadMedia(
  token: string,
  id: string,
  iv: Uint8Array,
  data: ArrayBuffer,
  type: string
): Promise<void> {
  const body = new Uint8Array(iv.byteLength + data.byteLength);
  body.set(iv, 0);
  body.set(new Uint8Array(data), iv.byteLength);
  const res = await fetch(`${API_BASE}/media/${id}?type=${encodeURIComponent(type)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  if (!res.ok) throw new ApiError(`Media upload failed (${res.status})`, res.status);
}

export async function downloadMedia(
  token: string,
  id: string
): Promise<{ iv: Uint8Array; data: ArrayBuffer; type: string } | null> {
  const res = await fetch(`${API_BASE}/media/${id}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(`Media download failed (${res.status})`, res.status);
  const all = new Uint8Array(await res.arrayBuffer());
  return {
    iv: all.slice(0, 12),
    data: all.slice(12).buffer,
    type: res.headers.get("content-type") || "application/octet-stream",
  };
}

// Remove a personal photo blob from storage (M3). Best-effort, idempotent.
export async function deleteMediaRemote(token: string, id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/media/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new ApiError(`Media delete failed (${res.status})`, res.status);
}

// Shared-strand photos (M2): encrypted with the strand DEK, gated by membership.
export async function uploadSharedMedia(
  token: string,
  strandId: string,
  id: string,
  iv: Uint8Array,
  data: ArrayBuffer,
  type: string
): Promise<void> {
  const body = new Uint8Array(iv.byteLength + data.byteLength);
  body.set(iv, 0);
  body.set(new Uint8Array(data), iv.byteLength);
  const res = await fetch(`${API_BASE}/shared/${strandId}/media/${id}?type=${encodeURIComponent(type)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  if (!res.ok) throw new ApiError(`Media upload failed (${res.status})`, res.status);
}

export async function deleteSharedMediaRemote(token: string, strandId: string, id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/shared/${strandId}/media/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new ApiError(`Media delete failed (${res.status})`, res.status);
}

export async function downloadSharedMedia(
  token: string,
  strandId: string,
  id: string
): Promise<{ iv: Uint8Array; data: ArrayBuffer; type: string } | null> {
  const res = await fetch(`${API_BASE}/shared/${strandId}/media/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(`Media download failed (${res.status})`, res.status);
  const all = new Uint8Array(await res.arrayBuffer());
  return {
    iv: all.slice(0, 12),
    data: all.slice(12).buffer,
    type: res.headers.get("content-type") || "application/octet-stream",
  };
}

// ---- feedback (a calm note to the maker) ----

// Open endpoint — no account needed. Token is sent if present, only so a note
// can be attributed; it's never required.
export function sendFeedback(
  message: string,
  contact?: string,
  token?: string | null
): Promise<{ ok: boolean }> {
  return req("/feedback", { method: "POST", token: token ?? undefined, body: { message, contact } });
}

// ---- shared strands (S3) ----

export type SharedRecord = {
  kind: string; // 'piece' | 'meta'
  id: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  dekEpoch: number;
  content: CipherBlob;
};
export type SharedStrandInfo = {
  strandId: string;
  ownerId: string;
  role: string;
  ephemeralPub: string;
  wrappedDEK: WrappedKey;
  dekEpoch: number;
};
export type StrandMember = { userId: string; role: string; email: string; identityPublicKey: string | null };

export function createShared(
  token: string,
  strandId: string,
  ephemeralPub: string,
  wrappedDEK: WrappedKey
): Promise<{ ok: boolean }> {
  return req("/shared/create", { method: "POST", token, body: { strandId, ephemeralPub, wrappedDEK } });
}

export function inviteToStrand(
  token: string,
  strandId: string,
  memberEmail: string,
  ephemeralPub: string,
  wrappedDEK: WrappedKey,
  dekEpoch: number
): Promise<{ ok: boolean; userId: string }> {
  return req(`/shared/${strandId}/invite`, {
    method: "POST",
    token,
    body: { memberEmail, ephemeralPub, wrappedDEK, dekEpoch },
  });
}

export function sharedMembers(token: string, strandId: string): Promise<{ members: StrandMember[] }> {
  return req(`/shared/${strandId}/members`, { token });
}

export function sharedMine(token: string): Promise<{ strands: SharedStrandInfo[] }> {
  return req("/shared/mine", { token });
}

export function sharedPush(
  token: string,
  strandId: string,
  changes: SharedRecord[]
): Promise<{ applied: number; cursor: number }> {
  return req(`/shared/${strandId}/push`, { method: "POST", token, body: { changes } });
}

export function sharedPull(
  token: string,
  strandId: string,
  since: number
): Promise<{ changes: SharedRecord[]; cursor: number; more: boolean }> {
  return req(`/shared/${strandId}/pull?since=${since}`, { token });
}

// Leave a strand you're a member of (self-removal).
export function sharedLeave(token: string, strandId: string): Promise<{ ok: boolean }> {
  return req(`/shared/${strandId}/leave`, { method: "POST", token });
}

// Owner removes a member. Rotation (re-key) is driven client-side afterwards.
export function sharedRemove(
  token: string,
  strandId: string,
  userId: string
): Promise<{ ok: boolean }> {
  return req(`/shared/${strandId}/remove`, { method: "POST", token, body: { userId } });
}

// ---- invite links (S6) ----

export function createInviteLink(
  token: string,
  strandId: string,
  inviteId: string,
  wrappedDEK: CipherBlob,
  joinProofHash: string,
  dekEpoch: number,
  expiresAt: number,
  maxUses: number
): Promise<{ ok: boolean; inviteId: string }> {
  return req(`/shared/${strandId}/invite-link`, {
    method: "POST",
    token,
    body: { inviteId, wrappedDEK, joinProofHash, dekEpoch, expiresAt, maxUses },
  });
}

export function joinClaim(
  token: string,
  inviteId: string,
  joinProof: string
): Promise<{ strandId: string; wrappedDEK: CipherBlob; dekEpoch: number }> {
  return req("/shared/join/claim", { method: "POST", token, body: { inviteId, joinProof } });
}

export function joinFinish(
  token: string,
  inviteId: string,
  joinProof: string,
  ephemeralPub: string,
  wrappedDEK: WrappedKey
): Promise<{ ok: boolean; strandId: string }> {
  return req("/shared/join/finish", {
    method: "POST",
    token,
    body: { inviteId, joinProof, ephemeralPub, wrappedDEK },
  });
}
