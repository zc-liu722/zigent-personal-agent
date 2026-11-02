// Document decoding stays outside the chat event loop. Only verified bytes cross
// this boundary; no source paths, shell commands or credentials are accepted.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { unzipSync } from 'fflate';
import mammoth from 'mammoth';
import { getDocument, version as pdfVersion } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const resourceDirectory = name => join(pdfRoot, name).replaceAll('\\', '/') + '/';
const MAX_TEXT = 2_000_000;
const MAX_PAGES = 200;
const fail = code => { throw new Error(code); };

function docxEntries(bytes, extract) {
  let count = 0, size = 0;
  return unzipSync(bytes, { filter: file => {
    if (++count > 5000 || (size += file.originalSize) > 128 * 1024 * 1024) fail('DOCUMENT_LIMIT');
    if (file.name === 'word/document.xml' && file.originalSize > 16 * 1024 * 1024) fail('DOCUMENT_LIMIT');
    return extract(file);
  } });
}

function assets(bytes, selected) {
  const images = [];
  const entries = docxEntries(bytes, file => {
    if (!/^word\/media\/[^/]+$/.test(file.name)) return false;
    const supported = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
    images.push({ image: images.length + 1, name: file.name.split('/').at(-1), supported });
    return selected?.includes(images.length) && supported && file.originalSize <= 16 * 1024 * 1024;
  });
  return { images, entries };
}

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, value) => {
    if (value[0] === '#') {
      const code = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[value.toLowerCase()] ?? all;
  });
}

async function word(bytes, request) {
  const { images, entries } = assets(bytes, request.images);
  if (request.action === 'render') {
    const pictures = request.images.map(number => {
      const image = images[number - 1];
      if (!image || !image.supported) fail('DOCUMENT_IMAGE_UNSUPPORTED');
      const data = entries['word/media/' + image.name];
      if (!data) fail('DOCUMENT_LIMIT');
      return { image: number, data };
    });
    return { format: 'docx', pictures };
  }
  // External relationships and embedded style mappings cannot fetch files or
  // change the conversion. HTML is immediately reduced to reference text.
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, {
    externalFileAccess: false, includeEmbeddedStyleMap: false,
    convertImage: mammoth.images.imgElement(async () => ({ src: 'embedded-image' }))
  });
  const text = decodeEntities(result.value
    .replace(/<h([1-6])[^>]*>/g, (_, level) => '\n\n' + '#'.repeat(Number(level)) + ' ')
    .replace(/<img\b[^>]*>/g, '[embedded image]')
    .replace(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/g, (_, _tag, cell) => cell.replace(/<\/p>/g, '\n').replace(/<p\b[^>]*>/g, '').trimEnd() + '\t')
    .replace(/<\/td>/g, '\t').replace(/<\/tr>/g, '\n')
    .replace(/<\/(p|h[1-6]|table|li)>/g, '\n\n').replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]*>/g, '')).replace(/[ \t]+\n/g, '\n').trim();
  const units = [];
  let offset = 0;
  for (const part of text.slice(0, MAX_TEXT).split(/\n\s*\n/)) {
    const content = part.trim();
    if (!content) continue;
    units.push({ paragraph: units.length + 1, text: content, offset });
    offset += Array.from(content + '\n\n').length;
    if (units.length >= 50000) break;
  }
  return { format: 'docx', units, images, truncated: text.length > MAX_TEXT || units.length >= 50000,
    warnings: result.messages.length ? ['Some Word elements may not have been converted; layout is not preserved.'] : [],
    location: 'Extracted paragraph numbers; Word page layout is not inferred. Table cells are separated by tabs.' };
}

