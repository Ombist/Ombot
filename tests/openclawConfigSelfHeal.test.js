import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const ombotRoot = path.join(testDir, '..');
import {
  _resetOpenClawSelfHealStateForTests,
  assessOpenClawConfigHealth,
  isOpenClawSelfHealEnabled,
  parseGatewayLoopbackTarget,
  runOpenClawConfigSelfHeal,
} from '../openclawConfigSelfHeal.js';

describe('openclawConfigSelfHeal', () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    _resetOpenClawSelfHealStateForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombot-heal-'));
    process.env.OPENCLAW_SELF_HEAL = '1';
    process.env.OPENCLAW_SINGLE_CLIENT_MODE = '1';
    process.env.OPENCLAW_SELF_HEAL_RESTART_GATEWAY = '0';
    process.env.OMBOT_REPO_DIR = path.join(tmpDir, 'repo');
    const toolsDir = path.join(process.env.OMBOT_REPO_DIR, 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.copyFileSync(path.join(ombotRoot, 'tools/openclaw-compose.mjs'), path.join(toolsDir, 'openclaw-compose.mjs'));
    fs.copyFileSync(
      path.join(ombotRoot, 'tools/openclaw-json-merge.mjs'),
      path.join(toolsDir, 'openclaw-json-merge.mjs')
    );
  });

  afterEach(() => {
    _resetOpenClawSelfHealStateForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.OPENCLAW_SELF_HEAL;
    delete process.env.OPENCLAW_SINGLE_CLIENT_MODE;
    delete process.env.OPENCLAW_SELF_HEAL_RESTART_GATEWAY;
    delete process.env.OPENCLAW_FRAGMENTS_DIR;
    delete process.env.OPENCLAW_RUNTIME_CONFIG_PATH;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OMBOT_REPO_DIR;
  });

  it('parses default gateway loopback target', () => {
    delete process.env.OPENCLAW_GATEWAY_URL;
    const t = parseGatewayLoopbackTarget();
    expect(t.host).toBe('127.0.0.1');
    expect(t.port).toBe(18789);
  });

  it('is enabled when SINGLE_CLIENT_MODE=1 by default', () => {
    delete process.env.OPENCLAW_SELF_HEAL;
    process.env.OPENCLAW_SINGLE_CLIENT_MODE = '1';
    expect(isOpenClawSelfHealEnabled()).toBe(true);
  });

  it('detects composed_runtime_mismatch', () => {
    const fragDir = path.join(tmpDir, 'openclaw.d');
    const runtime = path.join(tmpDir, 'openclaw.json');
    fs.mkdirSync(fragDir, { recursive: true });
    fs.writeFileSync(
      path.join(fragDir, '10-gateway-transport.json'),
      JSON.stringify({ gateway: { mode: 'local', bind: 'loopback', port: 18789 } })
    );
    fs.writeFileSync(runtime, JSON.stringify({ gateway: { mode: 'remote' } }) + '\n');
    process.env.OPENCLAW_FRAGMENTS_DIR = fragDir;
    process.env.OPENCLAW_RUNTIME_CONFIG_PATH = runtime;

    const h = assessOpenClawConfigHealth();
    expect(h.needsCompose).toBe(true);
    expect(h.reason).toBe('composed_runtime_mismatch');
  });

  it('composes runtime from fragments', async () => {
    const fragDir = path.join(tmpDir, 'openclaw.d');
    const runtime = path.join(tmpDir, 'openclaw.json');
    fs.mkdirSync(fragDir, { recursive: true });
    fs.writeFileSync(
      path.join(fragDir, '10-gateway-transport.json'),
      JSON.stringify({ gateway: { mode: 'local', bind: 'loopback', port: 18789 } })
    );
    fs.writeFileSync(runtime, JSON.stringify({ gateway: { mode: 'broken' } }) + '\n');
    process.env.OPENCLAW_FRAGMENTS_DIR = fragDir;
    process.env.OPENCLAW_RUNTIME_CONFIG_PATH = runtime;

    const result = await runOpenClawConfigSelfHeal({ trigger: 'test', force: true });
    expect(result.ok).toBe(true);
    expect(result.actions).toContain('composed');

    const j = JSON.parse(fs.readFileSync(runtime, 'utf8'));
    expect(j.gateway.mode).toBe('local');
  });

  it('flags gateway_mode_not_local when runtime matches fragments but mode is not local', () => {
    const fragDir = path.join(tmpDir, 'openclaw.d');
    const runtime = path.join(tmpDir, 'openclaw.json');
    const bad = { gateway: { mode: 'remote', bind: 'loopback', port: 18789 } };
    const body = `${JSON.stringify(bad, null, 2)}\n`;
    fs.mkdirSync(fragDir, { recursive: true });
    fs.writeFileSync(path.join(fragDir, '10-gateway-transport.json'), JSON.stringify(bad));
    fs.writeFileSync(runtime, body);
    process.env.OPENCLAW_FRAGMENTS_DIR = fragDir;
    process.env.OPENCLAW_RUNTIME_CONFIG_PATH = runtime;

    const h = assessOpenClawConfigHealth();
    expect(h.needsCompose).toBe(true);
    expect(h.reason).toBe('gateway_mode_not_local');
  });

  it('respects cooldown', async () => {
    const fragDir = path.join(tmpDir, 'openclaw.d');
    const runtime = path.join(tmpDir, 'openclaw.json');
    fs.mkdirSync(fragDir, { recursive: true });
    fs.writeFileSync(
      path.join(fragDir, '10-gateway-transport.json'),
      JSON.stringify({ gateway: { mode: 'local', bind: 'loopback', port: 18789 } })
    );
    fs.writeFileSync(runtime, JSON.stringify({ gateway: { mode: 'local', bind: 'loopback', port: 18789 } }) + '\n');
    process.env.OPENCLAW_FRAGMENTS_DIR = fragDir;
    process.env.OPENCLAW_RUNTIME_CONFIG_PATH = runtime;
    process.env.OPENCLAW_SELF_HEAL_COOLDOWN_MS = '600000';

    await runOpenClawConfigSelfHeal({ trigger: 't1', force: true });
    const second = await runOpenClawConfigSelfHeal({ trigger: 't2' });
    expect(second.actions).toContain('cooldown');
  });
});
