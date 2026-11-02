# Upstream origin

This directory contains the standalone apply-patch implementation from OpenAI Codex `rust-v0.80.0`, commit `f0679a6ab2563135e01cc922698cb54921a1719f`, <https://github.com/openai/codex/tree/f0679a6ab2563135e01cc922698cb54921a1719f/codex-rs/apply-patch>. The upstream Apache-2.0 license is included as `LICENSE`.

Local modifications: the crate is detached from the upstream Cargo workspace, its dependency versions are recorded in Cargo.toml and Cargo.lock, and upstream test code was removed. Consistently CRLF input is normalized for matching and written with CRLF; other matching/file algorithms retain this older implementation. Windows same-file/case-only moves are detected through volume/file identity and refused before writing; use an intermediate filename. This prevents the older write-then-delete algorithm from deleting its own destination. Multi-file updates are not atomic. This version predates later upstream patch changes; compatibility is not assumed.
