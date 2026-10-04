import {readFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {root,readCatalog} from './catalog.mjs';
await (async function standaloneCheck() {
  const catalog = await readCatalog();
  if (catalog.length !== 1 || catalog[0].id !== 'freight-fire') throw Error('Standalone catalog must contain only Transport Ship');
  const excluded = /(?:^|\/)(?:node_modules|artifacts|\.git|\.env(?:\.[^/]*)?|[^/]*\.(?:pem|key|pfx|p12)|id_rsa)(?:\/|$)/i;
  let checked = 0;
  async function scan(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (['node_modules', 'artifacts', '.git', 'dist'].includes(item.name)) continue;
      const filename = path.join(folder, item.name), relative = path.relative(root, filename).split(path.sep).join('/');
      if (item.isSymbolicLink() || excluded.test(relative)) throw Error('Unexpected private or linked file: ' + relative);
      if (item.isDirectory()) await scan(filename);
      else if (/\.(?:js|mjs|json|html|md|cmd|py)$/.test(filename)) {
        const source = await readFile(filename, 'utf8');
        if (/(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(source)) throw Error('Credential-like value in ' + relative);
        if (/\.(?:js|mjs)$/.test(filename)) {
          const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
          if (result.status !== 0) throw Error(result.stderr || 'Invalid JavaScript ' + relative); checked++;
          for (const match of source.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*['"](\.[^'"]+)['"]/g)) {
            const target = path.resolve(path.dirname(filename), match[1] || match[2]);
            if (!(await stat(target).catch(() => null))?.isFile()) throw Error('Missing local import in ' + relative + ': ' + target);
          }
        }
        if (filename.endsWith('.json')) JSON.parse(source);
      }
    }
  }
  await scan(root);
  const assets = JSON.parse(await readFile(path.join(root, 'ASSETS.lock.json'), 'utf8'));
  for (const item of assets.files) {
    const filename = path.resolve(root, item.path);
    if (!filename.startsWith(path.resolve(root) + path.sep)) throw Error('Invalid asset path');
    const bytes = await readFile(filename), actual = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== item.bytes || actual !== item.sha256) throw Error('Asset integrity mismatch: ' + item.path);
    if (filename.endsWith('.glb') && (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(8) !== bytes.length)) throw Error('Invalid GLB: ' + item.path);
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'games/freight-fire/assets/audio/cs2/freight-manifest.json'), 'utf8'));
  for (const filename of new Set(Object.values(manifest.banks).flat())) await stat(path.join(root, 'games/freight-fire/assets/audio/cs2', filename));
  console.log('PASS one FPS catalog, ' + checked + ' JavaScript modules, ' + assets.files.length + ' locked assets, all audio banks and private-file exclusion.');
})();
