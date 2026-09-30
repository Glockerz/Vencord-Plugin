/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 you
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * DeleteMyMessages engine.
 *
 * Bulk-deletes YOUR OWN messages, heavily inspired by (and porting the safety
 * mechanisms of) victornpb/undiscord: https://github.com/victornpb/undiscord
 *
 * This file re-implements Undiscord's search -> filter -> confirm -> delete
 * loop (see src/undiscord-core.js) on top of Vencord's authenticated RestAPI,
 * so the plugin never has to read or transmit your raw auth token.
 *
 * Two deliberate improvements over a straight port of undiscord-core.js:
 *
 *  1. CURSOR PAGING INSTEAD OF OFFSET PAGING.
 *     Undiscord keeps `offset` and re-asks for page 0 after every batch. That
 *     only works if Discord's search index has already forgotten the messages
 *     we just deleted - which it frequently hasn't (the index lags by seconds,
 *     sometimes much longer). When it lags, the same already-deleted messages
 *     come back forever, the job spins without progress, and it looks like it
 *     "stopped early". Here every request carries `min_id = <newest id we have
 *     already looked at> + 1`, so a page can never be returned twice and the
 *     scan always moves forward.
 *
 *  2. VERIFIED COUNTS INSTEAD OF `total_results`.
 *     Discord's `total_results` is an estimate for the whole query and is
 *     regularly wrong, so it is never used to decide anything or shown as
 *     "your" count. Everything displayed is counted by this plugin from
 *     messages it actually inspected, and every message is re-checked against
 *     the logged in account before it can be deleted.
 */

import { ChannelStore, RestAPI, UserStore } from "@webpack/common";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchMessage {
    id: string;
    channel_id: string;
    content: string;
    timestamp: string;
    type: number;
    pinned?: boolean;
    hit?: boolean;
    attachments?: any[];
    author: {
        id: string;
        username: string;
        discriminator?: string;
    };
}

export interface SearchResponse {
    messages?: SearchMessage[][];
    total_results?: number;
}

export interface DeleteFilters {
    /** "@me" for DMs / group DMs, otherwise the guild id */
    guildId: string;
    channelId: string;
    /** When searching a whole guild, restrict to a single channel too */
    scopeChannelOnly: boolean;

    content?: string;
    hasLink?: boolean;
    hasFile?: boolean;
    includePinned: boolean;
    /** also search NSFW channels (matters for whole-server scans) */
    includeNsfw: boolean;
    /** case-insensitive regex tested against message content */
    pattern?: string;
    /** message id or ISO date string - only delete messages after this */
    minId?: string;
    /** message id or ISO date string - only delete messages before this */
    maxId?: string;
    /** safety cap - stop after deleting this many messages (0 = unlimited) */
    maxDeletions: number;
}

export interface DeleteTuning {
    searchDelayMs: number;
    deleteDelayMs: number;
    maxAttemptsPerMessage: number;
    /**
     * How many full oldest->newest scans to perform. A scan that deletes
     * nothing ends the job; otherwise we scan again to catch anything
     * Discord's search index reported late.
     */
    maxSweeps: number;
}

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
    t: number;
    level: LogLevel;
    text: string;
}

export interface JobState {
    running: boolean;
    stopRequested: boolean;

    /** which full scan we are on (1-based) */
    pass: number;
    /** search pages fetched so far */
    pages: number;
    /** consecutive empty search pages at the end of the current scan */
    emptyPages: number;
    /** oldest-ward cursor: next search asks for messages newer than this */
    cursorId: string | null;

    delCount: number;
    failCount: number;
    /** could not be deleted, moved on anyway (archived thread, ...) */
    skipCount: number;
    /** already gone when we tried to delete it */
    goneCount: number;

    /** hit messages seen across all pages (yours + others, duplicates included) */
    scannedCount: number;
    /** unique hits authored by YOU */
    mineCount: number;
    /** unique hits authored by somebody else - never touched */
    notMineCount: number;
    /** your messages that passed every filter (safe to delete) */
    queuedCount: number;
    /** your messages excluded by the pinned/type/regex filters */
    filteredCount: number;

    /**
     * Discord's own `total_results` estimate. Unreliable - kept only so the UI
     * can show it as "Discord says ~N", never used for any decision.
     */
    grandTotal: number;

