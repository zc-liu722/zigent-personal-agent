---
name: xlsx
description: Analyze, create, and edit Excel workbooks with formulas, formatting, charts, recalculation, and verified values.
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

# Excel workbooks

Inspect workbook structure before editing: sheet names, used ranges, formulas, cached values, merged cells, tables, charts and external links. Preserve the uploaded original. Generated scripts use `python3` inside the isolated execution image; check imports there and do not use Windows production paths.

Use openpyxl to modify existing XLSX workbooks. Use pandas for analysis and transformations when useful, then write only the intended ranges back. A DataFrame is not a workbook: a pandas read/write round trip can lose formats, formulas, drawings and other workbook features.

Run generated scripts through the isolated backend. Install project-specific packages there if needed. Use ordinary library programs and soffice/Poppler scripts for inspection, rendering, conversion and recalculation.

## Formula and data rules

- Retain formulas where the workbook is meant to respond to changed inputs. Do not replace formulas with today's static results without user intent.
- openpyxl writes formulas but does not evaluate them. `data_only=True` reads previously cached results and can return stale or missing values.
- Check data types, dates, units, percentages, currency, rounding and missing values. Do not silently coerce identifiers with leading zeroes to numbers.
- Use explicit ranges, bounded iteration, and streaming reads for large files. Avoid visiting a million empty formatted rows.
- Preserve unrelated sheets and objects. Keep external links, macros, dynamic arrays and pivot features under explicit capability checks; do not claim full Excel compatibility.

## Recalculate and check

Save to a new file. Recalculate through the configured LibreOffice engine when formulas are added/changed or refreshed results are required. Reopen both formula and cached-value views. Check key business totals independently and inspect formula errors such as #REF!, #VALUE!, #DIV/0!, #NAME? and #N/A in relevant ranges.

LibreOffice may interpret some Excel-specific formulas differently. A `recalculated` check establishes an engine operation, not business correctness or complete Excel compatibility. Inspect important inputs/outputs and identify unsupported features.

For formatting or report changes, render representative sheets/ranges and inspect layout, number formats, headers, print area, chart labels and page breaks. Publish the editable XLSX and optional previews/PDF only after actual file creation. Retain immutable earlier versions and include a concise result summary with important assumptions.

## Commands, files and delivery

Use workspaces to open/import the authorized project. Use exec_command for shell commands, file reads, dependency discovery and generated programs; apply_patch for source edits; write_stdin to continue returned command sessions and view_image for rendered pages. Commands run in the persistent workspace path from context. Skill paths are supplied there. There is no separate native document-editing tool. Use installed libraries, ordinary helper scripts and soffice/Poppler for conversion, recalculation and rendering. Wait for authoring commands to finish before saving final artifacts; unrelated background servers may keep running.

Save selected versions through artifact_files save with resultId and expectedHash, then deliver the complete requested items manifest with requestKey. Check delivery_status; retry using the original deliveryId and saved versions. Preserve originals and important project files.

Python is /opt/zigent-python/bin/python; Node packages are in /opt/zigent-file-runtime/node_modules. ESM programs can use createRequire('/opt/zigent-file-runtime/package.json') to load those packages. Inspect actual imports/tools/fonts before relying on them. Install project-specific dependencies inside the execution environment.
