# Oizer platform roadmap

Plan for growing the Oizer CRM into the multi-tenant platform described in the Campaign Management System
spec (v1.0, June 2026). The spec itself is not committed here because it contains credentials (see
[Before anything else](#before-anything-else)).

Status: Phases 0 to 6 are live. On 2026-11-02 the "Oizer DRM" project (`wwaknikpdquwnphhwzsm`, Trubase Live org),
until then staging, became production, served from Cloudflare Pages (`oizer-drm`). The old `oizer-crm` project and
GitHub Pages site are retired. It still holds test data; the real data is reimported once the final version is ready.
Phases 7 and 8 are live (Apple Pay, Google Pay and 3-D Secure deferred). Phase 9 part 1, DAF cards and ACH through
Sola, is live; the Donary part waits for Donary's API documents and credentials. Phases 10 to 12 haven't started.

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
| 4 | Which legal entity holds vendor contracts. The spec leaves the Platform Owner undecided but also names "Success Systems". | Decide before signing Sola, Twilio, Plaid and email contracts. | Phase 7 |
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
| Recurring | Changelog says processor recurring billing (USAePay, now Sola) vs. the body's own engine | Own engine; Sola's Recurring API as fallback |
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

**Per-organization keys (migration `20261127000000_org_integration_keys.sql`, approved direction).** Each
organization can bring its own SendGrid, Twilio and Turnstile keys, like its Sola keys:
- The Super Admin enters them on the Messaging and Payments settings screens. Secret parts are encrypted with the
  Vault key `payment_keys_key`; the screens only learn whether a key is set (and the last four of the Twilio SID).
- Until an organization sets its own, the platform's Edge Function secrets above are used, so nothing stops working.
  "Use the platform's keys" clears one service.
- Delivery reports and texts signed with an organization's own keys arrive at its own webhook address (`?org=<id>`)
  and can only touch that organization's messages.
- The payment page uses the organization's Turnstile site key, and the `give` function its secret, falling back to
  `VITE_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.

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

Part 3, sharing and outreach, is built.

**Sharing a campaign's payment link.** The Share button on a campaign is for admins, and for fundraisers on their own
campaigns. It:
- copies the link, or gives a button snippet to put on a website
- emails or texts the link with the organization's check, Zelle and EIN details, plus an optional message above or
  below them
- shows the campaign's share history

The link comes from the campaign's Payment Link field until the payment pages arrive in Phase 8.

**Custom Outreach** is admin only:
- recipients are picked donors and fundraisers, groups (a campaign's donors, all donors, all fundraisers, primaries), or
  typed addresses, which aren't saved
- sent by email, text or both, with `{first_name}`, `{last_name}` and `{campaign_name}` filled in per person
- **bold**, *italic* and links in email, a preview per recipient, an optional PDF attachment, and scheduling with cancel
- saved templates
- a history showing delivery, opens and clicks per recipient and per send

**Both are marketing sends, so they carry opt-outs:**
- Every email has an unsubscribe link, the organization's address, and a List-Unsubscribe header. Every text ends
  "Reply STOP to opt out."
- Unsubscribing stops only marketing email; receipts and notifications still go. SendGrid unsubscribes and spam reports
  count as unsubscribes too.

Part 4, internal messaging, is built. Under Messages:
- **Conversations:** each fundraiser has one conversation with the office, which all admins share. Fundraisers can't
  write to each other, except in a campaign group chat that an admin turns on; turning it off hides it but keeps the
  history.
- **Voice messages:** hold to record, up to 2 minutes, stored apart from the text. Admins can download them.
- **Read receipts:** come from when each side last opened the conversation.
- **For admins:** quick replies (only the Super Admin edits them), one pinned announcement (emailed when posted,
  can't be dismissed), and broadcasts to all fundraisers, primaries or chosen ones. A broadcast lands in each
  person's conversation, and broadcast history is kept.
- **Unread count:** shows on the menu and on a bell in the header, which for admins adds the Task Sheet count.

**Email alerts:**
- Fundraisers hear when the office writes.
- Group members hear about new group messages.
- Admins choose right away, a morning digest of unread messages, or off.
- Someone emailed about a conversation in the last ten minutes, who hasn't opened it since, isn't emailed again.

**Not built:**
- Messages are fetched every 15 seconds, not pushed live.
- Automatic receipts are still to come.

Phase 7 is complete apart from automatic receipts.

### Phase 8: Public payment pages and cards (XL, needs vendors)
Public pages per campaign in English, Hebrew and Yiddish, Turnstile, Cloudflare rate limits, cover-the-fee, custom
fields, donor wall, thank-you page, embeddable widget, saved cards, gateway void and refund, and the recurring engine
with retries.

**Processor: Sola Payments, not USAePay.** The owner decided this on 2026-11-02. Sola is the former Cardknox, so its API
hosts are on cardknox.com. Each organization has its own Sola account and keys:
- **Keys:** the **iFields key** is public and safe in the browser, so it's stored plainly. The **API key** (`xKey`)
  must stay on the server; it's stored encrypted, like payee bank details, and only the payments Edge Function reads it.
  Each organization enters its own keys on a Payments settings screen.
- **Sandbox or production:** the key decides which, so the screen marks keys as sandbox for labels and 3-D Secure's
  staging mode.
- **Card capture:** iFields (`cdn.cardknox.com/ifields/<version>/ifields.min.js`) for both the public page and admin
  entry. Card number and CVV go straight from the browser to Sola as single-use tokens, so card data never reaches our
  server. That should keep us out of PCI scope (likely SAQ A, to be confirmed with Sola), and it removes the old
  concern about admin entry.
- **Charging:** a payments Edge Function posts to `https://x1.cardknox.com/gatewayjson` with the organization's
  `xKey`, `xVersion` 5.0.0 and these commands:
  - `cc:sale`
  - `cc:void`, `cc:refund` and `cc:voidrefund`
  - `cc:save`
  - `check:*` for ACH
  
  Each charge gets a unique `xInvoice`, so Sola's duplicate block protects against double submits.
- **Saved cards:** each card is stored on the donor as Sola's `xToken`, which never includes the CVV, and charged
  later with `cc:sale` plus `xToken`.
- **Recurring:** keeps our own engine, as decided earlier: scheduled `cc:sale` with the saved token, retried after 3
  and then 7 days. Sola's Recurring API (it has a Hebrew-calendar option) stays a fallback.
- **Webhooks:** each organization points Sola's webhook at our function, with a PIN of 15 or more characters, and we
  check the `ck-signature` MD5. Sola tries once and doesn't retry, so the webhook only confirms; our own response
  handling is the record.
- **Cover-the-fee:** we add the fee to `xAmount` ourselves, since Sola documents no surcharge field.
- **Testing:** use Sola's test cards (Visa 4111 1111 1111 1111). Amount 9.91 declines, 9.92 returns a gateway error,
  and CVV 222 fails the CVV check.

Planned parts:
1. Payments settings and admin card entry: keys, charge a card on New Donation, void and refund at the gateway, saved
   cards on the donor, webhook receiver.

   **Built.** The Super Admin enters the keys under Settings → Payments. The API key and webhook PIN are encrypted with
   the Vault key `payment_keys_key`.
   - **Charging:** "Charge a card" on New Donation and on the donor's Cards panel uses iFields 3.5.2607.1401. Each
     attempt is a `gateway_transactions` row. The `payments` Edge Function checks the admin through the database as
     them, reads the key, calls Sola and records the answer as that admin.
   - **Results:** an approval becomes a completed Credit Card donation with Sola's reference in `gateway_id`. A decline
     becomes a `failed` donation that doesn't count.
   - **Voids and refunds:** "Void at Sola" and "Refund at Sola" on a card donation; refunds are full only.
   - **Saved cards:** stored encrypted in `donor_cards`.
   - **Webhook:** `sola-webhook?org=<id>` checks the PIN signature, logs to `gateway_events` and finishes any charge
     whose answer was lost.
   - **Not yet:** ACH (`check:*`), partial refunds, and surcharges.
2. Public payment pages per campaign in three languages, with Turnstile, cover-the-fee, custom fields, donor wall and
   thank-you page. A campaign's Payment Link fills in automatically.

   **Built.** The page is at `<org address>/#/give/<campaign>`, needs no sign-in, and can be turned off per campaign.
   - **Payment Link:** new campaigns, and existing ones without a link, get this address.
   - **Content:** comes from the campaign's page settings plus new fields (page on or off, cover-the-fee on or off,
     suggested amount, description, thank-you message, banner). Admins and the primary fundraiser edit them on the
     campaign's Settings tab.
   - **Cover-the-fee:** `cover_fee_total` finds the smallest charge whose fee leaves the campaign the full gift. The
     donation records `fee_covered` and `custom_fields`.
   - **Charging:** the `give` Edge Function (no JWT) checks Cloudflare Turnstile, using `TURNSTILE_SECRET_KEY` and
     `VITE_TURNSTILE_SITE_KEY`. Without a secret it accepts only organizations on sandbox keys. The database enforces
     the page's rules, plus 5 failed or 20 total attempts per IP per hour.
   - **Recording:** an approved gift finds the donor by phone or email, or adds one, and is credited to the Online
     source. A decline is kept as a failed transaction with the IP.
   - **Thank-you page:** "Send me a receipt" adds a Receipt Requested item to the Task Sheet. That's the first item to
     use `task_items`, so new kinds no longer need the view rewritten. The office issues and sends the receipt from
     there until automatic receipts exist.
   - **Before real donors:** the Hebrew and Yiddish wording needs checking by a native speaker. DAF card options come
     with Phase 9.
3. Recurring donations: schedules, retries, notices, admin cancel, pause and change.

   **Built.** `recurring_donations` runs on our own engine with the donor's saved Sola card.
   - **From the page:** weekly, monthly, quarterly or annually, from a start date, until cancelled or for 2 to 520
     payments, with a live total and a terms box to tick. Starting today charges the first payment. A later start only
     saves the card (`cc:save`).
   - **From the office:** set one up on a saved card from the donor's Cards panel. "Save a card" saves without charging.
   - **Charging:** `kick_recurring` runs hourly (and on resume or retry) and calls the `recurring-charges` function. It
     claims what's due in the organization's own date and charges the saved token.
   - **Recording:** `record_gateway_result` records the donation and moves the schedule on in the same transaction, so a
     payment is never charged twice. Only successful charges count toward a fixed number; the last one completes the
     schedule. A closed campaign's charge lands unattributed.
   - **Failures:** retried after 3 days, then 7. The first failure notifies admins and the team. The third pauses the
     schedule and adds a Recurring Charge Failed item (via `task_items`).
   - **Admin controls:** pause, resume, retry now, cancel (the donor is told), and change the amount, frequency, card or
     next date.
   - **Deleted cards:** deleting a card cancels the recurring donations it paid for.
   - **Recurring page:** shows what's due in the next 30 and 90 days. Fundraisers see their own campaigns'.
   - **Not yet:** automatic receipts per charge, which need the server-side receipt renderer.
4. Embeddable widget, Apple Pay and Google Pay, and 3-D Secure.

   **Widget built.** `/widget.js?` is placed on any site as `<script src="<org address>/widget.js"
   data-campaign="1001">`.
   - **Button mode:** a Donate button that opens the campaign's page over the host site.
   - **Inline mode:** `data-mode="inline"` puts the form in the page, and the page reports its height so the frame
     never scrolls.
   - **The framed page:** `embed.html`, the same app, which the headers allow inside other sites (`frame-ancestors *`).
     It shows only donation forms, so no portal screen can be framed.
   - **Where to get it:** the campaign's Share window gives both snippets.
   - **Microphone:** the site headers now allow it on the CRM's own pages, so voice messages can record (they were
     blocked before).

   **Deferred by the owner on 2026-11-03:** Apple Pay, Google Pay and 3-D Secure.
   - Apple Pay needs an Apple Developer account, a merchant ID, and certificates in each organization's Sola portal.
   - Google Pay setup goes through a Sola representative.
   - 3-D Secure makes full billing address and mobile number required, and Sola's docs disagree on some verify-step
     fields, so confirm with Sola first.
   - Sola's docs for all three are summarized in the session notes: iFields `enable3DS`/`verify3DS`, the
     `/verifyJSON` endpoint, and `xDigitalWalletType` `ApplePay`/`GooglePay` with the base-64 token in `xCardNum`.

