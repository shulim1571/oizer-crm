# Readiness #6 and #7: plans (no infrastructure changed)

Written 2026-11-15 for Shulim's OK. Nothing below has been set up. No project, secret or setting was created or changed.

## #6 Separate production database

**Today:** `.env.production` and `.env.staging` both point at Supabase project `wwaknikpdquwnphhwzsm`. Tests, imports, sample data and the live site share one database.

### Target

| | Production (new) | Staging / test (existing `wwaknikpdquwnphhwzsm`) |
|---|---|---|
| Site | oizer.trubase.org (Pages `main` branch) | a Pages preview branch, e.g. `staging.oizer-drm.pages.dev` |
| Data | real organizations only | sample data, imports, UX tests |
| Backups | daily (7 days, included) + point-in-time restore, 7 days | daily (7 days, included) |
| Robot check | Cloudflare Turnstile, live site key | Turnstile *test* site key, so phone-size checks like #5 can run end to end without a person |
| Payments | live processor keys, set per organization in the database | sandbox keys only |
| Plaid | production bank links move here (already approved) | sandbox |

### Cost (flagged, needs approval)

Supabase bills per organization. Figures are from supabase.com/pricing and the backups and PITR docs, read 2026-11-15:

- **Pro plan:** from $25/month per organization. Includes $10/month of compute credit, which covers one Micro project.
- **Each extra project** pays its full compute cost. Micro is $10/month and Small is $15/month.
- **Point-in-time restore:** about $100/month per project for 7 days of history, about $200 for 14 days, about $400 for 28 days. It works on any compute size.
- **Daily backups:** kept 7 days, included on Pro.
- **Spend cap:** compute and point-in-time restore are not covered by the spend cap, which is on by default. These charges are fixed and predictable, not usage-based.

**Added cost per month:**

| Option | If the org is already on Pro | If the org is on Free |
|---|---|---|
| A. New Micro production project, daily backups only | **+$10** | **+$35** (Pro $25 + $10) |
| B. Option A plus 7-day point-in-time restore (recommended) | **+$110** | **+$135** |
| C. Option B on Small compute instead of Micro | **+$115** | **+$140** |

My access couldn't read which plan the org is on (permission denied), so both cases are shown. Usage beyond the Pro allowances (egress, storage, MAUs) is extra. The current volume (~73K donations) is well inside them.

Cloudflare: a Pages preview branch and a Turnstile test key cost nothing.

### Steps, once approved

1. **Create the project.** Shulim creates the production project in the same Supabase org, US East (same region as today), and turns on point-in-time restore if option B or C is chosen.
2. **Schema.** Apply the 110 migrations in order through the Management API (name by name, as today; not `db push`). Then compare the schema with staging: tables, functions, RLS policies, and security advisor counts against `security/cloud-baseline.json`.
3. **Edge functions.** Deploy all 19 functions with `--no-verify-jwt`. Then copy the function secrets. Shulim enters the values; they are never committed or pasted into chat.
4. **Auth.**
   - Set the site URL and redirect URLs to oizer.trubase.org.
   - Keep text/call 2FA. Never make an authenticator app required.
   - Set up SMTP and SMS the same way as staging.
5. **Data.** Copy only real organizations (`pg_dump` of their rows, with test orgs and sample rows filtered out), or start empty and re-import from the processors.
   - Moshe and Shulim decide which, given the sample-data-only rule.
   - Nothing is deleted from staging.
6. **Frontend.**
   - Point `.env.production` at the new project.
   - Change `.env.staging` to keep the current one.
   - `deploy` keeps publishing to Pages `main`.
   - Add a `deploy:staging` script that publishes to a `staging` branch.
7. **Cut over.** Do it in a quiet hour:
   - Pause the processor webhooks and feeds.
   - Run a final data copy.
   - Deploy.
   - Re-point the Sola, Elevon and Plaid webhook URLs to the new project's functions.
   - Resume.
   - Roll back by re-deploying with the old `.env.production`. The old project is untouched.
