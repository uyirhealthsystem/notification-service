# notification-service — Learning Guide

Concept-first explanations for the non-obvious decisions in this build.

## 1. Why notifications are a separate service at all

`authservice` could have called `nodemailer` directly on
`/auth/password/forgot`. The reason it doesn't:

- **Blast radius.** SMTP is slow and flaky. If the send is inline, a dead mail
  server turns a password-reset request into a hung HTTP call, and every
  service that ever needs to send email grows its own SMTP config and its own
  failure modes.
- **One place for email.** Templates, the "from" identity, retry policy, and
  (later) SMS/push all live here, not smeared across `authservice`, `booking`,
  `ambulance`, …
- **`authservice` stays a token service.** It mints, stores, and verifies the
  reset token — an auth concern — and then just announces "this happened". It
  never learns whether the email was sent, and doesn't care.

## 2. Domain events, not "send this email" commands

Two ways to model the Kafka message:

- **Command:** `authservice` publishes `{ to, subject, body }`. This service is
  a dumb pipe. But now `authservice` owns email copy and layout — the coupling
  just moved onto the wire.
- **Domain event (chosen):** `authservice` publishes *a fact* —
  `PasswordResetRequested { userId, email, otp, expiresAt }`. This service
  decides that fact means "send the reset-email template". `authservice`
  doesn't know an email exists.

The event model is why adding a `booking.events` / `BookingConfirmed` consumer
later is purely additive here: a new schema, a new template, one line in the
handler map. No producer changes.

## 3. What happens when SMTP is down

Three independent layers each degrade on their own:

| down | effect |
|---|---|
| Kafka | `authservice` still returns `202`; the event is dropped (best-effort producer). User retries. |
| notification-service | events pile up in the `auth.events` topic; consumed on restart. |
| SMTP | `sendEmail` retries 3× locally, then throws; the consumer doesn't commit the offset, so Kafka redelivers later. |

"Redelivers later" means the partition waits: Kafka delivers in order, so
nothing behind the failing message moves until it succeeds. That is right for
an outage that affects every email (SMTP down, bad credentials) - skipping
ahead would just fail the next one too. It is wrong for a failure that is about
*one* email, which is what section 5 is for.

While it waits, `/health` reports 503 (the consumer is "restarting"), so the
outage is visible rather than silent. And because one send can sit through
several SMTP timeouts, the consumer keeps heartbeating to Kafka during it -
otherwise the group would decide it died and hand the message to someone else
mid-send.

A password-reset event whose code has expired by the time it's processed is
dropped without sending - authservice would reject the code anyway.

## 4. Log mode

With no `SMTP_HOST`, `sendEmail` logs the rendered email and returns. This
isn't a hack — it's what keeps local dev and CI runnable with zero mail
infrastructure, and it makes "did the right email get built?" a `grep` away.
The handler and consumer code paths are identical; only the last inch changes.

It is refused in production (`NODE_ENV=production` without `SMTP_HOST` won't
start): there it would report every email as handled while sending none, and
write reset codes into the logs.

## 5. Poison messages vs transient failures

Some failures will happen the same way on every retry:

- the envelope isn't JSON / doesn't match the schema,
- the payload fails the handler's schema,
- the `eventVersion` isn't one this service understands,
- the SMTP server rejected *this* email with a 5xx (`550 no such mailbox`).

Retrying those forever blocks the partition - including emergency alerts
queued behind them. So they are thrown as `NonRetryableError`, and the consumer
publishes them to the **dead-letter topic** (`notification.dlq`) with the
reason and source offset, then commits and moves on. Anything else thrown is
transient and left uncommitted for redelivery.

The classification is deliberately narrow: a 5xx during *login* (`EAUTH`) is
our misconfiguration and would affect every email, so it stays transient -
dead-lettering it would empty the topic into the DLQ. If the DLQ publish itself
fails, the original message is redelivered rather than dropped.

DLQ copies of password-reset events have the code replaced with
`[redacted]`, so the DLQ doesn't become a place live codes outlive the 1h
retention on `auth.events`.
