# Create or use a template

Use python-docx to create a DOCX or load a template, then edit its actual styles, sections, paragraphs, tables and relationships. Preserve existing template content and geometry unless the user asked to change them. Plan page sizes, margins, styles, table widths and pagination before filling content. Set both Western and East Asian fonts using actual installed fonts. Keep tables and diagrams editable where practical.

The reusable builder is optional:

```python
from pathlib import Path
import word
word.create(Path('report.docx'), {
    'font': 'Noto Sans CJK SC', 'eastAsiaFont': 'Noto Sans CJK SC', 'fontSize': 11,
    'page': {'page_width': 210, 'page_height': 297, 'top_margin': 25, 'bottom_margin': 25},
    'blocks': [
        {'type': 'heading', 'level': 1, 'text': '标题'},
        {'type': 'paragraph', 'runs': [{'text': '普通文字'}, {'text': '加粗', 'bold': True}]},
        {'type': 'table', 'rows': [['项目', '数值'], ['收入', '100']]}
    ]
})
```

`word.create(destination,spec,source=template,images=[...])` can use a template. Page/image dimensions are millimetres, font sizes are points. Blocks support paragraph, heading (0–9), table, list, image and page_break. Images use sourceIndex into images and widthMm. Tables repeat their first row. Inspect actual existing style names before selecting them.

Use python-docx/lxml directly for custom numbering, precise column widths, section columns, chart construction and complex template population. Render the output with `/opt/zigent-file-runtime/render_docx.py`, inspect every relevant page through `view_image`, and correct defects before delivery.
