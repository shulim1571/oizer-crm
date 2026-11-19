# Per-organization email inbox: plan

Written 2026-11-19 for Shulim, updated the same day with Moshe's donations-mailbox survey (`review/donations-mailbox-reconciliation-2026-11-18.md`) and Shulim's decisions on it. **Plan only.** Nothing was built, and no Cloudflare, DNS, SendGrid or Supabase setting was changed. Cloudflare and SendGrid facts come from their docs, read 2026-11-19.

## What it does

- In Settings, an organization admin clicks **Create inbox address**. Donor Base gives them a random address that belongs to that organization only (for example `k7f3q9xw2m@<inbox domain>`). Copy and forwarding instructions are shown alongside it.
- Mail sent or forwarded to that address is stored under that organization, with its attachments.
- From **trusted senders**:
  - batch reports (OJC, Pledger, Donors Fund...) are matched to the batches already in Donor Base;
  - Zelle and wire notices become **To review** items with the fields filled in.
- **Nothing posts by itself.** A person confirms every match or new gift.

## One change from the brief: the inbox domain

**`in.trubase.org` can't be used for a catch-all.**
- Cloudflare: "Catch-all rules are only available for the apex domain."
- trubase.org's DNS is on Google Cloud DNS, and its mail is Google Workspace (checked 2026-11-19).
- Giving just `in.trubase.org` to Cloudflare ("subdomain setup") is Enterprise-only.

The options:

| Option | How it works | Cost | Notes |
|---|---|---|---|
| **A. A small domain just for inboxes (recommended)** | Register a domain on Cloudflare, e.g. `donorbase-mail.com` (Shulim picks the name). Catch-all on its apex goes to the Worker. | ≈ $10–15 a year (Cloudflare Registrar charges cost price; I didn't check today's price for any particular name) | Nothing touches trubase.org or its Google mail. Unlimited addresses, all from one rule. |
| B. Move trubase.org's DNS to Cloudflare | `in.trubase.org` on Cloudflare, one literal rule per address, made through the API | Free | Moves the DNS for every trubase.org service, including Google Workspace mail records. Limited to 200 rules, so about 200 organizations. Riskier, and outside Oizer. Not recommended. |
| C. A trubase.org subdomain delegated to Cloudflare | — | Enterprise plan | Not practical. |

The domain is never written into code. It's a setting (`INBOX_DOMAIN`) read by the Worker, the Edge Function and the app.

### Free options, checked before buying a domain

Shulim asked whether anything free works without touching trubase.org's Google Workspace mail. Checked 2026-11-19:

| Free option | Works? | What it needs | Catch |
|---|---|---|---|
| **S. SendGrid Inbound Parse on `in.trubase.org`** | **Yes, probably free. Best free option.** | One MX record for `in.trubase.org` → `mx.sendgrid.net`, added in Google Cloud DNS. trubase.org's own MX records, which carry Google Workspace mail, aren't touched; the subdomain has its own. Inbound Parse then POSTs every message for any address at that host straight to a Donor Base Edge Function (no Worker needed), up to 30 MB with attachments, and retries for 3 days if Donor Base is down. | SendGrid only allows Inbound Parse on a domain already verified in SendGrid. Is trubase.org verified for sending? If not, verifying adds a few CNAME records (SendGrid's own DKIM names, not Google's), still without touching Google mail. Its pricing page doesn't clearly show which plans include Inbound Parse; Shulim checks the SendGrid console (Settings → Inbound Parse). The webhook isn't signed, so the address it posts to carries a long secret, and each message's SPF/DKIM results are checked. |
| G. One Gmail account with "+token" addresses (`donorbase.inbox+k7f3…@gmail.com`) | Works, free | A new Gmail account, Gmail API access, a poller or Google Pub/Sub push | Every organization's mail would sit in one consumer mailbox, which is weaker separation for financial mail. Google can lock an automated account. Some forwarding set-ups reject "+" addresses. Not recommended. |
| Cloudflare Email Routing on a domain Oizer already owns | No | trubase.org and congoizer.org are both on Google DNS with Google mail; a catch-all would mean moving their DNS and mail | Touches Google mail; and congoizer.org belongs to one organization. |
| A free domain (e.g. eu.org) on Cloudflare | Works, free | Weeks for approval | Weak reputation for financial mail; can be withdrawn. Not recommended. |
| AWS SES receiving on `in.trubase.org` | Works, not quite free | MX on the subdomain, an AWS account, S3 | About $0.10 per 1,000 messages plus S3, so pennies a month. A second cloud account to look after. |

