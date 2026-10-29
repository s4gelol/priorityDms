/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface DeliveryContext {
    dnd: boolean;
    allowed: boolean;
    blocked: boolean;
    direct: boolean;
    self: boolean;
    optimistic: boolean;
    focusedChannel: boolean;
    streamerSuppressed: boolean;
    type: number;
}

export function shouldDeliver(c: DeliveryContext): boolean {
    return c.dnd && c.allowed && c.direct && !c.blocked && !c.self
        && !c.optimistic && !c.focusedChannel
        && !c.streamerSuppressed && [0, 19, 20].includes(c.type);
}

export function matchesSearch(query: string, ...names: string[]): boolean {
    const needle = query.trim().toLocaleLowerCase().replace(/^@/, "");
    return names.some(name => name.toLocaleLowerCase().includes(needle));
}
