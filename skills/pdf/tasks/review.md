# Compare, review and programming

Use installed ReportLab, pypdf, PDFium, pdfplumber, PyMuPDF, OCR and Office tools through `exec_command`. `import word` / `import pdf` loads reusable helpers from `/opt/zigent-file-runtime`. Use underlying libraries freely for requirements beyond those helpers. Install project dependencies in the execution environment if needed.

`pdf.compare(before,after,pages)` reports per-page text diffs, counts, geometry and rendered pixel changes. `pages` is one-based. Use comparisons to identify changed pages, then render them at review resolution. A pixel change may be intended; unchanged low-resolution images do not establish correctness.

Run programs through `exec_command`, continue returned session_id with `write_stdin`, and open exact page PNGs through `view_image`. Rendering and actual visual assessment are separate. Record concise current-hash content/structure/visual reviews as described in the main skill. Preserve immutable originals and saved versions; changing a source invalidates prior evidence. Deliver selected final versions only.
