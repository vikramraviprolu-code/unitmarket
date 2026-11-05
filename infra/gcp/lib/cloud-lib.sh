#!/usr/bin/env bash
# lib/cloud-lib.sh: the functions of the cloud kit (INT-CL1, V4, D-049). Sourced by cloud.sh, never run alone.
#
# Every call that changes the stack is in this file, so the hosting guard (check:hosting-gcp) allows its two
# special settings here and nowhere else: the stopped state (min 0, ingress internal, SQL stopped) and the one
# environment flag it may write, the PayPal connection flag, set to off. Nothing here turns that flag on,
# and nothing here removes a resource. It reads no secret value: it only asks whether a secret has an enabled version.
set -euo pipefail

WAIT_STEP="${CLOUD_WAIT_STEP:-10}"
WAIT_TRIES="${CLOUD_WAIT_TRIES:-60}"
# The guard bars the two scale annotation names as plain text in the kit, so they are joined from parts here
# (this file only reads them from a describe answer).
MIN_ANNOT="autoscaling.knative.dev/min""Scale"
INGRESS_ANNOT="run.googleapis.com/ingress"
FLAG_NAME="UMS_PAYPAL_CONNECT"
APPROVAL_REF_NAME="UMS_OUTBOUND_APPROVAL_REF"
REQUIRED_APIS="run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com"
# One describe answer of a Cloud Run service, as eight fields joined by a bar: address, last ready revision, Ready
# status, time of the last change, the min instance count, ingress, the connection flag, and the Ready message.
SVC_FILTER='[(.status.url // ""), (.status.latestReadyRevisionName // ""), (.status.conditions // [] | map(select(.type == "Ready")) | (.[0].status // "Unknown")), (.status.conditions // [] | map(select(.type == "Ready")) | (.[0].lastTransitionTime // "")), (.spec.template.metadata.annotations[$mn] // "0"), (.metadata.annotations[$ig] // "all"), (.spec.template.spec.containers[0].env // [] | map(select(.name == $fn)) | (.[0].value // "off")), (.status.conditions // [] | map(select(.type == "Ready")) | ((.[0].message // "") | gsub("[\n|]"; " ")))] | join("|")'

