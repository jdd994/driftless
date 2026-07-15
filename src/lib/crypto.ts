// crypto.ts
// End-to-end encryption for journal entries.
//
// Model: a passphrase only you know is stretched into an AES-GCM key with
// PBKDF2. Entries are encrypted in the browser; only ciphertext is ever
// written to storage (and, later, to any sync server). The key lives in
// memory for the session only — close the app and it's gone, so unlocking
// always requires the passphrase again.
//
// Honest tradeoff: there is no recovery. If the passphrase is forgotten,
// the entries cannot be decrypted by anyone, including us. That's the point.

// Current work factor for new vaults. OWASP's 2023+ guidance for
// PBKDF2-SHA256 is 600k. The count a vault was created with is stored in the
// vault (see db.ts) so raising this never locks out existing journals.
export const PBKDF2_ITERATIONS = 600_000;
const KEY_ALGO = { name: "AES-GCM", length: 256 } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

export type CipherBlob = {
  iv: number[]; // 12-byte AES-GCM nonce
  data: number[]; // ciphertext bytes
};

// Copy any byte view into a fresh, standalone ArrayBuffer. WebCrypto wants a
// BufferSource backed by ArrayBuffer (not SharedArrayBuffer); going through a
// plain ArrayBuffer keeps the types happy across TS versions.
function toBuf(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function newSalt(): number[] {
  return Array.from(randomBytes(16));
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    toBuf(enc.encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toBuf(salt), iterations, hash: "SHA-256" },
    baseKey,
    KEY_ALGO,
    // Extractable so a device can wrap a copy of the key for biometric unlock.
    // The key still lives only in memory; CSP blocks any script that could read
    // it (see invariants #2/#4 and SYNC_PLAN.md).
    true,
    ["encrypt", "decrypt"]
  );
}

// `iterations` defaults to the legacy count so vaults created before the work
// factor was stored (and raised) still unlock with the value they were made
// with. New vaults pass the current PBKDF2_ITERATIONS explicitly.
export async function deriveKeyFromSalt(
  passphrase: string,
  salt: number[],
  iterations = 250_000
): Promise<CryptoKey> {
  return deriveKey(passphrase, new Uint8Array(salt), iterations);
}

export async function encryptString(key: CryptoKey, plaintext: string): Promise<CipherBlob> {
  const iv = randomBytes(12);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBuf(iv) },
    key,
    toBuf(enc.encode(plaintext))
  );
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(cipher)) };
}

export async function decryptString(key: CryptoKey, blob: CipherBlob): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(new Uint8Array(blob.iv)) },
    key,
    toBuf(new Uint8Array(blob.data))
  );
  return dec.decode(plain);
}

// ---- Raw key export/import + wrapping (for biometric unlock) ------------
// A device can store a copy of the vault key wrapped by a secret that only a
// platform authenticator can reproduce after a biometric check (WebAuthn PRF).

export async function exportKeyRaw(key: CryptoKey): Promise<number[]> {
  return Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export async function importKeyRaw(bytes: number[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toBuf(new Uint8Array(bytes)), KEY_ALGO, true, [
    "encrypt",
    "decrypt",
  ]);
}

// Use the first 32 bytes of an external secret as an AES-GCM wrapping key.
async function kekFromSecret(secret: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secret.slice(0, 32), KEY_ALGO, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function wrapWithSecret(
  secret: ArrayBuffer,
  keyRaw: number[]
): Promise<CipherBlob> {
  const kek = await kekFromSecret(secret);
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBuf(iv) },
    kek,
    toBuf(new Uint8Array(keyRaw))
  );
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(data)) };
}

export async function unwrapWithSecret(
  secret: ArrayBuffer,
  blob: CipherBlob
): Promise<number[]> {
  const kek = await kekFromSecret(secret);
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(new Uint8Array(blob.iv)) },
    kek,
    toBuf(new Uint8Array(blob.data))
  );
  return Array.from(new Uint8Array(raw));
}

// ---- Binary encryption (media / images) --------------------------------
// Images are raw bytes, stored directly in IndexedDB (which holds ArrayBuffers
// efficiently) rather than the number[] shape used for small text blobs.
export type CipherBytes = { iv: Uint8Array; data: ArrayBuffer };

export async function encryptBytes(key: CryptoKey, bytes: ArrayBuffer): Promise<CipherBytes> {
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toBuf(iv) }, key, bytes);
  return { iv, data };
}

export async function decryptBytes(key: CryptoKey, blob: CipherBytes): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: toBuf(blob.iv) }, key, blob.data);
}

// ---- Identity keypair (ECDH P-256) for sharing --------------------------
// Public key: shared so others can encrypt to you. Private key: wrapped by the
// vault key and stored (device + server-wrapped), so it survives to a new
// device once the passphrase unlocks the vault. See SHARING_PLAN.md.

function b64(u8: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export type WrappedKey = { iv: string; data: string }; // base64

export function generateIdentityKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveKey",
    "deriveBits",
  ]);
}

export async function exportPublicKeyB64(pub: CryptoKey): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.exportKey("spki", pub)));
}

export function importPublicKeyB64(s: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", toBuf(fromB64(s)), { name: "ECDH", namedCurve: "P-256" }, true, []);
}

