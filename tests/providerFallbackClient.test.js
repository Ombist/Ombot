import { describe, expect, it } from 'vitest';
import { extractContentFromChatCompletion } from '../providerFallbackClient.js';

describe('extractContentFromChatCompletion', () => {
  it('returns string content directly', () => {
    const text = extractContentFromChatCompletion({
      choices: [{ message: { content: 'hello' } }],
    });
    expect(text).toBe('hello');
  });

  it('joins array content text fields', () => {
    const text = extractContentFromChatCompletion({
      choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }],
    });
    expect(text).toBe('a\nb');
  });
});