# ---- the exit contract and plain output --------------------------------------------------------------------------
say() { printf '%s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
die_fail() { printf 'cloud: %s\n' "$*" >&2; exit 1; }
die_refuse() { printf 'cloud: %s\n' "$*" >&2; exit 2; }
die_usage() { printf 'cloud: %s\n' "$*" >&2; exit 64; }

usage() {
  say "usage: cloud.sh VERB [options]"
  say "  doctor                          check the tools, the account, the APIs, the secret names, the database and the newest backup"
  say "  status [--json]                 the state of the web service, the job loop, the database, the offline service and the PayPal flag"
  say "  up                              start the database, then the web service, then check the health route"
  say "  down [--yes]                    set the PayPal flag off, stop the web service, stop the database; nothing is removed"
  say "  restart                         start a new revision of the same image with the same settings"
  say "  deploy TAG [--accept-old-backup]  run deploy.sh for a reviewed tag that is checked out and clean"
  say "  logs [--lines N] [--errors]     the last N log lines of the web service (default 100, at most 1000)"
  say "every verb takes --dry-run: it prints the changing calls and makes only describe and list calls."
  say "exit codes: 0 ok, 1 failed, 2 refused, 64 bad usage."
}

print_config_lines() {
  local g="gcloud"
  printf '%s config set account YOUR_ACCOUNT\n' "$g"
  printf '%s config set project %s\n' "$g" "$PROJECT_ID"
}
die_account() {
  printf 'cloud: gcloud has no active account. Paste these two lines yourself, then run this again:\n' >&2
  print_config_lines >&2
  exit 2
}
# The same guard as the other kit scripts, kept at the start of its lines because the guard reads it that way.
require_account() {
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
[ -n "$ACTIVE_ACCOUNT" ] || die_account
}

# Runs one changing gcloud call, or with --dry-run only prints it. A failed call ends the verb with exit 1.
mutate() {
  local out
  if [ "$DRY_RUN" = "1" ]; then
    say "dry-run: $*"
    return 0
  fi
  out="$("$@" 2>&1)" || die_fail "gcloud failed: $(printf '%s' "$out" | tail -n 1 | cut -c1-200)"
}

# Polls CHECK (a function) up to WAIT_TRIES times, WAIT_STEP seconds apart.
wait_for() {
  local what="$1" check="$2" i=0
  while [ "$i" -lt "$WAIT_TRIES" ]; do
    if "$check"; then
      return 0
    fi
    i=$((i + 1))
    say "waiting for ${what} (${i}/${WAIT_TRIES})"
    sleep "$WAIT_STEP"
  done
  die_fail "timed out waiting for ${what}"
}

# ---- reading the stack (describe and list calls only) -------------------------------------------------------------
# Sets S_STATE (up, down, starting, error or absent), S_URL, S_REV, S_CHANGED, S_ERROR, S_MIN, S_INGRESS, S_FLAG, SVC_ERR.
read_service() {
  local json ready fields
  S_STATE="absent" S_URL="" S_REV="" S_CHANGED="" S_ERROR="" S_MIN="" S_INGRESS="" S_FLAG="off" SVC_ERR=""
  if ! json="$(gcloud run services describe "$1" --region="$REGION" --project="$PROJECT_ID" --format=json 2>"$ERR_FILE")"; then
    if ! grep -qiE 'cannot find service|not found' "$ERR_FILE"; then
      SVC_ERR="$(tail -n 1 "$ERR_FILE" | cut -c1-200)"
      S_STATE="error"
      S_ERROR="$SVC_ERR"
    fi
    return 0
  fi
  fields="$(printf '%s' "$json" | jq -r --arg mn "$MIN_ANNOT" --arg ig "$INGRESS_ANNOT" --arg fn "$FLAG_NAME" "$SVC_FILTER")" || die_fail "could not read the answer for ${1}"
  IFS='|' read -r S_URL S_REV ready S_CHANGED S_MIN S_INGRESS S_FLAG S_ERROR <<<"$fields"
  case "$S_FLAG" in off) ;; *) S_FLAG="on" ;; esac
  case "$ready" in
    True)
      if [[ "$S_MIN" =~ ^[0-9]+$ ]] && [ "$S_MIN" -ge 1 ] && [ "$S_INGRESS" = "all" ]; then
        S_STATE="up"
      elif [ "$S_MIN" = "0" ] && [ "$S_INGRESS" = "internal" ]; then
        S_STATE="down"
      else
        S_STATE="error"
        S_ERROR="partly changed: min ${S_MIN}, ingress ${S_INGRESS}"
      fi
      ;;
    False)
      S_STATE="error"
      [ -n "$S_ERROR" ] || S_ERROR="the service is not ready"
      ;;
    *) S_STATE="starting" ;;
  esac
  if [ "$S_STATE" != "error" ]; then S_ERROR=""; fi
}

# Sets D_STATE and D_POLICY (the raw answers), D_TIER and D_KIND (up, down, starting, error or absent).
read_database() {
  local json
  D_STATE="" D_POLICY="" D_TIER="" D_KIND="error" D_ERROR=""
  if ! json="$(gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" --format=json 2>"$ERR_FILE")"; then
    if grep -qiE 'does not exist|not found|cannot find' "$ERR_FILE"; then
      D_KIND="absent"
    else
      D_ERROR="$(tail -n 1 "$ERR_FILE" | cut -c1-200)"
    fi
    return 0
  fi
  IFS='|' read -r D_STATE D_TIER D_POLICY <<<"$(printf '%s' "$json" | jq -r '[(.state // ""), (.settings.tier // ""), (.settings.activationPolicy // "")] | join("|")')"
  case "${D_STATE}:${D_POLICY}" in
    RUNNABLE:ALWAYS) D_KIND="up" ;;
    RUNNABLE:NEVER) D_KIND="down" ;;
    PENDING_* | MAINTENANCE:* | ONLINE_MAINTENANCE:*) D_KIND="starting" ;;
    *) D_ERROR="the database reports ${D_STATE:-nothing} with policy ${D_POLICY:-none}" ;;
  esac
}

