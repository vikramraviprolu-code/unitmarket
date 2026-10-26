#!/usr/bin/env bash
# monitoring.sh PROJECT_ID REGION EMAIL_ONE EMAIL_TWO BUDGET_AMOUNT   (GCP-1, D-049, C-13)
#
# Adds, after the first deploy: two uptime checks every 5 minutes (/healthz and the buyer home page /),
# an alert policy for each that e-mails BOTH addresses, and a monthly budget alert of BUDGET_AMOUNT in
# the billing account's currency (for example 60). Safe to run again: it keeps what exists. It prints
# names only. The notification channel commands use "gcloud beta", which needs the beta component
# (Cloud Shell has it); they could not be checked offline and are marked UNVERIFIED in the owner steps.
set -euo pipefail

die() {
  echo "monitoring: $*" >&2
  exit 1
}

[ "$#" -eq 5 ] || die "usage: monitoring.sh PROJECT_ID REGION EMAIL_ONE EMAIL_TWO BUDGET_AMOUNT"
PROJECT_ID="$1"
REGION="$2"
EMAIL_ONE="$3"
EMAIL_TWO="$4"
BUDGET_AMOUNT="$5"
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "PROJECT_ID is not a Google Cloud project id"
[[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || die "REGION is not a region name such as europe-west1"
[[ "$EMAIL_ONE" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "EMAIL_ONE is not an e-mail address"
[[ "$EMAIL_TWO" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "EMAIL_TWO is not an e-mail address"
[ "$EMAIL_ONE" != "$EMAIL_TWO" ] || die "the two e-mail addresses must differ (C-13: both operators)"
[[ "$BUDGET_AMOUNT" =~ ^[0-9]+(\.[0-9]{1,2})?$ ]] || die "BUDGET_AMOUNT is not a plain number such as 60"
command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed"
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
[ -n "$ACTIVE_ACCOUNT" ] || die "gcloud has no active account; sign in first, then run this again"
unset ACTIVE_ACCOUNT

SERVICE="unitmarket-sandbox"
POLICY_FILE=""
trap 'rm -f "$POLICY_FILE"' EXIT

echo "== APIs"
gcloud services enable monitoring.googleapis.com billingbudgets.googleapis.com --project="$PROJECT_ID"

SERVICE_URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)' 2>/dev/null || true)"
[ -n "$SERVICE_URL" ] || die "the service $SERVICE is not deployed yet; run deploy.sh first"
HOST="${SERVICE_URL#https://}"

echo "== e-mail channels (gcloud beta)"
CHANNELS=""
for EMAIL in "$EMAIL_ONE" "$EMAIL_TWO"; do
  CHANNEL="$(gcloud beta monitoring channels list --project="$PROJECT_ID" --type=email --filter="labels.email_address=${EMAIL}" --format='value(name)')"
  if [ -z "$CHANNEL" ]; then
    CHANNEL="$(gcloud beta monitoring channels create --project="$PROJECT_ID" --display-name="UnitMarket alert" --type=email --channel-labels="email_address=${EMAIL}" --format='value(name)')"
    echo "created a channel"
  else
    echo "kept a channel"
  fi
  CHANNELS="${CHANNELS:+${CHANNELS},}${CHANNEL}"
done

make_check() {
  local display="$1" path="$2" check_name check_id policy_name
  check_name="$(gcloud monitoring uptime list-configs --project="$PROJECT_ID" --filter="displayName=\"${display}\" OR display_name=\"${display}\"" --format='value(name)')"
  if [ -z "$check_name" ]; then
    gcloud monitoring uptime create "$display" \
      --project="$PROJECT_ID" \
      --resource-type=uptime-url \
      --resource-labels="host=${HOST},project_id=${PROJECT_ID}" \
      --protocol=https \
      --path="$path" \
      --period=5 \
      --status-codes=200 \
      --validate-ssl=true >/dev/null
    check_name="$(gcloud monitoring uptime list-configs --project="$PROJECT_ID" --filter="displayName=\"${display}\" OR display_name=\"${display}\"" --format='value(name)')"
    echo "created uptime check $display"
  else
    echo "kept uptime check $display"
  fi
  check_id="${check_name##*/}"
  [ -n "$check_id" ] || die "could not read the id of the uptime check $display"

  policy_name="${display} down"
  if [ -n "$(gcloud monitoring policies list --project="$PROJECT_ID" --filter="displayName=\"${policy_name}\" OR display_name=\"${policy_name}\"" --format='value(name)')" ]; then
    echo "kept alert policy $policy_name"
    return 0
  fi
  POLICY_FILE="$(mktemp)"
  {
    echo "displayName: \"${policy_name}\""
    echo "combiner: OR"
    echo "conditions:"
    echo "  - displayName: \"${display} fails from more than one location\""
    echo "    conditionThreshold:"
    echo "      filter: 'metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${check_id}\" AND resource.type=\"uptime_url\"'"
    echo "      aggregations:"
    echo "        - alignmentPeriod: 300s"
    echo "          perSeriesAligner: ALIGN_NEXT_OLDER"
    echo "          crossSeriesReducer: REDUCE_COUNT_FALSE"
    echo "          groupByFields:"
    echo "            - resource.label.*"
    echo "      comparison: COMPARISON_GT"
    echo "      thresholdValue: 1"
    echo "      duration: 300s"
    echo "notificationChannels:"
    echo "$CHANNELS" | tr ',' '\n' | while read -r ch; do echo "  - ${ch}"; done
  } >"$POLICY_FILE"
  gcloud monitoring policies create --project="$PROJECT_ID" --policy-from-file="$POLICY_FILE" >/dev/null
  rm -f "$POLICY_FILE"
  echo "created alert policy $policy_name"
}

echo "== uptime checks and alert policies"
make_check "ums-healthz" "/healthz"
make_check "ums-buyer-home" "/"

echo "== budget alert"
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)')"
BILLING_ACCOUNT="${BILLING_ACCOUNT#billingAccounts/}"
[ -n "$BILLING_ACCOUNT" ] || die "no billing account is linked to the project"
BUDGET_NAME="UnitMarket sandbox monthly"
if [ -n "$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --filter="displayName=\"${BUDGET_NAME}\" OR display_name=\"${BUDGET_NAME}\"" --format='value(name)')" ]; then
  echo "kept budget $BUDGET_NAME"
else
  gcloud billing budgets create \
    --billing-account="$BILLING_ACCOUNT" \
    --display-name="$BUDGET_NAME" \
    --budget-amount="$BUDGET_AMOUNT" \
    --calendar-period=month \
    --filter-projects="projects/${PROJECT_ID}" \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=0.9 \
    --threshold-rule=percent=1.0 \
    --notifications-rule-monitoring-notification-channels="$CHANNELS" >/dev/null
  echo "created budget $BUDGET_NAME"
fi
echo "monitoring done. Reminder: cancel or delete the project after 15 Dec 2026."
