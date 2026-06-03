import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getSingleClientActiveSessionForTests,
  registerSingleClientActiveSession,
  startSingleClientGateway,
  stopSingleClientGateway,
  unregisterSingleClientActiveSession,
} from '../singleClientGateway.js';

describe('singleClientGateway', () => {
  afterEach(() => {
    stopSingleClientGateway();
    vi.unstubAllEnvs();
  });

  it('startSingleClientGateway creates shared client when single-client mode', () => {
    vi.stubEnv('OPENCLAW_SINGLE_CLIENT_MODE', '1');
    vi.stubEnv('OPENCLAW_GATEWAY_URL', 'ws://127.0.0.1:9');
    startSingleClientGateway();
    startSingleClientGateway();
    expect(stopSingleClientGateway).toBeDefined();
  });

  it('unregister only clears matching active session', () => {
    const a = { _destroyed: false, traceId: 'a' };
    const b = { _destroyed: false, traceId: 'b' };
    registerSingleClientActiveSession(a);
    registerSingleClientActiveSession(b);
    expect(getSingleClientActiveSessionForTests()).toBe(b);
    unregisterSingleClientActiveSession(a);
    expect(getSingleClientActiveSessionForTests()).toBe(b);
    unregisterSingleClientActiveSession(b);
    expect(getSingleClientActiveSessionForTests()).toBeNull();
  });
});
