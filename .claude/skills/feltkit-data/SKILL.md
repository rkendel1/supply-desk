---
name: feltkit-data
description: Model, query, and change data in a FeltKit application on FeltDB — collections and schemas, ctx.db.get/find/query/count, insert/patch/replace/delete, pagination, transactions, and FeltKit's consistency guarantees (conflicts, read fences). Use when designing collections, writing queries or mutations that read and write, handling CONFLICT errors, or reasoning about concurrency.
---

# FeltKit: data on FeltDB

FeltDB is the durable source of truth. Each environment has exactly one FeltDB instance; application data, sessions,
the activity log, AppPort Services, and agent state all live in it. Never open another one.

## Model

```ts
import { feltkit, s } from "@feltdb/feltkit";
export const app = feltkit({ name: "crm" });
export const contacts = app.collection("contacts", {
  name: s.string(),
  email: s.string(),
  stage: s.enum(["lead", "customer"]),
  ownerId: s.string(),
});
```

Records carry `id` and `__version` (FeltDB's). Do not declare either. Writes are validated against the shape.

FeltDB enforces the schema the collections compile to (types, required fields, no undeclared fields).

- **References and constraints.** Declare a reference with `s.ref(otherCollection)`: it must
  name an existing record, and a referenced record cannot be deleted. Declare uniqueness and
  indexes in the third argument: `app.collection("contacts", {...}, { unique: [["email"]], indexes: [{ fields: ["stage"] }] })`.
- **Changing a collection.** Adding an optional field is installed by itself. A required
  field, a type change, a removed field or a removed populated collection needs an
  `app.migration("name", (m) => m.update(contacts, (c) => ({ ...c, newField: value })))`.
  `npx feltkit migrate --dry-run` shows the plan and the records that would fail. Never edit
  or rename a migration that ran.

## Read

```ts
await ctx.db.get(contacts, id);                                   // or null
await ctx.db.find(contacts, { stage: "lead" }, { orderBy: [{ field: "name", direction: "asc" }], limit: 50 });
await ctx.db.count(contacts, { ownerId });
const page = await ctx.db.query(contacts, { where: [{ field: "stage", eq: "lead" }], orderBy: [{ field: "name", direction: "asc" }], limit: 25, cursor });
// page.records, page.nextCursor, page.exhausted
await ctx.db.search(messages, { text: "deploy café", where: { channelId }, limit: 20 }); // needs { search: ["text"] } on the collection
```

`search` returns records whose declared `search` fields contain every word (case- and accent-insensitive),
newest first, at most `limit` (≤ 100). It scans the records matching `where`, so always narrow it with an
equality `where` on large collections. For live queries, filter by `id`, indexed, unique, reference or
tenant fields: a query that reads `find(messages, { channelId })` re-runs only when that channel changes.

`find` returns **every** match unless you pass `limit` (FeltKit reads FeltDB's pages for you), and `count`
counts every match. `query` returns **one page** of at most 1,000 records: follow `nextCursor` until it
is absent. For a large collection, page with `query` on a request path rather than `find` everything.
`where` clauses support `eq`, `neq`, `lt`, `lte`, `gt`, `gte`. Queries are read-only and live in the client
(`useQuery` re-runs when their data changes).

## Write

```ts
const id = await ctx.db.insert(contacts, { name, email, stage: "lead", ownerId });
await ctx.db.patch(contacts, id, { stage: "customer" });
await ctx.db.replace(contacts, id, { name, email, stage: "customer", ownerId });
await ctx.db.delete(contacts, id);
```

A mutation's writes are buffered and commit as **one FeltDB transaction** when the handler returns; if it throws,
nothing is written.

Records `ctx.db` returns are your own copies: change them freely; nothing is stored until you `patch` or `replace`.

## Consistency: what is guaranteed

- **Atomic**: all of a mutation's writes, or none.
- **Checked reads**: everything a mutation read — by id, by equality filter (including records that would newly
  match: phantoms), by range (conservatively), and whole collections — is checked at commit. If any of it changed,
  the commit fails with `CONFLICT` and `retryable: true`, and nothing is written. Retry the mutation; do not retry
  blindly in a loop without a bound. A `CONFLICT` without `retryable` (a duplicate unique value, "already applied")
  fails the same way again: do not retry it.
- **Not guaranteed**: a consistent snapshot *while* a handler runs; checks for read-only mutations; fences against
  writes made through `ctx.unsafe.feltdb`.
- Service effects (`ctx.services.*`) commit separately from the mutation.

## Patterns

- Uniqueness: read with `find` by the unique field, then insert; a concurrent duplicate makes one commit `CONFLICT`.
- Counters and balances: read then `patch` in the same mutation; concurrent updates conflict instead of losing one.
- Large scans: page with `query` + `cursor`; `find` is capped.

## Inspect data

Studio → Data (application collections and read-only platform collections). From a coding agent, read through the
application's capabilities (feltkit-agent skill); there is no direct database access for agents, by design.

## Requires approval

Deleting records, bulk changes, schema changes that drop fields, or anything in production.

## Compatibility

`@feltdb/feltkit` 0.3.x on `@feltdb/core` 0.21.0. Details: `npx feltkit docs guarantees` (node_modules/@feltdb/feltkit/docs/GUARANTEES.md). Verified in Claude Code only.
