# Oizer DRM / oizer-crm handoff (sanitized)

Captured: 2026-11-08 20:59:11 America/New_York  
Source machine: BPJCC-600 (`15aea360-81b4-4987-81dd-f21f023a80d5`)  
Source path: `C:\Users\ShulimMueller\oizer-crm`  
Box destination: `/workspace/oizer-drm/handoff/`  
Project separation: Oizer only — do not mix with SM Solutions / Trubase / prototypes.

## Claude session (context only; not required for files)

- Session: https://claude.ai/code/session_01KzgNHLDyCoFdi5t5iBjA1i
- Parent browser check: Claude task finished ~8:57 PM Eastern; no Running/Stop/active terminal visible.
- Reported by Claude (not re-run here): 490 tests pass; clean typecheck/build; no commit/push/deploy confirmed.

## Git snapshot preserved

- Branch: `docs/platform-roadmap`
- HEAD: `c5b4b9174b8a33d2e06dd55e75a341a073566ef4`
- Remote (no credentials): `https://github.com/shulim1571/oizer-crm.git`
- Working tree: dirty — 15 modified + 6 untracked (21 status lines), including org integration work. Status preserved in archive `.git` + files.
- Last commit subject (from capture): Share the campaign's own page when its Payment Link isn't a web address (2026-11-03 21:36:17 -0500)

## Transfer artifacts (verified)

| Artifact | Path | Bytes | SHA-256 |
|---|---|---:|---|
| Archive | `/workspace/oizer-drm/handoff/oizer-crm-handoff-20261108-205911.tar.gz` | 2512815 | `8af0bb4e52ebf4aae4b91f630d191d2b224ef575141aa117a01d6aebde1da5ec` |
| Manifest | `/workspace/oizer-drm/handoff/oizer-crm-manifest-20261108-205911.tsv` | 137948 | `0245366026ddc47adf5fd4bbba3582d950bbc443e15b4f2195b23d128e57d164` |
| Meta | `/workspace/oizer-drm/handoff/oizer-crm-meta-20261108-205911.txt` | (sidecar) | (see file) |
| Extracted tree | `/workspace/oizer-drm/handoff/extract-verify/` | 892 files | all manifest hashes matched |

Also on source temp (unchanged originals):  
`C:\Users\ShulimMueller\AppData\Local\Temp\oizer-drm-handoff\`

## Included / excluded

- Included: tracked + untracked source, `.git` history, lockfile, migrations, docs, public, `.github`, project `.claude`, config files, private env filenames listed below (values not recorded here).
- Excluded (reproducible / bulky): `node_modules` (~317 MiB), `dist` (~2.2 MiB), `.wrangler`.
- Source tree on BPJCC-600 left untouched (no edits, no commits, no deletes).

## Env / secrets (private; values never logged)

Present in archive and extract (names only): `.env.example`, `.env.local`, `.env.production`, `.env.staging`.  
Permissions on `/workspace/oizer-drm` restricted (`go-rwx`). Do not upload/attach these externally. Do not print values.

## Runtime identity (metadata only; not installed/run on box yet)

- Package: `oizer-crm` @ `1.0.0`
- Scripts present: `dev`, `dev:staging`, `build`, `preview`, `typecheck`, `test`, `deploy`
- Deps include React/Vite/Supabase client; devDeps include TypeScript, Vitest, Wrangler
- Config filenames present: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `embed.html`, Supabase migrations/functions/tests under `supabase/`

## Standing product requirements (do not lose)

- Per-organization settings / integrations is a standing requirement.
- Moving SendGrid / Twilio / Turnstile keys into org-level settings: approved direction.
- Visual sidebar / settings review: still pending (needs login).
- Production apply migration / deploy: unanswered — **must NOT proceed** until the user decides.
- Migration `20261127000000_org_integration_keys.sql` is future-dated relative to 2026-11-08; verify dating before any future apply.
- Related untracked/modified work preserved in this snapshot (IntegrationKeys, PayMethods, messaging/payments/give/recurring updates, tests, migrations `20261126000000_daf_and_ach.sql` and `20261127000000_org_integration_keys.sql`).

## Quiescence

- Latest included source mtime at capture/post-check: 2026-11-08 20:52:14 America/New_York (`supabase/tests/givepage.test.ts`)
- Capture: 20:59:11; post-check 21:00:19 — **0 files newer than capture**; same file count (892) and byte total (4224374). Snapshot treated as final for Claude handoff.

## Remains for a fully usable independent workspace (not done in this transfer)

1. Install dependencies (`npm ci` / equivalent) — not run yet.
2. Confirm vault/auth access for app/Supabase/Cloudflare as needed for review — no account-wide Claude/browser creds copied.
3. Visual login review of sidebar/settings.
4. Explicit user decision before any production migration apply or deploy.
5. Parent separately preserves Claude conversation context if needed beyond this file snapshot.

## Sign-out readiness (files)

Verified independent copy of the project files exists on the box. Source originals remain on BPJCC-600. For **project files**, signing out of Claude is OK after the user confirms. This handoff did not transfer Claude account auth or conversation UI state.