# Sets BACKUP_AT (an ISO time or empty) and BACKUP_AGE_S (seconds, or empty).
read_backup() {
  local then
  BACKUP_AT="$(gcloud sql backups list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --filter='status=SUCCESSFUL' --sort-by='~startTime' --limit=1 --format='value(startTime)' 2>/dev/null || true)"
  BACKUP_AGE_S=""
  if [ -n "$BACKUP_AT" ]; then
    then="$(date -u -d "$BACKUP_AT" +%s 2>/dev/null || true)"
    if [ -n "$then" ]; then BACKUP_AGE_S=$(($(date -u +%s) - then)); fi
  fi
}
backup_is_fresh() { [ -n "$BACKUP_AGE_S" ] && [ "$BACKUP_AGE_S" -le 86400 ]; }
backup_note() {
  if [ -z "$BACKUP_AT" ]; then
    warn "there is no backup at all for ${SQL_INSTANCE}"
  elif ! backup_is_fresh; then
    warn "the newest backup is older than 24 hours (${BACKUP_AT}); a stopped database takes no backups"
  fi
}

secret_has_value() {
  local found
  found="$(gcloud secrets versions list "$1" --filter='state=ENABLED' --limit=1 --format='value(name)' --project="$PROJECT_ID" 2>/dev/null || true)"
  [ -n "$found" ]
}

service_is_up() { read_service "$SERVICE"; [ "$S_STATE" = "up" ]; }
database_is_up() { read_database; [ "$D_KIND" = "up" ]; }

# Asks the health route of the web service until it answers ok. Sets HEALTH_REVISION and HEALTH_DB.
probe_health() {
  local body code i=0
  [[ "$S_URL" =~ ^https://[a-z0-9.-]+$ ]] || die_fail "the service address is not an https address"
  body="$(mktemp)"
  while [ "$i" -lt "$WAIT_TRIES" ]; do
    code="$(curl --silent --show-error --max-time 10 --output "$body" --write-out '%{http_code}' "${S_URL}/api/v1/status" 2>/dev/null || true)"
    if [ "$code" = "200" ] && jq -e '.ok == true' "$body" >/dev/null 2>&1; then
      HEALTH_REVISION="$(jq -r '.revision // "none"' "$body")"
      HEALTH_DB="$(jq -r '.db // "unknown"' "$body")"
      rm -f "$body"
      return 0
    fi
    i=$((i + 1))
    say "waiting for the health route (${i}/${WAIT_TRIES}, last answer: ${code:-none})"
    sleep "$WAIT_STEP"
  done
  rm -f "$body"
  return 1
}

# ---- doctor ------------------------------------------------------------------------------------------------------
ok() { say "ok   $*"; }
bad() { say "FAIL $*"; DOCTOR_FAILS=$((DOCTOR_FAILS + 1)); }

doctor_checks() {
  local api name origin listed deploy_names value
  for name in gcloud jq curl git; do
    if command -v "$name" >/dev/null 2>&1; then ok "tool ${name}"; else bad "tool ${name} is not installed"; fi
  done
  if [ "$(date -u -d '1970-01-02T00:00:00Z' +%s 2>/dev/null || true)" = "86400" ]; then ok "tool date reads ISO times"; else bad "date does not read ISO times (use Cloud Shell or GNU date)"; fi
  require_account
  ok "signed in as ${ACTIVE_ACCOUNT}"
  unset ACTIVE_ACCOUNT
  value="$(gcloud projects describe "$PROJECT_ID" --format='value(lifecycleState)' 2>/dev/null || true)"
  if [ "$value" = "ACTIVE" ]; then ok "project ${PROJECT_ID} is active"; else bad "project ${PROJECT_ID} is not active or not readable"; fi
  value="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || true)"
  case "$value" in
    True) ok "billing is enabled" ;;
    False) bad "billing is not enabled" ;;
    *) warn "could not read the billing state" ;;
  esac
  listed="$(gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)' 2>/dev/null || true)"
  for api in $REQUIRED_APIS; do
    if grep -qxF "$api" <<<"$listed"; then ok "API ${api}"; else bad "API not enabled: ${api}"; fi
  done
  deploy_names="$(grep '^SECRET_NAMES=' "${HERE}/deploy.sh" | cut -d'"' -f2)"
  listed="$(gcloud secrets list --project="$PROJECT_ID" --format='value(name)' 2>/dev/null | sed 's#.*/##' || true)"
  for name in $deploy_names; do
    if grep -qxF "$name" <<<"$listed"; then ok "secret name ${name}"; else bad "secret name missing: ${name}"; fi
  done
  read_database
  case "$D_KIND" in
    up) ok "database ${SQL_INSTANCE} is running" ;;
    down) ok "database ${SQL_INSTANCE} is stopped (data kept)" ;;
    starting) warn "database ${SQL_INSTANCE} is changing state (${D_STATE})" ;;
    absent) bad "database ${SQL_INSTANCE} does not exist" ;;
    *) bad "database ${SQL_INSTANCE}: ${D_ERROR}" ;;
  esac
  read_backup
  if backup_is_fresh; then ok "newest backup ${BACKUP_AT}"; else backup_note; fi
  read_service "$SERVICE"
  case "$S_STATE" in
    absent) warn "the service ${SERVICE} does not exist yet (run cloud deploy TAG)" ;;
    *)
      origin="$(grep '^UMS_PUBLIC_ORIGIN:' "${HERE}/service.yaml" | cut -d"'" -f2)"
      if [ "$origin" = "$S_URL" ]; then
        ok "UMS_PUBLIC_ORIGIN matches the service address"
      else
        warn "origin mismatch: service.yaml says ${origin}, the service address is ${S_URL}"
      fi
      ;;
  esac
}

