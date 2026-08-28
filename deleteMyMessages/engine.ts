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
 * loop (see undiscord-core.js) on top of Vencord's authenticated RestAPI,
 * so the plugin never has to read or transmit your raw auth token.
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
    /** case-insensitive regex tested against message content */
    pattern?: string;
    /** message id or ISO date string - only delete messages after this */
    minId?: string;
    /** message id or ISO date string - only delete messages before this */
    maxId?: string;
    /** safety cap - stop after deleting this many messages (0 = unlimited) */
    maxDeletions: number;
    /** if true, never actually deletes - only counts/prints what would happen */
    dryRun: boolean;
}

export interface DeleteTuning {
    searchDelayMs: number;
    deleteDelayMs: number;
    maxAttemptsPerMessage: number;
}

export interface JobState {
    running: boolean;
    stopRequested: boolean;
    delCount: number;
    failCount: number;
    skipCount: number;
    grandTotal: number;
    offset: number;
    iterations: number;
    messagesToDelete: SearchMessage[];
    skippedMessages: SearchMessage[];
}

export interface JobStats {
    startTime: number;
    endTime?: number;
    throttledCount: number;
    throttledTotalTime: number;
    lastPing: number | null;
    avgPing: number | null;
    etrMs: number;
}

export type ConfirmFn = (state: JobState, stats: JobStats) => Promise<boolean>;
export type ProgressFn = (state: JobState, stats: JobStats) => void;
export type StopFn = (state: JobState, stats: JobStats, reason: string) => void;

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

export class DeleteJob {
    filters: DeleteFilters;
    tuning: DeleteTuning;

    state: JobState = DeleteJob.freshState();
    stats: JobStats = DeleteJob.freshStats();

    onConfirm?: ConfirmFn;
    onProgress?: ProgressFn;
    onStop?: StopFn;

    private authorId: string;
    private beforeTs = 0;
    private consecutiveHardErrors = 0;

    constructor(filters: DeleteFilters, tuning: DeleteTuning) {
        this.filters = filters;
        // SAFETY: hard-locked to the current account. This plugin only ever
        // deletes messages authored by you, no matter what options were passed.
        this.authorId = UserStore.getCurrentUser().id;

        this.tuning = {
            searchDelayMs: Math.max(MIN_SEARCH_DELAY_MS, tuning.searchDelayMs),
            deleteDelayMs: Math.max(MIN_DELETE_DELAY_MS, tuning.deleteDelayMs),
            maxAttemptsPerMessage: Math.max(1, tuning.maxAttemptsPerMessage),
        };
    }

    static freshState(): JobState {
        return {
            running: false,
            stopRequested: false,
            delCount: 0,
            failCount: 0,
            skipCount: 0,
            grandTotal: 0,
            offset: 0,
            iterations: 0,
            messagesToDelete: [],
            skippedMessages: [],
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
        };
    }

    stop(reason = "Stopped by you.") {
        this.state.stopRequested = true;
        this.state.running = false;
        this.onStop?.(this.state, this.stats, reason);
    }

