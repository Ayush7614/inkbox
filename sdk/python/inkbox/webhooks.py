"""
inkbox/webhooks.py

Receiver-side webhook payload types.

This module is **wire-shape-only**: every field name is snake_case
because the customer's HTTP handler receives the raw JSON body
verbatim. The rest of the SDK's parsed-response types are dataclasses
with UUID/datetime coercion; the webhook module stays as ``TypedDict``s
over plain JSON so callers can do
``payload = cast(MailWebhookPayload, json.loads(body))`` without
round-tripping through a dataclass.

Two rules followed throughout:

  1. All enum-valued wire fields use ``Literal[...]`` string unions,
     not the existing ``StrEnum``s from ``inkbox.mail.types`` /
     ``inkbox.phone``. ``StrEnum`` is nominally typed by mypy / pyright:
     ``payload["data"]["message"]["direction"] == "inbound"`` would
     fail strict type-checking when ``direction`` is typed as the enum.
     Customers who want the enum object can call
     ``MessageDirection(payload["data"]["message"]["direction"])``
     themselves.

  2. Nested object types use wire ``TypedDict``s (``TextMediaItemWire``,
     ``RateLimitInfoWire``), not the existing dataclasses
     (``TextMediaItem``, ``RateLimitInfo``). The dataclasses have
     custom ``_from_dict`` classmethods with UUID/datetime coercion —
     they are not raw JSON dict shapes.

Authoritative server contracts:

  - ``~/servers/src/data_models/api_contracts/webhooks.py``
  - ``~/servers/src/data_models/api_contracts/phone/text.py``
  - ``~/servers/src/data_models/api_contracts/phone/call.py``
"""

from __future__ import annotations

from typing import Literal, TypedDict


# ---- Wire union types ____________________________________________________
# Members copied verbatim from the corresponding server enums in
# db/postgres/mail/models.py and db/postgres/phone/models.py.

MessageDirectionWire = Literal["inbound", "outbound"]

MessageStatus = Literal[
    "queued",
    "sent",
    "delivered",
    "bounced",
    "failed",
    "received",
    "deleted",
]

TextDirectionWire = Literal["inbound", "outbound"]

TextTypeWire = Literal["sms", "mms"]

SmsDeliveryStatusWire = Literal[
    "queued",
    "sent",
    "delivered",
    "delivery_failed",
    "delivery_unconfirmed",
    "sending_failed",
]

TextMessageOriginWire = Literal["user_initiated", "auto_reply"]

CallDirectionWire = Literal["outbound", "inbound"]

CallStatusWire = Literal[
    "initiated",
    "ringing",
    "answered",
    "completed",
    "failed",
    "canceled",
]

HangupReasonWire = Literal[
    "local",
    "remote",
    "max_duration",
    "voicemail",
    "rejected",
]


# ---- Nested wire shapes __________________________________________________

class TextMediaItemWire(TypedDict):
    """Snake_case wire shape for ``TextMessageResponse.media[i]``."""
    content_type: str
    size: int
    url: str


class RateLimitInfoWire(TypedDict):
    """Snake_case wire shape for the inbound-call payload's ``rate_limit``."""
    calls_used: int
    calls_remaining: int
    calls_limit: int
    minutes_used: float
    minutes_remaining: float
    minutes_limit: int


# ---- Shared ______________________________________________________________

class WebhookContact(TypedDict):
    """
    Address-book match for the remote party on a webhook event.

    Scoped to the receiving channel's ``identity_id`` via the server's
    ``contact_access`` model (wildcard sentinel or explicit per-identity
    grant). When multiple contacts share the value, the oldest by
    ``created_at`` wins. The field is always optional on the wire —
    treat ``None`` as "no visible address-book entry," never as an error.

    Attributes:
        id: Matched ``contacts.id``. Pass to ``inkbox.contacts.get(id)``
            to hydrate.
        name: Matched ``Contact.preferred_name``.
    """
    id: str
    name: str


# ---- Mail ________________________________________________________________

MailWebhookEventType = Literal[
    "message.received",
    "message.sent",
    "message.forwarded",
    "message.delivered",
    "message.bounced",
    "message.failed",
]


class MailWebhookMessage(TypedDict):
    """
    Field-for-field mirror of ``MailWebhookMessageData``
    (servers/.../webhooks.py:43).

    ``message_id`` is the RFC 5322 ``Message-ID`` header value, not
    renamed to ``message_id_header`` despite the naming-collision risk,
    to stay byte-identical to the wire.
    """
    id: str
    mailbox_id: str
    thread_id: str | None
    message_id: str | None
    from_address: str
    to_addresses: list[str]
    cc_addresses: list[str] | None
    subject: str | None
    snippet: str | None
    direction: MessageDirectionWire
    status: MessageStatus
    has_attachments: bool
    created_at: str | None


class MailWebhookData(TypedDict):
    message: MailWebhookMessage
    contact: WebhookContact | None


class MailWebhookPayload(TypedDict):
    event_type: MailWebhookEventType
    timestamp: str
    data: MailWebhookData


# ---- Text ________________________________________________________________

TextWebhookEventType = Literal[
    "text.received",
    "text.sent",
    "text.delivered",
    "text.delivery_failed",
    "text.delivery_unconfirmed",
]


class TextWebhookMessage(TypedDict):
    """
    Field-for-field mirror of ``TextMessageResponse``
    (servers/.../phone/text.py:39).

    The outbound-lifecycle block (``delivery_status``, ``error_code`` /
    ``error_detail``, ``sent_at`` / ``delivered_at`` / ``failed_at``)
    is the payload's headline value for the four ``text.*`` outbound
    events.
    """
    id: str
    direction: TextDirectionWire
    local_phone_number: str
    remote_phone_number: str
    text: str | None
    type: TextTypeWire
    media: list[TextMediaItemWire] | None
    is_read: bool
    delivery_status: SmsDeliveryStatusWire | None
    origin: TextMessageOriginWire
    error_code: str | None
    error_detail: str | None
    sent_at: str | None
    delivered_at: str | None
    failed_at: str | None
    is_blocked: bool
    created_at: str
    updated_at: str


class TextWebhookData(TypedDict):
    text_message: TextWebhookMessage
    contact: WebhookContact | None


class TextWebhookPayload(TypedDict):
    event_type: TextWebhookEventType
    timestamp: str
    data: TextWebhookData


# ---- Inbound call (FLAT - no envelope) ___________________________________

class PhoneIncomingCallWebhookPayload(TypedDict):
    """
    Field-for-field mirror of ``PhoneIncomingCallWebhookPayload``
    (servers/.../webhooks.py:164).

    This payload is **flat** -- there is no ``{event_type, timestamp,
    data}`` envelope. ``contact`` sits at the top level alongside the
    call fields.

    ``is_blocked`` is intentionally absent: the server dispatcher
    strips it from the wire body via
    ``payload.pop("is_blocked", None)`` after the Pydantic dump, and
    the spec model omits it (server commit ``75c56fe8``). Receivers
    will never see it.
    """
    id: str
    local_phone_number: str
    remote_phone_number: str
    direction: Literal["inbound"]
    status: CallStatusWire
    client_websocket_url: str | None
    use_inkbox_tts: bool | None
    use_inkbox_stt: bool | None
    hangup_reason: HangupReasonWire | None
    started_at: str | None
    ended_at: str | None
    created_at: str
    updated_at: str
    rate_limit: RateLimitInfoWire | None
    contact: WebhookContact | None
