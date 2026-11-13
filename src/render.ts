import type { ChatInfo } from "./telegram.js";

const S = 144; // Stream Deck key canvas (renders crisply on @2x keys)
const ALERT = "#ff3b30";
const PALETTE = ["#e17076", "#faa774", "#a695e7", "#7bc862", "#6ec9cb", "#65aadd", "#ee7aae"];

const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const toDataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

function initials(title: string): string {
	const parts = title.trim().split(/\s+/).filter(Boolean);
	const chars = (parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts).map((p) => [...p][0] ?? "");
	return chars.join("").toUpperCase() || "?";
}

function colorFor(id: string): string {
	let n = 0;
	for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
	return PALETTE[n % PALETTE.length];
}

export type KeyLook = { alert: boolean; badge?: string; dim?: boolean };

/** The chat's photo (or initials) filling the key, optionally with a red frame + count badge. */
export function chatImage(chat: ChatInfo, look: KeyLook): string {
	// Full-bleed square photo (keys are already rounded) — avoids clip paths, which
	// Stream Deck's SVG renderer doesn't handle reliably. xlink:href for the same reason.
	const face = chat.photo
		? `<image xlink:href="data:image/jpeg;base64,${chat.photo}" x="0" y="0" width="${S}" height="${S}" preserveAspectRatio="xMidYMid slice"/>`
		: `<rect width="${S}" height="${S}" fill="${colorFor(chat.id)}"/>
		   <text x="72" y="72" dy=".35em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="56" fill="#fff">${esc(initials(chat.title))}</text>`;

	const frame = look.alert ? `<rect x="6" y="6" width="132" height="132" rx="18" fill="none" stroke="${ALERT}" stroke-width="12"/>` : "";

	const badge =
		look.alert && look.badge
			? `<circle cx="112" cy="32" r="26" fill="${ALERT}" stroke="#fff" stroke-width="4"/>
			   <text x="112" y="32" dy=".36em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="${look.badge.length > 2 ? 20 : 28}" fill="#fff">${esc(look.badge)}</text>`
			: "";

	return toDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
		<rect width="${S}" height="${S}" fill="#000"/>
		<g opacity="${look.dim ? 0.35 : 1}">${face}</g>${frame}${badge}
	</svg>`);
}

/** Telegram-style paper plane with a short caption, for "not logged in" / "pick a chat" states. */
export function placeholderImage(caption: string, active = true): string {
	const fill = active ? "#2aabee" : "#555";
	return toDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
		<rect width="${S}" height="${S}" fill="#000"/>
		<circle cx="72" cy="60" r="44" fill="${fill}"/>
		<path d="M50 60 L94 42 L86 82 L72 70 L66 80 L64 68 Z" fill="#fff"/>
		<text x="72" y="128" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="20" fill="#ccc">${esc(caption)}</text>
	</svg>`);
}
