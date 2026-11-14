---
name: coding
description: Clone, understand, modify, build, run, and reproduce software projects in persistent execution workspaces, then deliver source and results.
---

## Execution platform

Use the actual platform, shell, Python command, helper paths and skills directory in the execution context. The Windows product runtime uses PowerShell 7 (`pwsh`) under a dedicated standard account, with network and localhost access enabled. It is full access for that account; conversations are not separate OS sandboxes. Production configuration/model credentials and other Agent accounts remain outside its permissions. Do not run administration or change the product runtime from a model command.

PowerShell 7 commands stop on unhandled PowerShell errors and nonzero native exits, including failures in pipelines. Expected nonzero results must be handled locally with try/catch and an explicit outcome; do not disable error handling for an entire batch. Legacy cmd/Windows PowerShell scripts must explicitly propagate child failures. A returned nonzero exit_code, failed execution state or workspace error is a failed tool result; retain its output and session for diagnosis.

On Windows use native PowerShell syntax and Windows paths. Do not paste Bash commands or `/opt` and `/workspace` paths into PowerShell. Any Linux examples below apply only when the context reports a legacy Linux runtime. `$env:ZIGENT_WORKSPACE` is the working root, `$env:ZIGENT_HELPERS` contains `word.py`, `pdf.py`, `render_docx.py` and `render_pdf.py`. `python` and `node` select the versioned managed runtime. Install extra dependencies into the project, never the read-only managed runtime. Node programs can use `createRequire(process.env.ZIGENT_NODE_PACKAGE)` for bundled packages.

Windows render examples:

```powershell
python "$env:ZIGENT_HELPERS\render_docx.py" '.\report.docx' --output_dir '.\review\word' --emit_pdf
python "$env:ZIGENT_HELPERS\render_pdf.py" '.\report.pdf' --output_dir '.\review\pdf'
```

`tty=true` provides ConPTY. A command returned with `session_id` continues independently of the frontend. Ctrl-C in a PTY is terminal input; a program can handle it and PowerShell may return 0 even when its child prints KeyboardInterrupt, so inspect output and poll for actual termination; Ctrl-C for a pipe command terminates its Job. A foreground shell exiting cleans up its remaining children; keep background servers attached to their returned command session. Service/host restart interrupts running execution jobs and never replays commands. Ordinary application reconnects preserve live sessions and cursors.

# Software projects

Use the existing project environment for project work. Otherwise `exec_command` provides a working directory. Create a long-term project only at the user’s request. Save requested outputs as immutable artifact versions. Read the repository README and scoped instructions before changing code.

All free-form commands, generated programs and dependency installation use the configured execution service. Use its declared permissions and platform. If it is unavailable, report that exact state; never switch to the control-plane service account or an undeclared execution backend.

## Work autonomously within the task

1. Clone or open the repository. Record its source URL and exact commit. Inspect its language, package manager, lockfiles, entry points, data/weights and compute requirements.
2. Create project-specific environments and install tools/dependencies inside the assigned account or execution instance. Do not alter Zigent's deployed application, shared credentials or other Agents' data.
3. Implement the user's goal. Prefer coherent, minimal architecture and established dependencies. Use apply_patch for source editing and re-read changed files when a version conflict is reported.
4. Build, start the relevant example or execute the authorized reproduction. Follow the user's and repository's verification requirements. Do not add or run automated tests unless the user explicitly requested them for the current task.
5. Keep long-running commands as managed jobs. Read bounded log increments, retain full diagnostics and send Ctrl-C through write_stdin. A wait timeout does not mean the process stopped.
6. Report progress only when there is a new finding, a meaningful phase change or a blocker. Tool activities cover routine reads, edits and commands. Retain completed results and live command IDs instead of repeating operations or announcing the same next step.
7. Review the diff and actual outputs. Distinguish repository downloaded, build completed, demo running, minimum experiment reproduced and target metric reproduced. Missing data, weights, credentials or GPU must be reported precisely.

For transient DNS, connection or TLS failures, retry idempotent reads and downloads with a small bounded budget and backoff. Preserve the exact errors, distinguish a failed attempt from confirmed backend unavailability, and reconcile partial downloads before retrying.

Runtime/account permissions are not publication authorization. Prepare deployable outputs first, then request approval before external publishing or administrator-level host changes. Existing explicit authorization remains valid within its scope.

## Deliver and continue

Publish actual source bundles, reports, datasets or executables through the artifact API. Include the exact revision, environment/lock information, launch instructions, completed verification and material limitations. A process ID or local path is not a downloadable artifact.

Keep source, user data, important results and reproduction materials in persistent projects or saved artifact versions when long-term retention is requested. An explicitly temporary task workspace expires as a whole after 24 hours; propose promotion before expiry if continued construction is valuable. Outside such a registered lifecycle, virtual environments/build caches may be cleaned only when registered as reproducible and not actively used. Never infer temporariness from filenames.

For shared projects, use the explicit grant and workspace write coordination. Do not read another Agent's folders or infer a share from a filename. On interrupted runs, reconcile saved files and job states before repeating actions with side effects.

## Commands, files and delivery

Read authorized attachments with `files read`. Import an attachment only when a program needs its path. Use the owning project or the working directory supplied by `exec_command`; continue processes with `write_stdin`. Use `skills files` only when a program needs packaged scripts or templates. Wait for authoring to finish before saving final versions.

Save selected versions through artifact_files save with resultId and expectedHash, then deliver the complete requested items manifest with requestKey. Check delivery_status; retry using the original deliveryId and saved versions. Preserve originals and important project files.

Python is /opt/zigent-python/bin/python; Node packages are in /opt/zigent-file-runtime/node_modules. ESM programs can use createRequire('/opt/zigent-file-runtime/package.json') to load those packages. Inspect actual imports/tools/fonts before relying on them. Install project-specific dependencies inside the execution environment.