    /** messages queued for deletion on the current page */
    messagesToDelete: SearchMessage[];
    /** your messages skipped by filters on the current page */
    skippedMessages: SearchMessage[];

    log: LogEntry[];
}

export interface JobStats {
    startTime: number;
    endTime?: number;
    throttledCount: number;
    throttledTotalTime: number;
    lastPing: number | null;
    avgPing: number | null;
    etrMs: number;
    /** how long the job has been running, refreshed on every progress event */
    elapsedMs: number;
    /** messages we still expect to have to delete (best estimate) */
    remainingEstimate: number;
}

export type ConfirmFn = (state: JobState, stats: JobStats) => Promise<boolean>;
export type ProgressFn = (state: JobState, stats: JobStats) => void;
export type StopFn = (state: JobState, stats: JobStats, reason: string) => void;

/** Injectable so the engine can be unit tested without a Discord client. */
export interface Deps {
    getCurrentUserId: () => string;
    get: (opts: { url: string; }) => Promise<any>;
    del: (opts: { url: string; }) => Promise<any>;
    /** Only overridden by tests - the client always really waits. */
    sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers (ported from undiscord/src/utils/helpers.js)
// ---------------------------------------------------------------------------

export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function msToHMS(ms: number) {
    const s = Math.max(0, ms | 0);
    const h = (s / 3.6e6) | 0;
    const m = ((s % 3.6e6) / 6e4) | 0;
    const sec = ((s % 6e4) / 1000) | 0;
    return `${h}h ${m}m ${sec}s`;
}

/** Redact potentially sensitive text before it ever hits devtools console */
export function redact(str: unknown) {
    return `<redacted len=${String(str ?? "").length}>`;
}

/** Turns a message id OR an ISO date string into a discord snowflake */
export function toSnowflake(value: string): string {
    if (/^\d+$/.test(value)) return value; // already a snowflake
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return value;
    return String(BigInt(time - 1420070400000) << 22n);
}

/**
 * Discord's `min_id` is EXCLUSIVE (it returns messages with id > min_id), so
 * the cursor is simply the newest id we have already looked at. Only when the
 * search misbehaves and hands back the same page twice do we nudge past it.
 */
export function nextSnowflake(id: string): string {
    try {
        return String(BigInt(id) + 1n);
    } catch {
        return id;
    }
}

function biggerId(a: string | null, b: string): string {
    if (a == null) return b;
    try {
        return BigInt(b) > BigInt(a) ? b : a;
    } catch {
        return a;
    }
}

function jitter(ms: number) {
    return ms + Math.floor(Math.random() * 250);
}

/**
 * Best-effort extraction of a retry_after (ms) from a RestAPI rejection.
 * Vencord's RestAPI rejects with an object that usually looks like
 * { status, body, text, ok: false } - body.retry_after is in *seconds*.
 */
function getRetryAfterMs(err: any): number | null {
    const retryAfterSec =
        err?.body?.retry_after ??
        err?.response?.body?.retry_after ??
        err?.retry_after;
    if (typeof retryAfterSec === "number" && !Number.isNaN(retryAfterSec)) {
        return Math.ceil(retryAfterSec * 1000);
    }
    return null;
}

function getStatus(err: any): number | undefined {
    return err?.status ?? err?.response?.status;
}

// ---------------------------------------------------------------------------
// Core job
// ---------------------------------------------------------------------------

const MIN_SEARCH_DELAY_MS = 400;
const MIN_DELETE_DELAY_MS = 300;
const MAX_CONSECUTIVE_HARD_ERRORS = 5;
const MAX_CONSECUTIVE_DELETE_FAILURES = 15;
const MAX_STUCK_PAGES = 3;
const MAX_LOG_ENTRIES = 80;

/**
 * How long to keep re-asking after the search returns nothing before a scan is
 * considered finished. Discord's search index lags behind real deletions, so a
 * single empty page proves nothing - we back off and ask again a few times.
 */
const EMPTY_PAGE_BACKOFF_MS = [2000, 4000, 8000, 15000];

/** what a final "is anything left?" scan costs, used for the ETA */
export const VERIFICATION_SCAN_MS = EMPTY_PAGE_BACKOFF_MS.reduce((a, b) => a + b, 0);

/** Message types the delete endpoint accepts (same list undiscord uses). */
function isDeletableType(type: number) {
    return type === 0 || (type >= 6 && type <= 21);
}

const defaultDeps: Deps = {
    getCurrentUserId: () => UserStore.getCurrentUser().id,
    get: opts => RestAPI.get(opts),
    del: opts => RestAPI.del(opts),
    sleep: undefined,
};

export class DeleteJob {
    filters: DeleteFilters;
    tuning: DeleteTuning;

