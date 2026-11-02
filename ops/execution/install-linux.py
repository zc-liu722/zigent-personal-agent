#!/usr/bin/env python3
"""Provision the trusted Linux broker from an exact checked-out Git release.

Run as root after host/container prerequisites have been explicitly authorized.
The identities input contains only SHA-256 token digests and exact owner scopes.
Never put bearer tokens or identity configuration in the repository.
"""
import argparse
import base64
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import tarfile


ASSETS = json.loads(Path(__file__).with_name('runtime-assets.json').read_text())
SOURCE_FILES = frozenset(ASSETS['sourceFiles'])
IMAGE_INPUT_FILES = frozenset(ASSETS['imageInputFiles'])
PLATFORM = 'linux/amd64'


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def fingerprint(domain, files):
    content = domain + '\nplatform=' + PLATFORM + '\n'
    content += ''.join(path + '\0' + files[path] + '\n' for path in sorted(files))
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


def verify_runtime_manifest(path, release, commit, image_id):
    """Validate the exact offline component before account/configuration changes."""
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024 * 1024:
        raise RuntimeError('Runtime manifest must be an ordinary bounded file')
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if (not isinstance(manifest, dict) or type(manifest.get('protocol')) is not int
            or manifest.get('protocol') != 1 or manifest.get('platform') != PLATFORM
            or manifest.get('sourceCommit') != commit or manifest.get('imageId') != image_id
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id)
            or not all(digest(manifest.get(name)) for name in (
                'componentFingerprint', 'imageInputsFingerprint', 'runtimeIdentity'))):
        raise RuntimeError('Offline runtime identity/protocol/platform does not match the requested component')
    maps = []
    for field, expected in (('sourceFiles', SOURCE_FILES), ('imageInputFiles', IMAGE_INPUT_FILES)):
        files = manifest.get(field)
        if not isinstance(files, dict) or set(files) != expected or not all(digest(value) for value in files.values()):
            raise RuntimeError('Offline runtime source inventory is invalid')
        for relative, expected_hash in files.items():
            current = release
            for part in Path(relative).parts:
                current /= part
                if current.is_symlink():
                    raise RuntimeError('Offline runtime source links are refused')
            info = current.lstat()
            if not stat.S_ISREG(info.st_mode) or hashlib.sha256(current.read_bytes()).hexdigest() != expected_hash:
                raise RuntimeError('Offline runtime source bytes do not match the component manifest')
        maps.append(files)
    combined = dict(maps[0])
    for name, value in maps[1].items():
        if name in combined and combined[name] != value:
            raise RuntimeError('Offline runtime inventories disagree')
        combined[name] = value
    if (fingerprint('zigent-execution-component-v1', combined) != manifest['componentFingerprint']
            or fingerprint('zigent-execution-image-inputs-v1', maps[1]) != manifest['imageInputsFingerprint']):
        raise RuntimeError('Offline runtime source fingerprints do not match')
    bases = manifest.get('baseDigests')
    if not isinstance(bases, list) or not bases or len(bases) > 16:
        raise RuntimeError('Offline runtime base image inventory is invalid')
    seen = set()
    for base in bases:
        if (not isinstance(base, dict) or set(base) != {'reference', 'digest'}
                or not isinstance(base['reference'], str)
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}', base['reference'])
                or base['reference'] in seen
                or not isinstance(base['digest'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', base['digest'])):
            raise RuntimeError('Offline runtime base image identity is invalid')
        seen.add(base['reference'])
    identity = ('zigent-execution-runtime-v1\nplatform=' + PLATFORM
                + '\ncomponentFingerprint=' + manifest['componentFingerprint']
                + '\nimageInputsFingerprint=' + manifest['imageInputsFingerprint']
                + '\nimageId=' + image_id + '\n')
    identity += ''.join(base['reference'] + '\0' + base['digest'] + '\n'
                        for base in sorted(bases, key=lambda value: value['reference']))
    if hashlib.sha256(identity.encode('utf-8')).hexdigest() != manifest['runtimeIdentity']:
        raise RuntimeError('Offline runtime package identity does not match')
    files = manifest.get('files')
    expected_payloads = {'image.tar.gz': 'docker-save-gzip', 'source.bundle': 'git-bundle'}
    if not isinstance(files, list) or len(files) != len(expected_payloads):
        raise RuntimeError('Offline runtime payload inventory is invalid')
    names = set()
    for file in files:
        if (not isinstance(file, dict) or file.get('name') not in expected_payloads
                or file.get('name') in names or file.get('kind') != expected_payloads[file['name']]
                or type(file.get('size')) is not int or not 0 < file['size'] <= 2**53 - 1
                or not digest(file.get('sha256'))):
            raise RuntimeError('Offline runtime payload identity is invalid')
        names.add(file['name'])
    return manifest


def archive_image_bindings(manifest_path, runtime):
    """Bind classic config IDs and containerd manifest IDs to the same archive."""
    archive = manifest_path.parent / 'image.tar.gz'
    expected = next(file for file in runtime['files'] if file['name'] == 'image.tar.gz')
    info = archive.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != expected['size']:
        raise RuntimeError('Runtime image archive size/type does not match the package')
    metadata, seen, collected, expanded = {}, set(), 0, 0
    with archive.open('rb') as stream:
        checksum = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
        if checksum.hexdigest() != expected['sha256']:
            raise RuntimeError('Runtime image archive failed SHA256 verification')
        stream.seek(0)
        # Inspect metadata only: never extract archive paths to the filesystem.
        with tarfile.open(fileobj=stream, mode='r|gz') as image:
            for member in image:
                expanded += member.size
                if len(seen) >= 20000 or expanded > 32 * 1024**3 or member.name in seen:
                    raise RuntimeError('Runtime image archive metadata exceeds its bounds or repeats a path')
                seen.add(member.name)
                if member.issym() or member.islnk():
                    raise RuntimeError('Runtime image archive outer links are refused')
                if not member.isfile():
                    continue
                wanted = member.name in ('manifest.json', 'index.json', 'oci-layout')
                blob = re.fullmatch(r'(?:blobs/sha256/[a-f0-9]{64}|[a-f0-9]{64}\.json)', member.name)
                if not wanted and not blob:
                    continue
                if member.size > 2 * 1024 * 1024:
                    if wanted:
                        raise RuntimeError('Runtime image metadata document is too large')
                    continue
                content = image.extractfile(member).read()
                collected += len(content)
                if collected > 32 * 1024 * 1024:
                    raise RuntimeError('Runtime image metadata budget exceeded')
                metadata[member.name] = content
    docker_manifest = json.loads(metadata['manifest.json'])
    if not isinstance(docker_manifest, list) or len(docker_manifest) != 1 or not isinstance(docker_manifest[0], dict):
        raise RuntimeError('Runtime archive must contain one Docker image')
    saved = docker_manifest[0]
    config_path = saved.get('Config')
    match = re.fullmatch(r'(?:blobs/sha256/([a-f0-9]{64})|([a-f0-9]{64})\.json)', config_path or '')
    if not match or config_path not in metadata:
        raise RuntimeError('Runtime archive config reference is invalid')
    config_sha = match.group(1) or match.group(2)
    config_bytes = metadata[config_path]
    if hashlib.sha256(config_bytes).hexdigest() != config_sha:
        raise RuntimeError('Runtime archive config digest does not match its bytes')
    config = json.loads(config_bytes)
    if not isinstance(config, dict) or config.get('os') != 'linux' or config.get('architecture') != 'amd64':
        raise RuntimeError('Runtime archive config platform is not Linux/amd64')
    bindings = {'configId': 'sha256:' + config_sha, 'manifestId': None}
    if 'index.json' in metadata or 'oci-layout' in metadata:
        if json.loads(metadata['oci-layout']).get('imageLayoutVersion') != '1.0.0':
            raise RuntimeError('Runtime archive OCI layout is invalid')
        index = json.loads(metadata['index.json'])
        descriptors = index.get('manifests')
        if index.get('schemaVersion') != 2 or not isinstance(descriptors, list) or len(descriptors) != 1:
            raise RuntimeError('Runtime archive must identify exactly one OCI image manifest')
        descriptor = descriptors[0]
        manifest_id = descriptor.get('digest', '')
        if (descriptor.get('mediaType') not in ('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json')
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', manifest_id)):
            raise RuntimeError('Runtime archive OCI manifest descriptor is invalid')
        manifest_bytes = metadata.get('blobs/sha256/' + manifest_id[7:])
        if (manifest_bytes is None or len(manifest_bytes) != descriptor.get('size')
                or hashlib.sha256(manifest_bytes).hexdigest() != manifest_id[7:]):
            raise RuntimeError('Runtime archive OCI manifest digest does not match its bytes')
        image_manifest = json.loads(manifest_bytes)
        config_descriptor = image_manifest.get('config', {})
        layers = image_manifest.get('layers')
        if (image_manifest.get('schemaVersion') != 2 or image_manifest.get('mediaType') != descriptor['mediaType']
                or config_descriptor.get('digest') != bindings['configId'] or config_descriptor.get('size') != len(config_bytes)
                or not isinstance(layers, list) or not layers
                or any(not isinstance(layer, dict) or not re.fullmatch(r'sha256:[a-f0-9]{64}', layer.get('digest', '')) for layer in layers)
                or saved.get('Layers') != ['blobs/sha256/' + layer['digest'][7:] for layer in layers]):
            raise RuntimeError('Runtime archive Docker/OCI image descriptors disagree')
        bindings['manifestId'] = manifest_id
    if runtime['imageId'] not in (bindings['configId'], bindings['manifestId']):
        raise RuntimeError('Published runtime image ID is not bound to its archive config/manifest')
    return bindings


def inspect_runtime_image(bindings):
    candidates = list(dict.fromkeys(value for value in bindings.values() if value))
    for reference in candidates:
        result = subprocess.run(['/usr/bin/docker', 'image', 'inspect', reference], check=False, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        if result.returncode:
            continue
        images = json.loads(result.stdout)
        if (not isinstance(images, list) or len(images) != 1 or images[0].get('Id') not in candidates
                or images[0].get('Os') != 'linux' or images[0].get('Architecture') != 'amd64'):
            raise RuntimeError('The imported runtime image does not match its bound immutable identity/platform')
        return images[0]['Id']
    raise RuntimeError('Neither archive-bound runtime image identity is loaded in the container engine')


def run(*arguments, capture=False):
    result = subprocess.run(arguments, check=True, text=True,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL)
    return result.stdout.strip() if capture else None


def runtime_capabilities(image):
    """Measure only the immutable image; no user project, credentials or network."""
    script = r'''import base64,hashlib,importlib.metadata,json,os,platform,shutil,subprocess,tempfile,signal
from pathlib import Path
packages={}
for name in ["python-docx","docxcompose","lxml","pypdf","pdfplumber","pypdfium2","PyMuPDF","reportlab","Pillow","openpyxl","python-pptx"]:
    try:packages[name]=importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:packages[name]=None
helpers={}
for name in ["word","pdf","render_docx","render_pdf"]:
    path=Path("/opt/zigent-file-runtime")/(name+".py")
    if path.is_file():helpers[name]={"path":str(path),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
fonts=sorted({p.name for p in Path("/usr/share/fonts").rglob("*") if p.suffix.lower() in {".ttf",".ttc",".otf"}})
binary="/usr/local/bin/zigent-execution"
signal.alarm(45)
with tempfile.TemporaryDirectory() as root:
    process=subprocess.Popen([binary],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,cwd=root)
    try:
        process.stdin.write(json.dumps({"id":1,"op":"start","params":{"command":["/bin/sh","-c","printf native-ready"],"cwd":root,"tty":True,"timeoutMs":10000}})+"\n");process.stdin.flush()
        output=b""
        while True:
            line=process.stdout.readline()
            if not line:raise RuntimeError("Native process transport closed")
            value=json.loads(line)
            if value.get("event")=="output":output+=base64.b64decode(value["data"])
            if value.get("id")==1:
                if value.get("error") or value["result"]["exitCode"]!=0 or output!=b"native-ready":raise RuntimeError("Native terminal execution is not ready")
                break
        patch="*** Begin Patch\n*** Add File: "+root+"/health.txt\n+native-patch-ready\n*** End Patch\n"
        result=subprocess.run(["apply_patch",patch],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        if result.returncode or (Path(root)/"health.txt").read_text().strip()!="native-patch-ready":raise RuntimeError("Native patch engine is not ready")
        if shutil.which("codex"):raise RuntimeError("Full Codex must not be included in the generic runtime")
    finally:
        process.stdin.close()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
signal.alarm(0)
print(json.dumps({"python":{"command":shutil.which("python3"),"version":platform.python_version()},"packages":packages,"helpers":helpers,"tools":{name:shutil.which(name) for name in ["node","git","rg","soffice","pdftoppm","tesseract","zigent-execution","apply_patch"]},"fonts":{"cjk":any("cjk" in name.lower() for name in fonts),"names":fonts[:80]},"workspace":"/workspace","commandRuntime":{"engine":"zigent-native","version":subprocess.check_output([binary,"--version"],text=True).strip(),"ready":True,"protocol":"zigent-process-v1"},"skills":"/opt/zigent-skills"}))'''
    output=run('/usr/bin/docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,nodev,size=134217728','--user','65534:65534','--env','PYTHONDONTWRITEBYTECODE=1','--entrypoint','python3',image,'-c',script,capture=True)
    result=json.loads(output)
    if set(result)!= {'python','packages','helpers','tools','fonts','workspace','commandRuntime','skills'} or not all(result['packages'].values()) or set(result['helpers'])!={'word','pdf','render_docx','render_pdf'}:
        raise RuntimeError('The immutable document programming runtime is incomplete')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', required=True, help='Exact Git checkout root')
    parser.add_argument('--commit', required=True)
    parser.add_argument('--runtime-manifest', required=True, help='Verified offline component manifest')
    parser.add_argument('--image-id', required=True, help='Already imported immutable Docker image ID')
    parser.add_argument('--identities', required=True, help='Controlled JSON digest-to-identity map')
    parser.add_argument('--listen-host', default='127.0.0.1')
    parser.add_argument('--listen-port', default=17643, type=int)
    parser.add_argument('--network', default='none', choices=['none', 'zigent-execution'])
    parser.add_argument('--tunnel-public-key', help='Enroll one constrained Windows-to-guest SSH forward key')
    parser.add_argument('--install-host-packages', action='store_true')
    args = parser.parse_args()
    if os.getuid() != 0 or not re.fullmatch(r'[a-f0-9]{40}', args.commit):
        raise RuntimeError('Root provisioning and an exact Git commit are required')
    release = Path(args.release).resolve()
    if run('git', '-C', str(release), 'rev-parse', 'HEAD', capture=True) != args.commit:
        raise RuntimeError('Release checkout does not match the requested commit')
    if run('git', '-C', str(release), 'status', '--porcelain', '--', 'ops/execution', capture=True):
        raise RuntimeError('Execution release sources are modified')
    manifest_path = Path(args.runtime_manifest)
    runtime = verify_runtime_manifest(manifest_path, release, args.commit, args.image_id)
    image_bindings = archive_image_bindings(manifest_path, runtime)
    source = release / 'ops' / 'execution'
    identities_path = Path(args.identities).resolve()
    if identities_path.is_relative_to(release) or identities_path.stat().st_mode & 0o077:
        raise RuntimeError('Identity enrollment must be a private file outside the checkout')
    identities = json.loads(identities_path.read_text())
    if not identities or not all(re.fullmatch(r'[a-f0-9]{64}', key) and set(value) == {'agentId', 'ownerUserId'}
                                 and all(isinstance(item, str) and item for item in value.values()) for key, value in identities.items()):
        raise RuntimeError('Invalid execution identity enrollment')
    if args.install_host_packages:
        run('apt-get', 'update')
        run('apt-get', 'install', '-y', 'docker.io', 'python3', 'iptables')
        run('systemctl', 'enable', '--now', 'docker.service')
    run('/usr/bin/docker', 'info')
    image = inspect_runtime_image(image_bindings)
    capabilities = runtime_capabilities(image)
    username = 'zigent-execution'
    try:
        account = pwd.getpwnam(username)
    except KeyError:
        run('useradd', '--system', '--user-group', '--create-home', '--home-dir', '/var/lib/zigent-execution', '--shell', '/usr/sbin/nologin', username)
        account = pwd.getpwnam(username)
    run('usermod', '-aG', 'docker', username)
    if args.tunnel_public_key:
        key_path = Path(args.tunnel_public_key).resolve()
        key = key_path.read_text().strip()
        parts = key.split()
        if len(key.splitlines()) != 1 or len(parts) < 2 or parts[0] != 'ssh-ed25519' or len(base64.b64decode(parts[1], validate=True)) != 51:
            raise RuntimeError('Expected one enrolled Ed25519 SSH public key')
        tunnel_user = 'zt-execution'
        try:
            pwd.getpwnam(tunnel_user)
        except KeyError:
            run('useradd', '--system', '--create-home', '--home-dir', '/var/lib/zigent-execution-tunnel', '--shell', '/bin/sh', tunnel_user)
        tunnel_home = Path('/var/lib/zigent-execution-tunnel')
        tunnel_home.mkdir(mode=0o755, exist_ok=True)
        os.chown(tunnel_home, 0, 0)
        tunnel_home.chmod(0o755)
        ssh = tunnel_home / '.ssh'
        if ssh.is_symlink():
            raise RuntimeError('Linked SSH enrollment directory')
        ssh.mkdir(mode=0o755, exist_ok=True)
        os.chown(ssh, 0, 0)
        authorized = ssh / 'authorized_keys'
        if authorized.is_symlink():
            raise RuntimeError('Linked SSH enrollment file')
        authorized.write_text('restrict,port-forwarding,permitopen="127.0.0.1:' + str(args.listen_port) + '",command="/usr/bin/false" ' + key + '\n')
        authorized.chmod(0o644)
        ssh_configuration = Path('/etc/ssh/sshd_config.d/55-zigent-execution.conf')
        ssh_configuration.write_text('AllowUsers zt-execution\nMatch User zt-execution\n'
                                     '    AuthenticationMethods publickey\n    PasswordAuthentication no\n'
                                     '    AllowTcpForwarding local\n    PermitOpen 127.0.0.1:' + str(args.listen_port) + '\n'
                                     '    AllowAgentForwarding no\n    X11Forwarding no\n    PermitTTY no\n'
                                     '    PermitTunnel no\n    ForceCommand /usr/bin/false\nMatch all\n')
        ssh_configuration.chmod(0o644)
        run('/usr/sbin/sshd', '-t')
        run('systemctl', 'reload', 'ssh.service')
    state = Path('/var/lib/zigent-execution')
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(state, account.pw_uid, account.pw_gid)
    state.chmod(0o700)
    destination = Path('/opt/zigent-execution/releases') / args.commit / runtime['runtimeIdentity']
    destination.mkdir(parents=True, exist_ok=True)
    for name in ASSETS['workerFiles']:
        target = destination / name
        if target.is_symlink():
            raise RuntimeError('Linked release path')
        shutil.copyfile(source / name, target)
        target.chmod(0o644)
    for name in ASSETS['sourceFiles']:
        if name.startswith('skills/'):
            target=destination/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(release/name,target);target.chmod(0o644)
    retained_manifest = destination / 'runtime-manifest.json'
    if retained_manifest.is_symlink():
        raise RuntimeError('Linked runtime manifest path')
    shutil.copyfile(manifest_path, retained_manifest)
    retained_manifest.chmod(0o644)
    if args.network == 'zigent-execution':
        existing = subprocess.run(['/usr/bin/docker', 'network', 'inspect', 'zigent-execution'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if existing.returncode:
            run('/usr/bin/docker', 'network', 'create', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.enable_icc=false', 'zigent-execution')
    config_directory = Path('/etc/zigent-execution')
    config_directory.mkdir(mode=0o750, exist_ok=True)
    os.chown(config_directory, 0, account.pw_gid)
    configuration = {'version': 1, 'runtimeCapabilities': capabilities, 'stateDirectory': str(state), 'engine': '/usr/bin/docker', 'image': image,
                     'publishedImageId': runtime['imageId'], 'imageConfigId': image_bindings['configId'],
                     'imageManifestId': image_bindings['manifestId'],
                     'componentSourceCommit': args.commit, 'runtimeIdentity': runtime['runtimeIdentity'],
                     'componentFingerprint': runtime['componentFingerprint'],
                     'imageInputsFingerprint': runtime['imageInputsFingerprint'],
                     'listenHost': args.listen_host, 'listenPort': args.listen_port, 'network': args.network,
                     'maxSnapshotBytes': 512 * 1024 * 1024, 'maxOutputBytes': 128 * 1024 * 1024,
                     'maxProjectBytes': 4 * 1024 * 1024 * 1024, 'minimumFreeBytes': 4 * 1024 * 1024 * 1024,
                     'maxConcurrentJobs': 2, 'memory': '4g', 'cpus': 2, 'identities': identities}
    path = config_directory / 'config.json'
    if path.is_symlink():
        raise RuntimeError('Linked execution config')
    path.write_text(json.dumps(configuration))
    os.chown(path, 0, account.pw_gid)
    path.chmod(0o640)
    # Installation and every service startup use the same policy. A failed apply
    # cannot start/restart the broker or relax a currently running task's rules.
    run('/usr/bin/python3', '-I', str(destination / 'network-guard.py'), '--config', str(path))
    service = Path('/etc/systemd/system/zigent-execution.service')
    service.write_text('''[Unit]
Description=Zigent isolated execution broker
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
User=zigent-execution
Group=zigent-execution
SupplementaryGroups=docker
ExecStart=/usr/bin/python3 -I ''' + str(destination / 'worker.py') + ''' --config /etc/zigent-execution/config.json
ExecStartPre=+/usr/bin/python3 -I ''' + str(destination / 'network-guard.py') + ''' --config /etc/zigent-execution/config.json
WorkingDirectory=/var/lib/zigent-execution
Environment=PYTHONDONTWRITEBYTECODE=1
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/zigent-execution
PrivateTmp=true
Restart=on-failure
RestartSec=5
TimeoutStopSec=infinity

[Install]
WantedBy=multi-user.target
''')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'zigent-execution.service')
    run('systemctl', 'restart', 'zigent-execution.service')
    run('systemctl', 'is-active', '--quiet', 'zigent-execution.service')
    print(json.dumps({'ready': True, 'protocol': 1, 'commit': args.commit, 'image': image,
                      'publishedImageId': runtime['imageId'], 'imageConfigId': image_bindings['configId'],
                      'imageManifestId': image_bindings['manifestId'],
                      'runtimeIdentity': runtime['runtimeIdentity'],
                      'listenPort': args.listen_port, 'network': args.network, 'identities': len(identities)}))


if __name__ == '__main__':
    main()
