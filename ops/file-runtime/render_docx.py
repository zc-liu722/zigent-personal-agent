"""Office documents -> PDF -> page images, shared by authoring and previews."""
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
from contextlib import contextmanager
if os.name != 'nt':
    import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid


@contextmanager
def lock_file(path):
    with Path(path).open('a+b') as stream:
        if os.name=='nt':
            import msvcrt
            stream.seek(0,2)
            if stream.tell()==0:stream.write(b'\0');stream.flush()
            stream.seek(0);msvcrt.locking(stream.fileno(),msvcrt.LK_LOCK,1)
        else:fcntl.flock(stream,fcntl.LOCK_EX)
        try:yield
        finally:
            if os.name=='nt':stream.seek(0);msvcrt.locking(stream.fileno(),msvcrt.LK_UNLCK,1)
            else:fcntl.flock(stream,fcntl.LOCK_UN)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def convert(source, destination):
    source=Path(source).resolve();destination=Path(destination).resolve()
    identity=os.environ.get('ZIGENT_RUNTIME_IDENTITY','unversioned')
    key=hashlib.sha256((identity+'\0'+digest(source)).encode()).hexdigest()
    cache=Path(os.environ.get('ZIGENT_PREVIEW_CACHE','/opt/zigent-preview-cache'))/key
    if (cache/'preview.pdf').is_file() and (cache/'receipt.json').is_file():
        receipt=json.loads((cache/'receipt.json').read_text())
        if receipt.get('sha256')==digest(cache/'preview.pdf'):
            destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(cache/'preview.pdf',destination);return
    with tempfile.TemporaryDirectory(prefix='zigent-office-') as temporary:
        root=Path(temporary);profile=(root/'profile').as_uri();output=root/'output';output.mkdir()
        executable=os.environ.get('ZIGENT_SOFFICE') or shutil.which('soffice')
        if not executable:raise RuntimeError('OFFICE_CONVERTER_UNAVAILABLE')
        extension=source.suffix.lower()
        export_filter='impress_pdf_Export' if extension in ('.ppt','.pptx','.odp') else 'calc_pdf_Export' if extension in ('.xls','.xlsx','.ods') else 'writer_pdf_Export'
        result=subprocess.run([executable,'-env:UserInstallation='+profile,'--headless','--convert-to','pdf:'+export_filter,'--outdir',str(output),str(source)],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180,creationflags=0x08000000 if os.name=='nt' else 0,env={**os.environ,'HOME':str(root)})
        generated=output/(source.stem+'.pdf')
        if result.returncode or not generated.is_file():
            detail=(result.stdout+result.stderr).decode('utf-8',errors='replace')[-1600:]
            raise RuntimeError('DOCUMENT_CONVERSION_FAILED exit='+str(result.returncode)+' '+detail)
        destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(generated,destination)


def render(source, output, pages=None, dpi=120, pdf_only=False):
    import pymupdf
    source=Path(source).resolve();output=Path(output).resolve();output.mkdir(parents=True,exist_ok=True)
    before=digest(source);pdf=output/'document.pdf';convert(source,pdf)
    if digest(source)!=before:raise RuntimeError('SOURCE_CHANGED_DURING_RENDER')
    with pymupdf.open(pdf) as doc:
        selected=pages if pages else list(range(1,len(doc)+1));images=[]
        if not pdf_only:
            for number in selected:
                if not 1<=number<=len(doc):raise ValueError('PAGE_RANGE_INVALID')
                path=output/('page-'+str(number)+'.png');doc[number-1].get_pixmap(matrix=pymupdf.Matrix(dpi/72,dpi/72),alpha=False).save(path)
                images.append({'path':str(path),'page':number,'sha256':digest(path)})
        report={'operationId':str(uuid.uuid4()),'sourcePath':str(source),'sourceSha256':before,'runtimeIdentity':os.environ.get('ZIGENT_RUNTIME_IDENTITY'),
            'rendererSha256':digest(__file__),'pdfPath':str(pdf),'pdfSha256':digest(pdf),'totalPages':len(doc),'images':images}
    record_report(report,output)
    return report


def record_report(report,output):
    output=Path(output)
    workspace=Path(os.environ.get('ZIGENT_WORKSPACE','/workspace')).resolve();source=Path(report['sourcePath']).resolve()
    if source.is_relative_to(workspace) and output.resolve().is_relative_to(workspace):
        report['sourceRelative']=source.relative_to(workspace).as_posix()
        pdf=Path(report['pdfPath']).resolve()
        if pdf.is_relative_to(workspace):report['pdfRelative']=pdf.relative_to(workspace).as_posix()
        for image in report.get('images',[]):
            path=Path(image['path']).resolve()
            if path.is_relative_to(workspace):image['relativePath']=path.relative_to(workspace).as_posix()
        index=workspace/'.document-render-index.json'
        with lock_file(workspace/'.document-render-index.lock'):
            entries=[]
            if index.is_file():
                try:entries=json.loads(index.read_text(encoding="utf-8"))[-79:]
                except (ValueError,TypeError):pass
            entries=[item for item in entries if item.get('sourcePath')!=str(source)]+[report]
            temporary=index.with_name(index.name+'.'+uuid.uuid4().hex+'.tmp');temporary.write_text(json.dumps(entries,ensure_ascii=False),encoding='utf-8');os.replace(temporary,index)

    (output/'render-manifest.json').write_text(json.dumps(report,ensure_ascii=False),encoding='utf-8')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('input');parser.add_argument('--output_dir',required=True)
    parser.add_argument('--pages',help='Comma-separated one-based page numbers');parser.add_argument('--dpi',type=int,default=120)
    parser.add_argument('--emit_pdf',action='store_true',help='PDF is retained internally for reproducible preview');parser.add_argument('--pdf_only',action='store_true')
    args=parser.parse_args()
    if not 36<=args.dpi<=300:parser.error('dpi must be 36..300')
    print(json.dumps(render(args.input,args.output_dir,[int(x) for x in args.pages.split(',')] if args.pages else None,args.dpi,args.pdf_only),ensure_ascii=False))

if __name__=='__main__':main()
