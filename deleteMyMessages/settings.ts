/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 you
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    searchDelay: {
        type: OptionType.NUMBER,
        description: "Delay in ms between search requests (Undiscord recommends >= 1000ms). Hard floor of 400ms is always enforced.",
        default: 1500,
    },
    deleteDelay: {
        type: OptionType.NUMBER,
        description: "Delay in ms between each message deletion (Undiscord recommends 1000-2100ms). Hard floor of 300ms is always enforced.",
        default: 1200,
    },
    maxAttempts: {
        type: OptionType.NUMBER,
        description: "How many times to retry deleting a single message before giving up on it.",
        default: 3,
    },
    addContextMenuEntry: {
        type: OptionType.BOOLEAN,
        description: "Add a \"Delete My Messages...\" option to channel/DM right-click context menus.",
        default: true,
    },
});
