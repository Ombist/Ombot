/**
 * Self-heal OpenClaw config when fragments exist but runtime JSON is missing, invalid, or out of sync.
 * Optionally restarts ombist-openclaw-gateway.service (requires passwordless sudo).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mergeOrderedFragments } from './tools/openclaw-json-merge.mjs';
import { classifyGatewayError } from './gatewayErrorClassifier.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {number} */
let lastHealAt = 0;
/** @type {Promise<{ ok: boolean; actions: string[]; reason?: string }> | null} */
let healInFlight = null;

function envTruthy(name, defaultWhenUnset = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultWhenUnset;
  }
  return ['1', 'true', 'yes'].includes(String(raw).trim().toLowerCase());
}

export function isOpenClawSelfHealEnabled() {
  if (process.env.OPENCLAW_SELF_HEAL !== undefined) {
    return envTruthy('OPENCLAW_SELF_HEAL', false);
  }
  return envTruthy('OPENCLAW_SINGLE_CLIENT_MODE', false);
}

function cooldownMs() {
  const n = Number(process.env.OPENCLAW_SELF_HEAL_COOLDOWN_MS ?? 120_000);
  return Number.isFinite(n) && n >= 10_000 ? n : 120_000;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function listFragmentFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json') && !n.startsWith('.') && !n.endsWith('.bak'))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => path.join(dir, n));
}

function pathWritable(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    const parent = path.dirname(filePath);
    try {
      fs.accessSync(parent, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function resolveToolsDir() {
  const candidates = [
    process.env.OMBOT_REPO_DIR ? path.join(process.env.OMBOT_REPO_DIR, 'tools') : '',
    path.join(__dirname, 'tools'),
    '/opt/ombot/Ombot/tools',
  ].filter(Boolean);
  for (const d of candidates) {
    if (fs.existsSync(path.join(d, 'openclaw-compose.mjs'))) return d;
  }
  return path.join(__dirname, 'tools');
}

function resolveConfigPaths() {
  const fragmentsDir = (process.env.OPENCLAW_FRAGMENTS_DIR || '/etc/ombot/openclaw.d').trim();
  const runtimePath = (
    process.env.OPENCLAW_RUNTIME_CONFIG_PATH ||
    process.env.OPENCLAW_CONFIG_PATH ||
    '/home/ombot/.openclaw/openclaw.json'
  ).trim();
  const etcPath = (process.env.OPENCLAW_CONFIG_PATH || '/etc/ombot/openclaw.json').trim();
  return { fragmentsDir, runtimePath, etcPath };
}

/**
 * @returns {{ needsCompose: boolean; reason: string; fragmentCount: number; composedMatchesRuntime: boolean | null }}
 */
export function assessOpenClawConfigHealth() {
  const { fragmentsDir, runtimePath } = resolveConfigPaths();
  const files = listFragmentFiles(fragmentsDir);
  if (files.length === 0) {
    return {
      needsCompose: false,
      reason: 'no_fragments',
      fragmentCount: 0,
      composedMatchesRuntime: null,
    };
  }

  let composedHash = '';
  try {
    const fragments = files.map((fp) => JSON.parse(fs.readFileSync(fp, 'utf8')));
    const body = Buffer.from(`${JSON.stringify(mergeOrderedFragments(fragments), null, 2)}\n`, 'utf8');
    composedHash = sha256Hex(body);
  } catch (err) {
    return {
      needsCompose: true,
      reason: `fragment_compose_error:${err?.message || String(err)}`,
      fragmentCount: files.length,
      composedMatchesRuntime: false,
    };
  }

  if (!fs.existsSync(runtimePath)) {
    return {
      needsCompose: true,
      reason: 'runtime_missing',
      fragmentCount: files.length,
      composedMatchesRuntime: false,
    };
  }

  let runtimeHash = '';
  try {
    JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    runtimeHash = sha256Hex(fs.readFileSync(runtimePath));
  } catch (err) {
    return {
      needsCompose: true,
      reason: `runtime_invalid:${err?.message || String(err)}`,
      fragmentCount: files.length,
      composedMatchesRuntime: false,
    };
  }

  const matches = composedHash === runtimeHash;
  if (!matches) {
    return {
      needsCompose: true,
      reason: 'composed_runtime_mismatch',
      fragmentCount: files.length,
      composedMatchesRuntime: false,
    };
  }

  const mode = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      return String(j?.gateway?.mode || '').trim();
    } catch {
      return '';
    }
  })();
  if (mode !== 'local') {
    return {
      needsCompose: true,
      reason: 'gateway_mode_not_local',
      fragmentCount: files.length,
      composedMatchesRuntime: true,
    };
  }

  return {
    needsCompose: false,
    reason: 'ok',
    fragmentCount: files.length,
    composedMatchesRuntime: true,
  };
}

