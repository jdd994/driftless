// media.ts
// Client-side image handling: downscale + re-encode so photos stay small —
// kinder to device storage now, and to sync later. No IO or crypto here.

export const MAX_DIM = 1600; // longest edge, px
export const QUALITY = 0.85;

// Base64-encode bytes (chunked, so large images don't overflow the call stack).
// Used to build data: URLs for display — allowed by the CSP everywhere, unlike
// blob: URLs.
export function bytesToBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function isHeic(file: File): boolean {
  return /(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

// Downscale + re-encode a photo to JPEG. Throws (never stores an unviewable
// blob) so the caller can show a clear message instead of a white polaroid.
// iPhone photos: adding from the phone works because iOS hands the browser a
// JPEG (or WebKit decodes the HEIC natively). A raw .heic added from a desktop
// browser can't be decoded there — we say so plainly rather than hang.
export async function compressImage(file: File): Promise<{ bytes: ArrayBuffer; type: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (isHeic(file)) {
      throw new Error(
        "This photo is in Apple's HEIC format, which this device can't open. Convert it to a JPEG first — e.g. open it in Google Photos, tap Edit, then Save copy — and add that."
      );
    }
    throw new Error("Couldn't read that image — try a JPEG or PNG.");
  }
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process that image on this device.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob: Blob | null = await new Promise((res) =>
    canvas.toBlob((b) => res(b), "image/jpeg", QUALITY)
  );
  if (!blob) throw new Error("Couldn't process that image.");
  return { bytes: await blob.arrayBuffer(), type: "image/jpeg" };
}