    state: JobState = DeleteJob.freshState();
    stats: JobStats = DeleteJob.freshStats();

    onConfirm?: ConfirmFn;
    onProgress?: ProgressFn;
    onStop?: StopFn;

    private deps: Deps;
    private authorId: string;
    private userMinId?: string;
    private userMaxId?: string;
    private pattern?: RegExp;
    private beforeTs = 0;
    private consecutiveHardErrors = 0;
    private consecutiveDeleteFailures = 0;
    private processedIds = new Set<string>();
    private failedMessages: SearchMessage[] = [];
    private confirmationAsked = false;
    private hitFallbackUsed = false;
    private warnedAboutOthers = false;
    private stuckPages = 0;
    private stopReason?: string;

    constructor(filters: DeleteFilters, tuning: DeleteTuning, deps: Partial<Deps> = {}) {
        this.filters = filters;
        this.deps = { ...defaultDeps, ...deps };
        // SAFETY: hard-locked to the current account. This plugin only ever
        // deletes messages authored by you, no matter what options were passed.
        this.authorId = this.deps.getCurrentUserId();

        this.tuning = {
            searchDelayMs: Math.max(MIN_SEARCH_DELAY_MS, tuning.searchDelayMs),
            deleteDelayMs: Math.max(MIN_DELETE_DELAY_MS, tuning.deleteDelayMs),
            maxAttemptsPerMessage: Math.max(1, tuning.maxAttemptsPerMessage),
            maxSweeps: Math.max(1, tuning.maxSweeps | 0),
        };

        this.userMinId = filters.minId ? toSnowflake(filters.minId) : undefined;
        this.userMaxId = filters.maxId ? toSnowflake(filters.maxId) : undefined;

        if (filters.pattern) {
            try {
                this.pattern = new RegExp(filters.pattern, "i");
            } catch {
                // malformed regex -> ignore the pattern filter, same as undiscord
                this.pattern = undefined;
            }
        }
    }

    static freshState(): JobState {
        return {
            running: false,
            stopRequested: false,
            pass: 0,
            pages: 0,
            emptyPages: 0,
            cursorId: null,
            delCount: 0,
            failCount: 0,
            skipCount: 0,
            goneCount: 0,
            scannedCount: 0,
            mineCount: 0,
            notMineCount: 0,
            queuedCount: 0,
            filteredCount: 0,
            grandTotal: 0,
            messagesToDelete: [],
            skippedMessages: [],
            log: [],
        };
    }

    static freshStats(): JobStats {
        return {
            startTime: Date.now(),
            throttledCount: 0,
            throttledTotalTime: 0,
            lastPing: null,
            avgPing: null,
            etrMs: 0,
            elapsedMs: 0,
            remainingEstimate: 0,
        };
    }

    /** how long the job ran for (or has been running, if still going) */
    elapsedMs(): number {
        return (this.stats.endTime ?? Date.now()) - this.stats.startTime;
    }

    /** deletions per minute so far - 0 until at least one message is gone */
    messagesPerMinute(): number {
        const minutes = this.elapsedMs() / 60000;
        return minutes > 0 ? this.state.delCount / minutes : 0;
    }

    stop(reason = "Stopped by you.") {
        this.state.stopRequested = true;
        this.state.running = false;
        this.stopReason = reason;
        this.log("warn", reason);
    }

    // -- small utilities ----------------------------------------------------

    /** Stop-responsive sleep (chunked so the Stop button is never blocked long) */
    private async sleep(ms: number) {
        if (this.deps.sleep) {
            await this.deps.sleep(ms);
            return;
        }
        const step = 250;
        let left = ms;
        while (left > 0 && !this.state.stopRequested) {
            const slice = Math.min(step, left);
            await wait(slice);
            left -= slice;
        }
    }

