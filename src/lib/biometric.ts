// biometric.ts
// Optional, per-device biometric unlock built on WebAuthn's PRF extension.
//
// A platform passkey (Face ID / Touch ID / Android fingerprint) can, via the
// `prf` extension, emit a stable secret after a biometric check. We use that
// secret to wrap a copy of the vault key on THIS device. The passphrase stays
// the durable root (this never replaces it); biometric is just a local
// shortcut, and if a platform can't do PRF we fall back to the passphrase.
//
// WebAuthn's PRF types aren't in the standard DOM lib yet, so the option
// objects are built loosely and the calls are cast.

import { wrapWithSecret, unwrapWithSecret, type CipherBlob } from "./crypto";

// A fixed app salt for the PRF evaluation — the secret is per-credential, so a
// constant salt is fine and keeps enroll/unlock consistent.
const PRF_SALT = new Uint8Array([
  0x64, 0x72, 0x69, 0x66, 0x74, 0x6c, 0x65, 0x73, 0x73, 0x2d, 0x70, 0x72, 0x66, 0x2d, 0x76, 0x31,
  0x9a, 0x3c, 0x71, 0x05, 0xe8, 0x2b, 0x4d, 0x16, 0xa7, 0x5f, 0xc0, 0x38, 0x91, 0x6e, 0x2d, 0x44,
]);

function rand(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export type Enrollment = {
  credentialId: number[];
  prfSalt: number[];
  wrapped: CipherBlob;
};

// True only when this device has a platform authenticator (built-in biometric).
export async function biometricSupported(): Promise<boolean> {
  try {
    return (
      typeof window !== "undefined" &&
      !!window.PublicKeyCredential &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

async function assertPrf(credentialId: number[]): Promise<ArrayBuffer | undefined> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: "public-key", id: new Uint8Array(credentialId) }],
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  } as unknown as CredentialRequestOptions)) as PublicKeyCredential | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ext = assertion?.getClientExtensionResults() as any;
  return ext?.prf?.results?.first as ArrayBuffer | undefined;
}

// Create a platform passkey with PRF and wrap the vault key with its output.
// Returns null if the platform can't produce a PRF secret (→ caller keeps the
// passphrase-only flow).
export async function enrollBiometric(vaultKeyRaw: number[]): Promise<Enrollment | null> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Driftless", id: location.hostname },
      user: { id: rand(16), name: "driftless", displayName: "Driftless" },
      challenge: rand(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "required",
      },
      timeout: 60_000,
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  } as unknown as CredentialCreationOptions)) as PublicKeyCredential | null;
  if (!cred) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ext = cred.getClientExtensionResults() as any;
  if (!ext.prf || ext.prf.enabled === false) return null; // PRF not supported here

  const credentialId = Array.from(new Uint8Array(cred.rawId));
  // Some platforms return the secret at create time; others need an assertion.
  let secret: ArrayBuffer | undefined = ext.prf.results?.first;
  if (!secret) secret = await assertPrf(credentialId);
  if (!secret) return null;

  const wrapped = await wrapWithSecret(secret, vaultKeyRaw);
  return { credentialId, prfSalt: Array.from(PRF_SALT), wrapped };
}

// Biometric check → unwrap → raw vault key bytes (or null on failure).
export async function unlockBiometric(enr: Enrollment): Promise<number[] | null> {
  const secret = await assertPrf(enr.credentialId);
  if (!secret) return null;
  try {
    return await unwrapWithSecret(secret, enr.wrapped);
  } catch {
    return null;
  }
}
