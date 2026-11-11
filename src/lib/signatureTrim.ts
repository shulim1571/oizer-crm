/**
 * The box around the writing in a signature image: the rows and columns with ink, ignoring transparent or near-white
 * pixels. Signature files often have wide blank margins, which made the signature float above the line on checks
 * (Moshe Henig, 2026-11-11). Returns null when the image has no ink.
 */
export function inkBox(pixels: Uint8ClampedArray, width: number, height: number): { x: number; y: number; w: number; h: number } | null {
  let top = height, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const ink = pixels[i + 3] > 40 && pixels[i] + pixels[i + 1] + pixels[i + 2] < 600;
      if (!ink) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) return null;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** The signature cut down to its writing, as a PNG; the original if the browser can't read it. */
export async function trimSignature(sig: { bytes: Uint8Array; mime: string }): Promise<{ bytes: Uint8Array; mime: string }> {
  try {
    const bitmap = await createImageBitmap(new Blob([sig.bytes as BlobPart], { type: sig.mime }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const box = inkBox(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height);
    if (!box) return sig;
    const out = document.createElement('canvas');
    out.width = box.w;
    out.height = box.h;
    out.getContext('2d')!.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'));
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' } : sig;
  } catch {
    return sig;
  }
}
