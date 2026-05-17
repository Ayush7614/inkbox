/**
 * Receiver-side webhook payload types.
 *
 * This module is **wire-shape-only**: every field name is snake_case
 * because the customer's HTTP handler receives the raw JSON body
 * verbatim. The rest of the SDK's parsed-response types remain
 * camelCase; the webhook module is the sole snake_case island so that
 * `JSON.parse(body) as MailWebhookPayload` round-trips cleanly without
 * a transformer.
 *
 * Two rules followed throughout:
 *
 *   1. All enum-valued wire fields use string-literal unions, not the
 *      TypeScript `enum` exports from `mail/types.ts` or `phone/types.ts`.
 *      TS `enum` members are nominally typed: a bare string from
 *      `JSON.parse` does NOT structurally satisfy an enum-typed field,
 *      so `{ direction: "inbound" }` would error against
 *      `direction: MessageDirection`. Literal unions parse cleanly.
 *
 *   2. Nested object types use the snake_case `Raw*` wire shapes from
 *      `phone/types.ts` (re-exported from the root `@inkbox/sdk`
 *      entry), not the camelCase parsed-response shapes
 *      (`TextMediaItem`, `RateLimitInfo`) — those have `contentType` /
 *      `rateLimit` etc., not what's on the wire.
 *
 * Authoritative server contracts:
 *   - `~/servers/src/data_models/api_contracts/webhooks.py`
 *   - `~/servers/src/data_models/api_contracts/phone/text.py`
 *     (`TextMessageResponse`, `TextMediaItem`)
 *   - `~/servers/src/data_models/api_contracts/phone/call.py`
 *     (`RateLimitInfo`)
 */

import type { RawRateLimitInfo, RawTextMediaItem } from "../phone/types.js";

// ---- Wire union types ------------------------------------------------
// Members copied verbatim from the corresponding server enums in
// `db/postgres/mail/models.py` and `db/postgres/phone/models.py`.

export type MessageDirectionWire = "inbound" | "outbound";

export type MessageStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "bounced"
  | "failed"
  | "received"
  | "deleted";

export type TextDirectionWire = "inbound" | "outbound";

export type TextTypeWire = "sms" | "mms";

export type SmsDeliveryStatusWire =
  | "queued"
  | "sent"
  | "delivered"
  | "delivery_failed"
  | "delivery_unconfirmed"
  | "sending_failed";

export type TextMessageOriginWire = "user_initiated" | "auto_reply";

export type CallDirectionWire = "outbound" | "inbound";

export type CallStatusWire =
  | "initiated"
  | "ringing"
  | "answered"
  | "completed"
  | "failed"
  | "canceled";

export type HangupReasonWire =
  | "local"
  | "remote"
  | "max_duration"
  | "voicemail"
  | "rejected";

// ---- Shared ----------------------------------------------------------

/**
 * Address-book match for the remote party on a webhook event.
 *
 * Scoped to the receiving channel's `identity_id` via the server's
 * `contact_access` model (wildcard sentinel or explicit per-identity
 * grant). When multiple contacts share the value, the oldest by
 * `created_at` wins. The field is always optional on the wire — treat
 * `null` as "no visible address-book entry," never as an error.
 */
export interface WebhookContact {
  /** Matched `contacts.id`. Pass to `inkbox.contacts.get(id)` to hydrate. */
  id: string;
  /** Matched `Contact.preferredName`. */
  name: string;
}

// ---- Mail ------------------------------------------------------------

export type MailWebhookEventType =
  | "message.received"
  | "message.sent"
  | "message.forwarded"
  | "message.delivered"
  | "message.bounced"
  | "message.failed";

/**
 * Field-for-field mirror of `MailWebhookMessageData`
 * (`~/servers/src/data_models/api_contracts/webhooks.py:43`).
 *
 * `message_id` is the RFC 5322 `Message-ID` header value (server
 * docstring) — not renamed to `message_id_header` despite the
 * naming-collision risk, to stay byte-identical to the wire.
 */
export interface MailWebhookMessage {
  id: string;
  mailbox_id: string;
  thread_id: string | null;
  message_id: string | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[] | null;
  subject: string | null;
  snippet: string | null;
  direction: MessageDirectionWire;
  status: MessageStatus;
  has_attachments: boolean;
  /** ISO 8601 datetime. */
  created_at: string | null;
}

export interface MailWebhookPayload {
  event_type: MailWebhookEventType;
  /** ISO 8601 datetime. */
  timestamp: string;
  data: {
    message: MailWebhookMessage;
    contact: WebhookContact | null;
  };
}

// ---- Text -----------------------------------------------------------

export type TextWebhookEventType =
  | "text.received"
  | "text.sent"
  | "text.delivered"
  | "text.delivery_failed"
  | "text.delivery_unconfirmed";

/**
 * Field-for-field mirror of `TextMessageResponse`
 * (`~/servers/src/data_models/api_contracts/phone/text.py:39`).
 *
 * The outbound-lifecycle block (`delivery_status`, `error_code` /
 * `error_detail`, `sent_at` / `delivered_at` / `failed_at`) is the
 * payload's headline value for the four `text.*` outbound events —
 * inspect those fields when discriminating on `event_type` below.
 */
export interface TextWebhookMessage {
  id: string;
  direction: TextDirectionWire;
  local_phone_number: string;
  remote_phone_number: string;
  text: string | null;
  type: TextTypeWire;
  media: RawTextMediaItem[] | null;
  is_read: boolean;
  delivery_status: SmsDeliveryStatusWire | null;
  origin: TextMessageOriginWire;
  error_code: string | null;
  error_detail: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  is_blocked: boolean;
  created_at: string;
  updated_at: string;
}

export interface TextWebhookPayload {
  event_type: TextWebhookEventType;
  timestamp: string;
  data: {
    text_message: TextWebhookMessage;
    contact: WebhookContact | null;
  };
}

// ---- Inbound call (FLAT — no envelope) ------------------------------

/**
 * Field-for-field mirror of `PhoneIncomingCallWebhookPayload`
 * (`~/servers/src/data_models/api_contracts/webhooks.py:164`).
 *
 * This payload is **flat** — there is no `{ event_type, timestamp, data }`
 * envelope. `contact` sits at the top level alongside the call fields.
 *
 * `is_blocked` is intentionally absent: the server dispatcher strips it
 * from the wire body via `payload.pop("is_blocked", None)` after the
 * Pydantic dump, and the spec model omits it (server commit
 * `75c56fe8`). Receivers will never see it.
 */
export interface PhoneIncomingCallWebhookPayload {
  id: string;
  local_phone_number: string;
  remote_phone_number: string;
  direction: "inbound";
  status: CallStatusWire;
  client_websocket_url: string | null;
  use_inkbox_tts: boolean | null;
  use_inkbox_stt: boolean | null;
  hangup_reason: HangupReasonWire | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  rate_limit: RawRateLimitInfo | null;
  contact: WebhookContact | null;
}
