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

// Downscale + re-encode a photo to JPEG. iPhone HEIC/HEIF can't be decoded by
// most browsers' canvas, so we convert those first (heic2any, lazily loaded so
// it doesn't weigh down startup). Throws on any failure rather than storing an
// unviewable blob — the caller surfaces a clear message instead of a white
// polaroid.
export async function compressImage(file: File): Promise<{ bytes: ArrayBuffer; type: string }> {
  let source: Blob = file;
  if (isHeic(file)) {
    const heic2any = (await import("heic2any")).default;
    const out = await heic2any({ blob: file, toType: "image/jpeg", quality: QUALITY });
    source = Array.isArray(out) ? out[0] : out;
  }
  const bitmap = await createImageBitmap(source);
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
