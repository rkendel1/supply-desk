# FeltKit feedback from building SupplyDesk

Building SupplyDesk on `@feltdb/feltkit` 0.3.10 surfaced these changes to FeltKit. Each is
filed against `rkendel1/feltkit` with the source location on `main` and a "done when" test.

| Issue | Change | Area |
|---|---|---|
| rkendel1/feltkit#23 | AppBoundry guest has no `Intl` (Boa built without `intl`), so artifacts format differently from dev, silently | AppBoundry engine |
| rkendel1/feltkit#24 | No published runtime runs `appboundry.app/1`; `appboundry run` doesn't exist on npm. Add one, plus `createArtifactTestApp` | AppBoundry, testing |
| rkendel1/feltkit#25 | Build skill recommends `ctx.agent`, which AppBoundry refuses; the refusal regex matches any `.agent` | Skills, AppBoundry build |
| rkendel1/feltkit#26 | A service-call denial inside a function doesn't name the function, caller, role or fix | Services, errors |
| rkendel1/feltkit#27 | Arguments are validated before authorization (`INVALID_ARGUMENT` instead of `FORBIDDEN`) | Runtime, guest |
| rkendel1/feltkit#28 | Derive output schemas from collections (`s.doc`, pick/omit) instead of restating them | Schema |
| rkendel1/feltkit#29 | No commit-ordered sequence for append-only logs written by mutations | Data |
| rkendel1/feltkit#30 | Naming rule, `FAILED_PRECONDITION`, `_` helper modules, stale skill versions, skills mid-session, post-commit effects | DX |

Status on FeltKit 0.3.24, the version SupplyDesk now runs on:

- `feltkit/_rules.ts` `money()` still formats by hand (#23). 0.3.24 refuses `Intl` at build with a clear
  reason, but doesn't provide it in artifacts, so the hand formatting stays.
- `scripts/verify-artifact.mjs` has been **removed** (#24). `tests/artifact.test.ts` runs the scenario
  against the artifact with `createArtifactTestApp`, and the artifact was also run under
  `@appport/appboundry` 1.11.1.
- `feltkit/_views.ts` no longer restates stored records (#28). They're `s.doc(collection)`.
- `feltkit/_audit.ts` no longer uses a per-process monotonic timestamp (#29). An invoice's history is
  ordered by `ctx.db.sequence`.
- Notifications and webhook events moved from `ctx.services.*` to `ctx.afterCommit.*` (#30).
- The Agent Skills were refreshed to 0.3.24.

FeltKit's `app.auditTrail` (unreleased at the time of writing) covers the audit trail's shape except
`invoiceId`, the extra indexed field SupplyDesk uses to show an invoice's whole history across subjects.
