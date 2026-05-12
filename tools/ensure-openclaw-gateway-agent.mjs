#!/usr/bin/env node
/**
 * Ensures OpenClaw JSON has an `agents.list` entry matching Ombot's bridge agent id.
 *
 * When OPENCLAW_FRAGMENTS_DIR exists (or OPENCLAW_AGENTS_FRAGMENT_PATH is set), writes only
 * the agents fragment under openclaw.d then runs openclaw-compose (single authority).
 *
 * Legacy mode (no fragments dir): updates OPENCLAW_RUNTIME_CONFIG_PATH / OPENCLAW_CONFIG_PATH
 * directly when OPENCLAW_LEGACY_AGENT_WRITE=1 or fragments dir is absent/unset.
 *
 * Env:
 *   OMBIST_GATEWAY_AGENT_ID, OMBIST_GATEWAY_AGENT_MODEL
 *   OPENCLAW_FRAGMENTS_DIR — default /etc/ombot/openclaw.d when present
 *   OPENCLAW_AGENTS_FRAGMENT_PATH — override fragment file path
 *   OPENCLAW_RUNTIME_CONFIG_PATH, OPENCLAW_CONFIG_PATH — for compose + legacy
 *   OPENCLAW_LEGACY_AGENT_WRITE=1 — force legacy multi-file write
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const agentId = (process.env.OMBIST_GATEWAY_AGENT_ID || 'default').trim() || 'default';
const primary = (process.env.OMBIST_GATEWAY_AGENT_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';

function mergeAgents(j) {
  j.agents = j.agents && typeof j.agents === 'object' ? j.agents : {};
  const defModel = { primary, fallbacks: [] };
  if (!j.agents.defaults || typeof j.agents.defaults !== 'object') {
    j.agents.defaults = {};
  }
  if (!j.agents.defaults.model || typeof j.agents.defaults.model !== 'object') {
    j.agents.defaults.model = { ...defModel };
  }
  const list = Array.isArray(j.agents.list) ? [...j.agents.list] : [];
  j.agents.list = list;
  if (list.some((a) => a && String(a.id) === agentId)) {
    return false;
  }
  const hasDefault = list.some((a) => a && a.default === true);
  list.push({
    id: agentId,
    default: !hasDefault,
    model: { ...defModel },
  });
  return true;
}

function runCompose() {
  const composeJs = path.join(__dirname, 'openclaw-compose.mjs');
  const r = spawnSync(process.execPath, [composeJs], {
    env: {
      ...process.env,
      OPENCLAW_COMPOSE_USE_FLOCK: process.env.OPENCLAW_COMPOSE_USE_FLOCK || '0',
    },
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`ensure-openclaw-gateway-agent: compose failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

const legacy =
  String(process.env.OPENCLAW_LEGACY_AGENT_WRITE || '').trim() === '1' ||
  String(process.env.OPENCLAW_LEGACY_AGENT_WRITE || '').toLowerCase() === 'true';

const fragmentsDir = (process.env.OPENCLAW_FRAGMENTS_DIR || '/etc/ombot/openclaw.d').trim();
const agentsFragmentPath =
  (process.env.OPENCLAW_AGENTS_FRAGMENT_PATH || '').trim() ||
  path.join(fragmentsDir, '30-ombist-gateway-agent.json');
const useFragments =
  !legacy && fragmentsDir !== '' && fs.existsSync(fragmentsDir) && fs.statSync(fragmentsDir).isDirectory();

if (useFragments) {
  let j = {};
  if (fs.existsSync(agentsFragmentPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(agentsFragmentPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        j = parsed;
      }
    } catch (e) {
      console.error(`ensure-openclaw-gateway-agent: invalid fragment ${agentsFragmentPath}: ${e.message}`);
      process.exit(1);
    }
  }
  if (!j.agents || typeof j.agents !== 'object') j.agents = {};
  const added = mergeAgents(j);
  const out = { agents: j.agents };
  try {
    fs.writeFileSync(agentsFragmentPath, `${JSON.stringify(out, null, 2)}\n`);
  } catch (e) {
    const code = e && e.code;
    if (code === 'EACCES' || code === 'EPERM') {
      console.error(
        `ensure-openclaw-gateway-agent: cannot write fragment (not permitted): ${agentsFragmentPath}`
      );
      process.exit(1);
    }
    throw e;
  }
  console.log(
    `ensure-openclaw-gateway-agent: fragment ${agentsFragmentPath} agentId=${agentId} primary=${primary} added=${added}`
  );
  runCompose();
  process.exit(0);
}

const paths = [
  process.env.OPENCLAW_RUNTIME_CONFIG_PATH,
  process.env.OPENCLAW_CONFIG_PATH,
].filter((p) => typeof p === 'string' && p.trim() !== '');

const unique = [...new Set(paths.map((p) => p.trim()))];
if (unique.length === 0) {
  console.error('ensure-openclaw-gateway-agent: set OPENCLAW_RUNTIME_CONFIG_PATH and/or OPENCLAW_CONFIG_PATH');
  process.exit(1);
}

let wrotePaths = 0;
for (const cfgPath of unique) {
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (e) {
    console.error(`ensure-openclaw-gateway-agent: cannot read ${cfgPath}: ${e.message}`);
    process.exit(1);
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    console.error(`ensure-openclaw-gateway-agent: invalid JSON ${cfgPath}: ${e.message}`);
    process.exit(1);
  }
  const added = mergeAgents(j);
  const out = `${JSON.stringify(j, null, 2)}\n`;
  try {
    fs.writeFileSync(cfgPath, out);
  } catch (e) {
    const code = e && e.code;
    if (code === 'EACCES' || code === 'EPERM') {
      console.error(
        `ensure-openclaw-gateway-agent: skip write (not permitted): ${cfgPath} (${code})`
      );
      continue;
    }
    throw e;
  }
  wrotePaths += 1;
  console.log(
    `ensure-openclaw-gateway-agent: ${cfgPath} agentId=${agentId} primary=${primary} added=${added}`
  );
}

if (wrotePaths === 0) {
  console.error('ensure-openclaw-gateway-agent: no config file was writable');
  process.exit(1);
}
