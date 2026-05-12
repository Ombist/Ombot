#!/usr/bin/env node
/**
 * Compose /etc/ombot/openclaw.d/*.json into effective openclaw.json.
 *
 * Env:
 *   OPENCLAW_FRAGMENTS_DIR — default /etc/ombot/openclaw.d
 *   OPENCLAW_RUNTIME_CONFIG_PATH — required for write (unless --dry-run)
 *   OPENCLAW_CONFIG_PATH — optional; if set, copy composed JSON there after runtime write
 *   OPENCLAW_COMPOSE_STRICT_KEYS=1 or --strict-keys — validate fragment filenames vs top-level keys
 *   OPENCLAW_COMPOSE_USE_FLOCK=0 — disable lock (default: attempt lock when not --dry-run)
 *
 * Args: [--dry-run] [--rollback] [--strict-keys] [--no-flock] [--json]
 *
 * Exit: 0 ok, 1 error, 2 COMPOSE_LOCKED, 3 STRICT_KEYS_VIOLATION
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { mergeOrderedFragments } from './openclaw-json-merge.mjs';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** @param {string} basename */
function strictKeysForFile(basename) {
  const lower = basename.toLowerCase();
  if (lower.startsWith('10-')) return { allow: ['gateway'], forbidAuthInGateway: true };
  if (lower.startsWith('20-')) return { allow: ['gateway'] };
  if (lower.startsWith('30-')) return { allow: ['models', 'agents'] };
  if (lower.startsWith('40-')) return { allow: ['plugins'] };
  if (lower.startsWith('90-')) return { allow: null };
  return { allow: null };
}

/**
 * @param {string} basename
 * @param {Record<string, unknown>} obj
 */
function validateStrictKeys(basename, obj) {
  const rule = strictKeysForFile(basename);
  if (!rule || rule.allow === null) return null;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!rule.allow.includes(k)) {
      return `fragment ${basename}: disallowed top-level key "${k}" (allowed: ${rule.allow.join(', ')})`;
    }
  }
  if (rule.forbidAuthInGateway && obj.gateway && typeof obj.gateway === 'object' && !Array.isArray(obj.gateway)) {
    const g = /** @type {Record<string, unknown>} */ (obj.gateway);
    if (g.auth !== undefined) {
      return `fragment ${basename}: gateway.auth not allowed in transport fragment (use 20-gateway-security)`;
    }
  }
  return null;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFragmentFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json') && !n.startsWith('.') && !n.endsWith('.bak'))
    .sort((a, b) => a.localeCompare(b));
  return names.map((n) => path.join(dir, n));
}

class ComposeLock {
  /** @param {string} lockPath */
  constructor(lockPath) {
    this.lockPath = lockPath;
    /** @type {number|null} */
    this.fd = null;
  }

  acquire(maxMs = 15000) {
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        this.fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(this.fd, String(process.pid));
        return;
      } catch (e) {
        const code = /** @type {NodeJS.ErrnoException} */ (e).code;
        if (code !== 'EEXIST') throw e;
        if (Date.now() - start > maxMs) {
          const err = new Error('COMPOSE_LOCKED');
          /** @type {Error & { code?: string }} */ (err).code = 'COMPOSE_LOCKED';
          throw err;
        }
        const stale = this.tryStealStaleLock();
        if (stale) {
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            /* ignore */
          }
          continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }

  tryStealStaleLock() {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf8').trim();
      const pid = parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) return true;
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    } catch {
      return true;
    }
  }

  release() {
    if (this.fd != null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      /* ignore */
    }
  }
}

