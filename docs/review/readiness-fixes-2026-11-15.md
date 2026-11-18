# Donor Base readiness fixes: work list (Nov 15, 2026)

> **Approved by Shulim Nov 15. Sample data only. Do not enforce an authenticator app; keep text/call 2FA. Skip the items listed under Held for Moshe.**

**Source:** the readiness review Page (66 proposals). This list keeps the original numbers. Supporting files are in `/workspace/oizer-drm/review/drm-readiness-2026-11-15/`: `code-data-findings.md`, the probe script `probe/probe.test.ts`, and the results in `probe/probe-results.json`.

**Ground rules:**
- Supabase project `wwaknikpdquwnphhwzsm` only.
- Never commit secrets. Keys stay in environment variables, and per-organization settings stay in the database.
- Never force-push.
- Add a regression test for every calculation or data fix.
- Report back by number: what changed, the commit, and test results.

**Infra and paid items are plan-only.** Items marked PLAN (#6 deploy part, #47, #49 live check, #50, #51, and #27 if it needs processor access) get a written plan with cost flagged. Don't change hosting, projects, plans or paid services. Infrastructure and paid upgrades need Shulim's OK.

## Held for Moshe (do not change)

- #2, #8, #10, #11, #18, #20, #21, #34, #41, #44, #54, #65 are waiting on Moshe's answers. Don't touch these behaviors.
- That includes:
  - undelivered checks on the dashboard
  - the "To collect" status and its label
  - the Total potential formula
  - payout/transfer below-zero rules
  - payout lock after check print
  - second approver
  - month/period locks on records
  - click-to-edit on donations
  - payment page desktop layout and the cover-fee checkbox
  - where New Donation goes after saving
  - menu and tab names
- **#48 is dropped.** Never require an authenticator app for anyone. Text and call 2FA must always stay available.

## Fix first: failing tests (3)

These tests are out of date because of intended changes. Update them so the suite is green:

1. `supabase/tests/methods.test.ts:75` expects 105.26. With fee round-up the correct value is 105.27.
2. `supabase/tests/phase0.test.ts:121` expects `/duplicate key/`. Now expect the friendly message "Campaign ID 1001 is already taken...".
3. `supabase/tests/roles.test.ts:100` expects highest+1 (20001). It should follow the campaign ID counter: typed IDs don't move it, so expect 1006.

**Acceptance:** `npm test` shows all tests pass.

## Blockers (6)

### #1 Fee not recalculated when a donation is edited
- **What's wrong:** `donation_defaults()` (`supabase/migrations/20261221000100_manual_fee_overrides_preset.sql:10-20`) only recalculates the fee when `manual_fee` changes. Changing the amount ($18 to $1,000 kept a $0.83 fee) or the method (Cash to Card kept $0) leaves a stale fee.
- **Fix:** on UPDATE, when `manual_fee` is null and amount, payment_method or campaign_id changed, set `fee := calculate_fee(...)` and net = amount - fee. Never overwrite a typed manual fee. Card-processor rows stay locked by `donation_edit_guard`.
- **Acceptance:** a test where a manual-entry gift edited 18 to 1000 on a 2.9% + 0.30 method gets fee 29.30 and net 970.70, Cash to Card recalculates, and a manual fee is untouched.

### #3 Voided or refunded gift still counts toward its pledge
- **What's wrong:** `match_donation_to_pledge` (trigger in `20261108000000_task_sheet_and_requests.sql:272`) adds `pledge_payments`, but nothing removes them when the gift is voided, refunded, returned or deleted. The pledge stays Fulfilled.
- **Fix:** when a donation leaves completed/collect, or is soft-deleted, delete or mark reversed its `pledge_payments` (logged), and reopen the pledge or installment.
- **Acceptance:** a pledge of 300 paid by a 300 gift shows Fulfilled. Voiding the gift returns it to Open with 300 outstanding. Same for refunded, returned and deleted.

### #4 Make refunds saved as voids
- **What's wrong:** `make_void` (`20261222001900_make_ingest.sql:188-196`) handles Sola refunds (lines 283-288) and Elevon refunds (312-316) by setting status `voided`. The fee disappears, partial refunds become full voids, both bank lines stay unmatched, and `reversal_date = current_date` is a UTC date.
- **Fix:**
  - Refunds become `refunded` with `reversal_date` = the processor's date in the org time zone, and a refunded amount. Support partial refunds (see #17).
  - Keep `voided` only for void commands.
  - Fee stays on refunds.
- **Acceptance:** a Make Sola refund payload produces a `refunded` row. A partial refund leaves the remainder counted. A void payload still voids. The Make ingest tests are updated.

### #5 Public payment page broken on phones
- **What's wrong:** at 400 px wide, the card number and CVV fields are missing or clipped, and the sticky Donate button overlaps the fields. Screenshot: `review/ux-2026-11-15/payment-page-mobile-400px.png`.
- **Fix:** repair the mobile layout so every field is visible and the Donate button never covers inputs. Leave the desktop layout alone (held, #44).
- **Acceptance:** at 360-414 px wide every field is visible and usable, and a sandbox card gift completes on a phone-sized viewport.

### #6 Live and test share one database (PLAN only)
- **What's wrong:** `.env.production` and `.env.staging` both point at the same Supabase project.
- **Plan to report back:**
  - A separate production project with daily backups and point-in-time restore.
  - Cost of the required plan, flagged.
  - Migration and deploy steps.
  - How to keep test imports out of production.
- **Rule:** no infrastructure change without Shulim's OK.

### #7 Tests don't guard deploys
- **What's wrong:** `.github/workflows/ci.yml:3-5` runs only on `main` and on PRs. Deploys run `npm run deploy` from a workstation.
- **Fix:** run CI on every branch push (including `docs/platform-roadmap`) and fix the 3 stale tests above.
- **Plan (report back):** moving deploys into GitHub Actions, gated on green CI. That needs deploy secrets set by Shulim; don't set any.
- **Acceptance:** CI runs on a push to the working branch and passes.

## Important (34)

### #9 Totals disagree across pages
- **What's wrong:**
  - Dashboard Today was $1,793 vs Transactions $1,093.
  - Dashboard 30 days was $219,037.61 for 1,864 gifts vs Transactions $220,617.72 for 1,866.
  - Platform shows 73,085 donations vs 73,000 in Transactions.
- **Fix:**
  - Explain and fix the scope differences: statuses, deleted rows, test org, created_at vs check_date.
  - Add a short "how this is calculated" note to each dashboard box.
  - Add a check (see #26) that the totals agree.
  - Don't change how undelivered checks are treated on the dashboard (held, #8). Document that difference instead.
- **Acceptance:** a written definition per number, and after the fix every total matches except the documented undelivered-check difference.

### #12 Backdated voucher funding lands on the previous day
- **What's wrong:** `add_voucher_funding` (`20261222003600_fees_round_up.sql:87`) uses `p_date::timestamptz`, which is midnight UTC, i.e. the previous day in ET. Its comparison to `current_date` is also a UTC date.
- **Fix:**
  - Use `(p_date + time '12:00') at time zone <org tz>` and `org_today()`.
  - Sweep the money-path uses of `current_date` (`make_void`, the pledge schedule windows in `campaign_summary`, the post-dated check in `donation_defaults`) and switch them to `org_today()`.
- **Acceptance:** a test with session TZ UTC: a funding dated 2026-11-10 shows `org_date` 2026-11-10, including after 7 PM ET.

### #13 Processor times without a zone read as UTC
- **What's wrong:** `make_time` (`20261222001900_make_ingest.sql:125`).
- **Fix:** if the string has no offset, interpret it in America/New_York (the org time zone). Verify against sample Sola `xEnteredDate` and Donary payloads.
- **Acceptance:** a test where "2026-11-12 01:30" gives org date 2026-11-12, and strings with offsets are unchanged.

### #14 Unknown payment method means no fee, and there are no per-processor fees
- **What's wrong:** `calculate_fee` matches on `lower(name)` and returns NULL when nothing matches. Sola and Elevon map to "Credit Card".
- **Fix:**
  - A Task Sheet item or flag for completed gifts whose method has no fee rule.
  - Block unknown methods in forms.
  - Design and implement fee rules per processor/source + method, falling back to the method rule.
  - Store the actual processor fee when a feed provides it.
- **Acceptance:** an unknown method shows a flag. A Sola card gift and an Elevon card gift can use different rates.

### #15 Fees inconsistent by source in Reports
- **What's wrong:** cash shows a $0.57 fee while some card gateways show $0.
- **Fix:** find the cause (manual fees on cash? missing rates on gateway names?) and fix the data rules or flag the rows. Sample data only.
- **Acceptance:** a short report of the cause, and Reports fees match the fee rules.

### #16 Manual fee has no bounds, and blank gave $0
- **What's wrong:** a negative fee and a fee above the amount are both accepted. In the form, leaving the manual fee blank on a card gift saved $0 instead of the preset.
- **Fix:**
  - A DB check and form validation for 0 <= manual_fee <= amount.
  - A blank manual fee must use the preset. Check whether the form sends fee 0.
- **Acceptance:** tests for the bounds, and a blank fee gives the preset fee.

### #17 No partial refunds, chargebacks or disputes
- **What's wrong:** `begin_card_reversal` (`20261126000000_daf_and_ach.sql:214`) only refunds the full amount. There's no disputed or chargeback status.
- **Fix:**
  - Partial refunds for in-app and Make.
  - A `disputed` status, held out of the balance.
  - `chargeback`, with a separate fee entry.
  - A Task Sheet item for each.
- **Acceptance:**
  - A $30 partial refund on $100 leaves $70 counted.
  - A disputed gift leaves the balance.
  - A chargeback records its fee.

### #19 "Available to pay out" figure (display only)
- **What's wrong:** Balance includes unsettled card money and uncleared checks.
- **Fix:** show an "Available to pay out" figure on the campaign page and the payout form. It is the balance minus card gifts within a hold period (org setting), minus deposited checks not yet cleared, minus open disputes. Don't block or change any payout rule (held, #18).
- **Acceptance:** the figure shows with an explanation, and the hold days setting works.

### #22 Split drops references
- **What's wrong:** `split_donation` (`20261222003600_fees_round_up.sql:95`). New parts lose `gateway_id`, `batch_id`, `bank_reference`, `voucher_id` and `created_by`.
- **Fix:** copy every reference field onto every part, and have reconciliation treat a split group as one bank item.
- **Acceptance:** a test where all parts carry the same references.

### #23 No duplicate protection on processor references
- **What's wrong:** there are no unique indexes on `donations.gateway_id` or `donary_id`. `make_existing` only looks up first, so there's a race.
- **Fix:** run the duplicate query, clean up the sample duplicates, then add partial unique indexes `(org_id, gateway_id)` and `(org_id, donary_id)` where deleted_at is null and status <> 'failed'. Handle a conflict as "duplicate" in ingest.
- **Acceptance:** a second insert with the same reference is rejected or treated as a duplicate, and the tests pass.

### #24 Guests see anonymous donors' names
- **What's wrong:** `guest_donations` (`20261103000000_roles_and_statuses.sql:674`) ignores `donations.anonymous`.
- **Fix:** return "Anonymous" when `d.anonymous`. Audit the other fundraiser, guest and public outputs for the same rule (donor wall, SMS digests, Share box).
- **Acceptance:** a guest test shows "Anonymous" for an anonymous gift.

### #25 Data Import has no preview
- **Fix:** add a dry-run step that shows counts to add, update and skip, plus row errors, before anything is saved.
- **Acceptance:** an import with errors shows them and saves nothing until confirmed.

### #26 Nightly integrity check
- **Fix:** an `integrity_report()` function and a nightly job built from the 19 queries in `code-data-findings.md` section 5:
  - orphans
  - duplicate references
  - net not equal to amount - fee
  - missing or out-of-range fees
  - batch total mismatch
  - negative balances
  - pledge payments on dead gifts
  - over-funded vouchers
  - gifts with no account
  - check vs payout amount
  - reconciled items changed after matching
  - refunds that came in as voids

  Results go to the Task Sheet, with a green or red "Books health" badge on the dashboard.
- **Acceptance:** the job runs, and seeded bad rows each show up.

### #27 Processor batch matching (PLAN first if processor access is needed)
- **Fix:**
  - Import settlement/batch reports (Sola, Elevon/Cartis, Donary): batch id, gross, fees, refunds, net, deposit date.
  - Store `settlement_batch_id` on donations.
  - Match a bank deposit to a batch, checking deposit = gifts - fees - refunds.
- **Report back:** which report formats are needed, if you don't have them.
- **Acceptance:** a sample batch file matches one deposit to its gifts.

### #28 Undelivered checks offered for bank matching
- **Fix:** exclude completed checks with delivered = false from `recon_book_items` until they're delivered.
- **Acceptance:** the undelivered check doesn't appear on the books side, and appears once marked delivered.

### #29 No book-side tie-out at sign-off
- **Fix:** compute a book balance per account (opening + book items through the period end). Show it next to the adjusted bank balance, and require equality, or a logged difference with a note, to sign off.
- **Acceptance:** sign-off is refused when there's an unexplained difference.

### #30 Real processor fee not applied
- **Fix:** an "Apply fee difference" action on a match with difference_type processor_fees. It spreads the difference across that match's donations pro-rata (rounded up, last row absorbs) with an audit note, so campaign fees reflect the real fee.
- **Acceptance:** the fees on the matched donations sum to the new total, and the campaign balance updates.

### #31 Gifts with no bank account never reconcile
- **Fix:** require an account on completed gifts. Where `route_account` returns null, use a configurable default or processor clearing account, and flag existing rows.
- **Acceptance:** new completed gifts always have `account_id`, and existing nulls are flagged.

### #32 Reconciliation summary, report, unmatch and audit
- **Fix:**
  - Per-account summary: statement balance, outstanding deposits and checks, unreconciled difference.
  - An exportable period report (CSV and PDF).
  - An unmatched-items list.
  - A visible Unmatch button and the matcher's name and time.
  - A one-line explanation of Match automatically.
- **Acceptance:** all visible on the page, and the report downloads.

### #33 Account list cleanup and bank-feed lines
- **What's wrong:** there's a duplicate "Cash" and an account named "pledge". Plaid-fed lines show Delete. Sandbox test-login text shows on other accounts.
- **Fix:** hide or disable Delete on Plaid-sourced lines (allow exclude with a reason instead), and remove the sandbox credential text from the UI. Sample data: flag the duplicate accounts for Shulim; don't delete them.
- **Acceptance:** no Delete on Plaid lines, and no sandbox text.

### #35 Campaign page Add donation button does nothing
- **What's wrong:** it throws a console error.
- **Fix:** open New Donation with the campaign prefilled.
- **Acceptance:** the button opens the form and saving works.

### #36 Undelivered check shows as green Completed
- **Fix:** show a "Not delivered" status badge (in lists and filters). The money rules are unchanged.
- **Acceptance:** undelivered checks show the badge everywhere.

### #37 Campaign 1008 counts and fees don't line up
- **What's wrong:** the header says 6 donations but the tab shows 4 (teams), and the rows show $0 fees vs $1.51 in the box.
- **Fix:** label figures "incl. teams", and make the row fees and box agree (check whether the rows show `fee` vs `manual_fee`).
- **Acceptance:** the rows sum to the box, and labels are clear.

### #38 Campaigns list doesn't add up
- **Fix:** add a Fees column, show "Shared (in parent #ID)" instead of $0.00 for teams, and add a "Below zero" quick filter.
- **Acceptance:** Raised - Fees - Expenses = Balance on the list totals.

### #39 Fast typing selects an archived campaign and clears the method
- **Fix:** exclude archived and closed campaigns from the New Donation picker (or warn on select), and don't clear payment_method when the campaign changes.
- **Acceptance:** typing "3056" quickly doesn't select the archived campaign, and the method is kept.

### #40 Transactions summary lags about 10 s
- **Fix:** show a loading state and blank the old totals while the new range loads. Ignore stale responses from earlier ranges.
- **Acceptance:** switching ranges never shows the previous range's totals.

### #42 Payouts list loads slowly
- **What's wrong:** about 20 s, with empty rows meanwhile.
- **Fix:** speed up (index or paging like the list-speed work), show a loading state, and add preset filters (To pay, Scheduled, Outstanding checks).
- **Acceptance:** first rows show in under 3 s on sample data.

### #43 Transfers lumped into Expenses
- **Fix:** on the campaign page show Transfers in and Transfers out as their own figures, separate from Expenses. Add a direction column (In/Out per campaign context) to the Transfers list.
- **Acceptance:** Balance = Raised (gifts) + Transfers in - Fees - Expenses - Transfers out, as displayed.

### #45 Settings pages flash warnings before loading
- **What's wrong:** Payments shows keys "Missing" before "Set". Account Security shows text codes "Off" before "On".
- **Fix:** loading skeletons, and no warnings until the data has loaded.
- **Acceptance:** no false warning on a slow network, tested with throttling.

### #46 Readable history
- **Fix:**
  - A History tab on donations, payouts and transfers (who, when, field, old to new) from `activity_log`.
  - A fundraiser-safe version for their own campaigns.
  - The Activity Log page shows readable changes, not raw key/value.
- **Acceptance:** editing a donation shows the change in its History.

### #47 Go-live checklist (PLAN only)
- **What's wrong:** messaging is in test mode, card processing is in sandbox, the Donary connection is off, and machines are unassigned.
- **Fix:** write a go-live checklist doc listing each switch and its order, to run after the wipe. Don't switch anything.

### #49 Future-dated migration names
- **Fix:** document the numbering rule (continue after `20261222004200`) in the README.
- **Report back (read-only):** whether the live `supabase_migrations.schema_migrations` matches the folder.

### #50 Error monitoring (PLAN only)
- **Fix:** propose error reporting for the front end, edge functions and webhooks (Make, Sola, Donary, recurring charges), with the cost of any service flagged. A free or self-built option, such as logging to a table and the Task Sheet, is OK to build.

### #51 Backups and restore (PLAN only)
- **Fix:** report the current backup and point-in-time-restore status, the cost to enable PITR, and the restore test steps. The cloud-config check is failing until Shulim sets the two GitHub secrets; don't set them.

## Nice-to-have (13)

### #52 New campaign not shown until reload
- **Fix:** refresh the list after saving, and prompt for a Primary Fundraiser on create.

### #53 Deleting a team's parent hides team money
- **Fix:** block soft-deleting a campaign with live teams or a non-zero balance.
- **Acceptance:** a test.

### #55 Campaign settings tab
- **Fix:** add image upload for banner and logo (alongside URL), use a single Save button, and speed up tab switching.

### #56 New campaign form
- **Fix:** put the name field on the first step. The "Cover the fee" default should come from the template setting, not always on.

### #57 Payment method chart is messy
- **Fix:** map imported method names to the standard methods (e.g. "usaepay" to Credit Card; payouts like "Stripe Payout- AB Charity" are not a donation method), and fold small slices into Other.

### #58 Transactions details
- **Fix:** show $0.00 instead of a blank fee, use plain label "Batch deposit" for Batch, and make donor names link to the donor. Leave the "Collect"/"To collect" label as is (held, #10).

### #59 Calculation odds and ends
- **Fix:**
  - A failed charge later marked completed should recalculate its fee.
  - Campaign fee % = fees / gifts raised (excluding transfers in).
  - Detect checks by the method's category rather than the name containing "check". Keep the same results for existing methods.
- **Acceptance:** tests.

### #60 Bank feed and bank fees
- **Fix:** a daily automatic Plaid sync, a Task Sheet item for lines unmatched more than 7 days, and one-click "record as bank fee/interest" that creates an org-level entry and matches it.

### #61 "Expenses out" shown negative
- **Fix:** explain the sign, or show it as a positive Out column, on Payments > bank accounts.

### #62 Settings save buttons and notifications
- **Fix:** one Save per Organization page (or autosave per section with confirmation). On My Notifications, fix the ticked-but-disabled box and its text, and prompt for the mobile number.

### #63 Permissions wording and guest invites
- **Fix:** plain names with a visible help line in the permissions matrix, and email invitations to guests.

### #64 Fundraisers, donors and payees
- **Fix:**
  - "Campaigns 2 (1 active)": make clear that archived campaigns are included.
  - Donor jargon labels ("OJC / Matbia", "Pledger / Nadvan"): use plain wording.
  - Add a paid-to-date total per payee.
  - Payee name cleanup: sample data, flag only.

### #66 Search and Platform
- **Fix:** show a searching state in header search and the campaign ID box, and add a confirmation to Suspend in Platform > Organizations.
