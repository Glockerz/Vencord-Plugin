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
 * On top of Undiscord:
 *  - Jobs run in the BACKGROUND (see ./manager.ts) - close the window, switch
 *    channel or server, and the job keeps going. A chat-box button shows live
 *    progress and reopens the window.
 *  - Cursor paging + repeated scans, so it does not stop before every one of
 *    your messages is gone even when Discord's search index lags.
 *  - Counts come from messages actually inspected, not from Discord's
 *    unreliable total_results estimate.
 *
 * This never reads or transmits your Discord auth token - all requests go
 * through Vencord's own authenticated RestAPI, the same way Discord's client
 * itself performs the requests.
 *
 * WARNING: automating your account is self-botting, which Discord's Terms of
 * Service forbid and which can get your account terminated. See the warning
 * shown in the tool itself.
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { addContextMenuPatch, findGroupChildrenByChildId, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { Menu } from "@webpack/common";

import { registerChatBarButton, unregisterChatBarButton } from "./ChatBarButton";
import { openDeleteMyMessagesModal } from "./DeleteMyMessagesModal";
import { jobManager } from "./manager";
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
        "Bulk-delete your own messages in a channel, DM or whole server, in the background. Automating your account is self-botting and against Discord's ToS - it can get your account banned.",
    // Static attribution shown in the plugin list - purely cosmetic, not tied
    // to whichever account runs the plugin. Message deletion always targets
    // UserStore.getCurrentUser().id at runtime (see engine.ts), regardless
    // of what's set here. Feel free to put your own name/id in, or leave it.
    authors: [{ name: "You", id: 0n }],
    settings,

    dependencies: ["CommandsAPI"],

    start() {
        addContextMenuPatch(["channel-context", "gdm-context"], ChannelContextMenuPatch);
        registerChatBarButton();
    },

    stop() {
        removeContextMenuPatch(["channel-context", "gdm-context"], ChannelContextMenuPatch);
        unregisterChatBarButton();
        // never leave a job deleting with the plugin turned off
        if (jobManager.isRunning) jobManager.stop("Stopped because the plugin was disabled.");
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
                        "Opened the Delete My Messages tool. Configure your filters, review the dry run, then confirm. " +
                        "**Heads up:** automating your account is self-botting, which breaks Discord's ToS and can get your account banned. " +
                        "The job keeps running in the background - reopen it with the trash icon next to the chat box.",
                });
            },
        },
    ],
});
