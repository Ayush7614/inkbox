# use-inkbox-webhook

Inbound email webhook example — expose a local ASGI handler at a public Inkbox tunnel URL, verify webhook signatures, and auto-reply when mail arrives.

No ngrok required. The handler runs in-process via `inkbox.tunnels.connect()`; Inkbox delivers webhooks to `https://{handle}.inkboxwire.com/hooks/mail`.

## Prerequisites

1. Python ≥ 3.11
2. An Inkbox API key (`INKBOX_API_KEY`) from [inkbox.ai/console](https://inkbox.ai/console)
3. Optional: `INKBOX_WEBHOOK_SIGNING_KEY` — if unset, the example calls `create_signing_key()` which **rotates** the org signing key

## Run

```bash
cp .env.example .env
# edit .env — set INKBOX_API_KEY

cd ../../sdk/python
uv run --env-file ../../examples/use-inkbox-webhook/.env \
  python ../../examples/use-inkbox-webhook/webhook_server.py
```

## What it does

1. Creates identity `webhook-email-demo` (mailbox + tunnel provisioned atomically)
2. Resolves or creates the org webhook signing key
3. Starts an in-process ASGI app behind `inkbox.tunnels.connect()`
4. Registers a `message.received` webhook subscription on the identity's mailbox
5. Sends a probe email to trigger an inbound webhook
6. Verifies the `X-Inkbox-Signature` header and auto-replies once
7. Deletes the subscription and identity on exit

## Architecture

```
webhook_server.py
├── ASGI app (POST /hooks/mail)  → verify_webhook() + parse MailWebhookPayload
├── inkbox.tunnels.connect()     → public URL without uvicorn/ngrok
└── inkbox.webhooks.subscriptions → message.received fan-out
```

See [`skills/inkbox-tunnels/SKILL.md`](../../skills/inkbox-tunnels/SKILL.md) for tunnel details and [`skills/inkbox-python/SKILL.md`](../../skills/inkbox-python/SKILL.md) for webhook subscription reference.
