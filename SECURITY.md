# Security Policy

Thank you for helping keep Folio and its users safe. This document explains
which versions receive security fixes, how to report a vulnerability privately,
what to expect after you report, and what is in scope.

## Supported versions

Folio is under active development. Security fixes are provided for the latest
released minor version. Once a new minor version ships, the previous one
receives critical fixes only for a short transition window.

| Version | Supported          |
| ------- | ------------------ |
| latest `0.x` (current) | Yes                |
| previous `0.x` minor   | Critical fixes only |
| older `0.x` releases   | No                 |

Pre-1.0 note: while Folio is on `0.x`, minor version bumps may include breaking
changes. We recommend always running the latest release to receive security
updates.

## Reporting a vulnerability

**Please do not open a public issue, discussion, or pull request for security
vulnerabilities.** Public disclosure before a fix is available puts users at
risk.

Report privately through either channel:

1. **GitHub private security advisories (preferred).** Go to the repository's
   **Security** tab and choose **Report a vulnerability**, or use
   [Security Advisories](https://github.com/owenpkent/folio/security/advisories/new).
   This keeps the report, discussion, and fix coordinated in one private place.
2. **Email.** Send details to **Owenpkent@gmail.com**. If you would like to send
   encrypted email, mention this in an initial message and we will arrange a key
   exchange.

Please include as much of the following as you can:

- A clear description of the issue and its impact.
- The Folio version and your operating system.
- Step-by-step reproduction instructions or a proof of concept.
- Any relevant logs, sample PDFs, or crash output (redact sensitive data).
- Whether the issue is already known or public anywhere.

## Response timeline

We aim to follow this schedule. Timelines are targets, not guarantees, for a
community-driven project:

| Milestone                     | Target                         |
| ----------------------------- | ------------------------------ |
| Acknowledge your report       | within 3 business days         |
| Initial assessment / triage   | within 7 business days         |
| Status updates                | at least every 7 days until resolved |
| Fix or mitigation for confirmed high-severity issues | as quickly as practical, typically within 90 days |

If you do not receive an acknowledgment within a few days, please send a polite
follow-up in case a message was missed.

## Coordinated disclosure policy

We follow coordinated disclosure:

- We will work with you to understand, confirm, and fix the issue.
- We ask that you give us reasonable time to release a fix before any public
  disclosure. We target a coordinated disclosure within **90 days** of the
  report, or sooner once a fix is released and users have had time to update.
- When a fix ships, we will publish a security advisory describing the issue and
  the fixed version.
- With your permission, we will credit you in the advisory. Let us know how you
  would like to be named, or if you prefer to remain anonymous.
- Please do not exploit a vulnerability beyond what is necessary to demonstrate
  it, and do not access, modify, or delete other users' data.

We appreciate good-faith security research and will not pursue or support legal
action against researchers who follow this policy.

## Scope

### In scope

- **The Folio desktop application** (the Tauri/Rust backend and the
  React/TypeScript frontend), including issues such as memory-safety bugs,
  sandbox or Tauri IPC escapes, path traversal, code execution via crafted PDF
  files, and unsafe handling of untrusted document content.
- **Plugin trust model.** Folio's plugin system is designed to be
  least-privilege. Vulnerabilities in the plugin host itself, for example a
  first-party plugin API that lets a plugin exceed its granted permissions,
  escape its sandbox, or access document data or the filesystem/network without
  consent, are in scope.
- **AI / MCP data-handling.** Folio's optional AI and
  [Model Context Protocol](https://modelcontextprotocol.io) integrations must
  only send document content or user data to external services with explicit
  user consent. Issues where AI/MCP features leak document data, transmit data
  without consent, mishandle credentials or API keys, or are vulnerable to
  prompt injection that causes unauthorized data access or actions are in scope.

### Out of scope

- **Third-party plugins** that are not maintained in this repository. Please
  report vulnerabilities in those to their respective maintainers. Folio's
  plugin trust model (in scope above) is about how the host contains plugins,
  not about the security of any individual third-party plugin.
- Vulnerabilities in upstream dependencies (for example PDF.js, Tauri, or the
  system WebView) that are already publicly known and tracked upstream. If you
  find a novel issue, report it upstream and let us know so we can update or
  mitigate.
- Issues that require a physical or already-privileged local attacker, or that
  depend on a compromised operating system.
- Social engineering, spam, and denial of service through resource exhaustion
  from intentionally abusive input, unless it leads to memory corruption or a
  broader security impact.

If you are unsure whether something is in scope, report it privately anyway and
we will help you figure it out. Thank you for keeping Folio users safe.
