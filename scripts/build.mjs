import {mkdir,cp,rm,lstat,realpath,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {root} from './catalog.mjs';
await (async function standaloneBuild() {
  const output = path.resolve(root, 'dist');
  if (path.dirname(output) !== path.resolve(root) || path.basename(output) !== 'dist') throw Error('Unsafe build output');
  if ((await lstat(output).catch(() => null))?.isSymbolicLink()) throw Error('Refusing linked build output');
  if ((await lstat(output).catch(() => null)) && await realpath(output) !== path.join(await realpath(root), 'dist')) throw Error('Resolved build directory escapes the project');
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  for (const name of ['index.html', 'games.json', 'games', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses', 'ASSETS.lock.json']) await cp(path.join(root, name), path.join(output, name), { recursive: true });
  for (const relative of ['index.html', 'games/freight-fire/index.html']) {
    const filename = path.join(output, relative);
    const html = await readFile(filename, 'utf8');
    await writeFile(filename, html.replace(/<body\b([^>]*)>/i, (_, attrs) => '<body' + attrs.replace(/\sdata-static=(["']).*?\1/i, '') + ' data-static="true">'));
  }
  console.log('Built standalone Transport Ship: ' + output);
})();
