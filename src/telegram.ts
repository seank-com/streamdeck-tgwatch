import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import streamDeck from "@elgato/streamdeck";
import QRCode from "qrcode";
import { Api, TelegramClient, utils } from "teleproto";
import { NewMessage, Raw, type NewMessageEvent } from "teleproto/events/index.js";
import { Logger } from "teleproto/extensions/index.js";
import { LogLevel } from "teleproto/extensions/Logger.js";
import { returnBigInt } from "teleproto/Helpers.js";
import { StringSession } from "teleproto/sessions/index.js";

/** Where the API credentials and login session live (outside the plugin folder, so updates keep you logged in). */
const CONFIG_DIR = path.join(os.homedir(), ".streamdeck-telegram-watch");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const POLL_MS = 60_000;
const DEBOUNCE_MS = 400;

export type ChatKind = "user" | "group" | "channel";

export type ChatInfo = {
	id: string;
	title: string;
	kind: ChatKind;
	username?: string;
	/** Phone number, when the user shares it with you (e.g. contacts). */
	phone?: string;
	/** Raw channel id (unmarked) for supergroups/channels — used for tg:// links. */
	channelId?: string;
	/** Profile photo as base64 JPEG, if the chat has one. */
	photo?: string;
	/** Last message in the chat is from someone else (not a service message). */
	waitingReply: boolean;
	unread: number;
	unreadMark: boolean;
	topMessageId?: number;
	loaded: boolean;
};

export type AuthState =
	| "needsCredentials"
	| "connecting"
	| "awaitingQr"
	| "awaitingCode"
	| "awaitingPassword"
	| "ready"
	| "error";

export type Status = { state: AuthState; message?: string; me?: string; /** PNG data URL of the login QR code. */ qr?: string };

type Config = { apiId: number; apiHash: string; session?: string };

type PickerEntry = { id: string; title: string; kind: ChatKind };

class TelegramService extends EventEmitter {
	status: Status = { state: "needsCredentials" };

	#client?: TelegramClient;
	#config?: Config;
	#chats = new Map<string, ChatInfo>();
	#watchCount = new Map<string, number>();
	#picker: PickerEntry[] = [];
	#debounce = new Map<string, NodeJS.Timeout>();
	#poll?: NodeJS.Timeout;
	#pending?: { resolve: (v: string) => void; reject: (e: Error) => void };
	#cancelled = false;

	// ── lifecycle ────────────────────────────────────────────────────────────

	/** Called once at plugin start: reconnect with the saved session, if any. */
	async init(): Promise<void> {
		const cfg = await loadConfig();
		if (!cfg?.session) {
			this.#setStatus({ state: "needsCredentials" });
			return;
		}
		this.#config = cfg;
		try {
			this.#setStatus({ state: "connecting" });
			const client = this.#makeClient(cfg, cfg.session);
			await client.connect();
			if (!(await client.checkAuthorization())) {
				this.#setStatus({ state: "needsCredentials", message: "Session expired — log in again." });
				return;
			}
			await this.#onReady();
		} catch (err) {
			this.#fail(err);
		}
	}

	/** Interactive login. The code / 2FA password arrive later via submit(). */
	async login(apiId: number, apiHash: string, phone: string): Promise<void> {
		await this.#teardown();
		this.#cancelled = false;
		const cfg: Config = { apiId, apiHash };
		try {
			this.#setStatus({ state: "connecting", message: "Requesting code…" });
			const client = this.#makeClient(cfg, "");
			await client.start({
				phoneNumber: phone,
				phoneCode: (viaApp) =>
					this.#ask(
						"awaitingCode",
						viaApp
							? "Telegram sent the code as a message in the \"Telegram\" chat on your phone/desktop app."
							: "Telegram sent the code by SMS.",
					),
				password: (hint) => this.#ask("awaitingPassword", hint ? `2FA password (hint: ${hint})` : "2FA password"),
				onError: async (err) => {
					if (this.#cancelled) return true;
					const msg = errorText(err);
					// Wrong code/password: let the user try again.
					if (/PHONE_CODE_INVALID|PASSWORD_HASH_INVALID/.test(msg)) {
						this.#setStatus({ ...this.status, message: `${msg} — try again.` });
						return false;
					}
					this.#setStatus({ state: "error", message: msg });
					return true;
				},
			});
			await this.#finishLogin(cfg, client);
		} catch (err) {
			if (this.#cancelled) {
				this.#setStatus({ state: "needsCredentials", message: "Login cancelled." });
			} else {
				this.#fail(err);
			}
		}
	}

