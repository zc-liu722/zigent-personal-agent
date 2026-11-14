import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { componentIds, inputOwner, inputReason, inputPolicy, inputParts } from '../../skills/zigent-source/scripts/release-inputs.mjs';
export { inputOwner, inputReason, inputPolicy };
export const definitions = Object.fromEntries(componentIds.map(id=>[id,{
  entry:`src/plugins/${id}/entry.ts`,directory:`src/plugins/${id}/`,provides:id==='model-http'?{modelProtocol:1}:{[id]:1},requires:{}
}]));
// Tool-only contributions do not declare an unused service.
for(const id of ['browser','health'])definitions[id].provides={};
definitions["model-catalog"].provides={modelCatalog:1};
definitions.location.provides={locationQuery:1};
definitions["model-codex"].provides={codexModel:1};
definitions["model-cursor"].provides={cursorModel:1};
definitions["model-antigravity"].provides={antigravityModel:1};
definitions.documents.provides={documentQuery:1};
definitions.recordings.provides={recordingWorkflow:1};
definitions['skill-resources'].provides={skillCatalog:1};
export function trackedFiles(source) { return execFileSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean); }
export async function fingerprint(source, files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) hash.update(file).update('\0').update(await readFile(join(source, file))).update('\0');
  return hash.digest('hex');
}
export function hostFiles(files) {
  return files.filter(file => inputOwner(file) === 'host');
}

/** Persist file identities as well as aggregate identities, so a shallow release
 * checkout can explain differences without fetching old source commits. */
export async function sourceInputs(source, files = trackedFiles(source)) {
  const inputs = {}, hashes = new Map(['host', 'web', ...componentIds].map(id => [id, createHash('sha256')]));
  for (const path of [...files].sort()) {
    const bytes = await readFile(join(source, path)), owner = inputOwner(path);
    inputs[path] = { owner, sha256: createHash('sha256').update(bytes).digest('hex') };
    const parts = inputParts(path, bytes);
    if (parts.length > 1) inputs[path].parts = Object.fromEntries(parts.map(([id, value]) => [id, createHash('sha256').update(value).digest('hex')]));
    for (const [id, value] of parts) hashes.get(id)?.update(path).update('\0').update(value).update('\0');
  }
  return { policy: inputPolicy, files: inputs, fingerprints: Object.fromEntries([...hashes].map(([id, hash]) => [id, hash.digest('hex')])) };
}
