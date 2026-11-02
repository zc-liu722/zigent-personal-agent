---
name: coding
description: Clone, understand, modify, build, run, and reproduce software projects in persistent execution workspaces, then deliver source and results.
---

## Execution platform

Use the actual platform, shell, Python command, helper paths and skills directory in the execution context. The Windows product runtime uses PowerShell 7 (`pwsh`) under a dedicated standard account, with network and localhost access enabled. It is full access for that account; conversations are not separate OS sandboxes. Production configuration/model credentials and other Agent accounts remain outside its permissions. Do not run administration or change the product runtime from a model command.

On Windows use native PowerShell syntax and Windows paths. Do not paste Bash commands or `/opt` and `/workspace` paths into PowerShell. Any Linux examples below apply only when the context reports a legacy Linux runtime. `$env:ZIGENT_WORKSPACE` is the current project root, `$env:ZIGENT_HELPERS` contains `word.py`, `pdf.py`, `render_docx.py` and `render_pdf.py`, and `$env:ZIGENT_SKILLS` contains task resources. `python` and `node` select the versioned managed runtime. Install extra dependencies into the project, never the read-only managed runtime. Node programs can use `createRequire(process.env.ZIGENT_NODE_PACKAGE)` for bundled packages.

Windows render examples:

```powershell
python "$env:ZIGENT_HELPERS\render_docx.py" '.\report.docx' --output_dir '.\review\word' --emit_pdf
python "$env:ZIGENT_HELPERS\render_pdf.py" '.\report.pdf' --output_dir '.\review\pdf'
```

`tty=true` provides ConPTY. A command returned with `session_id` continues independently of the frontend. Ctrl-C in a PTY is terminal input; a program can handle it and PowerShell may return 0 even when its child prints KeyboardInterrupt, so inspect output and poll for actual termination; Ctrl-C for a pipe command terminates its Job. A foreground shell exiting cleans up its remaining children; keep background servers attached to their returned command session. Service/host restart interrupts running execution jobs and never replays commands. Ordinary application reconnects preserve live sessions and cursors.

# Software projects

Use a persistent Agent-owned workspace so later conversations can continue the same project. Open the intended project or create one; materialize only authorized input files. Read the repository README and scoped instructions before changing code.

All free-form commands, generated programs and dependency installation use the configured execution service. Use its declared permissions and platform. If it is unavailable, report that exact state; never switch to the control-plane service account or an undeclared execution backend.

## Work autonomously within the task

1. Clone or open the repository. Record its source URL and exact commit. Inspect its language, package manager, lockfiles, entry points, data/weights and compute requirements.
2. Create project-specific environments and install tools/dependencies inside the assigned account or execution instance. Do not alter Zigent's deployed application, shared credentials or other Agents' data.
3. Implement the user's goal. Prefer coherent, minimal architecture and established dependencies. Use apply_patch for source editing and re-read changed files when a version conflict is reported.
4. Build, start the relevant example or execute the authorized reproduction. Follow the user's and repository's verification requirements. Do not add or run automated tests unless the user explicitly requested them for the current task.
5. Keep long-running commands as managed jobs. Read bounded log increments, retain full diagnostics and send Ctrl-C through write_stdin. A wait timeout does not mean the process stopped.
6. Review the diff and actual outputs. Distinguish repository downloaded, build completed, demo running, minimum experiment reproduced and target metric reproduced. Missing data, weights, credentials or GPU must be reported precisely.

For transient DNS, connection or TLS failures, retry idempotent reads and downloads with a small bounded budget and backoff. Preserve the exact errors, distinguish a failed attempt from confirmed backend unavailability, and reconcile partial downloads before retrying.

Runtime/account permissions are not publication authorization. Prepare deployable outputs first, then request approval before external publishing or administrator-level host changes. Existing explicit authorization remains valid within its scope.

## Deliver and continue

Publish actual source bundles, reports, datasets or executables through the artifact API. Include the exact revision, environment/lock information, launch instructions, completed verification and material limitations. A process ID or local path is not a downloadable artifact.

Keep source, user data, important results and reproduction materials long-term. Virtual environments/build caches may be cleaned only when registered as reproducible and not actively used. Never classify arbitrary files or model weights as temporary based only on their directory name.

For shared projects, use the explicit grant and workspace write coordination. Do not read another Agent's folders or infer a share from a filename. On interrupted runs, reconcile saved files and job states before repeating actions with side effects.

## Commands, files and delivery

Use workspaces to open/import the authorized project. Use exec_command for shell commands, file reads, dependency discovery and generated programs; apply_patch for source edits; write_stdin to continue returned command sessions and view_image for rendered pages. Commands run in the persistent workspace path from context. Skill paths are supplied there. There is no separate native document-editing tool. Use installed libraries, ordinary helper scripts and soffice/Poppler for conversion, recalculation and rendering. Wait for authoring commands to finish before saving final artifacts; unrelated background servers may keep running.

Save selected versions through artifact_files save with resultId and expectedHash, then deliver the complete requested items manifest with requestKey. Check delivery_status; retry using the original deliveryId and saved versions. Preserve originals and important project files.

Python is /opt/zigent-python/bin/python; Node packages are in /opt/zigent-file-runtime/node_modules. ESM programs can use createRequire('/opt/zigent-file-runtime/package.json') to load those packages. Inspect actual imports/tools/fonts before relying on them. Install project-specific dependencies inside the execution environment.