    log(level: LogLevel, text: string) {
        const entry = { t: Date.now(), level, text };
        this.state.log.push(entry);
        if (this.state.log.length > MAX_LOG_ENTRIES) {
            this.state.log.splice(0, this.state.log.length - MAX_LOG_ENTRIES);
        }
    }

    private emit() {
        this.onProgress?.(this.state, this.stats);
    }

    private capReached() {
        return this.filters.maxDeletions > 0 && this.state.delCount >= this.filters.maxDeletions;
    }

    /**
     * How many of your messages we still expect to delete.
     *
     * `queuedCount - delCount` alone is useless as a countdown: cursor paging
     * only discovers ~25 messages per page, so the verified queue is almost
     * always nearly empty and the ETA would claim "a few seconds left" for the
     * entire run. Discord's own count for the query is the only forward-looking
     * signal available, so we take whichever of the two is bigger - and the UI
     * always labels the result as an estimate.
     */
    remainingEstimate(): number {
        const verifiedLeft = Math.max(0, this.state.queuedCount - this.state.delCount);
        const estimatedLeft = this.state.grandTotal > 0
            ? Math.max(0, this.state.grandTotal - this.state.mineCount)
            : 0;
        return Math.max(verifiedLeft, estimatedLeft);
    }

    private calcEtr() {
        const { searchDelayMs, deleteDelayMs } = this.tuning;
        const avgPing = this.stats.avgPing ?? 0;
        const remaining = this.remainingEstimate();

        let etr =
            searchDelayMs * Math.ceil(remaining / 25) +
            (deleteDelayMs + avgPing) * remaining;

        // A job that deleted something always runs one more full scan to prove
        // nothing is left - that scan costs the empty-page backoff sequence.
        if (this.state.pass < this.tuning.maxSweeps) {
            etr += VERIFICATION_SCAN_MS;
        }

        this.stats.etrMs = etr;
        this.stats.remainingEstimate = remaining;
        this.stats.elapsedMs = Date.now() - this.stats.startTime;
    }

    private beforeRequest() {
        this.beforeTs = Date.now();
    }
    private afterRequest() {
        this.stats.lastPing = Date.now() - this.beforeTs;
        this.stats.avgPing =
            this.stats.avgPing != null && this.stats.avgPing > 0
                ? this.stats.avgPing * 0.9 + this.stats.lastPing * 0.1
                : this.stats.lastPing;
    }

    // -- main loop ----------------------------------------------------------

    /** Main loop - mirrors UndiscordCore.run(), with sweeps and cursor paging */
    async run() {
        if (this.state.running) return;

        this.state = DeleteJob.freshState();
        this.stats = DeleteJob.freshStats();
        this.processedIds = new Set();
        this.failedMessages = [];
        this.consecutiveHardErrors = 0;
        this.consecutiveDeleteFailures = 0;
        this.confirmationAsked = false;
        this.hitFallbackUsed = false;
        this.warnedAboutOthers = false;
        this.stuckPages = 0;
        this.stopReason = undefined;
        this.state.running = true;

        let reason = "Finished - no more of your matching messages were found.";

        try {
            for (;;) {
                const outcome = await this.runPass();

                if (outcome.kind === "stopped") {
                    reason = outcome.reason;
                    break;
                }
                if (outcome.kind === "cap") {
                    reason = `Reached your configured limit of ${this.filters.maxDeletions} messages.`;
                    break;
                }
                if (outcome.kind === "aborted") {
                    reason = outcome.reason;
                    break;
                }

                // Scan finished cleanly (search ran out of results).
                if (outcome.deleted === 0) break;
                if (this.state.pass >= this.tuning.maxSweeps) {
                    this.log(
                        "warn",
                        `Stopping after ${this.state.pass} scan(s) because "Max scans" is set to ${this.tuning.maxSweeps}. Raise it in plugin settings to keep going.`
                    );
                    break;
                }

                this.log(
                    "info",
                    `Scan ${this.state.pass} deleted ${outcome.deleted} message(s). Scanning again from the oldest message in case Discord's search index missed some...`
                );
                this.emit();
            }

            if (!this.state.stopRequested && this.failedMessages.length > 0) {
                await this.retryFailedMessages();
            }

            this.state.running = false;
        } catch (err) {
            this.state.running = false;
            reason = `Stopped due to an error: ${String((err as any)?.message ?? err)}`;
            this.log("error", reason);
        }

        this.stats.endTime = Date.now();
        this.log(
            "success",
            `Run finished: ${this.state.delCount} deleted, ${this.state.failCount} failed, ${this.state.goneCount} already gone, ${this.state.filteredCount} filtered out.`
        );
        this.onStop?.(this.state, this.stats, reason);
    }

