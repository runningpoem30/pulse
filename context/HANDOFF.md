# ONDC Pulse — Engineering Handoff & Context Document

**Date:** October 2026  
**Repository:** `datadog-for-ondc` (ONDC Pulse)  
**Status:** Phases 1–3 Complete | AWS Resources Deleted | Ready for Local Dev or Clean AWS Redeploy  

---

## 1. Executive Summary & Project Purpose

**ONDC Pulse** is a real-time observability, transaction tracking, protocol validation, and SLA monitoring platform built specifically for the **Open Network for Digital Commerce (ONDC)**. Think of it as a specialized "Datadog for ONDC".

### Core Problem It Solves
ONDC transactions are distributed asynchronous interactions between Buyer App (BAP), Seller App (BPP), and Logistics providers. Protocol violations (out-of-order steps, invalid state jumps), silent SLA timeouts (stuck searches, unconfirmed orders, delayed pickups), and unhandled fulfillment failures degrade network health and are hard to detect in real time.

### Core Capabilities Built
1. **High-Throughput Ingestion**: Serverless webhook ingestion via API Gateway -> S3 (raw payload archiving) -> SQS (decoupled buffering).
2. **Deterministic State Machine**: Strict protocol state validation for the ONDC Retail domain (`nic2004:52110`, `ONDC:RET10-12`), separating order action states from linear physical fulfillment states.
3. **SQS-Delayed SLA Engine**: In-band SLA breach detection utilizing standard SQS `DelaySeconds` (up to 15 minutes) rather than heavy cron infrastructure.
4. **Incident & RCA Management**: Automatic incident creation for SLA breaches and protocol violations, auto-resolution when orders progress, and incident lifecycle management (`OPEN` -> `ACKNOWLEDGED` -> `RESOLVED` / `IGNORED`).
5. **Observability UI & Dashboard**: Next.js dashboard app displaying transaction feeds, SLA breaches, metric aggregations, and order details.

---

## 2. Monorepo Architecture & Tech Stack

```text
datadog-for-ondc/
├── apps/
│   └── api/                  # Fastify REST server (local ingestion, health checks, orders)
├── packages/
│   └── database/             # Shared Prisma schema, clients, migrations, seeds
├── next/                     # Next.js 15 App Router (Dashboard UI, incident & simulator APIs)
├── infra/
│   └── cdk/                  # AWS CDK v2 (VPC, Aurora Serverless v2, S3, SQS, Lambdas, API Gateway)
├── docker/                   # Docker Compose for local PostgreSQL 14
└── context/                  # Feature specifications (01 to 16), roadmap, and agent guidance
```

### Technology Matrix
* **Language & Runtime:** TypeScript (Strict), Node.js 20+ / Node 22 runtime for Lambdas.
* **Database & ORM:** PostgreSQL 14/15, Prisma 5.10 / 5.22.
* **Testing:** Vitest (unit tests mock Prisma/AWS; integration tests test DB queries).
* **AWS Services (CDK):**
  * `API Gateway REST API`: `/webhook` secured by API Key & Usage Plan.
  * `AWS Lambda`: Ingestion Lambda (Fast lightweight buffering), Processor Lambda (Prisma + VPC), Migration Lambda (runs `prisma migrate deploy` & seed within VPC).
  * `Amazon S3`: Raw event payload archive.
  * `Amazon SQS`: `processingQueue` + Dead Letter Queue (`dlq`). Also used for delayed SLA timers.
  * `Amazon Aurora Serverless v2`: PostgreSQL cluster (`ondc_pulse` DB), managed credentials via AWS Secrets Manager.
  * `Amazon EventBridge`: `OndcPulseInternalBus` (available for metrics/events).

---

## 3. Work Completed To Date (Phases 1 — 3)

### Phase 1: Deterministic ONDC State Machine (`StateMachineService`)
* **Location:** [`apps/api/src/modules/events/state-machine.service.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/apps/api/src/modules/events/state-machine.service.ts)
* **Design:** Replaced naive linear states with a deterministic matrix designed specifically for ONDC Retail (`nic2004:52110`).
* **Two-Track Progression:**
  1. **Action Protocol State:** `SEARCHED` -> `SELECTED` -> `INITIALIZED` -> `CONFIRMED` -> `IN_PROGRESS` -> `COMPLETED` / `CANCELLED`.
  2. **Fulfillment State:** Extracted from `order.fulfillments[0].state.descriptor.code` (`Pending` -> `Packed` -> `Agent-assigned` -> `Picked` -> `Out-for-delivery` -> `Delivered`). Linear forward progression enforced; backwards jumps fail.
* **Strict Validation Statuses:** Evaluates each event to `VALID`, `INVALID_TRANSITION`, `UNEXPECTED_EVENT`, or `UNSUPPORTED_FLOW` (e.g. logistics `nic2004:60232` rejected as unsupported).
* **Terminal States:** No events accepted after `COMPLETED` or `CANCELLED`.
* **Permanent Archiving:** Invalid events are **never** discarded; they are saved to DB and S3 with their respective `validationStatus` for full audit trails.

### Phase 2: SQS-Delayed SLA Detection Engine
* **Location:** [`infra/cdk/src/lambdas/processor.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/infra/cdk/src/lambdas/processor.ts)
* **Design Decision:** Avoided complex EventBridge crons, Step Functions, or Timestream. The existing SQS queue is reused by sending delayed `SLA_CHECK` messages (`DelaySeconds: Math.floor(thresholdMs / 1000)` up to 900s).
* **Business Timestamps:** Deadlines are calculated from the ONDC payload's `context.timestamp` rather than AWS arrival time.
* **Stale Check Discard vs Incident Generation:**
  * When `SLA_CHECK` fires: Processor reads the order from Aurora.
  * If the order has progressed past the monitored state/fulfillment: check is discarded as **stale** (no incident).
  * If the order is still stuck: creates an `Incident` (`incidentType: 'SLA_BREACH'`, `status: 'OPEN'`, with rule metadata).
  * Idempotency prevents duplicate incidents on SQS retries.

