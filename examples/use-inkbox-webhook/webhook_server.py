"""
Inbound email webhook example — tunnel + signature verification + auto-reply.

Exposes an in-process ASGI handler at a public Inkbox tunnel URL, registers a
``message.received`` webhook subscription, sends a probe email, verifies the
incoming webhook signature, auto-replies once, then cleans up.

Requires INKBOX_API_KEY in the environment (see .env.example).
Optional INKBOX_WEBHOOK_SIGNING_KEY — if unset, create_signing_key() is called
(which rotates the org signing key).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any, cast

from inkbox import Inkbox, MailWebhookPayload, verify_webhook
from inkbox.exceptions import InkboxAPIError

HANDLE = "webhook-email-demo"
WEBHOOK_PATH = "/hooks/mail"
PROBE_SUBJECT = "Webhook probe"
WAIT_SECONDS = 90


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"ERROR: {name} is required.", file=sys.stderr)
        sys.exit(1)
    return value


async def _read_body(receive: Any) -> bytes:
    body = b""
    while True:
        event = await receive()
        if event["type"] != "http.request":
            continue
        body += event.get("body", b"")
        if not event.get("more_body", False):
            break
    return body


async def _send_response(
    send: Any,
    status: int,
    body: bytes,
    content_type: str = "text/plain",
) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", content_type.encode())],
        },
    )
    await send({"type": "http.response.body", "body": body})


def _ensure_identity(inkbox: Inkbox, handle: str) -> Any:
    try:
        existing = inkbox.get_identity(handle)
        print(f"=> Removing existing identity: {handle}")
        existing.delete()
    except InkboxAPIError:
        pass
    identity = inkbox.create_identity(handle, display_name="Webhook Demo")
    print(f"=> Created identity: {identity.agent_handle} ({identity.email_address})")
    return identity


def _resolve_signing_secret(inkbox: Inkbox) -> str:
    env_secret = os.environ.get("INKBOX_WEBHOOK_SIGNING_KEY", "").strip()
    if env_secret:
        print("=> Using INKBOX_WEBHOOK_SIGNING_KEY from environment")
        return env_secret
    print("=> No INKBOX_WEBHOOK_SIGNING_KEY — creating/rotating org signing key")
    key = inkbox.create_signing_key()
    print("   Save the signing key — it is shown only once.")
    return key.signing_key


async def main() -> None:
    api_key = _require_env("INKBOX_API_KEY")
    signing_secret = None
    sub_id = None
    listener = None

    with Inkbox(api_key=api_key) as inkbox:
        identity = _ensure_identity(inkbox, HANDLE)
        mailbox = identity.mailbox
        if mailbox is None:
            print("ERROR: Identity has no mailbox.", file=sys.stderr)
            sys.exit(1)

        signing_secret = _resolve_signing_secret(inkbox)
        webhook_received = asyncio.Event()
        handled_probe = False

        async def asgi_app(scope: dict[str, Any], receive: Any, send: Any) -> None:
            nonlocal handled_probe
            if scope["type"] != "http":
                return
            if scope["method"] != "POST" or scope.get("path") != WEBHOOK_PATH:
                await _send_response(send, 404, b"not found")
                return

            body = await _read_body(receive)
            headers = {
                key.decode("latin-1"): value.decode("latin-1")
                for key, value in scope.get("headers", [])
            }
            if not verify_webhook(
                payload=body,
                headers=headers,
                secret=signing_secret or "",
            ):
                await _send_response(send, 403, b"invalid signature")
                return

            payload = cast(MailWebhookPayload, json.loads(body))
            event_type = payload.get("event_type")
            message = payload.get("data", {}).get("message", {})
            direction = message.get("direction")
            subject = message.get("subject") or ""

            print(f"=> Webhook: {event_type} direction={direction} subject={subject!r}")

            if (
                event_type == "message.received"
                and direction == "inbound"
                and subject == PROBE_SUBJECT
                and not handled_probe
            ):
                handled_probe = True
                from_address = message.get("from_address") or identity.email_address
                message_id = message.get("id")
                inkbox.get_identity(HANDLE).send_email(
                    to=[from_address],
                    subject=f"Re: {PROBE_SUBJECT}",
                    body_text="Got your webhook — auto-reply from the Inkbox webhook example.",
                    in_reply_to_message_id=message_id,
                )
                print(f"=> Auto-replied to {from_address}")
                webhook_received.set()

            await _send_response(send, 200, b"ok")

        print("=> Connecting tunnel (in-process ASGI handler)")
        listener = inkbox.tunnels.connect(name=HANDLE, forward_to=asgi_app)
        public_url = listener.public_url
        webhook_url = f"{public_url}{WEBHOOK_PATH}"
        print(f"   Public URL:  {public_url}")
        print(f"   Webhook URL: {webhook_url}")

        serve_task = asyncio.create_task(listener.serve_forever())
        await asyncio.sleep(3)  # allow data plane to connect

        print("=> Creating webhook subscription (message.received)")
        sub = inkbox.webhooks.subscriptions.create(
            mailbox_id=mailbox.id,
            url=webhook_url,
            event_types=["message.received"],
        )
        sub_id = sub.id
        print(f"   Subscription: {sub_id}")

        try:
            print("=> Sending probe email to trigger webhook")
            identity.send_email(
                to=[mailbox.email_address],
                subject=PROBE_SUBJECT,
                body_text="Ping from the Inkbox webhook example.",
            )

            print(f"=> Waiting up to {WAIT_SECONDS}s for verified webhook...")
            await asyncio.wait_for(webhook_received.wait(), timeout=WAIT_SECONDS)
            print("=> Webhook received, signature verified, auto-reply sent")
        except TimeoutError:
            print(
                f"ERROR: No webhook received within {WAIT_SECONDS}s.",
                file=sys.stderr,
            )
            sys.exit(1)
        finally:
            print("=> Cleaning up")
            if listener is not None:
                await listener.aclose()
                serve_task.cancel()
                try:
                    await serve_task
                except asyncio.CancelledError:
                    pass
            if sub_id is not None:
                inkbox.webhooks.subscriptions.delete(sub_id)
                print(f"   Deleted subscription {sub_id}")
            inkbox.get_identity(HANDLE).delete()
            print(f"   Deleted identity {HANDLE}")
            print("   Done.")


if __name__ == "__main__":
    asyncio.run(main())
