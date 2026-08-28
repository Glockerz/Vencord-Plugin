/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 you
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * A permanent button in the chat box toolbar.
 *
 * It is the way back into a job that is running in the background: no matter
 * which channel/DM/server you are looking at, the button is there, it shows
 * live progress in its tooltip, and clicking it reopens the progress window.
 */

import { addChatBarButton, ChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { useEffect, useState } from "@webpack/common";

import { openDeleteMyMessagesModal } from "./DeleteMyMessagesModal";
import { msToHMS } from "./engine";
import { jobManager } from "./manager";

const BUTTON_ID = "delete-my-messages";

export function TrashIcon(props: { width?: number; height?: number; className?: string; style?: any; }) {
    return (
        <svg
            width={props.width ?? 20}
            height={props.height ?? 20}
            viewBox="0 0 24 24"
            fill="currentColor"
            className={props.className}
            style={props.style}
        >
            <path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
            <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zm4 11H8v-8h2v8zm4 0h-2v-8h2v8z" />
        </svg>
    );
}

function DeleteMyMessagesButton(props: { channel: { id: string; }; }) {
    const [, forceRender] = useState(0);
    useEffect(() => jobManager.subscribe(() => forceRender(x => x + 1)), []);

    const entry = jobManager.current;

    let tooltip = "Delete My Messages...";
    let color: string | undefined;

    if (jobManager.needsConfirmation) {
        tooltip = "Delete My Messages - waiting for you to confirm";
        color = "var(--text-warning, #faa61a)";
    } else if (jobManager.isRunning && entry) {
        tooltip = `Delete My Messages - running: ${entry.state.delCount} deleted in ${msToHMS(entry.job.elapsedMs())}`;
        color = "var(--status-danger)";
    } else if (entry?.done) {
        tooltip = `Delete My Messages - last run deleted ${entry.state.delCount}`;
    }

    return (
        <ChatBarButton tooltip={tooltip} onClick={() => openDeleteMyMessagesModal(props.channel.id)}>
            <TrashIcon style={color ? { color } : undefined} />
        </ChatBarButton>
    );
}

export function registerChatBarButton() {
    addChatBarButton(BUTTON_ID, DeleteMyMessagesButton as any, TrashIcon as any);
}

export function unregisterChatBarButton() {
    removeChatBarButton(BUTTON_ID);
}
