# PDF page and annotation operations

All operations create new files and preserve the source. Read and record the current source hash before editing.

- Use pypdf or PyMuPDF directly for selection/reordering; duplicates can be intentional.
- Use PyMuPDF to create one output per group, copying the selected source pages with insert_pdf.
- `pdf.edit(source,destination,spec,sources=[])` supports the actions below sequentially; page numbers are one-based at that action's point.

```python
import pdf
pdf.edit('input.pdf','edited.pdf',{'actions':[
    {'type':'select','pages':[3,1,2]},
    {'type':'rotate','page':1,'degrees':90},
    {'type':'merge','sourceIndex':0},
    {'type':'annotation','kind':'highlight','page':1,'rect':[50,60,200,80],'text':'复核'}
]},sources=['appendix.pdf'])
```

`select` can handle up to 10,000 selected pages. `merge` uses `sourceIndex` into the supplied source file list and optional zero-based `at` insertion boundary; the default appends. `rotate` adds 0/90/180/270 (or negative equivalents). `crop` takes `page` and `rect=[x0,y0,x1,y1]`. `annotation` kinds are `text`, `highlight`, `rectangle`; rectangles/coordinates are PDF points. `bookmarks` sets the supplied outline with `level/title/page` entries; explicitly retain old entries when preserving them is required.

Cropping hides content outside a visible box and does not redact it. A rectangle annotation does not redact. After structural operations, verify page order/count, crop/rotation, link targets, form widgets, annotations and bookmarks; render and inspect affected pages. Use custom pypdf/PyMuPDF code in the isolated runtime for finer control.
