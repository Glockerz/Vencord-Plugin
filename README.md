# Vencord-Plugin

## DeleteMyMessages

Bulk-delete **your own** Discord messages in a channel, DM, or across a whole
server, directly from Discord — inspired by, and re-implementing the safety
mechanisms of,
[victornpb/undiscord](https://github.com/victornpb/undiscord) (search →
filter → confirm → delete, with rate-limit backoff, configurable delays,
dry-run preview, and a hard cap on how many messages get deleted).

On top of Undiscord's approach it fixes the two things that make bulk deletion
feel unreliable:

- **It doesn't stop early.** Discord's search index lags behind real
  deletions, so paging by `offset` re-fetches already-deleted messages and
  stalls. This plugin pages with a `min_id` cursor (oldest → newest), retries
  empty pages with backoff, and re-scans the channel until a full scan deletes
  nothing.
- **It only ever counts and deletes *your* messages.** Every message is
  verified against your account before it can be deleted, and the numbers
  shown are counted from messages actually inspected rather than from
  Discord's unreliable `total_results` estimate.

See [`deleteMyMessages/README.md`](./deleteMyMessages/README.md) for
plugin-specific usage instructions, [`tests/README.md`](./tests/README.md) for
the engine's test suite (`npm test`), and [`INSTALL.md`](./INSTALL.md) for the
full step-by-step guide to building Vencord from source with this plugin
included and pointing your client at it (including fixes for the common
pitfalls people hit along the way).
