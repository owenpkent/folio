/**
 * Fails a production build that would bundle a package twice.
 *
 * Folio 0.9.0 shipped a bundle with two copies of React in it. Zustand's
 * store hooks were bound to one copy and React DOM rendered with the other, so
 * the first store read on launch threw "Cannot read properties of null
 * (reading 'useCallback')" and every launch ended on the crash screen. A clean
 * rebuild of the same commit came out right; the bad one was produced by a
 * transient state of the build machine, so nothing in the source or the
 * lockfile would have shown it, and CI, which builds on its own machine, was
 * green. This check looks at what the bundler actually resolved, on the
 * machine doing the build, which is the only place it can be seen.
 *
 * Two ways a package ends up in a bundle twice, and both are refused:
 *
 * - The same file reached under two spellings of its path. On Windows the
 *   file system ignores case and the bundler does not, so `w:\...` and
 *   `W:\...` (or a `\\?\` verbatim prefix) become two modules.
 * - A package that must be single (React and what shares its internals, and
 *   Zustand, which binds to whichever React it imports) installed in two
 *   places, as when a dependency carries its own nested copy.
 */
import type { Plugin } from 'vite';

/** Packages that break when two copies are loaded, not merely waste space. */
export const SINGLETON_PACKAGES = ['react', 'react-dom', 'scheduler', 'zustand'];

/** `\\?\`, the Windows verbatim-path prefix, which has a `?` of its own. */
const VERBATIM = /^\\\\\?\\/;

/**
 * A module id as the bundler keyed it, minus what makes two ids legitimately
 * different modules of one file: a virtual-module `\0` and a `?query` (as in
 * `?url` or `?worker`). The query is cut after the verbatim prefix, whose own
 * `?` would otherwise cut the whole path away.
 */
export function moduleFile(id: string): string {
  const bare = id.replace(/^\0/, '');
  const start = VERBATIM.test(bare) ? 4 : 0;
  const query = bare.indexOf('?', start);
  return query === -1 ? bare : bare.slice(0, query);
}

/** The file a module id names, as a comparable path: no verbatim prefix, forward slashes. */
export function normalizeModuleId(id: string): string {
  return moduleFile(id).replace(VERBATIM, '').replace(/\\/g, '/');
}

/**
 * Every way `ids` bundles something twice, as one readable line each; empty
 * when there is none. `caseInsensitive` is whether the build machine's file
 * system ignores case (Windows), which decides whether two spellings that
 * differ only in case are the same file.
 */
export function findDuplicateModules(ids: Iterable<string>, caseInsensitive: boolean): string[] {
  const fold = (path: string) => (caseInsensitive ? path.toLowerCase() : path);
  const spellings = new Map<string, Set<string>>();
  const roots = new Map<string, Set<string>>();

  for (const id of ids) {
    const path = normalizeModuleId(id);
    if (!path.includes('/node_modules/')) continue;
    // Keyed by the file, holding the spellings the bundler actually used: two
    // of them means one file became two modules.
    const key = fold(path);
    let seen = spellings.get(key);
    if (!seen) spellings.set(key, (seen = new Set()));
    seen.add(moduleFile(id));

    // The package a file belongs to is the one after the LAST node_modules
    // segment: a nested copy lives at .../node_modules/a/node_modules/react/.
    const match = /^(.*\/node_modules\/)((?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (!match || !SINGLETON_PACKAGES.includes(match[2])) continue;
    let places = roots.get(match[2]);
    if (!places) roots.set(match[2], (places = new Set()));
    places.add(fold(match[1] + match[2]));
  }

  const problems: string[] = [];
  for (const seen of spellings.values()) {
    if (seen.size > 1) problems.push(`one file under ${seen.size} paths: ${[...seen].join(' | ')}`);
  }
  for (const [name, places] of roots) {
    if (places.size > 1)
      problems.push(`${name} from ${places.size} places: ${[...places].join(' | ')}`);
  }
  return problems;
}

/** The Vite plugin: checks every module of a production build once it is complete. */
export function singleCopyGuard(): Plugin {
  return {
    name: 'folio:single-copy-guard',
    apply: 'build',
    generateBundle() {
      const problems = findDuplicateModules(this.getModuleIds(), process.platform === 'win32');
      if (problems.length === 0) return;
      this.error(
        `This build bundles a package twice, which breaks React at runtime ` +
          `(the 0.9.0 launch crash). A clean reinstall usually clears it: npm ci, ` +
          `then build again.\n  ${problems.join('\n  ')}`,
      );
    },
  };
}
