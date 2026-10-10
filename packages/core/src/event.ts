import { z } from 'zod';
import { AgentId, Id, ProcessRef, Timestamp } from './common.js';

/** Where an event came from. */
export const EventSource = z.enum(['osquery', 'santa', 'vigil', 'test', 'kernel-monitor']);
export type EventSource = z.infer<typeof EventSource>;

const base = {
  id: Id,
  /** When the activity happened on the machine (not when Vigil received it). */
  ts: Timestamp,
  source: EventSource,
  /** The sensor's original record, kept for investigation. Never interpreted by rules. */
  raw: z.unknown().optional(),
};

export const ProcessExecEvent = z.object({
  ...base,
  kind: z.literal('process.exec'),
  process: ProcessRef,
});

export const ProcessExitEvent = z.object({
  ...base,
  kind: z.literal('process.exit'),
  process: ProcessRef,
  exitCode: z.number().int().optional(),
});

export const FileOp = z.enum(['create', 'write', 'rename', 'delete', 'open']);
export type FileOp = z.infer<typeof FileOp>;

export const FileEvent = z.object({
  ...base,
  kind: z.literal('file'),
  op: FileOp,
  path: z.string(),
  /** Destination for renames. */
  newPath: z.string().optional(),
  sha256: z.string().optional(),
  process: ProcessRef.optional(),
});

export const NetworkConnectionEvent = z.object({
  ...base,
  kind: z.literal('network.connection'),
  direction: z.enum(['outbound', 'inbound']),
  protocol: z.enum(['tcp', 'udp', 'other']),
  localAddress: z.string().optional(),
  localPort: z.number().int().optional(),
  remoteAddress: z.string(),
  remotePort: z.number().int().optional(),
  /** Resolved name when the sensor knows it. */
  remoteHost: z.string().optional(),
  process: ProcessRef.optional(),
});

/**
 * A launch agent, launch daemon, login item or similar was added or changed.
 * On Linux: a systemd unit or XDG autostart entry outside the package
 * manager's folders.
 */
export const PersistenceEvent = z.object({
  ...base,
  kind: z.literal('persistence'),
  change: z.enum(['added', 'modified', 'removed']),
  mechanism: z.enum([
    'launch_agent',
    'launch_daemon',
    'login_item',
    'cron',
    'shell_profile',
    'systemd_unit',
    'autostart',
    'other',
  ]),
  path: z.string(),
  /** launchd label, when the item has one. */
  label: z.string().optional(),
  /** Program the item runs, when known. */
  program: z.string().optional(),
  programArgs: z.array(z.string()).optional(),
  process: ProcessRef.optional(),
});

/** Santa allowed or blocked a launch, or a protected-file access. */
export const SantaDecisionEvent = z.object({
  ...base,
  kind: z.literal('santa.decision'),
  target: z.enum(['execution', 'file_access']),
  decision: z.enum(['allow', 'block', 'audit_only']),
  /** Santa's own reason, e.g. BLOCK_BINARY, ALLOW_CERTIFICATE, BLOCK_UNKNOWN. */
  reason: z.string(),
  /** For file_access: the protected path that was touched. */
  path: z.string().optional(),
  process: ProcessRef,
});

/** A process started listening on a port (a backdoor opening a door). */
export const NetworkListenEvent = z.object({
  ...base,
  kind: z.literal('network.listen'),
  protocol: z.enum(['tcp', 'udp', 'other']),
  localAddress: z.string().optional(),
  localPort: z.number().int(),
  process: ProcessRef.optional(),
});