    private async runPass(): Promise<{ kind: "exhausted" | "stopped" | "cap" | "aborted"; deleted: number; reason: string; }> {
        this.state.pass++;
        this.state.emptyPages = 0;
        this.stuckPages = 0;
        // Scan strictly oldest -> newest, so `min_id` alone is a safe cursor.
        this.state.cursorId = this.userMinId ?? null;

        let deletedThisPass = 0;

        this.log(
            "info",
            `Scan ${this.state.pass}: searching for your messages...`
        );
        this.emit();

        for (;;) {
            if (this.state.stopRequested) {
                return { kind: "stopped", deleted: deletedThisPass, reason: this.stopReason ?? "Stopped by you." };
            }

            const data = await this.search();
            if (this.state.stopRequested) {
                return { kind: "stopped", deleted: deletedThisPass, reason: this.stopReason ?? "Stopped by you." };
            }

            const { toDelete, newestId, hitCount } = this.filterResponse(data);

            // Always move the cursor past everything we just looked at, even
            // when the whole page was skipped or already processed. This is
            // what guarantees the scan terminates instead of re-fetching the
            // same (stale) page over and over.
            const cursorBefore = this.state.cursorId;
            if (newestId != null) {
                // Only ever move forward: a stale index can hand back messages
                // older than the cursor, and moving backwards would re-scan.
                if (cursorBefore == null || biggerId(cursorBefore, newestId) === newestId) {
                    this.state.cursorId = newestId;
                }
                this.state.emptyPages = 0;

                if (this.state.cursorId === cursorBefore) {
                    // Page returned nothing newer than what we already saw.
                    this.stuckPages++;
                    if (this.stuckPages >= MAX_STUCK_PAGES) {
                        this.stuckPages = 0;
                        this.state.cursorId = nextSnowflake(newestId);
                        this.log(
                            "warn",
                            "Discord's search kept returning the same messages; forcing the scan forward past them."
                        );
                    }
                } else {
                    this.stuckPages = 0;
                }
            }

            this.calcEtr();
            this.emit();

            if (toDelete.length > 0) {
                if (!(await this.confirmGate())) {
                    return {
                        kind: "stopped",
                        deleted: deletedThisPass,
                        reason: this.stopReason ?? "Cancelled - you did not confirm.",
                    };
                }

                const result = await this.deleteMessagesFromList(toDelete);
                deletedThisPass += result.deleted;
                if (result.abortReason) {
                    return { kind: "aborted", deleted: deletedThisPass, reason: result.abortReason };
                }

                this.emit();

                if (this.capReached()) {
                    return { kind: "cap", deleted: deletedThisPass, reason: "" };
                }
            } else if (hitCount === 0) {
                // Nothing at all on this page. The search index lags behind
                // real deletions, so back off and ask again a few times before
                // declaring this scan finished.
                this.state.emptyPages++;
                const idx = this.state.emptyPages - 1;
                if (idx >= EMPTY_PAGE_BACKOFF_MS.length) {
                    this.log("info", `No results after ${EMPTY_PAGE_BACKOFF_MS.length} extra attempts - this scan is done.`);
                    return { kind: "exhausted", deleted: deletedThisPass, reason: "" };
                }
                const backoff = EMPTY_PAGE_BACKOFF_MS[idx];
                this.log(
                    "info",
                    `Search returned nothing (attempt ${this.state.emptyPages}/${EMPTY_PAGE_BACKOFF_MS.length}); waiting ${(backoff / 1000).toFixed(0)}s in case Discord's index is still catching up...`
                );
                this.emit();
                await this.sleep(backoff);
                continue;
            } else {
                this.log("info", `Page had ${hitCount} hit(s) but nothing deletable - moving on.`);
            }

            if (this.state.stopRequested) {
                return { kind: "stopped", deleted: deletedThisPass, reason: this.stopReason ?? "Stopped by you." };
            }

            await this.sleep(jitter(this.tuning.searchDelayMs));
        }
    }

