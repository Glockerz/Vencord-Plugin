# DeleteMyMessages

A [Vencord](https://vencord.dev) plugin that bulk-deletes **your own** Discord
messages in a channel, DM, or across a whole server — directly inspired by,
and re-implementing the safety mechanisms of,
[victornpb/undiscord](https://github.com/victornpb/undiscord).

It never reads or transmits your Discord auth token. All requests go through
Vencord's own authenticated `RestAPI`, exactly the way Discord's client
itself performs requests.

## Safeguards (ported from Undiscord)

- **Author-locked** — only ever deletes messages sent by the currently
  logged-in account. This is hard-enforced in `engine.ts` and cannot be
  overridden by any filter or option.
- **Confirmation step** before anything is deleted, showing an estimate of
  how many messages match and how long it will take.
- **Configurable search/delete delays** with enforced safe minimums
  (400ms / 300ms floors).
- **Automatic backoff + retry** on HTTP `429` (rate limited) and `202`
  (search index not ready yet) responses. Like `undiscord-core.js`, the
  delay is permanently raised after being throttled so the tool adapts to
  Discord's current rate limits instead of hammering the API.
- **Visible Stop button** to abort a running job at any time.
- **Dry run mode**, enabled by default, to preview what would be deleted
  before anything actually happens.
- **A configurable "max messages to delete" cap** for extra peace of mind.

## Features

- Delete messages in the current channel/DM, or search an entire server
  (subject to Discord's message search index).
- Filters: content substring, case-insensitive regex, has-link, has-file,
  include/exclude pinned messages, and before/after message ID or date.
- Live progress: messages found, deleted, failed, skipped, and how many
  times/how long the tool has been rate-limited.

## Installation (userplugin)

1. Set up a [Vencord development build](https://docs.vencord.dev/installing/)
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

## Usage

- Run the `/deletemymessages` slash command in any channel or DM, **or**
  right-click a channel/DM in the channel list and choose
  **"Delete My Messages..."**.
- Configure your filters and scope, review the dry-run preview, then
  confirm to actually delete.
- Click **Stop** at any time to abort a running job.

## Disclaimer

Bulk message deletion through client automation is against Discord's Terms
of Service and, like Undiscord itself, this plugin is provided for personal
convenience with no warranty. Deleted messages cannot be recovered. Use
generous delays and test with dry-run first.
