# Fill and verify interactive forms

Use pypdf or PyMuPDF in a normal program. Inspect the canonical AcroForm field tree and every page Widget, following Parent/Kids relationships. Check names, field types, current/default values, export states and appearance streams. A name may refer to a parent with several widgets. Duplicate names with distinct unrelated objects require explicit repair, not a blind reattachment.

Clone the original document with pypdf, recover genuinely orphaned widgets where appropriate, and update field values on all affected pages. Use actual on-states for checkboxes and explicit valid radio-group states. Do not guess /Yes. Unknown fields and unsupported states must be resolved. Keep fields interactive unless the user explicitly asked to flatten them.

Reopen the output and require all expected field values in the canonical field tree. Enumerate Widgets again, check inherited effective values, Parent/Kids consistency and nonempty normal appearance streams/states. A successful image render is not proof that stored logical values changed. For a flattened result, verify that no Widgets or AcroForm field tree remain.

Render output pages with `/opt/zigent-file-runtime/render_pdf.py`; use `view_image` to check text fit, non-Latin glyphs, checkmarks and radio marks. Unsupported XFA, signatures and dynamic forms need an editor-aware method; do not claim AcroForm changes establish compatibility.
