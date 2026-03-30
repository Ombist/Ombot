import { WebSocket } from 'ws';

const target = process.env.LOADCHECK_WS_URL || 'ws://127.0.0.1:8080/ws';
const total = Number(process.env.LOADCHECK_CLIENTS || 100);
const timeoutMs = Number(process.env.LOADCHECK_TIMEOUT_MS || 5000);
const rounds = Number(process.env.LOADCHECK_ROUNDS || 3);

let ok = 0;
let fail = 0;
let done = 0;
const startedAt = Date.now();

function finish() {
  if (done !== total * rounds) return;
  const attempts = total * rounds;
  const successRate = attempts === 0 ? 100 : (ok / attempts) * 100;
  const result = {
    target,
    rounds,
    total,
    attempts,
    ok,
    fail,
    successRate: Number(successRate.toFixed(2)),
    elapsedMs: Date.now() - startedAt,
  };
  console.log(JSON.stringify(result));
  if (successRate < 99.7) process.exit(1);
}

if (total === 0 || rounds === 0) {
  finish();
}

for (let r = 0; r < rounds; r++) {
  for (let i = 0; i < total; i++) {
    const ws = new WebSocket(target);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      fail++;
      done++;
      try {
        ws.terminate();
      } catch {}
      finish();
    }, timeoutMs);

    ws.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ok++;
      done++;
      ws.close();
      finish();
    });

    ws.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail++;
      done++;
      finish();
    });
  }
}
