---
name: feltkit-services
description: Configure, use, and troubleshoot AppPort Services in a FeltKit application — files, notifications, configuration and secrets, API keys, webhooks, jobs, schedules, intelligence. Use when the user wants to enable a service, send a notification, enqueue background work, emit or debug a webhook, issue or revoke an API key, set a configuration variable or secret, or asks why a job or delivery failed.
---

# FeltKit: services

Services are AppPort Services running on the application's own FeltDB instance. Every service effect is
authorized by AppPort Services' gateway with the application's roles, as the caller. **This skill grants no
permission and stores no secret.**

## Enable a service

```ts
// feltkit/app.ts
export const app = feltkit({
  name: "shop",
  roles: { admin: ["*"], ops: ["jobs.*", "webhooks.*", "orders.*"] },
  services: {
    files: true,
    notifications: { types: ["invoice.overdue"] }, // or true; declared types are offered in Studio
    configuration: true,
    apiKeys: { roles: ["machine"] },          // requests with an API key hold these roles
    webhooks: { events: ["invoice.sent"] },   // or true; declared events are offered when registering an endpoint
    jobs: { handlers: { "invoice.send": "billing:sendInvoice" } }, // job type → "<module>:<function>"
    schedules: true,                          // needs jobs
    intelligence: true,                       // the environment's model; agent decisions use it (feltkit model set)
  },
});
```

The permission for each operation is its AppPort Services capability name (`jobs.create`, `webhooks.register`,
`apikeys.create`, `configuration.write`, `credential.attach`, `credential.store`, `intelligence.write`, …). Grant them to roles like any permission.

## Use a service from a function

```ts
export const checkout = app.mutation({
  access: "orders.write",
  args: { orderId: s.string() },
  handler: async (ctx, { orderId }) => {
    ctx.afterCommit.jobs.enqueue("invoice.send", { orderId });             // runs later, as this caller, if this commits
    ctx.afterCommit.webhooks.emit("order.paid", { orderId });              // to subscribed endpoints, if this commits
    ctx.afterCommit.notifications.send({ recipient: "ada", type: "order", title: "Paid" });
    const region = await ctx.services.configuration.get("REGION");
    return { region };
  },
});
```

**Jobs run as whoever queued them, re-authorized each attempt:** that principal needs `jobs.create` to queue and
`jobs.execute` for the run, plus the job mutation's own `access`. In tests, `t.as(...)` callers are signed in like
production callers; `runServices()` returns `failed: { jobs, deliveries }` beside the attempt counts.

**Service calls inside functions run as the caller.** Every role that can reach a function needs the service
permissions that function uses: if `checkout` reads `configuration.get`, every role that calls `checkout` needs
`configuration.read`. A refusal says so: `orders:checkout called configuration.get as grace (roles: clerk), which does
not grant configuration.read`, with the file to change (`feltkit/app.ts`, roles).

Service effects commit on their own: they are not part of the mutation's transaction. A notification or webhook
sent from `ctx.services` stays sent if the mutation later fails at commit (`CONFLICT`). For effects that announce the
mutation's change, use `ctx.afterCommit`:

```ts
ctx.afterCommit.notifications.send({ recipient: "ada", type: "order", title: "Paid" }); // only if this commits
ctx.afterCommit.webhooks.emit("order.paid", { orderId });
ctx.afterCommit.jobs.enqueue("invoice.send", { orderId });
```

Each is recorded in the mutation's transaction (`_feltkit_outbox`) and performed after the commit, as the caller.
If the process stops in between, the services worker performs it later. A job or webhook delivery is created in
the transaction that marks the effect done, so it exists once per committed effect; notifications are deduplicated
by their idempotency key. Running the job and delivering the webhook are retried by the services (at least once). A failed effect stays `failed` with
its error until an operator retries it: `npx feltkit outbox list --state failed`, `npx feltkit outbox retry <id>`.
The same holds in an AppBoundry artifact (AppBoundry 1.5.0 or later).

## Configure a service

Configuration happens in AppPort Services' own pages, opened from FeltKit Studio: **Services → Manage**, acting as a
declared dev identity (development only). Those pages are the package's; FeltKit only signs you in. Do not write a
second configuration form or store settings elsewhere.

**Secrets and API keys for providers.** Services and configuration store only references: `credential-ref:<id>`.
The value is kept by FeltKit's credential custody, never in FeltDB, configuration, code, or a commit:

- `FELTKIT_CREDENTIAL_<ID>` (non-alphanumerics → `_`, upper-cased) wins when it is set; that reference is then
  read-only in Studio. Example: `credential-ref:stripe-signing` → `FELTKIT_CREDENTIAL_STRIPE_SIGNING`.
