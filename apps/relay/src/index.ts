/** The wire contract, from @vigil/core — this package deploys it, it does not redefine it. */
export {
  AlertBody,
  Cursor,
  EventBody,
  IngestAck,
  IngestRequest,
  MAX_BATCH_RECORDS,
  ShipRecord,
} from '@vigil/core';
export { DeviceId } from './store.js';
export { newToken, tokenHash, type TokenKind } from './tokens.js';
export { RELAY_DEFAULTS, resolveConfig, type RelayConfig } from './config.js';
export { RelayStore, type BatchOutcome, type DevicePosition, type RelayStats } from './store.js';
export { handleIngest, bearerToken, INGEST_PATH, sendJson, type IngestContext } from './ingest.js';
export { KeyedBuckets } from './ratelimit.js';
export { Retainer, type RetainRun, type RetentionLimits } from './retention.js';
export { startRelay, type RelayServer } from './server.js';
export {
  buildRelayMcpServer,
  relayMcpHandler,
  parseSince,
  fit,
  RELAY_NAME,
  RELAY_VERSION,
  UNTRUSTED,
  RELAY_EVENT_GROUPS,
  RelayEventGroup,
  MAX_ROWS,
  MAX_RESULT_BYTES,
  EVENT_DAYS,
  MAX_TEXT_CHARS,
  TOOL_CALLS_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  MAX_REQUEST_BYTES,
  type RelayMcpOptions,
  type RelayMcpStore,
  type RelayMcpResponder,
  type RelayEventRow,
  type RelayAlertRow,
  type RelayActionRow,
  type RelayRuleRow,
  type RelayDeviceFacts,
  type RelayStatusFacts,
  type VerifySocToken,
} from './mcp.js';
