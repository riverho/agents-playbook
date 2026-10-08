// ============================================================================
//  npm-pack.mjs — read `npm pack --json` output across npm versions.
// ----------------------------------------------------------------------------
//  npm 11 answers `npm pack --json` with an ARRAY of entries; npm 12 answers with an
//  OBJECT keyed by package name. Both are the same result. Code that knew only one
//  shape failed in two different directions, and the quieter one was worse:
//
//    - the release suite aborted (loud, found by running it), while
//    - the pack gate fell through to an "else" that printed the raw output, checked
//      NOTHING, and still exited 0 — the engine-in-tarball assertion simply stopped
//      running the moment the shape changed.
//
//  So the shape is decoded in ONE place, and an unrecognized value returns undefined
//  rather than a guess: every caller is expected to treat "cannot read the pack
//  result" as a failure rather than as a pass.
// ============================================================================

/**
 * The first packed-file entry from `npm pack --json` output, in either npm's shape.
 *
 * @param parsed - the parsed stdout of `npm pack --json`, or null when it did not parse.
 * @returns the entry (`filename`, `files`, `entryCount`, `unpackedSize`), or undefined
 *          when the value is neither an array of entries nor an object of them.
 */
export function firstPackedEntry(parsed) {
  if (Array.isArray(parsed)) return parsed.find((entry) => entry && typeof entry === 'object');
  if (parsed && typeof parsed === 'object') {
    // npm 12: `{ "<package name>": { filename, files, ... } }`
    return Object.values(parsed).find((entry) => entry && typeof entry === 'object');
  }
  return undefined;
}
