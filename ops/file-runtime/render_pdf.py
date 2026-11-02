"""Render selected PDF pages to PNG for visual inspection."""
import os
import sys
# Managed Windows rendering uses the actual bundled libraries, even if a task
# happens to contain a same-named Python module. Ordinary authoring retains its
# project imports; this filter applies only to these managed rendering helpers.
if os.name == 'nt':
    _python = os.path.normcase(os.path.dirname(os.path.abspath(sys.executable)))
    _helpers = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
    sys.path[:] = [p for p in sys.path if os.path.normcase(os.path.abspath(p)) == _helpers or os.path.normcase(os.path.abspath(p)).startswith(_python + os.sep) or os.path.normcase(os.path.abspath(p)) == _python]
    if _helpers not in sys.path: sys.path.insert(0, _helpers)

import argparse
import hashlib
import json
import uuid
from render_docx import record_report, digest
from pathlib import Path
import pymupdf


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('input');parser.add_argument('--output_dir',required=True);parser.add_argument('--pages');parser.add_argument('--dpi',type=int,default=120)
    args=parser.parse_args()
    if not 36<=args.dpi<=300:parser.error('dpi must be 36..300')
    source=Path(args.input).resolve();output=Path(args.output_dir).resolve();output.mkdir(parents=True,exist_ok=True);images=[]
    with pymupdf.open(source) as doc:
        if doc.needs_pass:raise ValueError('PDF_PASSWORD_REQUIRED')
        pages=[int(x) for x in args.pages.split(',')] if args.pages else list(range(1,len(doc)+1))
        for number in pages:
            if not 1<=number<=len(doc):raise ValueError('PAGE_RANGE_INVALID')
            path=output/('page-'+str(number)+'.png');doc[number-1].get_pixmap(matrix=pymupdf.Matrix(args.dpi/72,args.dpi/72),alpha=False).save(path)
            images.append({'path':str(path),'page':number,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
        report={'operationId':str(uuid.uuid4()),'sourcePath':str(source),'sourceSha256':digest(source),'pdfPath':str(source),'pdfSha256':digest(source),'runtimeIdentity':os.environ.get('ZIGENT_RUNTIME_IDENTITY'),'rendererSha256':digest(__file__),'totalPages':len(doc),'images':images}
        record_report(report,output);print(json.dumps(report))

if __name__=='__main__':main()
