# Contributing to eulr

## Requirements

- Node.js 22 or newer
- pnpm

## Local workflow

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run the TypeScript entry point during development with:

```bash
pnpm dev -- --help
pnpm dev -- --provider openai-compatible "inspect this repository"
```

Tests must not contact OAuth endpoints or live model services. Use a local HTTP
server for authentication and transport tests, and a scripted `ModelProvider`
for agent-loop tests.

## Design constraints

- Keep provider wire formats and credentials outside the agent core.
- Do not read credentials belonging to Codex CLI or another coding agent.
- Keep every file operation inside the active workspace, including through
  symbolic links.
- Preserve append-only session events and validate persisted data with Zod.
- Sanitize secrets before logging errors or debug information.
- Add focused tests for behavior and security boundaries changed by a patch.

## Codex protocol updates

Changes to the ChatGPT subscription adapter must be checked against current
official OpenAI documentation and a pinned revision of `openai/codex`. Update
[`docs/codex-protocol.md`](docs/codex-protocol.md) with the verified values and
revision. Never guess an endpoint, OAuth parameter, header, or event shape.
