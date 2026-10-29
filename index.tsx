import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { ChannelStore, Menu, NavigationRouter, PresenceStore, React, RelationshipStore, SelectedChannelStore, StreamerModeStore, UserStore, useState, useStateFromStores, WindowStore } from "@webpack/common";

import { matchesSearch, shouldDeliver } from "./policy";

const logger = new Logger("PriorityDMs");
const settings = definePluginSettings({
    people: { type: OptionType.CUSTOM, default: {} as Record<string, string[]>, description: "Allowed people, saved separately for each Discord account." },
    popup: { type: OptionType.BOOLEAN, default: true, description: "Show a notification for allowed DMs during Do Not Disturb." },
    sound: { type: OptionType.BOOLEAN, default: true, description: "Play a soft two-note chime for allowed DMs during Do Not Disturb." },
    volume: { type: OptionType.SLIDER, default: 50, description: "Chime volume", markers: [0, 25, 50, 75, 100], stickToMarkers: false },
    preview: { type: OptionType.BOOLEAN, default: false, description: "Include message text in notifications. Off keeps message contents private." },
    respectStreamer: { type: OptionType.BOOLEAN, default: true, description: "Respect Streamer Mode's notification and sound suppression." }
});

const accountId = () => UserStore.getCurrentUser()?.id ?? "";
const allowedIds = () => settings.store.people[accountId()] ?? [];
function setAllowed(id: string, allowed: boolean) {
    const account = accountId();
    if (!account) return;
    const ids = new Set(allowedIds());
    if (allowed) ids.add(id);
    else ids.delete(id);
    settings.store.people = { ...settings.store.people, [account]: [...ids] };
}

let audio: AudioContext | undefined;
let active = false;
const nativeNotifications = new Set<Notification>();
const seen = new Set<string>();

async function chime() {
    if (!active || !settings.store.sound || settings.store.volume === 0) return;
    try {
        audio ??= new AudioContext();
        const context = audio;
        await context.resume();
        if (!active || context.state !== "running") return;
        const now = context.currentTime;
        for (const [offset, frequency] of [[0, 660], [0.13, 880]]) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = "sine";
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0, now + offset);
            gain.gain.linearRampToValueAtTime(settings.store.volume / 100 * 0.16, now + offset + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.2);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start(now + offset);
            oscillator.stop(now + offset + 0.22);
            oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        }
    } catch (error) { logger.error("Could not play notification chime", error); }
}

function popup(title: string, body: string, channelId?: string, icon?: string) {
    const onClick = () => {
        window.focus();
        if (channelId) NavigationRouter.transitionTo(`/channels/@me/${channelId}`);
    };
    if (!document.hasFocus() && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
            const notification = new Notification(title, { body, icon, silent: true });
            nativeNotifications.add(notification);
            notification.onclick = () => { onClick(); notification.close(); };
            notification.onclose = () => nativeNotifications.delete(notification);
            return;
        } catch (error) { logger.error("Desktop notification failed; using in-app notification", error); }
    }
    void showNotification({ title, body, icon, onClick, noPersist: true }).catch(error => logger.error("Notification failed", error));
}

