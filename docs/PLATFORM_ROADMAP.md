# Oizer platform roadmap

Plan for growing the Oizer CRM into the multi-tenant platform described in the Campaign Management System
spec (v1.0, June 2026). The spec itself is not committed here because it contains credentials (see
[Before anything else](#before-anything-else)).

Status: Phases 0, 1, 2 and 3 are on the staging project ("Oizer DRM" in the Trubase Live org), which holds only test data.
None of them is on the live `oizer-crm` project. Later phases haven't started.

Still open for Phase 1:
- Supabase's built-in email only reaches the project's team members, a few messages an hour. Inviting anyone else needs
  a custom email provider, which Phase 7 sets up and which sign-ups need sooner on the live project.
- Per-organization subdomains need the move off GitHub Pages (decision 2). Organizations can already be reached by a
  mapped hostname or `?org=slug`.
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
Fee configuration with per-campaign overrides, manual entry with approval, batch entry, split donations, vouchers,
pledges including recurring schedules and auto-matching, post-dated checks, NSF, refunds, deletes, duplicate
detection, unattributed payments, sub-campaigns, transfers, bank accounts and routing rules.

### Phase 5: Workflow (L)
Admin Task Sheet with all task types, campaign requests and templates, fundraiser tasks and call lists, donor contact
log, donor merge, duplicate flags, dashboards and balance summary, inactive-campaign flags, Jewish calendar with
Shabbos and Yom Tov warnings, machine registry, assignment history and booking.

### Phase 6: Payouts and documents (L)
Payees and Do Not Pay, payout requests with encrypted bank details, scheduled payouts, check PDF with MICR line,
check register, receipts with the override cascade and permanent numbering, year-end statements, campaign reports,
donor lists, source reports, Excel/CSV/PDF export, the three bulk imports with 24-hour reversal.
**Test before use:** print sample checks on real stock and confirm MICR positioning with the bank.

### Phase 7: Communications (L, needs vendors)
Email and SMS providers, donation notifications and digests, Delivery Failed handling, link sharing, Custom Outreach
with tracking and opt-outs, internal messaging with voice notes, announcements and broadcasts.
**Needs:** verified sender domain, Twilio account and US A2P SMS registration, which has its own lead time.

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
| `sources` | Donary machines with numeric nicknames, plus source tags |
| `collectors` | Stays; used on cash entry |
| Yiddish name fields | Hebrew title, name and suffix |
| `pledges`, `tasks`, `transfers` | Extended in place |

Rule for every migration: each campaign's balance after must equal its balance before, to the cent. The migration
fails if it does not.

## Outside review needed

These need a qualified person, not just code: PCI scope (Phases 8 to 10), tax wording on receipts and statements,
TCPA and CAN-SPAM compliance for outreach, and storing bank details for payouts.
