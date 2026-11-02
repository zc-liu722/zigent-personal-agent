"""Retain resolved Cargo dependency license texts in the shipped runtime image."""
import json
from pathlib import Path
import shutil
import sys

metadata = json.loads(Path(sys.argv[1]).read_text())
destination = Path(sys.argv[2])
resolved = {node['id'] for node in metadata['resolve']['nodes']}
if not resolved:
    raise RuntimeError('Resolved dependency graph is empty')
packages = []
for package in metadata['packages']:
    if not package.get('source') or package['id'] not in resolved:
        continue
    source = Path(package['manifest_path']).parent
    target = destination / (package['name'] + '-' + package['version'])
    target.mkdir(parents=True)
    retained = []
    for path in source.rglob('*'):
        if path.is_file() and not path.is_symlink() and path.name.upper().startswith(('LICENSE', 'LICENCE', 'NOTICE', 'COPYING', 'COPYRIGHT')):
            relative = path.relative_to(source)
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, output)
            retained.append(str(relative))
    if not retained:
        raise RuntimeError('Missing dependency license text: ' + package['name'])
    packages.append({'name': package['name'], 'version': package['version'], 'license': package['license'], 'source': package['source'], 'files': retained})
(destination / 'manifest.json').write_text(json.dumps(packages, indent=2) + '\n')