    private async confirmGate(): Promise<boolean> {
        if (this.confirmationAsked) return true;
        // stopped before the dialog was ever answered
        if (this.state.stopRequested) return false;
        this.confirmationAsked = true;
        if (!this.onConfirm) return true;

        this.emit();
        const ok = await this.onConfirm(this.state, this.stats);
        if (!ok) {
            this.state.stopRequested = true;
            this.state.running = false;
            this.log("warn", "Cancelled - you did not confirm.");
            return false;
        }
        this.log("info", "Confirmed - starting deletions.");
        return true;
    }

    /** One more attempt at everything that failed, using the ids we already have */
    private async retryFailedMessages() {
        const list = this.failedMessages;
        this.failedMessages = [];
        this.log("info", `Retrying ${list.length} failed message(s) one more time...`);
        this.emit();

        for (let i = 0; i < list.length; i++) {
            if (this.state.stopRequested) return;
            const message = list[i];
            const result = await this.deleteMessage(message);
            if (result === "OK" || result === "GONE" || result === "SKIPPED") {
                // it went through on the second try - don't leave it counted as failed
                this.state.failCount = Math.max(0, this.state.failCount - 1);
            } else {
                this.failedMessages.push(message);
            }
            this.emit();
            if (i < list.length - 1) await this.sleep(jitter(this.tuning.deleteDelayMs));
        }
    }

    // -- search -------------------------------------------------------------

    private buildSearchUrl() {
        const { guildId, channelId } = this.filters;
        if (guildId === "@me") {
            return `/channels/${channelId}/messages/search`;
        }
        return `/guilds/${guildId}/messages/search`;
    }

    private buildQuery(): string {
        const { guildId, channelId, scopeChannelOnly, content, hasLink, hasFile, includeNsfw } =
            this.filters;

        const params: [string, string | undefined][] = [
            ["author_id", this.authorId],
            ["channel_id", guildId !== "@me" && scopeChannelOnly ? channelId : undefined],
            // exclusive lower bound: everything we already looked at is behind us
            ["min_id", this.state.cursorId ?? undefined],
            ["max_id", this.userMaxId ?? undefined],
            ["sort_by", "timestamp"],
            ["sort_order", "asc"],
            ["offset", "0"],
            ["content", content || undefined],
            // without this, a whole-server scan silently skips NSFW channels
            ["include_nsfw", includeNsfw ? "true" : undefined],
        ];

        const search = new URLSearchParams();
        for (const [k, v] of params) {
            if (v !== undefined) search.append(k, v);
        }
        if (hasLink) search.append("has", "link");
        if (hasFile) search.append("has", "file");

        return search.toString();
    }