	/** QR login: scan from the phone (Settings → Devices → Link Desktop Device). No code needed. */
	async loginQr(apiId: number, apiHash: string): Promise<void> {
		await this.#teardown();
		this.#cancelled = false;
		const cfg: Config = { apiId, apiHash };
		try {
			this.#setStatus({ state: "connecting", message: "Getting QR code…" });
			const client = this.#makeClient(cfg, "");
			await client.connect();
			await client.signInUserWithQrCode(
				{ apiId, apiHash },
				{
					qrCode: async ({ token }) => {
						const url = `tg://login?token=${token.toString("base64url")}`;
						const qr = await QRCode.toDataURL(url, { margin: 2, width: 240 });
						this.#setStatus({
							state: "awaitingQr",
							qr,
							message: "On your phone: Telegram → Settings → Devices → Link Desktop Device, then scan this.",
						});
					},
					password: (hint) => this.#ask("awaitingPassword", hint ? `2FA password (hint: ${hint})` : "2FA password"),
					onError: async (err) => {
						if (this.#cancelled) return true;
						const msg = errorText(err);
						if (/PASSWORD_HASH_INVALID/.test(msg)) {
							this.#setStatus({ ...this.status, message: `${msg} — try again.` });
							return false;
						}
						this.#setStatus({ state: "error", message: msg });
						return true;
					},
				},
			);
			await this.#finishLogin(cfg, client);
		} catch (err) {
			if (this.#cancelled) {
				this.#setStatus({ state: "needsCredentials", message: "Login cancelled." });
			} else {
				this.#fail(err);
			}
		}
	}

	async #finishLogin(cfg: Config, client: TelegramClient): Promise<void> {
		this.#config = { ...cfg, session: client.session.save() as unknown as string };
		await saveConfig(this.#config);
		await this.#onReady();
	}

	/** Deliver the login code or 2FA password the user typed in the property inspector. */
	submit(value: string): void {
		const p = this.#pending;
		this.#pending = undefined;
		p?.resolve(value.trim());
	}

	cancelLogin(): void {
		this.#cancelled = true;
		const p = this.#pending;
		this.#pending = undefined;
		p?.reject(new Error("cancelled"));
		void this.#teardown().then(() => this.#setStatus({ state: "needsCredentials", message: "Login cancelled." }));
	}

	async logout(): Promise<void> {
		try {
			await this.#client?.invoke(new Api.auth.LogOut());
		} catch {
			/* already invalid */
		}
		await this.#teardown();
		await rm(CONFIG_FILE, { force: true });
		this.#config = undefined;
		this.#chats.clear();
		this.#picker = [];
		this.#setStatus({ state: "needsCredentials", message: "Logged out." });
	}

	// ── watching ─────────────────────────────────────────────────────────────

	watch(id: string): void {
		this.#watchCount.set(id, (this.#watchCount.get(id) ?? 0) + 1);
		if (this.status.state === "ready") void this.refresh(id);
	}

	unwatch(id: string): void {
		const n = (this.#watchCount.get(id) ?? 1) - 1;
		if (n <= 0) this.#watchCount.delete(id);
		else this.#watchCount.set(id, n);
	}

	getChat(id: string): ChatInfo | undefined {
		return this.#chats.get(id);
	}

	/** Chats for the property-inspector dropdown, grouped like sdpi-components expects. */
	pickerItems() {
		const group = (kind: ChatKind) =>
			this.#picker.filter((c) => c.kind === kind).map((c) => ({ label: c.title, value: c.id }));
		return [
			{ label: "Direct messages", children: group("user") },
			{ label: "Groups", children: group("group") },
			{ label: "Channels", children: group("channel") },
		].filter((g) => g.children.length > 0);
	}

	async reloadPicker(): Promise<void> {
		if (this.status.state === "ready") await this.#loadDialogs();
	}

	/** Re-query a chat's top message + unread count (and photo/title the first time). */
	async refresh(id: string): Promise<void> {
		const client = this.#client;
		if (!client || this.status.state !== "ready") return;
		try {
			const input = await client.getInputEntity(returnBigInt(id));
			const res = await client.invoke(
				new Api.messages.GetPeerDialogs({ peers: [input] }), // teleproto wraps it in InputDialogPeer
			);
			const dialog = res.dialogs[0];
			if (!(dialog instanceof Api.Dialog)) return;
			const top = res.messages.find((m) => m.id === dialog.topMessage);

			const info: ChatInfo = this.#chats.get(id) ?? {
				id,
				title: "",
				kind: "user",
				waitingReply: false,
				unread: 0,
				unreadMark: false,
				loaded: false,
			};
			info.waitingReply = top instanceof Api.Message && !top.out;
			info.unread = dialog.unreadCount;
			info.unreadMark = !!dialog.unreadMark;
			info.topMessageId = dialog.topMessage;

			if (!info.loaded) {
				const entity = await client.getEntity(input);
				info.title = utils.getDisplayName(entity) || "Chat";
				if (entity instanceof Api.User) {
					info.kind = "user";
					info.username = entity.username ?? entity.usernames?.[0]?.username;
					info.phone = entity.phone ?? undefined;
				} else if (entity instanceof Api.Channel) {
					info.kind = entity.megagroup || entity.gigagroup ? "group" : "channel";
					info.username = entity.username ?? entity.usernames?.[0]?.username;
					info.channelId = entity.id.toString();
				} else {
					info.kind = "group";
				}
				try {
					const photo = await client.downloadProfilePhoto(entity, { isBig: false });
					if (Buffer.isBuffer(photo) && photo.length > 0) info.photo = photo.toString("base64");
				} catch (err) {
					streamDeck.logger.warn(`No photo for ${id}: ${errorText(err)}`);
				}
				info.loaded = true;
			}

			this.#chats.set(id, info);
			this.emit("chat", info);
		} catch (err) {
			streamDeck.logger.error(`refresh(${id}) failed: ${errorText(err)}`);
			if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(errorText(err))) {
				await this.#teardown();
				this.#setStatus({ state: "needsCredentials", message: "Session revoked — log in again." });
			}
		}
	}

	async markRead(id: string): Promise<void> {
		if (!this.#client) return;
		await this.#client.markAsRead(returnBigInt(id));
		await this.refresh(id);
	}

	/** A tg:// link that opens the chat in Telegram Desktop, if one exists for this chat type. */
	linkFor(id: string): string | undefined {
		const c = this.#chats.get(id);
		if (!c) return undefined;
		if (c.username) return `tg://resolve?domain=${c.username}`;
		if (c.kind === "user") return c.phone ? `tg://resolve?phone=${c.phone.replace(/\D/g, "")}` : `tg://user?id=${id}`;
		if (c.channelId) return `tg://privatepost?channel=${c.channelId}&post=${c.topMessageId ?? 1}`;
		return undefined; // basic (legacy) groups have no deep link
	}

	// ── internals ────────────────────────────────────────────────────────────

	#makeClient(cfg: Config, session: string): TelegramClient {
		this.#client = new TelegramClient(new StringSession(session), cfg.apiId, cfg.apiHash, {
			connectionRetries: 10,
			autoReconnect: true,
			baseLogger: new Logger(LogLevel.ERROR),
			deviceModel: "Stream Deck",
			appVersion: "Telegram Watch 0.1",
		});
		return this.#client;
	}

	async #onReady(): Promise<void> {
		const client = this.#client!;
		const me = await client.getMe();
		this.#setStatus({ state: "ready", me: utils.getDisplayName(me) });

		await this.#loadDialogs(); // also fills GramJS's entity cache so ids resolve

		client.addEventHandler((ev: NewMessageEvent) => {
			const id = ev.message.chatId?.toString();
			if (id) this.#schedule(id);
		}, new NewMessage({}));

		client.addEventHandler((u: Api.TypeUpdate) => {
			let peer: Api.TypePeer | undefined;
			if (u instanceof Api.UpdateReadHistoryInbox || u instanceof Api.UpdateReadHistoryOutbox) peer = u.peer;
			else if (u instanceof Api.UpdateReadChannelInbox) peer = new Api.PeerChannel({ channelId: u.channelId });
			else if (u instanceof Api.UpdateDialogUnreadMark && u.peer instanceof Api.DialogPeer) peer = u.peer.peer;
			else if (u instanceof Api.UpdateDeleteChannelMessages) peer = new Api.PeerChannel({ channelId: u.channelId });
			if (peer) this.#schedule(utils.getPeerId(peer));
			// Deleted DMs/basic-group messages don't say which chat — the poll catches those.
		}, new Raw({}));

		clearInterval(this.#poll);
		this.#poll = setInterval(() => this.#watchCount.forEach((_, id) => void this.refresh(id)), POLL_MS);

		await Promise.all([...this.#watchCount.keys()].map((id) => this.refresh(id)));
	}

	async #loadDialogs(): Promise<void> {
		const dialogs = await this.#client!.getDialogs({ limit: 300 });
		this.#picker = dialogs
			.filter((d) => d.id !== undefined)
			.map((d) => ({
				id: d.id!.toString(),
				title: d.title || d.name || "Untitled",
				kind: (d.isUser ? "user" : d.isGroup ? "group" : "channel") as ChatKind,
			}));
		this.emit("picker");
	}

	#schedule(id: string): void {
		if (!this.#watchCount.has(id)) return;
		clearTimeout(this.#debounce.get(id));
		this.#debounce.set(
			id,
			setTimeout(() => {
				this.#debounce.delete(id);
				void this.refresh(id);
			}, DEBOUNCE_MS),
		);
	}

	#ask(state: AuthState, message: string): Promise<string> {
		this.#setStatus({ state, message });
		return new Promise((resolve, reject) => (this.#pending = { resolve, reject }));
	}

	async #teardown(): Promise<void> {
		clearInterval(this.#poll);
		this.#debounce.forEach(clearTimeout);
		this.#debounce.clear();
		const c = this.#client;
		this.#client = undefined;
		if (c) {
			try {
				await c.destroy();
			} catch {
				/* ignore */
			}
		}
	}

	#fail(err: unknown): void {
		streamDeck.logger.error(`Telegram: ${errorText(err)}`);
		this.#setStatus({ state: "error", message: errorText(err) });
	}

	#setStatus(s: Status): void {
		this.status = s;
		this.emit("status", s);
	}
}

function errorText(err: unknown): string {
	if (err && typeof err === "object" && "errorMessage" in err) return String((err as { errorMessage: unknown }).errorMessage);
	return err instanceof Error ? err.message : String(err);
}

async function loadConfig(): Promise<Config | undefined> {
	try {
		return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Config;
	} catch {
		return undefined;
	}
}

async function saveConfig(cfg: Config): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
	await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export const telegram = new TelegramService();
