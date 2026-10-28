#!/usr/bin/env bash
# set-secret.sh PROJECT_ID REGION NAME   (GCP-1, D-049)
#
# Stores a new version of one secret in Secret Manager. The value is typed at a hidden prompt, twice,
# in a real terminal; it is never an argument, never in the shell history and never printed. Only the
# secret name and the new version number are printed. Run setup.sh first (it makes the empty secret).
#
# NAME is one of the names below. DATABASE_URL is made by setup.sh and cannot be set here.
# UMS_PUBLIC_ORIGIN is not a secret: it goes in service.yaml.
set -euo pipefail

die() {
  echo "set-secret: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || die "usage: set-secret.sh PROJECT_ID REGION NAME"
PROJECT_ID="$1"
REGION="$2"
NAME="$3"
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "PROJECT_ID is not a Google Cloud project id"
[[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || die "REGION is not a region name such as europe-west1"
case "$NAME" in
  PAYPAL_CLIENT_ID | PAYPAL_CLIENT_SECRET | PAYPAL_WEBHOOK_ID | UMS_OUTBOUND_APPROVAL_REF | UMS_SESSION_SECRET | UMS_APPROVAL_SECRET | UMS_LINK_SECRET | UMS_DEMO_PASSCODE_HASH | UMS_OWN_MERCHANT_ID | UMS_OPERATOR_TOTP_KEYS) ;;
  *) die "NAME is not one of the allowed secret names" ;;
esac
[ -t 0 ] && [ -t 2 ] || die "refused: a real terminal is needed for the hidden prompt (no pipe, no here-document)"
command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed"
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
[ -n "$ACTIVE_ACCOUNT" ] || die "gcloud has no active account; sign in first, then run this again"
unset ACTIVE_ACCOUNT

gcloud secrets describe "$NAME" --project="$PROJECT_ID" >/dev/null 2>&1 || die "the secret $NAME does not exist; run setup.sh first"

VALUE=""
CONFIRM=""
read -r -s -p "Value for $NAME (hidden): " VALUE
echo >&2
read -r -s -p "Type it again (hidden): " CONFIRM
echo >&2
[ -n "$VALUE" ] || die "empty value refused"
[ "$VALUE" = "$CONFIRM" ] || die "the two entries differ; nothing was stored"
unset CONFIRM

RESULT="$(printf '%s' "$VALUE" | gcloud secrets versions add "$NAME" --data-file=- --project="$PROJECT_ID" --format='value(name)')"
unset VALUE
echo "stored: $NAME version ${RESULT##*/}"
