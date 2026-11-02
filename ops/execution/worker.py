#!/usr/bin/env python3
"""Authenticated durable execution, with Windows native and legacy container backends.

The protected config maps bearer-token digests to exact Agent/owner identities.
Windows commands run under a dedicated standard account with explicit environment;
legacy commands use containers. See README.md for permissions and provisioning.
"""
import argparse
import importlib.util
import codecs
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import signal
import sys
import sqlite3
import stat
import subprocess
import threading
import time
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

if os.name == 'nt': sys.path.insert(0, str(Path(__file__).resolve().parent))

MANIFEST = '.zigent-transfer-manifest.json'
PROJECT_METADATA = '.zigent-project-metadata.json'
MAX_FILES = 100000
TERMINAL = {'completed', 'failed', 'cancelled', 'interrupted'}
GITHUB_HOST_KEY = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n'
GITHUB_AGENTS = frozenset({'deepmind', 'xiaochang'})
GITHUB_SSH_CONFIG = '''Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile /run/zigent-github/id_ed25519
  IdentitiesOnly yes
  HostKeyAlias github.com
  UserKnownHostsFile /run/zigent-github/known_hosts
  StrictHostKeyChecking yes
  BatchMode yes
'''


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def sha(value):
    return hashlib.sha256(value).hexdigest()


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def revision(manifest):
    return sha(encoded({'files': manifest['files'], 'links': manifest['links'], 'directories': manifest.get('directories', [])}))


