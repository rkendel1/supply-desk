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

What SupplyDesk works around today, and where:
- `feltkit/_rules.ts` `money()`: formats by hand (#23).
- `scripts/verify-artifact.mjs`: a reference host (#24).
- `feltkit/_views.ts`: restated output schemas (#28).
- `feltkit/_audit.ts`: a per-process monotonic timestamp (#29).
