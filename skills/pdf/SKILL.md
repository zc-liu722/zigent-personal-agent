---
name: pdf
description: Read, generate, edit, fill, compare, redact and visually verify PDF files through the bundled command tools, mature libraries and reusable scripts.
---

## Execution platform

Use the actual platform, shell, Python command, helper paths and skills directory in the execution context. The Windows product runtime uses PowerShell 7 (`pwsh`) under a dedicated standard account, with network and localhost access enabled. It is full access for that account; conversations are not separate OS sandboxes. Production configuration/model credentials and other Agent accounts remain outside its permissions. Do not run administration or change the product runtime from a model command.

On Windows use native PowerShell syntax and Windows paths. Do not paste Bash commands or `/opt` and `/workspace` paths into PowerShell. Any Linux examples below apply only when the context reports a legacy Linux runtime. `$env:ZIGENT_WORKSPACE` is the current project root, `$env:ZIGENT_HELPERS` contains `word.py`, `pdf.py`, `render_docx.py` and `render_pdf.py`, and `$env:ZIGENT_SKILLS` contains task resources. `python` and `node` select the versioned managed runtime. Install extra dependencies into the project, never the read-only managed runtime. Node programs can use `createRequire(process.env.ZIGENT_NODE_PACKAGE)` for bundled packages.

Windows render examples:

```powershell
python "$env:ZIGENT_HELPERS\render_docx.py" '.\report.docx' --output_dir '.\review\word' --emit_pdf
python "$env:ZIGENT_HELPERS\render_pdf.py" '.\report.pdf' --output_dir '.\review\pdf'
```

`tty=true` provides ConPTY. A command returned with `session_id` continues independently of the frontend. Ctrl-C in a PTY is terminal input; Ctrl-C for a pipe command terminates its Job. A foreground shell exiting cleans up its remaining children; keep background servers attached to their returned command session. Service/host restart interrupts running execution jobs and never replays commands. Ordinary application reconnects preserve live sessions and cursors.

# PDF files

Preserve the uploaded original and work in the persistent `/workspace`. Use `exec_command` to inspect files/run programs, `apply_patch` to edit program source, `write_stdin` to continue command sessions and `view_image` for real page inspection. Read task resources under `/opt/zigent-skills/pdf/tasks` with ordinary shell commands.

| Task | Resource |
| --- | --- |
| Text/positions, OCR and generation | `tasks/read-create.md` |
| Merge/split/order/rotate/crop, annotations/bookmarks | `tasks/pages.md` |
| Form tree, values, widgets and appearance | `tasks/forms.md` |
| Actual content removal and verification | `tasks/redact.md` |
| Compare, review and programming | `tasks/review.md` |

Use ReportLab for generation; pypdf/PyMuPDF for modifications and forms; pdfplumber for layout-aware extraction; Tesseract for needed scanned pages. Python and helpers are under `/opt/zigent-python` and `/opt/zigent-file-runtime`; inspect actual dependencies and fonts. Write the program needed for the complete user goal. Reusable `word.py`/`pdf.py` helpers are ordinary libraries, not a fixed-operation tool boundary.

Inspect encryption, native/scanned/mixed pages, page geometry, fields and annotations before editing. PDF-to-Word does not guarantee editable original structure. For reflow, verify source pages and create an editable source before rendering the PDF; deliver that source only if requested. Check important OCR names/numbers/dates against pages. Use an approved password flow; never guess or log passwords.

Render final pages with `python3 /opt/zigent-file-runtime/render_pdf.py input.pdf --output_dir review/pdf --pages 1,2`. Omit --pages for all pages. Open returned page PNGs with `view_image`, fix defects and re-render. Render success is not visual review. Content, structure and layout require separate checks. For persistent review evidence, write `.document-checks.json` entries `{path,expectedHash,runtimeIdentity,kind,assessment,note,pages}` with kind content/structure/visual, assessment passed/issues, and short notes. Set runtimeIdentity from ZIGENT_RUNTIME_IDENTITY; old-runtime assessments are historical. Visual entries require pages already viewed from current source bytes.

Wait for the authoring command to finish. Background servers may continue; saving pins the selected file bytes. Save selected candidates with `artifact_files save`, stable resultId and expectedHash; revisions reuse fileId/expectedVersion. Deliver the complete requested items manifest with requestKey, check delivery_status and retry exact saved versions using deliveryId. Working files, conversions and page images stay in the workspace. Explicit inspection/workspace-only requests use keep_candidates. User previews/downloads pin exact immutable versions and do not invoke a model.
