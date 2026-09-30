/**
 * A simulated Discord REST API, good enough to exercise the real engine:
 *
 *  - implements /messages/search (paging, min_id/max_id cursors, sort order,
 *    content filter, conversation grouping with context messages)
 *  - implements DELETE /channels/:id/messages/:id
 *  - can model Discord's LAGGING SEARCH INDEX (deleted messages keep coming
 *    back from search for a few requests) - the exact condition that made an
 *    offset-paging implementation stall
 *  - can return a wrong `total_results`, script 429/202 responses, and return
 *    other people's messages as hits
 */

export interface FakeMessage {
    id: string;
    channel_id: string;
    author: { id: string; username: string; };
    content: string;
    type?: number;
    pinned?: boolean;
    attachments?: any[];
}

export interface FakeOptions {
    me?: string;
    channelId?: string;
    guildId?: string;
    messages?: FakeMessage[];
    /** how many extra searches a deleted message stays visible for */
    indexLag?: number;
    /** report the whole channel as total_results instead of the filtered count */
    inflatedTotalResults?: boolean;
    /** ignore the author_id filter, like a misbehaving/ignored query param */
    ignoreAuthorFilter?: boolean;
    /** omit `hit: true` from search results */
    noHitFlags?: boolean;
    /** statuses to answer the first N search requests with */
    searchStatuses?: number[];
    /** statuses to answer the first N delete requests with */
    deleteStatuses?: number[];
    /** answer every delete request with this status (e.g. 500) */
    deleteAlwaysStatus?: number;
    /** 1-based search request numbers that answer with an empty page */
    emptySearchesAt?: number[];
    /** messages the index only reports after this many searches */
    lateMessages?: FakeMessage[];
    lateAfterSearches?: number;
    pageSize?: number;
}

export class FakeDiscord {
    me: string;
    channelId: string;
    guildId: string;
    messages: FakeMessage[];
    indexLag: number;
    inflatedTotalResults: boolean;
    ignoreAuthorFilter: boolean;
    noHitFlags: boolean;
    pageSize: number;

    channels: Record<string, { id: string; guild_id?: string; name: string; }> = {};

    searchCount = 0;
    deleteCount = 0;
    searchUrls: string[] = [];
    /** every id a DELETE was attempted against */
    deleteAttempts: string[] = [];
    /** ids actually deleted (i.e. really gone from the store) */
    deleted = new Set<string>();
    /** DELETE attempts against messages that are not mine */
    attemptedOnOthers: string[] = [];

    private pendingIndexRemoval = new Map<string, number>();
    private indexGone = new Set<string>();
    private searchStatuses: number[];
    private deleteStatuses: number[];
    private deleteAlwaysStatus?: number;
    private emptySearchesAt: Set<number>;
    private hiddenUntil = new Map<string, number>();

    constructor(opts: FakeOptions = {}) {
        this.me = opts.me ?? "111111111111111111";
        this.channelId = opts.channelId ?? "222222222222222222";
        this.guildId = opts.guildId ?? "333333333333333333";
        this.messages = opts.messages ?? [];
        this.indexLag = opts.indexLag ?? 0;
        this.inflatedTotalResults = opts.inflatedTotalResults ?? false;
        this.ignoreAuthorFilter = opts.ignoreAuthorFilter ?? false;
        this.noHitFlags = opts.noHitFlags ?? false;
        this.searchStatuses = [...(opts.searchStatuses ?? [])];
        this.deleteStatuses = [...(opts.deleteStatuses ?? [])];
        this.deleteAlwaysStatus = opts.deleteAlwaysStatus;
        this.pageSize = opts.pageSize ?? 25;
        this.emptySearchesAt = new Set(opts.emptySearchesAt ?? []);
        for (const m of opts.lateMessages ?? []) {
            this.messages.push(m);
            this.hiddenUntil.set(m.id, (opts.lateAfterSearches ?? 1) + 1);
        }

        this.channels[this.channelId] = {
            id: this.channelId,
            guild_id: this.guildId === "@me" ? undefined : this.guildId,
            name: "test-channel",
        };
    }

    /** ids still present in the store, sorted oldest first */
    liveIds() {
        return this.messages.filter(m => !this.deleted.has(m.id)).map(m => m.id);
    }

    private visibleInIndex(m: FakeMessage) {
        if (this.indexGone.has(m.id)) return false;
        const until = this.hiddenUntil.get(m.id);
        return until === undefined || this.searchCount >= until;
    }

    /** Discord's index forgets deletions a few requests late */
    private tickIndex() {
        for (const [id, left] of [...this.pendingIndexRemoval]) {
            if (left <= 1) {
                this.pendingIndexRemoval.delete(id);
                this.indexGone.add(id);
            } else {
                this.pendingIndexRemoval.set(id, left - 1);
            }
        }
    }

