/**
 * A picture chosen from the computer, shrunk to fit (keeping its shape) and stored as a data address with the page
 * (readiness #55: campaign banner and logo uploads). JPEG for photos (banners), PNG for logos (keeps transparency).
 */
export async function pictureToDataUrl(file: File, maxWidth: number, maxHeight: number, kind: 'photo' | 'logo'): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP picture.');
  if (file.size > 10_000_000) throw new Error('That picture is too large (over 10 MB).');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let url = kind === 'photo' ? canvas.toDataURL('image/jpeg', 0.82) : canvas.toDataURL('image/png');
  if (url.length > 650_000 && kind === 'photo') url = canvas.toDataURL('image/jpeg', 0.6);
  if (url.length > 650_000) throw new Error('That picture is too detailed to store; try a simpler or smaller one.');
  return url;
}
