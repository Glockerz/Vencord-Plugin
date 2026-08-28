/**
 * Ambient stubs for the modules Vencord provides at build time
 * (`@webpack/common`, `@api/*`, `@utils/*`, `@components/*`).
 *
 * They exist so `npm run typecheck` can type-check the plugin source without a
 * full Vencord checkout. Where a real type is available
 * (@vencord/discord-types, @types/react) it is used instead of `any`.
 */

declare module "@webpack/common" {
    import type { ComponentType } from "react";
    import type { Modal as ModalComponent } from "@vencord/discord-types";

    export const React: typeof import("react");
    export const useState: typeof import("react").useState;
    export const useRef: typeof import("react").useRef;
    export const useEffect: typeof import("react").useEffect;
    export const useMemo: typeof import("react").useMemo;
    export const useCallback: typeof import("react").useCallback;

    export const Modal: ModalComponent;
    export const Button: ComponentType<any> & { Sizes: Record<string, any>; Colors: Record<string, any>; };
    export const TextInput: ComponentType<any>;
    export const Forms: Record<string, any>;
    export const Menu: Record<string, any>;

    export const ChannelStore: {
        getChannel(id: string): any;
    };
    export const GuildStore: {
        getGuild(id: string): any;
    };
    export const UserStore: {
        getCurrentUser(): { id: string; username: string; };
    };
    export const Toasts: {
        Type: Record<string, string>;
        Position: Record<string, number>;
        genId(): string;
        show(data: any): void;
        pop(): void;
        create(message: string, type: string, options?: any): any;
    };
    export function showToast(message: string, type?: string, options?: any): void;

    export const RestAPI: {
        get(opts: { url: string; }): Promise<any>;
        post(opts: { url: string; body?: any; }): Promise<any>;
        put(opts: { url: string; body?: any; }): Promise<any>;
        patch(opts: { url: string; body?: any; }): Promise<any>;
        del(opts: { url: string; }): Promise<any>;
    };
}

declare module "@components/FormSwitch" {
    export interface FormSwitchProps {
        title: any;
        description?: any;
        value: boolean;
        onChange(value: boolean): void;
        className?: string;
        disabled?: boolean;
        hideBorder?: boolean;
    }
    export function FormSwitch(props: FormSwitchProps): any;
}

declare module "@utils/modal" {
    import type { RenderModal } from "@vencord/discord-types";
    export function openModal(render: RenderModal, options?: any, contextKey?: any): string;
    export function closeModal(key: string): void;
    export function closeAllModals(): void;
}

declare module "@api/Settings" {
    interface SettingDef {
        type: number;
        description?: string;
        default?: any;
        [key: string]: any;
    }

    export function definePluginSettings<S extends Record<string, SettingDef>>(settings: S): {
        store: { [K in keyof S]: S[K]["default"]; };
        use(): { [K in keyof S]: S[K]["default"]; };
        plain: Record<string, any>;
    };
}

declare module "@utils/types" {
    export enum OptionType {
        STRING = 1,
        NUMBER,
        BIGINT,
        BOOLEAN,
        SELECT,
        COMPONENT,
        CUSTOM,
    }

    interface CommandDef {
        name: string;
        description: string;
        inputType?: number;
        execute?(opts: any, ctx: { channel: { id: string; }; guild?: { id: string; }; }): any;
        [key: string]: any;
    }

    interface PluginDef {
        name: string;
        description: string;
        authors: { name: string; id: bigint; }[];
        commands?: CommandDef[];
        start?(): void;
        stop?(): void;
        [key: string]: any;
    }

    export default function definePlugin<P extends PluginDef>(plugin: P): P;
}

declare module "@api/Commands" {
    export enum ApplicationCommandInputType {
        BUILT_IN = 0,
        BUILT_IN_TEXT,
        BOT,
    }

    export interface CommandContext {
        channel: { id: string; };
        guild?: { id: string; };
    }

    export function sendBotMessage(channelId: string, message: any): void;
}

declare module "@api/ContextMenu" {
    export type NavContextMenuPatchCallback = (children: any[], props: any) => void;
    export function addContextMenuPatch(navId: string | string[], callback: NavContextMenuPatchCallback): void;
    export function removeContextMenuPatch(navId: string | string[], callback: NavContextMenuPatchCallback): void;
    export function findGroupChildrenByChildId(id: string, children: any[]): any[] | undefined;
}

declare module "@api/ChatButtons" {
    import type { ComponentType, ReactNode } from "react";

    export interface ChatBarButtonProps {
        children: ReactNode;
        tooltip: string;
        onClick(event: any): void;
        onContextMenu?(event: any): void;
        onAuxClick?(event: any): void;
        buttonProps?: Record<string, any>;
    }

    export const ChatBarButton: ComponentType<ChatBarButtonProps>;
    export type ChatBarButtonFactory = (props: any) => any;
    export type IconComponent = (props: any) => any;

    export function addChatBarButton(id: string, render: ChatBarButtonFactory, icon: IconComponent): void;
    export function removeChatBarButton(id: string): void;
}
