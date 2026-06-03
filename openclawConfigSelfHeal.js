/**
 * Self-heal OpenClaw: recompose fragments → runtime, restart gateway when port is down or config drift.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mergeOrderedFragments } from './tools/openclaw-json-merge.mjs';
import { repairOpenClawJsonFile } from './tools/openclaw-repair-route.mjs';
import { classifyGatewayError } from './gatewayErrorClassifier.js';
import { logger } from './logger.js';
import { gatewayLoopbackReachable } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {number} */
let lastHealAt = 0;
/** @type {Promise<{ ok: boolean; actions: string[]; reason?: string }> | null} */
let healInFlight = null;
/** @type {ReturnType<typeof setInterval> | null} */
let periodicTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let portWatchdogTimer = null;

function envTruthy(name, defaultWhenUnset = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultWhenUnset;
  }
  return ['1', 'true', 'yes'].includes(String(raw).trim().toLowerCase());
}

function envGatewayBridgeEnabled() {
  const v = (process.env.OPENCLAW_GATEWAY_BRIDGE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Watchdog + self-heal for single-client, bridge, or explicit OPENCLAW_SELF_HEAL. */
export function isGatewayWatchdogEnabled() {
  if (process.env.OPENCLAW_SELF_HEAL !== undefined) {
    return envTruthy('OPENCLAW_SELF_HEAL', false);
  }
  return envTruthy('OPENCLAW_SINGLE_CLIENT_MODE', false) || envGatewayBridgeEnabled();
}

export function isOpenClawSelfHealEnabled() {
  return isGatewayWatchdogEnabled();
}

function cooldownMs() {
  const n = Number(process.env.OPENCLAW_SELF_HEAL_COOLDOWN_MS ?? 120_000);
  return Number.isFinite(n) && n >= 10_000 ? n : 120_000;
}

function periodicIntervalMs() {
  const n = Number(process.env.OPENCLAW_SELF_HEAL_INTERVAL_MS ?? 180_000);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(60_000, n);
}

function gatewayWatchIntervalMs() {
  const n = Number(process.env.OPENCLAW_GATEWAY_WATCH_INTERVAL_MS ?? 60_000);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(15_000, n);
}

/** @returns {number} */
export function gatewayConnectWaitMs() {
  const n = Number(process.env.OPENCLAW_GATEWAY_CONNECT_WAIT_MS ?? 45_000);
  if (!Number.isFinite(n) || n < 0) return 45_000;
  return n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const dataDir = (process.env.OPENCLAW_DATA_DIR || '/var/lib/ombot').trim();
  const runtimePath = (
    process.env.OPENCLAW_RUNTIME_CONFIG_PATH ||
    (dataDir ? `${dataDir.replace(/\/$/, '')}/openclaw.json` : '') ||
    '/var/lib/ombot/openclaw.json'
  ).trim();
  const etcPath = (process.env.OPENCLAW_CONFIG_PATH || '/etc/ombot/openclaw.json').trim();
  return { fragmentsDir, runtimePath, etcPath };
}

/** @returns {string} */
function readRuntimeGatewayMode(runtimePath) {
  if (!runtimePath || !fs.existsSync(runtimePath)) return '';
  try {
    const j = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    return String(j?.gateway?.mode || '').trim();
  } catch {
    return '';
  }
}

/**
 * Ensure `10-gateway-transport.json` declares gateway.mode=local before compose.
 * @returns {{ patched: boolean; path?: string }}
 */
/**
 * Repair invalid route fragments / runtime before compose (blockrun overlay, nested models).
 * @returns {string[]}
 */
function repairOpenClawConfigsBeforeCompose(fragmentsDir, runtimePath, etcPath) {
  const actions = [];
  if (fragmentsDir && fs.existsSync(fragmentsDir)) {
    for (const fp of listFragmentFiles(fragmentsDir)) {
      const r = repairOpenClawJsonFile(fp);
      if (r.changed) {
        actions.push(`repaired_fragment:${path.basename(fp)}`);
      }
    }
  }
  if (runtimePath && fs.existsSync(runtimePath)) {
    const r = repairOpenClawJsonFile(runtimePath);
    if (r.changed) actions.push('repaired_runtime');
  }
  if (etcPath && etcPath !== runtimePath && fs.existsSync(etcPath)) {
    const r = repairOpenClawJsonFile(etcPath);
    if (r.changed) actions.push('repaired_etc');
  }
  return actions;
}

function ensureGatewayModeLocalInFragments(fragmentsDir) {
  const transportPath = path.join(fragmentsDir, '10-gateway-transport.json');
  if (!fs.existsSync(transportPath) || !pathWritable(transportPath)) {
    return { patched: false };
  }
  try {
    const j = JSON.parse(fs.readFileSync(transportPath, 'utf8'));
    if (!j.gateway || typeof j.gateway !== 'object' || Array.isArray(j.gateway)) {
      j.gateway = {};
    }
    if (j.gateway.mode === 'local') {
      return { patched: false, path: transportPath };
    }
    j.gateway.mode = 'local';
    const tmp = `${transportPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(j, null, 2)}\n`);
    fs.renameSync(tmp, transportPath);
    return { patched: true, path: transportPath };
  } catch (err) {
    logger.warn('openclaw_self_heal_fragment_mode_patch_failed', {
      path: transportPath,
      err: err?.message || String(err),
    });
    return { patched: false };
  }
}

/** @returns {{ host: string; port: number; url: string }} */
export function parseGatewayLoopbackTarget() {
  const url = (process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789').trim();
  try {
    const u = new URL(url);
    const host = u.hostname || '127.0.0.1';
    const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
    return { host, port: Number.isFinite(port) ? port : 18789, url };
  } catch {
    return { host: '127.0.0.1', port: 18789, url };
  }
}

/**
 * TCP probe (Gateway WS listens on same port).
 * @param {number} [timeoutMs]
 */
export function setGatewayLoopbackMetric(ok) {
  gatewayLoopbackReachable.set(ok ? 1 : 0);
}

export function probeGatewayLoopback(timeoutMs = 2000) {
  const { host, port, url } = parseGatewayLoopbackTarget();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ...result, host, port, url });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: 'timeout' }));
    socket.once('error', (err) => finish({ ok: false, error: err?.message || String(err) }));
  });
}

