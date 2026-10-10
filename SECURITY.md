# Security policy

Vigil at Home runs a root helper and can block programs on your Mac, so we take reports about it seriously.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Useful things to include:

- what an attacker could do, and what access they need first (a local user, a malicious file, a network position)
- the Vigil version or commit, and your macOS version and chip
- steps or a proof of concept

We aim to reply within a week, and we'll tell you when a fix is released. Once it is, we're happy to credit you unless you'd rather stay anonymous.

## Supported versions

Vigil at Home is in alpha. Only the latest release and `main` get security fixes.

## Trusted local boundaries

Two places trust every process running as your user. Both are deliberate; they
are written down so the choice is visible rather than accidental.

- **The agent socket** (`run/agent.sock` in the app's data folder) serves
  Claude Code's pre-flight hook and, when you turn them on, Vigil's read-only
  tools for your own agents: redacted alerts, events and agent sessions. The
  folder it lives in is `0700` and the socket itself `0600`, both owned by your
  user; Vigil also watches the socket for tampering, and tool calls are capped
  per connection (120 a minute by default). Any process running as you can
  still open it. That is accepted on purpose: such a process could read Vigil's
  SQLite database directly anyway, so the socket grants nothing your user
  account does not already reach. See [docs/agents.md](docs/agents.md).
- **The app window's CSP allows inline styles** (`style-src 'unsafe-inline'`,
  set in `apps/desktop/src/renderer/index.html`), because theming works by
  writing style tokens straight onto the root element. Scripts stay locked to
  `'self'`, and the window is sandboxed with context isolation, so even markup
  the renderer shouldn't show cannot reach Node or Vigil's privileged IPC.
  Converting to nonces or hashes would complicate dynamic theming for no
  measurable risk reduction, so this is accepted rather than fixed. If
  `script-src` ever needs to loosen, revisit this decision first.

## In scope

- the privileged helper (`packages/helper`, installed under `/Library/PrivilegedHelperTools`), its socket and its command list
- ways to get a block lifted, an allow rule added or a detection rule changed without the user's approval
- ways for event data, alert text or AI output to reach anything other than Vigil's read-only tools
- the Santa sync server, the osquery configuration and the app's IPC
- the agent socket (`run/agent.sock` in the app's data folder) that Claude Code's pre-flight hook asks. Only your account can reach it, and it is read-only: it answers deny, ask or nothing, never allow, and changes no rule, setting or block. Anything that makes it do more, or makes the hook (`vigil-hook.mjs`) read file contents or send what a tool would write, is in scope. See [docs/agents.md](docs/agents.md)
- Vigil's tools for your own agents (the same socket, through `vigil-hook.mjs mcp`). They are opt-in, off by default and read-only: they return redacted alerts, events and agent sessions, refuse every call while off, and never show a rule's conditions. Anything that makes them change something, answer while off, return data unredacted or reveal how a rule matches is in scope
- leaks of API keys that Vigil stores in the Keychain

Bugs in Santa, osquery, Electron, Claude Code, Codex or Ollama belong with those projects. Tell us too if Vigil makes one of them worse.