    async get(opts: { url: string; }) {
        const [path, qs = ""] = opts.url.split("?");
        if (!path.endsWith("/messages/search")) {
            throw new Error(`FakeDiscord: unexpected GET ${path}`);
        }

        this.searchCount++;
        this.searchUrls.push(opts.url);

        const scripted = this.searchStatuses.shift();
        if (scripted === 429) {
            throw { status: 429, body: { retry_after: 0.001 }, ok: false };
        }
        if (scripted === 202) {
            return { status: 202, body: { retry_after: 0.001 }, ok: false };
        }
        if (scripted && scripted >= 400) {
            throw { status: scripted, body: { message: "nope" }, ok: false };
        }

        this.tickIndex();

        if (this.emptySearchesAt.has(this.searchCount)) {
            return {
                status: 200,
                ok: true,
                body: { messages: [], total_results: 0, analytics_id: "fake" },
            };
        }

        const params = new URLSearchParams(qs);
        const authorId = params.get("author_id");
        const minId = params.get("min_id");
        const maxId = params.get("max_id");
        const content = params.get("content");
        const sortOrder = params.get("sort_order") ?? "desc";
        const offset = Number(params.get("offset") ?? "0");

        let pool = this.messages.filter(m => this.visibleInIndex(m));
        if (authorId && !this.ignoreAuthorFilter) {
            pool = pool.filter(m => m.author.id === authorId);
        }
        if (minId) pool = pool.filter(m => BigInt(m.id) > BigInt(minId));
        if (maxId) pool = pool.filter(m => BigInt(m.id) < BigInt(maxId));
        if (content) {
            const needle = content.toLowerCase();
            pool = pool.filter(m => m.content.toLowerCase().includes(needle));
        }

        const ascending = sortOrder === "asc";
        pool.sort((a, b) => (BigInt(a.id) > BigInt(b.id) === ascending ? 1 : -1));

        const matched = pool.length;
        const page = pool.slice(offset, offset + this.pageSize);

        // Discord wraps each hit in a "conversation" with context messages from
        // other people around it - only the hit is flagged.
        const conversations = page.map(hit => {
            // context messages around a hit normally belong to other people
            const others = this.messages.filter(
                m => m.id !== hit.id && m.author.id !== hit.author.id && this.visibleInIndex(m)
            );
            const idx = this.messages.findIndex(m => m.id === hit.id);
            const before = others.filter(m => this.messages.findIndex(x => x.id === m.id) < idx).slice(-1);
            const after = others.filter(m => this.messages.findIndex(x => x.id === m.id) > idx).slice(0, 1);
            const convo: any[] = [...before, this.noHitFlags ? { ...hit } : { ...hit, hit: true }, ...after];
            return convo;
        });

        return {
            status: 200,
            ok: true,
            body: {
                messages: conversations,
                total_results: this.inflatedTotalResults ? this.messages.length : matched,
                analytics_id: "fake",
            },
        };
    }

    async del(opts: { url: string; }) {
        const match = /\/channels\/([^/]+)\/messages\/([^/?]+)$/.exec(opts.url);
        if (!match) throw new Error(`FakeDiscord: unexpected DELETE ${opts.url}`);
        const id = match[2];

        this.deleteCount++;
        this.deleteAttempts.push(id);

        const message = this.messages.find(m => m.id === id);
        if (!message) throw { status: 404, body: { message: "Unknown Message" }, ok: false };

        // like the real API: deleting something that is already gone is a 404
        if (this.deleted.has(id)) {
            throw { status: 404, body: { message: "Unknown Message" }, ok: false };
        }

        if (message.author.id !== this.me) {
            this.attemptedOnOthers.push(id);
            throw { status: 403, body: { message: "Missing Permissions" }, ok: false };
        }

        const scripted = this.deleteStatuses.shift() ?? this.deleteAlwaysStatus;
        if (scripted === 500) {
            throw { status: 500, body: { message: "Internal Server Error" }, ok: false };
        }
        if (scripted === 429) {
            throw { status: 429, body: { retry_after: 0.001 }, ok: false };
        }
        if (scripted === 404) {
            this.deleted.add(id);
            throw { status: 404, body: { message: "Unknown Message" }, ok: false };
        }

        this.deleted.add(id);
        if (this.indexLag > 0) this.pendingIndexRemoval.set(id, this.indexLag);
        else this.indexGone.add(id);

        return { status: 204, ok: true, body: undefined };
    }
}

/** Build a channel where `mine` messages are mine and `others` belong to someone else */
export function buildChannel(opts: { mine: number; others: number; channelId?: string; me?: string; }) {
    const me = opts.me ?? "111111111111111111";
    const otherId = "999999999999999999";
    const channelId = opts.channelId ?? "222222222222222222";
    const messages: FakeMessage[] = [];

    let n = 0;
    const mk = (authorId: string, username: string): FakeMessage => ({
        id: String(1000000000000000n + BigInt(++n)),
        channel_id: channelId,
        author: { id: authorId, username },
        content: `message number ${n} from ${username}`,
        type: 0,
    });

    let mineLeft = opts.mine;
    let othersLeft = opts.others;
    // interleave, so other people's messages always sit between mine
    while (mineLeft > 0 || othersLeft > 0) {
        if (mineLeft > 0) {
            messages.push(mk(me, "me"));
            mineLeft--;
        }
        if (othersLeft > 0) {
            messages.push(mk(otherId, "other"));
            othersLeft--;
        }
    }

    return { messages, me, otherId, channelId };
}
