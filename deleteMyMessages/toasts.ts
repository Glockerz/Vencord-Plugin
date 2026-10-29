/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 you
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Toasts, across Vencord builds.
 *
 * Vencord has changed this API twice. Older builds exposed numeric types on
 * `Toasts.Type` (`MESSAGE: 0`, `SUCCESS: 1`, `FAILURE: 2`); current builds
 * dropped the whole `Toasts.Type` object - `Toasts` is only `{ show, pop }` now
 * - and take a plain string type on `showToast`.
 *
 * That change is why calling `Toasts.Type.MESSAGE` on a current build throws
 * "Cannot read properties of undefined (reading 'MESSAGE')", which happened
 * here in the middle of a job's confirmation step and took the job down with
 * it. So: use whichever of the two the installed build actually has.
 */

import { showToast, Toasts } from "@webpack/common";

export type ToastKind = "message" | "success" | "failure";

export function showJobToast(message: string, kind: ToastKind = "message") {
    const legacyType = (Toasts as any)?.Type?.[kind.toUpperCase()];
    // 0 is a valid legacy type, so only fall back on nullish values
    showToast(message, legacyType ?? kind);
}