**Recommendation:** if the SendGrid console shows Inbound Parse on Donor Base's current SendGrid plan, use **option S**. It's free, uses the `in.trubase.org` name Shulim wanted, needs no Worker and no new account, and leaves Google Workspace mail alone. Otherwise, buy the small domain (option A, about $10–15 a year). The rest of this plan works the same with either: only the first hop changes.

## How mail flows

1. **Cloudflare Email Routing** (free) has one catch-all rule on the inbox domain that sends every message to the **inbox Worker**.
2. **The Worker** does as little as possible:
   - It reads the recipient address and Cloudflare's `Authentication-Results` header (SPF, DKIM, DMARC).
   - It streams the raw message, up to Cloudflare's 25 MiB limit, to a Donor Base Edge Function, `email-inbound`, signed with a shared secret (HMAC).
   - It doesn't parse the message, which keeps it inside the Workers Free plan's 10 ms CPU limit.
   - It rejects the message (`setReject`) when the Edge Function answers that the address is unknown or turned off.
3. **The Edge Function `email-inbound`:**
   1. Checks the signature, then finds the organization from the address (`org_inboxes`). The address is the only key; nothing else picks the organization.
   2. Saves the raw `.eml` and each attachment in a private Supabase Storage bucket under `inbox/<org_id>/<email_id>/…`.
   3. Writes an `inbound_emails` row (sender, subject, time, Message-ID, authentication results, size) and one `inbound_attachments` row per file (name, type, size, SHA-256).
   4. Only when the sender is on the organization's trusted list **and** DMARC passed: runs the matching step for that sender's report type.
   5. Ignores a message it has already seen (same Message-ID for that organization).

(With option S, steps 1–2 are replaced by SendGrid Inbound Parse posting each message, raw, to `email-inbound` at a secret address; the function checks SendGrid's SPF/DKIM results instead of Cloudflare's header. Everything from step 3 on is the same.)

## Data (all per organization, with row-level security like every other table)

- **`org_inboxes`:** org, random local part (20+ characters from a strong random source), status (active / off / replaced), created by, created and replaced times.
  - One active address per organization.
  - **Replace** makes a new address. The old one keeps accepting for 14 days, marked "old address", then is refused.
  - **Turn off** refuses at once.
- **`inbox_trusted_senders`:** org, an exact address or a whole domain, a label ("OJC batch reports"), the report type it sends, who added it.
- **`inbound_emails`** / **`inbound_attachments`:** as above. Status: new, matched, to review, possible duplicate, not trusted, ignored.
- **Retention (Shulim, decided):** a per-organization setting, *Keep raw emails for*, default **7 years**. After that the raw `.eml` and attachments are removed from storage. What was read from them (deposits, lines, matches) stays with the books.
- **To review:** a new Task Sheet type, `inbox_review`, linked to the email, holding the fields it read (amount, date, sender name, reference, memo, the campaign if one is named) and how sure it is of each.
- **Who can see it:** admins with a new permission, *Manage inbox*, delegated like the others. Fundraisers never see the inbox.

## Matching (suggestions only): general rules

The reconciliation part below gives the readers for each format, from Moshe's mailbox.

- **Batch reports:**
  - One reader per issuer format reads the batch number, date, total and each line (voucher or grant number, amount).
  - It finds the Donor Base batch by issuer plus batch number, or by total and date if there's no number.
  - It shows the match side by side: lines found, lines missing, amounts that differ.
  - An admin presses **Confirm**, which marks the batch's lines funded, as the voucher screens do today.
