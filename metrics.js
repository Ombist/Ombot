import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const activeClientConnections = new client.Gauge({
  name: 'ombot_active_client_connections',
  help: 'Active websocket client connections',
  registers: [register],
});

export const relayErrorsTotal = new client.Counter({
  name: 'ombot_relay_errors_total',
  help: 'Total relay and protocol errors',
  registers: [register],
});

export const middlewareDisconnectsTotal = new client.Counter({
  name: 'ombot_middleware_disconnects_total',
  help: 'Total middleware disconnect events',
  registers: [register],
});

export const encryptedMessagesTotal = new client.Counter({
  name: 'ombot_encrypted_messages_total',
  help: 'Total encrypted messages relayed',
  registers: [register],
});

export const signatureVerifyFailTotal = new client.Counter({
  name: 'ombot_signature_verify_fail_total',
  help: 'Total client signature verification failures',
  registers: [register],
});

export const replayRejectTotal = new client.Counter({
  name: 'ombot_replay_reject_total',
  help: 'Total replay-protection rejections',
  registers: [register],
});

export const protocolMismatchTotal = new client.Counter({
  name: 'ombot_protocol_mismatch_total',
  help: 'Total protocol version mismatch rejections',
  registers: [register],
});

export const capabilityRejectTotal = new client.Counter({
  name: 'ombot_capability_reject_total',
  help: 'Total capability requirement rejections',
  registers: [register],
});

export const gatewayLoopbackReachable = new client.Gauge({
  name: 'ombot_gateway_loopback_reachable',
  help: 'OpenClaw gateway loopback TCP reachable (1) or not (0)',
  registers: [register],
});

export const gatewayBridgeConnectState = new client.Gauge({
  name: 'ombot_gateway_bridge_connected',
  help: 'OpenClaw gateway bridge connected (1) or not (0)',
  registers: [register],
});

export const gatewayBridgeErrorsTotal = new client.Counter({
  name: 'ombot_gateway_bridge_errors_total',
  help: 'Total gateway bridge protocol or I/O errors',
  registers: [register],
});

export const gatewayBridgePhoneToGatewayTotal = new client.Counter({
  name: 'ombot_gateway_bridge_phone_to_gateway_total',
  help: 'User messages forwarded from Phone decrypt path to OpenClaw gateway',
  registers: [register],
});

export const gatewayBridgeGatewayToPhoneTotal = new client.Counter({
  name: 'ombot_gateway_bridge_gateway_to_phone_total',
  help: 'Assistant replies forwarded from gateway to Phone encrypt path',
  registers: [register],
});

export const gatewayBridgeRejectTotal = new client.Counter({
  name: 'ombot_gateway_bridge_reject_total',
  help: 'Gateway rejections by phase/category/reason',
  labelNames: ['phase', 'category', 'reason'],
  registers: [register],
});

export const gatewayBridgeGateState = new client.Gauge({
  name: 'ombot_gateway_bridge_gate_state',
  help: 'Gateway health gate state (1 pass, 0 fail, -1 unknown)',
  labelNames: ['gate'],
  registers: [register],
});

export const gatewayBridgeFallbackTotal = new client.Counter({
  name: 'ombot_gateway_bridge_fallback_total',
  help: 'Fallback turns sent when gateway path degraded',
  labelNames: ['source', 'reason'],
  registers: [register],
});

export async function metricsText() {
  return register.metrics();
}
