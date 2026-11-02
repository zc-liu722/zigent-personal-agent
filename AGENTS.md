# Repository instructions

This repository is the independent community preparation tree for Zigent.

- Keep it private until the owner explicitly requests public release. Do not change repository visibility automatically.
- Work only in this checkout. Do not operate upstream production services or import their credentials, user data, diagnostics, local snapshots, workflows, or Git history.
- Prioritize rapid iteration. Do not add or run automated tests unless the user explicitly requests them for the current task. Do not require browser previews or screenshots for frontend edits unless requested.
- Keep type checking, compilation, dependency locks, third-party notices, and necessary packaging checks. Do not add test runners or deployment gates.
- There is no automatic production deployment from this repository. Commit and push authorized changes to this repository only; never infer authority to publish publicly.
- Import upstream changes only with the exact allowlist and reviewed sanitization in tools/upstream. New upstream files require review. Inspect generated changes and scan for secrets before committing.
- Preserve community-specific changes in tools/upstream/overlays, or explicitly update the export policy. The exporter refuses to overwrite independently modified managed files.
- Name model routes using full family-version-supplier identities. Keep apiModel separate, preserve verified context/reasoning metadata, and keep subscription routes at zero monetary cost while recording reported tokens.
- Read src/tools/AGENTS.md before changing tools. Keep activities concise and do not display credentials, raw private documents, or tool payloads in activity trails.
