/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 you
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Working out *which* private channel a context menu is about.
 *
 * The DM list's right-click menu is Discord's `user-context` menu, so the same
 * patch also fires for user context menus that have nothing to do with a DM
 * (a member in a server, the author of a message in a channel, ...). Adding a
 * "Delete My Messages" entry to those would be wrong: the channel the menu was
 * opened on is a *server* channel, which is what the channel menu is for.
 *
 * So the entry is only offered when the menu really is about a private
 * channel, and this module decides that. It deliberately has no Discord
 * imports, which keeps the trickiest part of the feature unit-testable
 * (see tests/resolveDm.test.ts).
 */

/** the ChannelType values a DM can have */
export const ChannelType = {
    DM: 1,
    GROUP_DM: 3,
} as const;

/** the shape of a `user-context` menu's props (all of it is optional) */
export interface UserContextProps {
    /** the channel the menu was opened on, when there is one */
    channel?: {
        id?: string;
        type?: number;
        /** store helpers, in case `type` is not exposed */
        isDM?: () => boolean;
        isGroupDM?: () => boolean;
    } | null;
    /** the user the menu was opened on, when there is one */
    user?: { id?: string; } | null;
    /** set when the menu belongs to a server, e.g. the member list */
    guildId?: string | null;
}

/** the parts of Discord's ChannelStore this module needs */
export interface DmChannelLookup {
    getDMFromUserId?(userId: string): string | undefined;
}

function isPrivateChannel(channel: UserContextProps["channel"]): boolean {
    if (!channel?.id) return false;
    if (channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM) return true;

    // some builds only expose the store's own helpers, so fall back to them
    try {
        return channel.isDM?.() === true || channel.isGroupDM?.() === true;
    } catch {
        return false;
    }
}

/**
 * Returns the id of the private channel a user context menu refers to, or
 * undefined when the menu is not about a DM.
 *
 *  - right-clicking the DM in the DM list (or a user inside a DM) hands us the
 *    private channel itself, so we can simply use it;
 *  - anywhere else in a server the menu's channel is a server channel, and the
 *    plugin stays out of the way;
 *  - a menu with no channel at all (the friends list, a profile popout) is
 *    still a private context, so the DM with that user is looked up in the
 *    channel store.
 */
export function resolveDmChannelId(
    props: UserContextProps | undefined | null,
    lookup: DmChannelLookup = {}
): string | undefined {
    const channel = props?.channel;

    if (channel?.id) return isPrivateChannel(channel) ? channel.id : undefined;

    // no channel to judge by - only trust this outside of a server
    if (props?.guildId) return undefined;

    const userId = props?.user?.id;
    if (!userId) return undefined;

    try {
        return lookup.getDMFromUserId?.(userId) || undefined;
    } catch {
        // the store throws for users you have never DMed with
        return undefined;
    }
}