- **Zelle and wire notices:**
  - A reader per bank format pre-fills amount, date, sender, reference and memo.
  - It suggests a donor (by name, email or phone) and a campaign (if the memo has a campaign number).
  - An admin opens the To review item, corrects anything, and presses **Create donation**, or marks it a duplicate if the bank feed already has it.
- **Anything else** (an unknown format or a trusted sender's other mail) is kept as **New** in the inbox list, with no suggestion.
- **Untrusted senders:** kept under **Not trusted**. They're never parsed and their attachments aren't opened in the app. An admin can trust the sender, which runs matching on that message.

## Reconciliation from the donations mailbox

From the survey of donations@congoizer.org (2.5 days old, 39 messages): OJC and Pledger ACH deposits, their certificate submissions, a USAePay nightly batch, an AB Charity payout and Chase mobile check deposits. Sola, Donary, Matbia, Donors Fund, Zelle and wires haven't appeared yet.

### Shulim's decisions (2026-11-19)

1. **Certificate lines:** store each certificate as a line under its voucher batch.
2. **Card last 4:** store the last 4 digits of the card on gifts, from the feeds and reports. Never more than the last 4.
3. **Fees follow the payment method, not the source.** Elevon and Sola are *sources*. An OJC card gift that came through Elevon gets the **OJC card** fee, not a card-processor rate.
4. **A different real fee goes to review.** When a deposit report shows a fee different from the one recorded, it goes on a review list to confirm before it's applied. Nothing changes a fee on its own (in line with Moshe's rule that a fee stays as the gift came in).
5. **Review may create a missing donation,** with the donor named in the report.
6. **USAePay detail: skipped.** Card processing is moving to Sola. The USAePay nightly email isn't read; a Sola settlement reader replaces it once Sola samples arrive (readiness #27).
7. **AB Charity:** waiting on Moshe. Its payout emails are stored, with no reader.
8. **Deposit slips** group checks, so a bank's check-deposit notice matches one slip.
9. **Possible duplicates are flagged, not skipped.** A second copy of a report (two Gmail accounts forward to this mailbox) or a deposit seen twice shows as "possible duplicate of …", with **Not a duplicate** / **Dismiss**.
10. **Raw email retention:** the per-organization setting above, default 7 years.

### New data (per organization, row-level security)

- **`voucher_lines`** (decision 1): voucher batch, certificate or voucher #, amount, donor's DAF account #, redeemed on, status (*submitted*, *in review*, *pending*, *rejected*, *funded*), the reported fee, and the deposit that paid it.
- **`donations.card_last4`** (decision 2): filled from Donary (`last4Digits`), Sola (masked card) and Elevon (`card_number`), keeping only the last 4. It's already hidden from fundraisers in History, as card details are.
- **`deposits`** (an "expected deposit"): issuer (OJC, Pledger, Chase check deposit, AB Charity…), the issuer's deposit or ACH id, date, gross, fees, net, the email it came from, and status (*new*, *matched*, *confirmed*, *possible duplicate*). **`deposit_lines`**: one per line of the report, with what it's matched to (a gift or a certificate line).
- **`deposit_slips`** (decision 8): date, bank account, the checks on it (gifts) and their total. Made on the Transactions page by ticking checks and choosing **Make deposit slip**, with a printable slip.
- **`fee_reviews`** (decision 4): gift, recorded fee, reported fee, deposit line. Shown as a Task Sheet type.

### Readers, in build order

