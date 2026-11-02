# Preserve formatting during local edits

Inspect the current source hash and actual Word structure first. `word.inventory(path,limit)` returns ordered paragraphs, table-cell paragraphs, headers/footers/notes, styles, direct run formatting (null means inherited), fonts, table coordinates/merge spans, comments and fields. Use python-docx/lxml directly for additional structure or large documents.

Use the reusable helper when its selectors fit:

```python
from pathlib import Path
import word
word.edit(Path('original.docx'),Path('edited.docx'),{'actions':[
    {'type':'replace','oldText':'an exact phrase','newText':'the replacement'},
    {'type':'table_cell','table':0,'row':1,'cell':2,'oldText':'100','newText':'120'},
    {'type':'style','oldText':'Introduction','style':'Heading1'}
]})
```

Actions run sequentially and save one output. `part` defaults to word/document.xml; headers, footers, footnotes and endnotes can be selected explicitly. `paragraph` is zero-based within that part. Text must match uniquely unless an intentional one-based occurrence is selected. For repeated text inspect context and narrow by paragraph. Ambiguous/missing matches abort; earlier changes may affect later matches.

The helper spans formatted runs without replacing the paragraph, retains untouched ZIP entries and relationships, and distributes replacement text across existing spans. It rejects crossings through hyperlinks, fields, drawings, revisions and special inline structures. For these structures, use careful OOXML code that preserves relationships and the user's intended formatting. Use explicit structure edits for tabs and paragraph breaks.

Do not assign paragraph.text or cell.text to existing formatted content as a shortcut. Compare before/after text, package parts and formatting, render affected pages with render_docx.py and inspect with view_image. A local wording edit must not silently restyle the whole paragraph.
