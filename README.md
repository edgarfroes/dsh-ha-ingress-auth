# dsh-ha-ingress-auth

Home Assistant ingress as the user and role layer for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh),
shipped as a Home Assistant app.

- One `dsh web` process per Home Assistant user: private chats, workspaces,
  approvals and General preferences.
- Home Assistant administrators get everything; users get Settings → General
  only, the admins' models and presets, and no shell or file tools.
- No dsh fork or patch. Everything goes through documented dsh extension
  points, with one flagged exception (see [Design](#design)).

User documentation: [app/dsh_ha_ingress_auth/DOCS.md](app/dsh_ha_ingress_auth/DOCS.md).

## Install (Home Assistant)

Add this repository in **Settings → Apps → App store → ⋮ → Repositories**,
install **DeepSeek Harness**, start it and turn on **Show in sidebar**.

Until the gateway is published to npm, build the app context from a checkout
first (`npm ci && npm run app:context`), because Home Assistant builds an app
from its own folder only.

## Layout

```
src/plugin/host.js        dsh host plugin loaded into every per-user process
src/gateway/              the ingress gateway (Node, no framework)
  cli.js                    entry point of the app
  server.js                 identity, role, forwarding
  roles.js                  HA users over Core's WebSocket (config/auth/list)
  children.js               one dsh process per user (uid, env, lifecycle)
  shared-config.js          admin settings shared across processes
  overlays.js               the --patch overlay each process boots with
  proxy.js                  HTTP/WebSocket forwarding and request policy
app/dsh_ha_ingress_auth/  the Home Assistant app (config.yaml, Dockerfile, DOCS.md)
e2e/                      fake-ingress stack (compose) + Playwright suite
test/unit/                node:test unit tests
```

## Design

| Need | How |
|---|---|
| Who is this? | Supervisor sets `X-Remote-User-Id` on ingress requests and drops any copy the browser sends. The gateway trusts it only on connections from Supervisor's ingress address (`172.30.32.2`). |
| Admin or not? | Core's `config/auth/list` over `ws://supervisor/core/websocket` (`homeassistant_api: true`). Admin = member of `system-admin`; user = `system-users`; anyone else is refused. |
| Private chats | Each user gets their own `dsh web` (own `DSH_HOME`, working directory and Unix uid) bound to `127.0.0.1`. dsh has a single operator per process, so a process per user is the separation. |
| Browser credentials | The gateway follows the child's launch URL (`connection.authenticatedUrl()`, written by the host plugin) and keeps the dsh cookie server-side. The browser only ever holds Home Assistant's own session. |
| Admin-only screens | The non-admin overlay disables the rows that provide them (`disabled: true`, the mechanism dsh's own bundle uses). The Agent presets section ships in the same plugin as the preset picker, so for users it is hidden by an index `style` row. |
| Shared admin settings | dsh saves Settings into the process's profile patch. The gateway copies admin rows between admins (holding dsh's own profile writer lock) and writes them as the non-admin processes' home patch, which dsh ranks above the profile patch and refuses to override. |
| Per-user preferences | Rows `ui-theme`, `locale`, `ui-chat`, `ui-conversation`, `ui-settings-general`, `ui-settings` stay in each user's own profile patch. |
| API keys for users | Passed as environment to user processes (dsh's environment credential layer, read-only in the UI). Users get no shell or file tools (`ctx.tools.guard` allow-list), no terminal, and `api/file` is limited to their own folder. |
| Settings behind a proxy | dsh disables Settings persistence on non-loopback pages. The host plugin sets `__DSH_TRANSPORT__.ownsHost` through an index `global` row. **This field is documented as shell-only**: it is the one deviation, tracked upstream in deepseek-harness discussion #5829. |
| HA ingress query re-encoding | Supervisor/Core forward queries as parsed parameters; dsh's combined plugin URLs (`plugins/??a,b`) come back as `??a,b=`. The gateway restores them. |

## Develop

```sh
npm ci
npm test          # unit tests
npm run e2e       # builds the app image and runs the fake-ingress suite in Docker
```

The E2E stack (`e2e/compose.yaml`) puts the real app image behind a stand-in
for Supervisor ingress at `172.30.32.2`, with a synthetic Home Assistant user
list and a stub OpenAI-compatible model, so it spends no tokens and needs no
Home Assistant.

## Versions

- `@deepseek-ai/dsh` **0.1.7-alpha.2**, exact, via
  `app/dsh_ha_ingress_auth/runtime/package-lock.json`. 0.1.7-alpha.1 is the
  first dsh that can be served under an ingress sub-path.
- `@earendil-works/pi-ai` **0.87.1** through npm `overrides` (dsh pins
  `^0.85.1`). pi-ai 0.86+ sends the `x-opencode-session` header OpenCode Go and
  Zen require; without it every opencode request fails with `MissingSessionID`.
  Remove the override once dsh depends on pi-ai ≥ 0.86.
- Base image `node:22.23.2-bookworm-slim`, pinned by digest.

## License

MIT
