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
import {
    Button,
    ChannelStore,
    Forms,
    GuildStore,
    Modal,
    React,
    TextInput,
    useRef,
    useState,
} from "@webpack/common";

import { DeleteFilters, DeleteJob, DeleteTuning, JobState, JobStats, msToHMS, resolveChannelScope } from "./engine";
import { settings } from "./settings";

interface Props {
    initialChannelId: string;
    modalProps: RenderModalProps;
}

type Phase = "config" | "confirm" | "running" | "done";

function Row({ children }: { children: React.ReactNode; }) {
    return <div style={{ marginBottom: 12 }}>{children}</div>;
}

function Label({ children }: { children: React.ReactNode; }) {
    return (
        <Forms.FormTitle tag="h5" style={{ marginBottom: 4 }}>
            {children}
        </Forms.FormTitle>
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
            setState({ ...s });
            setStats({ ...st });
        };
        newJob.onStop = (s, st, reason) => {
            setState({ ...s });
            setStats({ ...st });
            setStopReason(reason);
            setPhase("done");
        };
        newJob.onConfirm = () => {
            setPhase("confirm");
            setState({ ...newJob.state });
            setStats({ ...newJob.stats });
            return new Promise<boolean>(resolve => {
                confirmResolveRef.current = resolve;
            });
        };

        setJob(newJob);
        setPhase("running");
        newJob.run();
    }

    function confirmAccept() {
        setPhase("running");
        confirmResolveRef.current?.(true);
        confirmResolveRef.current = null;
    }
    function confirmReject() {
        job?.stop("Cancelled - you did not confirm.");
        setPhase("done");
        confirmResolveRef.current?.(false);
        confirmResolveRef.current = null;
    }

    function stopNow() {
        job?.stop("Stopped by you.");
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

    return (
        <Modal
            {...modalProps}
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
                            onChange={v => setMaxDeletions(v.replace(/[^0-9]/g, ""))}
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
                <Row>
                    <Forms.FormTitle tag="h4">Confirm deletion</Forms.FormTitle>
                    <Forms.FormText>
                        About <b>{state.grandTotal}</b> message(s) matched so far (this may keep growing
                        as more pages are scanned). Estimated time depends on rate limits.
                    </Forms.FormText>
                    <Forms.FormText style={{ marginTop: 8 }}>
                        {dryRun
                            ? "Dry run is ON - nothing will actually be deleted."
                            : "This will PERMANENTLY delete these messages. This cannot be undone."}
                    </Forms.FormText>
                </Row>
            )}

            {(isRunningPhase || isDonePhase) && state && stats && (
                <Row>
                    <Forms.FormTitle tag="h4">
                        {isDonePhase ? "Finished" : "Running..."}
                    </Forms.FormTitle>
                    <Forms.FormText>Found so far: {state.grandTotal}</Forms.FormText>
                    <Forms.FormText>
                        {dryRun ? "Would delete" : "Deleted"}: {state.delCount} &nbsp;|&nbsp; Failed: {state.failCount}
                        &nbsp;|&nbsp; Skipped: {state.skipCount}
                    </Forms.FormText>
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
            )}
        </Modal>
    );
}

export function openDeleteMyMessagesModal(channelId: string) {
    return openModal(modalProps => (
        <DeleteMyMessagesModal initialChannelId={channelId} modalProps={modalProps} />
    ));
}
