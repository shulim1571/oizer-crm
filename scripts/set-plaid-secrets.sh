#!/usr/bin/env bash
# Sets the plaid Edge Function's secrets on the Oizer Supabase project from this shell's environment.
# Sandbox only. Reads PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET (and PLAID_ENV, default sandbox); prints only the
# names it set, never a value. The values pass through a private temporary file that is deleted right away.
#   SUPABASE_ACCESS_TOKEN=... PLAID_CLIENT_ID=... PLAID_SANDBOX_SECRET=... scripts/set-plaid-secrets.sh
set -euo pipefail
PROJECT=wwaknikpdquwnphhwzsm
env_name="${PLAID_ENV:-sandbox}"
if [ "$env_name" != "sandbox" ]; then echo "Only the Plaid sandbox is allowed (PLAID_ENV must be sandbox)." >&2; exit 1; fi
missing=()
[ -n "${PLAID_CLIENT_ID:-}" ] || missing+=(PLAID_CLIENT_ID)
[ -n "${PLAID_SANDBOX_SECRET:-}" ] || missing+=(PLAID_SANDBOX_SECRET)
if [ ${#missing[@]} -gt 0 ]; then echo "Not set in this shell: ${missing[*]}" >&2; exit 1; fi
umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf 'PLAID_CLIENT_ID=%s\nPLAID_SANDBOX_SECRET=%s\nPLAID_ENV=%s\n' "$PLAID_CLIENT_ID" "$PLAID_SANDBOX_SECRET" "$env_name" > "$tmp"
npx -y supabase@3.0.0 secrets set --env-file "$tmp" --project-ref "$PROJECT" > /dev/null
echo "Set on Supabase project $PROJECT: PLAID_CLIENT_ID, PLAID_SANDBOX_SECRET, PLAID_ENV=$env_name"
