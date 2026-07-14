// globs.mjs — glob-lite compiler shared by runner detection (dir skipping)
// and the gate (source_globs / ignore_paths file matching). Supports ** and *
// only — enough for the shipped config patterns; zero dependencies.

/** Compile patterns into anchored regexes ('*' = no slash, '**' = anything). */
export function compileGlobs(patterns) {
  return (patterns || []).map((p) => {
    // Placeholder tokens keep later '*' substitutions from mangling the
    // regex fragments emitted for '**/' and '**'.
    const rx = p.replaceAll('\\', '/')
      .replace(/[.+^${}()|[\]]/g, '\\$&')
      .replace(/\*\*\//g, '')
      .replace(/\*\*/g, '')
      .replace(/\*/g, '[^/]*')
      .replaceAll('', '(?:.*/)?')
      .replaceAll('', '.*');
    return new RegExp(`^${rx}$`);
  });
}

/** Does a repo-relative FILE path match any pattern? (case-insensitive: NFR-C3) */
export function matchesFile(matchers, relPath) {
  const probe = relPath.replaceAll('\\', '/').toLowerCase();
  return matchers.some((m) => new RegExp(m.source, 'i').test(probe));
}

/** Does a repo-relative DIRECTORY path fall inside any pattern? */
export function matchesDir(matchers, relPath) {
  const probe = relPath.replaceAll('\\', '/') + '/';
  return matchers.some((m) => m.test(probe));
}
