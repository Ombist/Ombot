/**
 * OpenClaw Gateway `agent.params.agentId` — many installs have no literal `default` agent.
 * Substitute `OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID` / `OPENCLAW_BRIDGE_AGENT_ID` when the
 * upstream id is missing, blank, or placeholder `default`.
 */
export function resolveGatewayTurnAgentId(agentId) {
  const raw = agentId == null ? '' : String(agentId).trim();
  const env =
    String(process.env.OPENCLAW_BRIDGE_GATEWAY_DEFAULT_AGENT_ID || '').trim() ||
    String(process.env.OPENCLAW_BRIDGE_AGENT_ID || '').trim();
  if (env && (!raw || raw === 'default')) {
    return env;
  }
  if (raw) {
    return raw;
  }
  return env || 'default';
}