**Needs:**
- each organization's Sola sandbox keys (sign up at solapayments.com/devsdk), and production keys at go-live
- a Cloudflare Turnstile site key
- Sola to confirm the PCI SAQ type, and whether its PayFac fee pass-through applies

### Phase 9: Donary and DAF integrations (L, needs vendors)
Donary reference APIs and all four webhooks with idempotency. OJC, Matbia, The Donors Fund and Pledger integrations,
each with its own fields, error mapping, and void or refund rules.

**Changed on 2026-11-04: DAF cards and ACH go through Sola where Sola supports them.** The owner reports that each
organization's Sola account accepts most DAF payments and ACH. That replaces most of the separate DAF integrations.

DAF cards:
- Sola's gateway takes DAF cards with `xCommand` `grant:Recommendation`, and cancels them with `grant:Void`. A
  `grant:refund` event appears in the webhook list but isn't documented.
- Sola picks the DAF program from the card. The docs name DonorsFund, OJC and Pledger, and `xCardType` returns
  "DonorsFund", "OJC" and "Pledger".
- Matbia isn't in Sola's docs, but the owner's current payment page already sends Matbia to Sola, so it goes
  through Sola too. Fidelity and PayPal Giving aren't covered.
- **Fields, from the owner's current payment page (all sent to Sola):**

  | Program | Fields |
  |---|---|
  | OJC | card number, MM/YY |
  | Pledger | card number, MM/YY, CVV |
  | Matbia | card number, MM/YY |
  | The Donors Fund | either card number + CVV, or account email + 4-digit PIN |

  Each method has a button on the page, beside Credit Card, and each can be made recurring.
