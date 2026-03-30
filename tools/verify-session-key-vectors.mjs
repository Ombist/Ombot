/**
 * 驗證 sessionKey 與 docs/e2e-session-key-test-vectors.json 一致。
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { computeSessionKey } from '../sessionKey.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsonPath = join(__dirname, '../../docs/e2e-session-key-test-vectors.json');
const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));

let ok = 0;
for (const c of doc.cases) {
  const sk = computeSessionKey(c.agentId, c.conversationId, c.participantId ?? null);
  if (sk !== c.sessionKey) {
    console.error('Mismatch:', c, 'expected', c.sessionKey, 'got', sk);
    process.exit(1);
  }
  ok++;
}
console.log('session key vectors OK:', ok);
