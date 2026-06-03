#!/usr/bin/env node
/**
 * Extended OpenClaw drift signals for ombot-admin gateway config-drift.
 * Args: envRaw cfgRaw sdRaw fragmentsDir ombotHome
 * Prints JSON object (merge into drift output).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { mergeOrderedFragments } from './openclaw-json-merge.mjs';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isHttpUrl(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  try {
    return Boolean(new URL(t).hostname);
  } catch {
    return false;
  }
}

function listFragmentFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json') && !n.startsWith('.') && !n.endsWith('.bak'))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => path.join(dir, n));
}

const [, , envRaw, cfgRaw, sdRaw, fragmentsDir, ombotHome] = process.argv;

const out = {
  fragmentsDir: fragmentsDir || '',
  fragmentHashes: /** @type {{ basename: string; sha256: string }[]} */ ([]),
  composedExpectedHash: '',
  runtimeOnDiskHash: '',
  composedMatchesRuntime: null,
  bridgeAgentIdMatch: null,
  llmSecretDuplicationWarning: false,
  authProfileKeyIsUrl: false,
};

try {
  if (fragmentsDir && fs.existsSync(fragmentsDir)) {
    const files = listFragmentFiles(fragmentsDir);
    const fragments = [];
    for (const fp of files) {
      const buf = fs.readFileSync(fp);
      out.fragmentHashes.push({ basename: path.basename(fp), sha256: sha256Hex(buf) });
      fragments.push(JSON.parse(buf.toString('utf8')));
    }
    const composed = mergeOrderedFragments(fragments);
    const body = Buffer.from(`${JSON.stringify(composed, null, 2)}\n`, 'utf8');
    out.composedExpectedHash = sha256Hex(body);
  }
} catch {
  out.fragmentComposeError = true;
}

try {
  if (cfgRaw && cfgRaw.length > 0) {
    out.runtimeOnDiskHash = sha256Hex(Buffer.from(cfgRaw, 'utf8'));
  }
} catch {
  /* ignore */
}

if (out.composedExpectedHash && out.runtimeOnDiskHash && out.fragmentHashes.length > 0) {
  out.composedMatchesRuntime = out.composedExpectedHash === out.runtimeOnDiskHash;
}

const readEnv = (raw, key) => {
  const lines = raw.split(/\r?\n/);
  for (const ln of lines) {
    const line = ln.trim();
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith(`${key}=`)) continue;
    return line.slice(key.length + 1).trim();
  }
  return '';
};

const bridgeId = readEnv(envRaw || '', 'OPENCLAW_BRIDGE_AGENT_ID').replace(/^["']|["']$/g, '');
try {
  const j = JSON.parse(cfgRaw || '{}');
  const list = j?.agents?.list;
  if (bridgeId && Array.isArray(list)) {
    out.bridgeAgentIdMatch = list.some((a) => a && String(a.id) === bridgeId);
  }
} catch {
  out.bridgeAgentIdMatch = null;
}

const openaiEnv = Boolean(readEnv(envRaw || '', 'OPENAI_API_KEY'));
if (ombotHome) {
  const authBase = path.join(ombotHome, '.openclaw/agents');
  try {
    if (fs.existsSync(authBase)) {
      for (const ent of fs.readdirSync(authBase, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const p = path.join(authBase, ent.name, 'agent', 'auth-profiles.json');
        if (!fs.existsSync(p)) continue;
        const store = JSON.parse(fs.readFileSync(p, 'utf8'));
        const profs = store?.profiles;
        if (profs && typeof profs === 'object') {
          for (const [profileId, prof] of Object.entries(profs)) {
            if (openaiEnv && String(profileId).toLowerCase().startsWith('openai')) {
              out.llmSecretDuplicationWarning = true;
            }
            const keyVal = prof && typeof prof === 'object' ? prof.key : '';
            if (isHttpUrl(keyVal)) {
              out.authProfileKeyIsUrl = true;
            }
          }
        }
        if (out.authProfileKeyIsUrl && (!openaiEnv || out.llmSecretDuplicationWarning)) break;
      }
    }
  } catch {
    /* ignore */
  }
}

process.stdout.write(JSON.stringify(out));
