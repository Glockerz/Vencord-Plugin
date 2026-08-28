/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 you
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Modal UI for configuring, confirming and monitoring a deletion job.
 *
 * This is only a *view*: the job itself lives in ./manager.ts, so closing this
 * window (or switching to another channel) leaves it running.
 */

import { FormSwitch } from "@components/FormSwitch";
import { openModal } from "@utils/modal";
import { RenderModalProps } from "@vencord/discord-types";
import type { ReactNode } from "react";
import {
    Button,
    ChannelStore,
    Forms,
    GuildStore,
    Modal,
    TextInput,
    useEffect,
    useState,
} from "@webpack/common";

import { msToHMS, resolveChannelScope, type DeleteFilters, type DeleteTuning, type JobState, type SearchMessage } from "./engine";
import { jobManager } from "./manager";
import { settings } from "./settings";

interface Props {
    initialChannelId: string;
    modalProps: RenderModalProps;
}

const PREVIEW_COUNT = 10;
const PREVIEW_SNIPPET = 90;

function Row({ children }: { children: ReactNode; }) {
    return <div style={{ marginBottom: 12 }}>{children}</div>;
}

function Label({ children }: { children: ReactNode; }) {
    return (
        <Forms.FormTitle tag="h5" style={{ marginBottom: 4 }}>
            {children}
        </Forms.FormTitle>
    );
}

function Warning({ children }: { children?: ReactNode; }) {
    return (
        <div
            style={{
                marginBottom: 16,
                padding: "10px 12px",
                borderRadius: 4,
                border: "1px solid var(--text-danger)",
                background: "var(--background-secondary)",
            }}
        >
            <Forms.FormTitle tag="h5" style={{ color: "var(--text-danger)", marginBottom: 4 }}>
                Read this before you start
            </Forms.FormTitle>
            <Forms.FormText style={{ fontSize: 13 }}>
                This automates your account, which Discord calls <b>self-botting</b> and forbids in its
                Terms of Service. Accounts have been <b>terminated</b> for it. Deleted messages
                cannot be recovered.
            </Forms.FormText>
            <Forms.FormText style={{ fontSize: 13, marginTop: 6 }}>
                If you go ahead: keep the delays high, delete in small batches, dry-run first, and
                stop immediately if Discord starts rate-limiting you.
            </Forms.FormText>
            {children}
        </div>
    );
}

function snippet(message: SearchMessage) {
    const hasAttachment = (message.attachments?.length ?? 0) > 0;
    const content = String(message.content ?? "").replace(/\s+/g, " ").trim();
    const text = content.length > PREVIEW_SNIPPET ? content.slice(0, PREVIEW_SNIPPET) + "..." : content;
    if (!text) return hasAttachment ? "[attachment]" : "[empty message]";
    return hasAttachment ? `${text} [attachment]` : text;
}

function LogBox({ state }: { state: JobState; }) {
    const lines = state.log.slice(-12);
    if (lines.length === 0) return null;

    const colorFor = (level: string) =>
        level === "error"
            ? "var(--text-danger)"
            : level === "warn"
                ? "var(--text-warning, #faa61a)"
                : level === "success"
                    ? "var(--text-positive)"
                    : "var(--text-muted)";

    return (
        <div
            style={{
                marginTop: 12,
                maxHeight: 180,
                overflowY: "auto",
                fontFamily: "var(--font-code, monospace)",
                fontSize: 12,
                lineHeight: 1.5,
                background: "var(--background-secondary)",
                borderRadius: 4,
                padding: "8px 10px",
            }}
        >
            {lines.map((entry, i) => (
                <div key={i} style={{ color: colorFor(entry.level), whiteSpace: "pre-wrap" }}>
                    {entry.text}
                </div>
            ))}
        </div>
    );
}