1. **OJC "ACH Deposit" and Pledger "ACH Notification"** (the most messages, the most value):
   - Each email becomes a `deposit` with its lines.
   - **Certificate lines** match `voucher_lines` exactly by certificate # and amount. For OJC, the ACH id equals the submission's Batch No; a reviewed submission is funded under a new ACH id, so it matches by certificate #.
   - **Card and web lines** (OJC "Trans #" with masked card; Pledger "Card (***1234)" with Trans Type Donary, Cartis or AB Charity) match a gift by date ±1 day, amount, source and card last 4. More than one candidate goes to review.
   - **A line with no gift** goes to review with **Create donation** pre-filled (decision 5). The issuer gives the method (e.g. OJC card), plus amount and date. The donor is found by their DAF account # (`donors.ojc_id` / `pledger_id`) or by name; if neither matches, a new donor is made from the report's name.
   - **The deposit total (net)** matches one bank line one-to-one (deposit within 1–3 business days, set per issuer).
   - **Confirm** marks the lines funded and links the bank line.
   - **A reported fee different from the recorded one** goes to `fee_reviews`, not straight into the gift (decision 4). OJC's Plan B charge varies by donor, so this will come up.
2. **Certificate submissions** (OJC "Certificates submission received", OJC "grant split", Pledger "Batch Submission Confirmation"):
   - Each sets the voucher batch's certificate lines to *submitted*, *in review* or *pending*, and records the batch # it will be paid under.
   - A submission with no voucher batch in Donor Base, or with a different count or total, goes to review.
   - A split shows "partly funded, $X still pending".
3. **Chase check deposits** ("We received…" and "We accepted…" are paired into one item):
   - The amount and date match a **deposit slip** with the same total and date (decision 8); then the slip matches the bank line.
   - No slip with that total → review: "Pick the checks this deposit covers", which makes the slip.
4. **Zelle, wire and OJC wire notices:** as in the general rules, once real samples arrive.
5. **Sola settlement** (instead of USAePay, decision 6): once Sola samples arrive; see readiness #27.
6. **AB Charity:** stored only, until Moshe decides (decision 7).

### Fees follow the payment method (decision 3): what changes

