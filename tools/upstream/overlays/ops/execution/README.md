# Optional execution sources

This directory contains the generic durable worker, Windows and container backends, native process/patch implementation, image definition and license collection code. It does not contain an installation for any existing production host.

Build the independent native module with `cargo build --release --locked --workspace` in `native/`. Source origin and modifications are documented in `native/UPSTREAM.md`; preserve LICENSE and NOTICE.

The Dockerfile retains an optional document/execution runtime definition. Document library licensing, especially PyMuPDF/MuPDF, must be resolved for the intended distribution before publishing images. No image is built or published by this repository's default commands.

Windows execution requires a dedicated standard account, protected control configuration, explicitly provisioned runtime/dependencies and separate credentials. Existing machine provisioning, recovery, release and migration scripts are intentionally absent. Execution is disabled in the default Agent configuration. Configure and verify an isolated environment before enabling any execution tool.
