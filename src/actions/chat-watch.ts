import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { spawn } from "node:child_process";

import { chatImage, placeholderImage } from "../render.js";
import { telegram, type ChatInfo } from "../telegram.js";

export type ChatSettings = {
	chatId?: string;
	/** "reply": alert when the last message isn't yours. "unread": alert while there are unread messages. */
	mode?: "reply" | "unread";
	/** What a key press does. */
	press?: "open" | "read";
	/** Blink the ring while alerting. */
	flash?: boolean;
};

type Tracked = { action: KeyAction<ChatSettings>; settings: ChatSettings; blink?: NodeJS.Timeout; blinkOn: boolean };

@action({ UUID: "com.seank.telegram-watch.chat" })
export class ChatWatch extends SingletonAction<ChatSettings> {
	#keys = new Map<string, Tracked>();

	constructor() {
		super();
		telegram.on("chat", (chat: ChatInfo) => {
			for (const [ctx, t] of this.#keys) if (t.settings.chatId === chat.id) void this.#render(ctx);
		});
		telegram.on("status", () => this.#keys.forEach((_, ctx) => void this.#render(ctx)));
	}

	override async onWillAppear(ev: WillAppearEvent<ChatSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.#track(ev.action, ev.payload.settings);
		await this.#render(ev.action.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<ChatSettings>): void {
		this.#untrack(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ChatSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.#untrack(ev.action.id);
		this.#track(ev.action, ev.payload.settings);
		await this.#render(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<ChatSettings>): Promise<void> {
		const { chatId, press = "open" } = ev.payload.settings;
		if (!chatId || telegram.status.state !== "ready") {
			await ev.action.showAlert();
			return;
		}
		try {
			const link = press === "open" ? telegram.linkFor(chatId) : undefined;
			if (link) {
				streamDeck.logger.info(`Opening ${link}`);
				openExternal(link);
			} else {
				streamDeck.logger.info(`No deep link for ${chatId} (basic group?) — marking read instead`);
				await telegram.markRead(chatId);
				await ev.action.showOk();
			}
			// Telegram's read/reply updates will clear the alert on their own; refresh soon in case.
			setTimeout(() => void telegram.refresh(chatId), 3000);
		} catch (err) {
			streamDeck.logger.error(`Key press failed: ${String(err)}`);
			await ev.action.showAlert();
		}
	}

	/** Messages from the property inspector (chat picker + login flow). */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, ChatSettings>): Promise<void> {
		const p = (ev.payload ?? {}) as Record<string, string | boolean | undefined>;
		switch (p.event) {
			case "getChats":
				if (p.isRefresh) await telegram.reloadPicker();
				await streamDeck.ui.sendToPropertyInspector({ event: "getChats", items: telegram.pickerItems() });
				break;
			case "status":
				await streamDeck.ui.sendToPropertyInspector({ event: "status", ...telegram.status });
				break;
			case "login":
			case "loginQr": {
				const apiId = Number(p.apiId);
				const needPhone = p.event === "login";
				if (!apiId || !p.apiHash || (needPhone && !p.phone)) {
					await streamDeck.ui.sendToPropertyInspector({
						event: "status",
						...telegram.status,
						message: needPhone ? "Fill in API ID, API hash and phone number." : "Fill in API ID and API hash.",
					});
					break;
				}
				const hash = String(p.apiHash).trim();
				if (needPhone) void telegram.login(apiId, hash, String(p.phone).trim());
				else void telegram.loginQr(apiId, hash);
				break;
			}
			case "submit":
				telegram.submit(String(p.value ?? ""));
				break;
			case "cancel":
				telegram.cancelLogin();
				break;
			case "logout":
				await telegram.logout();
				break;
		}
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	#track(act: KeyAction<ChatSettings>, settings: ChatSettings): void {
		this.#keys.set(act.id, { action: act, settings, blinkOn: true });
		if (settings.chatId) telegram.watch(settings.chatId);
	}

	#untrack(ctx: string): void {
		const t = this.#keys.get(ctx);
		if (!t) return;
		clearInterval(t.blink);
		if (t.settings.chatId) telegram.unwatch(t.settings.chatId);
		this.#keys.delete(ctx);
	}

	async #render(ctx: string): Promise<void> {
		const t = this.#keys.get(ctx);
		if (!t) return;
		const { chatId, mode = "reply", flash = false } = t.settings;
		const state = telegram.status.state;
		const chat = chatId ? telegram.getChat(chatId) : undefined;

		const stopBlink = () => {
			clearInterval(t.blink);
			t.blink = undefined;
		};

		if (!chat) {
			stopBlink();
			const caption =
				state === "ready" ? (chatId ? "Loading…" : "Pick chat") : state === "connecting" ? "Connecting" : "Log in";
			await t.action.setImage(placeholderImage(caption, state === "ready"));
			return;
		}

		const alert = mode === "unread" ? chat.unread > 0 || chat.unreadMark : chat.waitingReply;
		const badge = chat.unread > 0 ? (chat.unread > 99 ? "99+" : String(chat.unread)) : "!";
		const dim = state !== "ready";
		const on = chatImage(chat, { alert, badge, dim });

		if (alert && flash && !dim) {
			const off = chatImage(chat, { alert: false, dim });
			// (Re)start the blinker with the latest frames.
			clearInterval(t.blink);
			t.blinkOn = true;
			t.blink = setInterval(() => {
				t.blinkOn = !t.blinkOn;
				void t.action.setImage(t.blinkOn ? on : off);
			}, 800);
		} else {
			stopBlink();
		}
		await t.action.setImage(on);
	}
}

/** Hand a tg:// link to the OS so Telegram Desktop's URL handler picks it up. */
function openExternal(url: string): void {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["explorer.exe", [url]] // avoids cmd.exe mangling the "&" in links
				: ["xdg-open", [url]];
	const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
	child.on("error", (err) => streamDeck.logger.error(`Couldn't open ${url}: ${err.message}`));
	child.unref();
}
