# notification-service

uyir's outbound-notification service. It consumes **domain events** from Kafka
and turns the ones it cares about into email. It is the only service that talks
to an SMTP server - every other service just publishes an event and moves on.

It handles two events:

| Topic | Event | Producer | Email |
|---|---|---|---|
| `auth.events` | `PasswordResetRequested` | authservice | "reset your password" code to the user |
| `hospital.events` | `EmergencyBookingRequested` | hospitalservice | new-emergency alert to the hospital's contact email (skipped if it has none) |

New event types are added as a schema + a template + one line in the handler
map (`src/kafka/consumer.ts`). The `EmergencyBookingRequested` contract is
documented in hospitalservice `docs/API.md` ("New-booking alerts").

## How it fits together

```
authservice ──(PasswordResetRequested)──▶ Kafka topic "auth.events"
                                              │
                                   notification-service consumer
                                              │
                                     render template ──▶ SMTP ──▶ inbox
```

- **authservice** mints/stores/verifies the reset token and builds the reset
  link. It only publishes an event; it never sends mail.
- **Kafka** holds the event. If this service is down, events wait in the topic
  and are processed when it comes back (topic retention is 1h - see the
  security note below).
- **notification-service** validates the event, renders the email, and sends
  it. A send that fails after local retries is left uncommitted so Kafka
  redelivers it later. A message that can *never* succeed (bad payload,
  unknown `eventVersion`, SMTP `5xx` for that recipient) goes to the
  dead-letter topic `notification.dlq` so it doesn't block the ones behind it.
  See `docs/LEARNING_GUIDE.md` §3-5.
- **Postgres** keeps a ledger of every notification - one row per event,
  channel and recipient (see "Notifications ledger" below). It is also what
  stops a redelivered Kafka message from being sent twice.
- **`GET /health`** is `200` only while the Kafka consumer is running; `503`
  while it's starting, restarting after a failure, or stopped.

## Run it locally

```bash
cp .env.example .env
npm install

# fake SMTP inbox at http://localhost:8025
docker compose up -d
# then in .env: SMTP_HOST=localhost  SMTP_PORT=1025

# Kafka (shared infra, one dir up)
docker compose -f ../docker-compose.kafka.yml up -d

# Postgres: create a database, put its URL in DATABASE_URL, then
npm run db:deploy

npm run dev
```

With **no** `SMTP_HOST` set the service runs in **log mode**: it renders each
email and logs it instead of sending. Good for a quick check and for CI.

## Config

| var | required | default | notes |
|---|---|---|---|
| `DATABASE_URL` | yes | – | Postgres, for the notifications ledger |
| `KAFKA_BROKERS` | yes | – | comma-separated |
| `KAFKA_CLIENT_ID` | no | `notification-service` | |
| `KAFKA_GROUP_ID` | no | `notification-service` | consumer group |
| `KAFKA_TOPICS` | no | `auth.events,hospital.events` | comma-separated |
| `KAFKA_DLQ_TOPIC` | no | `notification.dlq` | where never-succeeding messages go |
| `KAFKA_SSL` | no | `false` | `true` for MSK / Confluent / any TLS listener |
| `KAFKA_SASL_MECHANISM` | no | – | `plain`, `scram-sha-256`, `scram-sha-512` |
| `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` | with mechanism | – | |
| `SMTP_HOST` | **in production** | – | unset ⇒ log mode (refused when `NODE_ENV=production`) |
| `SMTP_PORT` | no | `587` | |
| `SMTP_USER` / `SMTP_PASS` | no | – | omit for unauthenticated (Mailpit) |
| `SMTP_SECURE` | no | `false` | `true` for implicit TLS (465) |
| `EMAIL_FROM` | no | `Uyir <no-reply@uyir.test>` | production warns on a reserved domain like `.test` |
| `PORT` | no | `4100` | health probe only |

## Notifications ledger

Table `notifications` (`prisma/schema.prisma`), one row per notification
on any channel - `EMAIL` today; `SMS`, `PUSH` and `WHATSAPP` use the same
table:

| column | |
|---|---|
| `channel` | `EMAIL` | `SMS` | `PUSH` | `WHATSAPP` |
| `status` | `PENDING` (in flight / waiting for retry) → `SENT` | `FAILED` (permanently rejected, dead-lettered) | `SKIPPED` (no address, code expired - reason in `statusReason`) |
| `template` | `password_reset`, `emergency_booking_requested` |
| `recipient` | email / E.164 phone / device token |
| `referenceId` | what it's about - `userId`, `bookingId` |
| `provider`, `providerMessageId` | e.g. `smtp` + the SMTP Message-ID, for bounce/support lookups (`log` = never actually sent) |
| `eventType`, `eventVersion`, `sourceTopic/Partition/Offset` | the event that caused it |
| `attempts`, `statusReason`, `createdAt`, `sentAt` | |

