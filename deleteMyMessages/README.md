# DeleteMyMessages

A [Vencord](https://vencord.dev) plugin that bulk-deletes **your own** Discord
messages in a channel, DM, or across a whole server — directly inspired by, and
re-implementing the safety mechanisms of,
[victornpb/undiscord](https://github.com/victornpb/undiscord).

It never reads or transmits your Discord auth token. All requests go through
Vencord's own authenticated `RestAPI`, exactly the way Discord's client
itself performs requests.

## Safeguards (ported from Undiscord)

- **Author-locked** — only ever deletes messages sent by the currently
  logged-in account. This is enforced twice: the search is filtered with
  `author_id`, *and* every message returned is re-checked against your account
  before it can be deleted, so even a search result containing somebody else's
  message can never be acted on.
- **Confirmation step** before anything is deleted, with a preview of the
  messages on the first page.
- **Configurable search/delete delays** with enforced safe minimums
  (400ms / 300ms floors).
- **Automatic backoff + retry** on HTTP `429` (rate limited) and `202`
  (search index not ready yet) responses. Like `undiscord-core.js`, the
  delay is permanently raised after being throttled so the tool adapts to
  Discord's current rate limits instead of hammering the API.
- **Visible Stop button** to abort a running job at any time (closing the
  window stops the job too — it can never keep deleting with no UI).
- **Dry run mode**, enabled by default, to preview counts before anything
  actually happens.
- **A configurable "max messages to delete" cap** for extra peace of mind.

## Runs in the background

The job does **not** belong to the window. Start it, then close the window,
switch to another DM or server, or just carry on chatting — it keeps deleting.

- A permanent **trash icon sits in the chat box toolbar** in every channel.
  Its tooltip shows live progress (`running: 128 deleted in 0h 4m 11s`), it
  turns red while a job runs and amber when the job is parked waiting for you
  to confirm. Click it to reopen the window.
- `/deletemymessages` reopens it too, from anywhere.
- The window shows **time running**, deletions per minute, the live log, and
  an explicit **"Keep running in background"** button next to **Stop now**.
- Closing the window never stops the job. Turning the plugin off does (that is
  the only silent stop, and it is logged).
- A toast tells you when it is waiting for confirmation and when it finishes.

## Speed is set when you start it

The start dialog has **Search delay (ms)** and **Delete delay (ms)** fields
(defaults come from plugin settings, floors of 400ms / 300ms are enforced), so
you can go slower for a big job without digging into Settings first.

## Time remaining is an estimate, and says so

With cursor paging the tool only discovers ~25 of your messages per page, so
"messages found" trails far behind reality for most of a run. The ETA therefore
uses whichever is larger: the messages it has already verified are still to be
deleted, or Discord's count for the query minus what it has seen so far. It is
labelled as an estimate, the message count next to it is shown as approximate,
and it also budgets for the final verification scan. The counts themselves
(deleted / failed / already gone / filtered out) are always exact.

## How it keeps going until *everything* of yours is gone

Discord's message-search index lags behind real deletions — often by several
seconds. Two consequences break naive implementations:

1. **Deleted messages keep coming back from search for a while.** If you page
   with `offset` (like `undiscord-core.js` does) you keep re-fetching the same
   stale page: you re-request already-deleted messages, get `404`s, and never
   move forward. This plugin instead pages with a **cursor**: every request
   carries `min_id = <newest message already inspected>`, scans strictly
   oldest → newest, and can therefore never ask for the same page twice.
2. **A page can come back empty while messages still exist.** An empty page is
   never trusted as "finished" — the tool backs off (2s, 4s, 8s, 15s) and asks
   again, and after a scan that deleted something it **scans the whole channel
   again from the oldest message** to pick up anything the index reported
   late. Scans stop as soon as one of them deletes nothing (or when the
   configurable *Max scans* limit is reached).

Anything that fails to delete is retried once more at the end, using the ids
already known — no extra searching needed.

## Honest counts

Discord's `total_results` is an **estimate for the whole query** and is
frequently wrong (it is not "your" message count). This plugin therefore
never displays it as your count and never uses it to decide when to stop.
Everything in the UI is counted from messages the tool actually inspected:

| Field | Meaning |
| --- | --- |
| **Your messages found** | unique search hits verified as authored by you |
| *…plus N from other people, ignored* | hits that were not yours — counted, never touched |
| **Matching your filters** | your messages that passed the pinned/type/regex filters |
| **Deleted / Failed / Already gone / Skipped** | outcome per message |
| *Discord's own estimate* | shown for reference only, labelled as unreliable |

## Features

- Delete messages in the current channel/DM, or search an entire server
  (subject to Discord's message search index).
- Filters: content substring, case-insensitive regex, has-link, has-file,
  include/exclude pinned messages, and before/after message ID or date.
- Live progress: verified counts, current scan, pages fetched, rate-limit
  history, estimated time remaining, and a rolling log of exactly what the
  tool is doing and why it stopped.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `searchDelay` | 1500ms | delay between search requests (400ms floor) |
| `deleteDelay` | 1200ms | delay between deletions (300ms floor) |
| `maxAttempts` | 3 | delete attempts per message |
| `maxScans` | 5 | full oldest→newest scans; a scan that deletes nothing ends the job |
| `addContextMenuEntry` | on | adds "Delete My Messages…" to channel/DM menus |

Search/delete delays are defaults only — the start dialog lets you override
them per job.

## The warning is the point

Automating your account is **self-botting**, which Discord's Terms of Service
forbid and which has gotten accounts terminated. The tool says so in its
subtitle, in a red box on the start and confirm screens, in the slash-command
reply, and in the plugin description — deliberately, every time, because the
downside is your account and not a re-run.

## Installation (userplugin)

1. Set up a [Vencord development build](https://vencord.dev/installing/)
   (`git clone` of Vencord + `pnpm install`).
2. Copy this `deleteMyMessages` folder into `src/userplugins/` in your
   Vencord checkout, so the path looks like:
   `Vencord/src/userplugins/deleteMyMessages/index.tsx`.
3. Build and inject:
   ```sh
   pnpm build
   pnpm inject
   ```
4. Restart Discord, then enable **DeleteMyMessages** under
   Settings → Vencord → Plugins.

Only the `deleteMyMessages/` folder is needed — `tests/`, `tsconfig.json` and
`package.json` at the repo root are development-only and are not part of the
plugin.

## Usage

- Run the `/deletemymessages` slash command in any channel or DM, **or**
  right-click a channel/DM in the channel list and choose
  **"Delete My Messages..."**.
- Configure your filters and scope, review the dry-run preview, then
  confirm to actually delete.
- Click **Stop** at any time to abort a running job.

## Development

```sh
npm install       # typescript + types only; the plugin itself has no deps
npm test          # behavioural tests for the engine (Node >= 22.18, no bundler)
npm run typecheck # tsc --noEmit over the plugin + tests
npm run check     # both
```

`npm test` runs the **real** engine against a simulated Discord REST API
(`tests/fakeDiscord.ts`) that can model a lagging search index, wrong
`total_results`, `429`/`202` responses and other people's messages. See
[`tests/README.md`](./tests/README.md).

## Disclaimer

Bulk message deletion through client automation is against Discord's Terms
of Service and, like Undiscord itself, this plugin is provided for personal
convenience with no warranty. Deleted messages cannot be recovered. Use
generous delays and test with dry-run first.