export async function wrapPrivateKey(vaultKey: CryptoKey, priv: CryptoKey): Promise<WrappedKey> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", priv);
  const cb = await encryptBytes(vaultKey, pkcs8);
  return { iv: b64(cb.iv), data: b64(new Uint8Array(cb.data)) };
}

export async function unwrapPrivateKey(vaultKey: CryptoKey, w: WrappedKey): Promise<CryptoKey> {
  const bytes = await decryptBytes(vaultKey, { iv: fromB64(w.iv), data: toBuf(fromB64(w.data)) });
  return crypto.subtle.importKey("pkcs8", bytes, { name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveKey",
    "deriveBits",
  ]);
}

// ---- Shared-strand keys (DEK) + ECIES wrapping --------------------------
// A shared strand has its own AES key (DEK). To share it, wrap it to a member's
// public key via an ephemeral ECDH agreement (only they can unwrap). Matches the
// server-verified scheme in SHARING_PLAN.md.

export type WrappedDEK = { ephemeralPub: string; wrappedDEK: WrappedKey };

export function generateDEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function wrapDEKForRecipient(recipientPubB64: string, dek: CryptoKey): Promise<WrappedDEK> {
  const recipient = await importPublicKeyB64(recipientPubB64);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: recipient },
    eph.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBuf(iv) },
    wrapKey,
    await crypto.subtle.exportKey("raw", dek)
  );
  return {
    ephemeralPub: await exportPublicKeyB64(eph.publicKey),
    wrappedDEK: { iv: b64(iv), data: b64(new Uint8Array(ct)) },
  };
}

export async function unwrapDEK(
  myPriv: CryptoKey,
  ephemeralPubB64: string,
  wrapped: WrappedKey
): Promise<CryptoKey> {
  const eph = await importPublicKeyB64(ephemeralPubB64);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: eph },
    myPriv,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(fromB64(wrapped.iv)) },
    wrapKey,
    toBuf(fromB64(wrapped.data))
  );
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

// ---- Invite links (S6) --------------------------------------------------
// A link carries a random secret in its URL fragment. From it we derive two
// independent HKDF sub-keys: a wrapKey that encrypts the strand DEK (opaque to
// the server) and a joinProof the server checks only by hash. See SHARING_PLAN.

export function randomLinkSecret(): Uint8Array {
  return randomBytes(32);
}

export function toBase64(u8: Uint8Array): string {
  return b64(u8);
}

// URL-fragment-safe base64 for the link secret.
export function b64url(u8: Uint8Array): string {
  return b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

export async function deriveInviteKeys(
  linkSecret: Uint8Array
): Promise<{ wrapKey: CryptoKey; joinProof: Uint8Array }> {
  const base = await crypto.subtle.importKey("raw", toBuf(linkSecret), "HKDF", false, ["deriveBits"]);
  const salt = new Uint8Array(0);
  const wrapBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toBuf(salt), info: enc.encode("driftless-invite-wrap") },
    base,
    256
  );
  const wrapKey = await crypto.subtle.importKey("raw", wrapBits, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  const proofBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toBuf(salt), info: enc.encode("driftless-invite-proof") },
    base,
    256
  );
  return { wrapKey, joinProof: new Uint8Array(proofBits) };
}

export async function sha256B64(bytes: Uint8Array): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", toBuf(bytes))));
}

export async function linkWrapDEK(wrapKey: CryptoKey, dek: CryptoKey): Promise<CipherBlob> {
  const raw = await crypto.subtle.exportKey("raw", dek);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toBuf(iv) }, wrapKey, raw);
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(ct)) };
}

export async function linkUnwrapDEK(wrapKey: CryptoKey, blob: CipherBlob): Promise<CryptoKey> {
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(new Uint8Array(blob.iv)) },
    wrapKey,
    toBuf(new Uint8Array(blob.data))
  );
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

// A small known token, encrypted at setup. On unlock we try to decrypt it;
// success means the passphrase was correct. AES-GCM fails loudly on a wrong
// key, so this never produces a false positive.
const VERIFIER_TEXT = "driftless-ok";

export async function makeVerifier(key: CryptoKey): Promise<CipherBlob> {
  return encryptString(key, VERIFIER_TEXT);
}

// ---- Envelope encryption (change-passphrase without re-encrypting data) ---
// The vault holds a random DEK that encrypts all data. The passphrase derives a
// KEK that only WRAPS the DEK. Changing the passphrase re-wraps the DEK — the
// DEK (and therefore every ciphertext, and each device's ability to read it)
// never changes. wrapVaultKey/unwrapVaultKey move the DEK in and out of that
// wrapped form; the wrapped blob is opaque, safe to store and sync.
export async function wrapVaultKey(kek: CryptoKey, dek: CryptoKey): Promise<CipherBlob> {
  return encryptString(kek, JSON.stringify(await exportKeyRaw(dek)));
}
export async function unwrapVaultKey(kek: CryptoKey, blob: CipherBlob): Promise<CryptoKey> {
  return importKeyRaw(JSON.parse(await decryptString(kek, blob)) as number[]);
}

export async function checkVerifier(key: CryptoKey, blob: CipherBlob): Promise<boolean> {
  try {
    const text = await decryptString(key, blob);
    return text === VERIFIER_TEXT;
  } catch {
    return false;
  }
}
