import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { mergeOrderedFragments } from '../tools/openclaw-json-merge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const composeScript = path.join(__dirname, '../tools/openclaw-compose.mjs');

function runCompose(env, args = ['--dry-run', '--json']) {
  const r = spawnSync(process.execPath, [composeScript, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('openclaw-compose.mjs', () => {
  it('dry-run merges sorted fragments and reports composedHash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-compose-'));
    fs.writeFileSync(
      path.join(dir, '10-a.json'),
      JSON.stringify({ gateway: { port: 1, mode: 'local' } }),
    );
    fs.writeFileSync(
      path.join(dir, '20-b.json'),
      JSON.stringify({ gateway: { port: 99 } }),
    );
    const { status, stdout } = runCompose({
      OPENCLAW_FRAGMENTS_DIR: dir,
      OPENCLAW_RUNTIME_CONFIG_PATH: '',
    });
    expect(status).toBe(0);
    const j = JSON.parse(stdout);
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('dry_run');
    expect(j.fragmentCount).toBe(2);
    expect(j.composedHash).toMatch(/^[a-f0-9]{64}$/);
    const merged = mergeOrderedFragments([
      JSON.parse(fs.readFileSync(path.join(dir, '10-a.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(dir, '20-b.json'), 'utf8')),
    ]);
    expect(merged.gateway.port).toBe(99);
    expect(merged.gateway.mode).toBe('local');
  });

  it('exits 3 on --strict-keys when 10-* contains gateway.auth', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-compose-strict-'));
    fs.writeFileSync(
      path.join(dir, '10-bad.json'),
      JSON.stringify({ gateway: { auth: { mode: 'token' } } }),
    );
    const { status, stderr } = runCompose({ OPENCLAW_FRAGMENTS_DIR: dir }, ['--dry-run', '--strict-keys']);
    expect(status).toBe(3);
    expect(stderr).toMatch(/STRICT_KEYS_VIOLATION/);
  });
});
