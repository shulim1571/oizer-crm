# Per-organization email inbox: plan

Written 2026-11-19 for Shulim, updated the same day with Moshe's donations-mailbox survey (`review/donations-mailbox-reconciliation-2026-11-18.md`), Shulim's decisions on it, and the choice of SendGrid Inbound Parse. **Plan only.** Nothing was built, and no DNS, SendGrid, Cloudflare or Supabase setting was changed. SendGrid and Cloudflare facts come from their docs, and Shulim's read-only look at the SendGrid console, 2026-11-19.

## What it does

- In Settings, an organization admin clicks **Create inbox address**. Donor Base gives them a random address that belongs to that organization only (for example `k7f3q9xw2m@<inbox domain>`). Copy and forwarding instructions are shown alongside it.
- Mail sent or forwarded to that address is stored under that organization, with its attachments.
- From **trusted senders**:
  - batch reports (OJC, Pledger, Donors Fund...) are matched to the batches already in Donor Base;
  - Zelle and wire notices become **To review** items with the fields filled in.
- **Nothing posts by itself.** A person confirms every match or new gift.

## The inbox host: SendGrid Inbound Parse (chosen)

**Decision (Shulim, 2026-11-19):** SendGrid Inbound Parse on a subdomain of `mail.trubase.org`, instead of buying a domain. It's free:
- **Plan:** Donor Base's SendGrid plan, Email API Essentials 50K (already paid for), includes Inbound Parse with no upgrade. No parse hosts are set up yet.
- **Authenticated domain:** the only one in SendGrid is `mail.trubase.org` (return path `em9078.mail.trubase.org` verified, link branding `url3910.mail.trubase.org`). So the Add Host dropdown offers only `mail.trubase.org`, with an optional subdomain.

Checked read-only in the SendGrid console (by Shulim) and in public DNS (2026-11-19).

**Suggested host: `inbox.mail.trubase.org`** (receiving domain `mail.trubase.org`, subdomain `inbox`).
- **Free to use:** the name doesn't exist in DNS today.
- **No loop:** `mail.trubase.org` itself has no MX record; it's used only for sending. Receiving on a different host than the sending domain avoids the loop SendGrid warns about, so Automatic Security on the sending domain can stay as it is.
- **Google Workspace mail is untouched:** it lives on trubase.org's own MX records, and only a new record for `inbox.mail` is added.
- **Addresses** look like `k7f3q9xw2m4t8p1z6c0d@inbox.mail.trubase.org`.

**The domain is a setting, never code.** `INBOX_DOMAIN` (e.g. `inbox.mail.trubase.org`) is an Edge Function secret, and the app reads it from the platform's settings. Moving to another host later means changing the setting and the MX record, nothing else.

### To add later (once the build is approved). Not done now.

**1. DNS (Google Cloud DNS, zone trubase.org).** One record:

| Name | Type | TTL | Data |
|---|---|---|---|
| `inbox.mail.trubase.org.` | MX | 3600 | `10 mx.sendgrid.net.` |

In the Google Cloud console, the record set's DNS name is `inbox.mail` in the trubase.org zone. Nothing else in the zone changes. SendGrid's docs say not to change this record afterwards; changing it stops the host receiving mail.

**2. SendGrid → Settings → Inbound Parse → Add Host & URL:**

| Setting | Value |
|---|---|
| Receiving domain | `mail.trubase.org`, subdomain `inbox` |
| Destination URL | `https://wwaknikpdquwnphhwzsm.supabase.co/functions/v1/email-inbound/<INBOUND_PARSE_TOKEN>` (the token is made at build time and given to Shulim privately, never in chat or the repo) |
| Check incoming emails for spam | **On** (adds `spam_score` / `spam_report` for messages up to 2.5 MB; shown in the inbox, never decides anything alone) |
| POST the raw, full MIME message | **On** (Donor Base keeps the original `.eml` and reads the attachments itself, so nothing is lost or re-encoded) |

