# Oizer CRM

Donor and campaign CRM for Oizer, replacing the AppSheet app. React + Vite front end on a Supabase (Postgres + Auth) back end.

## What's in it

| Screen | Admin | Campaign manager |
| --- | --- | --- |
| Active / All Campaigns (grouped by manager, Raised · Fees · Expenses · Balance · Pending) | all campaigns, add/edit | only campaigns where they are manager or sub-manager |
| Campaign detail (KPIs + donations, expenses, transfers, tasks, pledges) | add/edit everything | read-only, can add/edit tasks |
| Donation last 7 days (grouped by type) / All Donations (server-side search & paging) | add/edit/delete | their campaigns, read-only |
| New Donation | ✓ | — |
| Expense, Transfer | add/edit | their campaigns, read-only |
| Donor list + donor profile (lifetime giving, by campaign, by year, history, follow-up tasks) | add/edit | donors who gave to their campaigns |
| Task | ✓ | their campaigns |
| Exchange, Source, Account, Manager, Collector | ✓ | — |
| Users & Access | ✓ | — |

Every table has search (top bar), sortable columns and CSV download.

### Campaign math (matches AppSheet)

- **Raised** = Σ amount of `Payment` donations + Σ `funded` on `Batch` donations + transfers in
- **Fees** = Σ fee (non-voided)
- **Expenses** = Σ expenses + transfers out
- **Balance** = Raised − Fees − Expenses
- **Pending Balance** = Σ batch_pending

`Collect` and `Voided` donations don't count toward Raised. See the `campaign_summary` view in
[`supabase/migrations`](supabase/migrations).

## Logins & roles

Supabase Auth (email + password). Access is decided when someone creates a login:

1. Email listed in **Users & Access → Admin emails** → **admin** (seeded with `smueller@bpjcc.org`).
2. Email matches a **Manager** record's email → **manager**, linked to that manager record.
3. Anything else → **pending** (sees nothing) until an admin assigns a role.

Admins can change roles and link a login to one or more manager records on the Users & Access page.
All of this is enforced in Postgres with row-level security, not just hidden in the UI.

## Running locally

```bash
cp .env.example .env.local   # fill in the Supabase URL and publishable key
npm install
npm run dev
```

## Deploying

The build output (`dist/`) is a static site, so any static host works:

- **Netlify / Vercel / Cloudflare Pages:** import this GitHub repo, build command `npm run build`, output `dist`,
  and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- **GitHub Pages (current):** live at https://oizer.trubase.org (CNAME → `shulim1571.github.io`). Run the
  *Deploy to GitHub Pages* workflow to publish changes.

After deploying, add the site URL in Supabase → Authentication → URL Configuration (Site URL and Redirect URLs),
so confirmation and password-reset emails link back to it.

## Database

- Schema, RLS policies and views: `supabase/migrations/`.
- IDs keep the AppSheet Row IDs (campaign IDs are the campaign numbers).
- Donor data lives only in Supabase; nothing from the spreadsheet is committed here.