### Phase 3: Incident Service & RCA
* **Locations:**
  * [`next/app/api/incidents/[id]/route.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/next/app/api/incidents/[id]/route.ts)
  * [`next/app/api/incidents/route.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/next/app/api/incidents/route.ts)
  * [`infra/cdk/src/lambdas/processor.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/infra/cdk/src/lambdas/processor.ts)
* **Incident Lifecycle Management:** Added `PATCH /api/incidents/:id` supporting status transitions (`OPEN`, `ACKNOWLEDGED`, `RESOLVED`, `IGNORED`). Automatically populates `resolvedAt = new Date()` when resolved.
* **Protocol Violation Detection:** Processor transactions capture `INVALID_TRANSITION` and `UNEXPECTED_EVENT` and create `PROTOCOL_VIOLATION` incidents atomically with `OrderEvent`.
* **SLA Auto-Resolution:** When an order successfully receives a valid subsequent event and advances, the Processor automatically marks open `SLA_BREACH` incidents for that order as `RESOLVED`.
* **Filtering & RCA:** `GET /api/incidents` supports filtering by `status`, `severity`, and `incidentType`. RCA generation API exists at `/api/incidents/[id]/rca`.

---

## 4. AWS Deployment History & Current State

### What Was Deployed & Verified
1. **Full CDK Deployment:** Deployed in `us-east-1` across 4 stacks:
   * `OndcPulseFoundationStack` (S3 bucket, SQS queue + DLQ, EventBridge bus)
   * `OndcPulseDatabaseStack` (VPC, Aurora Serverless v2 PostgreSQL, Secrets Manager, Migration Lambda)
   * `OndcPulseApiStack` (API Gateway `/webhook`, Ingest Lambda, Processor Lambda)
   * `OndcPulseMetricsStack`
2. **Database Migration & Seed:**
   * Invoked `MigrationLambda` via AWS SDK to run `prisma migrate deploy`.
   * Invoked `MigrationLambda` with `{"action": "seed"}` to load [`smoke-test-seed.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/packages/database/prisma/smoke-test-seed.ts) (`smoke-test-tenant`, `smoke-test-seller.com`, `buyer-app.com`, and a 30s SLA rule from `SEARCHED` to `SELECTED`).
3. **Live Verification:** Executed live `curl` requests against API Gateway for:
   * Valid happy-path state transition (`on_search` -> `SEARCHED`).
   * Invalid state transition (`on_confirm` sent while in `SEARCHED` -> `INVALID_TRANSITION`).
   * SLA Breach (left in `SEARCHED` -> 30s delay -> `SLA_BREACH` incident created).
   * SLA Stale (advanced with `select` before 30s -> SLA check discarded cleanly).

