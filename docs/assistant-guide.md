# Oizer staff guide

Oizer is a campaign CRM for a charity organization: campaigns raise money through donations, and money goes out
as payouts. Each campaign has a balance: what it raised, less fees, payouts and transfers out, plus transfers in.

## Who can do what

- **Super Admin**: everything, including payment keys, phone lookup switches, reopening closed campaigns.
- **Admin**: runs the office. Records donations and payouts, approves requests, manages campaigns, fundraisers,
  bank accounts, reconciliation, outreach and settings.
- **Fundraiser** (shown as "manager" in some places): sees only the campaigns they are primary or secondary on.
  They can enter payments that wait for an admin's approval (if allowed), request payouts, request new campaigns,
  book machines, manage their donors and call lists, and see their campaigns' balances.
- People who sign in and aren't set up yet wait until an admin gives them a role under Settings > Users & Access.

## Campaigns

- **Campaigns** menu: tabs Active, All, Archived, Closed and Requests. Click a campaign name anywhere to open it.
- A campaign page shows Raised, Expenses, Balance and tabs for Donations, Payouts, Transfers, Pledges, Tasks,
  Settings and Sub-campaigns. **Open payment page** opens its public donation page; **Share** gives the link.
- **More** on a campaign: Edit campaign, Change template, Remove phone PIN, Batch entry, Report, Donor list,
  Import contacts, Publish, Archive, Reactivate, Reopen, Close campaign.
- **New campaign**: Campaigns > New campaign. Pick a template (or none), then fill in the details.
- **Templates** set a campaign's payment page settings (language, preset amounts, minimum, cover-fee default,
  receipts, donor wall, logo, color, custom fields) when it is made. **Change template** on an existing campaign
  copies the new template's page settings only; donations, payouts, names, fundraisers, goal, bank account, PIN
  and the page's own description, thank-you note and banner stay as they are.
- **Campaign Requests** (Campaigns > Requests): fundraisers request a new campaign; admins approve, ask for
  changes or reject. Pending requests also appear on the Task Sheet.
- **Close campaign** locks it: no new transactions. Only the Super Admin can reopen.
- **Sub-campaigns** either share the parent's balance or keep their own.
- **Phone PIN**: a 4-digit PIN set in Edit campaign. It lets a fundraiser on an unregistered phone hear the
  campaign by text or phone. It is stored scrambled and never shown; type a new one to change it.

## Donations (Transactions)

- **New Donation** (the New Donation button in the top bar on every page, or New Donation on a campaign's
  Donations tab): campaign, amount, payment method, donor, notes and status (at the bottom); Advanced has Source,
  Account and Timestamp. Every gift is a Payment. Check #, post-dated and check date appear only for
  Check; Delivered only for Cash or Check. **Manual fee** replaces the payment method's preset fee (net = amount less
  the manual fee); leave it empty to use the preset. After **Record donation** you go to the Transactions list.
- **Edit Donation** (click a transaction) has the same fields and rules as New Donation. There are no Type, Fee
  or batch fields on any donation form or in bulk edit; older rows keep what they already have. Collectors are no
  longer part of Donor Base.
- **New pledge** and **New vouchers** are tabs on New Donation; they open the pledge or voucher form. After a voucher is
  logged, its **voucher ref #** (VCH-...) is shown: write it on the physical voucher. The voucher form also has the
  **Issuer's ref. #** (the issuer's own number). Batch entry is on a campaign's More menu.
- **Charge a card** (admins): on New Donation or a campaign's Donations tab. Can save the card and set up a
  recurring charge; new recurring charges default to a set number of payments.
- **Transactions** is one list with a **Date** range above it (All time, Last 7 days, 30 days, 60 days, Last year or a
  custom range). It opens on "Successful" (completed) transactions; change the type dropdown to "All types" or
  another type to see others. Pages show 100 rows with numbered page buttons.
- **Save this view as my default** (in More) keeps your columns, filters and date range; **Reset to standard view**
  undoes it.
- **Filter** shows a box under each filterable column; **Columns** chooses, orders and saves views of columns;
  **More** exports to Excel or CSV and prints.
- **Editing a donation**: status can only move along allowed steps (for example a failed charge can't become
  completed). A payment that went through the card processor keeps its status, amount, method, fee and time;
  refund or void it at Sola from the donation instead.
