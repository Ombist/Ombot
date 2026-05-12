#!/usr/bin/env node
/**
 * Merge a route-sync style patch into an existing fragment file (or {}).
 * Usage: node openclaw-merge-route-fragment.mjs <fragmentPath> <patchPath> <outPath>
 */
import fs from 'fs';
import { mergeOpenclawPatch } from './openclaw-json-merge.mjs';

const [, , fragPath, patchPath, outPath] = process.argv;
if (!fragPath || !patchPath || !outPath) {
  console.error(
    'usage: node openclaw-merge-route-fragment.mjs <fragmentPath> <patchPath> <outPath>'
  );
  process.exit(2);
}

let base = {};
if (fs.existsSync(fragPath)) {
  try {
    base = JSON.parse(fs.readFileSync(fragPath, 'utf8'));
  } catch (e) {
    console.error(`invalid fragment JSON: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}
const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
const merged = mergeOpenclawPatch(base, patch);
fs.writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