function runCompose() {
  const toolsDir = resolveToolsDir();
  const composeScript = path.join(toolsDir, 'openclaw-compose.mjs');
  if (!fs.existsSync(composeScript)) {
    return { ok: false, error: 'openclaw-compose.mjs missing' };
  }

  const { fragmentsDir, runtimePath, etcPath } = resolveConfigPaths();
  if (!pathWritable(runtimePath)) {
    return { ok: false, error: `runtime not writable: ${runtimePath}` };
  }

  const env = {
    ...process.env,
    OPENCLAW_FRAGMENTS_DIR: fragmentsDir,
    OPENCLAW_RUNTIME_CONFIG_PATH: runtimePath,
    OPENCLAW_COMPOSE_USE_FLOCK: '0',
  };
  if (pathWritable(etcPath)) {
    env.OPENCLAW_CONFIG_PATH = etcPath;
  } else {
    delete env.OPENCLAW_CONFIG_PATH;
  }

  const r = spawnSync(process.execPath, [composeScript, '--json'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const stderr = (r.stderr || '').trim();
  const stdout = (r.stdout || '').trim();
  if (r.status !== 0) {
    const detail = stderr || stdout || `exit ${r.status}`;
    return { ok: false, error: detail.slice(0, 400) };
  }
  return { ok: true };
}

function tryRestartGatewayService() {
  if (!envTruthy('OPENCLAW_SELF_HEAL_RESTART_GATEWAY', true)) {
    return { ok: false, skipped: true, reason: 'restart_disabled' };
  }

  const units = [
    'ombist-openclaw-gateway.service',
    'openclaw-gateway@Ombist_IOS.service',
  ];
  for (const unit of units) {
    const r = spawnSync('sudo', ['-n', 'systemctl', 'restart', unit], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (r.status === 0) {
      return { ok: true, unit };
    }
  }
  return { ok: false, error: 'sudo systemctl restart failed (no passwordless sudo?)' };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.trigger]
 * @param {boolean} [opts.force] — ignore cooldown
 * @param {boolean} [opts.restartGateway] — default true when compose ran
 */
export async function runOpenClawConfigSelfHeal(opts = {}) {
  if (!isOpenClawSelfHealEnabled()) {
    return { ok: true, actions: [], reason: 'disabled' };
  }

  const now = Date.now();
  if (!opts.force && now - lastHealAt < cooldownMs()) {
    return { ok: true, actions: ['cooldown'], reason: 'cooldown' };
  }

  if (healInFlight) {
    return healInFlight;
  }

  healInFlight = (async () => {
    const actions = [];
    const trigger = opts.trigger || 'manual';
    logger.info('openclaw_self_heal_start', { trigger });

    const health = assessOpenClawConfigHealth();
    let composed = false;

    if (health.needsCompose) {
      const composeResult = runCompose();
      if (composeResult.ok) {
        composed = true;
        actions.push('composed');
        logger.info('openclaw_self_heal_compose_ok', {
          trigger,
          priorReason: health.reason,
          fragmentCount: health.fragmentCount,
        });
      } else {
        actions.push('compose_failed');
        logger.error('openclaw_self_heal_compose_failed', {
          trigger,
          reason: health.reason,
          error: composeResult.error,
        });
        lastHealAt = Date.now();
        return { ok: false, actions, reason: composeResult.error };
      }
    } else {
      actions.push('config_ok');
    }

    const shouldRestart =
      opts.restartGateway !== false && (composed || health.reason === 'runtime_missing');
    if (shouldRestart) {
      const restart = tryRestartGatewayService();
      if (restart.skipped) {
        actions.push('restart_skipped');
      } else if (restart.ok) {
        actions.push(`gateway_restarted:${restart.unit}`);
        logger.info('openclaw_self_heal_gateway_restarted', { unit: restart.unit, trigger });
      } else {
        actions.push('gateway_restart_failed');
        logger.warn('openclaw_self_heal_gateway_restart_failed', {
          trigger,
          error: restart.error,
          hint: 'run: sudo systemctl restart ombist-openclaw-gateway.service',
        });
      }
    }

    lastHealAt = Date.now();
    const ok = !actions.includes('compose_failed');
    logger.info('openclaw_self_heal_done', { trigger, ok, actions });
    return { ok, actions, reason: health.reason };
  })();

  try {
    return await healInFlight;
  } finally {
    healInFlight = null;
  }
}

/**
 * Fire-and-forget heal when gateway transport fails (ECONNREFUSED, etc.).
 * @param {unknown} errorLike
 * @param {string} [trigger]
 */
export function scheduleOpenClawSelfHealOnGatewayTransportError(errorLike, trigger = 'gateway_transport') {
  if (!isOpenClawSelfHealEnabled()) return;
  const classified = classifyGatewayError(errorLike);
  if (classified.category !== 'network') return;

  void runOpenClawConfigSelfHeal({ trigger, restartGateway: true }).catch((err) => {
    logger.error('openclaw_self_heal_unhandled', { err: err?.message || String(err) });
  });
}

/** Reset cooldown (tests). */
export function _resetOpenClawSelfHealStateForTests() {
  lastHealAt = 0;
  healInFlight = null;
}
