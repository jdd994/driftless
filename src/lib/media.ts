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

// Returns compressed JPEG bytes + mime type. Falls back to the original file
// bytes if canvas encoding isn't available.
export async function compressImage(file: File): Promise<{ bytes: ArrayBuffer; type: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob: Blob | null = await new Promise((res) =>
      canvas.toBlob((b) => res(b), "image/jpeg", QUALITY)
    );
    if (!blob) throw new Error("no blob");
    return { bytes: await blob.arrayBuffer(), type: "image/jpeg" };
  } catch {
    return { bytes: await file.arrayBuffer(), type: file.type || "image/jpeg" };
  }
}
