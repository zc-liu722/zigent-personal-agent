// Image rendering can remain silent for several minutes, independently of the
// text-model progress deadline. Keep one default for both image transports.
export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 10 * 60_000;
