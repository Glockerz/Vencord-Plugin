/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 you
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * DeleteMyMessages
 *
 * Bulk-deletes YOUR OWN messages in a channel/DM or across a whole server.
 * Directly inspired by (and re-implementing the safety mechanisms of)
 * victornpb/undiscord: https://github.com/victornpb/undiscord
 *
 * Safeguards ported from Undiscord:
 *  - Author-locked: only ever deletes messages sent by the currently logged
 *    in account (never other users' messages), regardless of any filter.
 *  - Confirmation step before anything is deleted, showing an estimate of
 *    how many messages match and how long it will take.
 *  - Configurable search/delete delays with enforced safe minimums.
 *  - Automatic backoff + retry on HTTP 429 (rate limit) and 202 (search
 *    index not ready yet) responses, permanently raising the delay after
 *    being throttled - exactly like undiscord-core.js does.
 *  - A visible Stop button to abort a running job at any time.
 *  - "Dry run" mode on by default so you can preview what would be deleted.
 *  - A hard "max messages to delete" cap you can set for extra safety.
 *
 * This never reads or transmits your Discord auth token - all requests go
 * through Vencord's own authenticated RestAPI, the same way Discord's client
 * itself performs the requests.
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { addContextMenuPatch, findGroupChildrenByChildId, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { Menu } from "@webpack/common";

import { openDeleteMyMessagesModal } from "./DeleteMyMessagesModal";
import { settings } from "./settings";

function openForChannel(channelId: string) {
    openDeleteMyMessagesModal(channelId);
}

const ChannelContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel?.id || !settings.store.addContextMenuEntry) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children)
        ?? findGroupChildrenByChildId("close-dm", children)
        ?? children;

    group.push(
        <Menu.MenuItem
            id="delete-my-messages"
            label="Delete My Messages..."
            color="danger"
            action={() => openForChannel(channel.id)}
        />
    );
};

export default definePlugin({
    name: "DeleteMyMessages",
    description:
        "Bulk-delete your own messages in a channel, DM, or across a whole server - with Undiscord-style rate-limit safeguards, confirmation, and dry-run preview.",
    // Static attribution shown in the plugin list - purely cosmetic, not tied
    // to whichever account runs the plugin. Message deletion always targets
    // UserStore.getCurrentUser().id at runtime (see engine.ts), regardless
    // of what's set here. Feel free to put your own name/id in, or leave it.
    authors: [{ name: "You", id: 0n }],
    settings,

    dependencies: ["CommandsAPI"],

    start() {
        addContextMenuPatch(["channel-context", "gdm-context"], ChannelContextMenuPatch);
    },

    stop() {
        removeContextMenuPatch(["channel-context", "gdm-context"], ChannelContextMenuPatch);
    },

    commands: [
        {
            name: "deletemymessages",
            description: "Open the Delete My Messages tool for this channel (bulk-delete your own messages)",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_opts, ctx) => {
                openForChannel(ctx.channel.id);
                sendBotMessage(ctx.channel.id, {
                    content:
                        "Opened the Delete My Messages tool. Configure your filters, review the dry run, then confirm.",
                });
            },
        },
    ],
});
