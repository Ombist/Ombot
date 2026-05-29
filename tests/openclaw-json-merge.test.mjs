import { describe, it, expect } from 'vitest';
import {
  deepMerge,
  mergeOpenclawPatch,
  mergeOrderedFragments,
  mergePlugins,
  normalizeNestedModelsKey,
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
  });
});
