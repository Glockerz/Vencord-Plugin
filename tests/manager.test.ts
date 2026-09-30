/**
 * Tests for the background job manager: the job must survive having no UI
 * attached at all, which is what lets you close the window / switch channel
 * while it keeps deleting.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { DeleteFilters, DeleteTuning } from "../deleteMyMessages/engine.ts";
import { jobManager } from "../deleteMyMessages/manager.ts";
import { buildChannel, FakeDiscord } from "./fakeDiscord.ts";
import { setBackend, toastLog } from "./webpackCommonMock.ts";

const noSleep = async (_ms: number) => { };

function tuning(): DeleteTuning {
    return { searchDelayMs: 1, deleteDelayMs: 1, maxAttemptsPerMessage: 3, maxSweeps: 5 };
}

function filtersFor(fake: FakeDiscord, overrides: Partial<DeleteFilters> = {}): DeleteFilters {
    return {
        guildId: fake.guildId,
        channelId: fake.channelId,
        scopeChannelOnly: true,
        includePinned: false,
        includeNsfw: true,
        maxDeletions: 0,
        ...overrides,
    };
}

/** every test starts from a clean manager and cleans up after itself */
function install(t: any, fake: FakeDiscord) {
    setBackend(fake);
    if (jobManager.isRunning) jobManager.stop("cleanup");
    jobManager.clear();
    toastLog.length = 0;
    t.after(() => {
        if (jobManager.isRunning) jobManager.stop("cleanup");
        jobManager.clear();
    });
}

