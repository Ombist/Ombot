import { classifyGatewayError } from './gatewayErrorClassifier.js';

function normalizeOpenAiBaseUrl(raw) {
  const base = String(raw || '').trim();
  if (!base) return 'https://api.openai.com/v1';
  if (base.endsWith('/v1')) return base;
  if (base.endsWith('/v1/')) return base.slice(0, -1);
  return `${base.replace(/\/+$/, '')}/v1`;
}

function extractContentFromChatCompletion(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const message = choice?.message;
  if (!message) return null;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const chunks = message.content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean);
    return chunks.length > 0 ? chunks.join('\n') : null;
  }
  return null;
}

export class ProviderFallbackClient {
  constructor() {
    this.openAiApiKey = String(process.env.OPENAI_API_KEY || '').trim();
    this.openAiBaseUrl = normalizeOpenAiBaseUrl(process.env.OPENAI_BASE_URL);
    this.model = (
      process.env.OPENCLAW_FALLBACK_OPENAI_MODEL ||
      process.env.OPENAI_MODEL ||
      'gpt-4.1-mini'
    ).trim();
    this.timeoutMs = Number(process.env.OPENCLAW_FALLBACK_TIMEOUT_MS || 45000);
  }

  isConfigured() {
    return this.openAiApiKey.length > 0;
  }

  async completeUserTurn(userText) {
    if (!this.isConfigured()) {
      throw new Error('fallback_provider_not_configured');
    }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.openAiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.openAiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                'You are Ombot fallback mode. Be concise and say fallback mode is active if relevant.',
            },
            { role: 'user', content: String(userText || '') },
          ],
          temperature: 0.2,
        }),
        signal: ctrl.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        const classified = classifyGatewayError(body);
        const err = new Error(`fallback_provider_http_${res.status}:${body.slice(0, 300)}`);
        err.category = classified.category;
        err.reason = classified.reason;
        throw err;
      }
      const json = JSON.parse(body);
      const text = extractContentFromChatCompletion(json);
      if (!text) throw new Error('fallback_provider_empty_response');
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export { extractContentFromChatCompletion };
