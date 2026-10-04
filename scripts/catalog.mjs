import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isSlug = (value) => typeof value === 'string' && slugPattern.test(value);

export async function readCatalog(projectRoot = root) {
  const games = JSON.parse(await readFile(path.join(projectRoot, 'games.json'), 'utf8'));
  if (!Array.isArray(games)) throw new Error('games.json 必须是数组。');
  const seen = new Set();
  for (const game of games) {
    if (!isSlug(game.id) || seen.has(game.id)) throw new Error(`游戏 id 无效或重复：${game.id}`);
    seen.add(game.id);
    for (const field of ['title', 'description', 'category']) {
      if (typeof game[field] !== 'string' || !game[field].trim()) throw new Error(`${game.id}: 缺少 ${field}`);
    }
    for (const field of ['tags', 'controls']) {
      if (!Array.isArray(game[field]) || !game[field].every((item) => typeof item === 'string' && item.trim())) {
        throw new Error(`${game.id}: ${field} 必须是文字数组`);
      }
    }
    if (!/^#[0-9a-f]{6}$/i.test(game.accent)) throw new Error(`${game.id}: accent 必须是六位十六进制颜色`);
    if (game.featured !== undefined && typeof game.featured !== 'boolean') throw new Error(`${game.id}: featured 必须是布尔值`);
    for (const field of ['entry', 'cover']) {
      const value = game[field];
      if (typeof value !== 'string' || !value.startsWith(`games/${game.id}/`) || value.includes('..') || /[\\?#%]/.test(value)) {
        throw new Error(`${game.id}: ${field} 必须指向自身游戏目录内的本地文件`);
      }
      const info = await stat(path.join(projectRoot, value)).catch(() => null);
      if (!info?.isFile()) throw new Error(`${game.id}: 找不到文件 ${value}`);
    }
    if (!game.entry.endsWith('.html')) throw new Error(`${game.id}: entry 必须是 HTML 文件`);
  }
  return games;
}