function parseArgs(argv) {
  const flags = { dryRun: false, rollback: false, strictKeys: false, noFlock: false, json: false };
  for (const a of argv) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--rollback') flags.rollback = true;
    else if (a === '--strict-keys') flags.strictKeys = true;
    else if (a === '--no-flock') flags.noFlock = true;
    else if (a === '--json') flags.json = true;
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const strict =
    flags.strictKeys ||
    String(process.env.OPENCLAW_COMPOSE_STRICT_KEYS || '').trim() === '1' ||
    String(process.env.OPENCLAW_COMPOSE_STRICT_KEYS || '').toLowerCase() === 'true';
  const fragmentsDir = (process.env.OPENCLAW_FRAGMENTS_DIR || '/etc/ombot/openclaw.d').trim();
  const runtimePath = (process.env.OPENCLAW_RUNTIME_CONFIG_PATH || '').trim();
  const etcPath = (process.env.OPENCLAW_CONFIG_PATH || '').trim();
  const useFlock =
    !flags.dryRun &&
    !flags.noFlock &&
    String(process.env.OPENCLAW_COMPOSE_USE_FLOCK || '1').trim() !== '0';

  if (flags.rollback) {
    if (!runtimePath) {
      console.error('openclaw-compose: OPENCLAW_RUNTIME_CONFIG_PATH required for --rollback');
      process.exit(1);
    }
    const bak = `${runtimePath}.bak`;
    if (!fs.existsSync(bak)) {
      console.error(`openclaw-compose: backup missing: ${bak}`);
      process.exit(1);
    }
    const body = fs.readFileSync(bak, 'utf8');
    fs.writeFileSync(runtimePath, body);
    if (etcPath) fs.writeFileSync(etcPath, body);
    console.log(JSON.stringify({ ok: true, mode: 'rollback', restoredFrom: bak }, null, 2));
    return;
  }

  const files = listFragmentFiles(fragmentsDir);

  const fragments = [];
  const fragmentMeta = [];
  for (const fp of files) {
    const base = path.basename(fp);
    let j;
    try {
      j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) {
      console.error(`openclaw-compose: invalid JSON ${fp}: ${/** @type {Error} */ (e).message}`);
      process.exit(1);
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      console.error(`openclaw-compose: ${fp} must be a JSON object`);
      process.exit(1);
    }
    if (strict) {
      const err = validateStrictKeys(base, /** @type {Record<string, unknown>} */ (j));
      if (err) {
        console.error(`openclaw-compose: STRICT_KEYS_VIOLATION: ${err}`);
        process.exit(3);
      }
    }
    fragments.push(j);
    fragmentMeta.push({
      file: fp,
      basename: base,
      sha256: sha256Hex(fs.readFileSync(fp)),
    });
  }

  const composed = mergeOrderedFragments(fragments);
  const outBuf = Buffer.from(`${JSON.stringify(composed, null, 2)}\n`, 'utf8');
  const composedHash = sha256Hex(outBuf);

  if (flags.dryRun) {
    let diskHash = '';
    if (runtimePath && fs.existsSync(runtimePath)) {
      diskHash = sha256Hex(fs.readFileSync(runtimePath));
    }
    const report = {
      ok: true,
      mode: 'dry_run',
      fragmentsDir,
      fragmentCount: files.length,
      fragments: fragmentMeta,
      composedHash,
      runtimePath: runtimePath || null,
      runtimeOnDiskHash: diskHash || null,
      matchesRuntime: diskHash === composedHash,
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (files.length === 0) {
    console.error(`openclaw-compose: no fragment JSON files in ${fragmentsDir}`);
    process.exit(1);
  }

  if (!runtimePath) {
    console.error('openclaw-compose: OPENCLAW_RUNTIME_CONFIG_PATH required (or use --dry-run)');
    process.exit(1);
  }

  const lockPath = path.join(fragmentsDir, '.compose.lock');
  /** @type {ComposeLock|null} */
  let lock = null;
  if (useFlock) {
    try {
      fs.mkdirSync(fragmentsDir, { recursive: true });
    } catch {
      /* ignore */
    }
    lock = new ComposeLock(lockPath);
    try {
      lock.acquire();
    } catch (e) {
      if (/** @type {Error & { code?: string }} */ (e).code === 'COMPOSE_LOCKED') {
        console.error('openclaw-compose: COMPOSE_LOCKED');
        process.exit(2);
      }
      throw e;
    }
  }

  try {
    const tmp = `${runtimePath}.tmp.${process.pid}`;
    const bak = `${runtimePath}.bak`;
    if (fs.existsSync(runtimePath)) {
      fs.copyFileSync(runtimePath, bak);
    }
    fs.writeFileSync(tmp, outBuf);
    fs.renameSync(tmp, runtimePath);
    if (etcPath) {
      const tmpEtc = `${etcPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpEtc, outBuf);
      fs.renameSync(tmpEtc, etcPath);
    }

    const audit = {
      at: new Date().toISOString(),
      mode: 'compose',
      composedHash,
      fragmentFiles: fragmentMeta.map((m) => m.basename),
    };
    console.error(`openclaw-compose: ok composedHash=${composedHash} fragments=${files.length}`);
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, ...audit }, null, 2));
    }
  } finally {
    lock?.release();
  }
}

main();
