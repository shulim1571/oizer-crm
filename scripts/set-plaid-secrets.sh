#!/usr/bin/env bash
# Sets the plaid Edge Function's secrets on the Oizer Supabase project from this shell's environment.
# PLAID_ENV chooses the Plaid environment: sandbox (the default) or production (approved for Oizer by Shulim,
# 2026-11-13). Each environment has its own secret: PLAID_SANDBOX_SECRET or PLAID_PRODUCTION_SECRET; PLAID_CLIENT_ID
# is the same for both. Prints only the names it set, never a value. Values pass through a private temporary file
# that is deleted right away.
#
#   Set keys:        SUPABASE_ACCESS_TOKEN=... PLAID_ENV=production PLAID_CLIENT_ID=... PLAID_PRODUCTION_SECRET=... scripts/set-plaid-secrets.sh
#   Switch only:     SUPABASE_ACCESS_TOKEN=... PLAID_ENV=production scripts/set-plaid-secrets.sh --env-only
#                    (sets PLAID_ENV alone, after checking by name that the client ID and that environment's secret
#                    are already set on the project; no key is read or sent)
set -euo pipefail
PROJECT=wwaknikpdquwnphhwzsm
env_name="${PLAID_ENV:-sandbox}"
case "$env_name" in
  sandbox) secret_name=PLAID_SANDBOX_SECRET ;;
  production) secret_name=PLAID_PRODUCTION_SECRET ;;
  *) echo "PLAID_ENV has to be sandbox or production." >&2; exit 1 ;;
esac

if [ "${1:-}" = "--env-only" ]; then
  : "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is not set in this shell}"
  names="$(curl -sf "https://api.supabase.com/v1/projects/$PROJECT/secrets" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(x=>x.name).join("\n")))')"
  for n in PLAID_CLIENT_ID "$secret_name"; do
    grep -qx "$n" <<<"$names" || { echo "Not set on the project yet: $n. Set the keys first (without --env-only)." >&2; exit 1; }
  done
  umask 077
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  printf 'PLAID_ENV=%s\n' "$env_name" > "$tmp"
  npx -y supabase@3.0.0 secrets set --env-file "$tmp" --remote="$PROJECT" --yes > /dev/null
  echo "Set on Supabase project $PROJECT: PLAID_ENV=$env_name (uses PLAID_CLIENT_ID and $secret_name, already set)"
  exit 0
fi

missing=()
[ -n "${PLAID_CLIENT_ID:-}" ] || missing+=(PLAID_CLIENT_ID)
[ -n "${!secret_name:-}" ] || missing+=("$secret_name")
if [ ${#missing[@]} -gt 0 ]; then echo "Not set in this shell: ${missing[*]}" >&2; exit 1; fi
umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf 'PLAID_CLIENT_ID=%s\n%s=%s\nPLAID_ENV=%s\n' "$PLAID_CLIENT_ID" "$secret_name" "${!secret_name}" "$env_name" > "$tmp"
npx -y supabase@3.0.0 secrets set --env-file "$tmp" --remote="$PROJECT" --yes > /dev/null
echo "Set on Supabase project $PROJECT: PLAID_CLIENT_ID, $secret_name, PLAID_ENV=$env_name"
