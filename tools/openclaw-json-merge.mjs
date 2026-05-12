/**
 * Shared OpenClaw JSON deep merge (plugins merge by id). Used by compose, route-sync, merge-patch CLI.
 * @module openclaw-json-merge
 */

/**
 * @param {unknown[]} curList
 * @param {unknown[]} patchList
 */
export function mergePlugins(curList, patchList) {
  if (!Array.isArray(patchList)) return curList;
  const curArr = Array.isArray(curList) ? curList.slice() : [];
  for (const pp of patchList) {
    if (!pp || typeof pp !== 'object' || !pp.id) continue;
    const idx = curArr.findIndex((p) => p && p.id === pp.id);
    if (idx === -1) {
      curArr.push(pp);
      continue;
    }
    const existing = Object.assign({}, curArr[idx]);
    if (pp.config && typeof pp.config === 'object' && !Array.isArray(pp.config)) {
      if (!existing.config || typeof existing.config !== 'object') existing.config = {};
      deepMerge(existing.config, pp.config);
    }
    for (const kk of Object.keys(pp)) {
      if (kk === 'config') continue;
      existing[kk] = pp[kk];
    }
    curArr[idx] = existing;
  }
  return curArr;
}

/**
 * Deep-merge `source` into `target` (mutates target). Arrays are replaced except `plugins`.
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
export function deepMerge(target, source) {
  for (const k of Object.keys(source)) {
    const v = source[k];
    if (k === 'plugins' && Array.isArray(v)) {
      target.plugins = mergePlugins(
        /** @type {unknown[]} */ (target.plugins),
        v
      );
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      deepMerge(/** @type {Record<string, unknown>} */ (target[k]), /** @type {Record<string, unknown>} */ (v));
    } else {
      target[k] = v;
    }
  }
}

/**
 * Merge patch into a clone of base (non-destructive on base).
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} patch
 */
export function mergeOpenclawPatch(base, patch) {
  const cur = JSON.parse(JSON.stringify(base));
  deepMerge(cur, patch);
  return cur;
}

/**
 * Merge ordered fragment objects (first wins lowest precedence when using reduce - actually last wins for deep merge keys).
 * Each fragment is deep-merged in sort order: later files override earlier for scalar keys; objects merge.
 * @param {Record<string, unknown>[]} fragments
 */
export function mergeOrderedFragments(fragments) {
  const out = {};
  for (const frag of fragments) {
    if (!frag || typeof frag !== 'object' || Array.isArray(frag)) continue;
    deepMerge(out, frag);
  }
  return out;
}
