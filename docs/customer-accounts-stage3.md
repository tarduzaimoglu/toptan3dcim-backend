# Customer accounts, stage 3: personalized figurine requests

This stage adds an opt-in request flow to the existing customer account system. It reuses Strapi Users & Permissions accounts, the stage 1 server-side session/BFF, and the stage 2 account ownership boundary. It does not add payment or offer acceptance to figurine requests.

## Local setup

1. Install the backend and frontend lockfile dependencies with `npm ci` in each repository.
2. Configure the existing account variables from stage 1 in both applications. Set `FIGURINE_REQUESTS_ENABLED=true` on the backend and `CUSTOMER_ACCOUNTS_ENABLED=true`.
3. For local development only, set `FIGURINE_STORAGE_DRIVER=local`; private files are kept under the backend `.tmp/private-figurines` directory and never enter Strapi's public Upload library. Set `FIGURINE_MAIL_MODE=file` to write controlled test notifications to `.tmp/figurine-mail`. These modes are rejected in production.
4. Start Strapi with `CUSTOMER_SCHEMA_SETUP=true` for the additive Strapi schema setup and package seed, then start Next.js with `CUSTOMER_STRAPI_INTERNAL_URL`, `CUSTOMER_BFF_SECRET`, and `CUSTOMER_PUBLIC_ORIGIN` configured as documented in stage 1.
5. Before enabling customer submission, publish an approved privacy/photo notice and version in the `Figurine Settings` single type. An empty notice deliberately disables submission. Add actual, approved example images to package gallery fields only if they exist; an empty gallery is omitted.

For an S3-compatible private provider, set `FIGURINE_STORAGE_DRIVER=s3` and the `FIGURINE_PRIVATE_S3_*` variables. Use a dedicated private bucket/prefix with no public read or ACL access. Configure bucket CORS for the exact customer origin and signed `PUT` headers. The application signs short-lived object-specific uploads into `quarantine/`, decodes and bounds the file on completion, stores a metadata-stripped WEBP derivative under `assets/`, and deletes the quarantine object. Do not point these variables at the public Strapi upload bucket. The existing deployment's private bucket, credentials, ingress policy, and object lifecycle configuration were not verified in this repository/session.

Defaults are 10 MiB per image, 10 images, 50 MiB total, and 40 million pixels. They can be adjusted with `FIGURINE_MAX_FILE_BYTES`, `FIGURINE_MAX_FILES`, `FIGURINE_MAX_TOTAL_BYTES`, and `FIGURINE_MAX_PIXELS`, within the backend's hard caps. HEIC/HEIF is not accepted; use JPEG, PNG, or WebP. Sharp being compiled with a decoder is not treated as HEIC support without a real representative sample and production runtime validation.

The Strapi cron worker retries durable outbox messages once per minute and removes expired uploads/orphaned drafts every 15 minutes. Multiple Strapi instances use a database lease on each outbox row; monitor `[figurine] notification delivery failed`, the outbox `lastErrorCode`, attempt count, and failed rows. Before production, configure authenticated SMTP (`CUSTOMER_SMTP_*`, `CUSTOMER_MAIL_FROM`) and verify delivery. File mailbox mode is for local testing only.

## Additive schema and rollout

The new collection types are figurine packages, customer drafts, upload sessions, private asset metadata, requests, and notification outbox; a single type stores public notice and display copy. Existing orders, payments, customer relations, and XIDs are not renamed or removed. The only added upload files are private object-store items, not public CMS media.

Local Strapi schema sync creates these new tables and relations. Before a live rollout, take and verify a database backup and object-store backup/policy snapshot. Deploy the backend code and additive schema first with request creation disabled; confirm the new tables and admin plugin. Configure the private bucket/CORS and mail provider, set the approved privacy text and package display options, then enable `FIGURINE_REQUESTS_ENABLED`. Seed defaults only once under the normal controlled schema setup. Roll back by disabling the feature first; preserve request rows and private objects until a reviewed retention/deletion procedure exists. Do not drop these tables or objects as a code rollback shortcut.

Release checks still required: PostgreSQL transaction/locking tests on the target PostgreSQL version; the stage 2 actual Posnet agreement/callback verification remains an independent payment release gate; real private S3-compatible provider upload, quarantine cleanup, signed retrieval, timeout, and multi-instance lease tests; actual SMTP delivery; admin staff roles/permissions; approved privacy text and its version; KDV/kargo price scope; and review of retention/deletion periods and customer-facing legal copy. The local SQLite/mock results are not PostgreSQL, hosting, legal, or bank verification.

## Customer and staff behavior

`/kisiye-ozel-figur` is public to browse and requires an authenticated, email-confirmed customer to submit. The BFF stores files as File/Blob values in IndexedDB until submit. A draft from no account or a different account requires explicit customer confirmation before association. Submission snapshots package content and initial price display (as a starting price only), details, and verified photo references, and writes the request and encrypted notification outbox row in one transaction. Failed notification delivery does not roll back the request.

Customers can view their own requests at `/hesap/figur-talepleri`. Customer API responses contain no staff notes or production costs. Photos are read through a no-store same-origin BFF image endpoint that authenticates the existing HttpOnly customer session and checks request/asset ownership; no view bearer URL is placed in page markup, email, or application logs. Staff photos use an authenticated, role-checked Strapi admin endpoint. Generic public CRUD is denied. The admin plugin provides request list/detail, photo review, and failed-notification retry; quote authoring/approval, request conversion to order, payment, and operational status management remain stage 4.

No exact dimensions, stand/box inclusion, production/delivery duration, KDV/kargo inclusion, or unapproved retention period is asserted. No real product photographs or customer reviews are invented. No stock or reservation is represented.
