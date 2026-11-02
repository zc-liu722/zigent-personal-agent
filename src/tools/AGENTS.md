# Tool development requirements

Read `README.md` in this directory before adding or changing a tool.

Every local tool registration must define an `activity` presenter alongside its schema and executor. Treat the presenter as part of the tool's public contract, not optional UI polish. Implement and review all three lifecycle translations: `started(input)`, `completed(input, result)`, and `failed(input, error)`.

Translate only an allowlisted subset of raw fields into `ToolActivityPresentation`. Never pass raw input/output objects, credentials, access tokens, long document bodies, binary data, internal confirmation IDs, or generic JSON into the activity trail. Write messages as actions performed by the agent (for example, “我正在查找…”), never as implementation statements such as “正在调用 xxx 工具”.

Review representative inputs, outputs, hidden fields, and final rendered meaning without adding automated tests, following the repository's rapid iteration policy. A tool must not be registered without these translations.
