# Codex subscription protocol notes

`eulr` implements the ChatGPT subscription transport in an isolated auth and
provider adapter. It does not read Codex CLI credentials and it does not invoke
Codex CLI.

## Provenance

The protocol values below were verified on 2026-07-14 against the official
`openai/codex` repository at commit
[`5bed6447998c754d154dbd796517310b8f04d4ce`](https://github.com/openai/codex/commit/5bed6447998c754d154dbd796517310b8f04d4ce).
That source baseline corresponds to the official `rust-v0.144.4` release. The
provider therefore defines `CODEX_PROTOCOL_COMPATIBILITY_VERSION` as `0.144.4`.
This value tracks Codex protocol compatibility and is intentionally independent
from the eulr package version.
The public authentication documentation is at
[`developers.openai.com/codex/auth`](https://developers.openai.com/codex/auth).

The public documentation describes the user-facing browser and device flows.
Exact endpoints, query parameters, token shapes, inference headers, SSE events,
and the model catalog endpoint are derived from the pinned official source.
They are not a stable public API contract and may change.

## Browser authorization

The current flow is OAuth Authorization Code with PKCE S256:

- Issuer: `https://auth.openai.com`
- Public client ID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Authorization endpoint: `https://auth.openai.com/oauth/authorize`
- Token endpoint: `https://auth.openai.com/oauth/token`
- Scope: `openid profile email offline_access api.connectors.read api.connectors.invoke`
- Callback: `http://localhost:1455/auth/callback`, then registered fallback port
  `1457`
- Listener binding: `127.0.0.1` only

`state` is 32 cryptographically random bytes encoded as unpadded base64url. The
PKCE verifier is 64 random bytes encoded the same way; the challenge is the
unpadded base64url SHA-256 digest of the verifier.

The authorization query also includes `response_type=code`,
`code_challenge_method=S256`, `id_token_add_organizations=true`, and
`codex_cli_simplified_flow=true`. Codex CLI sends `originator=codex_cli_rs`.
`eulr` deliberately sends `originator=eulr` and does not impersonate the
official client.

The callback validates `state` before accepting the authorization code. A
callback with the wrong state receives HTTP 400 while the temporary server
continues waiting for the valid callback, cancellation, or timeout. Code
exchange uses an `application/x-www-form-urlencoded` body containing
`grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, and
`code_verifier`. Tokens and authorization codes are never printed.

The official implementation has no browser callback timeout. `eulr` adds a
ten-minute timeout as a local safety policy and supports cancellation with an
`AbortSignal`.

## Device authorization

Device authorization is a beta feature and must be enabled for the account or
workspace. The current source uses a Codex-specific bridge rather than the
standard RFC 8628 wire format:

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode` with JSON
   `{ "client_id": "..." }`.
2. Show `https://auth.openai.com/codex/device` and the returned user code.
3. Poll `POST https://auth.openai.com/api/accounts/deviceauth/token` with the
   returned `device_auth_id` and `user_code`.
4. Treat HTTP 403 and 404 as pending, waiting for the server-provided interval.
5. On success, exchange `authorization_code` with the returned PKCE verifier
   and redirect URI `https://auth.openai.com/deviceauth/callback`.

Polling stops after fifteen minutes or when cancelled. An initial HTTP 404 is
reported as device authorization not being enabled.

## Credentials and refresh

Credentials are stored only in `~/.eulr/auth.json`, grouped by provider ID.
On POSIX, `~/.eulr` is mode `0700` and the auth file is mode `0600`. Updates use
an atomic temporary-file rename.

The ChatGPT access token is sent as a bearer token. JWT payload decoding is used
only to obtain expiry and routing metadata; `eulr` does not treat locally
decoded, unverified claims as proof of identity. The current namespaced ID-token
claim `https://api.openai.com/auth` contains `chatgpt_account_id`, plan data,
and the FedRAMP flag.

An access token is refreshed within five minutes of its `exp`. If no usable
`exp` exists, the source-compatible fallback refresh interval is eight days.
Refresh uses JSON at the token endpoint:

```json
{
  "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "..."
}
```

Only one refresh is in flight per `AuthService`; a lock file also serializes
refresh and credential mutation across eulr processes sharing the same auth
file. Cancellation is isolated per caller, and the transport is aborted when
no refresh caller remains. Optional response fields retain their previous
values. HTTP 401 and the errors `refresh_token_expired`,
`refresh_token_reused`, and `refresh_token_invalidated` require a new login.

## Inference transport

The ChatGPT Codex base URL is `https://chatgpt.com/backend-api/codex`. `eulr`
uses the verified HTTP SSE fallback:

- Responses: `POST /responses`
- Models: `GET /models?client_version=<codex-protocol-compatibility-version>`
- Authorization: `Bearer <ChatGPT access token>`
- Routing: `ChatGPT-Account-ID: <chatgpt_account_id>`
- Optional FedRAMP routing: `X-OpenAI-Fedramp: true`

The current official client prefers a Responses WebSocket transport. HTTP SSE
remains implemented as its fallback and is the deliberately smaller transport
used by eulr v1. `eulr` identifies itself with `originator: eulr`.

The request uses the Responses API item shapes for messages, function calls,
and function outputs. Function definitions are top-level
`{ type, name, description, strict, parameters }` objects, not the nested Chat
Completions tool shape. Requests set `store=false`, `stream=true`,
`tool_choice=auto`, and include encrypted reasoning content when available.

The adapter normalizes text, reasoning status, function calls, token usage, and
completion into provider-independent `ModelEvent` values. Opaque encrypted
reasoning items are stored as JSON-only provider items and returned in their
original output order on the next stateless tool-call turn. A stream that closes
before `response.completed`, or a tool call whose final arguments disagree with
its streamed arguments, is rejected. Network and 5xx failures receive a small,
bounded retry before any streamed output; a 401 triggers one credential refresh.
There is no automatic fallback from subscription access to API billing.

## Model catalog

The authenticated `/models` response is authoritative for the current account
and rollout. Its wire shape is a top-level `{ "models": [...] }` object. `eulr`
maps each model `slug` to its internal ID, returns only `visibility=list` entries
whose `minimal_client_version` is compatible with the Codex protocol version,
and orders them by ascending priority. A successful catalog is retained in
memory; a later refresh failure keeps that snapshot and emits a sanitized
warning. With no snapshot, an explicitly configured model remains selectable
after a provider-level catalog failure and is accompanied by the same warning.
Authentication and account-selection failures remain errors.

The model list bundled in Codex source is only an offline fallback for the
official client, not a statement of account entitlement, so eulr does not
hardcode it.

## Verification boundary

Automated tests cover PKCE, callback state, cancellation and timeout, device
polling, refresh concurrency, credential permissions, request adaptation, SSE
normalization, 401 refresh, retry limits, and secret redaction without contacting
OpenAI. A real browser authorization and live inference request still require a
user account and explicit interactive authentication.
