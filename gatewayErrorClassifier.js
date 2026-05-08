function toFlatErrorString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function includesAny(haystack, needles) {
  for (const needle of needles) {
    if (haystack.includes(needle)) return true;
  }
  return false;
}

export function classifyGatewayError(errorLike) {
  const raw = toFlatErrorString(errorLike);
  const text = raw.toLowerCase();

  if (
    includesAny(text, ['not_paired', 'device_identity_required', 'device identity required'])
  ) {
    return { category: 'pairing', reason: 'not_paired', raw };
  }

  if (
    includesAny(text, [
      'missing scope',
      'insufficient_scope',
      'operator.write',
      'scope:',
      'forbidden',
    ])
  ) {
    return { category: 'scope', reason: 'missing_scope', raw };
  }

  if (
    includesAny(text, [
      'no api key found',
      'invalid api key',
      '401',
      'unauthorized',
      'auth_failed',
      'authentication',
      'permission denied for provider',
    ])
  ) {
    return { category: 'provider', reason: 'provider_auth', raw };
  }

  if (includesAny(text, ['econnrefused', 'etimedout', 'ehostunreach', 'network'])) {
    return { category: 'network', reason: 'transport_error', raw };
  }

  return { category: 'unknown', reason: 'unknown', raw };
}
