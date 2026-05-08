import { describe, expect, it } from 'vitest';
import { classifyGatewayError } from '../gatewayErrorClassifier.js';

describe('classifyGatewayError', () => {
  it('classifies pairing errors', () => {
    const out = classifyGatewayError({ code: 'NOT_PAIRED', message: 'device identity required' });
    expect(out.category).toBe('pairing');
    expect(out.reason).toBe('not_paired');
  });

  it('classifies scope errors', () => {
    const out = classifyGatewayError('errorMessage=missing scope: operator.write');
    expect(out.category).toBe('scope');
    expect(out.reason).toBe('missing_scope');
  });

  it('classifies provider auth errors', () => {
    const out = classifyGatewayError('No API key found for provider "openai"');
    expect(out.category).toBe('provider');
    expect(out.reason).toBe('provider_auth');
  });
});
