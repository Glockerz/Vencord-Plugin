/**
 * Behavioural tests for the DeleteMyMessages engine.
 *
 * These run the REAL engine (deleteMyMessages/engine.ts) against a simulated
 * Discord REST API - `@webpack/common` is aliased to a mock that forwards
 * RestAPI.get/del and UserStore.getCurrentUser to a FakeDiscord instance.
 *
 * Run with:  npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DeleteJob } from "../deleteMyMessages/engine.ts";
import type { DeleteFilters, DeleteTuning, JobState, JobStats } from "../deleteMyMessages/engine.ts";
import { buildChannel, FakeDiscord } from "./fakeDiscord.ts";
import { setBackend } from "./webpackCommonMock.ts";

const noSleep = async (_ms: number) => { };

function makeJob(fake: FakeDiscord, filterOverrides: Partial<DeleteFilters> = {}, tuningOverrides: Partial<DeleteTuning> = {}) {
    setBackend(fake);

    const filters: DeleteFilters = {
        guildId: fake.guildId,
        channelId: fake.channelId,
        scopeChannelOnly: true,
        includePinned: false,
        includeNsfw: true,
        maxDeletions: 0,
        dryRun: false,
        ...filterOverrides,
    };

    const tuning: DeleteTuning = {
        searchDelayMs: 1,
        deleteDelayMs: 1,
        maxAttemptsPerMessage: 3,
        maxSweeps: 5,
        ...tuningOverrides,
    };

    const job = new DeleteJob(filters, tuning, { sleep: noSleep });

    const done = new Promise<{ state: JobState; stats: JobStats; reason: string; }>(resolve => {
        job.onStop = (state, stats, reason) => resolve({ state: { ...state, log: [...state.log] }, stats, reason });
    });

    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("job did not finish within 10s (possible infinite loop)")), 10000)
    );

    return { job, done: Promise.race([done, timeout]) };
}

function mineIdsOf(messages: { id: string; author: { id: string; }; }[], me: string) {
    return messages.filter(m => m.author.id === me).map(m => m.id);
}

// ---------------------------------------------------------------------------
// The bug report: "it stops before it deletes all your messages"
// ---------------------------------------------------------------------------

test("deletes every one of my messages when Discord's search index lags behind", async () => {
    const { messages, me } = buildChannel({ mine: 60, others: 47 });
    // a deleted message keeps being returned by search for 3 more requests
    const fake = new FakeDiscord({ messages, indexLag: 3 });
    const { job, done } = makeJob(fake);

    job.run();
    const { state, reason } = await done;

    assert.equal(fake.deleted.size, 60, `only ${fake.deleted.size}/60 of my messages were deleted`);
    assert.deepEqual(
        [...fake.deleted].sort(),
        mineIdsOf(messages, me).sort(),
        "the set of deleted messages must be exactly my messages"
    );
    assert.equal(state.delCount, 60);
    assert.equal(state.failCount, 0);
    assert.equal(state.mineCount, 60);
    assert.match(reason, /Finished/);
    assert.equal(job.state.running, false);
});

test("an empty page in the middle of the scan does not end the job early", async () => {
    const { messages, me } = buildChannel({ mine: 80, others: 10 });
    // Discord answers requests #2 and #3 with nothing at all, mid-scan
    const fake = new FakeDiscord({ messages, indexLag: 2, emptySearchesAt: [2, 3] });
    const { job, done } = makeJob(fake);

    job.run();
    const { state } = await done;

    assert.equal(fake.deleted.size, 80);
    assert.equal(state.delCount, 80);
    assert.equal(state.failCount, 0);
    assert.ok(fake.searchCount >= 4, "it must have kept searching after the empty pages");
    assert.deepEqual([...fake.deleted].sort(), mineIdsOf(messages, me).sort());
});

test("re-scans to pick up messages the index only reports late", async () => {
    const { messages, me, channelId } = buildChannel({ mine: 30, others: 5 });
    const late = {
        id: "9999999999999999990",
        channel_id: channelId,
        author: { id: me, username: "me" },
        content: "indexed late",
        type: 0,
    };
    const fake = new FakeDiscord({
        messages,
        lateMessages: [late],
        lateAfterSearches: 4,
    });
    const { job, done } = makeJob(fake);

    job.run();
    const { state } = await done;

    assert.ok(fake.deleted.has(late.id), "the late-indexed message should be deleted on a later scan");
    assert.equal(state.delCount, 31);
    assert.ok(state.pass >= 2, `expected more than one scan, got ${state.pass}`);
});

// ---------------------------------------------------------------------------
// The bug report: "it shows all messages ... not just yours"
// ---------------------------------------------------------------------------

test("only my own messages are ever deleted, even when search returns everyone's", async () => {
    const { messages, me } = buildChannel({ mine: 40, others: 60 });
    // pretend the author_id filter is ignored server-side and hits come back for everyone
    const fake = new FakeDiscord({ messages, ignoreAuthorFilter: true });
    const { job, done } = makeJob(fake);

    job.run();
    const { state } = await done;

    assert.deepEqual(fake.attemptedOnOthers, [], "no delete request may target somebody else's message");
    assert.deepEqual([...fake.deleted].sort(), mineIdsOf(messages, me).sort());
    assert.equal(state.delCount, 40);
    assert.equal(state.mineCount, 40);
    assert.equal(state.notMineCount, 60, "other people's messages must be counted separately");
});

test("reported counts come from verified messages, not from Discord's total_results", async () => {
    const { messages, me } = buildChannel({ mine: 25, others: 75 });
    // Discord claims 100 results for the query (the whole channel)
    const fake = new FakeDiscord({ messages, inflatedTotalResults: true });
    const { job, done } = makeJob(fake);

    job.run();
    const { state } = await done;

    assert.equal(state.grandTotal, 100, "the raw estimate is kept, but only as a reference");
    assert.equal(state.mineCount, 25, "the 'your messages' count must be verified per message");
    assert.equal(state.queuedCount, 25);
    assert.equal(state.delCount, 25);
    assert.equal(fake.deleted.size, 25);
    assert.deepEqual([...fake.deleted].sort(), mineIdsOf(messages, me).sort());
});

test("every search request is scoped to me and pages forward with a cursor", async () => {
    const { messages, me } = buildChannel({ mine: 70, others: 20 });
    const fake = new FakeDiscord({ messages, indexLag: 1 });
    const { job, done } = makeJob(fake);

    job.run();
    await done;

    assert.ok(fake.searchUrls.length > 0);

    let previousCursor = 0n;
    for (const url of fake.searchUrls) {
        const params = new URLSearchParams(url.split("?")[1]);
        assert.equal(params.get("author_id"), me, "every search must be filtered to my own id");
        assert.equal(params.get("sort_order"), "asc");
        assert.equal(params.get("offset"), "0", "paging must use the cursor, not an offset");
        assert.equal(params.get("include_nsfw"), "true", "NSFW channels must be included");
        const cursor = params.get("min_id");
        if (cursor == null) {
            previousCursor = 0n; // a new scan legitimately restarts from the beginning
        } else {
            assert.ok(BigInt(cursor) >= previousCursor, "the cursor must never move backwards");
            previousCursor = BigInt(cursor);
        }
    }
});

// ---------------------------------------------------------------------------
// Safety + filters
// ---------------------------------------------------------------------------

test("respects the max-deletions cap", async () => {
    const { messages } = buildChannel({ mine: 50, others: 5 });
    const fake = new FakeDiscord({ messages });
    const { job, done } = makeJob(fake, { maxDeletions: 7 });

    job.run();
    const { state, reason } = await done;

    assert.equal(fake.deleted.size, 7);
    assert.equal(state.delCount, 7);
    assert.match(reason, /limit of 7/);
});

test("dry run counts everything but deletes nothing", async () => {
    const { messages } = buildChannel({ mine: 33, others: 12 });
    const fake = new FakeDiscord({ messages });
    const { job, done } = makeJob(fake, { dryRun: true });

    job.run();
    const { state } = await done;

    assert.equal(fake.deleteCount, 0, "dry run must not send a single DELETE");
    assert.equal(fake.deleted.size, 0);
    assert.equal(state.delCount, 33, "dry run still reports what would be deleted");
    assert.equal(state.mineCount, 33);
});

test("pinned messages are kept unless explicitly included", async () => {
    const { messages, me } = buildChannel({ mine: 20, others: 4 });
    const pinned = mineIdsOf(messages, me).slice(0, 3);
    for (const m of messages) if (pinned.includes(m.id)) m.pinned = true;

    const keepFake = new FakeDiscord({ messages: messages.map(m => ({ ...m })) });
    const keep = makeJob(keepFake);
    keep.job.run();
    const keepState = (await keep.done).state;
    assert.equal(keepFake.deleted.size, 17);
    assert.equal(keepState.filteredCount, 3);

    const deleteFake = new FakeDiscord({ messages: messages.map(m => ({ ...m })) });
    const del = makeJob(deleteFake, { includePinned: true });
    del.job.run();
    await del.done;
    assert.equal(deleteFake.deleted.size, 20);
});

test("content and regex filters narrow the deletion set", async () => {
    const { messages } = buildChannel({ mine: 20, others: 0 });
    messages.forEach((m, i) => {
        m.content = i % 2 === 0 ? "keep me" : "nuke this";
    });

    const contentFake = new FakeDiscord({ messages: messages.map(m => ({ ...m })) });
    const byContent = makeJob(contentFake, { content: "nuke" });
    byContent.job.run();
    await byContent.done;
    assert.equal(contentFake.deleted.size, 10);

    const patternFake = new FakeDiscord({ messages: messages.map(m => ({ ...m })) });
    const byPattern = makeJob(patternFake, { pattern: "^keep" });
    byPattern.job.run();
    await byPattern.done;
    assert.equal(patternFake.deleted.size, 10);
});

test("non-deletable system messages are skipped, everything else still goes", async () => {
    const { messages, me } = buildChannel({ mine: 20, others: 0 });
    const system = mineIdsOf(messages, me).slice(0, 4);
    // type 1 (recipient add) is a system message nobody can delete. Note that
    // types 6-21 ARE treated as deletable, matching undiscord's own filter.
    for (const m of messages) if (system.includes(m.id)) m.type = 1;

    const fake = new FakeDiscord({ messages });
    const { job, done } = makeJob(fake);
    job.run();
    const { state } = await done;

    assert.equal(fake.deleted.size, 16);
    assert.equal(state.filteredCount, 4);
    assert.equal(state.delCount, 16);
});

test("min_id / max_id filters are passed through", async () => {
    const { messages, me } = buildChannel({ mine: 30, others: 0 });
    const ids = mineIdsOf(messages, me).sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1));
    const fake = new FakeDiscord({ messages });
    const { job, done } = makeJob(fake, { minId: ids[9], maxId: ids[20] });

    job.run();
    await done;

    assert.equal(fake.deleted.size, 10, "only the 10 messages strictly between the bounds");
    for (const id of fake.deleted) {
        assert.ok(BigInt(id) > BigInt(ids[9]) && BigInt(id) < BigInt(ids[20]));
    }
});

// ---------------------------------------------------------------------------
// Rate limiting / errors / stopping
// ---------------------------------------------------------------------------

test("survives 429s on both search and delete and still finishes", async () => {
    const { messages } = buildChannel({ mine: 20, others: 5 });
    const fake = new FakeDiscord({
        messages,
        searchStatuses: [429, 429],
        deleteStatuses: [429, 429, 429],
    });
    const { job, done } = makeJob(fake);

    job.run();
    const { state, stats } = await done;

    assert.equal(fake.deleted.size, 20);
    assert.equal(state.delCount, 20);
    assert.ok(stats.throttledCount >= 5, `expected throttling to be recorded, got ${stats.throttledCount}`);
});

test("waits out a 202 'not indexed yet' response", async () => {
    const { messages } = buildChannel({ mine: 10, others: 0 });
    const fake = new FakeDiscord({ messages, searchStatuses: [202, 202] });
    const { job, done } = makeJob(fake);

    job.run();
    const { stats } = await done;

    assert.equal(fake.deleted.size, 10);
    assert.ok(stats.throttledCount >= 2);
});

test("a message that is already gone counts as gone, not as a failure", async () => {
    const { messages } = buildChannel({ mine: 10, others: 0 });
    const fake = new FakeDiscord({ messages, deleteStatuses: [404] });
    const { job, done } = makeJob(fake);

    job.run();
    const { state } = await done;

    assert.equal(state.goneCount, 1);
    assert.equal(state.failCount, 0);
    assert.equal(state.delCount, 9);
});

test("stop() halts the job promptly", async () => {
    const { messages } = buildChannel({ mine: 100, others: 0 });
    const fake = new FakeDiscord({ messages });
    const { job, done } = makeJob(fake);

    job.onProgress = state => {
        if (state.delCount >= 5) job.stop("Stopped by you.");
    };

    job.run();
    const { state, reason } = await done;

    assert.equal(reason, "Stopped by you.");
    assert.ok(state.delCount >= 5 && state.delCount < 100, `stopped after ${state.delCount} deletions`);
    assert.equal(job.state.running, false);
});

test("cancelling the confirmation deletes nothing", async () => {
    const { messages } = buildChannel({ mine: 15, others: 0 });
    const fake = new FakeDiscord({ messages });
    const { job, done } = makeJob(fake);

    job.onConfirm = async () => false;

    job.run();
    const { reason } = await done;

    assert.equal(fake.deleteCount, 0);
    assert.match(reason, /did not confirm/);
});

test("handles search responses that do not flag hits", async () => {
    const { messages } = buildChannel({ mine: 20, others: 20 });
    const fake = new FakeDiscord({ messages, noHitFlags: true });
    const { job, done } = makeJob(fake);

    job.run();
    const { state } = await done;

    assert.equal(fake.deleted.size, 20, "every one of my messages should still be found");
    assert.deepEqual(fake.attemptedOnOthers, []);
    assert.equal(state.delCount, 20);
});

test("messages that failed are retried once more at the end", async () => {
    const { messages } = buildChannel({ mine: 6, others: 0 });
    // the first message fails all 3 attempts, then the retry pass succeeds
    const fake = new FakeDiscord({ messages, deleteStatuses: [500, 500, 500] });
    const { job, done } = makeJob(fake);

    job.run();
    const { state } = await done;

    assert.equal(fake.deleted.size, 6, "the retried message should end up deleted");
    assert.equal(state.delCount, 6);
    assert.equal(state.failCount, 0, "a message that succeeded on the retry pass is not a failure");
});

test("gives up with a clear message when Discord refuses every deletion", async () => {
    const { messages } = buildChannel({ mine: 60, others: 0 });
    const fake = new FakeDiscord({ messages, deleteAlwaysStatus: 500 });
    const { job, done } = makeJob(fake);

    job.run();
    const { state, reason } = await done;

    assert.equal(fake.deleted.size, 0);
    assert.match(reason, /failed in a row/);
    assert.equal(state.failCount, 15, "it must stop instead of burning through the whole channel");
    assert.equal(job.state.running, false);
});
