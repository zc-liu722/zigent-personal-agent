---
name: pptx
description: Create and edit native PowerPoint presentations, follow uploaded templates, and verify slide layout and chart editability.
---

## Execution platform

Use the actual platform, shell, Python command, helper paths and skills directory in the execution context. The Windows product runtime uses PowerShell 7 (`pwsh`) under a dedicated standard account, with network and localhost access enabled. It is full access for that account; conversations are not separate OS sandboxes. Production configuration/model credentials and other Agent accounts remain outside its permissions. Do not run administration or change the product runtime from a model command.

On Windows use native PowerShell syntax and Windows paths. Do not paste Bash commands or `/opt` and `/workspace` paths into PowerShell. Any Linux examples below apply only when the context reports a legacy Linux runtime. `$env:ZIGENT_WORKSPACE` is the working root, `$env:ZIGENT_HELPERS` contains `word.py`, `pdf.py`, `render_docx.py` and `render_pdf.py`. `python` and `node` select the versioned managed runtime. Install extra dependencies into the project, never the read-only managed runtime. Node programs can use `createRequire(process.env.ZIGENT_NODE_PACKAGE)` for bundled packages.

Use `exec_command cache=render` for disposable crops, page images and conversion checks. The command starts in the render directory; use the working root to address the source. Use `view_image` for inspection and `image_assets present` to pin selected images. Keep editable sources and final files in the working directory.

Windows render examples (set `$imageRenderRoot` to the actual returned imageScratchDirectory first):

```powershell
python "$env:ZIGENT_HELPERS\render_docx.py" '.\report.docx' --output_dir (Join-Path $imageRenderRoot 'word') --emit_pdf
python "$env:ZIGENT_HELPERS\render_pdf.py" '.\report.pdf' --output_dir (Join-Path $imageRenderRoot 'pdf')
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

Keep preview troubleshooting bounded. If conversion of the deck fails, inspect that error and use at most one minimal known-good PPTX to distinguish a renderer/environment failure from a file-specific failure. When the minimal file also fails, or the established failure is environmental, stop trying additional office applications, browser previews, COM automation or runtime installations as substitute preview stacks. Complete the applicable structural checks, report visual verification as unavailable with the precise environment gap, and deliver the verified artifact rather than repeating equivalent checks. Do not claim that structural inspection proves visual correctness.

Progress text is not a verification step. After reporting a new rendering finding or a genuine phase change, continue silently through routine retries and checks; do not post successive "final check" or "continuing verification" messages. Once the available checks are complete and the artifact is ready, deliver it with any remaining verification limitation instead of announcing another review round.

## Commands, files and delivery

Read authorized attachments with `files read`. Import an attachment only when a program needs its path. Use the owning project or the working directory supplied by `exec_command`; continue processes with `write_stdin`. Use `skills files` only when a program needs packaged scripts or templates. Wait for authoring to finish before saving final versions.

Save selected versions through artifact_files save with resultId and expectedHash, then deliver the complete requested items manifest with requestKey. Check delivery_status; retry using the original deliveryId and saved versions. Preserve originals and important project files.

Python is /opt/zigent-python/bin/python; Node packages are in /opt/zigent-file-runtime/node_modules. ESM programs can use createRequire('/opt/zigent-file-runtime/package.json') to load those packages. Inspect actual imports/tools/fonts before relying on them. Install project-specific dependencies inside the execution environment.
