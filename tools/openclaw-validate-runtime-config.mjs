#!/usr/bin/env node
/**
 * Validate (and optionally repair) OpenClaw runtime JSON after route-sync / compose.
 * Usage: node openclaw-validate-runtime-config.mjs [--repair] <configPath>
 * Exit 0 when models shape is valid; exit 1 when invalid nested models.models or blockrun overlay remains.
 */
import fs from 'fs';
import {
  hasInvalidBlockrunProviderOverlay,
  hasInvalidNestedModelsKey,
  hasInvalidOpenClawModelsConfig,
  normalizeNestedModelsKey,
  repairBlockrunProviderOverlay,
} from './openclaw-json-merge.mjs';

const args = process.argv.slice(2);
const repair = args[0] === '--repair';
const configPath = repair ? args[1] : args[0];

if (!configPath) {
  console.error('usage: node openclaw-validate-runtime-config.mjs [--repair] <configPath>');
  process.exit(2);
}

if (!fs.existsSync(configPath)) {
  console.error(`config not found: ${configPath}`);
  process.exit(2);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`invalid JSON: ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}

if (!hasInvalidOpenClawModelsConfig(cfg)) {
  process.exit(0);
}

if (repair) {
  normalizeNestedModelsKey(cfg);
  repairBlockrunProviderOverlay(cfg);
  if (!hasInvalidOpenClawModelsConfig(cfg)) {
    fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    process.exit(0);
  }
}

if (hasInvalidNestedModelsKey(cfg)) {
  console.error(
    'invalid OpenClaw models shape: nested models.models (use models.providers); run openclaw doctor --fix or restore .bak'
  );
  process.exit(1);
}

if (hasInvalidBlockrunProviderOverlay(cfg)) {
  console.error(
    'invalid OpenClaw models.providers.blockrun: custom providers must declare models[]; omit blockrun for official mode or include api/apiKey/models'
  );
  process.exit(1);
}

process.exit(1);
