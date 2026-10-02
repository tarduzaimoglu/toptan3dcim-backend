# Customer accounts release validation (local only)

Checked 2026-10-02. No deployment, live database access, live schema change, payment flag change, or real customer data operation was performed.

## What is verifiable here

- The repository contains a Next.js 16.2.4 frontend (`toptan3dcim-frontend`) and Strapi 5.43.0 backend (`toptan3dcim-backend`). The Strapi Dockerfile builds with Node 22 and requires PostgreSQL in production. `config/database.ts` defaults to SQLite outside production; production refuses to start without `DATABASE_CLIENT=postgres` and `DATABASE_URL`.
- No local `.env`/`.env.local` exists in either app. The inspected process environment has no application, database, SMTP, or S3 configuration. No service was listening on the expected local ports. Docker, Podman, PostgreSQL CLI/server tools, and a PostgreSQL Windows service were unavailable, so no actual PostgreSQL version could be queried.
- The backend fixture command creates a uniquely named disposable SQLite file under `toptan3dcim-backend/.tmp` and sets up a local-only Strapi instance. It exercises the account, cart, payment mock, private local storage, outbox and admin service contracts. It does not exercise real SMTP/S3/Postgres or a visible browser session.
- The frontend account BFF calls `CUSTOMER_STRAPI_INTERNAL_URL` from the Next.js server. Browser account calls stay same-origin. The existing `/backend/*` rewrite instead defaults to a Tailscale hostname unless `BACKEND_PROXY_URL` is set. That repository default is not evidence of the deployed route.
- Figurine S3 upload uses a browser PUT to the signed object URL, so the configured private-storage endpoint must be reachable from the customer's network and allow the exact signed PUT CORS origin/headers. The non-production local upload URL points directly at Strapi. The checked repository does not establish a production-reachable route for either path. Therefore a customer without Tailscale can use account pages only if the Next.js host can reach Strapi; photo uploads also require an internet-reachable signed-storage endpoint (or a deliberately public Next.js upload proxy, which is not implemented). This has not been verified on hosting.
- No SMTP or private bucket is configured locally. Controlled file mail and local private files are covered by tests only. No real SMTP server or S3-compatible service was contacted.

## Repeatable local checks

Run from `toptan3dcim-backend`:

```powershell
npm run test:accounts
npm run build
```

The account test harness sets `NODE_ENV=test`, SQLite, a random database filename, local-only storage/mail modes, and ephemeral secrets itself. Do not set `CUSTOMER_TEST_POSTGRES_URL` unless a dedicated disposable local PostgreSQL test database is running.

On a machine with Docker Compose, PostgreSQL test setup is:

```powershell
docker compose -f docker-compose.stage5-postgres.yml up -d --wait
$env:CUSTOMER_TEST_POSTGRES_URL = 'postgres://customer_test:customer_test_only@127.0.0.1:55432/customer_test_stage5'
npm run test:accounts -- --postgres
```

It uses PostgreSQL 16 in a localhost-only port binding and a tmpfs data directory. Stop it after testing with `docker compose -f docker-compose.stage5-postgres.yml down`. A passing SQLite run is not PostgreSQL evidence; the separate-process concurrency matrix in `customer-accounts-stage5.md` still needs a Postgres run.

Before any production schema sync that creates the unique `orders_user_lnk(order_id)` index, run this read-only check against a backup/staging copy first:

```sql
SELECT order_id, COUNT(*) AS link_count, ARRAY_AGG(user_id ORDER BY user_id) AS user_ids
FROM orders_user_lnk
GROUP BY order_id
HAVING COUNT(*) > 1
ORDER BY order_id;
```

Any returned row blocks index creation until a person reviews the underlying orders and ownership evidence. This query only reports; it does not remove or merge links. Also verify the relation table exists before running it.

## SMTP, storage, roles, and workers