**3. Supabase:** deploy `email-inbound` with JWT verification **off** (SendGrid can't send a Supabase login). Set its secrets:
- `INBOUND_PARSE_TOKEN`
- `INBOX_DOMAIN`
- `INBOUND_PARSE_TOKEN_NEXT`, empty except while the token is being changed.

### Other options considered

| Option | Why not |
|---|---|
| Buy a small domain on Cloudflare, with Email Routing and a Worker (≈ $10–15 a year) | Not needed now that Inbound Parse is free on the current plan. It stays the fallback if SendGrid is ever dropped. |
| `in.trubase.org` on Cloudflare | A catch-all works only on a domain's apex. trubase.org's DNS is on Google, and putting only a subdomain on Cloudflare is Enterprise-only. |
| `in.trubase.org` with SendGrid | Only `mail.trubase.org` is authenticated in SendGrid, so a host must sit under it. Authenticating trubase.org too would add records for no gain. |
| One Gmail account with "+token" addresses | Every organization's mail in one consumer mailbox; weaker separation. |
| A free domain (eu.org) / AWS SES | Weak reputation / a second cloud account to run. |

## How mail flows

1. **The sender** (OJC, Pledger, Chase…), or a Gmail auto-forward, delivers to `<random>@inbox.mail.trubase.org`. DNS sends it to SendGrid's MX.
2. **SendGrid Inbound Parse** POSTs the message (raw MIME, plus its fields) to `email-inbound` at the secret URL. Limits: 30 MB per message with attachments. A `5xx` answer is retried for up to 3 days; a `2xx` ends it. SendGrid doesn't follow redirects. It accepts any local part except `abuse`, `postmaster` and `unsubscribe`.
3. **The Edge Function `email-inbound`:**
   1. **Secret check.** The last part of the URL must equal `INBOUND_PARSE_TOKEN` (or `INBOUND_PARSE_TOKEN_NEXT` while rotating), compared in constant time. Anything else gets `404` with no body, and nothing is stored or logged beyond the attempt.
   2. **Address → organization.** It reads the recipients from SendGrid's `envelope` field (`to`), keeps only addresses at `INBOX_DOMAIN`, and looks each local part up in `org_inboxes`. The address is the only key; nothing else picks the organization. Unknown or turned-off addresses: answered `200` (so SendGrid doesn't retry) and dropped, with a count kept for the platform.
   3. Saves the raw `.eml` (SendGrid's `email` field) and each attachment, parsed from the MIME, in a private Supabase Storage bucket under `inbox/<org_id>/<email_id>/…`.
   4. Writes an `inbound_emails` row and one `inbound_attachments` row per file:
      - the row holds sender, subject, time, Message-ID, size, spam score, and the SPF/DKIM results below;
      - each attachment row holds name, type, size and SHA-256.
   5. **Authenticity** (below) decides whether it may be read as a trusted report.
   6. Only for a **trusted sender whose mail authenticated**: runs the reader for that sender's report type.
   7. A second copy (same Message-ID, or the same issuer deposit id) is kept and marked **possible duplicate**, never silently skipped.
   8. Answers `200` once stored. A storage or database failure answers `500`, so SendGrid retries.

### How authenticity is checked (SPF and DKIM)

SendGrid doesn't sign its webhook and doesn't report DMARC. So:
- **The secret URL** proves the POST came through Donor Base's Inbound Parse set-up.
- **The message's own authentication** proves who sent it:
  - **DKIM.** SendGrid's `dkim` field lists each signature's domain and result, e.g. `{@ojcfund.org : pass}`. Donor Base also re-verifies the DKIM signature from the raw message itself, so it doesn't rely on that field alone.
  - **SPF.** The `SPF` field (`pass`, `fail`, `softfail`, `none`…) for the envelope sender, from `envelope.from`.
- **The rule (DMARC-style alignment), worked out by Donor Base.** A message counts as **authentic** when DKIM passes for a domain that matches or is a parent of the **From:** header's domain, or SPF passes for an envelope-from domain that matches the From: domain.
- **Trusted senders** need **authentic + on the organization's trusted list**. Anything else is stored as *not trusted*: shown, never read automatically.
- **Forwarded mail:** most of Oizer's mail arrives by Gmail auto-forward (`congoizer@gmail.com` → the inbox). Forwarding changes the envelope sender, so SPF then reflects Google, not OJC. The original **DKIM signature usually survives** an unchanged forward, so OJC's `ojcfund.org` signature still passes and aligns with From. That's why DKIM is the main check. If a forwarder breaks DKIM, the message lands under *not trusted* with the reason shown, and an admin can look and allow it once.

### Changing the token

1. Make a new token and set it as `INBOUND_PARSE_TOKEN_NEXT`; both work.
2. Change the Destination URL in SendGrid.
3. After a day, move the new token to `INBOUND_PARSE_TOKEN` and clear `_NEXT`.

No mail is lost.

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

- **Spoofing:** readers run only for trusted senders whose mail is **authentic** (DKIM or SPF aligned with From:, as above). Anything else is stored as "not trusted", with the reason shown.
- **The webhook:** only POSTs to the secret URL are accepted. A wrong or missing token gets `404` and nothing is stored.
- **Tenant isolation:** the address decides the organization, row-level security on every table, and storage paths scoped by org. Addresses are long and random, so they can't be guessed. Replacing one retires the old.
- **Attachments:** PDF, CSV, XLSX and images are read for matching. Anything else is kept but not opened. There's no virus scanning; files are only downloaded by an admin who chooses to.
- **Size and volume:**
  - 30 MB per message (SendGrid's limit); larger mail is refused by SendGrid.
  - A per-organization cap, e.g. 500 messages a day. Past it, messages are acknowledged but not stored, and the Task Sheet says so. Inbound Parse can't refuse mail after accepting it, so this is the closest equivalent.
- **Secrets:** `INBOUND_PARSE_TOKEN` (and `_NEXT` while rotating) live only in the Edge Function's secrets and in SendGrid's Destination URL. `INBOX_DOMAIN` is a setting. Nothing is hardcoded or committed, and the token never appears in logs (the function logs "token ok/bad", not the path).
- **Card data:** a bank notice that contains a full card number has it masked before anything is saved in the database. The raw `.eml` stays only in private storage.

## Costs

| Item | Cost |
|---|---|
| SendGrid Inbound Parse on `inbox.mail.trubase.org` | **$0**: included in the Email API Essentials 50K plan Shulim already pays for (confirmed in the console). SendGrid doesn't state a per-message charge for inbound mail. No domain, Worker or Cloudflare account needed |
| DNS | $0: one record in the existing Google Cloud DNS zone |
| Storage | Supabase Storage on the existing project: 1 GB on Free, 100 GB included on Pro. R2 isn't needed; if wanted later, 10 GB free, then $0.015 per GB-month. |
| Edge Function | Within the existing Supabase plan |

**Expected total: $0.** The domain purchase (≈ $10–15 a year) isn't needed. Storage for 7 years of mail stays well inside the current Supabase plan at this volume (about 15 messages a day, mostly under 100 KB).

## Build order, once approved

1. Tables (inbox, trusted senders, emails, attachments, `voucher_lines`, `deposits`/`deposit_lines`, `deposit_slips`, `fee_reviews`, `donations.card_last4`), the permission, the storage bucket, the retention setting. Settings screen. Tests for tenant isolation.
2. `email-inbound` Edge Function: authenticity check, storing, possible-duplicate flag, the inbox list. Tested with sample `.eml` files built from the survey's formats (no real data).
3. Turn on the host (Shulim, with the values in "To add later"): the MX record for `inbox.mail.trubase.org` in Google Cloud DNS, then the Inbound Parse host in SendGrid with the secret URL. End to end: send a sample message to a test organization's address, check it lands only there, then a wrong-token POST gets 404.
4. Card last 4 from Donary, Sola and Elevon on new gifts.
5. OJC and Pledger ACH readers, with the deposit match-and-confirm screen, create-missing-donation and fee review.
6. Certificate submission readers, with certificate lines on voucher batches.
7. Deposit slips and the Chase check-deposit reader.
8. Fee-by-method change (once Shulim and Moshe confirm it replaces readiness #14).
9. Zelle, wire and Sola readers once samples arrive; AB Charity once Moshe decides.

## Needed from Shulim

1. ~~Inbox host~~: decided, SendGrid Inbound Parse. Please confirm the host name `inbox.mail.trubase.org`, or pick another subdomain under `mail.trubase.org`.
2. **When the build reaches step 3:**
   - Add the MX record (table above) in Google Cloud DNS.
   - Add the Inbound Parse host in SendGrid, with the Destination URL I'll hand over privately (the token goes into the private folder, never chat).
   - No Cloudflare token is needed.
3. **Sample emails** still missing (the survey covers OJC, Pledger and Chase), sanitized or sample data: Donors Fund and Matbia deposit reports, a Sola settlement report, a Zelle notice from each bank Oizer uses, a wire notice. Plus: is the second forward, `donations.oizer@gmail.com`, confirmed, and what does it receive?
4. **Who may manage the inbox:** Super Admin only, or admins with the new *Manage inbox* permission (suggested).
5. ~~How long to keep emails~~: decided, a per-organization setting, default 7 years. Still open: may an admin delete a single email before then? The default is no.
6. **Confirm that fees-by-method replaces readiness #14's processor rates** (with Moshe), and whether any method genuinely needs two prices.
7. **AB Charity** (Moshe): a payment method or a source, and is there a payout export?
8. ~~Costs~~: $0, nothing to buy.
