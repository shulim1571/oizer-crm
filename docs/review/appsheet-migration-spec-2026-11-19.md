# AppSheet → Donor Base migration spec (AppSheet gap review #2)

Written 2026-11-19 for Shulim's OK. **Spec only.** Nothing was imported, deleted or changed; the live project still has only sample/test data. Figures below come from the 2026-11-11 test import (`AS-…` rows, counts only; no donor rows were read).

## Rules for the real run

- **Order:** accounts → sources → managers → donors → campaigns (parents before teams) → donations → pledges (+ payments) → vouchers → payouts → transfers → tasks.
- **Where:** on the production project (readiness #6), after the test-data wipe, with the Make feed in *live* mode only once the import is checked (see the feed cutover plan).
- **IDs:** AppSheet keys are kept as `AS-<key>` for donations, payouts, transfers and pledges; campaign numbers and donor IDs keep their AppSheet value. Re-running is safe: an existing `AS-` row is updated, never doubled.
- **No double counting with the live feed:** a donation whose Donary payment number or gateway reference is already here (sent live by Make or Donary) is skipped and listed.
- **Fees:** each gift keeps the fee AppSheet recorded (Moshe, Nov 18: a fee stays as the gift came in). A Manual Fee becomes `manual_fee`.
- **Method names:** imported as written; odd names show on the Task Sheet and are mapped with Method aliases (fees kept).
- **Proof it's right (required):** for every campaign, Raised, Fees, Payouts, Transfers in/out and Balance must equal AppSheet's to the cent. The import writes a report; any campaign that differs blocks sign-off. The nightly Books check must then come back clean or with each item explained.

## Table by table

| AppSheet | Rows | Donor Base | Notes |
|---|---:|---|---|
| Account | 8 | `accounts` | "Filter Checks" dropped (Moshe). |
| Source | 43 | `sources` | Donary machines (`DP_…`) become machine sources. |
| Manager | 120 | `managers` | Sub Manager → `sub_manager_ids`. |
| Collector | 25 | `collectors` | Kept for history; not shown on screens (Moshe). Donary's collector name is still stored on each incoming gift (`collector_label`): the Make feed always did, and the direct Donary webhook does too since Nov 19. |
| Donor | 3,727 | `donors` | Yiddish/English names; OJC/Nadvan/Matbia/Pledger IDs. Phone: one field holding two numbers is split first to Home, second to Cell; one number to Cell (Moshe). |
| Campaign | ~392 | `campaigns` | Names: see below. Archive (datetime) → archived; Exchange flag; PIN is set only through the PIN screen (stored scrambled). |
| Donation, Type = Payment | 71,802 | `donations` | Command/Result/Gateway ID/Donary ID kept; Delivered=false on a check → "Not delivered". |
| Donation, Type = Batch | 815 | `donations` (is_batch) **plus** `vouchers` | See below. |
| Donation, Type = Collect | 41 (39 in the test import) | `donations` | See below; needs Moshe. |
| Donation, Type = Voided | 22–24 | `donations`, status voided | Kept for history; not in raised. |
| Pledge / Pledge Split | 33 / 0 | `pledges`, `pledge_payments` | |
| Campaign Split | 0 | (`split_donation`) | Nothing to move. |
| Expense | ~1,933 | `expenses` (payouts) | Check Number and Cleared kept. A check payout already issued gets a `checks` row marked printed (so it can't be printed twice) with its number; Longamount isn't needed (worked out when printing). |
| Transfer | 227 | `transfers` | |
| Task | 14 | `tasks` | |
| Sola | 6,223 | `donations` processor details only | See below. |
| Donary | 23,189 | `donations` processor details only | See below. |
| Sheet13 (fee rules) | — | `payment_methods`, `processor_fee_rules` | Already set up; check each rate against Sheet13 before the run. |

### Campaign names (needs Shulim/Moshe to confirm)

AppSheet has Campaign Name, Friendly Name and Real Name. Proposed: **Real Name → internal name** (what the office calls it), **Friendly Name → external name** (what donors see on payment pages and receipts), **Campaign Name** kept as `campaign_name` (it's what Donary and Make send). In the test import 46 of 343 campaigns have different internal and external names; the import lists those 46 for a quick look before the real run.

### Batch rows → vouchers (needs a sample check, roadmap decision 6)

815 Batch rows in the test import: 393 OJC Fund, 263 Pledger, 138 Donors Fund, 6 Matbia, 4 imasser, 3 with no method. 760 are Complete, 53 Open, 2 blank; 558 are funded below their face amount, $4,424 still pending in all. (The review counted 509 Open from the raw export; the import's count is 53, so the run will report both and explain the difference before anything is moved.)

Proposed: each Batch row stays a donation (it's what campaign raised counts today, matching AppSheet) **and** gets a linked `vouchers` record (issuer from the method, face value = amount, funded so far, pending = what's still to come). Open batches go on the Task Sheet as "awaiting funds" like any voucher. First step: 20 Batch rows chosen across issuers and statuses are shown to Moshe side by side with their AppSheet rows; nothing is moved until he says they look right.

### Collect (needs Moshe)

39 gifts in the test import are "Collect": 14 OJC voucher, 11 Check, 11 Pledge, 3 Cash. Moshe's rule (readiness #10) is that "To collect" means a check not yet delivered, and #10 was held. Proposed: the 11 checks become checks marked **Not delivered** (out of raised until delivered, as today); the other 28 are listed for Moshe to say what each should be (a pledge, a voucher awaiting funds, or a gift).

### Processor history (Sola 6,223 / Donary 23,189)

These sheets were skipped in the test import because they hold card tokens and card data. Proposed: keep, per gift, only what refunds, disputes, receipts and reconciliation need: processor, reference numbers, card brand and last 4, device/machine, location, collector name, processed time. **Never** tokens, full card numbers, expiry or raw payloads. They're matched to gifts by gateway reference / Donary payment number; any that don't match are reported, not imported.

### Orphans

The test import found 3 donations and 26 payouts with no campaign (the review saw 29 and 26 in the raw export). The run puts them under a holding campaign "Unassigned (from AppSheet)" so totals still match, and lists each for the office to move.

## What's needed to run it

1. Shulim/Moshe confirm the campaign-name mapping and the Collect proposal; Moshe checks the 20-row batch sample.
2. The production project exists (readiness #6) and the test data is wiped.
3. A fresh AppSheet export on the day, with AppSheet's feed still running so nothing is missed (the overlap in the cutover plan).
4. Then: the importer runs in a dry-run first (report only), then for real; the balance report must match before sign-off.