8. **Check.**
   - Dashboard totals match the old project for the copied organizations.
   - A live $1 gift and a refund go through, then get reversed.
   - Login works with text and call codes.

### Keeping test imports out of production

- Imports, seed scripts and the test suite only ever read `.env.staging`, or run in memory as the test suite already does. Seed and import scripts refuse to run when the project ref is the production ref.
- CI never gets production credentials (see #7: production deploy secrets live in a protected GitHub environment that needs approval).
- In production, the `organizations` row can carry `is_test`. Feeds and imports for a test org are rejected there. This is a small migration, written when #6 goes ahead.
- Processor sandbox keys are only ever saved in staging organizations.

## #7 Deploys from GitHub Actions, gated on green CI

**Done already (c795e3a):** CI runs on every branch push and every PR, and passes on `docs/platform-roadmap`.

**Today:** `npm run deploy` runs from a workstation with a local Cloudflare token. Nothing stops a deploy when tests fail.

### Plan

- **New workflow `deploy.yml`.**
  - Triggered by `workflow_run` when CI completes. It runs only when the conclusion is `success` and the branch is the deploy branch (now `docs/platform-roadmap`, later `main`).
  - It can also be started by hand with `workflow_dispatch`, and it re-checks that CI is green for that commit.
- **Jobs:**
  1. **frontend:** `npm ci`, then `npm run deploy`. The script already builds, writes the public function config, and publishes with `wrangler pages deploy`.
  2. **functions:** deploy only the functions whose folders changed in the commit, with the pinned Supabase CLI and `--no-verify-jwt`.
  3. **migrations:** leave manual at first. Migrations change live data, so they keep going through the named Management API call by a person. Possible later step: a job that applies new migration files by name after an approval.
- **GitHub environment `production`.**
  - Required reviewer: Shulim.
  - Only the deploy branch may use it.
  - It holds the secrets, so a pull request from a fork can never reach them. This matters because the repo is public.
- **Secrets Shulim would add.** I don't set any.
  - `CLOUDFLARE_API_TOKEN`: the existing Pages-only token, or a new one scoped to Pages edit on `oizer-drm`.
  - `SUPABASE_ACCESS_TOKEN`: only for the functions job. It's best as a token used only for deploys, so it can be revoked on its own.
  - `CLOUDFLARE_ACCOUNT_ID` is already a repo variable. The public Supabase URL and publishable key are already in the workflow.
- **Safety:**
  - Actions pinned by commit SHA, as in `ci.yml`.
  - `permissions: contents: read`.
  - `concurrency: deploy` so two deploys never overlap.
  - The deploy log prints the Pages URL and the commit SHA.
- **Cost:** none. The public repo gets free Actions minutes. CI takes about 9 minutes and a deploy about 3.
- **Afterwards:** workstation deploys stop. `npm run deploy` stays for an emergency, run by Shulim only.

## #27 Processor batch matching (plan; needs report samples)

**Goal:** match each bank deposit from a processor to the gifts it pays out, and check that deposit = gifts - fees - refunds.

**What I need from Shulim or Moshe** (one recent sample file of each, sandbox or real with card numbers removed; I don't have these formats):

| Processor | Report | Fields used |
|---|---|---|
| Sola (Cardknox) | Batch/settlement report (CSV export from the Sola portal, or the Reporting API `report:batch` if the API key may be used for reports) | batch number, batch date, deposit date, transaction refs (xRefNum), gross, fees, refunds/voids, net |
| Elevon (Cartis) | Daily funding / settlement report | funding date, batch id, transaction reference ids, gross, discount/fees, chargebacks/refunds, net deposit |
| Donary | Payout / deposit file | payout id, date, payment numbers included, gross, fees, net |

**Build, once the samples are in:**
1. A `settlement_batches` table (processor, batch id, batch date, deposit date, gross, fees, refunds, net) and `donations.settlement_batch_id`.
2. An import on the Bank Reconciliation page per processor format, with the same preview-then-confirm step as Data Import. It links gifts by processor reference.
3. On matching, a processor deposit line can be matched to a whole batch (one book item, like a split gift). The match checks deposit = gross - fees - refunds and shows any difference.
4. The batch's real fees can then be spread over its gifts with the "Apply fee difference" step (#30).

**Cost:** none for files exported by hand. The Sola Reporting API is part of the existing account. Nothing is set up or changed until the samples arrive.

## #47 Go-live checklist (plan only; nothing switched)

Run in this order, after the wipe of test data and once the production project (#6) exists:

1. **Data**
   - Wipe test data (test imports via `test_import_rows`, Make test batches, hand-made sample rows).
   - Keep a row count per table as evidence (readiness D9).
   - Run the Books check (dashboard, Check now) and clear what it finds.
2. **Bank accounts:** set the default bank account. Map each campaign and method to its account. Make sure no gifts sit in "Clearing (unassigned)".
3. **Payment methods and fees:**
   - Add or map every method name on the Task Sheet's No Fee Rule items.
   - Set processor rates (Fees → Processor rates) for Sola and Elevon.
4. **Card processing (Sola):** enter the live API key and PIN under Payments, then switch Mode from Sandbox to Live. Then:
   - run one $1 live charge and refund it
   - check that the webhook arrives
5. **Elevon / Make:** point the Make scenarios at production and turn ingest on. Send one test transaction, then remove it.
6. **Donary:** turn the connection on (it's off). Assign each machine to its campaign under Machine Bookings → Donary Machines, then watch one day's sync.
7. **Messaging (Twilio, email):** take messaging out of test mode, then send one text and one email to staff only.
8. **Robot check:** the live Cloudflare Turnstile key on the payment pages.
9. **Plaid:** production bank links are already approved. Re-link on production and run one sync.
10. **People:** invite the real admins and fundraisers. Everyone sets up text/call codes; an authenticator app stays optional.
11. **Watch for a week:**
    - the nightly Books check
    - the Task Sheet
    - failed-delivery items
    - the cloud-config check, once its two GitHub secrets are set

## #50 Error monitoring (plan; free option first)

- **Free (can be built now, no cost):**
  - A `client_errors` table, written by the app through a rate-limited function when the page hits an uncaught error (message, page, release, time; no form contents).
  - Edge functions log failures to the same table.
  - The nightly Books check gets a "new errors" line, so they reach the Task Sheet.
  - Webhook failures (Make, Sola, Donary) already go to their ingest logs. The same nightly job would flag a run of failures, and recurring-charge failures already reach the Task Sheet.
- **Paid option:** Sentry for the front end and edge functions.
  - Free tier: 5,000 errors/month.
  - Team plan: about $26/month.
  - I haven't checked current Sentry pricing.
  - It needs a DSN in the build environment.
- **Recommendation:** build the free version. Add Sentry only if the volume or the need for stack traces grows.

## #51 Backups and restore (plan; nothing changed)

- **Now:** daily physical backups are on (8 kept, latest 2026-11-16 09:46 UTC). Point-in-time restore is **off**. Project in us-east-2, Postgres 17.
- **Cost to turn on PITR** (Supabase pricing page, read 2026-11-15):
  - about $100/month for 7 days of history
  - about $200/month for 14 days
  - about $400/month for 28 days
  - not covered by the spend cap
  - on production, per #6
- **Restore test, once a quarter:**
  1. Restore the latest daily backup into a new project; for PITR, pick a time.
  2. Run the Books check and compare row counts and the dashboard totals with the source.
  3. Record the time it took.
  4. Delete the test project.
- **Blocked:** the daily cloud-config check stays red until Shulim sets its two GitHub secrets. I haven't set them.