    private calcEtr() {
        const { searchDelayMs, deleteDelayMs } = this.tuning;
        const avgPing = this.stats.avgPing ?? 0;
        this.stats.etrMs =
            searchDelayMs * Math.round(this.state.grandTotal / 25) +
            (deleteDelayMs + avgPing) * this.state.grandTotal;
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

    /** Main loop - mirrors UndiscordCore.run() */
    async run() {
        if (this.state.running) return;

        this.state = DeleteJob.freshState();
        this.state.running = true;
        this.stats = DeleteJob.freshStats();

        let askedConfirmation = false;

        try {
            do {
                if (this.state.stopRequested) break;

                this.state.iterations++;

                const searchResponse = await this.search();
                if (this.state.stopRequested) break;

                this.filterResponse(searchResponse);

                this.calcEtr();
                this.onProgress?.(this.state, this.stats);

                if (this.state.messagesToDelete.length > 0) {
                    if (!askedConfirmation) {
                        askedConfirmation = true;
                        const confirmed = this.onConfirm
                            ? await this.onConfirm(this.state, this.stats)
                            : true;
                        if (!confirmed) {
                            this.state.running = false;
                            this.onStop?.(this.state, this.stats, "Cancelled - you did not confirm.");
                            return;
                        }
                    }

                    if (this.filters.dryRun) {
                        // Count as "would delete" and advance offset so we don't loop forever
                        this.state.delCount += this.state.messagesToDelete.length;
                        this.state.offset += this.state.messagesToDelete.length;
                    } else {
                        await this.deleteMessagesFromList();
                    }

                    if (
                        this.filters.maxDeletions > 0 &&
                        this.state.delCount >= this.filters.maxDeletions
                    ) {
                        this.state.running = false;
                        this.onStop?.(
                            this.state,
                            this.stats,
                            `Reached your configured limit of ${this.filters.maxDeletions} messages.`
                        );
                        return;
                    }
                } else if (this.state.skippedMessages.length > 0) {
                    // Nothing deletable on this page (e.g. all system messages) -
                    // adjust offset and keep paging, same trick undiscord uses.
                    this.state.offset += this.state.skippedMessages.length;
                } else {
                    // Empty page => we've reached the end of the results.
                    this.state.running = false;
                }

                if (!this.state.running || this.state.stopRequested) break;

                await wait(jitter(this.tuning.searchDelayMs));
            } while (this.state.running);

            this.stats.endTime = Date.now();
            if (!this.state.stopRequested) {
                this.onStop?.(this.state, this.stats, "Finished - no more matching messages found.");
            }
        } catch (err) {
            this.state.running = false;
            this.onStop?.(this.state, this.stats, `Stopped due to an error: ${String((err as any)?.message ?? err)}`);
        }
    }

    private buildSearchUrl() {
        const { guildId, channelId, scopeChannelOnly } = this.filters;
        if (guildId === "@me") {
            return `/channels/${channelId}/messages/search`;
        }
        return `/guilds/${guildId}/messages/search`;
    }

    private buildQuery(): string {
        const { guildId, channelId, scopeChannelOnly, minId, maxId, content, hasLink, hasFile } =
            this.filters;

        const params: [string, string | undefined][] = [
            ["author_id", this.authorId],
            [
                "channel_id",
                guildId !== "@me" && scopeChannelOnly ? channelId : undefined,
            ],
            ["min_id", minId ? toSnowflake(minId) : undefined],
            ["max_id", maxId ? toSnowflake(maxId) : undefined],
            ["sort_by", "timestamp"],
            ["sort_order", "desc"],
            ["offset", String(this.state.offset)],
            ["content", content || undefined],
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
    private async search(): Promise<{ messages: SearchMessage[][]; total_results: number; }> {
        const url = this.buildSearchUrl();
        const query = this.buildQuery();

        for (;;) {
            if (this.state.stopRequested) return { messages: [], total_results: this.state.grandTotal };

            try {
                this.beforeRequest();
                const resp: any = await RestAPI.get({ url: `${url}?${query}` });
                this.afterRequest();

                if (resp.status === 202) {
                    const retryMs = (resp.body?.retry_after ?? 1) * 1000;
                    this.stats.throttledCount++;
                    this.stats.throttledTotalTime += retryMs;
                    await wait(retryMs);
                    continue;
                }

                this.consecutiveHardErrors = 0;
                return resp.body;
            } catch (err) {
                this.afterRequest();
                const status = getStatus(err);

                if (status === 202) {
                    const retryMs = getRetryAfterMs(err) ?? 1000;
                    this.stats.throttledCount++;
                    this.stats.throttledTotalTime += retryMs;
                    await wait(retryMs);
                    continue;
                }

                if (status === 429) {
                    const retryMs = getRetryAfterMs(err) ?? this.tuning.searchDelayMs;
                    this.stats.throttledCount++;
                    this.stats.throttledTotalTime += retryMs;
                    // Undiscord permanently raises the delay after being throttled
                    this.tuning.searchDelayMs = Math.max(this.tuning.searchDelayMs, retryMs);
                    await wait(retryMs * 2);
                    continue;
                }

                this.consecutiveHardErrors++;
                if (this.consecutiveHardErrors >= MAX_CONSECUTIVE_HARD_ERRORS) {
                    throw new Error(`Search failed too many times in a row (status ${status ?? "?"})`);
                }
                await wait(1000 * this.consecutiveHardErrors);
            }
        }
    }

    private filterResponse(data: { messages: SearchMessage[][]; total_results: number; }) {
        const total = data.total_results ?? 0;
        if (total > this.state.grandTotal) this.state.grandTotal = total;

        const discovered = (data.messages ?? [])
            .map(convo => convo.find(m => m.hit === true))
            .filter(Boolean) as SearchMessage[];

        let toDelete = discovered;
        // deletable message types only (system messages etc. can't be deleted)
        toDelete = toDelete.filter(m => m.type === 0 || (m.type >= 6 && m.type <= 21));
        toDelete = toDelete.filter(m => (m.pinned ? this.filters.includePinned : true));

        if (this.filters.pattern) {
            try {
                const regex = new RegExp(this.filters.pattern, "i");
                toDelete = toDelete.filter(m => regex.test(m.content));
            } catch {
                // malformed regex -> ignore the pattern filter, same as undiscord
            }
        }

        const skipped = discovered.filter(m => !toDelete.find(d => d.id === m.id));

        this.state.messagesToDelete = toDelete;
        this.state.skippedMessages = skipped;
    }

    private async deleteMessagesFromList() {
        const list = this.state.messagesToDelete;
        for (let i = 0; i < list.length; i++) {
            if (this.state.stopRequested) return;

            if (
                this.filters.maxDeletions > 0 &&
                this.state.delCount >= this.filters.maxDeletions
            ) {
                return;
            }

            const message = list[i];

            let attempt = 0;
            for (;;) {
                const result = await this.deleteMessage(message);
                if (result === "RETRY") {
                    attempt++;
                    if (attempt >= this.tuning.maxAttemptsPerMessage) break;
                    await wait(jitter(this.tuning.deleteDelayMs));
                    continue;
                }
                break;
            }

            this.calcEtr();
            this.onProgress?.(this.state, this.stats);

            if (i < list.length - 1) {
                await wait(jitter(this.tuning.deleteDelayMs));
            }
        }
    }

    private async deleteMessage(message: SearchMessage): Promise<"OK" | "RETRY" | "FAILED" | "SKIPPED"> {
        const url = `/channels/${message.channel_id}/messages/${message.id}`;
        try {
            this.beforeRequest();
            await RestAPI.del({ url });
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
                await wait(retryMs * 2);
                return "RETRY";
            }

            const body = (err as any)?.body;
            if (status === 400 && body?.code === 50083) {
                // Thread archived - skip permanently, bump offset like undiscord does
                this.state.offset++;
                this.state.skipCount++;
                return "SKIPPED";
            }

            if (status === 404) {
                // Already gone - treat as a skip, not a failure
                this.state.skipCount++;
                return "SKIPPED";
            }

            this.state.failCount++;
            return "FAILED";
        }
    }
}

// ---------------------------------------------------------------------------
// Scope resolution helpers used by index.tsx
// ---------------------------------------------------------------------------

export function resolveChannelScope(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) throw new Error("Could not resolve that channel.");
    const guildId = channel.guild_id || "@me";
    return { channel, guildId };
}
