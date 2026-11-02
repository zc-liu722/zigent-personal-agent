# Repository-owned execution module

OpenAI Codex sources: https://github.com/openai/codex . Apache-2.0; see LICENSE
and the retained upstream NOTICE. No Ratatui code is included. Windows ConPTY source retains the WezTerm MIT notices; see terminal/src/win/LICENSE.wezterm. Third-party Cargo
licenses are collected from the locked registry sources into the release image.
`upstream-files.json` records original source hashes and local paths.

## Terminal and process library

Fixed upstream tag `rust-v0.166.0`, commit
`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, directory `codex-rs/utils/pty/src`.
Included: child ownership/reaping, explicit launch settings, POSIX child launcher,
Linux descriptor cleanup and fresh-process setup helper, pipe I/O, PTY I/O,
process handles, Unix signals/process groups, Windows ConPTY, input normalization, process attributes and Job Objects. The local crate is `zigent-terminal`.

Local changes: detached Cargo workspace; locked registry dependencies; omitted upstream test modules; renamed the Linux setup argument to `--zigent-process-setup`. Windows is the default product target. ConPTY and pipe children enter a Job at CreateProcessW time, with kill-on-close, no breakaway, memory/process/CPU limits. The Zigent pipe adapter reuses the pinned Windows command/environment and process-attribute helpers, restricts inherited handles and creates a Job before launch. Commands receive only explicit environment variables. After root exit the supervisor explicitly closes ConPTY while its reader is active, allowing Windows 10 output EOF without requiring Windows 11 ReleasePseudoConsole. Descendants are stopped when the command ends; detached grandchildren are not preserved. Original Unix code remains for legacy recovery/development, not the default execution service.

## Patch library

Fixed upstream tag `rust-v0.80.0`, commit
`f0679a6ab2563135e01cc922698cb54921a1719f`, directory `codex-rs/apply-patch`.
Included: patch grammar/parser, context matching, text add/update/move/delete,
invocation parser and standalone executable. Local changes: detached manifest,
locked dependencies, removed upstream test code, and CRLF-preserving text updates for consistently CRLF files, and an actual Windows volume/file-ID check rejecting same-file/case-only moves before writing. Use two moves through an intermediate name for case-only renames. See `patch/UPSTREAM.md`.
The newer 0.166 patch crate depends on the remote executor filesystem; that
subsystem is deliberately excluded. The older grammar/file algorithm is not
claimed equivalent to later Codex versions (notably CRLF/encoding and filesystem
edge behavior). Patches are not multi-file atomic transactions.

## Zigent integration and excluded systems

`runner/` is Zigent-maintained code: one command per process, bounded JSON frames,
base64 byte output, stdin, SIGINT, termination, timeout and output draining.
`native_engine.py` bridges that narrow protocol to the existing durable worker.
The existing worker owns sandbox policy, identities, concurrency, output budgets,
platform-specific teardown, synchronization and recovery. `windows_engine.py` uses named Jobs, dedicated standard Windows accounts and explicit runtime/environment whitelists. Full network/localhost access is intentional; same-Agent conversations are not OS-isolated. No command replay on failure.

Excluded: Codex CLI, app-server, core/model orchestration, login/accounts,
telemetry, network services and upstream sandbox implementations. No Codex
executable is downloaded or launched by this module. The tiny setup helper
reexecutes this independently built module solely to configure child descriptors
and controlling terminals before target exec.

## Build and update

`cargo build --release --locked --workspace` in this directory builds
`zigent-execution` and the standalone `codex-apply-patch` (installed as
`apply_patch`). The Windows runner builds from the exact release commit with Rust 1.99.1, MSVC and Windows SDK. Rust/MSVC/Cargo are build prerequisites only. The product includes the two executables, common durable worker and a locked Windows Python/Node/headless LibreOffice/font capsule. Existing Codex model routing/delegation dependencies remain separate. WSL/Docker are used only by retained legacy recovery paths. Source hashes, Cargo.lock, executable hashes, actual dependency files and host font configuration bind the runtime identity. Upstream upgrades require review and actual terminal/document verification; never fetch a full CLI as fallback.
