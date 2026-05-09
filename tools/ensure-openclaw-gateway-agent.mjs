#!/usr/bin/env node
/**
 * Ensures OpenClaw JSON has an `agents.list` entry matching Ombot's bridge agent id
 * (so Gateway accepts `agent` turns without "unknown agent id").
 *
 * Prefer updating only `OPENCLAW_RUNTIME_CONFIG_PATH` (ombot-owned); provision copies to
 * `/etc/ombot/openclaw.json` with `as_root cp`. Writable-only paths are typical; if `/etc` is
 * passed without permission, that write is skipped when at least one path was updated.
 *
 * Env:
 *   OMBIST_GATEWAY_AGENT_ID — agent id to ensure (default: default)
 *   OMBIST_GATEWAY_AGENT_MODEL — model.primary string (default: gpt-4o-mini)
 *   OPENCLAW_RUNTIME_CONFIG_PATH, OPENCLAW_CONFIG_PATH — each non-empty path is updated (deduped)
 */
import fs from 'fs';

const agentId = (process.env.OMBIST_GATEWAY_AGENT_ID || 'default').trim() || 'default';
const primary = (process.env.OMBIST_GATEWAY_AGENT_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
const paths = [
  process.env.OPENCLAW_RUNTIME_CONFIG_PATH,
  process.env.OPENCLAW_CONFIG_PATH,
].filter((p) => typeof p === 'string' && p.trim() !== '');

const unique = [...new Set(paths.map((p) => p.trim()))];
if (unique.length === 0) {
  console.error('ensure-openclaw-gateway-agent: set OPENCLAW_RUNTIME_CONFIG_PATH and/or OPENCLAW_CONFIG_PATH');
  process.exit(1);
}

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
