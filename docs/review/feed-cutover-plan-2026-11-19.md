# Make / Donary feed cutover plan (AppSheet gap review #1)

Written 2026-11-19 for Shulim's OK. **Plan only.** No Make scenario, connection or setting was changed. The Make feed stays on and Donary stays off.

## Where things stand

| Feed | Today | In Donor Base |
|---|---|---|
| Donary payment, pledge, void, schedule | Donary → Make → **AppSheet first**, then Donor Base, with Donor Base errors ignored | `make-ingest` (`make_ingest`). Everything it records is tagged as test data (`test_import_rows`), so the test wipe removes it |
| Sola (card gifts not made in Donor Base) | Sola → Make → AppSheet, then Donor Base | `make-ingest`, the `sola` branch. Gifts made on Donor Base payment pages arrive through `payments`/`give`, and the `sola-webhook` function records them |
| Elevon | Elevon → Make → AppSheet, then Donor Base | `make-ingest`, the `elevon` branch |
| Donary direct | Not connected (`donary_settings` is empty) | Built: `donary-webhook` (`donary_ingest`, with an event log and duplicate check), and `donary-sync` (sends Donor Base campaigns and donors to Donary) |

Since Nov 12, the Make feed has delivered 1,183 Donary payments (10 recognized as duplicates), 1 void, 53 Elevon and 2 Sola transactions. No schedule has come in yet.

## Questions from the review, answered

- **Can Donor Base void without the AppSheet sheet lookup?** Yes. A Make `donary-void` finds the gift by its Donary payment number, or else by the gateway reference (`make_void`), and voids its split parts too. The direct webhook finds it by the Donary payment number. The Google Sheets step in Make's Donary Void scenario is only needed for AppSheet.
- **Duplicates during the overlap:** before recording anything, both paths look for a gift with the same Donary payment number or gateway reference (`make_existing`; the event log in `donary_ingest`). The unique indexes `donations_gateway_once` / `donations_donary_once` back this up. They don't cover imported AppSheet rows (`AS-…`), which is why the history import must skip what's already here (see step 5).
- **Schedules:** now kept as read-only schedules (Nov 19, gap #6). Their first payment is linked, and later payments are linked when Donary sends the schedule's ID with them.

## Recommended target

1. **Donary → Donor Base directly** (`donary-webhook`), not through Make. Donary's Enterprise webhooks send payment, void, pledge and schedule events to a per-organization address with its own token. Each event is logged and replays are ignored.
2. **Sola:** gifts made in Donor Base already come in directly. For card gifts made elsewhere, such as Sola's own portal, keep the Make Sola scenario, pointed at Donor Base first.
3. **Elevon:** keep Make, pointed at Donor Base first (there's no direct Elevon feed).
4. **AppSheet** stops receiving at the end of the overlap.

## Steps

Shulim makes every change in Make or Donary. Steps marked *build* are small Donor Base changes, made once this plan is approved.

1. **Live mode for the Make ingest (build).** Today every Make row is test data, so the test wipe would delete it. Add a per-organization switch, *test* (today's behavior, still the default) or *live*. In live mode, rows are real and aren't tagged.
2. **Production first.** Do the cutover on the production project (readiness #6), not the staging one used today. Copy the Make key and the Donary token there. Neither is ever written into a document or chat.
3. **Reverse the order in Make (Shulim).** In each Donary, Sola and Elevon scenario, send to Donor Base first and to AppSheet second. Stop ignoring Donor Base errors: on a non-200 reply, Make retries and alerts. Donor Base already answers with clear outcomes (`created`, `duplicate`, `voided`, `skipped` with a reason).
4. **Connect Donary directly (Shulim, once approved).** Enter the Donary orgGuid and API key under Settings → Donary. Paste Donor Base's webhook address into Donary's Enterprise webhook settings. Then turn **off** the four Make Donary scenarios, so each gift arrives once. The duplicate check catches any gift that arrives both ways during the switch.
5. **History import, then the overlap.** Import the AppSheet history (see the migration spec). The importer skips any row whose Donary payment number or gateway reference is already here, so gifts the live feed recorded first aren't doubled.
6. **Overlap of two weeks.** AppSheet keeps receiving from Make second. Each morning, compare the two:
   - per campaign: count and total for yesterday;
   - unmatched Donary events (the Donary page shows them).

   The nightly Books check flags any gaps.
7. **Retire AppSheet's feed (Shulim).** Remove the AppSheet step from each Make scenario, and the Google Sheets lookup from Donary Void. Keep the AppSheet app read-only for 90 days, then archive it.

## Rollback

- Until step 7, AppSheet still receives everything, so it stays a complete record.
- To go back on any day: put AppSheet first again in Make, and turn the Donary webhook off in Donor Base (Settings → Donary). Nothing is deleted.
- In Donor Base, gifts from the cutover days stay in place. The duplicate check makes re-sending safe.

## Checks before each step

- `make_ingest_log` and the Donary event log show no unexpected `error` or `unmatched` outcomes for 3 days.
- For each campaign, Donor Base's raised figure for the overlap days matches AppSheet's.
- The Task Sheet has no "No Fee Rule" items for incoming method names. Map them under Payment Methods & Fees → Method aliases.

## Cost

None. Make's operation count drops once the Donary scenarios are off.

## Needs a decision

- OK to build step 1 (live mode switch, default *test*)?
- Direct Donary webhook (recommended) or keep Donary in Make?
- Start date for the overlap, and its length (two weeks suggested).