/**
 * Poll until loopback gateway accepts TCP or timeout.
 * @param {object} [opts]
 * @param {number} [opts.maxWaitMs]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.probeTimeoutMs]
 */
export async function waitForGatewayLoopback(opts = {}) {
  const maxWait = opts.maxWaitMs ?? gatewayConnectWaitMs();
  if (maxWait <= 0) {
    const probe = await probeGatewayLoopback(opts.probeTimeoutMs ?? 1500);
    setGatewayLoopbackMetric(probe.ok);
    return { ok: probe.ok, probe };
  }
  const poll = opts.pollMs ?? 500;
  const deadline = Date.now() + maxWait;
  let lastProbe = await probeGatewayLoopback(opts.probeTimeoutMs ?? 1500);
  if (lastProbe.ok) {
    setGatewayLoopbackMetric(true);
    return { ok: true, probe: lastProbe };
  }
  while (Date.now() < deadline) {
    await sleep(poll);
    lastProbe = await probeGatewayLoopback(opts.probeTimeoutMs ?? 1500);
    if (lastProbe.ok) {
      setGatewayLoopbackMetric(true);
      return { ok: true, probe: lastProbe };
    }
  }
  setGatewayLoopbackMetric(false);
  return { ok: false, probe: lastProbe };
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

  try {
    JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  } catch (err) {
    return {
      needsCompose: true,
      reason: `runtime_invalid:${err?.message || String(err)}`,
      fragmentCount: files.length,
      composedMatchesRuntime: false,
    };
  }

  const runtimeHash = sha256Hex(fs.readFileSync(runtimePath));
  const matches = composedHash === runtimeHash;
  if (!matches) {
    return {
      needsCompose: true,
      reason: 'composed_runtime_mismatch',
      fragmentCount: files.length,
      composedMatchesRuntime: false,
    };
  }

  const mode = readRuntimeGatewayMode(runtimePath);
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

/** Snapshot for /readyz and operators. */
export async function getOpenClawSelfHealStatus() {
  const { runtimePath } = resolveConfigPaths();
  const config = assessOpenClawConfigHealth();
  const loopback = await probeGatewayLoopback(1500);
  setGatewayLoopbackMetric(loopback.ok);
  const gatewayMode = readRuntimeGatewayMode(runtimePath);
  return {
    enabled: isGatewayWatchdogEnabled(),
    config,
    gatewayMode: gatewayMode || null,
    gatewayModeOk: gatewayMode === 'local',
    gatewayLoopback: loopback,
    gatewayReachable: loopback.ok,
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
 * @param {boolean} [opts.restartGateway] — try systemctl restart when port down or after compose
 */
/**
 * Light watchdog: TCP probe + restart gateway when port is down (no compose).
 */
export async function runGatewayPortWatchdog() {
  if (!isGatewayWatchdogEnabled()) {
    return { ok: true, actions: [], reason: 'disabled' };
  }
  const probe = await probeGatewayLoopback(2000);
  setGatewayLoopbackMetric(probe.ok);
  if (probe.ok) {
    return { ok: true, actions: ['port_up'], gatewayReachable: true };
  }

  logger.warn('openclaw_gateway_watchdog_port_down', {
    error: probe.error,
    host: probe.host,
    port: probe.port,
  });

  const restart = tryRestartGatewayService();
  const actions = [`gateway_port_down:${probe.error || 'closed'}`];
  if (restart.skipped) {
    actions.push('restart_skipped');
    return { ok: false, actions, gatewayReachable: false };
  }
  if (!restart.ok) {
    actions.push('gateway_restart_failed');
    return { ok: false, actions, gatewayReachable: false };
  }
  actions.push(`gateway_restarted:${restart.unit}`);
  const wait = await waitForGatewayLoopback({ maxWaitMs: gatewayConnectWaitMs() });
  if (wait.ok) {
    actions.push('gateway_port_up');
    return { ok: true, actions, gatewayReachable: true };
  }
  actions.push(`gateway_still_down:${wait.probe?.error || 'closed'}`);
  return { ok: false, actions, gatewayReachable: false };
}

export async function runOpenClawConfigSelfHeal(opts = {}) {
  if (!isGatewayWatchdogEnabled()) {
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

    const { fragmentsDir, runtimePath, etcPath } = resolveConfigPaths();
    let health = assessOpenClawConfigHealth();
    let composed = false;

    if (health.needsCompose) {
      const repairActions = repairOpenClawConfigsBeforeCompose(fragmentsDir, runtimePath, etcPath);
      for (const a of repairActions) {
        actions.push(a);
      }
      const modePatch = ensureGatewayModeLocalInFragments(fragmentsDir);
      if (modePatch.patched) {
        actions.push('fragment_mode_patched_local');
        logger.info('openclaw_self_heal_fragment_mode_local', { path: modePatch.path });
        health = assessOpenClawConfigHealth();
      }
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

    let probe = await probeGatewayLoopback(2000);
    setGatewayLoopbackMetric(probe.ok);
    if (!probe.ok) {
      actions.push(`gateway_port_down:${probe.error || 'closed'}`);
    }

    const wantRestart =
      opts.restartGateway !== false &&
      (composed || health.reason === 'runtime_missing' || !probe.ok);

    if (wantRestart) {
      const restart = tryRestartGatewayService();
      if (restart.skipped) {
        actions.push('restart_skipped');
      } else if (restart.ok) {
        actions.push(`gateway_restarted:${restart.unit}`);
        logger.info('openclaw_self_heal_gateway_restarted', { unit: restart.unit, trigger });
        const wait = await waitForGatewayLoopback({ maxWaitMs: gatewayConnectWaitMs() });
        probe = wait.probe;
        if (wait.ok) {
          actions.push('gateway_port_up');
        } else {
          actions.push(`gateway_still_down:${probe.error || 'closed'}`);
          logger.warn('openclaw_self_heal_gateway_still_down', {
            trigger,
            error: probe.error,
            host: probe.host,
            port: probe.port,
          });
        }
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
    const ok =
      !actions.includes('compose_failed') &&
      !actions.some((a) => a.startsWith('gateway_still_down'));
    const gatewayMode = readRuntimeGatewayMode(runtimePath);
    logger.info('openclaw_self_heal_done', {
      trigger,
      ok,
      actions,
      gatewayReachable: probe.ok,
      gatewayMode: gatewayMode || '(missing)',
      gatewayModeOk: gatewayMode === 'local',
    });
    return {
      ok,
      actions,
      reason: health.reason,
      gatewayReachable: probe.ok,
      gatewayMode,
      gatewayModeOk: gatewayMode === 'local',
    };
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
  if (!isGatewayWatchdogEnabled()) return;
  const classified = classifyGatewayError(errorLike);
  if (classified.category !== 'network') return;

  void runOpenClawConfigSelfHeal({ trigger, restartGateway: true, force: true }).catch((err) => {
    logger.error('openclaw_self_heal_unhandled', { err: err?.message || String(err) });
  });
}

/**
 * Before/after user turn when gateway WS is not ready (config may be fine; service down).
 */
export function scheduleOpenClawSelfHealOnGatewayUnavailable(trigger = 'gateway_unavailable') {
  if (!isGatewayWatchdogEnabled()) return;
  void runOpenClawConfigSelfHeal({ trigger, restartGateway: true, force: true }).catch((err) => {
    logger.error('openclaw_self_heal_unhandled', { err: err?.message || String(err) });
  });
}

/** Light TCP probe + restart interval. */
export function startGatewayPortWatchdog() {
  stopGatewayPortWatchdog();
  if (!isGatewayWatchdogEnabled()) return;
  const interval = gatewayWatchIntervalMs();
  if (interval <= 0) return;

  portWatchdogTimer = setInterval(() => {
    void runGatewayPortWatchdog().catch((err) => {
      logger.error('openclaw_gateway_watchdog_failed', { err: err?.message || String(err) });
    });
  }, interval);
  portWatchdogTimer.unref?.();
  logger.info('openclaw_gateway_port_watchdog_started', { intervalMs: interval });
}

export function stopGatewayPortWatchdog() {
  if (portWatchdogTimer) {
    clearInterval(portWatchdogTimer);
    portWatchdogTimer = null;
  }
}

/** Periodic compose + port check (single-bot / bridge deployments). */
export function startPeriodicOpenClawSelfHeal() {
  stopPeriodicOpenClawSelfHeal();
  if (!isGatewayWatchdogEnabled()) return;
  const interval = periodicIntervalMs();
  if (interval <= 0) return;

  periodicTimer = setInterval(() => {
    void runOpenClawConfigSelfHeal({ trigger: 'periodic', restartGateway: true }).catch((err) => {
      logger.error('openclaw_self_heal_periodic_failed', { err: err?.message || String(err) });
    });
  }, interval);
  periodicTimer.unref?.();
  logger.info('openclaw_self_heal_periodic_started', { intervalMs: interval });
}

export function stopPeriodicOpenClawSelfHeal() {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

/** Startup heal + periodic compose + light port watchdog. */
export function startGatewayLoopbackWatchdog() {
  if (!isGatewayWatchdogEnabled()) return;
  void runOpenClawConfigSelfHeal({ trigger: 'ombot_startup', force: true }).catch((err) => {
    logger.error('openclaw_self_heal_startup_failed', { err: err?.message || String(err) });
  });
  startPeriodicOpenClawSelfHeal();
  startGatewayPortWatchdog();
}

export function stopGatewayLoopbackWatchdog() {
  stopPeriodicOpenClawSelfHeal();
  stopGatewayPortWatchdog();
}

/** Reset cooldown (tests). */
export function _resetOpenClawSelfHealStateForTests() {
  lastHealAt = 0;
  healInFlight = null;
  stopGatewayLoopbackWatchdog();
}
