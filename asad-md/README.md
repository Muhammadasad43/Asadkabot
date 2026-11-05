# Asad MD

A local-only WhatsApp archiver bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys` 7.0.0-rc13). It runs as a linked device on your own WhatsApp account and quietly keeps a private archive of the messages it sees.

Everything stays on your device. Nothing is uploaded anywhere.

| What | Where |
| --- | --- |
| WhatsApp session credentials | `./auth/` |
| Archived voice notes | `./media/voice/` |
| Message database (SQLite) | `./data/` |

You control the bot by sending commands to yourself (your own "Message yourself" chat). The command prefix is `+`.

## Requirements

- Android phone with [Termux](https://f-droid.org/packages/com.termux/) (install it from F-Droid, not the Play Store)
- Node.js **22.13 or newer** (the bot uses the built-in `node:sqlite`, so there is no native compiling)
- A WhatsApp account on your phone

## Termux setup

```bash
# 1. Update packages and install Node.js
pkg update && pkg upgrade -y
pkg install nodejs git -y

# 2. Check the version. It must print v22.13.0 or higher.
node -v

# 3. Get the project into a folder (copy it over, or git clone it), then:
cd asad-md
npm install

# 4. Start the bot
npm start
```

Optional but recommended: stop Android from killing Termux in the background.

```bash
termux-wake-lock
```

You can also disable battery optimization for Termux in Android settings.

## Pairing-code login

Asad MD logs in with a pairing code, so you don't need to scan a QR code.

1. Run `npm start`.
2. On first run it asks for your phone number. Enter it **with the country code and digits only**, for example `923001234567` (no `+`, spaces, or dashes).
3. The bot prints an **8-character pairing code**.
4. On your phone open **WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead**.
5. Type in the code shown in Termux.
6. When linking succeeds the bot prints your own JID and `Asad MD is online`.

The session is saved in `./auth/`. On later runs the bot logs in automatically and does not ask for your number again.

To log in from scratch, stop the bot, delete the `./auth/` folder, and start it again. If you logged the bot out from your phone (Linked Devices), also delete `./auth/` before restarting.

## Using commands

Open your own chat ("Message yourself") and send a message starting with `+`. Only messages you send from your own account in your own chat are treated as commands. The command set arrives in Part 3 of this build.

## Warnings

### WhatsApp ban risk

Baileys is an **unofficial** library. It is not made or approved by WhatsApp or Meta, and using unofficial clients goes against WhatsApp's Terms of Service. Your account **can be restricted or permanently banned**.

- Use at your own risk, and consider using a secondary number if you can't afford to lose the account.
- This bot only reads and archives. Avoid using it for bulk messaging or spam, which raises the risk a lot.
- Don't run the same session from several places at once.
- Keep `./auth/` private. Anyone who has it can access your WhatsApp account.

### Offline-gap warning

The bot can only archive what it sees **while it is running and connected**.

- If Termux is closed, your phone is off, or you have no internet, messages that arrive in that time are **not guaranteed to be archived**.
- If someone deletes a message while the bot is offline, or deletes a message the bot never saw, it cannot be recovered. The bot can only mark a deletion for messages it has already stored.
- Voice notes and other media must be downloaded while WhatsApp still serves them. Media the bot didn't fetch in time may be lost.
- Keep the bot running (see `termux-wake-lock` above) for the most complete archive.

### Privacy

The archive contains other people's messages. Keep the `data/` and `media/` folders secure, and follow the privacy laws and expectations that apply to you.

## Project layout

```
asad-md/
├── package.json
├── README.md
├── .gitignore
├── auth/            (created at runtime, WhatsApp session)
├── data/            (created at runtime, SQLite database)
├── media/voice/     (created at runtime, archived voice notes)
└── src/
    ├── index.js     entry point, login and event wiring
    ├── store.js     message database
    ├── handlers.js  incoming and deleted message handling
    ├── commands.js  "+" commands
    └── media.js     media download and labelling
```
