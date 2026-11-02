# Advanced Word operations

Use `word.edit(source,destination,{"actions":[...]})` or the underlying python-docx/lxml APIs. Anchor actions use the exact-match selectors from `tasks/edit.md`. Comments, tracked replacements, notes, bookmarks and controls currently require plain direct text runs in `word/document.xml`; protected ranges fail atomically. Use generated OOXML code when the requested structure exceeds that boundary.

| `type` | Required/optional action fields |
| --- | --- |
| `comment` | `oldText`, `text`, optional `author` |
| `comment_update` / `comment_delete` | existing comment `id`; update also requires `text` |
| `track_replace` | `oldText`, `newText`, optional `author` |
| `revisions` | `mode: accept/reject`, optional revision `id` |
| `bookmark` | `oldText`, unique `name` starting with a Latin letter, max 40 characters |
| `footnote` / `endnote` | `oldText`, `text` |
| `content_control` | `oldText`, `tag` |
| `field` | `instruction`, optional zero-based `paragraph`, optional `cached` result |
| `equation` | zero-based `paragraph`, `text` or native `omml` XML |

Revision accept/reject covers text insertion/deletion/movement; formatting revisions require an editor-aware method and are rejected instead of silently left unresolved. Comments are package structures with range/reference markers and relationships. Inspect their presence and content; a PDF render can omit comments.

Fields permit `TOC`, `REF`, `PAGEREF`, `SEQ`, `PAGE`, `NUMPAGES` and their switches. Add a bookmark before a corresponding `REF/PAGEREF`. Field insertion marks results dirty and requests update-on-open. **It does not evaluate the field.** Inspect each instruction, cached text and dirty flag. For headless refresh, convert a working DOCX to DOCX using a fresh LibreOffice profile and output directory, reopen it, compare fields and render the result. Check TOC headings, page numbers, reference targets, sequence values and total pages. If the converter leaves stale/empty/error values, use an appropriate editor refresh and report that remaining item. Do not flatten fields or substitute guessed page numbers to claim success.

Equations remain editable OMML. A plain `text` creates a basic math run; fractions, matrices and other constructs use structured `omml` rooted at `m:oMath` with Office math/Word elements only. Never inject external relationships or executable content.

`word.merge(master_path, additional_paths, destination)` composes additional DOCX files. The maintained docxcompose library remaps parts/relationships and preserves appended styles. The master controls headers/footers; inspect section boundaries, list numbering, notes, images and references after merging. If each source needs distinct section headers, implement and verify those sections explicitly through generated code.