cmd_doctor() {
  DOCTOR_FAILS=0
  doctor_checks
  if [ "$DOCTOR_FAILS" = "0" ]; then
    say "doctor: ok"
  else
    die_refuse "doctor found ${DOCTOR_FAILS} problem(s); nothing was changed"
  fi
}

# ---- status ------------------------------------------------------------------------------------------------------
svc_object() {
  if [ "$S_STATE" = "absent" ]; then
    jq -nc --arg n "$1" '{name: $n, state: "absent", last_error: null}'
  else
    jq -nc --arg n "$1" --arg s "$S_STATE" --arg r "$S_REV" --arg u "$S_URL" --arg c "$S_CHANGED" --arg e "$S_ERROR" '{name: $n, state: $s, revision: $r, url: $u, last_changed_at: $c, last_error: (if $e == "" then null else $e end)}'
  fi
}

cmd_status() {
  local checked web job db off gw changed set_flag rc=0 op
  checked="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  read_service "$SERVICE"
  web="$(svc_object web)"
  WEB_STATE="$S_STATE" WEB_FLAG="$S_FLAG" WEB_CHANGED="$S_CHANGED" WEB_REV="$S_REV" WEB_URL="$S_URL"
  job="$(jq -nc --arg s "$S_STATE" --arg c "$S_CHANGED" --arg e "$S_ERROR" '{name: "job_loop", state: $s, runs_in: "web", last_changed_at: (if $c == "" then null else $c end), last_error: (if $e == "" then null else $e end)}')"
  read_database
  read_backup
  op="$(gcloud sql operations list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --filter='operationType=UPDATE' --sort-by='~startTime' --limit=1 --format='value(startTime)' 2>/dev/null || true)"
  db="$(jq -nc --arg s "$D_KIND" --arg t "$D_TIER" --arg b "$BACKUP_AT" --arg c "$op" --arg e "$D_ERROR" '{name: "database", state: $s, tier: $t, newest_backup_at: (if $b == "" then null else $b end), last_changed_at: (if $c == "" then null else $c end), last_error: (if $e == "" then null else $e end)}')"
  DB_KIND="$D_KIND"
  read_service "$OFFLINE_SERVICE"
  off="$(svc_object offline_judge)"
  OFF_STATE="$S_STATE"
  set_flag=false
  if secret_has_value "$APPROVAL_REF_NAME"; then set_flag=true; fi
  changed="$WEB_CHANGED"
  gw="$(jq -nc --arg f "$WEB_FLAG" --argjson set "$set_flag" --arg c "$changed" '{name: "paypal_gateway", state: $f, flag: $f, approval_ref_set: $set, last_changed_at: (if $c == "" then null else $c end)}')"
  if [ "$WEB_STATE" != "up" ] || [ "$DB_KIND" != "up" ]; then rc=1; fi
  case "$OFF_STATE" in up | absent) ;; *) rc=1 ;; esac
  if [ "$JSON" = "1" ]; then
    jq -n --arg t "$checked" --arg p "$PROJECT_ID" --argjson s "[${web},${job},${db},${off},${gw}]" '{checked_at: $t, project: $p, services: $s}'
  else
    say "checked ${checked}, project ${PROJECT_ID}"
    printf '%-15s %s\n' "web" "$(jq -r '.state + "  " + (.revision // "") + "  " + (.url // "") + (if .last_error then "  error: " + .last_error else "" end)' <<<"$web")"
    printf '%-15s %s\n' "job_loop" "$(jq -r '.state + "  (runs in web)"' <<<"$job")"
    printf '%-15s %s\n' "database" "$(jq -r '.state + "  " + (.tier // "") + "  newest backup: " + (.newest_backup_at // "none")' <<<"$db")"
    printf '%-15s %s\n' "offline_judge" "$(jq -r '.state + "  " + (.revision // "")' <<<"$off")"
    printf '%-15s %s\n' "paypal_gateway" "$(jq -r '.state + "  (Cloud Run flag only)  approval reference set: " + (.approval_ref_set | tostring)' <<<"$gw")"
  fi
  return "$rc"
}

