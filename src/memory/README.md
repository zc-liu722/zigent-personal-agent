# Markdown memory

The current architecture, primary-source comparison, implemented improvements and
next-stage design are documented in [DESIGN.md](DESIGN.md).

`storage.longTermMemory` names an Agent-owned directory (`data/<agent>/memory`).
Memory bodies are real UTF-8 Markdown files: `agent-soul.md`, `behavior-rules.md`,
`users/<owner hash>/long-term-memory.md`, and that user's `archives/*.md`.
The metadata file stores scope identifiers, archive titles, confirmation receipts,
and extension metadata, never a duplicate of the Markdown bodies.

`CURRENT` selects a complete directory under `generations/`. Reads follow that
pointer; writes stage every document and its metadata, read them back, then
atomically rename the pointer. The current and two previous generations are kept.
A failed write cannot publish half an archive move or an incomplete batch.
Persona and shared rules stay Agent-wide; private Markdown and archives stay scoped
to their original users. Group conversations still receive no private documents.

The Agent's `long_term_memory.read` returns Markdown strings and a revision.
`replace` supplies unique exact `oldText` and `newText` (empty deletes a passage);
`append` supplies text including newlines. Archives additionally support `create`
and whole-file `delete` with the complete original body. Every replacement matches
the original document, not the result of an earlier edit. Overlaps, ambiguous or
missing matches, changed revisions, and unsupported proposal formats are rejected.
All files in a proposal are validated before a preview is emitted. Confirmation
repeats that same patch against fresh stored content inside the serialized writer.
Retries use the receipt stored atomically alongside the Markdown. Direct user
editing saves only the selected file through the authenticated existing web path.

## Edited conversation history

Editing a web user message soft-deletes that original message and all later
messages in the same conversation. `web_messages.deleted_at` records the edit
time, and `deleted_by_edit` identifies the replacement request. In model memory,
`messages.deleted_at` and `rewind_from_turn` retain the discarded turns with their
original IDs, content, summaries, tool/activity traces, question answers and image
references. Subsequent edits affect only active rows; original deletion metadata
is preserved. Turn numbers are never reused, and token/cost accounting continues
to include work already performed without counting retained rows twice.

Ordinary web reads, action lookup, document context, model context, conversation
history search and image reactivation exclude deleted messages. Restart recovery
also leaves their stored content unchanged. The existing private
`inspect-model-conversations.yml` workflow includes them in both metadata and
full conversation exports, with deletion metadata in JSON and a visible label in
the audit HTML. Select the exact session ID (or `latest`) for the complete history.
No automatic purge is applied. This preserves future edits; messages hard-deleted
before this change cannot be reconstructed from ID-only rewind markers.

## Context budgets and checkpoints

Every catalogue route declares `context`: the exact supplier's window and output
limits, their sources/date, and a `summary`, `openai-native`, `anthropic-native`,
or `runtime` strategy. Protocol compatibility alone never enables native
compaction. ZenMux OpenAI routes prefer its documented compact endpoint;
unsupported native calls fall back to portable structured summaries and are not
probed again for an hour. Claude through ZenMux, DeepSeek and Kimi currently use
portable summaries. Codex App Server owns native compaction inside its tool loop;
Zigent also bounds admission into each new adapter invocation.
The adapter leaves Codex's native auto-compaction limit to its model catalogue;
it never overwrites that limit with Zigent's conservative cold-start estimate.

