# Inspect, compare and review

Read structure with `word.inventory(path)`: paragraphs/runs/styles, table coordinates and merges, headers/footers, comments, revisions, fields, notes and content controls. For text/structure comparisons, `word.compare(before,after)` reports text diffs, package changes and structural counts. These helpers are ordinary Python; use lxml or other installed libraries to investigate anything they do not report.

Render both versions using `/opt/zigent-file-runtime/render_docx.py` with distinct output directories. Compare PDF text/page counts and use PyMuPDF or Pillow for page-image differences. A pixel difference may be intentional; matching low-resolution images cannot establish every requirement. Use `view_image` to assess actual layout at an appropriate resolution.

Verify that intended content changed while untouched content, run formatting, links, numbering and sections stayed intact. A render cannot establish that comments or fields are structurally correct. Review all pages after a substantial redesign, batching large documents with --pages. Never reuse an older render after changing source bytes.

The renderer records source/PDF/image hashes and page numbers. The user preview reuses that PDF. Record content/structure/visual assessments in `.document-checks.json` using the main skill's schema; visual entries require viewed page numbers. Final output versions and their review evidence remain bound to exact file hashes.