async function pdf(bytes, request) {
  const loading = getDocument({ data: new Uint8Array(bytes), verbosity: 0,
    isEvalSupported: false, useWorkerFetch: false, useSystemFonts: true,
    cMapUrl: resourceDirectory('cmaps'), standardFontDataUrl: resourceDirectory('standard_fonts'),
    wasmUrl: resourceDirectory('wasm'), maxImageSize: 16_000_000, canvasMaxAreaInBytes: 64_000_000 });
  try {
    const document = await loading.promise;
    const from = request.from ?? 1, to = Math.min(request.to ?? MAX_PAGES, document.numPages);
    if (from > document.numPages) fail('DOCUMENT_PAGE_RANGE');
    if (request.action === 'render') {
      const pictures = [];
      for (const number of request.pages) {
        if (number > document.numPages) fail('DOCUMENT_PAGE_RANGE');
        const page = await document.getPage(number), initial = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 2400 / Math.max(initial.width, initial.height), Math.sqrt(6_000_000 / (initial.width * initial.height)));
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
        pictures.push({ page: number, data: canvas.toBuffer('image/png') });
        page.cleanup();
      }
      return { format: 'pdf', totalPages: document.numPages, pictures };
    }
    const units = [];
    let characters = 0, textTruncated = false;
    for (let number = from; number <= to; number++) {
      const page = await document.getPage(number), content = await page.getTextContent();
      let text = '', y, endX;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const nextY = item.transform[5];
        const newLine = y !== undefined && Math.abs(nextY - y) > 3;
        if (text && newLine && !text.endsWith('\n')) text += '\n';
        const fontSize = Math.max(1, Math.hypot(item.transform[2], item.transform[3]));
        const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text)
          && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(item.str);
        if (!newLine && endX !== undefined && !/\s$/.test(text) && !/^\s/.test(item.str)
          && item.transform[4] - endX > Math.max(1, fontSize * (cjk ? 0.6 : 0.15))) text += ' ';
        const addition = item.str + (item.hasEOL ? '\n' : '');
        const remaining = Math.max(0, MAX_TEXT - characters - text.length);
        text += addition.slice(0, remaining);
        if (addition.length > remaining) textTruncated = true;
        y = nextY;
        endX = item.transform[4] + item.width;
        if (text.length + characters > MAX_TEXT) break;
      }
      if (text.length + characters > MAX_TEXT) { text = text.slice(0, MAX_TEXT - characters); textTruncated = true; }
      text = text.trim(); characters += text.length;
      units.push({ page: number, text, needsImage: text.replace(/\s/g, '').length < 20 });
      page.cleanup();
      if (characters >= MAX_TEXT) break;
    }
    return { format: 'pdf', totalPages: document.numPages, units,
      truncated: (units.at(-1)?.page ?? 0) < to || characters >= MAX_TEXT || textTruncated,
      indexedFrom: from, indexedTo: units.at(-1)?.page ?? from,
      warnings: units.some(unit => unit.needsImage) ? ['Pages with little or no extracted text require view with explicit page numbers; OCR is not inferred.'] : [] };
  } finally { await loading.destroy(); }
}

if (!isMainThread) {
  // No external resources are needed. PDF built-in resources use package-local
  // Node factories; Word external relationships remain disabled above.
  globalThis.fetch = async () => { fail('DOCUMENT_EXTERNAL_RESOURCE'); };
  try {
    const { format, bytes, request } = workerData;
    if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024) fail('DOCUMENT_LIMIT');
    const result = format === 'pdf' ? await pdf(bytes, request) : format === 'docx' ? await word(bytes, request) : fail('DOCUMENT_UNSUPPORTED');
    parentPort.postMessage({ result });
  } catch (error) {
    const code = error?.name === 'PasswordException' ? 'DOCUMENT_PASSWORD_REQUIRED'
      : /^DOCUMENT_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'DOCUMENT_PARSE_FAILED';
    parentPort.postMessage({ error: code });
  }
} else if (process.argv.includes('--health')) {
  createCanvas(1, 1).toBuffer('image/png');
  if (!getDocument || !mammoth.convertToHtml || !unzipSync) fail('DOCUMENT_DEPENDENCY_UNAVAILABLE');
  console.info(`DOCUMENT_READER ready pdfjs=${pdfVersion}`);
}
