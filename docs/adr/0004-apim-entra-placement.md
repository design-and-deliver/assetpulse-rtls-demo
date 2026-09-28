# ADR 0004 — Where APIM and Entra ID would sit

**Status:** Proposed (not built; the demo has no auth) · 2026-09-27

## Context

The demo's hospital id (`?h=`) is a sandbox key, not a secret, because there is nothing to
protect. A production RTLS feed carries PHI-adjacent location data and drives work orders, so
every socket must be authenticated and authorized to a specific hospital and role.

## Decision (for production)

```
browser / handheld ──MSAL──▶ Entra ID  (access token, aud = api://assetpulse)
        │
        └─ wss://api.<org>/assetpulse/ws?h=…   (token in Sec-WebSocket-Protocol or ?access_token=)
              │
         Azure API Management — WebSocket passthrough API
              │   onHandshake policy: validate-jwt (issuer, audience, roles),
              │   map a hospital claim to the allowed h, rate-limit handshakes
              ▼
         App Service (inbound access restricted to APIM)
```

- **Entra ID** issues tokens. The web console uses MSAL.js. The Expo handheld uses MSAL through
  `expo-auth-session`. App roles (`Ops`, `Tech`) replace the self-declared topics. The server
  subscribes a socket to `role:tech` only when the token has the `Tech` role.
- **APIM** fronts `/ws` as a **WebSocket passthrough API**. Policies run on the handshake, and
  after the upgrade frames pass through untouched. `validate-jwt` rejects a bad token before the
  app ever sees an upgrade. APIM is also where handshake rate limits, IP filtering, and a single
  public hostname for the REST APIs and the socket belong.
- **The app still re-checks.** It validates the token itself (defense in depth) and binds the
  socket to the hospital claim. APIM doesn't see frames after the upgrade, so per-command
  authorization (for example, whether this tech may `accept_wo`) has to live in the app.

## Consequences

- Tokens expire while sockets stay open. The server records the token's `exp`, closes the socket
  with an app code (for example, 4401) when it passes, and the client reconnects with a fresh
  token and resumes. The existing resume path makes that lossless.
- `?access_token=` in the URL gets written to logs. Prefer the subprotocol header, and scrub query
  strings from APIM and App Service logs.
