"""Internal immutable preview derivation; never exposed as a model editing tool."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import uuid


class PreviewWorker:
    def __init__(self, worker):
        self.worker=worker
        self.capacity=threading.BoundedSemaphore(2)
        self.last_cleanup=0

    def run(self, identity, request):
        if set(request)!={'source','name','sha256'} or request['name'] not in ('source.docx','source.doc','source.pptx','source.ppt','source.xlsx','source.xls','source.odt','source.odp','source.ods'):
            raise ValueError('Invalid immutable preview input')
        if not isinstance(request['source'],str) or len(request['source'])>180*1024*1024:raise ValueError('Preview input exceeds limit')
        data=base64.b64decode(request['source'],validate=True)
        if hashlib.sha256(data).hexdigest()!=request['sha256']:raise ValueError('Preview source hash mismatch')
        if not self.capacity.acquire(blocking=False):raise RuntimeError('Preview queue is busy; try again')
        worker=self.worker;cache_root=worker.root/'derived-cache'/identity['scope'];cache_root.mkdir(parents=True,exist_ok=True,mode=0o700)
        if time.time()-self.last_cleanup>3600:
            self.last_cleanup=time.time()
            for path in cache_root.iterdir():
                if len(path.name)==64 and all(c in '0123456789abcdef' for c in path.name) and not path.is_symlink() and path.is_dir() and path.stat().st_mtime<time.time()-7*86400:
                    shutil.rmtree(path)
        key=hashlib.sha256((worker.config['runtimeIdentity']+'\0'+request['sha256']).encode()).hexdigest();cache=cache_root/key
        try:
            if (cache/'preview.pdf').is_file() and (cache/'receipt.json').is_file():
                receipt=json.loads((cache/'receipt.json').read_text());pdf=(cache/'preview.pdf').read_bytes()
                if hashlib.sha256(pdf).hexdigest()==receipt.get('sha256'):
                    os.utime(cache,None);return {**receipt,'pdf':base64.b64encode(pdf).decode()}
            root=worker.root/'derived';root.mkdir(mode=0o700,exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='preview-',dir=root) as temporary:
                directory=Path(temporary);directory.chmod(0o700);(directory/request['name']).write_bytes(data)
                name='zigent-preview-'+uuid.uuid4().hex
                argv=[worker.engine,'run','--pull=never','--rm','--init','--name',name,'--label','org.zigent.preview=true',
                    '--user',str(os.getuid())+':'+str(os.getgid()),'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=1g','--cpus=2','--network=none',
                    '--tmpfs','/tmp:rw,nosuid,nodev,size=536870912','--mount','type=bind,src='+str(directory)+',dst=/workspace','--workdir','/workspace',
                    '--env','HOME=/tmp','--env','LANG=C.UTF-8','--env','ZIGENT_RUNTIME_IDENTITY='+worker.config['runtimeIdentity'],worker.image,
                    'python3','/opt/zigent-file-runtime/render_docx.py','/workspace/'+request['name'],'--output_dir','/workspace/output','--pdf_only']
                try:result=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=240,env={'PATH':'/usr/bin:/bin'})
                except subprocess.TimeoutExpired:
                    subprocess.run([worker.engine,'kill',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,env={'PATH':'/usr/bin:/bin'});raise RuntimeError('Preview conversion timed out')
                if result.returncode:raise RuntimeError('Preview conversion failed')
                output=directory/'output';pdf=(output/'document.pdf').read_bytes()
                if len(pdf)>256*1024*1024 or not pdf.startswith(b'%PDF-'):raise ValueError('Invalid preview output')
                report=json.loads((output/'render-manifest.json').read_text());receipt={'sha256':hashlib.sha256(pdf).hexdigest(),'totalPages':report['totalPages'],'warnings':[]}
                stage=cache_root/('.stage-'+uuid.uuid4().hex);stage.mkdir(mode=0o700)
                try:
                    (stage/'preview.pdf').write_bytes(pdf);(stage/'receipt.json').write_text(json.dumps(receipt))
                    try:os.rename(stage,cache)
                    except OSError:
                        if not (cache/'preview.pdf').is_file():raise
                        receipt=json.loads((cache/'receipt.json').read_text());pdf=(cache/'preview.pdf').read_bytes()
                        if hashlib.sha256(pdf).hexdigest()!=receipt.get('sha256'):raise RuntimeError('Preview cache changed')
                finally:shutil.rmtree(stage,ignore_errors=True)
                return {**receipt,'pdf':base64.b64encode(pdf).decode()}
        finally:self.capacity.release()
