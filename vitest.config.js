import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['boxCrypto.js', 'chatroomStorage.js', 'sessionKey.js', 'ed25519.js'],
      thresholds: {
        lines: 85,
        branches: 65,
        functions: 85,
        statements: 85,
      },
    },
  },
});