def safe_link(path, target):
    relative(path)
    if isinstance(target, str) and (chr(127) in target or len(target.encode('utf-16-le')) // 2 > 1000):
        raise ValueError('Invalid project link target')
    if not isinstance(target, str) or not target or len(target) > 1000 or target.startswith('/') or re.search(r'[\\\x00-\x1f]', target):
        raise ValueError('Invalid project link target')
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
    if resolved == '..' or resolved.startswith('../'):
        raise ValueError('Project link escapes the workspace')
    if resolved != '.':
        relative(resolved)


def relative(value, empty=False):
    if empty and value in ('', '.'):
        return ''
    if isinstance(value, str) and (chr(127) in value or len(value.encode('utf-16-le')) // 2 > 1000
        or any(len(part.encode('utf-16-le')) // 2 > 240 or re.match(r'^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)', part, re.I) for part in value.split('/'))):
        raise ValueError('Invalid portable workspace path')
    if not isinstance(value, str) or not value or len(value) > 1000 or re.search(r'[\\\x00-\x1f<>:"|?*]', value):
        raise ValueError('Invalid workspace path')
    if any(not part or part in ('.', '..') or part.endswith(('.', ' ')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I) for part in value.split('/')):
        raise ValueError('Invalid workspace path')
    return value


def validate_manifest(manifest, maximum):
    if not isinstance(manifest, dict) or manifest.get('version') != 1:
        raise ValueError('Invalid project snapshot')
    groups = ('files', 'links', 'directories', 'regenerable')
    if not all(isinstance(manifest.get(group, []), list) for group in groups) or sum(len(manifest.get(group, [])) for group in groups) > MAX_FILES:
        raise ValueError('Invalid project manifest or entry limit')
    if manifest.get('archivePrefix', '') not in ('', 'payload/'):
        raise ValueError('Invalid project archive prefix')
    occupied, directories, dependencies, spelling = set(), set(), set(), {}
    total = 0
    all_paths = []
    def claim(name, category):
        relative(name)
        if name.lower() in (MANIFEST, PROJECT_METADATA) or name.lower() in occupied | directories | dependencies:
            raise ValueError('Project filename collision')
        parts = name.split('/')
        for index in range(1, len(parts) + 1):
            prefix = '/'.join(parts[:index])
            if prefix.lower() in spelling and spelling[prefix.lower()] != prefix:
                raise ValueError('Portable project filename collision')
            spelling[prefix.lower()] = prefix
        category.add(name.lower())
        all_paths.append(name)
    for item in manifest.get('files', []):
        if not isinstance(item, dict) or not isinstance(item.get('mode'), int) or not 0 <= item['mode'] <= 0o777 or not isinstance(item.get('size'), int) or item['size'] < 0 or not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')):
            raise ValueError('Invalid project file metadata')
        total += item['size']
        if total > maximum:
            raise ValueError('Project snapshot exceeds its byte limit')
        claim(item['path'], occupied)
    for link in manifest.get('links', []):
        safe_link(link['path'], link['target'])
        claim(link['path'], occupied)
    for name in manifest.get('directories', []):
        claim(name, directories)
    for name in manifest.get('regenerable', []):
        if posixpath.basename(name) not in ('node_modules', '.venv', 'venv'):
            raise ValueError('Invalid dependency cache path')
        claim(name, dependencies)
    for name in all_paths:
        parent = posixpath.dirname(name)
        while parent:
            if parent.lower() in occupied | dependencies:
                raise ValueError('Project hierarchy conflicts with a file, link or dependency tree')
            parent = posixpath.dirname(parent)


def safe_path(root, name, missing=False):
    relative(name)
    target = root
    for part in name.split('/'):
        target = target / part
        if target.is_symlink() or getattr(target.lstat() if target.exists() else None, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Linked workspace path')
        try:
            info = target.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise
        if not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            raise ValueError('Linked or special workspace file')
    return target


def regenerable(parent, name):
    def regular(name):
        value = parent / name
        return value.is_file() and not value.is_symlink()
    if name == 'node_modules':
        return any(regular(lock) for lock in ('package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'))
    if name in ('.venv', 'venv'):
        return any(regular(lock) for lock in ('uv.lock', 'poetry.lock', 'requirements.txt'))
    return False


def inventory(root, maximum):
    files, dependencies, links, directories_found, total, names, count = [], [], [], [], 0, set(), 0
    def visit(directory, prefix=''):
        nonlocal total, count
        for target in sorted(directory.iterdir(), key=lambda p: p.name.encode('utf-16-be')):
            count += 1
            if count > MAX_FILES:
                raise ValueError('Project snapshot contains too many entries')
            name = relative(prefix + target.name)
            if name.lower() in (MANIFEST, PROJECT_METADATA):
                raise ValueError('Reserved transfer filename')
            info = target.lstat()
            if os.name == 'nt' and getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('Windows reparse points cannot be published')
            if target.is_symlink():
                link = os.readlink(target)
                safe_link(name, link)
                if not target.resolve(strict=False).is_relative_to(root):
                    raise ValueError('Project link escapes the workspace')
                if name.lower() in names or len(files) + len(links) >= MAX_FILES:
                    raise ValueError('Project snapshot filename collision or limit')
                names.add(name.lower())
                links.append({'path': name, 'target': link})
                continue
            if stat.S_ISDIR(info.st_mode):
                if regenerable(directory, target.name):
                    dependencies.append(name)
                else:
                    directories_found.append(name)
                    visit(target, name + '/')
            else:
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('Linked or special project file: ' + name)
                total += info.st_size
                if total > maximum or len(files) >= MAX_FILES or name.lower() in names:
                    raise ValueError('Project snapshot limit or portable filename collision')
                names.add(name.lower())
                data = target.read_bytes()
                after = target.lstat()
                if (info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                    raise ValueError('Workspace changed during snapshot')
                files.append({'path': name, 'sha256': sha(data), 'size': len(data), 'mode': info.st_mode & 0o777})
    visit(root)
    files.sort(key=lambda item: item['path'].encode('utf-16-be'))
    links.sort(key=lambda item: item['path'].encode('utf-16-be'))
    manifest = {'version': 1, 'files': files, 'regenerable': sorted(dependencies, key=lambda name: name.encode('utf-16-be')), 'links': links,
                'directories': sorted(directories_found, key=lambda name: name.encode('utf-16-be')), 'archivePrefix': 'payload/'}
    validate_manifest(manifest, maximum)
    return manifest


def snapshot(root, destination, maximum):
    manifest = inventory(root, maximum)
    temporary = destination.with_suffix('.part')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
            for item in manifest['files']:
                path = safe_path(root, item['path'])
                data = path.read_bytes()
                if len(data) != item['size'] or sha(data) != item['sha256']:
                    raise ValueError('Workspace changed during snapshot')
                archive.writestr('payload/' + item['path'], data)
            archive.writestr(MANIFEST, encoded(manifest))
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return revision(manifest)


def remove_transfer_tree(path):
    """Delete only disposable transfer copies; retain a busy copy for recovery."""
    if not re.fullmatch(r'\.(?:import|retired)-[a-f0-9]{32}', path.name):
        raise ValueError('Only owned transfer copies may be cleaned')
    def readonly(function, target, exception):
        error = exception[1]
        if os.name != 'nt' or not isinstance(error, PermissionError): raise error
        info = os.lstat(target)
        if getattr(info, 'st_file_attributes', 0) & 0x400 or not getattr(info, 'st_file_attributes', 0) & 1:
            raise error
        # Clear the Windows read-only attribute on this disposable copy only.
        # This never changes ACLs or the installed workspace/original artifacts.
        os.chmod(target, stat.S_IREAD | stat.S_IWRITE)
        function(target)
    for attempt in range(10):
        try:
            shutil.rmtree(path, onerror=readonly)
            return True
        except FileNotFoundError:
            return True
        except OSError as error:
            if os.name == 'nt' and getattr(error, 'winerror', None) in (5, 32, 33) and attempt < 9:
                time.sleep(.1)
                continue
            print(encoded({'event': 'transfer_cleanup_retained', 'tree': path.name, 'type': type(error).__name__, 'winerror': getattr(error, 'winerror', None)}).decode(), file=sys.stderr, flush=True)
            return False


_engine_spec = importlib.util.spec_from_file_location('zigent_native_engine', Path(__file__).with_name('native_engine.py'))
_engine_module = importlib.util.module_from_spec(_engine_spec)
_engine_spec.loader.exec_module(_engine_module)
NativeCommand = _engine_module.NativeCommand
_preview_spec=importlib.util.spec_from_file_location('zigent_preview_worker',Path(__file__).with_name('preview_worker.py'))
_preview_module=importlib.util.module_from_spec(_preview_spec);_preview_spec.loader.exec_module(_preview_module)

class Worker:
    def __init__(self, config):
        self.config = config
        self.root = Path(config['stateDirectory']).resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.native = None
        self.is_windows = config.get('backend') == 'windows-native'
        self.engine = config.get('engine', '/usr/bin/docker')
        if not self.is_windows and not Path(self.engine).is_absolute():
            raise ValueError('Container engine must be an absolute path')
        self.image = config.get('image', config['runtimeIdentity']) if self.is_windows else config['image']
        if not self.is_windows and not re.fullmatch(r'sha256:[a-f0-9]{64}', self.image):
            raise ValueError('Configure the immutable local image ID')
        self.maximum = min(max(int(config.get('maxSnapshotBytes', 512 * 1024 * 1024)), 1024 * 1024), 2 * 1024 * 1024 * 1024)
        self.output_limit = min(max(int(config.get('maxOutputBytes', 128 * 1024 * 1024)), 1024 * 1024), 512 * 1024 * 1024)
        self.max_jobs = min(max(int(config.get('maxConcurrentJobs', 2)), 1), 16)
        self.lock = threading.RLock()
        self.running = {}
        self.admitting = {}
        self.cancelled = set()
        self.terminals = {}
        self.previews = _preview_module.PreviewWorker(self)
        self.draining = False
        self.db = sqlite3.connect(self.root / 'jobs.sqlite', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,workspace TEXT NOT NULL,state TEXT NOT NULL,
          command_hash TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,exit_code INTEGER,error TEXT,snapshot_error TEXT);
          CREATE INDEX IF NOT EXISTS jobs_scope ON jobs(scope,created DESC);
          CREATE TABLE IF NOT EXISTS terminal_jobs(id TEXT PRIMARY KEY,request TEXT NOT NULL);''')
        if self.is_windows:
            from windows_engine import WindowsBackend
            self.native = WindowsBackend(self)
            self.previews = self.native.previews
        else:
            orphaned = subprocess.run([self.engine, 'ps', '-a', '--filter', 'label=org.zigent.execution=true', '--format', '{{.Names}}'],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20,
                                      text=True, check=True, env={'PATH': '/usr/bin:/bin'})
            for name in orphaned.stdout.splitlines():
                if re.fullmatch(r'zigent-[a-f0-9-]{36}', name):
                    self.stop_container(name[7:])
        # A supervisor restart cannot reconstruct stdin or assume a process is safe to adopt.
        # Stop only our named containers and record interruption, never replay a command.
        for job in self.db.execute("SELECT * FROM jobs WHERE state IN ('starting','running')").fetchall():
            self.stop_container(job['id'])
            self.db.execute("UPDATE jobs SET state='interrupted',error=?,updated=? WHERE id=?", (self.native.interruption_reason if self.native else 'Worker restarted; command was not replayed', self.now(), job['id']))
        self.db.commit()

    @staticmethod
    def now():
        return int(time.time() * 1000)

    def identity(self, token):
        value = sha(token.encode())
        for expected, identity in self.config['identities'].items():
            if hmac.compare_digest(value, expected):
                if set(identity) != {'agentId', 'ownerUserId'} or not all(isinstance(v, str) and v for v in identity.values()):
                    raise ValueError('Invalid configured execution identity')
                return {**identity, 'scope': sha(encoded([identity['agentId'], identity['ownerUserId']]))}
        return None

    def workspace(self, identity, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', identifier):
            raise ValueError('Invalid workspace ID')
        scope = self.root / 'workspaces' / identity['scope']
        scope.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory = scope / identifier
        if directory.is_symlink():
            raise ValueError('Linked workspace')
        return directory

    def github_credentials(self, identity):
        return self.root / 'credentials' / identity['scope'] / 'github'

    def provision_github(self, identity, data):
        if identity['agentId'] not in GITHUB_AGENTS:
            raise ValueError('GitHub credential enrollment is not enabled for this Agent')
        if len(data) > 8192 or not data.startswith(b'-----BEGIN OPENSSH PRIVATE KEY-----\n') or not data.rstrip().endswith(b'-----END OPENSSH PRIVATE KEY-----'):
            raise ValueError('Invalid GitHub SSH private key')
        with self.lock:
            directory = self.github_credentials(identity)
            directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if directory.is_dir():
                current = directory / 'id_ed25519'
                if current.is_file() and hmac.compare_digest(current.read_bytes(), data) and (directory / 'config').is_file() and (directory / 'known_hosts').is_file():
                    return {'configured': True}
                raise RuntimeError('A different GitHub credential is already configured')
            stage = directory.parent / ('.github-' + uuid.uuid4().hex)
            stage.mkdir(mode=0o700, exist_ok=False)
            try:
                ssh_config = GITHUB_SSH_CONFIG
                if self.is_windows:
                    # Authorize only the credential explicitly enrolled for this Agent.
                    base = directory.as_posix()
                    ssh_config = ssh_config.replace('/run/zigent-github/id_ed25519', '"' + base + '/id_ed25519"').replace('/run/zigent-github/known_hosts', '"' + base + '/known_hosts"')
                for name, content in [('id_ed25519', data), ('known_hosts', GITHUB_HOST_KEY.encode()), ('config', ssh_config.encode())]:
                    fd = os.open(stage / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(content)
                        stream.flush()
                        os.fsync(stream.fileno())
                os.rename(stage, directory)
            except Exception:
                shutil.rmtree(stage, ignore_errors=True)
                raise
        return {'configured': True}

    def job_path(self, job_id):
        path = self.root / 'jobs' / job_id
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        return path

    def get(self, identity, job_id):
        if not re.fullmatch(r'[a-f0-9-]{36}', job_id):
            raise ValueError('Invalid job ID')
        with self.lock:
            row = self.db.execute('SELECT * FROM jobs WHERE id=? AND scope=?', (job_id, identity['scope'])).fetchone()
            if row is None and (identity['scope'], job_id) in self.admitting:
                raise RuntimeError('Job admission is still pending')
        if row is None:
            raise FileNotFoundError('Job not found')
        return row

    def busy(self, scope, workspace):
        return self.db.execute("SELECT id FROM jobs WHERE scope=? AND workspace=? AND state IN ('starting','running')", (scope, workspace)).fetchone() is not None

    def import_snapshot(self, identity, workspace, data, expected):
        directory = self.workspace(identity, workspace)
        with self.lock:
            if self.busy(identity['scope'], workspace):
                raise RuntimeError('Workspace is running a program')
            if expected == 'new' and directory.exists():
                raise RuntimeError('Remote workspace already exists; reconcile its snapshot before writing')
            current = inventory(directory, self.maximum) if directory.exists() else {'version': 1, 'files': [], 'regenerable': [], 'links': [], 'directories': []}
            if expected != 'new' and not hmac.compare_digest(expected, revision(current)):
                raise RuntimeError('Remote workspace changed; reconcile its snapshot before writing')
            stage = directory.with_name('.import-' + uuid.uuid4().hex)
            stage.mkdir(mode=0o700)
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    entries, total, names = archive.infolist(), 0, set()
                    if len(entries) > MAX_FILES + 1:
                        raise ValueError('Project snapshot contains too many files')
                    for item in entries:
                        relative(item.filename[8:] if item.filename.startswith('payload/') else item.filename)
                        if item.filename.lower() in names or stat.S_ISLNK(item.external_attr >> 16):
                            raise ValueError('Duplicate or linked archive entry')
                        names.add(item.filename.lower())
                        total += item.file_size
                        if total > self.maximum + 16 * 1024 * 1024:
                            raise ValueError('Project snapshot exceeds its limit')
                    if archive.getinfo(MANIFEST).file_size > 16 * 1024 * 1024:
                        raise ValueError('Project manifest exceeds its limit')
                    raw_manifest = archive.read(MANIFEST)
                    if len(raw_manifest) > 16 * 1024 * 1024:
                        raise ValueError('Project manifest exceeds its limit')
                    manifest = json.loads(raw_manifest)
                    validate_manifest(manifest, self.maximum)
                    if self.native and manifest.get('links'):
                        raise ValueError('Windows execution does not import symbolic links; keep the original project and use ordinary files')
                    prefix = manifest.get('archivePrefix', '')
                    if manifest.get('version') != 1 or not isinstance(manifest.get('files'), list) or not isinstance(manifest.get('regenerable'), list) or not isinstance(manifest.get('links'), list):
                        raise ValueError('Invalid project snapshot')
                    if not isinstance(manifest.get('directories', []), list) or len(manifest.get('directories', [])) > MAX_FILES:
                        raise ValueError('Invalid project directories')
                    for name in manifest.get('directories', []):
                        safe_path(stage, relative(name), True).mkdir(mode=0o700, parents=True, exist_ok=True)
                    wanted = {MANIFEST}
                    for item in manifest['files']:
                        name = relative(item['path'])
                        if prefix + name in wanted or name in (MANIFEST, PROJECT_METADATA) or not isinstance(item.get('mode'), int) or not 0 <= item['mode'] <= 0o777:
                            raise ValueError('Duplicate project file')
                        wanted.add(prefix + name)
                        content = archive.read(prefix + name)
                        if len(content) != item['size'] or sha(content) != item['sha256']:
                            raise ValueError('Project snapshot content mismatch')
                        target = safe_path(stage, name, True)
                        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                        with target.open('xb') as stream:
                            stream.write(content)
                        target.chmod(item['mode'])
                    if wanted != set(archive.namelist()):
                        raise ValueError('Unexpected archive entries')
                    for name in manifest['regenerable']:
                        relative(name)
                    occupied = {name.lower() for name in wanted}
                    if len(manifest['files']) + len(manifest['links']) > MAX_FILES:
                        raise ValueError('Project snapshot contains too many files')
                    for link in manifest['links']:
                        name, target = link['path'], link['target']
                        safe_link(name, target)
                        if name.lower() in occupied or any(item['path'].startswith(name + '/') for item in manifest['files']):
                            raise ValueError('Project links conflict with ordinary files')
                        occupied.add(name.lower())
                        path = safe_path(stage, name, True)
                        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                        path.symlink_to(target)
                    for link in manifest['links']:
                        if not (stage / link['path']).resolve(strict=False).is_relative_to(stage):
                            raise ValueError('Project link escapes the workspace')
                # Preserve only known reconstructable dependencies. Source deletion propagates.
                for name in current['regenerable']:
                    source = safe_path(directory, name)
                    target = safe_path(stage, name, True)
                    if not target.exists() and regenerable(target.parent, target.name):
                        target.parent.mkdir(parents=True, exist_ok=True)
                        os.rename(source, target)
                old = directory.with_name('.retired-' + uuid.uuid4().hex)
                if directory.exists():
                    os.rename(directory, old)
                try:
                    os.rename(stage, directory)
                except Exception:
                    if old.exists():
                        os.rename(old, directory)
                    raise
                published = revision(inventory(directory, self.maximum))
                removed = remove_transfer_tree(old) if old.exists() else True
                return {'revision': published, **({'retainedPrevious': old.name} if not removed else {})}
            finally:
                if stage.exists():
                    remove_transfer_tree(stage)

    def stop_container(self, job_id):
        if self.native:
            return self.native.stop(job_id)
        subprocess.run([self.engine, 'kill', 'zigent-' + job_id], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=20, check=False, env={'PATH': '/usr/bin:/bin'})
        for _ in range(20):
            observed = subprocess.run([self.engine, 'ps', '-a', '--filter', 'name=^/zigent-' + job_id + '$', '--format', '{{.State}}'],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      timeout=15, check=False, text=True, env={'PATH': '/usr/bin:/bin'})
            if observed.returncode != 0:
                raise RuntimeError('CONTAINER_STOP_UNCONFIRMED: container engine unavailable')
            states = observed.stdout.strip().splitlines()
            if not states or all(state in ('exited', 'dead') for state in states):
                return
            time.sleep(0.1)
        raise RuntimeError('CONTAINER_STOP_UNCONFIRMED: container still exists')

    def disk_budget(self, directory, extra=()):
        minimum = int(self.config.get('minimumFreeBytes', 4 * 1024 * 1024 * 1024))
        if shutil.disk_usage(self.root).free < minimum:
            return 'Worker disk headroom is exhausted; program was stopped'
        filesystem = os.statvfs(self.root) if hasattr(os, 'statvfs') else None
        if filesystem and filesystem.f_files and filesystem.f_favail < 10000:
            return 'Worker filesystem inode reserve is exhausted; program was stopped'
        maximum = int(self.config.get('maxProjectBytes', 4 * 1024 * 1024 * 1024))
        total, entries = 0, 0
        for parent, directories, files in (row for root in (directory, *extra) for row in os.walk(root, followlinks=False)):
            directories[:] = [name for name in directories if not (Path(parent) / name).is_symlink()]
            entries += len(directories) + len(files)
            if entries > int(self.config.get('maxProjectEntries', 200000)):
                return 'Project exceeded its operating file-count budget; program was stopped'
            for name in files:
                try:
                    info = (Path(parent) / name).lstat()
                except FileNotFoundError:
                    continue
                if stat.S_ISREG(info.st_mode):
                    total += info.st_size
                    if total > maximum:
                        return 'Project exceeded its operating disk budget; program was stopped'
        return None

    def start(self, identity, request):
        if not isinstance(request, dict) or not isinstance(request.get('id'), str):
            raise ValueError('Invalid execution request')
        request = {**request, 'id': str(uuid.UUID(request['id']))}
        key = (identity['scope'], request['id'])
        fingerprint = sha(encoded(request))
        with self.lock:
            if key in self.admitting:
                if self.admitting[key] != fingerprint:
                    raise RuntimeError('Job identity already used for a different request')
                return {'id': request['id'], 'state': 'starting'}
            self.admitting[key] = fingerprint
        try:
            return self.admit(identity, request)
        finally:
            with self.lock:
                self.admitting.pop(key, None)

    def admit(self, identity, request):
        if not {'id', 'workspaceId', 'command', 'cwd', 'timeoutMs'} <= set(request) or set(request) - {'id', 'workspaceId', 'command', 'cwd', 'timeoutMs', 'repairOf', 'terminal'}:
            raise ValueError('Invalid execution request')
        job_id = str(uuid.UUID(request['id']))
        request['id'] = job_id
        command = request['command']
        if not isinstance(command, str) or not command.strip() or len(command) > 64000 or '\0' in command:
            raise ValueError('Invalid command')
        terminal = request.get('terminal')
        if terminal is not None and (not isinstance(terminal, dict) or set(terminal) != {'tty','shell','login'} or not isinstance(terminal['tty'],bool) or not isinstance(terminal['login'],bool) or terminal['shell'] not in (('pwsh','powershell','cmd') if self.native else ('/bin/bash','/bin/sh','/bin/zsh'))):
            raise ValueError('Invalid terminal parameters')
        cwd = relative(request['cwd'], True)
        timeout = request['timeoutMs']
        if not isinstance(timeout, int) or timeout < 1000 or timeout > 86400000:
            raise ValueError('Invalid execution time limit')
        fingerprint = sha(encoded({'id': job_id, 'workspaceId': request['workspaceId'], 'command': command,
                                   'cwd': cwd, 'timeoutMs': timeout, 'repairOf': request.get('repairOf'), 'terminal': terminal}))
        with self.lock:
            previous = self.db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            if previous:
                if previous['scope'] != identity['scope'] or previous['command_hash'] != fingerprint:
                    raise RuntimeError('Job identity already used for a different request')
                return {'id': job_id, 'state': previous['state']}
        directory = self.workspace(identity, request['workspaceId'])
        if not directory.is_dir():
            raise FileNotFoundError('Workspace has not been imported')
        repair = self.get(identity, request['repairOf']) if 'repairOf' in request else None
        if repair and (repair['workspace'] != request['workspaceId'] or repair['state'] not in TERMINAL):
            raise ValueError('Repair must reference a terminal job in this project')
        disk_error = self.disk_budget(directory)
        if disk_error and not repair:
            raise RuntimeError(disk_error)
        if cwd and not safe_path(directory, cwd).is_dir():
            raise ValueError('Working directory does not exist')
        with self.lock:
            previous = self.db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            if previous:
                if previous['scope'] != identity['scope'] or previous['command_hash'] != fingerprint:
                    raise RuntimeError('Job identity already used for a different request')
                return {'id': job_id, 'state': previous['state']}
            if self.draining or len(self.running) >= self.max_jobs:
                raise RuntimeError('Execution capacity is busy; try again later')
            if self.busy(identity['scope'], request['workspaceId']):
                legacy = self.db.execute("SELECT j.id FROM jobs j LEFT JOIN terminal_jobs t ON j.id=t.id WHERE j.scope=? AND j.workspace=? AND j.state IN ('starting','running') AND t.id IS NULL",(identity['scope'],request['workspaceId'])).fetchone()
                if terminal is None or legacy:
                    raise RuntimeError('Workspace is running a program')
            now = self.now()
            self.db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL)',
                            (job_id, identity['scope'], request['workspaceId'], 'starting', fingerprint, now, now))
            if terminal is not None:
                self.db.execute('INSERT INTO terminal_jobs VALUES (?,?)',(job_id,json.dumps(terminal)))
            self.db.commit()
            self.job_path(job_id)
            self.running[job_id] = None
            threading.Thread(target=self.run, args=(identity, request), daemon=True).start()
        return {'id': job_id, 'state': 'starting'}

    def update(self, job_id, state, code=None, error=None, snapshot_error=None):
        with self.lock:
            self.db.execute('UPDATE jobs SET state=?,exit_code=?,error=?,snapshot_error=?,updated=? WHERE id=?',
                            (state, code, error, snapshot_error, self.now(), job_id))
            self.db.commit()

    def run(self, identity, request):
        if self.native:
            return self.native.run(identity, request)
        job_id, workspace = request['id'], request['workspaceId']
        directory, job_directory = self.workspace(identity, workspace), self.job_path(job_id)
        state, code, error = 'failed', None, None
        process, timed_out, monitoring_done = None, threading.Event(), threading.Event()
        resource_errors = []
        try:
            if job_id in self.cancelled:
                state = 'cancelled'
                return
            argv = [self.engine, 'run', '--pull=never', '--rm', '--init', '--interactive', '--name', 'zigent-' + job_id,
                    '--label', 'org.zigent.execution=true',
                    '--user', str(os.getuid()) + ':' + str(os.getgid()), '--read-only', '--cap-drop=ALL',
                    '--security-opt=no-new-privileges', '--pids-limit=512', '--memory=' + str(self.config.get('memory', '4g')),
                    '--cpus=' + str(self.config.get('cpus', 2)), '--network=' + self.config.get('network', 'none'),
                    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
                    '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1',
                    '--tmpfs', '/tmp:rw,nosuid,nodev,size=1073741824',
                    '--mount', 'type=bind,src=' + str(directory) + ',dst=/workspace',
                    '--workdir', '/workspace' + ('/' + request['cwd'] if request['cwd'] else ''),
                    '--env', 'HOME=/workspace/.zigent-home', '--env', 'LANG=C.UTF-8',
                    '--env','ZIGENT_RUNTIME_IDENTITY='+self.config['runtimeIdentity'],
                    self.image, '/bin/bash', '-c', 'mkdir -p "$HOME"; ' + request['command']]
            cache=self.root/'derived-cache'/identity['scope'];cache.mkdir(parents=True,exist_ok=True,mode=0o700)
            insert=argv.index(self.image)
            argv[insert:insert]=['--mount','type=bind,src='+str(Path(__file__).parent/'skills')+',dst=/opt/zigent-skills,readonly',
                '--mount','type=bind,src='+str(cache)+',dst=/opt/zigent-preview-cache,readonly']
            github = self.github_credentials(identity)
            if identity['agentId'] in GITHUB_AGENTS and github.is_dir():
                insert = argv.index(self.image)
                argv[insert:insert] = ['--mount', 'type=bind,src=' + str(github) + ',dst=/run/zigent-github,readonly',
                                       '--env', 'GIT_SSH_COMMAND=ssh -F /run/zigent-github/config']
            terminal = request.get('terminal')
            if terminal is not None:
                argv[argv.index(self.image)+1:] = ['/bin/bash','-c','mkdir -p "$HOME"; exec /usr/local/bin/zigent-execution']
            process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL if terminal is not None else subprocess.STDOUT,
                                       env={'PATH': '/usr/bin:/bin'}, start_new_session=True)
            if terminal is None:
                os.set_blocking(process.stdin.fileno(), False)
            with self.lock:
                self.running[job_id] = process
            self.update(job_id, 'running')
            if job_id in self.cancelled:
                self.stop_container(job_id)
            def monitor():
                while not monitoring_done.wait(0.5):
                    try:
                        failure = self.disk_budget(directory) if 'repairOf' not in request else ('Worker disk headroom is exhausted; repair cannot continue' if shutil.disk_usage(self.root).free < 512 * 1024 * 1024 else None)
                        if failure and not resource_errors:
                            resource_errors.append(failure)
                        if job_id in self.cancelled or resource_errors:
                            self.stop_container(job_id)
                    except Exception as failure:
                        if not resource_errors:
                            resource_errors.append(str(failure)[:1000])
            threading.Thread(target=monitor, daemon=True).start()
            def expire():
                timed_out.set()
                self.stop_container(job_id)
            timer = threading.Timer(request['timeoutMs'] / 1000, expire)
            timer.daemon = True
            timer.start()
            total = 0
            try:
                with (job_directory / 'output.log').open('wb') as stream:
                    if terminal is not None:
                        engine = NativeCommand(process, job_id, stream, self.output_limit)
                        identifier = engine.start({**request, **terminal,'github':identity['agentId'] in GITHUB_AGENTS and github.is_dir()})
                        with self.lock:
                            self.terminals[job_id] = (engine, terminal['tty'])
                        response = engine.wait(identifier)
                        code = response['exitCode']
                        if response.get('timedOut'):
                            error = 'Program exceeded its execution time limit'
                        process.stdin.close()
                        process.wait(timeout=20)
                    else:
                        while True:
                            chunk = os.read(process.stdout.fileno(), 16384)
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > self.output_limit:
                                error = 'Program output exceeded its disk budget'
                                self.stop_container(job_id)
                                break
                            stream.write(chunk)
                            stream.flush()
                        code = process.wait(timeout=30)
            finally:
                timer.cancel()
            state = 'cancelled' if job_id in self.cancelled else 'failed' if timed_out.is_set() or resource_errors or error or code else 'completed'
            if resource_errors:
                error = resource_errors[0]
            if timed_out.is_set():
                error = 'Program exceeded its execution time limit'
        except Exception as failure:
            state='cancelled' if job_id in self.cancelled else 'failed'
            error = str(failure)[:1000]
            try:
                self.stop_container(job_id)
            except Exception:
                pass
            if process and process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=20)
        finally:
            monitoring_done.set()
            stopped = True
            try:
                self.stop_container(job_id)
            except Exception as stop_error:
                # Never publish or release a workspace while its process may still run.
                self.update(job_id, 'running', code, 'CONTAINER_STOP_UNCONFIRMED: ' + str(stop_error)[:900])
                with self.lock:
                    self.running[job_id] = None
                stopped = False
            if stopped:
                with self.lock:
                    self.update(job_id, state, code, error)
                    self.running.pop(job_id, None)
                    self.terminals.pop(job_id, None)
                    self.cancelled.discard(job_id)
                    if not self.busy(identity['scope'], workspace):
                        try:
                            snapshot(directory, job_directory / 'snapshot.zip', self.maximum)
                            rows=self.db.execute("SELECT id FROM jobs WHERE scope=? AND workspace=? AND state NOT IN ('starting','running')",(identity['scope'],workspace)).fetchall()
                            for row in rows:
                                target=self.job_path(row['id'])
                                if not (target/'acknowledged.json').exists() and not (target/'snapshot.zip').exists():
                                    os.link(job_directory/'snapshot.zip',target/'snapshot.zip')
                        except Exception as failure:
                            self.update(job_id,state,code,error,str(failure)[:1000])
            if process:
                if process.stdin:
                    process.stdin.close()
                if process.stdout:
                    process.stdout.close()

    def read(self, identity, job_id, offset, limit):
        row = self.get(identity, job_id)
        if row['state'] == 'running' and (row['error'] or '').startswith('CONTAINER_STOP_UNCONFIRMED'):
            try:
                self.stop_container(job_id)
                failure = None
                try:
                    snapshot(self.workspace(identity, row['workspace']), self.job_path(job_id) / 'snapshot.zip', self.maximum)
                except Exception as error:
                    failure = str(error)[:1000]
                self.update(job_id, 'interrupted', row['exit_code'], 'Execution was interrupted; container termination has now been confirmed', failure)
                with self.lock:
                    self.running.pop(job_id, None)
                row = self.get(identity, job_id)
            except Exception:
                pass
        path = self.job_path(job_id) / 'output.log'
        size = path.stat().st_size if path.exists() else 0
        offset = min(offset, size)
        content = b''
        if path.exists():
            with path.open('rb') as stream:
                stream.seek(offset)
                content = stream.read(max(4, limit))
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        output = decoder.decode(content, final=row['state'] in TERMINAL and offset + len(content) == size)
        pending = decoder.getstate()[0]
        consumed = len(content) - len(pending)
        return {'id': job_id, 'state': row['state'], 'exitCode': row['exit_code'], 'error': row['error'],
                'snapshotError': row['snapshot_error'], 'output': output,
                'offset': offset, 'nextOffset': offset + consumed, 'outputBytes': size, 'truncated': offset + consumed < size}

    def acknowledge(self, identity, job_id, request):
        row = self.get(identity, job_id)
        if row['state'] not in TERMINAL or set(request) != {'snapshotSha256', 'logSha256'} or not all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in request.values()):
            raise ValueError('Invalid durable export acknowledgement')
        directory = self.job_path(job_id)
        receipt = directory / 'acknowledged.json'
        with self.lock:
            if receipt.exists():
                if json.loads(receipt.read_text(encoding="utf-8")) != request:
                    raise RuntimeError('Conflicting export acknowledgement')
                return {'acknowledged': True}
            snapshot_path, log_path = directory / 'snapshot.zip', directory / 'output.log'
            log_hash = file_digest(log_path) if log_path.exists() else sha(b'')
            if not snapshot_path.is_file() or file_digest(snapshot_path) != request['snapshotSha256'] or log_hash != request['logSha256']:
                raise RuntimeError('Export acknowledgement does not match retained bytes')
            temporary = directory / 'acknowledged.part'
            with temporary.open('w') as stream:
                json.dump(request, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, receipt)
            snapshot_path.unlink()
            log_path.unlink(missing_ok=True)
        return {'acknowledged': True}


class Handler(BaseHTTPRequestHandler):
    server_version = 'ZigentExecution/1'
    protocol_version = 'HTTP/1.1'

    def setup(self):
        self.request.settimeout(30)
        super().setup()

    def log_message(self, *_):
        pass  # Request paths and bodies may contain private project metadata.

    def json(self, status, value):
        payload = encoded(value)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def body(self, limit):
        length = int(self.headers.get('Content-Length', '-1'))
        if length < 0 or length > limit or self.headers.get('Transfer-Encoding'):
            raise ValueError('Invalid or excessive request body')
        value = self.rfile.read(length)
        if len(value) != length:
            raise ValueError('Incomplete request body')
        return value

    def handle_request(self):
        self.connection.settimeout(120)
        worker = self.server.worker
        authorization = self.headers.get('Authorization', '')
        identity = worker.identity(authorization[7:]) if authorization.startswith('Bearer ') and len(authorization) <= 512 else None
        if not identity:
            self.json(401, {'error': 'Execution authentication required'})
            return
        parsed = urlsplit(self.path)
        parts = [unquote(part) for part in parsed.path.split('/') if part]
        method = self.command
        if method == 'GET' and parts == ['v1', 'health']:
            if worker.native:
                self.json(200, worker.native.health(identity))
                return
            subprocess.run([worker.engine, 'image', 'inspect', worker.image], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin'}, check=True, timeout=15)
            self.json(200, {'protocol': 1, 'agentId': identity['agentId'], 'ownerUserId': identity['ownerUserId'], 'backend': 'container', 'image': worker.image,
                            'admissionTracking': True,
                            'capabilities': {key:worker.config.get('runtimeCapabilities',{}).get(key) for key in ['python','packages','helpers','tools','fonts','workspace','commandRuntime','skills'] if key in worker.config.get('runtimeCapabilities',{})},
                            'runtimeIdentity': worker.config.get('runtimeIdentity'),
                            'githubSshConfigured': identity['agentId'] in GITHUB_AGENTS and worker.github_credentials(identity).is_dir()})
        elif worker.native and method == 'POST' and parts == ['v1','admin','drain']:
            self.body(1024)
            with worker.lock:
                worker.draining = True
                active = len(worker.running) + len(worker.admitting)
            self.json(200, {'draining': True, 'active': active})
        elif method == 'POST' and parts == ['v1','derived','preview']:
            self.json(200,worker.previews.run(identity,json.loads(self.body(190*1024*1024))))
        elif method == 'PUT' and parts == ['v1', 'credentials', 'github']:
            self.json(201, worker.provision_github(identity, self.body(8192)))
        elif method == 'PUT' and len(parts) == 4 and parts[:2] == ['v1', 'workspaces'] and parts[3] == 'snapshot':
            data = self.body(worker.maximum + 32 * 1024 * 1024)
            self.json(200, worker.import_snapshot(identity, parts[2], data, self.headers.get('X-Expected-Revision', '')))
        elif method == 'GET' and len(parts) == 4 and parts[:2] == ['v1','workspaces'] and parts[3] == 'files':
            query=parse_qs(parsed.query,keep_blank_values=True);name=relative(query.get('path',[''])[0],True)
            directory=safe_path(worker.workspace(identity,parts[2]),name) if name else worker.workspace(identity,parts[2])
            offset=int(query.get('offset',['0'])[0]);limit=int(query.get('limit',['100'])[0])
            if offset<0 or not 1<=limit<=200:raise ValueError('Invalid directory range')
            entries=sorted((p for p in directory.iterdir() if p.name not in (MANIFEST,PROJECT_METADATA)),key=lambda p:(not p.is_dir(),p.name));files=[]
            for path in entries[offset:offset+limit]:
                info=path.lstat();files.append({'path':(name+'/' if name else '')+path.name,'name':path.name,'type':'directory' if stat.S_ISDIR(info.st_mode) else 'file','size':info.st_size,'modifiedAt':int(info.st_mtime*1000)})
            self.json(200,{'workspaceId':parts[2],'path':name or '.','files':files,**({'nextOffset':offset+limit} if offset+limit<len(entries) else {})})
        elif method == 'GET' and len(parts) == 4 and parts[:2] == ['v1','workspaces'] and parts[3] == 'file':
            query=parse_qs(parsed.query);directory=worker.workspace(identity,parts[2]);path=safe_path(directory,relative(query['path'][0]))
            before=path.stat()
            if not stat.S_ISREG(before.st_mode) or before.st_size>256*1024*1024:
                raise ValueError('Execution file must be ordinary and bounded')
            data=path.read_bytes();after=path.stat()
            if (before.st_ino,before.st_mtime_ns,before.st_size)!=(after.st_ino,after.st_mtime_ns,after.st_size):
                raise RuntimeError('File changed while reading; try again')
            self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        elif method == 'GET' and len(parts) == 4 and parts[:2] == ['v1', 'workspaces'] and parts[3] == 'snapshot':
            directory = worker.workspace(identity, parts[2])
            with worker.lock:
                if worker.busy(identity['scope'], parts[2]):
                    raise RuntimeError('Program is still running')
                if not directory.is_dir():
                    raise FileNotFoundError('Workspace not found')
                retained = worker.root / 'recovery' / identity['scope']
                retained.mkdir(mode=0o700, parents=True, exist_ok=True)
                path = retained / (parts[2] + '.zip')
                snapshot(directory, path, worker.maximum)
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Length', str(path.stat().st_size))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            with path.open('rb') as stream:
                shutil.copyfileobj(stream, self.wfile, 1024 * 1024)
        elif method == 'POST' and parts == ['v1', 'jobs']:
            self.json(201, worker.start(identity, json.loads(self.body(128 * 1024))))
        elif len(parts) >= 3 and parts[:2] == ['v1', 'jobs']:
            job_id = parts[2]
            row = worker.get(identity, job_id)
            if method == 'GET' and len(parts) == 3:
                query = parse_qs(parsed.query)
                offset, limit = int(query.get('offset', ['0'])[0]), int(query.get('limit', ['16000'])[0])
                if offset < 0 or not 1 <= limit <= 64000:
                    raise ValueError('Invalid output range')
                self.json(200, worker.read(identity, job_id, offset, limit))
            elif method == 'GET' and len(parts) == 4 and parts[3] == 'export':
                if row['state'] not in TERMINAL:raise RuntimeError('Program is still running')
                directory=worker.job_path(job_id);path=directory/'snapshot.zip'
                if not path.is_file():raise RuntimeError('Workspace export is not ready')
                self.json(200,{'snapshotSha256':file_digest(path),'size':path.stat().st_size})
            elif method == 'GET' and len(parts) == 4 and parts[3] == 'log':
                if row['state'] not in TERMINAL:
                    raise RuntimeError('Program is still running')
                if (worker.job_path(job_id) / 'acknowledged.json').exists():
                    self.json(410, {'error': 'Execution log is durably archived by the control plane'})
                    return
                path = worker.job_path(job_id) / 'output.log'
                size = path.stat().st_size if path.exists() else 0
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Content-Length', str(size))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                if path.exists():
                    with path.open('rb') as stream:
                        shutil.copyfileobj(stream, self.wfile, 1024 * 1024)
            elif method == 'GET' and len(parts) == 4 and parts[3] == 'snapshot':
                if row['state'] not in TERMINAL:
                    raise RuntimeError('Program is still running')
                if (worker.job_path(job_id) / 'acknowledged.json').exists():
                    self.json(410, {'error': 'Project snapshot is durably archived by the control plane'})
                    return
                if row['snapshot_error']:
                    raise RuntimeError(row['snapshot_error'])
                path = worker.job_path(job_id) / 'snapshot.zip'
                if not path.is_file():
                    # Interrupted jobs retain the project and can still publish a fresh snapshot.
                    with worker.lock:
                        if worker.busy(identity['scope'],row['workspace']):
                            raise RuntimeError('Workspace is running a program')
                        snapshot(worker.workspace(identity, row['workspace']), path, worker.maximum)
                self.send_response(200)
                self.send_header('Content-Type', 'application/zip')
                self.send_header('Content-Length', str(path.stat().st_size))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                with path.open('rb') as stream:
                    shutil.copyfileobj(stream, self.wfile, 1024 * 1024)
            elif method == 'POST' and len(parts) == 4 and parts[3] == 'stdin':
                request = json.loads(self.body(128 * 1024))
                if set(request) != {'text'} or not isinstance(request['text'], str) or len(request['text'].encode()) > 4096 or '\0' in request['text']:
                    raise ValueError('Invalid program input')
                with worker.lock:
                    terminal=worker.terminals.get(job_id)
                    process=worker.running.get(job_id)
                if not terminal and worker.db.execute('SELECT id FROM terminal_jobs WHERE id=?',(job_id,)).fetchone():
                    deadline=time.monotonic()+20
                    while not terminal and time.monotonic()<deadline:
                        with worker.lock:terminal=worker.terminals.get(job_id)
                        if worker.get(identity,job_id)['state'] in TERMINAL:break
                        if not terminal:time.sleep(.05)
                if terminal:
                    terminal[0].write(request['text'],terminal[1])
                else:
                    if worker.db.execute('SELECT id FROM terminal_jobs WHERE id=?',(job_id,)).fetchone():
                        raise RuntimeError('Terminal is starting; poll before sending input')
                    if not process or process.poll() is not None:
                        raise RuntimeError('Program is no longer accepting input')
                    try:
                        accepted=os.write(process.stdin.fileno(),request['text'].encode())
                    except BlockingIOError:
                        raise RuntimeError('Program input is busy; read its output before sending more input')
                    if accepted != len(request['text'].encode()):
                        raise RuntimeError('Program accepted only part of its input')
                self.json(200, {'accepted': True})
            elif method == 'POST' and len(parts) == 4 and parts[3] == 'acknowledge':
                self.json(200, worker.acknowledge(identity, job_id, json.loads(self.body(1024))))
            elif method == 'POST' and len(parts) == 4 and parts[3] == 'cancel':
                self.body(1024)
                if row['state'] not in TERMINAL:
                    with worker.lock:
                        worker.cancelled.add(job_id)
                    worker.stop_container(job_id)
                self.json(200, {'accepted': True, 'terminationConfirmed': True})
            else:
                self.json(404, {'error': 'Execution route not found'})
        else:
            self.json(404, {'error': 'Execution route not found'})

    def dispatch(self):
        try:
            self.handle_request()
        except FileNotFoundError as error:
            self.close_connection = True
            self.json(404, {'error': str(error)[:1000]})
        except RuntimeError as error:
            self.close_connection = True
            self.json(409, {'error': str(error)[:1000]})
        except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
            self.close_connection = True
            self.json(400, {'error': str(error)[:1000]})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as error:
            self.close_connection = True
            trace = error.__traceback__
            while trace and trace.tb_next: trace = trace.tb_next
            # Operational codes and repository function/line only. Never expose
            # request bodies, paths, command text, credentials or raw exceptions.
            location = (trace.tb_frame.f_code.co_name + ':' + str(trace.tb_lineno)) if trace else 'unknown'
            detail = type(error).__name__ + '; errno=' + str(getattr(error, 'errno', None)) + '; winerror=' + str(getattr(error, 'winerror', None)) + '; at=' + location
            self.json(503, {'error': 'Execution infrastructure unavailable (' + detail + ')'})

    do_GET = dispatch
    do_POST = dispatch
    do_PUT = dispatch


class BoundedHTTPServer(ThreadingHTTPServer):
    def __init__(self, *args, **kwargs):
        self.capacity = threading.BoundedSemaphore(8)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.capacity.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.capacity.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.capacity.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    arguments = parser.parse_args()
    path = Path(arguments.config).resolve()
    permissions = path.stat()
    if path.is_symlink() or os.name != 'nt' and permissions.st_mode & 0o027:
        raise RuntimeError('Execution config must not be writable by group or readable by others')
    config = json.loads(path.read_text(encoding="utf-8"))
    worker = Worker(config)
    server = BoundedHTTPServer((config.get('listenHost', '127.0.0.1'), int(config.get('listenPort', 17643))), Handler)
    server.daemon_threads = True
    server.worker = worker
    def shutdown(*_):
        worker.draining = True
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        worker.draining = True
        # Every command has a bounded timeout. A release waits for its worker jobs.
        while worker.running:
            time.sleep(0.25)
        worker.db.close()


if __name__ == '__main__':
    main()
