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

The Agent's `markdown read` returns a logical document's Markdown and revision.
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

Every catalogue route declares its exact context and output limits and a
`summary`, `openai-native`, `anthropic-native`, or `runtime` strategy. ZenMux GPT
routes prefer its documented compact endpoint. A rejected native endpoint or
replay pauses native compaction attempts for that route for an hour. Compatible
protocols alone do not establish support for native compaction.

Ordinary ChatGPT subscription chats persist one Codex App Server thread binding
per Zigent session. Consecutive turns on the same account, model route and tool
catalogue resume that thread with the new input. The App Server preserves its
native compaction state and controls its own auto-compaction threshold. A route
switch, history edit or fork, changed tool catalogue, or unavailable thread
rebuilds from active Zigent history. The binding is consumed before submitting
new input and published atomically with the next saved reply. A crash or a failed
turn therefore cannot introduce uncommitted native history on the next request.
Zigent continues to own the original conversation and tool journal.

The DeepSeek API documents that Responses `context_management` is unsupported.
Routes without a verified native mechanism use DeepSeek Harness's one-shot
compaction approach and its pinned upstream prompt. The summarization request
replays the routed prefix with its instructions and tool schema when supported,
appends the upstream directive and accepts a text checkpoint only. No host tool
executor is provided. The same approach serves as fallback when a verified native
endpoint fails. The previous Zigent rolling summaries remain in historical audit
records. New requests use original active messages and exact-route checkpoints.

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

The gateway checks HTTP requests before each model round and fallback, including
instructions, tool schemas, images and tool results. Runtime routes admit the new
input and leave native history pressure to the App Server when it owns the
thread. Unicode estimates are calibrated against comparable HTTP request usage.
One provider-confirmed context rejection can trigger a same-route retry after
reducing the request. Irreducible input enters the existing model-fallback path.

Old bulky tool results are replaced with exact references only when
`conversation_history.read_live_tool` is available. Recent and protected tools
and pending confirmations remain intact. A summary normally consumes the original
prefix. Tool-result references can make the same balanced span fit when the
summary request would otherwise exceed its own window. Closed tool exchanges,
the current user input and image anchors remain protected. The gateway rejects
empty, truncated or oversized summaries and only advances a checkpoint if the
replacement makes the request smaller.

`context_checkpoints` stores request checkpoints separately from original messages.
Prefix fingerprints and exact route/credential binding guard replay. Native items
stay bound to their original route, and rewinds invalidate checkpoints. Old
Zigent summary checkpoints are rebuilt from originals as needed. Image-bearing
anchors remain in memory instead of being serialized into SQLite. Actual
compaction usage is metered on its route, including zero monetary cost and actual
token usage for subscriptions.

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
or archive titles. Archive bodies remain on demand: `markdown search`
locates passages, and `markdown read` with the archive document ID reads one complete archive by exact title.
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
