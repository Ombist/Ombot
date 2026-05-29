#!/usr/bin/env node
/**
 * Validate (and optionally repair) OpenClaw runtime JSON after route-sync / compose.
 * Usage: node openclaw-validate-runtime-config.mjs [--repair] <configPath>
 * Exit 0 when models shape is valid; exit 1 when invalid nested models.models remains.
 */
import fs from 'fs';
import {
  hasInvalidNestedModelsKey,
  normalizeNestedModelsKey,
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

if (!hasInvalidNestedModelsKey(cfg)) {
  process.exit(0);
}

if (repair) {
  normalizeNestedModelsKey(cfg);
  if (!hasInvalidNestedModelsKey(cfg)) {
    fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    process.exit(0);
  }
}

console.error(
  'invalid OpenClaw models shape: nested models.models (use models.providers); run openclaw doctor --fix or restore .bak'
);
process.exit(1);