The old implicit 32,000-token Agent cap has been removed. An explicit
`memoryContextWindowTokens` remains an operator cap, and an explicit
`memoryCompressionRatio` remains an override. Otherwise the selected route's
window, output reservation, safety margin and trigger policy determine the
budget. Supplier `/models` metadata overrides the configured manufacturer baseline.
When a supplier has no explicit window, use the exact model/version's official
manufacturer specification, with `limitSource`, documentation and verification date
in both catalogues. Do not substitute an arbitrary 32K/256K window. Codex's
reported effective window takes precedence over a public API model's capacity.
All deployed routes have documented windows. Legacy unverified estimates are
advisory only: fixed instructions/tools may already exceed such an estimate, so
failure to shrink a request to it must not block a supplier call. Verified
manufacturer/supplier limits, runtime-reported windows and explicit operator caps
remain hard limits. Exact numeric rejection limits stay scoped to the current run
and also bound its summary requests; estimated request sizes never shrink the model
window for other conversations. Explicit account context restrictions (including
Kimi's numeric 403 entitlement limits) permit compression; missing model access does not.

The gateway checks complete requests before every model round and every fallback
route, including instructions, tool schemas, images and tool results. Unicode
estimates are conservative approximations, calibrated with comparable HTTP
request usage; cached tokens already included in input are never added twice.
Aggregate adapter usage is not mistaken for a context-window measurement.
An upstream context rejection permits one same-route compact-and-retry, never a
repeat of tools already executed. Irreducible oversized current input on a verified
limit enters the existing model-fallback/confirmation path instead of silently
truncating the user's request. An unverified estimate alone never proves supplier
overflow. Current-only prefixes are not summarized: restoring the required
original input alongside its summary cannot save space. Progress is announced
only for a compressible prefix. Recovery from a real overflow requires a smaller
request before a same-route retry; a rejected native replay may instead retry the
original portable representation.

Old bulky tool observations are cleared only when exact run-local retrieval is
available, with recent/protected tools and pending confirmations retained.
`conversation_history.read_live_tool` reads the original by call ID and expected
hash; clearing never executes that tool again. Projection edits stay stable within
the run, while summaries always consume unmodified source messages.
Summaries preserve goals, constraints,
decisions (including rejected approaches), current state, evidence references and
next actions. They are incremental, chunked to fit the summarizer's own budget,
and checked for complete sections, truncation and actual space recovery before
publication. Reasoning output has a separate reservation from checkpoint text.
Complete recent turns stay verbatim; a long single turn can be cut only between
closed tool exchanges while its original user input and image anchors remain.

Portable historical checkpoints use the first retained turn as their boundary.
Exact-route request checkpoints are stored separately in `context_checkpoints`
without replacing original messages or audit traces. Prefix fingerprints and
route/protocol/supplier/API-model binding prevent reuse after edits or incompatible
fallback; native blocks are replayed unchanged and only on their original route.
Credential rotation also invalidates the binding. A native replay rejected by
the supplier gets one portable rebuild from originals without repeating tools.
Rewinds invalidate checkpoints; forks rebuild from their own original messages.
Image-bearing in-memory anchors are not serialized as Buffer JSON checkpoints.
Checkpoint writes are atomic; failed/partial summaries cannot advance history.
Checkpoints also retain bounded deterministic provenance, generation and numeric
diagnostics. Every fourth portable generation rebuilds from source still available
to the run; earlier session archives remain accessible through history retrieval.
Hashes verify source identity, not semantic completeness of a summary.
All actual compaction usage is metered through the existing supplier cost policy,
including zero monetary cost for subscriptions and ordinary cache-write tokens.

`GET api/models/context?model=<canonical-name>` reports effective policy through
the existing authenticated web path. `diagnose-agent-runtime.yml` with an explicit
Agent and `context_only=true` checks deployed policy and storage counts without
reading conversation content or making model calls.

## Recall and indexing

Personal Markdown is loaded in full in private conversations and authorized
background tasks, independent of query keywords, profile size or model route.
Soul and shared rules also stay complete. Personal context is outside the stable
system prefix and pinned against conversation compaction. Full request admission
still accounts for all memory text. Group conversations receive no private profile
or archive titles. Archive bodies remain on demand: `long_term_memory.search`
locates passages, and `read_archive` reads one complete archive by exact title.
Memory documents have no paginated body-read action; `read` returns the complete
profile and shared rules.

Visible conversation content and form answers have rebuildable SQLite FTS5
indexes. Phrase matching preserves literal substring behavior; lexical all/any
queries support Unicode words and CJK character pairs. Source access and deletion
filters apply before result projection. Thought/tool traces remain opt-in and are
not copied into the visible-content index. Index maintenance is incremental,
bounded and resumable. Search exposes partial coverage and continuation when
fallback source scanning or candidate paging is needed. Source hashes support
consistent paginated reads. No embedding provider or graph database is required.

Markdown reads cache a verified generation and file-stat fingerprint, returning
cloned values. Changed files, a new CURRENT pointer, commits and restores invalidate
the cache; maintenance reads continue to read the stored files directly.

## Maintenance

Runtime initialization creates an empty Markdown store only when no published
pointer or retained generation exists. Missing files in an existing generation
require recovery and never cause an empty store to replace existing memory.

After startup, deployment runs `node dist/memory/maintenance.js verify <manifest>`.
It reads all referenced Markdown files and reports format and scope counts only.
No private bodies enter logs or Git. Deployment and rollback verify the selected
manifest's Markdown store; code releases never copy development memory or replace
conversation databases.

Role inspection uses the strictly read-only Markdown reader. Reviewed role
maintenance stages an ACL-protected draft, compares the complete current
generation, publishes a new one with the Agent stopped, and can restore its
retained previous generation if readiness fails. It never edits running files.
The maintenance CLI retains only `verify`, `promote`, and `restore` operations.

Per repository policy, verify changes by code review, type checking, compilation,
release packaging and deployment health checks. Do not run automated test suites
unless explicitly requested for the current task.
