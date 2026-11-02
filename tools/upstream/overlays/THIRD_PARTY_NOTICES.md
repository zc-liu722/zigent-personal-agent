# Third-party notices

Zigent includes third-party code and assets with their own license terms. The project's root license is still pending review; this file does not grant a new license or replace upstream notices.

| Component | Retained records |
| --- | --- |
| Independent native execution and patch code derived from OpenAI Codex | [Apache-2.0 LICENSE](ops/execution/native/LICENSE), [NOTICE](ops/execution/native/NOTICE), [UPSTREAM](ops/execution/native/UPSTREAM.md), [patch origin](ops/execution/native/patch/UPSTREAM.md), [file origins](ops/execution/native/upstream-files.json) |
| WezTerm portions of Windows terminal implementation | [MIT notice](ops/execution/native/terminal/src/win/LICENSE.wezterm) |
| KaTeX and bundled fonts | [LICENSE](web/vendor/katex/LICENSE), [source notes](web/vendor/katex/README.md) |
| highlight.js | [LICENSE](web/vendor/highlight/LICENSE) |
| Vaul-derived keyboard behavior | [LICENSE](web/vendor/vaul/LICENSE.md), [source notes](web/vendor/vaul/README.md) |
| Bundled document editor | [generated third-party license file](web/document-editor.LICENSE.txt) |
| Optional runtime font | [OFL](ops/execution/windows/FONT-OFL.txt), [versioned runtime metadata](ops/execution/windows/runtime-lock.json) |

The locked package declaration inventory is in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md). The scope, unresolved decisions and binary distribution considerations are in [docs/LICENSING.md](docs/LICENSING.md). Preserve each upstream notice when copying, rebuilding or distributing the relevant component.