/** A browser extension was installed, updated or removed. */
export const BrowserExtensionEvent = z.object({
  ...base,
  kind: z.literal('browser.extension'),
  change: z.enum(['added', 'modified', 'removed']),
  browser: z.string(),
  extensionId: z.string(),
  name: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

/** macOS's own security notices: XProtect hits, TCC permission changes, Gatekeeper overrides. */
export const SystemAlertEvent = z.object({
  ...base,
  kind: z.literal('system.alert'),
  subtype: z.enum(['xprotect_detected', 'tcc_modified', 'gatekeeper_override']),
  path: z.string().optional(),
  sha256: z.string().optional(),
  process: ProcessRef.optional(),
  /** Subtype-specific fields, e.g. malware name, TCC service and right. */
  details: z.record(z.string(), z.string()).default({}),
});

/**
 * An AI agent asked to run a tool (Claude Code's PreToolUse hook). Vigil checks
 * it against rules before the tool runs. Nothing has happened yet, so no real
 * process exists: write content arrives only as its size and hash.
 */
export const AgentToolRequestEvent = z.object({
  ...base,
  kind: z.literal('agent.tool_request'),
  /** The agent's tool name, e.g. Bash, Write, WebFetch or mcp__server__tool. */
  tool: z.string().max(128),
  command: z.string().max(4096).optional(),
  /** Size of the full command; it may be longer than the part in `command`. */
  commandBytes: z.number().int().nonnegative().optional(),
  /** Set by Vigil when `command` is only the start of the command (the hook keeps 4,096 characters). */
  commandClipped: z.literal(true).optional(),
  /**
   * Absolute; the hook has already resolved `..` against `cwd` and followed
   * links, and Vigil writes it the way rules do (`/var`, not `/private/var`).
   */
  filePath: z.string().max(1024).optional(),
  /** The path as the hook sent it, when that differs from `filePath`. For display only. */
  filePathGiven: z.string().max(1024).optional(),
  url: z.string().max(2048).optional(),
  /** For mcp__<server>__<tool> tools. */
  mcpServer: z.string().max(128).optional(),
  cwd: z.string().max(1024).optional(),
  contentBytes: z.number().int().nonnegative().optional(),
  contentSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  agent: z.object({
    host: z.enum(['claude-code']),
    id: AgentId.optional(),
    /** Vigil's session for the agent, when the tracker knows the hook's parent. */
    session: z.string().max(32).optional(),
    /** The host's own session id. */
    hookSession: z.string().max(128).optional(),
  }),
  /** Bash only: the would-be shell. Never a real process. */
  process: ProcessRef.extend({ pid: z.literal(0) }).optional(),
});
export type AgentToolRequestEvent = z.infer<typeof AgentToolRequestEvent>;

/**
 * The kernel-monitor daemon's identity fields, shared by its kinds (the
 * spec's kernel base): two clocks — `at`, the wall time the daemon anchored
 * the event to, and `monoNs`, the monotonic stamp it orders by — plus the
 * acting task. `id` and `ts` are the union's storage contract (the events
 * table's primary key and time column), filled by the sensor's parser, not
 * by the daemon.
 */
const kernelBase = {
  id: Id,
  ts: Timestamp,
  source: z.literal('kernel-monitor'),
  at: z.string(),
  monoNs: z.number().int(),
  tgid: z.number().int(),
  uid: z.number().int(),
  comm: z.string().max(16),
  /** The daemon's original index line, kept for investigation. */
  raw: z.unknown().optional(),
};

/** A task changed its credentials: the setuid family, capset, a sudo step. */
export const PrivilegeChangeEvent = z.object({
  ...kernelBase,
  kind: z.literal('privilege.change'),
  fromUid: z.number().int(),
  toUid: z.number().int(),
  caps: z.array(z.string()).optional(),
});
export type PrivilegeChangeEvent = z.infer<typeof PrivilegeChangeEvent>;

/** A kernel module was loaded or unloaded. */
export const KernelModuleEvent = z.object({
  ...kernelBase,
  kind: z.literal('kernel.module'),
  module: z.string(),
  op: z.enum(['load', 'unload']),
});
export type KernelModuleEvent = z.infer<typeof KernelModuleEvent>;

/** The monitor's own heartbeat: drop counters, the hooks it attached, and whether it had to fall back. */
export const MonitorHealthEvent = z.object({
  ...kernelBase,
  kind: z.literal('monitor.health'),
  droppedTotal: z.number().int(),
  hooks: z.array(z.string()),
  degraded: z.boolean(),
});
export type MonitorHealthEvent = z.infer<typeof MonitorHealthEvent>;

export const SensorEvent = z.discriminatedUnion('kind', [
  ProcessExecEvent,
  ProcessExitEvent,
  FileEvent,
  NetworkConnectionEvent,
  PersistenceEvent,
  SantaDecisionEvent,
  NetworkListenEvent,
  BrowserExtensionEvent,
  SystemAlertEvent,
  AgentToolRequestEvent,
  PrivilegeChangeEvent,
  KernelModuleEvent,
  MonitorHealthEvent,
]);
export type SensorEvent = z.infer<typeof SensorEvent>;
export type EventKind = SensorEvent['kind'];
export const EventKind = z.enum([
  'process.exec',
  'process.exit',
  'file',
  'network.connection',
  'persistence',
  'santa.decision',
  'network.listen',
  'browser.extension',
  'system.alert',
  'agent.tool_request',
  'privilege.change',
  'kernel.module',
  'monitor.health',
]);

export type EventOfKind<K extends EventKind> = Extract<SensorEvent, { kind: K }>;
