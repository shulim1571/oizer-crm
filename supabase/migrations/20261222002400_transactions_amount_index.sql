-- List speed audit (Moshe Henig, 2026-11-12: "make sure the payout list and all other lists load quickly").
-- Every list was timed as the app loads it, as an Oizer admin on the sample organization. All but one were already
-- fast in the database (Payouts 24 ms; most 5-60 ms; Campaigns, Fundraisers and Donors 75-145 ms after edb28a9).
-- The one slow one: Transactions sorted by Amount (0.8-1.0 s in real use, 272 ms in a trial), because the database
-- built the whole list before sorting it. With donations indexed by amount it reads them in order instead (64 ms).
-- Nothing a list shows changes.
create index if not exists donations_org_amount_idx on public.donations (org_id, amount) where deleted_at is null;
