# Read, OCR and create

Use `pdfinfo`, PyMuPDF and pypdf to identify page count, encryption, dimensions, rotation, crop boxes, metadata, forms and annotations. Use `pdfplumber` for layout-aware table extraction and `page.get_text('words')` from PyMuPDF for page/rectangle/block/line metadata. Preserve page numbers and coordinates. Extraction order is an estimate; verify multi-column text, tables and equations against page images.

Render scanned/mixed pages and OCR only the pages needed. Tesseract includes eng+chi_sim. Check critical names, numbers and dates visually. Never treat missing OCR text as proof that an image contains no sensitive content.

Use ReportLab to create PDFs with actual embedded fonts, precise layouts, charts and tables. A simple optional helper is `pdf.create(destination,{'blocks':[{'type':'heading','text':'标题'},{'type':'paragraph','text':'正文'},{'type':'table','rows':[['项目','数值'],['收入','100']]}]})`. Its font defaults to a Chinese CID font; use ReportLab directly for embedded fonts or advanced layout. Page dimensions are PDF points. For editable reflow, build a Word/source document first.

Render the completed PDF using `/opt/zigent-file-runtime/render_pdf.py` and inspect pages using `view_image`.