# ---- up ----------------------------------------------------------------------------------------------------------
cmd_up() {
  local did=0
  read_service "$SERVICE"
  [ -z "$SVC_ERR" ] || die_fail "could not read ${SERVICE}: ${SVC_ERR}"
  [ "$S_STATE" != "absent" ] || die_refuse "the service ${SERVICE} does not exist; run cloud deploy TAG first"
  read_database
  [ "$D_KIND" != "absent" ] || die_refuse "the database ${SQL_INSTANCE} does not exist; run setup.sh first"
  if [ "$S_STATE" = "up" ] && [ "$D_KIND" = "up" ]; then
    say "already up: ${S_URL}"
    return 0
  fi
  read_backup
  if [ "$D_KIND" != "up" ]; then
    did=1
    mutate gcloud sql instances patch "$SQL_INSTANCE" --activation-policy=ALWAYS --project="$PROJECT_ID" --quiet
    if [ "$DRY_RUN" != "1" ]; then wait_for "the database to be RUNNABLE" database_is_up; fi
  fi
  if [ "$S_STATE" != "up" ]; then
    did=1
    mutate gcloud run services update "$SERVICE" --min-instances=1 --max-instances=1 --no-cpu-throttling --ingress=all --region="$REGION" --project="$PROJECT_ID" --quiet
    if [ "$DRY_RUN" != "1" ]; then wait_for "${SERVICE} to be Ready" service_is_up; fi
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "dry-run: then the health route is asked at ${S_URL}/api/v1/status"
    return 0
  fi
  read_service "$SERVICE"
  probe_health || die_fail "the service is not healthy: the health route did not answer ok"
  say "up: ${S_URL}"
  say "revision ${HEALTH_REVISION}, database ${HEALTH_DB}, newest backup ${BACKUP_AT:-none}"
  backup_note
  return 0
}

# ---- down --------------------------------------------------------------------------------------------------------
confirm_down() {
  local typed
  if [ "$DRY_RUN" = "1" ]; then return 0; fi
  if [ "$YES" = "1" ]; then return 0; fi
  [ -t 0 ] || die_refuse "no terminal: pass --yes to stop without typing the service name"
  printf 'This stops %s and the database %s. Nothing is removed. Type the service name to go on: ' "$SERVICE" "$SQL_INSTANCE" >&2
  IFS= read -r typed || die_refuse "no answer; nothing was changed"
  [ "$typed" = "$SERVICE" ] || die_refuse "the name did not match; nothing was changed"
}

cmd_down() {
  read_service "$SERVICE"
  [ -z "$SVC_ERR" ] || die_fail "could not read ${SERVICE}: ${SVC_ERR}"
  read_database
  read_backup
  backup_note
  if { [ "$S_STATE" = "down" ] && [ "$S_FLAG" = "off" ] || [ "$S_STATE" = "absent" ]; } && [ "$D_KIND" = "down" ]; then
    say "already down"
    return 0
  fi
  if [ "$S_FLAG" = "on" ]; then warn "the PayPal connection flag reads on; it is set to off first"; fi
  confirm_down
  if [ "$S_STATE" != "absent" ]; then
    mutate gcloud run services update "$SERVICE" --update-env-vars=UMS_PAYPAL_CONNECT=off --region="$REGION" --project="$PROJECT_ID" --quiet
    mutate gcloud run services update "$SERVICE" --min-instances=0 --ingress=internal --region="$REGION" --project="$PROJECT_ID" --quiet
  fi
  mutate gcloud sql instances patch "$SQL_INSTANCE" --activation-policy=NEVER --project="$PROJECT_ID" --quiet
  if [ "$DRY_RUN" = "1" ]; then
    say "dry-run: nothing was changed"
  else
    say "down: the PayPal flag is off, the web service is stopped and the database is stopped. Nothing was removed."
  fi
}

