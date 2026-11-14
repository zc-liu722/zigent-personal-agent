import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function frontmatterDescription(body) {
  const text = body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const fence = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!fence) return;
  for (const line of fence[1].split('\n')) {
    const found = /^description:\s*(.*)$/.exec(line);
    if (!found) continue;
    const value = found[1].trim().replace(/^['"]|['"]$/g, '').trim();
    if (value && !/^(?:>[+-]?|\|[+-]?)$/.test(value)) return value;
  }
}
/** Bundle exact tracked resources, including references/scripts, inside the verified component. */
export function skillAssets(source) {
  return { name: 'skill-assets', setup(build) {
    build.onResolve({ filter: /^#skill-assets$/ }, () => ({ path: '#skill-assets', namespace: 'skill-assets' }));
    build.onLoad({ filter: /.*/, namespace: 'skill-assets' }, async () => {
      const paths = execFileSync('git', ['ls-files', '-z', 'skills'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
      const groups = new Map();
      for (const path of paths) {
        const match = /^skills\/([a-z][a-z0-9_-]{0,63})\/(.+)$/.exec(path);
        if (!match || match[2].split('/').some(part => part === '..' || !part) || match[2] === '__proto__') throw Error(`SKILL_RESOURCE_PATH_INVALID ${path}`);
        const bytes = await readFile(join(source, path));
        if (!groups.has(match[1])) groups.set(match[1], {});
        groups.get(match[1])[match[2]] = bytes.toString('base64');
      }
      const entries = [];
      for (const [name, files] of groups) {
        if (!files['SKILL.md']) throw Error(`SKILL_ENTRY_MISSING ${name}`);
        const body = Buffer.from(files['SKILL.md'], 'base64').toString('utf8');
        if (body.length > 100000) throw Error(`SKILL_BODY_TOO_LARGE ${name}`);
        // Legacy packages without frontmatter keep their name. Do not copy body text into the catalogue.
        const description = frontmatterDescription(body) ?? name;
        const revision = Number.parseInt(createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12), 16) + 1;
        entries.push({ name, description: description.slice(0, 500), body, rules: '', revision, files });
      }
      return { contents: `export default ${JSON.stringify(entries)};`, loader: 'js', watchFiles: paths.map(path => join(source, path)) };
    });
  } };
}
