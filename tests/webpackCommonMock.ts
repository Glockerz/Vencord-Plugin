/**
 * Stands in for Vencord's `@webpack/common` during tests. Every call is
 * forwarded to whichever FakeDiscord the test installed, so the engine under
 * test runs its REAL default code path (RestAPI.get / RestAPI.del /
 * UserStore.getCurrentUser) - nothing is stubbed inside the engine itself.
 */

import type { FakeDiscord } from "./fakeDiscord.ts";

let backend: FakeDiscord | null = null;

export function setBackend(fake: FakeDiscord) {
    backend = fake;
}

function useBackend(): FakeDiscord {
    if (!backend) throw new Error("No FakeDiscord installed - call setBackend() first");
    return backend;
}

export const UserStore = {
    getCurrentUser: () => ({ id: useBackend().me, username: "me" }),
};

export const ChannelStore = {
    getChannel: (id: string) => useBackend().channels[id],
};

export const RestAPI = {
    get: (opts: { url: string; }) => useBackend().get(opts),
    post: (opts: { url: string; }) => useBackend().get(opts),
    del: (opts: { url: string; }) => useBackend().del(opts),
};

export const GuildStore = {
    getGuild: (_id: string) => undefined,
};

/** toasts shown by the plugin, so tests can assert on them */
export const toastLog: { message: string; type?: string | number; }[] = [];

/**
 * Mirrors what current Vencord builds actually export: `Toasts` has no `Type`
 * on purpose - the plugin has to cope without it (see deleteMyMessages/toasts.ts).
 */
export const Toasts = {
    show: (data: any) => toastLog.push(data),
    pop: () => { },
};

export function showToast(message: string, type?: string | number) {
    toastLog.push({ message, type });
}
