/**
 * Tests for the plugin's toast helper.
 *
 * This exists because of a real crash: current Vencord builds no longer expose
 * `Toasts.Type`, and calling `Toasts.Type.MESSAGE` threw
 * "Cannot read properties of undefined (reading 'MESSAGE')" from inside a
 * job's confirmation step, taking the whole job down with it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { showJobToast, type ToastKind } from "../deleteMyMessages/toasts.ts";
import { Toasts, toastLog } from "./webpackCommonMock.ts";

/** the mock matches current Vencord (no Toasts.Type), like a fresh build */
function currentBuild(t: any) {
    delete (Toasts as any).Type;
    toastLog.length = 0;
    t.after(() => {
        delete (Toasts as any).Type;
        toastLog.length = 0;
    });
}

/** Vencord used to ship numeric types on Toasts.Type */
function legacyBuild(t: any) {
    (Toasts as any).Type = { MESSAGE: 0, SUCCESS: 1, FAILURE: 2, CUSTOM: 3 };
    toastLog.length = 0;
    t.after(() => {
        delete (Toasts as any).Type;
        toastLog.length = 0;
    });
}

test("a current build (no Toasts.Type) gets a plain string type", t => {
    currentBuild(t);

    assert.equal((Toasts as any).Type, undefined, "the mock should model current Vencord");

    // this is the call that used to throw
    assert.doesNotThrow(() => showJobToast("waiting for you to confirm"));
    assert.deepEqual(toastLog.at(-1), { message: "waiting for you to confirm", type: "message" });

    showJobToast("done", "success");
    assert.equal(toastLog.at(-1)!.type, "success");

    showJobToast("with failures", "failure");
    assert.equal(toastLog.at(-1)!.type, "failure");
});

test("a legacy build still gets the numeric Toasts.Type value", t => {
    legacyBuild(t);

    const expectations: Array<[ToastKind, number]> = [["message", 0], ["success", 1], ["failure", 2]];
    for (const [kind, expected] of expectations) {
        showJobToast(kind, kind);
        assert.equal(toastLog.at(-1)!.type, expected, `${kind} should map to ${expected}`);
    }
});

test("legacy type 0 (MESSAGE) is not mistaken for 'missing'", t => {
    legacyBuild(t);

    // 0 is falsy - a naive `legacyType || kind` fallback would send "message"
    // instead of the numeric 0 that old builds expect
    showJobToast("hi");
    assert.equal(toastLog.at(-1)!.type, 0);
});
