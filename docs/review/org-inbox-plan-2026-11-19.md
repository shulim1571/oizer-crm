# Per-organization email inbox: plan

Written 2026-11-19 for Shulim. **Plan only.** Nothing was built, and no Cloudflare, DNS or Supabase setting was changed. Cloudflare facts come from developers.cloudflare.com, read 2026-11-19.

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

## Data (all per organization, with row-level security like every other table)

- **`org_inboxes`:** org, random local part (20+ characters from a strong random source), status (active / off / replaced), created by, created and replaced times.
  - One active address per organization.
  - **Replace** makes a new address. The old one keeps accepting for 14 days, marked "old address", then is refused.
  - **Turn off** refuses at once.
- **`inbox_trusted_senders`:** org, an exact address or a whole domain, a label ("OJC batch reports"), the report type it sends, who added it.
- **`inbound_emails`** / **`inbound_attachments`:** as above. Status: new, matched, to review, not trusted, ignored.
- **To review:** a new Task Sheet type, `inbox_review`, linked to the email, holding the fields it read (amount, date, sender name, reference, memo, the campaign if one is named) and how sure it is of each.
- **Who can see it:** admins with a new permission, *Manage inbox*, delegated like the others. Fundraisers never see the inbox.

## Matching (suggestions only)

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

## Settings screen

- The address, with **Copy**. Forwarding instructions for Gmail and Outlook, and a "send to this address" line for issuers.
- **Gmail's forwarding confirmation:** Gmail sends a confirmation code to a new forwarding address. The inbox shows that email (from `forwarding-noreply@google.com`) even though the sender isn't trusted, so the admin can copy the code.
- **Replace address** and **Turn off**, each asking first.
- Trusted senders: add, edit, remove.
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
| Cloudflare Email Routing | Free on all plans |
| Inbox domain (option A) | ≈ $10–15 a year |
| Inbox Worker | Free plan: 100,000 requests a day, 10 ms CPU each. If messages ever exceed the CPU limit, Workers Paid is $5 a month (10 M requests, 30 M CPU-ms included). |
| Storage | Supabase Storage on the existing project: 1 GB on Free, 100 GB included on Pro. R2 isn't needed; if wanted later, 10 GB free, then $0.015 per GB-month. |
| Edge Function | Within the existing Supabase plan |

**Expected total: about $10–15 a year,** plus $5 a month only if the Worker needs the Paid plan.

## Build order, once approved

1. Tables, permission and storage bucket. Settings screen to create, replace and turn off addresses and manage trusted senders. Tests for tenant isolation.
2. `email-inbound` Edge Function: signature check, storing, duplicate check, the inbox list. Tested with sample `.eml` files.
3. Inbox Worker and Email Routing on the inbox domain (Shulim's account; see below). End to end with a sample message.
4. Batch-report readers (one per issuer), then the match-and-confirm screen.
5. Zelle and wire readers, then the To review items.
6. Gmail forwarding confirmation, the daily cap, Task Sheet notices.

## Needed from Shulim

1. **The inbox domain:** option A (and the name to register), or a different choice.
2. **A Cloudflare API token** scoped to that domain: Email Routing edit, DNS edit, Workers Scripts edit. Today's token only covers Pages. Shulim saves it in the private folder; it's never pasted in chat.
3. **Sample emails**, sanitized or sample data, for each format to read:
   - an OJC, Pledger and Donors Fund batch report;
   - a Zelle received notice from each bank Oizer uses;
   - a wire received notice.
4. **Who may manage the inbox:** Super Admin only, or admins with the new *Manage inbox* permission (suggested).
5. **How long to keep emails and attachments** (suggested: 7 years, matching financial records), and whether an admin may delete one. Deleting data is Shulim's decision, so the default is no delete.
6. **Approval of the costs** above.
