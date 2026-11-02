---
name: pptx
description: Create and edit native PowerPoint presentations, follow uploaded templates, and verify slide layout and chart editability.
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

# PowerPoint presentations

Use native editable PPTX as the deliverable. Start by opening the workspace and inspecting the input/template. Preserve the uploaded original and describe installed runtime dependencies before coding.

## Plan and implement

For a new presentation, derive an outline, slide size, visual hierarchy, fonts and restrained style from the user's purpose or supplied reference. PptxGenJS is installed in the managed execution runtime for authoring; python-pptx is available for inspecting and modifying existing decks. Execute generated scripts in the reported execution backend. For Node, a CommonJS `.cjs` script can use `require('pptxgenjs')` through the image's `NODE_PATH`; ESM imports do not use `NODE_PATH`, so resolve the installed package explicitly or install a project-local dependency. Never reuse native Windows runtime paths inside Linux.

For an existing deck, preserve its masters, themes, image relationships, speaker notes, layouts and untouched slides. Use python-pptx for supported modifications; inspect and edit OOXML carefully for unsupported elements. Avoid rebuilding all slides just to replace a few words. Do not silently discard animation, SmartArt, embedded media or charts.

Text should be real text boxes; diagrams should use editable shapes when practical. Data charts should retain their source data and native chart structure. Rasterize only elements that are intentionally images or cannot be represented faithfully; do not turn every slide into a screenshot unless the user explicitly wants an image deck.

Use slide masters and consistent margins. Prefer a clear message per slide, readable type, meaningful chart labels, adequate contrast and a coherent narrative. Keep source citations associated with claims and data. For Chinese, select installed CJK fonts and confirm glyphs in rendered output.

## Check and publish

Reopen the saved PPTX and verify slide count, key text, tables, chart data and required relationships. Convert to PDF with soffice in a fresh temporary user profile/output directory, then render page images with render_pdf.py. Inspect slide images for overflow, clipping, overlapping objects, tiny labels, image distortion and unintended layout changes. A successful render does not prove visual correctness.

Repair the affected slides and repeat focused rendering. Publish the native PPTX and optionally PDF, with a short description of completed changes. Save an immutable version so a later edit cannot alter the earlier delivery. If an advanced original feature cannot be preserved, identify it explicitly before claiming completion.

## Commands, files and delivery

Use workspaces to open/import the authorized project. Use exec_command for shell commands, file reads, dependency discovery and generated programs; apply_patch for source edits; write_stdin to continue returned command sessions and view_image for rendered pages. Commands run in the persistent workspace path from context. Skill paths are supplied there. There is no separate native document-editing tool. Use installed libraries, ordinary helper scripts and soffice/Poppler for conversion, recalculation and rendering. Wait for authoring commands to finish before saving final artifacts; unrelated background servers may keep running.

Save selected versions through artifact_files save with resultId and expectedHash, then deliver the complete requested items manifest with requestKey. Check delivery_status; retry using the original deliveryId and saved versions. Preserve originals and important project files.

Python is /opt/zigent-python/bin/python; Node packages are in /opt/zigent-file-runtime/node_modules. ESM programs can use createRequire('/opt/zigent-file-runtime/package.json') to load those packages. Inspect actual imports/tools/fonts before relying on them. Install project-specific dependencies inside the execution environment.
