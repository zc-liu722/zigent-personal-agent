# Composer keyboard avoidance

The [keyboard focus/closing tracker](https://github.com/emilkowalski/vaul/blob/3e97aac6a38e4481bade71d7233ed6002e80f9b0/src/index.tsx#L476-L534) in `../../composer-keyboard-viewport.js` is adapted from Vaul at commit `3e97aac6a38e4481bade71d7233ed6002e80f9b0`, checked on 2026-10-29. The upstream MIT license is preserved in `LICENSE.md`. React, Radix, drawer gestures and modal semantics are not included.

Mobile reading always uses the document, including while editing. The page, application shell and transcript do not become fixed or clipped during keyboard input. Only the composer follows the measured visual viewport while a keyboard is detected. On dismissal it returns to native `bottom: 0`, even if the textarea retains focus.

Composer lift and transcript-end visibility compare client rectangles in one coordinate space. The document root's client top converts `visualViewport.pageTop + height` into that space; `offsetTop + height` alone is not a client coordinate on all Safari versions ([WebKit bug 306779](https://bugs.webkit.org/show_bug.cgi?id=306779)). On a short conversation, native focus panning can leave a large visual/layout offset; subtracting that offset again would lower the composer behind the keyboard after its initial correct position. Measurements are refreshed after bottom-follow as well as on viewport events.

The transcript reserves the measured composer height plus keyboard occlusion, allowing its final message to scroll above the input. The existing reading-anchor mechanism preserves older reading positions and follows the bottom when appropriate; user drags and momentum suppress programmatic scroll writes. No scroll-owner transfer, reverse message flow or body fixation is used.

This replaces the keyboard frame because physical iPhone screenshots still showed bottom clipping after the earlier focus-lifetime fix. Fixed-root layouts and keyboard dismissal can interact with Safari's browser area: see [WebKit bug 232543](https://bugs.webkit.org/show_bug.cgi?id=232543). Keeping the transcript in document flow removes that application clipping boundary rather than trying to repair it after dismissal.

Viewport events still depend on the browser: [WebKit bug 265578](https://bugs.webkit.org/show_bug.cgi?id=265578) documents late keyboard viewport reports. A bounded 350ms recheck handles late measurements; pinch zoom retains the current layout. Build and deployment checks do not establish keyboard behavior on a physical iPhone.
