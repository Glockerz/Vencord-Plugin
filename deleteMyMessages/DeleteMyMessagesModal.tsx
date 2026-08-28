/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 you
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Modal UI for configuring, confirming and monitoring a deletion job.
 * Loosely mirrors the popup UI of victornpb/undiscord.
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
    useRef,
    useState,
} from "@webpack/common";

import { DeleteFilters, DeleteJob, DeleteTuning, JobState, JobStats, SearchMessage, msToHMS, resolveChannelScope } from "./engine";
import { settings } from "./settings";

interface Props {
    initialChannelId: string;
    modalProps: RenderModalProps;
}

type Phase = "config" | "confirm" | "running" | "done";

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
    const [phase, setPhase] = useState<Phase>("config");

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

    // --- job state -------------------------------------------------------------
    const [job, setJob] = useState<DeleteJob | null>(null);
    const [state, setState] = useState<JobState | null>(null);
    const [stats, setStats] = useState<JobStats | null>(null);
    const [stopReason, setStopReason] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const confirmResolveRef = useRef<((v: boolean) => void) | null>(null);

    if (!channel) {
        return (
            <Modal {...modalProps} title="Delete My Messages">
                <Forms.FormText style={{ margin: "16px 0" }}>
                    Could not resolve the current channel.
                </Forms.FormText>
            </Modal>
        );
    }

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
            searchDelayMs: settings.store.searchDelay,
            deleteDelayMs: settings.store.deleteDelay,
            maxAttemptsPerMessage: settings.store.maxAttempts,
            maxSweeps: settings.store.maxScans,
        };
    }

    function start() {
        setError(null);
        setStopReason(null);

        let filters: DeleteFilters;
        try {
            resolveChannelScope(initialChannelId);
            filters = buildFilters();
        } catch (e: any) {
            setError(String(e?.message ?? e));
            return;
        }

        const newJob = new DeleteJob(filters, buildTuning());

        newJob.onProgress = (s, st) => {
            setState({ ...s, log: [...s.log] });
            setStats({ ...st });
        };
        newJob.onStop = (s, st, reason) => {
            setState({ ...s, log: [...s.log] });
            setStats({ ...st });
            setStopReason(reason);
            setPhase("done");
        };
        newJob.onConfirm = () => {
            setState({ ...newJob.state, log: [...newJob.state.log] });
            setStats({ ...newJob.stats });
            setPhase("confirm");
            return new Promise<boolean>(resolve => {
                confirmResolveRef.current = resolve;
            });
        };

        setJob(newJob);
        setPhase("running");
        newJob.run();
    }

    function confirmAccept() {
        const resolve = confirmResolveRef.current;
        confirmResolveRef.current = null;
        setPhase("running");
        resolve?.(true);
    }
    function confirmReject() {
        const resolve = confirmResolveRef.current;
        confirmResolveRef.current = null;
        // the engine flips to the "done" phase itself via onStop
        resolve?.(false);
    }

    function stopNow() {
        job?.stop("Stopped by you.");
    }

    /** Closing the window must never leave a job running with no Stop button */
    function handleClose() {
        const resolve = confirmResolveRef.current;
        confirmResolveRef.current = null;
        resolve?.(false);
        job?.stop("Stopped because the window was closed.");
        modalProps.onClose();
    }

    const isConfigPhase = phase === "config";
    const isConfirmPhase = phase === "confirm";
    const isRunningPhase = phase === "running";
    const isDonePhase = phase === "done";

    const actions =
        isConfigPhase
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
                    { text: "Yes, proceed", variant: "critical-primary" as const, onClick: confirmAccept },
                    { text: "Cancel", variant: "secondary" as const, onClick: confirmReject },
                ]
                : isRunningPhase
                    ? [{ text: "Stop", variant: "critical-primary" as const, onClick: stopNow }]
                    : [{ text: "Close", variant: "secondary" as const, onClick: modalProps.onClose }];

    const preview = state?.messagesToDelete.slice(0, PREVIEW_COUNT) ?? [];

    return (
        <Modal
            {...modalProps}
            onClose={handleClose}
            title="Delete My Messages"
            subtitle="Bulk-delete only your own messages - Undiscord-style safeguards apply."
            actions={actions}
        >
            <Forms.FormText style={{ margin: "0 0 16px" }}>
                Inspired by{" "}
                <a href="https://github.com/victornpb/undiscord" target="_blank" rel="noreferrer">
                    Undiscord
                </a>
                . This only ever deletes messages sent by you, and this action cannot be undone.
            </Forms.FormText>

            {isConfigPhase && (
                <>
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
                    <Row>
                        <Forms.FormTitle tag="h4">Confirm deletion</Forms.FormTitle>
                        <Forms.FormText>
                            This first page holds <b>{state.messagesToDelete.length}</b> of <b>your</b> messages that
                            match your filters. The tool then keeps scanning oldest → newest and deletes{" "}
                            <b>every message of yours</b> that matches - the totals below grow as it goes, so this
                            is not the final number.
                        </Forms.FormText>
                        {state.notMineCount > 0 && (
                            <Forms.FormText style={{ marginTop: 4 }}>
                                {state.notMineCount} message(s) from <b>other people</b> turned up in the search
                                results. They are counted separately and will never be deleted.
                            </Forms.FormText>
                        )}
                        <Forms.FormText style={{ marginTop: 8 }}>
                            {dryRun
                                ? "Dry run is ON - nothing will actually be deleted."
                                : "This will PERMANENTLY delete these messages. This cannot be undone."}
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

            {(isRunningPhase || isDonePhase) && state && stats && (
                <>
                    <Row>
                        <Forms.FormTitle tag="h4">
                            {isDonePhase ? (dryRun ? "Dry run finished" : "Finished") : "Running..."}
                        </Forms.FormTitle>

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
                            <b>{dryRun ? "Would delete" : "Deleted"}:</b> {state.delCount}
                            &nbsp;|&nbsp; <b>Failed:</b> {state.failCount}
                            &nbsp;|&nbsp; <b>Already gone:</b> {state.goneCount}
                            &nbsp;|&nbsp; <b>Skipped:</b> {state.skipCount}
                        </Forms.FormText>
                        <Forms.FormText style={{ color: "var(--text-muted)" }}>
                            Scan {state.pass} of up to {settings.store.maxScans} · {state.pages} search page(s) ·{" "}
                            {state.scannedCount} search hit(s) inspected
                        </Forms.FormText>
                        {state.grandTotal > 0 && (
                            <Forms.FormText style={{ color: "var(--text-muted)" }}>
                                Discord's own estimate for the query was ~{state.grandTotal} - that number is
                                unreliable and is not used to decide anything.
                            </Forms.FormText>
                        )}
                        <Forms.FormText>
                            Rate-limited {stats.throttledCount} time(s), total wait {msToHMS(stats.throttledTotalTime)}
                        </Forms.FormText>
                        {isRunningPhase && (
                            <Forms.FormText>Estimated time remaining: {msToHMS(stats.etrMs)}</Forms.FormText>
                        )}
                        {isDonePhase && stopReason && (
                            <Forms.FormText style={{ marginTop: 8 }}>{stopReason}</Forms.FormText>
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
