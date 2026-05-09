import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveGatewayTurnAgentId } from '../gatewayTurnAgentId.js';

describe('resolveGatewayTurnAgentId', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns explicit non-default id unchanged', () => {
    vi.stubEnv('OPENCLAW_BRIDGE_AGENT_ID', 'from-env');
    expect(resolveGatewayTurnAgentId('explicit')).toBe('explicit');
  });

  it('replaces placeholder default with env', () => {
    vi.stubEnv('OPENCLAW_BRIDGE_AGENT_ID', 'main');
    expect(resolveGatewayTurnAgentId('default')).toBe('main');
    expect(resolveGatewayTurnAgentId('')).toBe('main');
    expect(resolveGatewayTurnAgentId(undefined)).toBe('main');
  });

  it('prefers OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID over BRIDGE_AGENT_ID', () => {
    vi.stubEnv('OPENCLAW_BRIDGE_AGENT_ID', 'a');
    vi.stubEnv('OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID', 'b');
    expect(resolveGatewayTurnAgentId('default')).toBe('b');
  });

  it('falls back to default when no env and no id', () => {
    expect(resolveGatewayTurnAgentId(undefined)).toBe('default');
    expect(resolveGatewayTurnAgentId('')).toBe('default');
  });
});
