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

## Organizations

Every business record belongs to one organization, and organizations can't see each other. Oizer Umoshia is the first.

- **Which organization:** the web address decides, through `org_domains`, or `?org=slug`. The app sends it with every
  data request as `x-org-id`. The database honours that only for a member, so it selects but never grants.
- **The wall:** a restrictive `org_wall` policy on every table, plus composite foreign keys so a record can't point at
  another organization's record. Campaign IDs and source keys only need to be unique within an organization.
- **Platform Owner:** sees a list of organizations with counts, and can add, suspend or enter one. Entering opens a
  session that expires after 4 hours and appears in that organization's own activity log. Set through `platform_owners`.

## Logins & roles

Supabase Auth (email + password). One login can belong to several organizations, with a role in each (`org_members`):

1. Email listed in **Users & Access → Admin emails** → **admin** there.
2. Email matches a **Manager** record's email → **manager** there, linked to that manager record.
3. Signed up on an organization's page with neither → **pending** (sees nothing) until an admin assigns a role.

Admins can change roles and link a login to one or more manager records on the Users & Access page.
All of this is enforced in Postgres with row-level security, not just hidden in the UI.

Five wrong passwords in a row lock an account for an hour once the password verification hook is switched on in the
Supabase dashboard (Authentication > Hooks → `public.hook_password_verification_attempt`). Resetting the password or an
admin's **Unlock** on Users & Access clears it.

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
- **Deleting never removes data.** Deletes on business tables mark the row with `deleted_at`, and it disappears from
  every screen and total. `restore_record(table, id)` brings it back (admins only; no screen for it yet).
- **Activity Log** records every add, edit, delete, sign-in, sign-out and CSV export. Nobody can edit it through the
  app or API, and triggers block changes even for the database owner.
- **Balance snapshots:** run `select take_balance_snapshot('before-x')` ahead of a risky migration and
  `select * from balance_drift('before-x')` after it. No rows back means no campaign's numbers moved.

- **Scheduled jobs:** pg_cron calls `run_job(name)`, and every run is recorded in `job_runs`. New jobs go in `run_job`
  plus a `cron.schedule` line.
- **Health check:** the `health` Edge Function answers 200 when the database responds and the hourly heartbeat is
  recent, otherwise 503. Callers must send the project's legacy anon key as a bearer token.

## Staging

`npm run dev:staging` runs the app against the staging Supabase project ("Oizer DRM", org Trubase Live), which holds no
real data. Apply new migrations there first. `npm run dev` still uses `.env.local`, which points at the live project.

## Tests

```bash
npm test
```

Runs every migration on an in-process Postgres (PGlite) with a small stand-in for Supabase Auth, then checks access
rules, soft delete, the activity log and balance math. No Supabase project or network needed. Anything that depends
on Supabase itself (real sign-ins, PostgREST, grants on a real project) still needs checking on staging.
