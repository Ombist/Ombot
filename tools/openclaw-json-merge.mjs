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
 * Hoist mistaken `models.models.providers` (legacy iOS route-sync bug) to `models.providers`.
 * @param {Record<string, unknown>} obj
 */
export function normalizeNestedModelsKey(obj) {
  const models = obj?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return;
  const nested = /** @type {Record<string, unknown>} */ (models).models;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return;
  const nestedProviders = nested.providers;
  if (!nestedProviders || typeof nestedProviders !== 'object' || Array.isArray(nestedProviders)) {
    return;
  }
  const modelsRec = /** @type {Record<string, unknown>} */ (models);
  if (!modelsRec.providers || typeof modelsRec.providers !== 'object' || Array.isArray(modelsRec.providers)) {
    modelsRec.providers = nestedProviders;
  } else {
    deepMerge(/** @type {Record<string, unknown>} */ (modelsRec.providers), nestedProviders);
  }
  delete modelsRec.models;
}

/**
 * @param {unknown} obj
 * @returns {boolean}
 */
export function hasInvalidNestedModelsKey(obj) {
  const models = /** @type {Record<string, unknown> | undefined} */ (
    obj && typeof obj === 'object' && !Array.isArray(obj) ? obj.models : undefined
  );
  if (!models || typeof models !== 'object' || Array.isArray(models)) return false;
  const nested = /** @type {Record<string, unknown>} */ (models).models;
  return !!(nested && typeof nested === 'object' && !Array.isArray(nested));
}

/**
 * OpenClaw rejects custom provider overlays without a non-empty `models` list.
 * @param {unknown} obj
 * @returns {boolean}
 */
export function hasInvalidBlockrunProviderOverlay(obj) {
  const models = /** @type {Record<string, unknown> | undefined} */ (
    obj && typeof obj === 'object' && !Array.isArray(obj) ? obj.models : undefined
  );
  if (!models || typeof models !== 'object' || Array.isArray(models)) return false;
  const providers = /** @type {Record<string, unknown>} */ (models).providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false;
  const blockrun = providers.blockrun;
  if (!blockrun || typeof blockrun !== 'object' || Array.isArray(blockrun)) return false;
  const list = /** @type {{ models?: unknown }} */ (blockrun).models;
  return !(Array.isArray(list) && list.length > 0);
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {boolean} true when repair changed config
 */
export function repairBlockrunProviderOverlay(obj) {
  if (!hasInvalidBlockrunProviderOverlay(obj)) return false;
  const models = /** @type {Record<string, unknown>} */ (obj).models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return false;
  if (!models.providers || typeof models.providers !== 'object' || Array.isArray(models.providers)) {
    models.providers = {};
  }
  const providers = /** @type {Record<string, unknown>} */ (models.providers);
  const blockrun = /** @type {Record<string, unknown>} */ (providers.blockrun);
  const baseUrl = typeof blockrun.baseUrl === 'string' ? blockrun.baseUrl.trim() : '';
  if (!baseUrl) {
    delete providers.blockrun;
    return true;
  }
  if (typeof blockrun.api !== 'string' || !blockrun.api.trim()) {
    blockrun.api = 'openai-completions';
  }
  if (typeof blockrun.apiKey !== 'string' || !blockrun.apiKey.trim()) {
    blockrun.apiKey = 'x402-proxy-handles-auth';
  }
  blockrun.models = [{ id: 'blockrun/auto' }];
  return true;
}

/**
 * @param {unknown} obj
 * @returns {boolean}
 */
export function hasInvalidOpenClawModelsConfig(obj) {
  return hasInvalidNestedModelsKey(obj) || hasInvalidBlockrunProviderOverlay(obj);
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
  normalizeNestedModelsKey(cur);
  const patchClone = JSON.parse(JSON.stringify(patch));
  normalizeNestedModelsKey(patchClone);
  deepMerge(cur, patchClone);
  normalizeNestedModelsKey(cur);
  repairBlockrunProviderOverlay(cur);
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
    const normalized = JSON.parse(JSON.stringify(frag));
    normalizeNestedModelsKey(normalized);
    deepMerge(out, normalized);
  }
  normalizeNestedModelsKey(out);
  repairBlockrunProviderOverlay(out);
  return out;
}
