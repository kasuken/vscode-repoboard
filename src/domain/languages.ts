import { LanguageShare } from './model';

/**
 * Extension → language with GitHub Linguist colours. Data, markup and config formats (JSON, YAML,
 * Markdown, XML…) are deliberately left out so they never dominate the bar.
 */
const TABLE: ReadonlyArray<[name: string, color: string, extensions: string[]]> = [
  ['TypeScript', '#3178c6', ['ts', 'tsx', 'mts', 'cts']],
  ['JavaScript', '#f1e05a', ['js', 'jsx', 'mjs', 'cjs']],
  ['C#', '#178600', ['cs', 'csx']],
  ['F#', '#b845fc', ['fs', 'fsi', 'fsx']],
  ['Visual Basic .NET', '#945db7', ['vb']],
  ['Razor', '#512be4', ['razor', 'cshtml']],
  ['Python', '#3572a5', ['py', 'pyi', 'pyw']],
  ['Jupyter Notebook', '#da5b0b', ['ipynb']],
  ['Java', '#b07219', ['java']],
  ['Kotlin', '#a97bff', ['kt', 'kts']],
  ['Scala', '#c22d40', ['scala', 'sc']],
  ['Groovy', '#4298b8', ['groovy', 'gradle']],
  ['Go', '#00add8', ['go']],
  ['Rust', '#dea584', ['rs']],
  ['C', '#555555', ['c', 'h']],
  ['C++', '#f34b7d', ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ixx']],
  ['Objective-C', '#438eff', ['m', 'mm']],
  ['Swift', '#f05138', ['swift']],
  ['Dart', '#00b4ab', ['dart']],
  ['Ruby', '#701516', ['rb', 'rake', 'gemspec']],
  ['PHP', '#4f5d95', ['php']],
  ['Blade', '#f7523f', ['blade.php']],
  ['Elixir', '#6e4a7e', ['ex', 'exs']],
  ['Erlang', '#b83998', ['erl', 'hrl']],
  ['Haskell', '#5e5086', ['hs']],
  ['Clojure', '#db5855', ['clj', 'cljs', 'cljc']],
  ['Lua', '#000080', ['lua']],
  ['R', '#198ce7', ['r']],
  ['Julia', '#a270ba', ['jl']],
  ['Zig', '#ec915c', ['zig']],
  ['Nim', '#ffc200', ['nim']],
  ['Perl', '#0298c3', ['pl', 'pm']],
  ['Shell', '#89e051', ['sh', 'bash', 'zsh', 'fish']],
  ['PowerShell', '#012456', ['ps1', 'psm1', 'psd1']],
  ['Batchfile', '#c1f12e', ['bat', 'cmd']],
  ['HTML', '#e34c26', ['html', 'htm']],
  ['CSS', '#663399', ['css']],
  ['SCSS', '#c6538c', ['scss', 'sass']],
  ['Less', '#1d365d', ['less']],
  ['Vue', '#41b883', ['vue']],
  ['Svelte', '#ff3e00', ['svelte']],
  ['Astro', '#ff5a03', ['astro']],
  ['Bicep', '#519aba', ['bicep']],
  ['HCL', '#844fba', ['tf', 'hcl']],
  ['Dockerfile', '#384d54', ['dockerfile']],
  ['Makefile', '#427819', ['mk', 'makefile']],
  ['CMake', '#da3434', ['cmake']],
  ['SQL', '#e38c00', ['sql']],
  ['GraphQL', '#e10098', ['graphql', 'gql']],
  ['Solidity', '#aa6746', ['sol']],
  ['GDScript', '#355570', ['gd']],
  ['ShaderLab', '#222c37', ['shader']],
  ['HLSL', '#aace60', ['hlsl']],
  ['GLSL', '#5686a5', ['glsl', 'vert', 'frag']],
  ['Assembly', '#6e4c13', ['asm', 's']],
  ['OCaml', '#ef7a08', ['ml', 'mli']],
  ['Elm', '#60b5cc', ['elm']],
  ['Crystal', '#000100', ['cr']],
  ['V', '#4f87c4', ['v']],
];

export const UNKNOWN_LANGUAGE_COLOR = '#8b949e';

export interface LanguageDef {
  name: string;
  color: string;
}

const BY_EXTENSION = new Map<string, LanguageDef>();
for (const [name, color, extensions] of TABLE) {
  for (const ext of extensions) {
    BY_EXTENSION.set(ext, { name, color });
  }
}

export function languageForFile(fileName: string): LanguageDef | undefined {
  const lower = fileName.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile')) {
    return BY_EXTENSION.get('dockerfile');
  }
  if (lower === 'makefile' || lower === 'gnumakefile') {
    return BY_EXTENSION.get('makefile');
  }
  if (lower === 'cmakelists.txt') {
    return BY_EXTENSION.get('cmake');
  }
  if (lower.endsWith('.blade.php')) {
    return BY_EXTENSION.get('blade.php');
  }
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css') || lower.endsWith('.d.ts') || lower.endsWith('.g.cs') || lower.endsWith('.designer.cs')) {
    // Generated or vendored: counted as noise by Linguist too.
    return undefined;
  }
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? BY_EXTENSION.get(lower.slice(dot + 1)) : undefined;
}

/** Byte totals → shares sorted by size. Languages under 0.5 % are folded into "Other". */
export function toShares(bytes: ReadonlyMap<LanguageDef, number>): LanguageShare[] {
  let total = 0;
  for (const n of bytes.values()) {
    total += n;
  }
  if (total === 0) {
    return [];
  }
  const shares: LanguageShare[] = [];
  let other = 0;
  for (const [lang, n] of [...bytes.entries()].sort((a, b) => b[1] - a[1])) {
    const percent = (n / total) * 100;
    if (percent < 0.5) {
      other += percent;
    } else {
      shares.push({ name: lang.name, color: lang.color, percent: Math.round(percent * 10) / 10 });
    }
  }
  if (other >= 0.1) {
    shares.push({ name: 'Other', color: UNKNOWN_LANGUAGE_COLOR, percent: Math.round(other * 10) / 10 });
  }
  return shares;
}
