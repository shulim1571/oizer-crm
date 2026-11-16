# Moshe's answers on held readiness items (Nov 15, 2026). Approved by Shulim to build.

Build these (refs are finding numbers in readiness-fixes-2026-11-15.md, "Held for Moshe"):

- #44 Payment page (desktop): keep the 2-column layout, renumber steps so they read in order; "Cover the processing fee" starts unticked. Done Nov 16: desktop numbers read 1 Your details (left), 2 Amount, 3 Payment (right); phones keep 1 Amount, 2 Your details, 3 Payment. Cover the fee is now off on every template and campaign page (new ones were already off); admins can still turn it on per template.
- #54 After saving a donation: go to Transactions when started from the top New Donation button; go back to the campaign when started from a campaign page.
- #10 "To collect" status: use it only for checks not yet delivered (Moshe's rule). Adjust balance/fee handling to match.
- #11 Total potential: keep the formula; team (sub-campaign) amounts count just like the parent's amounts, so include them on the parent. Done Nov 16: a parent's Total potential now adds its teams' raised, open pledges, pending and undelivered checks (the box says "with teams" when they add anything). Sub-campaigns that keep their own balance stay on their own page, as for Raised.
- #8 Checks not delivered: on the dashboard, show them in one box together with open pledges (not counted in raised).
- #20 After "Yes, it printed": lock that payout's amount and payee (void the check to change). Unprinted payouts stay editable. Done Nov 16: once a check is confirmed printed (or emailed), the payout form shows amount and payee read-only with "Check #N has printed. Void the check to change this.", and the database refuses the change too. Voiding the check unlocks it; memo, notes and other fields stay editable; merging payees still works. 19 payouts on file are locked now.
- #41 Clicking a donation opens a read-only view first, with Edit and Issue Receipt buttons on top.
- #65 Sidebar says "Task Sheet". Rename the Machine Bookings "Calendar" and "Bookings" tabs to clearer names of your choice.

Do NOT build (Moshe said no):
- #18 blocking payouts/transfers below zero.
- #21 second approver.
- #2 locking records after bank sign-off.

Leave out for now: #34 "books closed through" date (undecided).

Added Nov 16 (Moshe, text 11:36 AM ET; Shulim asked to add it):
- Phones: show numbers with dashes (845-555-1234) throughout the app. Done Nov 16 (display only).
- Phones: home phone and cell phone as separate fields on donors/contacts, existing numbers moved over sensibly. Done Nov 16 (option A, no cost): donors have Cell phone and Home phone boxes, shown on the donor list and the donor page. Of 3,352 donors with a phone, 2,265 had two numbers (first went to Cell, second to Home; none had labels) and 1,087 had one (went to Cell). 3 numbers have an odd digit count and went to Cell as typed. The Phone field is kept and now holds "cell, home" so search and imports work as before. Texts to donors go to the Cell number. Option B (Twilio Lookup, about $30) was not done; it needs approval.
