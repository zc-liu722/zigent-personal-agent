# Runtime and programming

Run normal commands with `exec_command`, edit program source with `apply_patch`, continue sessions with `write_stdin` and inspect page PNGs with `view_image`. Read this skill and its resources using `cat`/`sed`; the skill root is `/opt/zigent-skills/docx`.

Python 3.13 is at `/opt/zigent-python/bin/python` and first on the command PATH. Installed libraries include python-docx, lxml, docxcompose, ReportLab, pypdf, PDFium, pdfplumber and PyMuPDF. Inspect actual imports and font files before relying on them. Node packages are under `/opt/zigent-file-runtime/node_modules`; use `createRequire('/opt/zigent-file-runtime/package.json')` for ESM programs needing these packages. Project-specific dependencies may be installed inside the execution environment.

`/opt/zigent-file-runtime` is on PYTHONPATH. `import word` and `import pdf` load reusable ordinary Python helpers. They can be combined with diagrams, charts, calculations, custom OOXML, precise styles/sections and templates; they are not a restriction on programming.

```python
from pathlib import Path
from word import inventory, edit, create, merge
edit(Path('original.docx'), Path('edited.docx'), {
    'actions': [{'type': 'replace', 'oldText': 'exact text', 'newText': 'revised text'}]
})
```

Preserve package members and relationship targets for local edits. Use underlying libraries for unsupported structures. Code, content/structure checks, renders and visual review all run through the same workspace and command tools. A returned session ID is not completion. Use `write_stdin` until the command terminates; resolve synchronization errors in the file panel before delivery. Never use Windows production paths, install into the running application, or infer another Agent's data access.
