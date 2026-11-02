import { interactionUrl } from './interaction-model.js';

/** Share the same URL extraction and scheme/credential policy across event cards. */
export function scheduleLink(text) {
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"'）)]+/gi)) {
    const url = interactionUrl(match[0].replace(/[，。,.；;！!？?、]+$/, ''));
    if (url) return url;
  }
  return '';
}
