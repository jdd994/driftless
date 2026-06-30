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

// A small known token, encrypted at setup. On unlock we try to decrypt it;
// success means the passphrase was correct. AES-GCM fails loudly on a wrong
// key, so this never produces a false positive.
const VERIFIER_TEXT = "driftless-ok";

export async function makeVerifier(key: CryptoKey): Promise<CipherBlob> {
  return encryptString(key, VERIFIER_TEXT);
}

export async function checkVerifier(key: CryptoKey, blob: CipherBlob): Promise<boolean> {
  try {
    const text = await decryptString(key, blob);
    return text === VERIFIER_TEXT;
  } catch {
    return false;
  }
}
