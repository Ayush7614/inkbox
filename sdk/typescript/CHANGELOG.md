# Changelog

## Unreleased — webhook subscriptions refactor

### Breaking

- **`Mailbox.webhookUrl` removed.** Mailbox PATCH no longer accepts `webhookUrl`; sending it returns 422. Migration: create a `webhooks.subscriptions` row for each mailbox that needs delivery (see Added below).
- **`PhoneNumber.incomingTextWebhookUrl` removed** from every shape that carried it (`PhoneNumber`, `IdentityPhoneNumber`, `IdentityPhoneNumberCreateOptions`, `phoneNumbers.update`, `phoneNumbers.provision`, identity-create's nested `phoneNumber`). Sending it returns 422 server-side. Replace with a `text.*` subscription on the phone number.
- **Phone-text webhook payload — `data.contact` → `data.contacts` + `data.agent_identities`.** `contact` is gone. `contacts` is always a list (possibly empty); `agent_identities` is a new always-present list of matched agent identities. Destructuring `const { contact } = data` silently breaks.
- **Inbound-call webhook payload — top-level `contact` → `contacts` + `agent_identities`.** Same shape swap at the top level of the flat payload.
- **`TextWebhookMessage.remote_phone_number` is now nullable.** Populated on inbound and 1:1 outbound; `null` on group outbound rows (the per-recipient state lives in `recipients[]`).
- **Mail webhook payload — `data.agent_identities` is now required on the wire** alongside the existing `data.contacts` (both default `[]`). Receivers that previously did `Object.keys(data)` or strict shape checks will see a new key.

### Added

- **`inkbox.webhooks.subscriptions` resource** — full CRUD for the new `/webhooks/subscriptions` endpoint surface. `list`, `get`, `create`, `update`, `delete`. The SDK mirrors all four server validators client-side (exactly-one FK, non-empty distinct events, no `phone.incoming_call`, channel coherence) so typos surface as thrown errors rather than 422 round-trips. New exports: `WebhookSubscription`, `WebhookSubscriptionsResource`, `WebhookSubscriptionStatus`, plus option types for create/update/list.
- **`WebhookAgentIdentity` / `WebhookMailAgentIdentity`** types covering identity matches on text/call and mail payloads. Same shape as the contact types but with `agent_handle` / `display_name` instead of `name`. Mail variant also carries `bucket` + `address`.
- **Group-text fields on `TextWebhookMessage`:** `conversation_id`, `sender_phone_number`, `recipients: WebhookRecipient[] | null`. `recipients` is `null` on inbound, one entry on outbound 1:1 (legacy lifecycle fields hoisted from that single entry), multiple entries on group outbound (legacy fields stay `null`). New exported `WebhookRecipient` interface.
- **`data.recipient_phone_number` on `TextWebhookPayload`** identifies which recipient an outbound lifecycle event is about. `null` on inbound and 1:1 outbound.

## 0.4.4

### Added

- **Identity visibility controls.** New `IdentityAccess` type and three methods on both `IdentitiesResource` and `AgentIdentity`:
  - `listAccess()` — list who can see an identity. Returns either a single wildcard row (`viewerIdentityId === null` — every active identity in the org sees it) or explicit per-viewer rows. An empty list means no scoped agent can see the identity.
  - `grantAccess(viewerIdentityId)` — grant a viewer identity visibility on the target. Pass `null` to reset the target to the org-wide wildcard.
  - `revokeAccess(viewerIdentityId)` — revoke one viewer's visibility, keyed by the viewer identity's UUID.

  Granting a viewer against an already-wildcard target raises `RedundantContactAccessGrantError` (409); revoking a non-existent grant raises `InkboxAPIError` (404).

## 0.4.3

### Breaking

- **`identity.unlinkPhoneNumber()` / `IdentitiesResource.unlinkPhoneNumber()` were renamed to `releasePhoneNumber()`** and their behavior changed accordingly. The method now releases the number at the carrier and removes it locally; previously it only cleared the FK on the row and left the carrier-side number live. There is no "unlink without release" path anymore — once a number is released, it cannot be reattached.
- **`identity.assignPhoneNumber()` (and the underlying `IdentitiesResource.assignPhoneNumber()`) were removed.** The server no longer supports cross-identity reassignment; phone numbers are bound to the identity they were provisioned on. To attach a number to an identity, either pass the nested `phoneNumber` option to `inkbox.createIdentity(...)`, or call `inkbox.phoneNumbers.provision({ agentHandle, ... })` for an existing identity.
- **`identity.delete()` cascade now releases the linked phone number** (vendor + local), instead of clearing the FK and leaving the carrier-side number live.
