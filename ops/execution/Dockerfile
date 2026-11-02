# The resulting immutable image ID is recorded in the worker's controlled config.
# Build this image from the exact Git release; do not install into a running task.
FROM rust:1.99.1-bookworm AS execution-build
WORKDIR /build
COPY ops/execution/native/ ./
RUN cargo build --release --locked --workspace \
    && mkdir /licenses \
    && cargo metadata --locked --format-version 1 > /licenses/cargo-metadata.json
# Retain the full inventory above and the resolved graph for the shipped target.
RUN cargo metadata --locked --format-version 1 --filter-platform x86_64-unknown-linux-gnu > /licenses/linux-metadata.json
COPY ops/execution/collect-licenses.py /collect-licenses.py
RUN python3 /collect-licenses.py /licenses/linux-metadata.json /licenses/crates
FROM python:3.13-slim-bookworm AS python-runtime
FROM node:24-bookworm-slim
COPY --from=python-runtime /usr/local/ /usr/local/
COPY --from=python-runtime /etc/ssl/certs/ /etc/ssl/certs/
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
    python3 python3-venv python3-pip git openssh-client curl ca-certificates build-essential \
    libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils \
    tesseract-ocr tesseract-ocr-chi-sim fonts-noto-cjk fonts-liberation \
    libexpat1 libffi8 libsqlite3-0 libbz2-1.0 liblzma5 zlib1g \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ripgrep zip unzip file \
    && rm -rf /var/lib/apt/lists/*
COPY ops/file-runtime/requirements.lock ops/file-runtime/package.json ops/file-runtime/package-lock.json /opt/zigent-file-runtime/
RUN python3 -m venv /opt/zigent-python \
    && /opt/zigent-python/bin/pip install --no-cache-dir --only-binary=:all: --require-hashes \
      -r /opt/zigent-file-runtime/requirements.lock \
    && npm ci --prefix /opt/zigent-file-runtime --omit=dev --no-audit --no-fund
COPY --from=execution-build /build/target/release/zigent-execution /usr/local/bin/zigent-execution
COPY --from=execution-build /build/target/release/codex-apply-patch /usr/local/bin/apply_patch
COPY --from=execution-build /licenses/ /usr/share/zigent-execution/dependencies/
COPY ops/execution/native/LICENSE ops/execution/native/NOTICE ops/execution/native/UPSTREAM.md ops/execution/native/upstream-files.json /usr/share/zigent-execution/
COPY ops/file-runtime/word.py ops/file-runtime/pdf.py ops/file-runtime/render_docx.py ops/file-runtime/render_pdf.py /opt/zigent-file-runtime/
ENV PYTHONPATH="/opt/zigent-file-runtime"
ENV PATH="/opt/zigent-python/bin:/opt/zigent-file-runtime/node_modules/.bin:${PATH}"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV NODE_PATH="/opt/zigent-file-runtime/node_modules"
WORKDIR /workspace
CMD ["/bin/bash"]