export function DeleteMyMessagesModal({ initialChannelId, modalProps }: Props) {
    // re-render whenever the background job reports something, plus once a
    // second while it runs so the elapsed clock ticks
    const [, forceRender] = useState(0);
    useEffect(() => jobManager.subscribe(() => forceRender(x => x + 1)), []);

    const entry = jobManager.current;
    const isRunning = jobManager.isRunning;

    useEffect(() => {
        if (!isRunning) return;
        const timer = setInterval(() => forceRender(x => x + 1), 1000);
        return () => clearInterval(timer);
    }, [isRunning]);

    // --- scope -------------------------------------------------------------
    const channel = ChannelStore.getChannel(initialChannelId);
    const guildId = channel?.guild_id ?? "@me";
    const guildName = guildId !== "@me" ? GuildStore.getGuild(guildId)?.name : undefined;
    const [scope, setScope] = useState<"channel" | "guild">("channel");

    // --- filters -------------------------------------------------------------
    const [content, setContent] = useState("");
    const [pattern, setPattern] = useState("");
    const [hasLink, setHasLink] = useState(false);
    const [hasFile, setHasFile] = useState(false);
    const [includePinned, setIncludePinned] = useState(false);
    const [includeNsfw, setIncludeNsfw] = useState(true);
    const [minId, setMinId] = useState("");
    const [maxId, setMaxId] = useState("");
    const [maxDeletions, setMaxDeletions] = useState("0");
    const [dryRun, setDryRun] = useState(true);

    // --- speed (settable here so you don't have to dig into plugin settings) ---
    const [searchDelay, setSearchDelay] = useState(String(settings.store.searchDelay));
    const [deleteDelay, setDeleteDelay] = useState(String(settings.store.deleteDelay));
    const [error, setError] = useState<string | null>(null);

    if (!channel) {
        return (
            <Modal {...modalProps} title="Delete My Messages">
                <Forms.FormText style={{ margin: "16px 0" }}>
                    Could not resolve the current channel.
                </Forms.FormText>
            </Modal>
        );
    }

    const isConfigPhase = !entry;
    const isConfirmPhase = !!entry && jobManager.needsConfirmation;
    const isRunningPhase = !!entry && !entry.done && !jobManager.needsConfirmation;
    const isDonePhase = !!entry?.done;

    const state = entry?.state ?? null;
    const stats = entry?.stats ?? null;

    function buildFilters(): DeleteFilters {
        return {
            guildId,
            channelId: initialChannelId,
            scopeChannelOnly: scope === "channel" || guildId === "@me",
            content: content.trim() || undefined,
            hasLink,
            hasFile,
            includePinned,
            includeNsfw,
            pattern: pattern.trim() || undefined,
            minId: minId.trim() || undefined,
            maxId: maxId.trim() || undefined,
            maxDeletions: Math.max(0, parseInt(maxDeletions, 10) || 0),
            dryRun,
        };
    }

    function buildTuning(): DeleteTuning {
        return {
            searchDelayMs: Math.max(400, parseInt(searchDelay, 10) || settings.store.searchDelay),
            deleteDelayMs: Math.max(300, parseInt(deleteDelay, 10) || settings.store.deleteDelay),
            maxAttemptsPerMessage: settings.store.maxAttempts,
            maxSweeps: settings.store.maxScans,
        };
    }

    function start() {
        setError(null);
        try {
            resolveChannelScope(initialChannelId);
            jobManager.start(buildFilters(), buildTuning(), initialChannelId);
        } catch (e: any) {
            setError(String(e?.message ?? e));
        }
    }

    const preview = state?.messagesToDelete.slice(0, PREVIEW_COUNT) ?? [];
    const originChannel = entry ? ChannelStore.getChannel(entry.originChannelId) : undefined;
    const originName = (originChannel as any)?.name ?? entry?.originChannelId ?? initialChannelId;

    const actions = isConfigPhase
        ? [
            {
                text: dryRun ? "Start dry run" : "Start deleting",
                variant: "critical-primary" as const,
                onClick: start,
            },
            { text: "Cancel", variant: "secondary" as const, onClick: modalProps.onClose },
        ]
        : isConfirmPhase
            ? [
                { text: "Yes, proceed", variant: "critical-primary" as const, onClick: () => jobManager.confirm(true) },
                { text: "Cancel", variant: "secondary" as const, onClick: () => jobManager.confirm(false) },
            ]
            : isRunningPhase
                ? [
                    { text: "Stop now", variant: "critical-primary" as const, onClick: () => jobManager.stop("Stopped by you.") },
                    {
                        text: "Keep running in background",
                        variant: "secondary" as const,
                        onClick: modalProps.onClose,
                    },
                ]
                : [
                    { text: "Close", variant: "secondary" as const, onClick: modalProps.onClose },
                    { text: "Start another", variant: "primary" as const, onClick: () => jobManager.clear() },
                ];

    return (
        <Modal
            {...modalProps}
            title="Delete My Messages"
            subtitle="Automates your account (self-botting) - against Discord's ToS and can get you banned."
            actions={actions}
        >
            {isConfigPhase && (
                <>
                    <Warning />

                    <Row>
                        <Label>Where</Label>
                        <Forms.FormText>
                            Channel: <b>#{(channel as any).name ?? initialChannelId}</b>
                            {guildName && <> in <b>{guildName}</b></>}
                        </Forms.FormText>
                        {guildId !== "@me" && (
                            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    color={scope === "channel" ? Button.Colors.BRAND : Button.Colors.TRANSPARENT}
                                    onClick={() => setScope("channel")}
                                >
                                    This channel only
                                </Button>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    color={scope === "guild" ? Button.Colors.BRAND : Button.Colors.TRANSPARENT}
                                    onClick={() => setScope("guild")}
                                >
                                    Whole server
                                </Button>
                            </div>
                        )}
                    </Row>

                    <Row>
                        <Label>Speed</Label>
                        <div style={{ display: "flex", gap: 12 }}>
                            <div style={{ flex: 1 }}>
                                <Forms.FormText style={{ fontSize: 12 }}>Search delay (ms, min 400)</Forms.FormText>
                                <TextInput
                                    value={searchDelay}
                                    onChange={(v: string) => setSearchDelay(v.replace(/[^0-9]/g, ""))}
                                    placeholder="1500"
                                />
                            </div>
                            <div style={{ flex: 1 }}>
                                <Forms.FormText style={{ fontSize: 12 }}>Delete delay (ms, min 300)</Forms.FormText>
                                <TextInput
                                    value={deleteDelay}
                                    onChange={(v: string) => setDeleteDelay(v.replace(/[^0-9]/g, ""))}
                                    placeholder="1200"
                                />
                            </div>
                        </div>
                        <Forms.FormText style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                            Lower is faster and more likely to get your account flagged. Defaults come from
                            Settings → Vencord → Plugins → DeleteMyMessages.
                        </Forms.FormText>
                    </Row>

                    <Row>
                        <Label>Content contains (optional)</Label>
                        <TextInput value={content} onChange={setContent} placeholder="e.g. secret" />
                    </Row>

                    <Row>
                        <Label>Regex pattern filter (optional, case-insensitive)</Label>
                        <TextInput value={pattern} onChange={setPattern} placeholder="e.g. ^lol" />
                    </Row>

                    <Row>
                        <FormSwitch title="Has link" value={hasLink} onChange={setHasLink} hideBorder />
                        <FormSwitch title="Has file" value={hasFile} onChange={setHasFile} hideBorder />
                        <FormSwitch title="Include pinned messages" value={includePinned} onChange={setIncludePinned} hideBorder />
                        <FormSwitch
                            title="Include NSFW channels"
                            description="Needed for a whole-server scan to see your messages in NSFW channels."
                            value={includeNsfw}
                            onChange={setIncludeNsfw}
                            hideBorder
                        />
                    </Row>

                    <Row>
                        <div style={{ display: "flex", gap: 12 }}>
                            <div style={{ flex: 1 }}>
                                <Label>After message ID / date</Label>
                                <TextInput value={minId} onChange={setMinId} placeholder="id or 2024-01-01" />
                            </div>
                            <div style={{ flex: 1 }}>
                                <Label>Before message ID / date</Label>
                                <TextInput value={maxId} onChange={setMaxId} placeholder="id or 2024-06-01" />
                            </div>
                        </div>
                    </Row>

                    <Row>
                        <Label>Max messages to delete (0 = no limit)</Label>
                        <TextInput
                            value={maxDeletions}
                            onChange={(v: string) => setMaxDeletions(v.replace(/[^0-9]/g, ""))}
                            placeholder="0"
                        />
                    </Row>

                    <Row>
                        <FormSwitch
                            title="Dry run (don't actually delete)"
                            description="Recommended: preview counts without deleting anything first."
                            value={dryRun}
                            onChange={setDryRun}
                            hideBorder
                        />
                    </Row>

                    {error && (
                        <Forms.FormText style={{ color: "var(--text-danger)" }}>{error}</Forms.FormText>
                    )}
                </>
            )}

            {isConfirmPhase && state && (
                <>
                    <Warning />
                    <Row>
                        <Forms.FormTitle tag="h4">Confirm deletion</Forms.FormTitle>
                        <Forms.FormText>
                            This first page holds <b>{state.messagesToDelete.length}</b> of <b>your</b> messages that
                            match your filters. The tool then keeps scanning oldest → newest and deletes{" "}
                            <b>every message of yours</b> that matches, so this is not the final number.
                        </Forms.FormText>
                        {state.notMineCount > 0 && (
                            <Forms.FormText style={{ marginTop: 4 }}>
                                {state.notMineCount} message(s) from <b>other people</b> turned up in the search
                                results. They are counted separately and will never be deleted.
                            </Forms.FormText>
                        )}
                        <Forms.FormText style={{ marginTop: 8 }}>
                            {entry?.filters.dryRun
                                ? "Dry run is ON - nothing will actually be deleted."
                                : "This will PERMANENTLY delete these messages, in the background, until you press Stop."}
                        </Forms.FormText>
                    </Row>

                    {preview.length > 0 && (
                        <Row>
                            <Label>Preview (first {preview.length} of {state.messagesToDelete.length} on this page)</Label>
                            <div
                                style={{
                                    maxHeight: 160,
                                    overflowY: "auto",
                                    background: "var(--background-secondary)",
                                    borderRadius: 4,
                                    padding: "8px 10px",
                                    fontSize: 12,
                                    lineHeight: 1.5,
                                }}
                            >
                                {preview.map(m => (
                                    <div key={m.id} style={{ whiteSpace: "pre-wrap" }}>
                                        <b style={{ color: "var(--text-normal)" }}>{m.author?.username ?? "you"}</b>
                                        <span style={{ color: "var(--text-muted)" }}>{` — ${snippet(m)}`}</span>
                                    </div>
                                ))}
                            </div>
                        </Row>
                    )}

                    <LogBox state={state} />
                </>
            )}

            {(isRunningPhase || isDonePhase) && state && stats && entry && (
                <>
                    <Row>
                        <Forms.FormTitle tag="h4">
                            {isDonePhase
                                ? (entry.filters.dryRun ? "Dry run finished" : "Finished")
                                : "Running in the background..."}
                        </Forms.FormTitle>

                        {isRunningPhase && (
                            <Forms.FormText style={{ color: "var(--text-muted)" }}>
                                You can close this window, switch channel or server - it keeps going. Reopen it
                                from the trash icon next to the chat box, or with /deletemymessages.
                            </Forms.FormText>
                        )}

                        <Forms.FormText>
                            <b>Time running:</b> {msToHMS(entry.job.elapsedMs())}
                            {isDonePhase && <>&nbsp;(total)</>}
                            &nbsp;|&nbsp; <b>Speed:</b> {entry.job.messagesPerMinute().toFixed(1)} msg/min
                        </Forms.FormText>
                        <Forms.FormText>
                            <b>Your messages found:</b> {state.mineCount}
                            {state.notMineCount > 0 && (
                                <> &nbsp;(plus {state.notMineCount} from other people, ignored)</>
                            )}
                        </Forms.FormText>
                        <Forms.FormText>
                            <b>Matching your filters:</b> {state.queuedCount}
                            {state.filteredCount > 0 && (
                                <> &nbsp;({state.filteredCount} of yours skipped by pinned/type/regex filters)</>
                            )}
                        </Forms.FormText>
                        <Forms.FormText>
                            <b>{entry.filters.dryRun ? "Would delete" : "Deleted"}:</b> {state.delCount}
                            &nbsp;|&nbsp; <b>Failed:</b> {state.failCount}
                            &nbsp;|&nbsp; <b>Already gone:</b> {state.goneCount}
                            &nbsp;|&nbsp; <b>Skipped:</b> {state.skipCount}
                        </Forms.FormText>
                        {isRunningPhase && (
                            <Forms.FormText>
                                <b>Time remaining:</b> ~{msToHMS(stats.etrMs)}
                                <span style={{ color: "var(--text-muted)" }}>
                                    {" "}(estimate - about {stats.remainingEstimate} message(s) left; Discord's
                                    search count is approximate, so treat this as a rough guide)
                                </span>
                            </Forms.FormText>
                        )}
                        <Forms.FormText style={{ color: "var(--text-muted)" }}>
                            Scan {state.pass} of up to {settings.store.maxScans} · {state.pages} search page(s) ·{" "}
                            {state.scannedCount} search hit(s) inspected · target #{originName}
                        </Forms.FormText>
                        {state.grandTotal > 0 && (
                            <Forms.FormText style={{ color: "var(--text-muted)" }}>
                                Discord's own estimate for the query was ~{state.grandTotal} - used only for the
                                time estimate above, never to decide when to stop.
                            </Forms.FormText>
                        )}
                        <Forms.FormText>
                            Rate-limited {stats.throttledCount} time(s), total wait {msToHMS(stats.throttledTotalTime)}
                        </Forms.FormText>
                        {isDonePhase && entry.reason && (
                            <Forms.FormText style={{ marginTop: 8 }}>{entry.reason}</Forms.FormText>
                        )}
                    </Row>

                    <LogBox state={state} />
                </>
            )}
        </Modal>
    );
}

export function openDeleteMyMessagesModal(channelId: string) {
    return openModal(modalProps => (
        <DeleteMyMessagesModal initialChannelId={channelId} modalProps={modalProps} />
    ));
}