/** confirm automatically, like a user clicking "Yes, proceed" */
function autoConfirm(t: any) {
    const unsubscribe = jobManager.subscribe(() => {
        if (jobManager.needsConfirmation) jobManager.confirm(true);
    });
    t.after(unsubscribe);
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 10000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

test("a job keeps running and finishing with no UI attached", async t => {
    const { messages } = buildChannel({ mine: 40, others: 20 });
    const fake = new FakeDiscord({ messages, indexLag: 2 });
    install(t, fake);
    autoConfirm(t);

    const entry = jobManager.start(filtersFor(fake), tuning(), fake.channelId, { sleep: noSleep });
    assert.ok(jobManager.isRunning, "the job must be running right after start()");

    // nobody is listening: no modal, no subscriber - it must still complete
    await waitUntil(() => entry.done, "the job to finish");

    assert.equal(fake.deleted.size, 40, "every one of my messages should be deleted");
    assert.deepEqual(fake.attemptedOnOthers, []);
    assert.equal(entry.state.delCount, 40);
    assert.equal(entry.state.mineCount, 40);
    // the search is filtered to me, so other people's messages never even show up
    assert.equal(entry.state.notMineCount, 0);
    assert.match(entry.reason ?? "", /Finished/);
    assert.equal(jobManager.isRunning, false);
    assert.ok(entry.job.elapsedMs() >= 0, "elapsed time must be reported");

    assert.ok(
        toastLog.some(toast => /40 deleted/.test(toast.message)),
        `expected a completion toast, got: ${JSON.stringify(toastLog)}`
    );

    jobManager.clear();
    assert.equal(jobManager.hasJob, false, "a finished job can be dismissed");
});

test("subscribers are notified while the job runs", async t => {
    const { messages } = buildChannel({ mine: 12, others: 0 });
    const fake = new FakeDiscord({ messages });
    install(t, fake);
    autoConfirm(t);

    let notifications = 0;
    const unsubscribe = jobManager.subscribe(() => notifications++);
    t.after(unsubscribe);

    const entry = jobManager.start(filtersFor(fake), tuning(), fake.channelId, { sleep: noSleep });
    await waitUntil(() => entry.done, "the job to finish");

    assert.ok(notifications > 5, `expected regular progress notifications, got ${notifications}`);

    const before = notifications;
    jobManager.clear();
    assert.equal(notifications, before + 1, "clear() notifies subscribers");
});

test("the job waits for confirmation and can be answered later", async t => {
    const { messages } = buildChannel({ mine: 10, others: 0 });
    const fake = new FakeDiscord({ messages });
    install(t, fake);

    const entry = jobManager.start(filtersFor(fake), tuning(), fake.channelId, { sleep: noSleep });

    await waitUntil(() => jobManager.needsConfirmation, "the confirmation prompt");
    assert.equal(fake.deleteCount, 0, "nothing may be deleted before you confirm");
    assert.ok(entry.state.messagesToDelete.length > 0, "the preview should be available");
    assert.ok(
        toastLog.some(toast => /waiting for you to confirm/i.test(toast.message)),
        `expected a "waiting for confirmation" toast, got: ${JSON.stringify(toastLog)}`
    );

    jobManager.confirm(true);
    await waitUntil(() => entry.done, "the job to finish");

    assert.equal(fake.deleted.size, 10);
    assert.equal(jobManager.needsConfirmation, false);
});

test("refusing the confirmation deletes nothing", async t => {
    const { messages } = buildChannel({ mine: 10, others: 0 });
    const fake = new FakeDiscord({ messages });
    install(t, fake);

    const entry = jobManager.start(filtersFor(fake), tuning(), fake.channelId, { sleep: noSleep });
    await waitUntil(() => jobManager.needsConfirmation, "the confirmation prompt");

    jobManager.confirm(false);
    await waitUntil(() => entry.done, "the job to finish");

    assert.equal(fake.deleteCount, 0);
    assert.match(entry.reason ?? "", /did not confirm/);
});

test("stop() works from outside the modal", async t => {
    const { messages } = buildChannel({ mine: 200, others: 0 });
    const fake = new FakeDiscord({ messages });
    install(t, fake);
    autoConfirm(t);

    const entry = jobManager.start(filtersFor(fake), tuning(), fake.channelId, { sleep: noSleep });
    const unsubscribe = jobManager.subscribe(() => {
        if (entry.state.delCount >= 5 && jobManager.isRunning) jobManager.stop("Stopped by you.");
    });
    t.after(unsubscribe);

    await waitUntil(() => entry.done, "the job to finish");

    assert.equal(entry.reason, "Stopped by you.");
    assert.ok(entry.state.delCount >= 5 && entry.state.delCount < 200, `stopped after ${entry.state.delCount}`);
    assert.equal(jobManager.isRunning, false);
});

test("stopping a job that is waiting for confirmation does not hang it", async t => {
    const { messages } = buildChannel({ mine: 10, others: 0 });
    const fake = new FakeDiscord({ messages });
    install(t, fake);

    const entry = jobManager.start(filtersFor(fake), tuning(), fake.channelId, { sleep: noSleep });
    await waitUntil(() => jobManager.needsConfirmation, "the confirmation prompt");

    jobManager.stop("Stopped by you.");
    await waitUntil(() => entry.done, "the job to finish");

    assert.equal(fake.deleteCount, 0);
    assert.equal(entry.reason, "Stopped by you.", "the stop reason must not be replaced by 'did not confirm'");
    assert.equal(jobManager.needsConfirmation, false);
});

test("only one job can run at a time", async t => {
    const { messages } = buildChannel({ mine: 50, others: 0 });
    const fake = new FakeDiscord({ messages });
    install(t, fake);
    autoConfirm(t);

    jobManager.start(filtersFor(fake), tuning(), fake.channelId, { sleep: noSleep });
    assert.throws(
        () => jobManager.start(filtersFor(fake), tuning(), fake.channelId, { sleep: noSleep }),
        /already running/
    );

    jobManager.stop("Stopped by you.");
    await waitUntil(() => !jobManager.isRunning, "the job to stop");
});

test("the time-remaining estimate covers messages not discovered yet", async t => {
    const { messages } = buildChannel({ mine: 100, others: 0 });
    const fake = new FakeDiscord({ messages });
    install(t, fake);
    autoConfirm(t);

    const entry = jobManager.start(filtersFor(fake), tuning(), fake.channelId, { sleep: noSleep });

    // grab the numbers as soon as the first page (25 messages) has been seen
    let snapshot: { mine: number; remaining: number; etr: number; } | null = null;
    const unsubscribe = jobManager.subscribe(() => {
        if (!snapshot && entry.state.mineCount >= 25) {
            snapshot = {
                mine: entry.state.mineCount,
                remaining: entry.stats.remainingEstimate,
                etr: entry.stats.etrMs,
            };
        }
    });
    t.after(unsubscribe);

    await waitUntil(() => entry.done, "the job to finish");

    assert.ok(snapshot, "expected to observe the job mid-run");
    const seen = snapshot as { mine: number; remaining: number; etr: number; };

    assert.equal(seen.mine, 25, "only the first page has been discovered at this point");
    assert.equal(seen.remaining, 75, "the estimate must include the 75 messages not seen yet");
    assert.ok(seen.etr > 75 * 300, `ETA should cover at least 75 deletions, got ${seen.etr}ms`);

    assert.equal(entry.state.delCount, 100, "and it still goes on to delete all of them");
});