- **To confirm with Sola:**
  - which request fields carry these (especially the Donors Fund email and PIN)
  - whether iFields captures DAF card numbers
  - the response format, and refund rules
  - how DAF is enabled per account
  - the sandbox test cards (Donors Fund amounts must be under $5)
- DAF gifts get no receipt, as the spec says, and keep the fee rules of their payment method.

ACH:
- **Commands:** `check:sale` (`xRouting`, `xAccount`, `xName`, optional `xAccountType`), `check:save` (gives a token),
  `check:void` (before the day's batch is sent), `check:refund` (full only, after settlement), and `check:VoidRefund`
  (ACHQ accounts only).
- **Card fields:** iFields has an ACH field (`data-ifields-id="ach"`, token in `xACH`). How it maps to `xAccount`
  needs confirming with Sola, and routing is typed in plainly.
- **Results:** come 2–3 days later as `xStatus` 16 Settled, 18 Returned or 14 Chargeback. ACHQ accounts also get
  `xStatusReason` codes such as "R01 - Insufficient Funds". A returned ACH payment becomes the existing Returned status,
  with its Task Sheet item.
- **Confirm with Sola:** whether returns trigger a webhook. Otherwise poll the reporting API daily.
- **Form, from the owner's current payment page:** a Credit Card / Check switch; Account Type (checking or savings),
  Name on Account, Routing Number and Account Number, each typed twice to confirm; then the ACH authorization text
  (downloadable) with a required "I acknowledge" box, before the human check.
- **Compliance:** Nacha requires the donor's authorization (signature or electronic consent) to be captured and kept.
  Store the exact authorization wording shown, the time, and the IP with each gift and saved account.
- **Recurring and saved accounts:** ACH tokens work with `check:sale` + `xToken`, so recurring donations and saved
  accounts can use bank accounts too.

**Built (part 1, migration `20261126000000_daf_and_ach.sql`):**
- The Super Admin turns on ACH and each fund under Settings → Payments, and can replace the ACH authorization wording.
- The payment page shows the method buttons; the office's "Take a payment" and "Save a card or account" do the same.
- Gifts are recorded as `ACH` or `<Fund> Online`, so fees and the no-receipt rule follow the existing payment methods.
  Cover-the-fee uses the chosen method's fee.
- Each bank debit keeps the wording agreed to, the time, the IP and who agreed (donor, or the admin attesting).
- The webhook marks a bank debit settled, or returned with its reason; a return puts "Bank Payment Returned" on the
  Task Sheet. DAF grants void only; refunds are refused with a note to ask the fund.
- Recurring: bank accounts work like cards. A fund's recurring grant starts today and repeats only if Sola returns a
  token on the first grant; otherwise the donor is told it wasn't set up.
- Field mapping guessed until Sola confirms: DAF cards in `xCardNum`/`xExp`/`xCVV`; Donors Fund email and PIN in
  `xCardNum`/`xCVV`; bank numbers typed plainly (both numbers twice) rather than through the iFields ACH field. ACH
  returns rely on the webhook; a daily report check is still to do if Sola doesn't post returns.

**Needs:** production credentials from Donary, and Sola's answers above. The spec's open questions for
Pledger and The Donors Fund move to Sola.

### Phase 10: Phone and SMS lookup (L, needs vendors)
SMS campaign lookup, then every IVR flow. Evaluate Twilio's PCI payment feature for card entry rather than handling
digits in our own functions.

### Phase 11: Bank reconciliation (L, needs vendors)
Plaid feed, auto-matching, discrepancy handling, check clearing and stale checks, bank-to-bank transfers, period
sign-off. Manual reconciliation can ship before Plaid is contracted.

**Part 1, manual reconciliation, is built (migration `20261128000000_bank_reconciliation.sql`, not yet applied).**
Admin only, under Payouts → Bank Reconciliation, per bank account:
- **Bank lines:** a statement export (CSV or Excel) from any bank. The header row and columns are guessed (one amount
  column, or debit and credit) and can be changed; dates and amounts in the usual US formats are read. A file brought in
  twice, or overlapping statements, only adds new lines; two identical lines in one file both count. A file can be undone
  until one of its lines is matched. Lines can also be typed in. Plaid will feed the same table later.
- **The books for an account:** gifts deposited there (post-dated checks on their check date), refunds and returned
  checks taken back out, payouts (printed checks on the check's date; a payout whose only check was voided is left out),
  and transfers between accounts. An item that never passes through the bank, such as an opening balance, can be set
  aside with a reason.
- **Matching:** any number of bank lines to any number of book items. Amounts always come from the books. A difference
  has to be named: processor fees kept back, bank fee, interest, or something else with a note. A bank-only line (a fee,
  interest) is matched with no book items. Matching a payout clears its check; unmatching puts it back to outstanding.
- **Matching automatically**, only where there is exactly one answer: a check by its number and amount; one line and one
  item with the same amount, the item no more than `recon_match_days` (default 10) days before a deposit or 120 before a
  withdrawal; and a deposit equal to a day's gifts by one method or all of that day's gifts, in full or less their fees.
- **Between accounts:** transfers between the organization's own banks, with no campaign balance change. A cross-account
  campaign transfer puts "Bank Transfer Needed" on the Task Sheet until its bank transfer is recorded (new transfers
  only; earlier ones aren't backfilled).
- **Periods:** sign-off needs every bank line through the end date matched or explained, and opening balance plus the
  lines to equal the statement's ending balance, to the cent. The first period takes the statement's start date and
  opening balance; each later one starts the day after the last, from its ending balance. The report keeps deposits in
  transit, outstanding payments, the adjusted bank balance and the differences by kind, and prints. A signed-off period
  locks its lines and matches; only the Super Admin can reopen it, latest first, with a reason.
- Each import, match, unmatch and sign-off is in the activity log.

Still to come: the Plaid feed, a book balance per account (the books have no opening balance per bank account yet, so
the report reconciles the bank side), stale-check handling beyond today's Task Sheet item, and a daily ACH-return report
check if Sola doesn't post returns.

### Phase 12: Platform operations (M)
Public API with scoped keys and rate limits, independent uptime monitoring and status page, org onboarding, custom
domains, "Powered by" footer.

**Built (migration `20261129000000_platform_operations.sql`).** Decisions from Shulim, 2026-11-09: read-only API with
per-organization keys made by the Super Admin, 60 requests a minute per key; a Cloudflare scheduled Worker and our own
status page, no paid service; only the Platform Owner creates organizations (already the case); `<slug>.trubase.org`
by default plus the organization's own domain through Cloudflare; the "Powered by" footer is a per-organization setting.

- **Public API** (`api` Edge Function, `GET /functions/v1/api/v1/{campaigns,donors,donations}[/<id>]`). Keys look like
  `oz_live_<8>_<48>`, are shown once and kept only as a SHA-256 hash, and each reads only the kinds of records it was
  given. Donors come with names only; their email, phone and address are a separate permission (`donor_contact`,
  migration `20261130000000_api_donor_contact.sql`). Lists page 50 at a time (`limit` up to 100, `after`, `updated_since`; donations also by `campaign_id` and
  `donor_id`). The database checks the key, scope and rate limit in `api_request()`; errors carry their HTTP status
  (401, 403, 404, 422, 429 with `Retry-After`). No CORS: keys belong on servers. Settings → Organization → API Keys.
- **Uptime and status page** (`workers/uptime`). Every 5 minutes, from Cloudflare: the app's addresses, the database and
  scheduled jobs (the `health` function), sign-in, and the public API. 90 days kept in Workers KV; the Worker serves the
  page at `/` and JSON at `/status.json`, and emails Shulim on a change through the platform's SendGrid key. Stays at
  its `oizer-status.<subdomain>.workers.dev` address for now. **Not deployed yet:** it needs a Cloudflare token with
  Workers Scripts and Workers KV Storage edit, then the `SENDGRID_KEY` secret. Alerts come from `status@mail.trubase.org` (verified in SendGrid). Free on
  the Workers Free plan (one cron trigger, about 576 KV writes a day of the 1,000 allowed).
- **Web addresses** (`domains` Edge Function; Settings → Organization → Web Addresses). The Super Admin sets up the
  default `<slug>.trubase.org` and up to five of their own (a subdomain such as `donate.example.org`; a bare domain can't
  CNAME here). The screen shows the DNS records to add; Cloudflare verifies the domain and issues and renews the
  certificate; "Check now", the open screen every 30 seconds and a job every 10 minutes ask again. An address leads to
  the organization only when the address and its certificate are both active, and stops the moment it is removed.
  Addresses under trubase.org can't be claimed as an organization's own.
  - `DOMAIN_PROVIDER=pages` (default): custom domains on the Pages project. Free, up to 100 per project on the Free plan.
    Works with trubase.org's DNS where it is today (Google Cloud DNS).
  - `DOMAIN_PROVIDER=saas`: Cloudflare for SaaS custom hostnames, routed to the app by `workers/router`. Needs a zone
    hosted at Cloudflare (`CF_SAAS_ZONE_ID`, `CF_SAAS_TARGET`). 100 hostnames included on Free/Pro/Business, then $0.10
    per hostname per month; Cloudflare may ask for a payment method on the account before enabling it.
  - Nothing happens until the Edge Function secrets `CF_DOMAINS_TOKEN` and `CF_ACCOUNT_ID` are set. **Switched off for
    now** (Shulim, 2026-11-09): built and deployed, waiting for that token. Addresses already working keep working.
  - Each default subdomain gets its own CNAME to `oizer-drm.pages.dev` in trubase.org's DNS (Google Cloud DNS); no
    wildcard record.
- **"Powered by" footer** (Settings → Organization). On or off, its words (80 characters) and an optional `https://`
  link; shown on payment pages, the sign-in page and the portal. Off until the Super Admin turns it on.
- **Sidebar.** Entries went from about 50 to 30: views of the same list are now tabs above the page (Campaigns: Active,
  All, Archived, Closed, Exchange; Transactions: Last 7 Days, All; Outreach; Reports; Payouts and Requests; Fundraisers
  and Directory; and the settings grouped under Organization, Users & Access, Payments, Messaging, Sources & Machines).
  Every page keeps its address.

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
| Payment processing: Sola Payments (replaces USAePay) | 8 |
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