- Today, a gift's fee can come from a *processor rate*, chosen by its source: Elevon/Cartis → the Elevon rate, Donary → the Donary rate (readiness #14). Under Shulim's decision the **payment method** decides. An "OJC" card gift pays the OJC card fee whether it came through Elevon, Donary or Sola, and a regular credit card pays the credit card fee.
- **This reverses readiness #14** (processor rates per method). The plan: stop picking the fee by source, and keep the processor-rates tab only for a method that genuinely has two prices (if any), or remove it. Shulim and Moshe confirm before the build.
- **Getting the method right becomes the key step.** Donary and Elevon send the card brand. A card that is really an OJC, Pledger, Donors Fund or Matbia card arrives as a "card" with that issuer's name or BIN. The readers above (Pledger "Card (***1234)" lines, OJC card lines) let review correct a gift's method to the DAF card, and a method change brings the right fee (the existing rule since Nov 18).
- **Existing gifts keep their fees** (Moshe's rule). Only new gifts, and gifts whose method is corrected, use the new rule.

## Settings screen

- The address, with **Copy**. Forwarding instructions for Gmail and Outlook, and a "send to this address" line for issuers.
- **Gmail's forwarding confirmation:** Gmail sends a confirmation code to a new forwarding address. The inbox shows that email (from `forwarding-noreply@google.com`) even though the sender isn't trusted, so the admin can copy the code.
- **Replace address** and **Turn off**, each asking first.
- Trusted senders: add, edit, remove. Each sender has a report type (OJC ACH, OJC submission, Pledger ACH, Pledger batch, Chase deposit, AB Charity, Zelle, wire, other).
- Per organization: which readers are on; deposit lag days per issuer; the date window for card lines; the bank account each issuer pays into; the organization's own issuer account numbers (OJC/Pledger org ids); *Keep raw emails for* (default 7 years). Nothing is hardcoded.
- The last 50 emails: status, sender, subject, attachments, with a link to the matching To review or batch item.

## Safety

- **Spoofing:** matching runs only for trusted senders whose mail **passed DMARC**. A message that fails DMARC is stored as "not trusted" and flagged.
- **Tenant isolation:** the address decides the organization, row-level security on every table, and storage paths scoped by org. Addresses are long and random, so they can't be guessed. Replacing one retires the old.
- **Attachments:** PDF, CSV, XLSX and images are read for matching. Anything else is kept but not opened. There's no virus scanning; files are only downloaded by an admin who chooses to.
- **Size and volume:**
  - 25 MiB per message (Cloudflare's limit).
  - A per-organization cap, e.g. 500 messages a day. Past it, mail is refused and the Task Sheet says so.
- **Secrets:** the HMAC secret is in the Worker's secrets and the Edge Function's secrets. The inbox domain is a setting. Nothing is hardcoded or committed.
- **Card data:** a bank notice that contains a full card number has it masked before anything is saved in the database. The raw `.eml` stays only in private storage.

## Costs

| Item | Cost |
|---|---|
| First hop, option S (SendGrid Inbound Parse on `in.trubase.org`) | **$0** if the current SendGrid plan includes Inbound Parse (to confirm in the console); no Worker or domain needed |
| First hop, option A instead | Domain ≈ $10–15 a year; Cloudflare Email Routing free; Worker on the free plan ($5 a month only if it ever needs the Paid plan) |
| Storage | Supabase Storage on the existing project: 1 GB on Free, 100 GB included on Pro. R2 isn't needed; if wanted later, 10 GB free, then $0.015 per GB-month. |
| Edge Function | Within the existing Supabase plan |

**Expected total: $0 with option S** (if SendGrid's plan includes it), **otherwise about $10–15 a year.** Storage for 7 years of mail stays well inside the current Supabase plan at this volume (about 15 messages a day, mostly under 100 KB).

## Build order, once approved

1. Tables (inbox, trusted senders, emails, attachments, `voucher_lines`, `deposits`/`deposit_lines`, `deposit_slips`, `fee_reviews`, `donations.card_last4`), the permission, the storage bucket, the retention setting. Settings screen. Tests for tenant isolation.
2. `email-inbound` Edge Function: authenticity check, storing, possible-duplicate flag, the inbox list. Tested with sample `.eml` files built from the survey's formats (no real data).
3. The first hop: option S (MX for `in.trubase.org` and Inbound Parse, both in Shulim's accounts) or option A (domain, Email Routing, Worker). End to end with a sample message.
4. Card last 4 from Donary, Sola and Elevon on new gifts.
5. OJC and Pledger ACH readers, with the deposit match-and-confirm screen, create-missing-donation and fee review.
6. Certificate submission readers, with certificate lines on voucher batches.
7. Deposit slips and the Chase check-deposit reader.
8. Fee-by-method change (once Shulim and Moshe confirm it replaces readiness #14).
9. Zelle, wire and Sola readers once samples arrive; AB Charity once Moshe decides.

## Needed from Shulim

1. **Check the SendGrid console** (Settings → Inbound Parse):
   - Is Inbound Parse available on Donor Base's plan?
   - Is trubase.org a verified ("authenticated") domain there?
   If both are yes, option S is free: Shulim adds one MX record for `in.trubase.org` in Google Cloud DNS, and sets up the Inbound Parse host, with the secret address I'll give, in SendGrid. If not, choose option A and its name.
2. **For option A only:** a Cloudflare API token scoped to that domain (Email Routing edit, DNS edit, Workers Scripts edit). Today's token only covers Pages. Shulim saves it in the private folder; it's never pasted in chat.
3. **Sample emails** still missing (the survey covers OJC, Pledger and Chase), sanitized or sample data: Donors Fund and Matbia deposit reports, a Sola settlement report, a Zelle notice from each bank Oizer uses, a wire notice. Plus: is the second forward, `donations.oizer@gmail.com`, confirmed, and what does it receive?
4. **Who may manage the inbox:** Super Admin only, or admins with the new *Manage inbox* permission (suggested).
5. ~~How long to keep emails~~: decided, a per-organization setting, default 7 years. Still open: may an admin delete a single email before then? The default is no.
6. **Confirm that fees-by-method replaces readiness #14's processor rates** (with Moshe), and whether any method genuinely needs two prices.
7. **AB Charity** (Moshe): a payment method or a source, and is there a payout export?
8. **Approval of the costs** above ($0 with option S).
