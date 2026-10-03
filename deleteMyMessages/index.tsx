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
 *  - Reachable from the right-click menus: channels and group DMs (channel
 *    context menus) and people in the DM list (the user context menu, which is
 *    a different menu - see ./resolveDm.ts), plus /deletemymessages anywhere.
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
import { ChannelStore, Menu } from "@webpack/common";

import { registerChatBarButton, unregisterChatBarButton } from "./ChatBarButton";
import { openDeleteMyMessagesModal } from "./DeleteMyMessagesModal";
import { jobManager } from "./manager";
import { resolveDmChannelId } from "./resolveDm";
import { settings } from "./settings";

const CHANNEL_MENU_IDS: string[] = ["channel-context", "gdm-context"];
/** the menu you get when you right-click a person in the DM list */
const USER_MENU_IDS: string[] = ["user-context"];

function openForChannel(channelId: string) {
    openDeleteMyMessagesModal(channelId);
}

/** keep it short - long menu labels get truncated by Discord */
const MENU_LABEL = "Purge Messages";

function deleteMyMessagesItem(id: string, channelId: string) {
    return (
        <Menu.MenuItem
            id={id}
            label={MENU_LABEL}
            color="danger"
            action={() => openForChannel(channelId)}
        />
    );
}

const ChannelContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel?.id || !settings.store.addContextMenuEntry) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children)
        ?? findGroupChildrenByChildId("close-dm", children)
        ?? children;

    group.push(deleteMyMessagesItem("delete-my-messages", channel.id));
};

/**
 * The DM list's right-click menu (the one with "Mark As Read" / "Close DM")
 * is Discord's *user* context menu, not the channel one - that is why the
 * entry has to be patched in separately here.
 *
 * The same menu is used for users in other contexts (a member in a server, a
 * message author, ...), so the DM is resolved first and the entry is only
 * added when the menu really is about a private channel (see ./resolveDm.ts).
 */
const UserContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!settings.store.addContextMenuEntry) return;

    const channelId = resolveDmChannelId(props, {
        getDMFromUserId: userId => ChannelStore.getDMFromUserId(userId),
    });
    if (!channelId) return;

    const entry = deleteMyMessagesItem("delete-my-messages-dm", channelId);

    // sit next to Discord's own DM actions ("Mark As Read" / "Close DM"), with
    // a separator so the destructive entry is not mistaken for one of them
    const dmGroup = findGroupChildrenByChildId("close-dm", children)
        ?? findGroupChildrenByChildId("mark-channel-read", children);

    if (dmGroup) {
        const closeDm = dmGroup.findIndex(child => child?.props?.id === "close-dm");
        dmGroup.splice(closeDm === -1 ? dmGroup.length : closeDm + 1, 0, <Menu.MenuSeparator />, entry);
    } else {
        children.push(<Menu.MenuGroup>{entry}</Menu.MenuGroup>);
    }
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
        addContextMenuPatch(CHANNEL_MENU_IDS, ChannelContextMenuPatch);
        addContextMenuPatch(USER_MENU_IDS, UserContextMenuPatch);
        registerChatBarButton();
    },

    stop() {
        removeContextMenuPatch(CHANNEL_MENU_IDS, ChannelContextMenuPatch);
        removeContextMenuPatch(USER_MENU_IDS, UserContextMenuPatch);
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
                        "Opened the Delete My Messages tool. Configure your filters, review the preview, then confirm. " +
                        "**Heads up:** automating your account is self-botting, which breaks Discord's ToS and can get your account banned. " +
                        "The job keeps running in the background - reopen it with the trash icon next to the chat box.",
                });
            },
        },
    ],
});