function FriendPicker() {
    settings.use(["people"]);
    const [query, setQuery] = useState("");
    const [tab, setTab] = useState<"friends" | "allowed">("friends");
    const [feedback, setFeedback] = useState("");
    const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unavailable" : Notification.permission);
    const users = useStateFromStores([UserStore, RelationshipStore], () => {
        const ids = [...new Set([...RelationshipStore.getFriendIDs(), ...allowedIds()])];
        return ids.map(id => ({ id, user: UserStore.getUser(id), nickname: RelationshipStore.getNickname(id) ?? "", friend: RelationshipStore.isFriend(id) }));
    });
    const dnd = useStateFromStores([UserStore, PresenceStore], () => PresenceStore.getStatus(accountId()) === "dnd");
    const allowed = new Set(allowedIds());
    const rows = users.filter(({ id, user, nickname, friend }) => (tab === "allowed" ? allowed.has(id) : friend)
        && matchesSearch(query, nickname, user?.globalName ?? "", user?.username ?? "", id))
        .sort((a, b) => (a.nickname || a.user?.globalName || a.user?.username || a.id).localeCompare(b.nickname || b.user?.globalName || b.user?.username || b.id));
    return <section className="pd-panel" aria-label="Priority DM settings">
        <div className="pd-hero"><span className="pd-eyebrow">YOUR QUIET CIRCLE</span>
            <h2>Quiet for everyone.<br />Available for your people.</h2>
            <p>Choose whose direct messages can break through Do Not Disturb.</p>
            <div className="pd-pills"><span>{dnd ? "● DND is on" : "○ Waiting for DND"}</span><span>{allowed.size} allowed</span></div>
        </div>
        <div className="pd-tools">
            <div className="pd-tabs" role="group" aria-label="People list">
                <button type="button" aria-pressed={tab === "friends"} onClick={() => setTab("friends")}>Find friends</button>
                <button type="button" aria-pressed={tab === "allowed"} onClick={() => setTab("allowed")}>Allowed · {allowed.size}</button>
            </div>
            <label className="pd-label" htmlFor="pd-search">Search your friends</label>
            <input id="pd-search" className="pd-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, username, or friend nickname…" autoComplete="off" />
            <div className="pd-list" aria-label="Matching people">
                {rows.length === 0 && <div className="pd-empty">{query ? "No matches. Try another name." : tab === "allowed" ? "Your circle starts here. Find a friend and select Allow." : "No friends to show yet."}</div>}
                {rows.map(({ id, user, nickname }) => <div className="pd-row" key={id}>
                    {user ? <img className="pd-avatar" src={user.getAvatarURL(undefined, 64, false)} alt="" /> : <span className="pd-avatar pd-fallback">?</span>}
                    <div className="pd-person"><strong>{nickname || user?.globalName || user?.username || "Unknown user"}</strong><span>{user ? `@${user.username}` : id}</span></div>
                    <Button size="small" variant={allowed.has(id) ? "secondary" : "primary"} aria-label={`${allowed.has(id) ? "Remove" : "Allow"} ${user?.username ?? id}`} onClick={() => {
                        setAllowed(id, !allowed.has(id));
                        setFeedback(allowed.has(id) ? "Removed from your quiet circle." : "Added to your quiet circle. Saved automatically.");
                    }}>{allowed.has(id) ? "Remove" : "+ Allow"}</Button>
                </div>)}
            </div>
            <p className="pd-hint">Saved automatically for this account. You can also right-click a user to allow or remove them.</p>
            <div className="pd-actions"><Button size="small" variant="secondary" onClick={() => {
                if (settings.store.popup) popup("Priority DMs · Test", "This is how an allowed DM will reach you.");
                void chime();
                setFeedback(settings.store.popup || settings.store.sound ? "Test sent with your popup and sound settings. OS Focus / Do Not Disturb can still silence desktop banners." : "Popups and sound are both off. Enable one below to test it.");
            }}>Test notification</Button>
                {permission === "default" && <Button size="small" variant="secondary" onClick={async () => {
                    try { setPermission(await Notification.requestPermission()); }
                    catch { setFeedback("Desktop permission could not be requested. In-app notifications are still available."); }
                }}>Enable desktop banners</Button>}
            </div>
            {permission === "denied" && <p className="pd-hint">Desktop banners are blocked. Enable them in your browser or system settings; in-app notifications still work.</p>}
            <p className="pd-feedback" role="status">{feedback}</p>
        </div>
    </section>;
}

const userMenu: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user || user.id === accountId() || RelationshipStore.isBlockedOrIgnored(user.id)) return;
    children.push(<Menu.MenuItem id="priority-dms-allow" label={allowedIds().includes(user.id) ? "Remove from DND allowed people" : "Allow DMs during DND"} action={() => setAllowed(user.id, !allowedIds().includes(user.id))} />);
};

export default definePlugin({
    name: "PriorityDMs",
    description: "Keep Do Not Disturb on and let your chosen people through. Includes a searchable friends picker.",
    authors: [{ name: "s4ge.lol", id: 1072867100957347840n }],
    tags: ["Notifications", "Friends"],
    settings,
    settingsAboutComponent: FriendPicker,
    contextMenus: { "user-context": userMenu },
    start() { active = true; seen.clear(); },
    stop() {
        active = false;
        seen.clear();
        for (const notification of nativeNotifications) notification.close();
        nativeNotifications.clear();
        void audio?.close().catch(() => {});
        audio = undefined;
    },
    flux: {
        MESSAGE_CREATE({ message, optimistic }) {
            if (!active || !message?.author || seen.has(message.id)) return;
            const me = accountId();
            const channel = ChannelStore.getChannel(message.channel_id);
            const streamer = settings.store.respectStreamer && StreamerModeStore.enabled;
            if (!shouldDeliver({
                dnd: PresenceStore.getStatus(me) === "dnd",
                allowed: allowedIds().includes(message.author.id),
                blocked: RelationshipStore.isBlockedOrIgnored(message.author.id),
                direct: channel?.type === 1,
                self: message.author.id === me,
                optimistic: !!optimistic,
                focusedChannel: WindowStore.isFocused() && SelectedChannelStore.getChannelId() === message.channel_id,
                streamerSuppressed: streamer && StreamerModeStore.disableNotifications,
                type: message.type ?? 0
            })) return;
            seen.add(message.id);
            if (seen.size > 500) seen.delete(seen.values().next().value!);
            if (settings.store.sound && !(streamer && StreamerModeStore.disableSounds)) void chime();
            if (settings.store.popup) {
                const user = UserStore.getUser(message.author.id);
                const name = RelationshipStore.getNickname(message.author.id) || user?.globalName || message.author.username;
                const body = settings.store.preview
                    ? (message.content || (message.attachments?.length ? "Sent an attachment" : "Sent a message")).slice(0, 240)
                    : "Sent you a direct message";
                popup(`${name} · Priority DM`, body, message.channel_id, user?.getAvatarURL(undefined, 64, false));
            }
        }
    }
});
