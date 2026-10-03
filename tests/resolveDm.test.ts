/**
 * Tests for the DM-list context menu entry.
 *
 * Discord's `user-context` menu is what opens when you right-click a person in
 * the DM list - but it is also what opens for a member in a server or for the
 * author of a message. The entry must only appear when the menu is really
 * about a private channel, and it must point at *that* channel, so the
 * resolution is the part worth testing (the menu insertion itself is three
 * lines of React).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ChannelType, resolveDmChannelId } from "../deleteMyMessages/resolveDm.ts";

/** a private channel as it arrives in the DM list's context menu */
const dmChannel = (id = "dm-1") => ({ id, type: ChannelType.DM });
const groupDmChannel = (id = "gdm-1") => ({ id, type: ChannelType.GROUP_DM });
/** a normal server channel, i.e. *not* something this plugin should offer */
const guildChannel = (id = "chan-1") => ({ id, type: 0 });

test("the DM list's menu resolves to the DM that was right-clicked", () => {
    assert.equal(
        resolveDmChannelId({ channel: dmChannel("dm-42"), user: { id: "u1" } }),
        "dm-42"
    );
});

test("group DMs in the DM list resolve too", () => {
    assert.equal(
        resolveDmChannelId({ channel: groupDmChannel("gdm-42"), user: { id: "u1" } }),
        "gdm-42"
    );
});

test("channels that only expose the store helpers are understood", () => {
    assert.equal(
        resolveDmChannelId({ channel: { id: "dm-7", isDM: () => true } }),
        "dm-7"
    );
    assert.equal(
        resolveDmChannelId({ channel: { id: "dm-8", isGroupDM: () => true } }),
        "dm-8"
    );
});

test("a server member's menu never gets the entry, even if a DM exists", () => {
    // this is the important one: the *menu* is about a server channel, so the
    // entry would open the tool for the wrong place entirely
    let lookedUp = false;
    const resolved = resolveDmChannelId(
        { channel: guildChannel(), user: { id: "u1" }, guildId: "guild-1" },
        {
            getDMFromUserId: () => {
                lookedUp = true;
                return "dm-1";
            },
        }
    );

    assert.equal(resolved, undefined);
    assert.equal(lookedUp, false, "must not even look up a DM for a server channel");

    // the channel alone is enough to know better, even without a guildId
    assert.equal(resolveDmChannelId({ channel: guildChannel(), user: { id: "u1" } }), undefined);
});

test("a guildId is also enough to stay out of the way when no channel is passed", () => {
    assert.equal(
        resolveDmChannelId(
            { user: { id: "u1" }, guildId: "guild-1" },
            { getDMFromUserId: () => "dm-1" }
        ),
        undefined
    );
});

test("menus outside a server fall back to the DM with that user", () => {
    // e.g. the friends list: no channel in the menu, but still about one person
    assert.equal(
        resolveDmChannelId({ user: { id: "u1" } }, { getDMFromUserId: id => `dm-for-${id}` }),
        "dm-for-u1"
    );
});

test("no DM stored means no entry", () => {
    assert.equal(resolveDmChannelId({ user: { id: "u1" } }, { getDMFromUserId: () => undefined }), undefined);
    assert.equal(resolveDmChannelId({ user: { id: "u1" } }, {}), undefined);
});

test("a store that throws is not fatal", () => {
    assert.equal(
        resolveDmChannelId({ user: { id: "u1" } }, {
            getDMFromUserId: () => {
                throw new Error("unknown user");
            },
        }),
        undefined
    );
});

test("a channel that exposes neither a type nor the helpers is left alone", () => {
    assert.equal(resolveDmChannelId({ channel: { id: "mystery" } }), undefined);
});

test("empty menu props are handled", () => {
    assert.equal(resolveDmChannelId(undefined), undefined);
    assert.equal(resolveDmChannelId(null), undefined);
    assert.equal(resolveDmChannelId({}), undefined);
    assert.equal(resolveDmChannelId({ channel: null, user: null }), undefined);
    assert.equal(resolveDmChannelId({ channel: { id: "" }, user: { id: "u1" } }), undefined);
});
