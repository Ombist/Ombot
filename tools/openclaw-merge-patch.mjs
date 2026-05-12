#!/usr/bin/env node
/**
 * CLI: merge OpenClaw patch JSON into existing config (same semantics as route-sync).
 * Usage: node openclaw-merge-patch.mjs <cfgPath> <patchPath> <outPath>
 */
import fs from 'fs';
import { mergeOpenclawPatch } from './openclaw-json-merge.mjs';

const [, , cfgPath, patchPath, outPath] = process.argv;
if (!cfgPath || !patchPath || !outPath) {
  console.error('usage: node openclaw-merge-patch.mjs <cfgPath> <patchPath> <outPath>');
  process.exit(2);
}

const cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
const merged = mergeOpenclawPatch(cur, patch);
fs.writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
