# Telegram Watch — Stream Deck plugin

One key per Telegram DM or group. Each key shows that chat's profile photo. When someone is waiting on you, the key gets a red frame and an unread-count badge (`!` if everything's read but you haven't replied).

## Install

You need **Stream Deck 7.1+** (running) and **Node.js** (any recent version — it's only for the build tools; Stream Deck runs the plugin on its own bundled Node).

```bash
git clone https://github.com/seank-com/streamdeck-tgwatch.git
cd streamdeck-tgwatch
npm install
npm install-scripts approve esbuild   # see note below
npm install -g @elgato/cli           # the `streamdeck` command, once per machine
npm run build
npm run link                         # installs the plugin into Stream Deck
```

The **Telegram Watch** category should appear in Stream Deck's action list. If it doesn't, quit and reopen Stream Deck.

### About the npm install warnings

- **Blocked install scripts.** Newer npm versions don't run package install scripts until you approve them. Only **esbuild** (the bundler used by `npm run build`) needs one, hence the `approve` step above.
- **"3 high severity vulnerabilities."** These are a single `zod` advisory inherited from Elgato's own SDK (`@elgato/streamdeck` → `@elgato/utils`). It only affects validation of messages from the local Stream Deck app, so the practical risk is negligible. **Don't run `npm audit fix --force`** — it "fixes" it by downgrading the SDK to 1.x, which breaks the plugin. It will clear once Elgato updates the dependency.

## Set up the keys

1. Get an **API ID and API hash** (once): log in at <https://my.telegram.org> → **API development tools** → create an app (any name/platform) → copy *App api_id* and *App api_hash*.
2. Drag **Telegram Watch → Watch Chat** onto a key and open its settings.
3. Enter the API ID and hash, click **Log in with QR code**, and scan it from your phone: Telegram → **Settings → Devices → Link Desktop Device**. Enter your 2FA password if asked. (Phone-number + code login is there too, but codes for third-party apps often don't arrive.)
4. Pick the chat. Repeat for the other keys — the login is shared, so steps 1 and 3 happen only once.

## Per-key options

| Setting    | Choices |
|------------|---------|
| Alert when | **Last message isn't mine** (default — clears only when you reply) · **There are unread messages** (clears as soon as you've read it) |
| On press   | **Open chat in Telegram** (via `tg://` link) · **Mark as read** |
| Blink      | Flash the frame while alerting |

If the other side always answers right after you (e.g. agents/bots), **There are unread messages** is the better choice: it clears the moment you've seen their last message.

## Development

```bash
npm run watch     # rebuild + restart the plugin on every save
npm run restart   # restart the plugin manually (see note below)
npm run pack      # build a .streamDeckPlugin file for a GitHub Release
```

Logs are in `com.seank.telegram-watch.sdPlugin/logs/`; each run starts with a `Telegram Watch starting (built …)` line showing which build is loaded.

If that line doesn't show your latest build after `npm run restart`, Stream Deck didn't really reload the plugin (it can report success anyway). Quit Stream Deck from its tray icon and reopen it.

## How it works

- `src/telegram.ts` uses [teleproto](https://www.npmjs.com/package/teleproto) (the maintained fork of GramJS) to talk MTProto as **your user account**, so it can see DMs and groups. It listens for new-message and read updates and re-checks each watched chat (`messages.getPeerDialogs`), with a 60-second poll as a safety net.
- `src/actions/chat-watch.ts` is the key action; `src/render.ts` draws the key as an SVG (photo + frame + badge).
- `com.seank.telegram-watch.sdPlugin/ui/chat-watch.html` is the property inspector (login flow + chat picker), using sdpi-components.
- `com.seank.telegram-watch.sdPlugin/bin/` is build output and isn't checked in.

## Notes

- Credentials and the login session are stored in `~/.streamdeck-telegram-watch/config.json` (on Windows, `%USERPROFILE%\.streamdeck-telegram-watch\`), not in Stream Deck settings or the repo. That session is full access to your Telegram account — treat it like a password. **Log out** in the key settings revokes it. Each computer needs its own login.
- On Windows, pressing a key opens the chat through the registered `tg://` handler. If nothing happens, check that `Win+R` → `tg://resolve?domain=telegram` opens Telegram Desktop.
- Legacy basic groups have no deep link, so pressing **Open** on one marks it read instead (the key shows a checkmark). Supergroups and DMs open normally.
- Profile photos are re-checked every 60 seconds, so a changed photo shows up on its key within about a minute.
