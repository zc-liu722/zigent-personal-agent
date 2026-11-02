const MAX_PIXELS = 16_000_000;
const MAX_EDGE = 8192;

function dimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a
    && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    // Canvas uses eight-bit channels. Preserve deeper color, transparency and APNG verbatim.
    if (bytes[24] !== 8 || ![0, 2, 3].includes(bytes[25])) return;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), type = view.getUint32(offset + 4);
      if (offset + length + 12 > bytes.length) return;
      if (type === 0x6163544c || type === 0x74524e53) return; // acTL or tRNS
      if (type === 0x49444154) return { type: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
      offset += length + 12;
    }
    return;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8 && bytes[offset + 2] === 8)
      return { type: 'image/jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    offset += length;
  }
}

self.onmessage = async event => {
  const file = event.data;
  let bitmap, canvas, result;
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return;
    const info = dimensions(new Uint8Array(await file.arrayBuffer()));
    // Never downscale small text or long screenshots. Oversized decodes keep the original.
    if (!info || info.width < 1 || info.height < 1 || info.width * info.height > MAX_PIXELS
      || Math.max(info.width, info.height) > MAX_EDGE) return;
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(bitmap, 0, 0);
    result = await canvas.convertToBlob({ type: info.type === 'image/png' ? 'image/png' : 'image/webp', quality: .94 });
    // Unsupported WebP encoding falls back to high-quality JPEG, never opaque PNG growth.
    if (info.type === 'image/jpeg' && result.type !== 'image/webp')
      result = await canvas.convertToBlob({ type: 'image/jpeg', quality: .94 });
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.type)) result = undefined;
  } catch { /* Decoding/encoding is an optional optimization; upload the original on failure. */ }
  finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
    // The caller treats a missing result as the original file.
    self.postMessage(result ?? null);
  }
};
