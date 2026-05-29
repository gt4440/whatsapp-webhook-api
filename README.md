# WhatsApp REST API with Webhook Integration

A production-ready WhatsApp gateway built on **Node.js + Express + [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)**, with a dark-themed web dashboard and outbound webhook events.

> ⚠️ **Disclaimer:** whatsapp-web.js is an unofficial library that automates WhatsApp Web. It is **not** affiliated with or endorsed by WhatsApp/Meta and using it may violate WhatsApp's Terms of Service. Use a number you're willing to risk.

## Features

- Dark, responsive dashboard served at `/`
- QR-code login (scan with your phone)
- Multi-session support keyed by `userId`
- Outbound webhook on connect / new message / disconnect

## API

| Method | Endpoint                | Description                                        |
| ------ | ----------------------- | -------------------------------------------------- |
| POST   | `/api/start-session`    | Initialize WhatsApp; returns a QR base64 string    |
| GET    | `/api/status/:userId`   | Connection status                                  |
| POST   | `/api/send-message`     | Send a text message (`{ userId, recipient, message }`) — `recipient` may be a **contact name OR phone number** |
| GET    | `/api/contacts`         | Contacts/chats (name + number) for autocomplete    |
| GET    | `/api/unread`           | Unread messages with sender name + text            |
| GET    | `/api/chats`            | Recent chats with names                            |
| POST   | `/api/logout`           | Disconnect the session                             |
| GET    | `/api/health`           | Health check                                       |

## Webhook payloads

Sent via `POST` to `BOT_WEBHOOK_URL`:

```jsonc
// connected
{ "event": "connected", "message": "WhatsApp Account successfully connected to Telegram!", "userId": "<userId>" }

// new_message
{ "event": "new_message", "senderName": "<name>", "senderNumber": "<number>", "text": "<content>", "userId": "<userId>" }

// disconnected
{ "event": "disconnected", "message": "WhatsApp session ended." }
```

## Run locally

```bash
cp .env.example .env   # then edit if needed
npm install
npm start
# open http://localhost:3000
```

## Environment variables

| Variable          | Default                                  |
| ----------------- | ---------------------------------------- |
| `PORT`            | `3000`                                   |
| `BOT_WEBHOOK_URL` | the configured Lovable webhook           |
| `CHROME_PATH`     | (optional) path to system Chrome/Chromium|