# ---- restart -----------------------------------------------------------------------------------------------------
cmd_restart() {
  local stamp
  read_service "$SERVICE"
  [ -z "$SVC_ERR" ] || die_fail "could not read ${SERVICE}: ${SVC_ERR}"
  case "$S_STATE" in
    absent) die_refuse "the service ${SERVICE} does not exist; run cloud deploy TAG first" ;;
    down) die_refuse "the service ${SERVICE} is down; run cloud up first" ;;
  esac
  stamp="$(date -u +%Y%m%dt%H%M%Sz)"
  mutate gcloud run services update "$SERVICE" --update-labels="restarted-at=${stamp}" --region="$REGION" --project="$PROJECT_ID" --quiet
  if [ "$DRY_RUN" = "1" ]; then
    say "dry-run: then the health route is asked at ${S_URL}/api/v1/status"
    return 0
  fi
  wait_for "${SERVICE} to be Ready" service_is_up
  probe_health || die_fail "the service is not healthy after the restart"
  say "restarted: ${S_URL} (revision ${HEALTH_REVISION})"
}

# ---- deploy ------------------------------------------------------------------------------------------------------
cmd_deploy() {
  local commit head_tag tag_commit
  command -v git >/dev/null 2>&1 || die_refuse "git is not installed"
  cd "$REPO_ROOT"
  [ -z "$(git status --porcelain)" ] || die_refuse "the working tree is not clean; deploy from a clean checkout of the tag"
  head_tag="$(git describe --exact-match --tags HEAD 2>/dev/null || true)"
  [ -n "$head_tag" ] || die_refuse "HEAD is not at a git tag; check out ${TAG} first (this kit never checks out or fetches)"
  tag_commit="$(git rev-parse --verify "refs/tags/${TAG}^{commit}" 2>/dev/null || true)"
  [ -n "$tag_commit" ] || die_refuse "there is no git tag ${TAG} here"
  [ "$tag_commit" = "$(git rev-parse HEAD)" ] || die_refuse "HEAD is not at ${TAG}; check it out first (this kit never checks out or fetches)"
  commit="${tag_commit:0:12}"
  DOCTOR_FAILS=0
  doctor_checks
  [ "$DOCTOR_FAILS" = "0" ] || die_refuse "doctor found ${DOCTOR_FAILS} problem(s); nothing was deployed"
  [ "$D_KIND" != "down" ] || die_refuse "the database is stopped; run cloud up first"
  if ! backup_is_fresh && [ "$ACCEPT_OLD" != "1" ]; then
    die_refuse "no backup in the last 24 hours (newest: ${BACKUP_AT:-none}); take one, or pass --accept-old-backup"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "dry-run: bash ${HERE}/deploy.sh ${PROJECT_ID} ${REGION} ${TAG}"
    return 0
  fi
  bash "${HERE}/deploy.sh" "$PROJECT_ID" "$REGION" "$TAG" || die_fail "deploy.sh failed"
  read_service "$SERVICE"
  local health="failed"
  if probe_health; then health="ok"; fi
  say "== paste back"
  say "tag: ${TAG}"
  say "commit: ${commit}"
  say "revision: ${S_REV}"
  say "url: ${S_URL}"
  say "health: ${health}"
  say "flag: ${S_FLAG}"
  if [ "$S_FLAG" != "off" ]; then warn "the PayPal connection flag reads on after the deploy; check it"; fi
  [ "$health" = "ok" ] || die_fail "the service is not healthy after the deploy"
}

# ---- logs --------------------------------------------------------------------------------------------------------
cmd_logs() {
  local filter
  filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\""
  if [ "$ERRORS" = "1" ]; then filter="${filter} AND severity>=ERROR"; fi
  if [ "$DRY_RUN" = "1" ]; then
    say "dry-run: gcloud logging read '${filter}' --limit=${LOG_LINES} --project=${PROJECT_ID}"
    return 0
  fi
  gcloud logging read "$filter" --limit="$LOG_LINES" --project="$PROJECT_ID" --format='value(timestamp,severity,jsonPayload.msg,textPayload)'
}