- Otherwise, in development and test, the local encrypted vault `.feltkit/<env>/credentials.vault` (AES-256-GCM,
  key in `.feltkit/<env>/credentials.key`, both 0600, gitignored, never in a build or deploy).
- Production uses environment variables only; storing a value there fails with `CUSTODY_READ_ONLY` unless the
  operator opted in with `FELTKIT_CREDENTIAL_VAULT=1` and `FELTKIT_CREDENTIAL_VAULT_KEY` (32 bytes from their
  secret manager).

Where a person enters a key (it goes through AppPort Services' `credential.store`, authorized as them, audited
without the value, and is never shown again): **Studio → Models** (API key field next to provider and model),
**Studio → Integrations → Set key**, **Studio → Services → Credentials** (set, replace, remove), or on the host
`npx feltkit credential set <provider|credential-ref:id>` (hidden prompt, or piped on stdin) and
`npx feltkit model set --provider … --model … --api-key-stdin`. `npx feltkit credential status` lists every
reference, what uses it, whether it is set, where, and its version.

As an agent: **never ask the user to paste a key into the chat, and never put one in a command line, a file, a
configuration variable, or a reply.** Tell them where to enter it (the Models screen, or `feltkit credential set`
in their own terminal). If a key appears in the conversation anyway, do not repeat it; tell the user to rotate it.
A value in a reference field is refused by Studio and the server. Storing needs the `credential.store` permission
(the starter's `admin` role grants `credential.*`).

**API keys** are shown once when created (or rotated). FeltKit accepts them on `/appport` and `/mcp` as an identity
holding `services.apiKeys.roles`. In production `FELTKIT_API_KEY_VERIFIER_KEY` (≥ 32 bytes) must be set; changing it
invalidates every key.

**Moving configuration to production.** `feltkit config export --out config.json` writes development's variables,
credential binding names and references, active webhook endpoints, and enabled schedules (never a secret value).
`feltkit config import config.json --env production --dry-run` shows the plan; run it again without `--dry-run`,
on the host with the server stopped, to apply it. Imports never create credential bindings: attach each one it
lists and have the user set its `FELTKIT_CREDENTIAL_<ID>`. Schedules are listed, not imported.

## Troubleshoot

Service states in Studio and `npx feltkit inspect --json`: `available` (not enabled), `unconfigured`, `configured`,
`unhealthy` (store check failed, a required secret is missing, or recent work failed), `unavailable`.

| Symptom | Look at | Usual cause |
|---|---|---|
| Job `failed` | Services → Job runs (`lastError`), Activity filtered to `via: job` | The handler function threw; or `DENIED` — the enqueuer no longer has an active session or key |
| Job never runs | `services.jobs.handlers` | No handler for the type (enqueue refuses unknown types) |
| Delivery `failed` | Services → Webhook deliveries (`lastStatusCode`, `lastError`), Credentials | Signing credential not set; receiver returned 4xx (not retried); destination did not resolve |
| Endpoint rejected on registration | the error | Private/loopback URLs are refused outside development |
| Variable set in the page is missing in code | the environment | The page edits the running environment's scope; check `ctx.environment.name` |
| Models: "No API key is stored for credential-ref:…" | Studio → Models, `feltkit credential status` | Enter the key in the Models API key field (or `feltkit credential set <provider>`); production: set the variable on the host |
| `CUSTODY_READ_ONLY` | the message names the variable | The value comes from the host (`FELTKIT_CREDENTIAL_<ID>` is set, or production without the vault opt-in): change it there |
| `FORBIDDEN … credential.store` / `intelligence.write` | the dev identity's roles | Save as a dev user whose role grants `credential.*` and `intelligence.*` (the starter's Ada) |

Durable work (jobs, schedules, deliveries) re-authorizes every attempt **as the principal that created it**. If
that principal signs out everywhere or its key is revoked, its pending work is refused — by design.

Retry or replay from Studio (Job runs → Retry, Deliveries → Replay), or ask the FeltKit agent to diagnose it
(see the feltkit-agent skill). In tests, drive due work explicitly: `await app.runtime.runServices()`.

## Requires approval

Revoking or rotating API keys, disabling endpoints, deleting configuration or secrets, and replaying deliveries
affect other systems. Confirm with the user before doing any of them.

## Compatibility

`@feltdb/feltkit` 0.3.x with `@appport/services` 0.16.0 (shared instance; transactional job and webhook creation; `credential.store` / `credential.status`; `servicesContract` for Managed FeltDB).
The console is development-only.
Verified in Claude Code only.
