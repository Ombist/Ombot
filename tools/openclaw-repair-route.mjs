#!/usr/bin/env node
/**
 * Repair OpenClaw route fragments + runtime (nested models, blockrun overlay, official orphan blockrun).
 * Usage: node openclaw-repair-route.mjs [--json] <file> [file...]
 * With no files: reads OPENCLAW_FRAGMENTS_DIR + OPENCLAW_RUNTIME_CONFIG_PATH + OPENCLAW_CONFIG_PATH from env.
 */
import fs from 'fs';
import path from 'path';
import {
  hasInvalidBlockrunProviderOverlay,
  hasInvalidNestedModelsKey,
  hasInvalidOpenClawModelsConfig,
  normalizeNestedModelsKey,
  repairBlockrunProviderOverlay,
} from './openclaw-json-merge.mjs';

/**
 * Official route-sync should not leave blockrun-only overlay without ombrouter plugin.
 * @param {Record<string, unknown>} cfg
 * @returns {boolean}
 */
export function stripOfficialOrphanBlockrun(cfg) {
  if (!hasInvalidBlockrunProviderOverlay(cfg)) return false;
  const plugins = cfg.plugins;
  const hasOmbRouter =
    Array.isArray(plugins) && plugins.some((p) => p && typeof p === 'object' && p.id === 'ombrouter');
  if (hasOmbRouter) return false;
  const models = cfg.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return false;
  const providers = /** @type {Record<string, unknown>} */ (models).providers;
  if (!providers || typeof providers !== 'object') return false;
  delete providers.blockrun;
  if (Object.keys(providers).length === 0) {
    delete /** @type {Record<string, unknown>} */ (models).providers;
  }
  if (Object.keys(/** @type {Record<string, unknown>} */ (models)).length === 0) {
    delete cfg.models;
  }
  return true;
}

/**
 * @param {string} filePath
 * @returns {{ path: string, changed: boolean, actions: string[] }}
 */
export function repairOpenClawJsonFile(filePath) {
  const actions = [];
  if (!filePath || !fs.existsSync(filePath)) {
    return { path: filePath, changed: false, actions: ['missing'] };
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return {
      path: filePath,
      changed: false,
      actions: [`invalid_json:${/** @type {Error} */ (e).message}`],
    };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { path: filePath, changed: false, actions: ['not_object'] };
  }
  let changed = false;
  if (hasInvalidNestedModelsKey(cfg)) {
    normalizeNestedModelsKey(cfg);
    changed = true;
    actions.push('hoisted_nested_models');
  }
  if (stripOfficialOrphanBlockrun(cfg)) {
    changed = true;
    actions.push('stripped_official_orphan_blockrun');
  }
  if (repairBlockrunProviderOverlay(cfg)) {
    changed = true;
    actions.push('repaired_blockrun_overlay');
  }
  if (changed) {
    fs.writeFileSync(filePath, `${JSON.stringify(cfg, null, 2)}\n`);
  }
  if (hasInvalidOpenClawModelsConfig(cfg)) {
    actions.push('still_invalid');
  } else if (!actions.length) {
    actions.push('ok');
  }
  return { path: filePath, changed, actions };
}

function listFragmentFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json') && !n.startsWith('.') && !n.endsWith('.bak'))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => path.join(dir, n));
}

function resolvePathsFromEnv() {
  const paths = [];
  const fragDir = (process.env.OPENCLAW_FRAGMENTS_DIR || '/etc/ombot/openclaw.d').trim();
  for (const fp of listFragmentFiles(fragDir)) {
    paths.push(fp);
  }
  const runtime = (process.env.OPENCLAW_RUNTIME_CONFIG_PATH || '').trim();
  const etc = (process.env.OPENCLAW_CONFIG_PATH || '/etc/ombot/openclaw.json').trim();
  if (runtime) paths.push(runtime);
  if (etc && etc !== runtime) paths.push(etc);
  return paths;
}

function main() {
  const jsonOut = process.argv.includes('--json');
  const files = process.argv.slice(2).filter((a) => a !== '--json');
  const targets = files.length > 0 ? files : resolvePathsFromEnv();
  const results = targets.map((fp) => repairOpenClawJsonFile(fp));
  const stillInvalid = results.some((r) => r.actions.includes('still_invalid'));
  const payload = {
    ok: !stillInvalid,
    repaired: results.some((r) => r.changed),
    results,
  };
  if (jsonOut) {
    console.log(JSON.stringify(payload));
  } else {
    for (const r of results) {
      console.log(`${r.path}: ${r.actions.join(',')}`);
    }
  }
  process.exit(stillInvalid ? 1 : 0);
}

import { fileURLToPath, pathToFileURL } from 'url';

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  main();
}
