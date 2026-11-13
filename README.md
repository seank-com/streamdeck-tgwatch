# Telegram Watch — Stream Deck plugin

One key per Telegram DM or group. Each key shows that chat's profile photo. When someone is waiting on you, the key gets a red frame and an unread-count badge (`!` if everything's read but you haven't replied).

## Setup

```bash
npm install
npm install -g @elgato/cli   # if you don't have it
npm run build
npm run link                 # installs the plugin into Stream Deck (dev link)
```

Then in Stream Deck:

1. Drag **Telegram Watch → Watch Chat** onto a key.
2. In its settings, enter your **API ID / API hash** (from <https://my.telegram.org> → *API development tools*).
3. Click **Log in with QR code** and scan it from your phone: Telegram → Settings → Devices → **Link Desktop Device**. Enter your 2FA password if asked. (Phone + code login is there too, but codes for third-party apps often don't arrive.)
4. Pick the chat. Repeat for the other keys; login is shared, so you only do steps 2–3 once.

Dev loop: `npm run watch` rebuilds and restarts the plugin on save.

## Per-key options

| Setting    | Choices |
|------------|---------|
| Alert when | **Last message isn't mine** (default: a reply is owed) · **There are unread messages** (better for busy groups) |
| On press   | **Open chat in Telegram** (via `tg://` link) · **Mark as read** |
| Blink      | Flash the frame while alerting |

The alert clears on its own as soon as you reply (from any device) or read the chat.

## How it works

- `src/telegram.ts` uses GramJS (MTProto) as **your user account**, so it can see DMs and groups. It listens for new-message and read updates and re-checks each watched chat (`messages.getPeerDialogs`), with a 60-second poll as a safety net.
- `src/actions/chat-watch.ts` is the key action; `src/render.ts` draws the key as an SVG (photo + frame + badge).
- `ui/chat-watch.html` is the property inspector (login flow + chat picker), using sdpi-components.

## Notes

- Credentials and the login session are kept in `~/.streamdeck-telegram-watch/config.json` (mode 600), not in Stream Deck settings and not in the plugin folder. That session is full access to your Telegram account: treat it like a password. **Log out** in the key settings revokes it.
- Legacy basic groups have no deep link, so pressing **Open** on one marks it read instead. Supergroups and DMs open normally.
- Photos are fetched once per plugin start. Restart the plugin to pick up a changed photo.
