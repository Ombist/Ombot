import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  deepMerge,
  hasInvalidBlockrunProviderOverlay,
  hasInvalidNestedModelsKey,
  mergeOpenclawPatch,
  mergeOrderedFragments,
  mergePlugins,
  normalizeNestedModelsKey,
  repairBlockrunProviderOverlay,
} from '../tools/openclaw-json-merge.mjs';

describe('mergePlugins', () => {
  it('merges by id and deep-merges config', () => {
    const cur = [{ id: 'a', config: { x: 1 } }];
    const patch = [{ id: 'a', config: { y: 2 } }, { id: 'b', enabled: true }];
    const out = mergePlugins(cur, patch);
    expect(out).toHaveLength(2);
    const a = out.find((p) => p.id === 'a');
    expect(a.config).toEqual({ x: 1, y: 2 });
  });
});

describe('mergeOpenclawPatch', () => {
  it('deep merges plugins array semantics', () => {
    const base = { gateway: { port: 1 }, plugins: [{ id: 'p', config: { a: 1 } }] };
    const patch = { plugins: [{ id: 'p', config: { b: 2 } }] };
    const m = mergeOpenclawPatch(base, patch);
    expect(m.gateway.port).toBe(1);
    expect(m.plugins[0].config).toEqual({ a: 1, b: 2 });
  });
});

describe('mergeOrderedFragments', () => {
  it('applies later scalar overrides', () => {
    const a = [{ gateway: { port: 1 } }, { gateway: { port: 2 } }];
    const m = mergeOrderedFragments(a);
    expect(m.gateway.port).toBe(2);
  });
});

describe('deepMerge', () => {
  it('replaces arrays except plugins handling in mergeOpenclawPatch path', () => {
    const t = { x: [1, 2] };
    deepMerge(t, { x: [3] });
    expect(t.x).toEqual([3]);
  });
});

describe('hasInvalidNestedModelsKey', () => {
  it('detects nested models.models', () => {
    expect(
      hasInvalidNestedModelsKey({
        models: { models: { providers: { blockrun: {} } } },
      })
    ).toBe(true);
    expect(
      hasInvalidNestedModelsKey({
        models: { providers: { blockrun: {} } },
      })
    ).toBe(false);
  });
});

describe('hasInvalidBlockrunProviderOverlay', () => {
  it('detects blockrun with only baseUrl', () => {
    expect(
      hasInvalidBlockrunProviderOverlay({
        models: { providers: { blockrun: { baseUrl: 'http://127.0.0.1:8402/v1' } } },
      })
    ).toBe(true);
    expect(
      hasInvalidBlockrunProviderOverlay({
        models: {
          providers: {
            blockrun: {
              baseUrl: 'http://127.0.0.1:8402/v1',
              api: 'openai-completions',
              apiKey: 'x',
              models: [{ id: 'blockrun/auto' }],
            },
          },
        },
      })
    ).toBe(false);
  });
});

describe('stripOfficialOrphanBlockrun', () => {
  it('removes blockrun-only overlay when no ombrouter plugin', async () => {
    const { stripOfficialOrphanBlockrun } = await import('../tools/openclaw-repair-route.mjs');
    const cfg = {
      agents: { defaults: { model: { primary: 'openai/gpt-4o-mini', fallbacks: [] } } },
      models: { providers: { blockrun: { baseUrl: 'http://127.0.0.1:8402/v1' } } },
    };
    expect(stripOfficialOrphanBlockrun(cfg)).toBe(true);
    expect(cfg.models).toBeUndefined();
  });
});

describe('repairBlockrunProviderOverlay', () => {
  it('adds minimal models list for legacy blockrun-only patch', () => {
    const cfg = { models: { providers: { blockrun: { baseUrl: 'http://127.0.0.1:8402/v1' } } } };
    expect(repairBlockrunProviderOverlay(cfg)).toBe(true);
    expect(cfg.models.providers.blockrun.models).toEqual([{ id: 'blockrun/auto' }]);
    expect(cfg.models.providers.blockrun.api).toBe('openai-completions');
  });
});

describe('openclaw-validate-runtime-config.mjs', () => {
  it('--repair fixes nested models and blockrun overlay then exits 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-validate-'));
    const cfgPath = path.join(dir, 'openclaw.json');
    fs.writeFileSync(
      cfgPath,
      `${JSON.stringify({ models: { models: { providers: { blockrun: { baseUrl: 'http://127.0.0.1:8402/v1' } } } } }, null, 2)}\n`
    );
    const script = path.join(process.cwd(), 'tools/openclaw-validate-runtime-config.mjs');
    const r = spawnSync(process.execPath, [script, '--repair', cfgPath], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const fixed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(fixed.models.models).toBeUndefined();
    expect(fixed.models.providers.blockrun.baseUrl).toBe('http://127.0.0.1:8402/v1');
    expect(fixed.models.providers.blockrun.models).toEqual([{ id: 'blockrun/auto' }]);
  });
});

describe('normalizeNestedModelsKey', () => {
  it('hoists models.models.providers to models.providers', () => {
    const cfg = {
      models: {
        models: {
          providers: {
            blockrun: { baseUrl: 'http://127.0.0.1:8402/v1' },
          },
        },
      },
    };
    normalizeNestedModelsKey(cfg);
    expect(cfg.models.models).toBeUndefined();
    expect(cfg.models.providers.blockrun.baseUrl).toBe('http://127.0.0.1:8402/v1');
  });

  it('mergeOpenclawPatch repairs legacy nested models patch', () => {
    const base = {};
    const patch = {
      models: {
        models: {
          providers: { blockrun: { baseUrl: 'http://127.0.0.1:8402/v1' } },
        },
      },
    };
    const merged = mergeOpenclawPatch(base, patch);
    expect(merged.models.models).toBeUndefined();
    expect(merged.models.providers.blockrun.baseUrl).toBe('http://127.0.0.1:8402/v1');
    expect(merged.models.providers.blockrun.models).toEqual([{ id: 'blockrun/auto' }]);
  });

  it('mergeOpenclawPatch repairs blockrun-only provider overlay', () => {
    const merged = mergeOpenclawPatch(
      {},
      { models: { providers: { blockrun: { baseUrl: 'http://127.0.0.1:8402/v1' } } } }
    );
    expect(merged.models.providers.blockrun.models).toEqual([{ id: 'blockrun/auto' }]);
  });
});