### What Happened Next: Deletion of AWS Resources
* **All AWS resources were deleted.**
* **What this means right now:**
  1. The Aurora Serverless v2 cluster and Secrets Manager secret no longer exist.
  2. The root [`.env`](file:///Users/archietans/Developer/projects/datadog-for-ondc/.env) currently contains a stale `DATABASE_URL` pointing to the deleted Aurora cluster (`ondcpulsedatabasestack-auroradatabaseauroracluster-...`).
  3. The previous API Gateway URL (`https://396z8qj0fh.execute-api.us-east-1.amazonaws.com/prod`) and API Key are gone.
  4. S3 buckets, SQS queues, and Lambdas are gone.
  5. **No application code was lost.** Everything needed to run locally or redeploy to AWS is version-controlled in this repository.

---

## 5. Known Gotchas & How to Run the Project Right Now

### Gotcha 1: Integration Tests Fail If Pointed to Deleted Aurora
If you run `npm test` without updating `.env`, tests that attempt a real DB connection (like `health.test.ts`, `events.test.ts`, `db.test.ts`) will fail with:
```text
PrismaClientInitializationError: Can't reach database server at ondcpulsedatabasestack...
```
*Note: Pure unit tests that mock Prisma (like `state-machine.service.test.ts` and `processor.test.ts`) pass completely.*

### To Run Locally with Docker (Zero AWS Required):
1. **Start Local Postgres:**
   ```bash
   npm run db:up
   # Starts postgres:14-alpine on port 5433 (via docker/docker-compose.yml)
   ```
2. **Update `.env` in the repo root:**
   ```env
   DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres"
   PORT=3000
   HOST="0.0.0.0"
   LOG_LEVEL="info"
   ```
3. **Run Migrations & Seed:**
   ```bash
   npm run db:migrate
   npm run db:seed:demo  # or npm run db:seed
   ```
4. **Run Tests:**
   ```bash
   npm test
   ```
5. **Start Dev Servers:**
   ```bash
   npm run dev
   # Next.js UI on http://localhost:3000, Fastify API on configured port
   ```

### To Redeploy to AWS (When Ready for Cloud):
1. **Deploy CDK Stacks:**
   ```bash
   cd infra/cdk
   npx cdk deploy --all
   ```
2. **Run Migrations Inside AWS:**
   Find the deployed `MigrationLambda` function name and invoke it:
   ```bash
   # Run Prisma migrate deploy
   aws lambda invoke --function-name <MigrationLambdaName> --payload '{}' /dev/stdout
   # Seed smoke test participants and SLA rules
   aws lambda invoke --function-name <MigrationLambdaName> --payload '{"action":"seed"}' /dev/stdout
   ```
3. **Retrieve New Credentials:**
   * Get the new API Gateway URL and API Key from CDK outputs.
   * Fetch the new Aurora credentials from AWS Secrets Manager and update your root `.env`.

### Gotcha 2: CDK Unit Test Assertions
`infra/cdk/lib/constructs/AuroraDatabase.ts` was previously modified for demo/hackathon ease to use public subnets and open port 5432 to allow direct connectivity. Two tests in `infra/cdk/test/DatabaseStack.test.ts` still expect private isolated subnets and closed port 5432. If strict CDK tests need to pass, either adjust `AuroraDatabase.ts` or update the test expectations.

### Gotcha 3: Next.js Turbopack Warning
On some macOS development setups, building `next` can throw a warning regarding Turbopack `lightningcss` native binary. The standard Next.js dev server and API builds work properly regardless.

---

## 6. Critical Files & Directory Index

| Purpose | File Path |
| :--- | :--- |
| **Retail State Machine** | [`apps/api/src/modules/events/state-machine.service.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/apps/api/src/modules/events/state-machine.service.ts) |
| **State Machine Unit Tests** | [`apps/api/src/modules/events/state-machine.service.test.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/apps/api/src/modules/events/state-machine.service.test.ts) |
| **SQS Processor Lambda** | [`infra/cdk/src/lambdas/processor.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/infra/cdk/src/lambdas/processor.ts) |
| **Ingest Lambda** | [`infra/cdk/src/lambdas/ingest.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/infra/cdk/src/lambdas/ingest.ts) |
| **Migration & Seed Lambda** | [`infra/cdk/src/lambdas/migrate.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/infra/cdk/src/lambdas/migrate.ts) |
| **CDK Stacks Entrypoint** | [`infra/cdk/bin/ondc-pulse.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/infra/cdk/bin/ondc-pulse.ts) |
| **Prisma Schema** | [`packages/database/prisma/schema.prisma`](file:///Users/archietans/Developer/projects/datadog-for-ondc/packages/database/prisma/schema.prisma) |
| **Smoke Test Seed Data** | [`packages/database/prisma/smoke-test-seed.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/packages/database/prisma/smoke-test-seed.ts) |
| **Incidents API Routes** | [`next/app/api/incidents/route.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/next/app/api/incidents/route.ts) & [`[id]/route.ts`](file:///Users/archietans/Developer/projects/datadog-for-ondc/next/app/api/incidents/%5Bid%5D/route.ts) |
| **Manual Verification Curl Guide** | [`manual_curl_tests.md` (Artifact)](file:///Users/archietans/.gemini/antigravity-ide/brain/2c00ba08-5627-4fcd-9c62-08f52669b0de/manual_curl_tests.md) |

---

## 7. Recommended Next Steps for the Next Agent

1. **Decide Execution Mode:**
   * **If continuing local development / UI polish:** Start local Postgres (`npm run db:up`), point `.env` to `localhost:5433`, run migrations, and verify all tests pass.
   * **If redeploying to AWS:** Run `cd infra/cdk && npx cdk deploy --all`, invoke `MigrationLambda` to migrate and seed, and update `.env` with new AWS endpoints.
2. **Upcoming Roadmap Items (Phase 3+):**
   * Configure notification integrations (SNS / Slack / PagerDuty webhooks for critical incidents).
   * Integrate LLM/Bedrock RCA summarization over historical incident logs.
   * Wire live WebSocket / SSE streaming to the Next.js dashboard for real-time transaction updates.
