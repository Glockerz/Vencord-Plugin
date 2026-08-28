/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 you
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Background job manager.
 *
 * A deletion job lives here, NOT in the modal. That is what lets you close the
 * window, switch to another DM/server, or browse around while it keeps
 * deleting - the modal is only ever a view onto whatever is running.
 */

import { showToast, Toasts } from "@webpack/common";

import { DeleteJob, type DeleteFilters, type DeleteTuning, type Deps, type JobState, type JobStats } from "./engine";

export interface ManagedJob {
    id: string;
    job: DeleteJob;
    filters: DeleteFilters;
    startedAt: number;
    state: JobState;
    stats: JobStats;
    reason: string | null;
    done: boolean;
    /** the channel/DM the job was started from, for the "open" button */
    originChannelId: string;
}

type Listener = () => void;

class JobManager {
    current: ManagedJob | null = null;
    private listeners = new Set<Listener>();
    private confirmResolve: ((accepted: boolean) => void) | null = null;

    subscribe(listener: Listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit() {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // one broken view must not break the job
            }
        }
    }

    private snapshot(state: JobState, stats: JobStats) {
        return { state: { ...state, log: [...state.log] }, stats: { ...stats } };
    }

    get isRunning() {
        return this.current != null && !this.current.done;
    }

    /** the job is paused on the "are you sure?" dialog and needs an answer */
    get needsConfirmation() {
        return this.confirmResolve != null;
    }

    get hasJob() {
        return this.current != null;
    }

    start(filters: DeleteFilters, tuning: DeleteTuning, originChannelId: string, deps: Partial<Deps> = {}): ManagedJob {
        if (this.isRunning) throw new Error("A deletion job is already running - stop it before starting another.");

        const job = new DeleteJob(filters, tuning, deps);

        const entry: ManagedJob = {
            id: `${Date.now()}`,
            job,
            filters,
            startedAt: Date.now(),
            state: job.state,
            stats: job.stats,
            reason: null,
            done: false,
            originChannelId,
        };
        this.current = entry;
        this.confirmResolve = null;

        job.onProgress = (state, stats) => {
            const snap = this.snapshot(state, stats);
            entry.state = snap.state;
            entry.stats = snap.stats;
            this.emit();
        };

        job.onConfirm = (state, stats) => {
            const snap = this.snapshot(state, stats);
            entry.state = snap.state;
            entry.stats = snap.stats;
            // the answer can come from any UI instance, whenever it is opened
            const answer = new Promise<boolean>(resolve => {
                this.confirmResolve = resolve;
            });
            this.emit();
            showToast("DeleteMyMessages is waiting for you to confirm the deletion", Toasts.Type.MESSAGE);
            return answer;
        };

        job.onStop = (state, stats, reason) => {
            const snap = this.snapshot(state, stats);
            entry.state = snap.state;
            entry.stats = snap.stats;
            entry.reason = reason;
            entry.done = true;
            this.confirmResolve = null;
            this.emit();

            const seconds = Math.round(job.elapsedMs() / 1000);
            showToast(
                `DeleteMyMessages: ${state.delCount} deleted in ${seconds}s - ${reason}`,
                state.failCount > 0 ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS
            );
        };

        // deliberately not awaited - the job runs in the background from here
        job.run();
        this.emit();

        return entry;
    }

    confirm(accepted: boolean) {
        const resolve = this.confirmResolve;
        this.confirmResolve = null;
        resolve?.(accepted);
        this.emit();
    }

    stop(reason = "Stopped by you.") {
        // a job parked on the "are you sure?" dialog is awaiting a promise -
        // release it, or stopping it would hang the job forever
        if (this.confirmResolve) {
            const resolve = this.confirmResolve;
            this.confirmResolve = null;
            resolve(false);
        }
        this.current?.job.stop(reason);
    }

    /** dismiss a finished job from the UI (does nothing while one is running) */
    clear() {
        if (this.current?.done) this.current = null;
        this.emit();
    }
}

export const jobManager = new JobManager();
