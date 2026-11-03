# Oizer platform roadmap

Plan for growing the Oizer CRM into the multi-tenant platform described in the Campaign Management System
spec (v1.0, June 2026). The spec itself is not committed here because it contains credentials (see
[Before anything else](#before-anything-else)).

Status: Phases 0 to 6 are live. On 2026-11-02 the "Oizer DRM" project (`wwaknikpdquwnphhwzsm`, Trubase Live org),
until then staging, became production, served from Cloudflare Pages (`oizer-drm`). The old `oizer-crm` project and
GitHub Pages site are retired. It still holds test data; the real data is reimported once the final version is ready.
Phases 7 to 10 haven't started.

Still open for Phase 1:
- Supabase's built-in email only reaches the project's team members, a few messages an hour. Inviting anyone else needs
  a custom email provider, which Phase 7 sets up and which sign-ups need sooner on the live project.
- Per-organization subdomains: the front end is now on Cloudflare Pages (decision 2), so each one is a custom domain
  on the `oizer-drm` project plus a row in `org_domains`. Organizations can already be reached by `?org=slug`.
- Feature switches are stored per organization, but no screen uses them until those features exist.

Limits to know about:
- The account lockout covers sign-ins through the app. Someone calling Supabase's sign-in API directly with the public key
  isn't counted, though Supabase's own rate limits still apply. Moving to the Team plan and its password hook would close that.
- A Platform Owner's export ban only hides the button. Anyone who can read data can copy it, so the guarantee is that
  every session is logged in that organization's activity log.

### Email links (every project)
In Authentication > URL Configuration, set the Site URL to the app's address and add each organization's address to the
Redirect URLs. In Authentication > Emails, change the link in these templates so links work in any browser and mail
scanners can't use them up:
- Reset password: `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Reset password</a>`
- Confirm sign up: `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup">Confirm your email</a>`

### Going live with Phases 0 and 1
1. Back up the live database and run `select take_balance_snapshot('before-phase-1')`.
2. Apply the migrations in order, then deploy the app straight away. The migration removes `profiles.role`, so the
   current live app stops working until the new one is up. Plan a few quiet minutes.
   `smueller@trubase.org` becomes Platform Owner and Oizer's Super Admin, and `smueller@bpjcc.org` stays a regular admin.
3. Check that `select * from balance_drift('before-phase-1')` returns no rows. The migrations also stop themselves if
   any balance changes.
4. Deploy the `sign-in` and `health` Edge Functions to the live project, `sign-in` with JWT verification off. Do this before the new app goes up, or nobody can sign in.

## Where we are today

| Area | Today | Spec |
| --- | --- | --- |
| Tenancy | One organization, no `org_id` | Isolated organizations plus a Platform Owner |
| Roles | admin, manager, pending | Platform Owner, Super Admin, Admin, Primary, Secondary, Community Guest |
| Back end | Browser talks directly to Supabase; no Edge Functions, RPCs or scheduled jobs | Server-side payments, webhooks, jobs, PDFs |
| Hosting | GitHub Pages, one custom domain | Per-org URLs, Cloudflare, `noindex` and CORS headers |
| Money | Donations with a `type` column; fee and net are typed in or defaulted | Full transaction lifecycle, fee engine, audit trail |
| Tests | Typecheck and build only | Money and access rules need real tests |

Already in place and worth keeping: Postgres RLS, campaign and donor screens, sortable tables, CSV export,
Hebrew/Yiddish donor names, manager-scoped access, and live data imported from AppSheet.

## Before anything else

1. **Credentials in the spec.** It contains an OJC development login and a Pledger bearer token in plain text.
   Keep the file out of the repo and out of shared drives. If it has been circulated, ask Pledger whether that
   token is live and have it reissued. Both belong in server-side secrets only.
2. **Import token on disk.** `oizer-work/data/import_token.txt` is left over from the AppSheet import (not opened
   while writing this plan). Revoke it if it is still valid, then delete the file.
3. **Confirm a database backup and restore works** before the first schema change in Phase 1.

## Decisions needed

These change the build, so they need an answer before the phase noted.

| # | Decision | Recommendation | Needed by |
| --- | --- | --- | --- |
| 1 | The spec lets one email hold separate accounts in different orgs. Supabase Auth keeps one user per email. | Built this way: one login with a membership per org; the URL picks the org. People in two orgs share a password, which departs slightly from the spec. | Phase 1 |
| 2 | The spec names AWS/GCP/Azure, Redis and S3. | Stay on Supabase (Postgres, Auth, Storage, Edge Functions) and move the front end to Cloudflare Pages, which the spec requires in front of payment pages anyway. GitHub Pages cannot do per-org subdomains or custom headers. Confirm Supabase's uptime terms meet the 99.9% requirement. | Phase 1 |
| 3 | A separate staging Supabase project, which is an added cost. | Required. Multi-tenant RLS must not be developed against live donor data. | Phase 0 |
| 4 | Which legal entity holds vendor contracts. The spec leaves the Platform Owner undecided but also names "Success Systems". | Decide before signing USAePay, Twilio, Plaid and email contracts. | Phase 7 |
| 5 | `Exchange` campaigns and `Collect` donations exist today but not in the spec. | Both kept: 26 Exchange campaigns stay flagged, and 41 Collect donations became the status `collect`. Tell us if either should change. | Phase 2 |
| 6 | Today's `Batch` donations look like vouchers (batch/voucher number, funded, pending). The spec's "Batch Entry" means something different. | Migrate them to voucher records, after checking a sample with whoever enters them. | Phase 4 |

## Spec conflicts and the default used

The plan follows the right-hand column unless told otherwise.

| Topic | Conflict | Default |
| --- | --- | --- |
| Tenancy | "One organization, one EIN — single-tenant system" vs. the multi-tenant section | Multi-tenant |
| Roles | "Four roles" vs. the role matrix and Community Guest | All six roles |
| Sub-campaign balance | "No balance of its own" vs. Shared/Independent Balance Mode | Balance Mode |
| Reopening a closed campaign | "Only Super Admin" and "if delegated" vs. "any admin" | Super Admin or delegated admin |
| Failed email/SMS | "No automatic retry" vs. "retried up to 3×" | Provider-level retries only, then a Delivery Failed task |
| Fees on receipts | "Shown transparently on the receipt" vs. "never shown" | Gross amount only |
| Transfers | "Fundraisers have no visibility" vs. "appears in both campaigns' history" | Fundraisers see an "Internal transfer" line with the amount only, so their balance still adds up |
| Donor access | "Own campaigns only" and "No access" vs. full-database lookup | Lookup across the org, history limited to own campaigns, no database screen |
| Recurring | Changelog says USAePay recurring billing vs. the body's own engine | Own engine |
| Refund of a split leg | "Balance gains back the net" vs. net removed elsewhere | Net is removed from the campaign balance |
| Timezone | "System timezone: Eastern" vs. per-org configuration | Per-org setting, defaulting to Eastern |

## Phases

Sizes are relative (S, M, L, XL), not dates. Each phase goes to staging first and reaches production only after
sign-off, with Oizer live throughout.

### Phase 0: Foundations (M)
Staging project, repeatable migrations, automated tests for RLS and money math, append-only activity log, soft
delete, settings tables, Edge Function and scheduled-job scaffolding.
**Done when:** a test proves a manager cannot read another manager's campaign, and every campaign's balance is
snapshotted so later migrations can be checked to the cent.

### Phase 1: Multi-tenant core (XL, highest risk)
`organizations`, memberships, `org_id` on every table, and an RLS rewrite. Campaign IDs become unique per org, so
`campaigns` moves to a composite key and every foreign key that references it changes; `sources` does too.
Tenant-by-URL login, Platform Owner, logged impersonation, per-org feature switches, org details and branding,
account lockout. Oizer becomes the first tenant.
**Done when:** isolation tests pass on every table with two orgs, and all Oizer balances match the Phase 0 snapshot.

### Phase 2: Roles and the transaction model (L)
Built on staging. Screens say Fundraiser; in the database they stay `managers`, with `manager_id` as the Primary and
`sub_manager_ids` as the Secondaries. A team table can wait for Phase 5, when primaries request team changes. Guests
are listed by email in `campaign_guests`. Permission overrides are stored and manageable, and take effect as each
feature they apply to is built. Fundraisers entering pledges and adding donors arrives with those screens in Phases 4
and 5, and hiding transfer details from them with Phase 4.
Super Admin, delegation, permission overrides, suspend and deactivate. Transaction statuses replace `type`.
Campaign statuses (Draft, Active, Archived, Closed) with auto-reactivation. Internal and external names, permanent
IDs, Featured.
**Done when:** the role matrix is covered by tests and balances still match.

### Phase 3: Tables and navigation (M)
Built on staging. A bulk void records the void here only; gateway voids arrive with Phase 8. Last-4 card search needs card
data, which also arrives with Phase 8.
Filter on any column, saved views and personal defaults, column picker, frozen columns, compact mode, date-with-time
display, alternating rows, inline "+ Create New" in every picker, campaign ID bar, Global Transaction View with
totals, bulk edit, and bulk void or delete with typed confirmation.

### Phase 4: Money operations (XL)
Being built in three parts. Part 1 is on staging: fees and methods, fundraiser entry with approval, batch entry, splits,
refunds, returned and post-dated checks, duplicate flags and unattributed payments. Splitting works on a saved gift (save,
then Split), by admins only. Part 2 is on staging too: vouchers and pledges, one-time and recurring, with automatic matching. Paying a pledge by card waits
for Phase 8, and overdue items reach the Task Sheet and digests in Phases 5 and 7. Existing Batch rows stay as they are until
someone who enters them confirms how they map to vouchers (see decision 6). Part 3 is on staging too: sub-campaigns with shared or independent balances, transfer rules (admins only, reversed rather than
edited) and bank routing by campaign, method and default. Sub-campaign payment pages wait for Phase 8, payouts for Phase 6, and
machine assignment for Phase 9.
Fee configuration with per-campaign overrides, manual entry with approval, batch entry, split donations, vouchers,
pledges including recurring schedules and auto-matching, post-dated checks, NSF, refunds, deletes, duplicate
detection, unattributed payments, sub-campaigns, transfers, bank accounts and routing rules.

### Phase 5: Workflow (L)
Being built in parts. Part 1 is on staging: the Admin Task Sheet, campaign requests and team requests. The sheet covers the
types whose features exist so far; payout, delivery failure, receipt, machine, recurring and reconciliation items arrive with
those phases, and its emails with Phase 7. Part 2 is on staging too: templates, private fundraiser tasks and call lists. Template page settings take effect with the
payment pages in Phase 8, and due-today reminders with Phase 7. Part 3 is on staging too: donor lookup, the contact log, duplicates and merging, both dashboards and the balance summary.
Part 4 is on staging too: the Jewish calendar with Shabbos and Yom Tov warnings, and the machine registry, assignment history and booking. That completes the phase's screens.
Booking notifications arrive with Phase 7, payouts on the calendar with Phase 6, webhook routing with Phase 9, and phone booking with Phase 10.
Admin Task Sheet with all task types, campaign requests and templates, fundraiser tasks and call lists, donor contact
log, donor merge, duplicate flags, dashboards and balance summary, inactive-campaign flags, Jewish calendar with
Shabbos and Yom Tov warnings, machine registry, assignment history and booking.

### Phase 6: Payouts and documents (L)
Being built in four parts. Part 1 is on staging: payee profiles with Do Not Pay, rejection notes and merging; payout
requests from fundraisers with bank and Zelle details encrypted by a Vault key; approval on the Task Sheet (first admin
wins); scheduled payouts; custom payout methods; and payee details hidden from fundraisers without payout rights, while
their balances still count every payout. Part 2 is on staging too: per-account check settings, checks printed on letter
stock with the check on top and two stubs, numbered per account and never reused, the check register (outstanding,
cleared, voided with a reason, lost), signature images, and the organization's own MICR font (upload a licensed
E-13B font; printing is blocked until one is added). Matching cleared checks to the bank is Phase 11. Part 3 is on
staging too: receipts with permanent R-YYYY-NNNNN numbers, frozen when issued; receipt text at four levels (single
donation, campaign, fundraiser, default) with Hebrew right to left; partial amounts; Void & Correct; receipts voided
automatically when a donation changes, with a Task Sheet item to reissue; one receipt for a split donation; bulk
receipting by date range; year-end statements with a permanent log. Receipts and statements print from the browser
(save as PDF); sending them by email or SMS, auto-receipts and PDF attachments arrive with Phase 7. Part 4 is on staging
too, which completes the phase: every table exports to Excel and CSV and prints (save as PDF) with headings on each page;
the source report; campaign reports and donor lists from a campaign's page; the fundraiser directory; and bulk imports
(campaigns with opening balances, donors, donation history, pledges, fundraisers, and campaign contact lists) with a
preview, a permanent log, Task Sheet conflicts, and reversal within 24 hours. Background exports with an emailed link,
and welcome emails for imported fundraisers, arrive with Phase 7. Payout emails arrive with Phase 7 and phone requests with Phase 10.
On live, each payee name already used becomes a profile (about 1,040; some differ only by punctuation and can be merged).
Payees and Do Not Pay, payout requests with encrypted bank details, scheduled payouts, check PDF with MICR line,
check register, receipts with the override cascade and permanent numbering, year-end statements, campaign reports,
donor lists, source reports, Excel/CSV/PDF export, the three bulk imports with 24-hour reversal.
**Test before use:** print sample checks on real stock and confirm MICR positioning with the bank.

### Phase 7: Communications (L, needs vendors)
Email and SMS providers, donation notifications and digests, Delivery Failed handling, link sharing, Custom Outreach
with tracking and opt-outs, internal messaging with voice notes, announcements and broadcasts.
**Needs:** verified sender domain, Twilio account and US A2P SMS registration, which has its own lead time.

Part 1, the sending engine, is built. Every email and text is a row in `messages`. The `send-messages` function hands
messages to SendGrid and Twilio. It runs as soon as a message is queued, and again every minute; the database calls it
with a token kept in its Vault. `message-events` records SendGrid's signed event webhook, Twilio's signed status
reports, and STOP/START replies. A failure becomes one Delivery Failed task per message, with no automatic retry. Each
organization has Messaging Settings: sender, texting number, test list, and a test mode that holds everything else
until it is switched off. Receipts and statements can be sent by email (the page itself) or by text (a private link
valid for a year).

Provider keys are Edge Function secrets the owner enters: `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_PUBLIC_KEY`,
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. The project's URL is the Vault entry `project_url`.

Part 2, notifications, is built. The `run_notifications` job runs every minute and handles:
- **Donation alerts:** sent to the campaign's fundraisers and to the parent campaign's primary. Donary machine payments,
  opening balances and imported rows are left out.
- **Refund and returned-check alerts:** sent only to the team of the campaign whose money went back.
- **Admin donation alerts:** each admin chooses all donations, those at or over an amount, or none, on all or chosen
  campaigns.
- **New Task Sheet items:** sent right away. Payout requests follow each admin's own payout setting.

Timed emails go out in each organization's own time zone:
- **8 AM:** a digest of Task Sheet items waiting a day or more, the admin donation digest (daily, or weekly on Sunday), and
  each fundraiser's tasks due today.
- **Sunday:** digests of open pledges and open vouchers.
- **At `machine_digest_time`:** each campaign's machine-by-machine summary.

These are sent as they happen, by triggers:
- decisions on campaign, team and payout requests
- team additions (to the person added and to the primary)
- machine booking confirmations with the person's place in line, and later status changes

Everyone sets their own choices under My Notifications: email, text or both for each kind. Fundraisers can't turn off
their donation alerts. The Task Sheet is read as one of the organization's admins would see it.

Still to come in Phase 7: automatic receipts (they need the receipt page drawn on the server), recurring-donation notices
with Phase 8, and message alerts with part 4.

Parts 3 and 4 haven't started:
- Part 3: payment link sharing and Custom Outreach.
- Part 4: internal messaging.

### Phase 8: Public payment pages and cards (XL, needs vendors)
Public pages per campaign in English, Hebrew and Yiddish, Pay.js card capture, Turnstile, Cloudflare rate limits,
cover-the-fee, custom fields, donor wall, thank-you page, embeddable widget, saved cards, gateway void and refund,
recurring engine with retries.
**Needs:** USAePay merchant account and sandbox, plus a PCI scope review. Admin and IVR card entry bring card data
server-side under the spec as written; using Pay.js for admin entry would reduce that.

### Phase 9: Donary and DAF integrations (L, needs vendors)
Donary reference APIs and all four webhooks with idempotency. OJC, Matbia, The Donors Fund and Pledger integrations,
each with its own fields, error mapping, and void or refund rules.
**Needs:** production credentials from each. The spec lists open questions for Pledger (sandbox, error catalog, void
token) and The Donors Fund (who the validation token is issued to).

### Phase 10: Phone and SMS lookup (L, needs vendors)
SMS campaign lookup, then every IVR flow. Evaluate Twilio's PCI payment feature for card entry rather than handling
digits in our own functions.

### Phase 11: Bank reconciliation (L, needs vendors)
Plaid feed, auto-matching, discrepancy handling, check clearing and stale checks, bank-to-bank transfers, period
sign-off. Manual reconciliation can ship before Plaid is contracted.

### Phase 12: Platform operations (M)
Public API with scoped keys and rate limits, independent uptime monitoring and status page, org onboarding, custom
domains, "Powered by" footer.

## Spec coverage

| Spec section | Phase |
| --- | --- |
| Design principles: filtering, default views, inline create, display standards | 3 |
| Design principle: delivery failure | 7 |
| Multi-tenant architecture | 1, 12 |
| User roles, admin accounts, overrides, multi-fundraiser campaigns | 2 |
| Transaction management | 2, 3, 4 (gateway void: 8) |
| Pledge tracking, batch entry, split donations, vouchers, fee deduction | 4 |
| Features: campaign and donor management | 2, 4, 5 |
| Features: receipts and year-end statements | 6 |
| Custom outreach, internal messaging, notifications, link sharing | 7 |
| Fundraiser tasks, Admin Task Sheet, campaign templates and requests | 5 |
| Campaign payment page, recurring donations, saved cards | 8 |
| Campaign ID system, archiving and reactivation | 2 |
| Donor lookup, contact log, merge, dashboards | 5 |
| Customizable table views | 3 |
| Sub-campaigns, transfers, bank routing | 4 |
| Payment processing: USAePay | 8 |
| Payment processing: Donary, DAF platforms | 9 |
| Payment processing: manual entry, custom methods | 4 |
| SMS lookup, phone IVR | 10 |
| Jewish calendar, machine booking, machine mapping | 5 (webhook routing: 9) |
| Bank integration and reconciliation | 11 |
| Source reporting, payouts, check generation, bulk import, print and export | 6 |
| Webhooks | 9 |
| API endpoints, public API, SDKs and widget | 8, 9, 12 |
| System health and monitoring | 12 |
| Authentication and lockout | 1 |
| Activity log, soft delete, retention | 0 |
| Concurrency rules | 5 |

## Migrating current data

| Today | Becomes |
| --- | --- |
| `managers`, `user_managers` | Fundraisers and org memberships |
| `campaigns.manager_id`, `sub_manager_ids` | Campaign team (Primary, Secondary) |
| `real_name`, `friendly_name`, `campaign_name` | Internal and external names (confirm which is which) |
| `donations.type` | Transaction status and method; see decisions 5 and 6 |
| `expenses` | Payouts, keeping their history and check numbers |
| `accounts` | Bank accounts |
| `sources` | Donary machines with numeric nicknames, plus source tags. Sources named like `Oizer #6` with a `DP_` ID become machines automatically, unassigned; the rest stay sources |
| `transfers` with no source campaign | Stay as they are. These 35 are campaign balances brought over before the first program, so really unrecorded donations (confirmed by the office, November 2026) |
| `collectors` | Stays; used on cash entry |
| Yiddish name fields | Hebrew title, name and suffix |
| `pledges`, `tasks`, `transfers` | Extended in place |

Rule for every migration: each campaign's balance after must equal its balance before, to the cent. The migration
fails if it does not.

## Outside review needed

These need a qualified person, not just code: PCI scope (Phases 8 to 10), tax wording on receipts and statements,
TCPA and CAN-SPAM compliance for outreach, and storing bank details for payouts.
