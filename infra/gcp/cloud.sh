#!/usr/bin/env bash
# cloud.sh VERB [options]   (INT-CL1, V4, D-049)
#
# One command each to check, start, stop, restart and deploy the hosted sandbox stack, and to read its logs:
#   doctor | status [--json] | up | down [--yes] | restart | deploy TAG [--accept-old-backup] | logs [--lines N] [--errors]
# Every verb takes --dry-run, which prints the changing calls and makes only describe and list calls.
#
# All names come from stack.env, which is parsed as plain KEY=value lines and never run. Exit codes: 0 ok,
# 1 the action failed, 2 refused (a precondition is not met, or there is no terminal for a prompt), 64 bad usage.
# No verb turns the PayPal connection on. The only flag this kit writes is the connection flag, set to off.
# Agents run this kit only against a fake gcloud (D-049); the owner or Sakthi run it for real in Cloud Shell.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
# shellcheck source=lib/cloud-lib.sh
source "${HERE}/lib/cloud-lib.sh"

# ---- 1. the command line (a usage error is 64 and makes no call) ----------------------------------------------
DRY_RUN=0
YES=0
JSON=0
ACCEPT_OLD=0
ERRORS=0
LOG_LINES=100
TAG=""

[ "$#" -ge 1 ] || { usage >&2; die_usage "no verb given"; }
VERB="$1"
shift
case "$VERB" in
  help | --help | -h)
    usage
    exit 0
    ;;
  doctor | status | up | down | restart | deploy | logs) ;;
  *) die_usage "unknown verb: $(printf '%s' "$VERB" | tr -c 'A-Za-z0-9._-' '?' | cut -c1-40)" ;;
esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) [ "$VERB" = "down" ] || die_usage "--yes is only for down"; YES=1 ;;
    --json) [ "$VERB" = "status" ] || die_usage "--json is only for status"; JSON=1 ;;
    --accept-old-backup) [ "$VERB" = "deploy" ] || die_usage "--accept-old-backup is only for deploy"; ACCEPT_OLD=1 ;;
    --errors) [ "$VERB" = "logs" ] || die_usage "--errors is only for logs"; ERRORS=1 ;;
    --lines)
      [ "$VERB" = "logs" ] || die_usage "--lines is only for logs"
      [ "$#" -ge 2 ] || die_usage "--lines needs a number from 1 to 1000"
      LOG_LINES="$2"
      shift
      ;;
    -*) die_usage "unknown option: $(printf '%s' "$1" | tr -c 'A-Za-z0-9._=-' '?' | cut -c1-40)" ;;
    *)
      { [ "$VERB" = "deploy" ] && [ -z "$TAG" ]; } || die_usage "unexpected argument"
      TAG="$1"
      ;;
  esac
  shift
done
if [ "$VERB" = "deploy" ]; then
  [ -n "$TAG" ] || die_usage "deploy needs a git tag name"
  [[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] || die_usage "the tag is not a plain git tag name"
fi
if [ "$VERB" = "logs" ]; then
  [[ "$LOG_LINES" =~ ^[1-9][0-9]{0,3}$ ]] && [ "$LOG_LINES" -le 1000 ] || die_usage "--lines must be a number from 1 to 1000"
fi
[[ "$WAIT_STEP" =~ ^[0-9]{1,3}$ ]] || die_usage "CLOUD_WAIT_STEP must be a number of seconds"
[[ "$WAIT_TRIES" =~ ^[0-9]{1,4}$ ]] || die_usage "CLOUD_WAIT_TRIES must be a number"

# ---- 2. stack.env: strict KEY=value lines, a fixed set of names, checked values -------------------------------
STACK_FILE="${HERE}/stack.env"
[ -f "$STACK_FILE" ] || die_refuse "stack.env is missing"
PROJECT_ID="" REGION="" SERVICE="" SQL_INSTANCE="" OFFLINE_SERVICE="" AR_REPO=""
while IFS= read -r LINE || [ -n "$LINE" ]; do
  case "$LINE" in '' | '#'*) continue ;; esac
  [[ "$LINE" =~ ^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._-]*)$ ]] || die_refuse "stack.env: only plain KEY=value lines are allowed"
  case "${BASH_REMATCH[1]}" in
    PROJECT_ID | REGION | SERVICE | SQL_INSTANCE | OFFLINE_SERVICE | AR_REPO) printf -v "${BASH_REMATCH[1]}" '%s' "${BASH_REMATCH[2]}" ;;
    *) die_refuse "stack.env: a name the kit does not use" ;;
  esac
done <"$STACK_FILE"
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die_refuse "stack.env: PROJECT_ID is not a Google Cloud project id"
[[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || die_refuse "stack.env: REGION is not a region name such as europe-west3"
for NAME in SERVICE SQL_INSTANCE OFFLINE_SERVICE AR_REPO; do
  [[ "${!NAME}" =~ ^[a-z][a-z0-9-]{1,61}[a-z0-9]$ ]] || die_refuse "stack.env: ${NAME} is missing or is not a plain resource name"
done

# ---- 3. the tools and the signed-in account ----------------------------------------------------------------------
command -v gcloud >/dev/null 2>&1 || die_refuse "gcloud is not installed"
command -v jq >/dev/null 2>&1 || die_refuse "jq is not installed"
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
[ -n "$ACTIVE_ACCOUNT" ] || die_account
unset ACTIVE_ACCOUNT
ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

case "$VERB" in
  doctor) cmd_doctor ;;
  status) cmd_status ;;
  up) cmd_up ;;
  down) cmd_down ;;
  restart) cmd_restart ;;
  deploy) cmd_deploy ;;
  logs) cmd_logs ;;
esac
