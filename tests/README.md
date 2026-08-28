# Tests

Behavioural tests for the DeleteMyMessages engine. They run the **real**
plugin source — `deleteMyMessages/engine.ts` — against a simulated Discord
REST API, so the search → filter → confirm → delete loop is exercised exactly
as it runs inside Discord.

## Running

```sh
npm install   # once: typescript + @types (no runtime deps)
npm test      # node --test
npm run typecheck
npm run check # both
```

Requires Node **>= 22.18** (the tests use Node's built-in TypeScript support,
so no bundler or build step is involved).

## How it works

| File | Purpose |
| --- | --- |
| `fakeDiscord.ts` | A fake Discord API: `/messages/search` (paging, `min_id`/`max_id`, sort order, content filter, conversation grouping with context messages) and `DELETE /channels/:id/messages/:id`. Can simulate a **lagging search index**, a wrong `total_results`, `429`/`202` responses, missing `hit` flags, and an ignored `author_id` filter. |
| `webpackCommonMock.ts` | Stands in for Vencord's `@webpack/common`; forwards `RestAPI.get/del` and `UserStore.getCurrentUser` to whichever `FakeDiscord` the test installed. |
| `aliasLoader.mjs` / `register.mjs` | Node module-resolution hooks that map `@webpack/common` to the mock, so the unmodified plugin source can be imported directly. |
| `engine.test.ts` | The tests. |
| `types/vencord-modules.d.ts` | Ambient stubs for `@webpack/common`, `@api/*`, `@utils/*`, `@components/*` so `npm run typecheck` works without a Vencord checkout. |

The engine's waits are injectable (`DeleteJob`'s third constructor argument),
which is the only thing the tests override — everything else, including the
real `RestAPI` call path, is the shipped code.

## What is covered

- **Completeness** — every message of yours is deleted even when Discord's
  search index keeps returning already-deleted messages, when a page comes
  back empty mid-scan, and when the index reports messages only on a later
  scan.
- **Author safety** — no delete request ever targets somebody else's message,
  even when the search returns their messages as hits; other people's messages
  are counted separately instead.
- **Honest counts** — reported numbers come from messages the tool inspected,
  not from Discord's `total_results` estimate.
- **Paging** — every search is scoped to your own id and pages forward with a
  monotonically increasing cursor instead of an offset.
- **Filters & caps** — pinned/type/regex/content filters, `min_id`/`max_id`,
  the max-deletions cap, and dry run.
- **Failure handling** — `429` on search and delete, `202` not-indexed,
  messages that are already gone, stopping mid-run, and cancelling the
  confirmation dialog.