- **Failed card charges** show a Retry button for admins (or "Retry the recurring charge" for a recurring one).
- **Refund / Returned check / Split / Delete** are on the donation's actions.
- Fees: each payment method has a fee; a failed charge never has a fee.
- **Pledges** track promised amounts and installments; payments can be matched to a pledge.
- **Recurring** lists scheduled card or bank charges: pause, resume, retry or cancel them.
- **Receipts**: the standard receipt text is set under Receipts (a fundraiser can also have their own, on their
  page); campaigns don't have their own receipt text. Receipts can be emailed, texted or printed.

## Payouts and checks

- **Payouts** menu: Payouts and Requests. Admins add payouts with **New payout**; fundraisers send a payout request.
- A new payout's Process on date defaults to today; a later date schedules it, and it returns to the Task Sheet
  on the day. The payout form shows the campaign's balance now and after the payout.
- **Print check**: on a payout with method Check and a bank account set up for checks, use Print check; later,
  **Print again**. If Print says the page is out of date, reload the page and try again.
- **Check Register** lists every check number, with void and reprint.

## Bank accounts and reconciliation

- **Bank accounts** are under Settings > Payments > Bank Accounts; each has check settings for printing.
- **Bank Reconciliation**: pick an account, then bring in bank lines (a CSV or Excel statement, typed lines, or
  Plaid), match them to donations, payouts and transfers, and sign off each period against the statement balance.
- **Plaid (sandbox only for now)**: on the bank lines tab, Connect with Plaid, pick a test bank and sign in with
  user_good / pass_good, then Sync now. Lines already brought in are skipped; Disconnect keeps them.

## Messages and outreach

- **Messages** is the internal inbox between the office and fundraisers.
- **Outreach** sends email and text campaigns: New Message, History, Templates, Sent Messages. In emails,
  **bold** and *italic* work and web addresses become links. Texts are plain (the stars are taken out). Merge
  fields {first_name}, {last_name} and {campaign_name} fill in per person in the subject, email and text.

## Machines and calendar

- **Machine Bookings**: fundraisers request a machine for a day; admins confirm and assign machines. Admins can
  book for a fundraiser (it stays a pending request). The Calendar shows bookings per day.

## Phone & Text Lookup (Settings > Messaging > Phone & Text Lookup)

- Text the organization's number with **BAL** for your campaigns, a campaign number, or a campaign number and its
  PIN. Team and sub-campaign numbers with a letter work by text too (1001A, in any case). **RECENT** (or RECENT 1001)
  texts back your latest 5 transactions with the donor's name. The phone line takes number IDs only for now.
- **Teams by phone**: after a campaign's numbers are read on the phone line, a caller whose number is on file (a
  donor, fundraiser or admin) can press 1 to hear the campaign's teams as a numbered list, then press a team's number
  and pound to hear it. Callers not on file aren't offered teams. Admins are
  matched by the phone in their notification settings, fundraisers by a registered phone.
- The Super Admin turns text replies and the phone line on or off; an option leaves Donary donations out of
  replies. Wrong PINs lock a phone (5 in an hour) or a campaign PIN (10 in an hour) for the rest of the hour.
  Every lookup is listed on that page.

## Settings

- **Organization**: name, legal name, EIN, address, phone and email (the phone and email show on payment pages),
  Zelle, check payee, director, time zone, logo and color. Web Addresses and API Keys are tabs there.
- **Users & Access**: invite people and set roles. **Notifications**: what each person gets by email or text.
- **Organization > API Keys**: bot check (Turnstile) keys, email and text keys, and the AI help assistant settings.
- **Payments**: Card Processing (Sola keys), Methods & Fees, Payout Methods, Bank Accounts.
- **Campaign Templates** and **Data Import** are under Settings too.

## Account security and two-step verification

- The shield button next to your email (bottom of the menu) opens **Account security**. Click **Set up two-step
  verification**, scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator,
  1Password and similar), and enter the 6-digit code to finish.
- **No app? Use text or call codes:** on Account security, under **Text or call codes**, click **Add a phone**, enter
  your number, choose **Text me** or **Call me**, and enter the 6-digit code. At sign-in you can choose text or call
  each time, and **Send a new code** if it doesn't arrive. Codes expire after 10 minutes; up to 5 codes an hour.
- Once it is on, you enter a code after your password when you sign in. **Not now** lets you in without bank and
  reconciliation data.
- **Bank Reconciliation and Plaid need a verified session.** Admins without two-step verification see a prompt there
  to set it up; the rest of Donor Base works as usual.
- New passwords need at least 12 characters, including a number and a special character.
- You are signed out after 30 minutes without activity, and after 12 hours in any case.

## The help assistant

- This assistant answers how-to questions about Oizer. It can't see donors, donations, bank lines or any other
  records, and can't change anything. Admins turn it on and choose its model and limits under Settings > Organization > API Keys.
