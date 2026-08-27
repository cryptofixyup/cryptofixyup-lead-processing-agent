# Lead Agent

An inbound lead qualification and research agent built with Next.js, AI SDK, Workflow DevKit, and the Vercel Slack Adapter.

## Production flow

```text
Lead submission
     ↓
Bot protection + schema validation
     ↓
Idempotency reservation + durable lead record
     ↓
start(workflow) → runId
     ↓
Research → Qualification → Email draft
     ↓
Persistent approval_pending state
     ↓
Slack Approve / Reject
     ↓
Workflow resume
     ↓
Resend delivery
     ↓
Persistent sent / rejected / failed state
```

The submission endpoint is idempotent. Clients may provide an `Idempotency-Key` header containing 1–128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, or `-`. If omitted, the validated lead payload is hashed with SHA-256 and used as the idempotency key.

Lead lifecycle state and idempotency reservations are stored in Upstash Redis over HTTPS. The REST API supports atomic `SET ... NX EX` reservations for duplicate suppression.

## Environment

```text
AI_GATEWAY_API_KEY
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
SLACK_CHANNEL_ID
EXA_API_KEY
RESEND_API_KEY
RESEND_FROM_EMAIL
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

## Durable states

`queued → started → researching → qualified → approval_pending → sent`

Terminal alternatives are `closed`, `rejected`, and `failed`.

Each stored lead has a 30-day TTL. Idempotency reservations have a 7-day TTL. This store is intentionally an operational state layer, not a long-term CRM or compliance archive. For regulated retention, migrate the same record model to PostgreSQL and keep Redis as the idempotency/cache layer.

## CI

The GitHub Actions validation workflow installs with the frozen pnpm lockfile, runs TypeScript validation, and performs a production Next.js build.

## Getting started

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Configure the environment variables before submitting a lead. Slack interactivity must point to `/api/slack` on the deployed application.