    /** GET the search endpoint, handling 202 (not indexed) and 429 like undiscord does */
    private async search(): Promise<SearchResponse> {
        const url = this.buildSearchUrl();

        for (;;) {
            if (this.state.stopRequested) return { messages: [], total_results: 0 };

            const query = this.buildQuery();

            try {
                this.beforeRequest();
                const resp: any = await this.deps.get({ url: `${url}?${query}` });
                this.afterRequest();

                if (resp?.status === 202) {
                    const retryMs = Math.max(250, (resp.body?.retry_after ?? 1) * 1000);
                    this.stats.throttledCount++;
                    this.stats.throttledTotalTime += retryMs;
                    this.log("warn", `Channel isn't indexed yet - waiting ${(retryMs / 1000).toFixed(1)}s.`);
                    this.emit();
                    await this.sleep(retryMs);
                    continue;
                }

                this.consecutiveHardErrors = 0;
                this.state.pages++;
                return (resp?.body ?? { messages: [], total_results: 0 }) as SearchResponse;
            } catch (err) {
                this.afterRequest();
                const status = getStatus(err);

                if (status === 202) {
                    const retryMs = getRetryAfterMs(err) ?? 1000;
                    this.stats.throttledCount++;
                    this.stats.throttledTotalTime += retryMs;
                    this.log("warn", `Channel isn't indexed yet - waiting ${(retryMs / 1000).toFixed(1)}s.`);
                    this.emit();
                    await this.sleep(retryMs);
                    continue;
                }

                if (status === 429) {
                    const retryMs = getRetryAfterMs(err) ?? this.tuning.searchDelayMs;
                    this.stats.throttledCount++;
                    this.stats.throttledTotalTime += retryMs;
                    // Undiscord permanently raises the delay after being throttled
                    this.tuning.searchDelayMs = Math.max(this.tuning.searchDelayMs, retryMs);
                    this.log("warn", `Rate limited by Discord for ${(retryMs / 1000).toFixed(1)}s - raising the search delay.`);
                    this.emit();
                    await this.sleep(retryMs * 2);
                    continue;
                }

                this.consecutiveHardErrors++;
                this.log("error", `Search request failed (status ${status ?? "unknown"}) - attempt ${this.consecutiveHardErrors}/${MAX_CONSECUTIVE_HARD_ERRORS}.`);
                this.emit();
                if (this.consecutiveHardErrors >= MAX_CONSECUTIVE_HARD_ERRORS) {
                    throw new Error(`Search failed too many times in a row (status ${status ?? "?"})`);
                }
                await this.sleep(1000 * this.consecutiveHardErrors);
            }
        }
    }

    // -- filtering ----------------------------------------------------------

    /**
     * Pull the actual hits out of the response. Discord wraps every hit in a
     * "conversation" of surrounding context messages, and marks the hit with
     * `hit: true`. If a response ever omits `hit` entirely we fall back to the
     * first message of ours in each conversation - never anyone else's.
     */
    private extractHits(data: SearchResponse): SearchMessage[] {
        const conversations = Array.isArray(data?.messages) ? data.messages : [];
        const pageHasHitFlags = conversations.some(convo =>
            Array.isArray(convo) && convo.some(m => m?.hit === true)
        );

        const hits: SearchMessage[] = [];
        const seen = new Set<string>();

        for (const convo of conversations) {
            if (!Array.isArray(convo) || convo.length === 0) continue;

            let hit = pageHasHitFlags
                ? convo.find(m => m?.hit === true)
                : convo.find(m => m?.author?.id === this.authorId);

            if (!pageHasHitFlags && hit && !this.hitFallbackUsed) {
                this.hitFallbackUsed = true;
                this.log(
                    "warn",
                    "Discord's search response did not mark any message as a hit; falling back to matching your messages by author. Counts may be slightly off."
                );
            }
            if (!hit) continue;

            // In fallback mode the server-side content filter can't be trusted,
            // so re-apply it here to avoid deleting things that don't match.
            if (!pageHasHitFlags && this.filters.content) {
                const needle = this.filters.content.toLowerCase();
                if (!String(hit.content ?? "").toLowerCase().includes(needle)) continue;
            }

            if (seen.has(hit.id)) continue;
            seen.add(hit.id);
            hits.push(hit);
        }

        return hits;
    }

    private filterResponse(data: SearchResponse) {
        const total = data?.total_results ?? 0;
        if (total > this.state.grandTotal) this.state.grandTotal = total;

        const hits = this.extractHits(data);

        const mine: SearchMessage[] = [];
        let newestId: string | null = null;

        for (const m of hits) {
            this.state.scannedCount++;
            newestId = biggerId(newestId, m.id);

            // HARD SAFETY CHECK: never even look at somebody else's message.
            if (m?.author?.id !== this.authorId) {
                if (!this.processedIds.has(m.id)) {
                    this.processedIds.add(m.id);
                    this.state.notMineCount++;
                }
                continue;
            }

            if (this.processedIds.has(m.id)) continue; // seen on an earlier page
            this.processedIds.add(m.id);
            this.state.mineCount++;
            mine.push(m);
        }

        let toDelete = mine.filter(m => isDeletableType(m.type ?? 0));
        toDelete = toDelete.filter(m => (m.pinned ? this.filters.includePinned : true));
        if (this.pattern) {
            const regex = this.pattern;
            toDelete = toDelete.filter(m => regex.test(String(m.content ?? "")));
        }

        const skipped = mine.filter(m => !toDelete.some(d => d.id === m.id));

        this.state.queuedCount += toDelete.length;
        this.state.filteredCount += skipped.length;
        this.state.messagesToDelete = toDelete;
        this.state.skippedMessages = skipped;

        if (this.state.notMineCount > 0 && !this.warnedAboutOthers) {
            this.warnedAboutOthers = true;
            this.log(
                "warn",
                "Discord's search also returned other people's messages - they are counted separately and will never be deleted."
            );
        }

        return { toDelete, skipped, newestId, hitCount: hits.length };
    }

