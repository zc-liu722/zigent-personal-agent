"""Windows full-access execution under a dedicated standard account.

Network and localhost are intentionally available. This is not a hostile-code
sandbox. The control plane, bearer secret files and other Agent accounts remain
outside this account's ACL. A named Job owns every model process before launch.
"""
import base64
import ctypes
from ctypes import wintypes
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import uuid

kernel = ctypes.WinDLL('kernel32', use_last_error=True) if os.name == 'nt' else None
if kernel:
    for name, args, result in [
        ('CreateJobObjectW', [ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        ('OpenJobObjectW', [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
        ('CloseHandle', [wintypes.HANDLE], wintypes.BOOL),
        ('TerminateJobObject', [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        ('QueryInformationJobObject', [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
    ]:
        f = getattr(kernel, name); f.argtypes = args; f.restype = result


def current_sid():
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    token = wintypes.HANDLE(); size = wintypes.DWORD(); text = ctypes.c_void_p()
    if not advapi.OpenProcessToken(wintypes.HANDLE(-1), 8, ctypes.byref(token)): raise ctypes.WinError(ctypes.get_last_error())
    try:
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        data = ctypes.create_string_buffer(size.value)
        if not advapi.GetTokenInformation(token, 1, data, size, ctypes.byref(size)): raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p))[0]
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(text)): raise ctypes.WinError(ctypes.get_last_error())
        try: return ctypes.wstring_at(text)
        finally:
            kernel.LocalFree.argtypes = [ctypes.c_void_p]; kernel.LocalFree(text)
    finally: kernel.CloseHandle(token)


class Accounting(ctypes.Structure):
    _fields_ = [('user', ctypes.c_int64), ('kernel', ctypes.c_int64), ('period_user', ctypes.c_int64), ('period_kernel', ctypes.c_int64),
                ('faults', wintypes.DWORD), ('total', wintypes.DWORD), ('active', wintypes.DWORD), ('terminated', wintypes.DWORD)]


class Job:
    def __init__(self, identifier, create=False):
        self.lock = threading.RLock()
        self.name = 'Local\\ZigentExecution-' + str(uuid.UUID(identifier))
        self.handle = kernel.CreateJobObjectW(None, self.name) if create else kernel.OpenJobObjectW(0x1F003F, False, self.name)
        if not self.handle and (create or ctypes.get_last_error() != 2):
            raise ctypes.WinError(ctypes.get_last_error())

    def active(self):
        with self.lock:
            if not self.handle: return 0
            data = Accounting()
            if not kernel.QueryInformationJobObject(self.handle, 1, ctypes.byref(data), ctypes.sizeof(data), None):
                raise ctypes.WinError(ctypes.get_last_error())
            return data.active

    def stop(self):
        with self.lock:
            if self.handle and self.active():
                if not kernel.TerminateJobObject(self.handle, 1): raise ctypes.WinError(ctypes.get_last_error())
                deadline = time.monotonic() + 20
                while self.active():
                    if time.monotonic() > deadline: raise RuntimeError('WINDOWS_JOB_STOP_UNCONFIRMED')
                    time.sleep(.02)

    def close(self):
        with self.lock:
            if self.handle: kernel.CloseHandle(self.handle); self.handle = None


class WindowsBackend:
    def __init__(self, worker):
        if os.name != 'nt': raise RuntimeError('Windows execution requires Windows')
        if ctypes.windll.shell32.IsUserAnAdmin(): raise RuntimeError('Execution worker must use a standard account')
        ctypes.windll.gdi32.AddFontResourceExW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,ctypes.c_void_p]
        ctypes.windll.gdi32.AddFontResourceExW.restype=ctypes.c_int
        self.account_sid = current_sid()
        if self.account_sid != worker.config.get('accountSid'): raise RuntimeError('Execution account SID does not match its dedicated native identity')
        self.worker = worker
        self.config = worker.config
        boot = ctypes.create_string_buffer(32); returned = wintypes.ULONG()
        status = ctypes.windll.ntdll.NtQuerySystemInformation(90, boot, len(boot), ctypes.byref(returned))
        if status != 0: raise RuntimeError('Windows boot identity is unavailable')
        self.boot_id = hashlib.sha256(boot.raw[:16]).hexdigest()
        self.instance_id = str(uuid.uuid4())
        self.base_identity = self.config['runtimeIdentity']
        self.font_metadata = None
        self.font_content = {}
        self.font_lock = threading.Lock()
        previous_path = worker.root / 'instance.json'
        previous = json.loads(previous_path.read_text(encoding="utf-8")) if previous_path.is_file() else None
        self.interruption_reason = 'Host rebooted; command was not replayed' if previous and previous['bootId'] != self.boot_id else 'Execution service restarted; command was not replayed'
        temporary = previous_path.with_suffix('.new')
        with temporary.open('w') as stream:
            json.dump({'bootId': self.boot_id, 'instanceId': self.instance_id, 'startedAt': time.time()}, stream); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, previous_path)
        self.runtime = self.config['windowsRuntime']
        self.verify_control_permissions()
        self.slots = threading.BoundedSemaphore(worker.max_jobs)
        self.jobs = {}
        self.previews = WindowsPreviews(self)
        self.version = subprocess.check_output([self.runtime['execution'], '--version'], timeout=10).decode().strip()
        if self.version != 'zigent-execution 1.1.0': raise RuntimeError('Native execution version mismatch')
        for path in self.runtime['managedFonts']:
            if not ctypes.windll.gdi32.AddFontResourceExW(str(path), 0, None): raise RuntimeError('Managed font initialization failed')

    def verify_control_permissions(self):
        probes = self.config.get('controlPlaneProbes')
        if not probes or not probes.get('readDenied') or not probes.get('writeDenied'):
            raise RuntimeError('Control-plane ACL capability probes are missing')
        for field, flags in [('readDenied', os.O_RDONLY), ('writeDenied', os.O_WRONLY)]:
            for path in probes[field]:
                try: handle = os.open(path, flags)
                except PermissionError: continue
                except OSError as failure: raise RuntimeError('Control-plane ACL probe is unavailable') from failure
                else:
                    os.close(handle)
                    raise RuntimeError('Control-plane ACL protection failed; execution refused')
        peer_directories = probes.get('peerReadDenied')
        if not peer_directories:
            raise RuntimeError('Agent data ACL capability probes are missing')
        for path in peer_directories:
            try:
                with os.scandir(path) as entries:
                    next(entries, None)
            except (PermissionError, FileNotFoundError):
                continue
            except OSError as failure:
                raise RuntimeError('Agent data ACL probe is unavailable') from failure
            raise RuntimeError('Agent data ACL protection failed; execution refused')

    def refresh_rendering_identity(self):
        with self.font_lock:
            root = Path(os.environ['SystemRoot']) / 'Fonts'
            assets = {'font/' + p.name: p for p in root.iterdir() if p.is_file()}
            assets.update({'library/' + path: Path(path) for path in self.config.get('hostLibraries', {})})
            signature = {key: (p.stat().st_size, p.stat().st_mtime_ns) for key, p in assets.items()}
            if signature == self.font_metadata: return
            actual = {}
            for key, path in assets.items():
                if self.font_metadata and self.font_metadata.get(key) == signature[key]: actual[key] = self.font_content[key]
                else: actual[key] = hashlib.sha256(path.read_bytes()).hexdigest()
            self.font_content = actual; self.font_metadata = signature
            expected = {'font/' + key: value for key, value in self.config.get('hostFonts', {}).items()}
            expected.update({'library/' + key: value for key, value in self.config.get('hostLibraries', {}).items()})
            identity = self.base_identity if actual == expected else hashlib.sha256(json.dumps([self.base_identity, actual], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            self.config['runtimeIdentity'] = identity

    def health(self, identity):
        self.verify_control_permissions()
        self.refresh_rendering_identity()
        return {'protocol': 1, 'backend': 'windows-native', 'agentId': identity['agentId'], 'ownerUserId': identity['ownerUserId'],
                'admissionTracking': True,
                'runtimeIdentity': self.config['runtimeIdentity'], 'instanceId': self.instance_id, 'hostEpoch': self.boot_id, 'githubSshConfigured': self.worker.github_credentials(identity).is_dir(),
                'capabilities': {**self.config['runtimeCapabilities'], 'workspaceRoot': str(self.worker.workspace(identity, '_').parent)}, 'permissions': {'mode': 'full-access', 'network': True, 'localhost': True,
                'account': 'standard', 'accountSid': self.account_sid, 'controlPlaneProtected': True,
                'agentDataIsolated': True, 'osIsolationBetweenConversations': False}}

    def temporary(self, identifier):
        return self.worker.root / 'tmp' / str(uuid.UUID(identifier))

    def environment(self, directory, identifier):
        self.verify_control_permissions()
        self.refresh_rendering_identity()
        home = directory / '.zigent-home'; home.mkdir(exist_ok=True)
        # LibreOffice's profile internals still exceed MAX_PATH when TEMP is
        # below a deeply nested project. Keep per-command scratch under the
        # same protected account state, outside project snapshots.
        temp = self.temporary(identifier); temp.mkdir(parents=True, exist_ok=True)
        runtime = self.runtime
        windows = os.environ.get('SystemRoot', 'C:\\Windows')
        environment = {'SystemRoot': windows, 'WINDIR': windows, 'ComSpec': windows + '\\System32\\cmd.exe', 'PATHEXT': '.COM;.EXE;.BAT;.CMD',
                'PATH': os.pathsep.join([str(Path(runtime['python']).parent), str(Path(runtime['node']).parent),
                    str(Path(runtime['execution']).parent), str(Path(runtime['soffice']).parent),
                    runtime['nodeModules'] + '\\.bin', str(Path(runtime['pwsh']).parent), windows + '\\System32',
                    'C:\\Program Files\\Git\\cmd']),
                'HOME': str(home), 'USERPROFILE': str(home), 'APPDATA': str(home / 'AppData'), 'LOCALAPPDATA': str(home / 'LocalAppData'),
                'TEMP': str(temp), 'TMP': str(temp), 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                'PYTHONPATH': runtime['helpers'], 'NODE_PATH': runtime['nodeModules'],
                'ZIGENT_WORKSPACE': str(directory), 'ZIGENT_SKILLS': runtime['skills'], 'ZIGENT_HELPERS': runtime['helpers'],
                'ZIGENT_NODE_PACKAGE': str(Path(runtime['nodeModules']).parent / 'package.json'),
                'ZIGENT_PREVIEW_CACHE': str(self.worker.root / 'derived-cache' / self.config['scope']),
                'ZIGENT_SOFFICE': runtime['soffice'], 'ZIGENT_RUNTIME_IDENTITY': self.config['runtimeIdentity']}
        credentials = self.worker.github_credentials({'scope': self.config['scope']})
        if credentials.is_dir():
            environment['GIT_SSH_COMMAND'] = '"C:/Program Files/Git/usr/bin/ssh.exe" -F "' + (credentials / 'config').as_posix() + '"'
        return environment

    def command(self, request, job_directory):
        terminal = request.get('terminal') or {'shell': 'pwsh', 'login': False, 'tty': False}
        shell = terminal['shell']; tty = terminal['tty']
        if shell in ('pwsh', 'powershell'):
            path = job_directory / 'command.ps1'
            prefix = "$global:LASTEXITCODE=0\n[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding\n"
            # Preserve the final native exit status, following the pinned Codex
            # hook_environment_executor.rs PowerShell status ordering. -File by
            # itself otherwise reports success for a failed external program.
            suffix = '\nif ($?) { exit 0 }; if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1\n'
            path.write_text(prefix + request['command'] + suffix, encoding='utf-8-sig')
            # The supplied program is kept as script bytes, never rewritten as Bash.
            argv = [self.runtime['pwsh'] if shell == 'pwsh' else os.environ['SystemRoot'] + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']
            argv += ([] if terminal['login'] else ['-NoProfile']) + ([] if tty else ['-NonInteractive'])
            return argv + ['-ExecutionPolicy', 'Bypass', '-File', str(path)], tty
        if shell == 'cmd':
            if not request['command'].isascii(): raise ValueError('cmd currently accepts ASCII script text only; use pwsh for Unicode commands')
            path = job_directory / 'command.cmd'; path.write_text(request['command'], encoding='utf-8')
            return [os.environ['SystemRoot'] + '\\System32\\cmd.exe', '/d', '/c', str(path)], tty
        raise ValueError('Windows supports pwsh, powershell or cmd; Bash commands are not translated')

    def transport(self, identifier, directory, argv, tty, timeout, output, maximum, registered=True, workspace=None):
        from native_engine import NativeCommand
        job = Job(identifier, True)
        process = None
        try:
            environment = self.environment(workspace or directory, identifier)
            # Only the supervisor receives this name. Model commands do not inherit its pipe or environment.
            with self.worker.lock:
                if identifier in self.worker.cancelled: raise RuntimeError('Command was cancelled before launch')
                process = subprocess.Popen([self.runtime['execution']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                           env={**environment, 'ZIGENT_JOB_NAME': job.name}, creationflags=0x08000000, close_fds=True)
                self.jobs[identifier] = job
                if registered: self.worker.running[identifier] = process
            engine = NativeCommand(process, identifier, output, maximum)
            if registered:
                with self.worker.lock: self.worker.terminals[identifier] = (engine, tty)
                self.worker.update(identifier, 'running')
            call = engine.request('start', {'command': argv, 'cwd': str(directory), 'tty': tty, 'timeoutMs': timeout, 'env': environment})
            engine.command_id = call
            if identifier in self.worker.cancelled: job.stop()
            result = engine.wait(call, timeout / 1000 + 30)
            process.stdin.close()
            process.wait(timeout=20)
            return result
        finally:
            # Confirm the complete named job is empty before allowing snapshot/export.
            job.stop()
            if process and process.poll() is None:
                process.kill(); process.wait(timeout=10)
            with self.worker.lock: self.jobs.pop(identifier, None)
            job.close()
            shutil.rmtree(self.temporary(identifier), ignore_errors=True)

    def stop(self, identifier):
        with self.worker.lock: job = self.jobs.get(identifier)
        owned = job is None
        if owned: job = Job(identifier)
        try:
            job.stop()
            with self.worker.lock: process = self.worker.running.get(identifier)
            if process and process.poll() is None:
                process.kill(); process.wait(timeout=10)
            job.stop()
        finally:
            if owned: job.close()

    def run(self, identity, request):
        from worker import snapshot
        worker = self.worker; identifier = request['id']
        directory = worker.workspace(identity, request['workspaceId']); result_directory = worker.job_path(identifier)
        state, code, error = 'failed', None, None
        stopped = False
        monitor_done = threading.Event(); resource_errors = []
        admitted = self.slots.acquire(blocking=False)
        try:
            if not admitted: raise RuntimeError('Native execution capacity is busy')
            if identifier in worker.cancelled: state = 'cancelled'; return
            argv, tty = self.command(request, result_directory)
            def monitor():
                while not monitor_done.wait(.5):
                    try:
                        failure = worker.disk_budget(directory, (self.temporary(identifier),))
                        if failure and not resource_errors: resource_errors.append(failure)
                        if resource_errors or identifier in worker.cancelled: self.stop(identifier)
                    except Exception as failure:
                        if not resource_errors: resource_errors.append(str(failure)[:500])
            threading.Thread(target=monitor, daemon=True).start()
            with (result_directory / 'output.log').open('wb') as stream:
                result = self.transport(identifier, directory / request['cwd'], argv, tty, request['timeoutMs'], stream, worker.output_limit, workspace=directory)
            code = result['exitCode']
            if result.get('timedOut'): error = 'Program exceeded its execution time limit'
            if resource_errors: error = resource_errors[0]
            state = 'cancelled' if identifier in worker.cancelled else 'failed' if code or error else 'completed'
        except Exception as failure:
            error = str(failure)[:1000]; state = 'cancelled' if identifier in worker.cancelled else 'failed'
        finally:
            monitor_done.set()
            try: self.stop(identifier); stopped = True
            except Exception as failure: worker.update(identifier, 'running', code, 'CONTAINER_STOP_UNCONFIRMED: ' + str(failure)[:500])
            if stopped:
                with worker.lock:
                    worker.update(identifier, state, code, error)
                    worker.running.pop(identifier, None); worker.terminals.pop(identifier, None); worker.cancelled.discard(identifier)
                    if not worker.busy(identity['scope'], request['workspaceId']):
                        try:
                            snapshot(directory, result_directory / 'snapshot.zip', worker.maximum)
                            for row in worker.db.execute("SELECT id FROM jobs WHERE scope=? AND workspace=? AND state NOT IN ('starting','running')", (identity['scope'], request['workspaceId'])).fetchall():
                                target = worker.job_path(row['id']) / 'snapshot.zip'
                                if not target.exists() and not (target.parent / 'acknowledged.json').exists(): shutil.copyfile(result_directory / 'snapshot.zip', target)
                        except Exception as failure: worker.update(identifier, state, code, error, str(failure)[:1000])
            if admitted: self.slots.release()


class WindowsPreviews:
    def __init__(self, backend): self.backend = backend

    def run(self, identity, request):
        import tempfile
        backend = self.backend; worker = backend.worker
        if set(request) not in ({'source', 'name', 'sha256'}, {'source', 'name', 'sha256', 'expectedRuntimeIdentity'}) or request['name'] not in ('source.docx', 'source.doc', 'source.pptx', 'source.ppt', 'source.xlsx', 'source.xls', 'source.odt', 'source.odp', 'source.ods'):
            raise ValueError('Invalid immutable preview input')
        backend.refresh_rendering_identity()
        if request.get('expectedRuntimeIdentity') and request['expectedRuntimeIdentity'] != worker.config['runtimeIdentity']: raise RuntimeError('RENDERING_RUNTIME_CHANGED')
        data = base64.b64decode(request['source'], validate=True)
        if len(data) > 128 * 1024 ** 2 or hashlib.sha256(data).hexdigest() != request['sha256']: raise ValueError('Preview source mismatch')
        if not backend.slots.acquire(blocking=False): raise RuntimeError('Preview queue is busy')
        key = hashlib.sha256((worker.config['runtimeIdentity'] + '\0' + request['sha256']).encode()).hexdigest()
        root = worker.root / 'derived-cache' / identity['scope']; root.mkdir(parents=True, exist_ok=True)
        cache = root / key
        try:
            if (cache / 'receipt.json').is_file():
                receipt = json.loads((cache / 'receipt.json').read_text(encoding="utf-8")); pdf = (cache / 'preview.pdf').read_bytes()
                if hashlib.sha256(pdf).hexdigest() == receipt['sha256']: return {**receipt, 'pdf': base64.b64encode(pdf).decode()}
            with tempfile.TemporaryDirectory(prefix='derive-', dir=root) as temporary:
                directory = Path(temporary); source = directory / request['name']; source.write_bytes(data)
                argv = [backend.runtime['python'], str(Path(backend.runtime['helpers']) / 'render_docx.py'), str(source), '--output_dir', str(directory / 'output'), '--pdf_only']
                identifier = str(uuid.uuid4()); monitor_done = threading.Event(); resource_errors = []
                def monitor():
                    while not monitor_done.wait(.5):
                        try:
                            failure = worker.disk_budget(directory, (backend.temporary(identifier),))
                            if failure:
                                resource_errors.append(failure); backend.stop(identifier); return
                        except Exception as failure:
                            resource_errors.append(str(failure)[:500]); backend.stop(identifier); return
                threading.Thread(target=monitor, daemon=True).start()
                try: result = backend.transport(identifier, directory, argv, False, 240000, io.BytesIO(), 1024 * 1024, False)
                finally: monitor_done.set()
                if resource_errors: raise RuntimeError(resource_errors[0])
                if result['exitCode'] or result.get('timedOut'): raise RuntimeError('Preview conversion failed')
                output = directory / 'output'; pdf_path = output / 'document.pdf'
                if pdf_path.stat().st_size > 256 * 1024 ** 2: raise RuntimeError('Preview PDF exceeded its output limit')
                pdf = pdf_path.read_bytes()
                if not pdf.startswith(b'%PDF-') or len(pdf) > 256 * 1024 ** 2: raise RuntimeError('Invalid PDF conversion')
                report = json.loads((output / 'render-manifest.json').read_text(encoding="utf-8"))
                receipt = {'sha256': hashlib.sha256(pdf).hexdigest(), 'totalPages': report['totalPages'], 'warnings': [], 'sourceSha256': request['sha256'], 'runtimeIdentity': worker.config['runtimeIdentity']}
                stage = root / ('.stage-' + uuid.uuid4().hex); stage.mkdir()
                try:
                    (stage / 'preview.pdf').write_bytes(pdf); (stage / 'receipt.json').write_text(json.dumps(receipt))
                    if not cache.exists(): os.rename(stage, cache)
                finally: shutil.rmtree(stage, ignore_errors=True)
                return {**receipt, 'pdf': base64.b64encode(pdf).decode()}
        finally: backend.slots.release()
