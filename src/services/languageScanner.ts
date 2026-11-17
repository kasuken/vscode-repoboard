import { Dirent, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LanguageDef, languageForFile, toShares } from '../domain/languages';
import { LanguageShare } from '../domain/model';

export interface ScanOptions {
  ignoreDirs: Iterable<string>;
  maxFiles: number;
  maxDepth?: number;
}

/**
 * GitHub-style language bar: bytes per language over a bounded breadth-first walk.
 * Hidden folders, the ignore list and symlinks are skipped.
 */
export async function scanLanguages(folder: string, options: ScanOptions): Promise<LanguageShare[]> {
  const ignore = new Set([...options.ignoreDirs].map((d) => d.toLowerCase()));
  const maxDepth = options.maxDepth ?? 10;
  const bytes = new Map<LanguageDef, number>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: folder, depth: 0 }];
  let counted = 0;
  let head = 0;

  while (head < queue.length && counted < options.maxFiles) {
    const { dir, depth } = queue[head++]!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files: Array<{ file: string; lang: LanguageDef }> = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < maxDepth && !entry.name.startsWith('.') && !ignore.has(entry.name.toLowerCase())) {
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        const lang = languageForFile(entry.name);
        if (lang && counted + files.length < options.maxFiles) {
          files.push({ file: path.join(dir, entry.name), lang });
        }
      }
    }
    counted += files.length;
    const sizes = await Promise.all(files.map((f) => fs.stat(f.file).then((s) => s.size, () => 0)));
    files.forEach((f, i) => bytes.set(f.lang, (bytes.get(f.lang) ?? 0) + Math.max(sizes[i]!, 1)));
  }
  return toShares(bytes);
}

const LOGO_CANDIDATES = [
  'logo.svg', 'logo.png', 'icon.svg', 'icon.png',
  '.github/logo.svg', '.github/logo.png',
  'media/icon.png', 'media/icon.svg', 'images/icon.png', 'images/logo.png',
  'assets/logo.svg', 'assets/logo.png', 'assets/icon.png',
  'public/logo.svg', 'public/logo.png', 'public/favicon.svg', 'public/apple-touch-icon.png',
  'resources/icon.png', 'docs/logo.png', 'docs/logo.svg',
];
const MAX_LOGO_BYTES = 96 * 1024;

/**
 * Finds a logo in the project and returns it as a data: URI (so the webview never needs access
 * to project folders). Capped in size; SVGs are fine because <img> never runs their scripts.
 */
export async function findLogo(folder: string): Promise<string | undefined> {
  for (const candidate of LOGO_CANDIDATES) {
    const file = path.join(folder, candidate);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_LOGO_BYTES) {
        continue;
      }
      const data = await fs.readFile(file);
      const mime = candidate.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
      // try the next one
    }
  }
  return undefined;
}