- `npm run test:accounts` writes controlled mail payloads under `.tmp/customer-mail` and `.tmp/figurine-mail`, and injects an unavailable SMTP endpoint to verify durable failure/retry behavior. This does not verify delivery, sender alignment, TLS, or provider throttling. For staging, enter `CUSTOMER_SMTP_HOST`, `CUSTOMER_SMTP_PORT`, `CUSTOMER_SMTP_USER`, `CUSTOMER_SMTP_PASS`, and `CUSTOMER_MAIL_FROM` in the backend's secret environment store. Enter frontend contact-mail SMTP values separately only if that existing contact form is in scope. Do not put credentials in chat or commit them.
- Private image tests use the isolated local private-storage driver and inspect that public `/uploads` access is denied. The S3 driver requires `FIGURINE_PRIVATE_S3_ENDPOINT`, `FIGURINE_PRIVATE_S3_BUCKET`, `FIGURINE_PRIVATE_S3_REGION`, `FIGURINE_PRIVATE_S3_ACCESS_KEY_ID`, and `FIGURINE_PRIVATE_S3_SECRET_ACCESS_KEY`. Set them only in the backend secret store after creating a private test bucket, then verify signed upload, private read, deny-public, delete and retry plus customer-network reachability/CORS. No S3 service has been tested here.
- Figurine operations run on Strapi's existing cron worker after backend startup: outbox and customer mail every minute, cleanup every 15 minutes. `npm run develop` is for local development; `npm run start` runs the compiled app. Outbox jobs are durable; a crashed `processing` job becomes eligible again after its lock expiry. Failed jobs retry with backoff up to eight attempts; the Strapi Figurine Admin notification queue shows failures and supports manual requeue. Restart the backend process to restart its cron scheduler. No separate worker process is required by the current implementation.
- Staff role allowlists are now fail-closed: absent/empty global and per-capability role names grant no workflow capability. The example env uses blanks. Configure only verified Strapi Admin role names/codes in the backend secret/config environment, then test permitted and denied staff accounts in staging. Customer Users & Permissions roles do not grant Strapi Admin roles.

## Checks completed in this workspace

- `npm run test:accounts`: passed, 27 isolated SQLite integration/security groups. Includes registration, confirmation, reset, session revocation, ownership, address/order snapshots, cart merge, payment callback mocks, private upload and public URL denial, offer/operations, account deletion, role denial, outbox retry and closed marketing consent.
- `npm run build` in the backend passed after the role fail-closed edit, including the Strapi admin panel. The final frontend production build passed earlier in this work using the local Strapi fixture. Focused frontend lint and `git diff --check` passed earlier; backend `git diff --check` passed for this work (Git printed existing line-ending notices only).
- PostgreSQL was not run. SMTP/S3 services were not configured. No visible local browser was available in this session, so desktop/mobile acceptance, interactive staff/customer workflows and screenshots are not verified. No screenshots are claimed.
- Payments remain disabled. Do not change `FIGURINE_PAYMENTS_ENABLED` or `POSNET_BANK_VERIFIED`; static IP/bank Posnet validation and real refunds are independent release blockers for payment/refund only.

## Remaining publication decisions

- Provide the actual staging Next.js and Strapi origin/routing and trusted proxy arrangement; ensure customers can reach the signed private bucket URL without Tailscale and validate bucket CORS.
- Configure staging SMTP and private S3 credentials through the hosting secret store, then run real delivery and storage integration tests.
- Run PostgreSQL 16 fixture and the separate-process concurrency matrix on an isolated test instance; run the read-only ownership duplicate query on a backup/staging copy before adding the unique index.
- Map and verify least-privilege Strapi Admin roles. Keep marketing consent disabled until approved copy/version and an integration target are decided. Continue to separate account-deletion requests from actual deletion; approve data-class and backup retention policies before building/enabling erasure.
- The current browser-control service was unavailable (`agent.browsers.list()` returned no browsers). To finish visual acceptance, provide a usable local browser session or rerun this checkout in an environment with the in-app Browser available. Test with a synthetic-only configured fixture; do not enable production consent or payment settings for local acceptance.