    // -- deleting -----------------------------------------------------------

    private async deleteMessagesFromList(list: SearchMessage[]) {
        let deleted = 0;

        for (let i = 0; i < list.length; i++) {
            if (this.state.stopRequested || this.capReached()) break;

            const message = list[i];

            let result: DeleteResult = "FAILED";
            for (let attempt = 0; attempt < this.tuning.maxAttemptsPerMessage; attempt++) {
                result = await this.deleteMessage(message);
                if (result !== "RETRY") break;
                if (this.state.stopRequested) break;
                if (attempt < this.tuning.maxAttemptsPerMessage - 1) {
                    await this.sleep(jitter(this.tuning.deleteDelayMs));
                }
            }

            switch (result) {
                case "OK":
                    deleted++;
                    this.consecutiveDeleteFailures = 0;
                    break;
                case "GONE":
                case "SKIPPED":
                    this.consecutiveDeleteFailures = 0;
                    break;
                default:
                    this.consecutiveDeleteFailures++;
                    this.state.failCount++;
                    this.failedMessages.push(message);
                    break;
            }

            this.calcEtr();
            this.emit();

            if (
                this.consecutiveDeleteFailures >= MAX_CONSECUTIVE_DELETE_FAILURES
            ) {
                const reason = `Stopping: ${MAX_CONSECUTIVE_DELETE_FAILURES} message deletions failed in a row (Discord is refusing them - check your permissions in that channel or slow the tool down in plugin settings).`;
                this.log("error", reason);
                return { deleted, abortReason: reason };
            }

            if (i < list.length - 1) {
                await this.sleep(jitter(this.tuning.deleteDelayMs));
            }
        }

        return { deleted, abortReason: null as string | null };
    }

    private async deleteMessage(message: SearchMessage): Promise<DeleteResult> {
        const url = `/channels/${message.channel_id}/messages/${message.id}`;
        try {
            this.beforeRequest();
            await this.deps.del({ url });
            this.afterRequest();
            this.state.delCount++;
            return "OK";
        } catch (err) {
            this.afterRequest();
            const status = getStatus(err);

            if (status === 429) {
                const retryMs = getRetryAfterMs(err) ?? this.tuning.deleteDelayMs;
                this.stats.throttledCount++;
                this.stats.throttledTotalTime += retryMs;
                this.tuning.deleteDelayMs = Math.max(this.tuning.deleteDelayMs, retryMs);
                this.log("warn", `Rate limited while deleting - raising the delete delay to ${this.tuning.deleteDelayMs}ms.`);
                this.emit();
                await this.sleep(retryMs * 2);
                return "RETRY";
            }

            const body = (err as any)?.body;
            if (status === 400 && body?.code === 50083) {
                // Thread archived - can't delete, just move on (the cursor
                // already guarantees we won't be asked about it again)
                this.state.skipCount++;
                return "SKIPPED";
            }

            if (status === 404) {
                // Already gone - not a failure, the goal is achieved either way
                this.state.goneCount++;
                return "GONE";
            }

            this.log("error", `Could not delete message ${redact(message.id)} (status ${status ?? "unknown"}).`);
            return "FAILED";
        }
    }
}

type DeleteResult = "OK" | "RETRY" | "FAILED" | "SKIPPED" | "GONE";

// ---------------------------------------------------------------------------
// Scope resolution helpers used by index.tsx
// ---------------------------------------------------------------------------

export function resolveChannelScope(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) throw new Error("Could not resolve that channel.");
    const guildId = channel.guild_id || "@me";
    return { channel, guildId };
}
