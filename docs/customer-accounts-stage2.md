# Customer accounts and checkout — stage 2

Implemented locally on the existing Strapi Users & Permissions customer accounts and same-origin Next.js BFF. No new identity service was added. Nothing was deployed and no live database or bank was accessed.

## Implemented

- Authenticated carts persist under the verified customer. Revision compare-and-swap protects concurrent device updates. Unique hashed merge receipts make retries idempotent. Backend quote validates published/active product, configured Strapi component variant, minimum and maximum quantity, and current server price. Changed prices and invalid rows are returned to the client. The schema contains no stock quantity, so no stock or reservation is inferred.
- Checkout quotes and hashes a server-calculated total before confirmation. An idempotency key is scoped to the account or a browser-held guest key. Member identity comes from the verified session. Owned address selections are copied into order shipping and billing snapshots. Guest orders remain unlinked from customers.
- PaymentAttempt records have unique XID, amount, currency and state. Order fields and legacy XIDs stay in place. Callback phases use database compare-and-swap; a durable `charging` claim is stored before financialization. Uncertain outcomes block new attempts. Repeated initiation reuses a ready attempt. Callback MAC, XID, amount and status must validate before Order payment state changes.
- Payment result routes fetch server-verified order state. A success URL never clears the cart. Paid member carts remove the quantities in the immutable order snapshot; a verified guest result removes only purchased quantities from local storage.
- Payment and fulfillment states are separate. Carrier and tracking fields are displayed when set. Legacy missing operation data remains unknown. An internal admin-role-checked order operation service enforces transitions and writes audit events; no admin UI or generic write route was added.
- Existing Strapi product variants already use `ColorName`, `ColorCode` and image components. A variant must match one configured `ColorName`; arbitrary colour text is rejected.

## Changed paths

Backend: `src/commerce/{cart,checkout,operations,authorization}.ts`, new `customer-cart`, `cart-merge`, `payment-attempt` and `operation-event` schemas, additive Order schema changes, customer dispatcher, payment service/controller/Posnet timeout, CRUD boundary, tests and this document.

Frontend: cart context and page, checkout page, same-origin account BFF, payment result component/routes, guest-cart settlement helper, account order list/detail and browser E2E harness.

## Posnet and reconciliation

The official [POSNET XML services guide](https://www.yapikredipos.com.tr/getmedia/5a5be15e-73d1-4a1e-9bd5-1b190013605c/POSNET-XML-Services-Tr-2-1-1-3.pdf?ext=.pdf) documents Agreement status queries and `txnStatus` values 1 (success) and 0 (failed/cancelled). The [POSNET 3D Secure guide](https://www.yapikredipos.com.tr/getmedia/780c5f70-fb98-45ed-817e-fc56fce37810/POSNET-3D-Secure-Entegrasyonu-2-0-1-5.pdf?ext=.pdf) describes resolving and verifying merchant data before financialization. Reconciliation is disabled by default. An active admin must invoke the internal service; exactly one Sale record matching the configured order-ID mapping, XID-derived ID, amount and currency is required. An empty, ambiguous or mismatched result retains the unknown lock.

Merchant-specific test credentials, a confirmed XID/order-ID prefix, and bank test results were unavailable. The local suite mocks every bank response. `POSNET_AGREEMENT_ENABLED` must remain false until the merchant confirms `POSNET_AGREEMENT_XID_PREFIX` and verifies Agreement queries in the bank's test environment. No real charge or refund was made. The repository does not identify a deployed hosting plan or reverse-proxy limits, so its production request body and end-to-end callback timeout limits could not be independently verified. The BFF body caps and individual bank request timeout above are application settings; hosting limits still need environment-side confirmation.

## Additive schema and production sequence

Strapi adds four collections and optional columns to `orders`; no existing Order field is dropped or renamed, and `Order.user` remains optional. Existing totals, line snapshots, relationships and legacy XIDs are not rewritten. Unique indexes cover the cart owner, merge receipt, attempt XID and checkout key. Setup remains opt-in and repeat-safe.

Before a later production rollout, back up and test restore; apply schema sync first to a production-sized PostgreSQL copy; compare order count, totals, users, XIDs and callback fixtures; deploy backend with the account gate disabled; then deploy the matching BFF/frontend and configure HTTPS, SMTP and shared keys before enabling account and checkout flags. Rollback should retain the additive schema and run a compatible old app version. Do not restore a backup over intervening orders/payments without reconciliation. No live migration or deployment was run.

Backend variables: `CUSTOMER_ACCOUNTS_ENABLED`, `CUSTOMER_SCHEMA_SETUP`, `CUSTOMER_BFF_SECRET`, `CUSTOMER_TOKEN_ENCRYPTION_KEY`, `CUSTOMER_PUBLIC_ORIGIN`, existing `POSNET_MERCHANT_ID`, `POSNET_TERMINAL_ID`, `POSNET_ID`, `POSNET_ENCKEY`, `POSNET_XML_URL`, `POSNET_OOS_URL`, `BACKEND_URL`, `FRONTEND_URL`, and new reconciliation gates `POSNET_AGREEMENT_ENABLED`, `POSNET_AGREEMENT_XID_PREFIX`. Next retains `CUSTOMER_ACCOUNTS_ENABLED`, `CUSTOMER_STRAPI_INTERNAL_URL`, `CUSTOMER_BFF_SECRET`, `CUSTOMER_PUBLIC_ORIGIN`, optional trusted proxy IP header, and existing `NEXT_PUBLIC_PAYMENTS_ENABLED`.

## Test limits and later work

Integration tests use a new isolated SQLite database per run and deterministic mocked bank responses. PostgreSQL lock and unique-index concurrency was not verified because this environment has no local PostgreSQL or Docker executable. An optional `--postgres` test mode accepts only a loopback URL whose database name starts `customer_test_`; it was not run. Production HTTPS/proxy, SMTP, PostgreSQL multi-instance contention and merchant-specific Posnet tests remain external dependencies. Stock inventory/reservations, order cancellation/refunds and a full admin operation UI remain later work.