The message **body is not stored** - reset emails carry a live code.

**No duplicates.** `idempotencyKey` (unique) is the event + channel +
recipient. A redelivered message finds its row: `SENT`/`SKIPPED` → not sent
again. The event is identified by its envelope `eventId` if the producer sends
one (none do yet - adding it makes this hold even if an event is published
twice), otherwise by Kafka topic/partition/offset. The remaining gap: a crash
after the provider accepts but before the row is marked `SENT` sends it again
on redelivery.

If Postgres is down, nothing is sent - the event waits in Kafka like an SMTP
outage (`/health` goes 503).

```sql
-- did hospital X get the alert for booking Y?
SELECT channel, status, recipient, "statusReason", "sentAt"
FROM notifications WHERE "referenceId" = '<bookingId>';
```

**Adding a channel** (e.g. SMS): write `src/channels/sms.ts` returning a
`Delivery` like `src/channels/email.ts` does (provider name + a `send()` that
returns the provider's message id and throws `NonRetryableError` on permanent
rejection), then call `deliver(ctx, smsDelivery(...))` in the handler. No
migration - the enum already has the channel.

## Event contract

Topic `auth.events`, message value is JSON:

```json
{
  "eventType": "PasswordResetRequested",
  "eventVersion": 1,
  "occurredAt": "2026-09-04T10:15:30.000Z",
  "data": {
    "userId": "uuid",
    "email": "user@example.com",
    "otp": "123456",
    "expiresAt": "2026-09-04T10:45:30.000Z"
  }
}
```

**Security note.** `otp` is a live single-use 6-digit code. It is kept safe by
a short TTL (10 min, enforced in authservice), single-use +
sibling-invalidation on redeem, and a **1-hour retention** on the `auth.events`
topic so the log does not keep usable codes around. A stronger design - send
only `userId` and have this service call authservice for a code - is a noted
future change.

## Deploy (AWS EC2)

Same layout as authservice: GitHub Actions builds and tests, rsyncs a release
to `/opt/notification-service/releases/<ts>` over SSH, flips the `current`
symlink and restarts the systemd unit. The deploy waits for `/health` - which
also proves the brokers and Kafka credentials work - and **rolls back** to the
previous release if it isn't healthy within ~60s.

One-time setup:

1. **EC2** - Amazon Linux 2023 (default user `ec2-user`), in the same VPC as
   Kafka. Its security group needs outbound access to the brokers, Postgres,
   SMTP (587) and HTTPS (443 - each deploy runs `npm ci`, which downloads
   packages and Prisma's engine). No inbound port is needed except SSH from
   GitHub Actions; `/health` is only checked on localhost.
2. **Postgres** - an RDS for PostgreSQL instance (or a database on an existing
   one) reachable from the EC2 host, with a user that can create tables. Each
   deploy runs `prisma migrate deploy` before restarting. Migrations are not
   undone on rollback, so keep them additive.
3. **Email** - in Amazon SES, verify the sending domain (SES publishes the DKIM
   records), add SPF and DMARC records to its DNS, request production access
   (leave the sandbox), and create SMTP credentials.
4. **Host** - copy `deploy/` to the box and run `bash deploy/setup-ec2.sh`,
   then fill in `/opt/notification-service/shared/notification-service.env`
   (template: `deploy/notification-service.env.example`).
5. **Kafka** - create `notification.dlq` if the cluster doesn't auto-create
   topics.
6. **GitHub** - in the repo, create a `production` environment with secrets
   `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`.

Then every push to `main` deploys (`.github/workflows/ci-cd.yml`); PRs run the
checks only. To deploy from your machine instead:
`EC2_HOST=… EC2_USER=ec2-user bash deploy/deploy-local.sh`.

Operating it: `sudo journalctl -u notification-service -f` for logs; read the
DLQ with `kafka-console-consumer.sh --topic notification.dlq --from-beginning`.

## Deliberately not built yet

- **DLQ replay tooling.** Dead-lettered messages are kept with their reason
  and source offset, but replaying them is a manual produce back onto the
  source topic.
- **SMS / push / WhatsApp senders.** The ledger and `deliver()` support them;
  no provider is wired up yet.
- Retention for the ledger (it grows forever), per-service "from" branding,
  user notification preferences, a schema registry.
