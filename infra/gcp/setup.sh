#!/usr/bin/env bash
# setup.sh PROJECT_ID REGION   (GCP-1, D-049)
#
# Creates the resources for the hosted sandbox demo in YOUR Google Cloud project. Run it yourself in
# Cloud Shell, signed in as yourself. It is safe to run again: each step looks first and keeps what exists.
# It prints names only, never a secret value. The database password is made here, goes straight into
# Secret Manager as the DATABASE_URL secret, and is never shown or stored anywhere else. The two gcloud
# commands that take it as an argument run with gcloud file logging off, because gcloud writes every
# argument to ~/.config/gcloud/logs otherwise.
#
# What it creates: the APIs, one Artifact Registry repository, one runtime service account (secret
# accessor on the listed secrets and Cloud SQL client, nothing else), one Cloud SQL for PostgreSQL 16
# instance (backups, point in time recovery, deletion protection, no authorized networks, connector
# enforcement, a storage limit), one database, one database user, and the empty secret containers.
# INFRA-A adds the empty containers of the four optional secrets (readable by the runtime account) and
# the second service's runtime account, ums-offline, with four own empty containers it alone can read.
set -euo pipefail

die() {
  echo "setup: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || die "usage: setup.sh PROJECT_ID REGION"
PROJECT_ID="$1"
REGION="$2"
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "PROJECT_ID is not a Google Cloud project id"
[[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || die "REGION is not a region name such as europe-west1"
command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed"
command -v openssl >/dev/null 2>&1 || die "openssl is not installed"
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
[ -n "$ACTIVE_ACCOUNT" ] || die "gcloud has no active account; sign in first, then run this again"
unset ACTIVE_ACCOUNT

AR_REPO="unitmarket"
SQL_INSTANCE="unitmarket-sbx-pg"
SQL_TIER="db-g1-small"
SQL_DB="unitmarket"
SQL_USER="ums_app"
RUNTIME_SA_NAME="ums-runtime"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
# DATABASE_URL is made below. The rest get their value from set-secret.sh.
SECRET_NAMES="DATABASE_URL PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_WEBHOOK_ID UMS_OUTBOUND_APPROVAL_REF UMS_SESSION_SECRET UMS_APPROVAL_SECRET UMS_LINK_SECRET UMS_DEMO_PASSCODE_HASH UMS_OWN_MERCHANT_ID UMS_OPERATOR_TOTP_KEYS"
# Optional: a name with no value leaves its feature off (deploy.sh).
OPTIONAL_SECRET_NAMES="UMS_PUBLISHER_PASSCODE_HASH UMS_OFFER_MAX_MINOR UMS_AI_ADAPTER UMS_ANTHROPIC_API_KEY"
# The second service (deploy-offline.sh) has its own account and its own four secrets, no payment secret.
OFFLINE_SA_NAME="ums-offline"
OFFLINE_SA="ums-offline@${PROJECT_ID}.iam.gserviceaccount.com"
OFFLINE_SECRET_NAMES="UMS_OFFLINE_SESSION_SECRET UMS_OFFLINE_APPROVAL_SECRET UMS_OFFLINE_LINK_SECRET UMS_OFFLINE_DEMO_PASSCODE_HASH"

echo "== billing"
BILLING_ENABLED="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || true)"
[ "$BILLING_ENABLED" = "True" ] || die "billing is not linked to this project; link it in the console, then run this again"

echo "== APIs"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  monitoring.googleapis.com \
  --project="$PROJECT_ID"

echo "== Artifact Registry repository $AR_REPO"
if gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "kept $AR_REPO"
else
  gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="UnitMarket sandbox images" \
    --project="$PROJECT_ID" >/dev/null
  echo "created $AR_REPO"
fi

echo "== runtime service account $RUNTIME_SA_NAME"
if gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "kept $RUNTIME_SA_NAME"
else
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --display-name="UnitMarket runtime" \
    --project="$PROJECT_ID" >/dev/null
  echo "created $RUNTIME_SA_NAME"
fi
# A new service account can take a few seconds to be visible to the IAM calls below.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then break; fi
  sleep 3
done

echo "== roles for the runtime service account"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/cloudsql.client" \
  --condition=None >/dev/null
echo "bound roles/cloudsql.client"

echo "== secret containers (no values yet)"
for NAME in $SECRET_NAMES; do
  if ! gcloud secrets describe "$NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$NAME" --replication-policy=automatic --project="$PROJECT_ID" >/dev/null
    echo "created $NAME"
  else
    echo "kept $NAME"
  fi
  gcloud secrets add-iam-policy-binding "$NAME" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" >/dev/null
done

echo "== optional secret containers (no values yet)"
for NAME in $OPTIONAL_SECRET_NAMES; do
  if ! gcloud secrets describe "$NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$NAME" --replication-policy=automatic --project="$PROJECT_ID" >/dev/null
    echo "created $NAME"
  else
    echo "kept $NAME"
  fi
  gcloud secrets add-iam-policy-binding "$NAME" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" >/dev/null
done

echo "== runtime service account $OFFLINE_SA_NAME (second service)"
if gcloud iam service-accounts describe "$OFFLINE_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "kept $OFFLINE_SA_NAME"
else
  gcloud iam service-accounts create "$OFFLINE_SA_NAME" \
    --display-name="UnitMarket offline service" \
    --project="$PROJECT_ID" >/dev/null
  echo "created $OFFLINE_SA_NAME"
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if gcloud iam service-accounts describe "$OFFLINE_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then break; fi
  sleep 3
done

echo "== offline secret containers (no values yet)"
for NAME in $OFFLINE_SECRET_NAMES; do
  if ! gcloud secrets describe "$NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$NAME" --replication-policy=automatic --project="$PROJECT_ID" >/dev/null
    echo "created $NAME"
  else
    echo "kept $NAME"
  fi
  gcloud secrets add-iam-policy-binding "$NAME" \
    --member="serviceAccount:${OFFLINE_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" >/dev/null
done

echo "== Cloud SQL instance $SQL_INSTANCE (this can take 10 minutes)"
if gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "kept $SQL_INSTANCE"
else
  # No authorized networks, and connector enforcement REQUIRED: only Google's connector (Cloud Run's
  # built-in one) or the Auth Proxy can connect. "gcloud beta" because the storage limit flag is
  # not in the general availability command (checked with --help). The limit is in GB.
  gcloud beta sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_16 \
    --edition=ENTERPRISE \
    --tier="$SQL_TIER" \
    --region="$REGION" \
    --availability-type=zonal \
    --storage-type=SSD \
    --storage-size=10GB \
    --storage-auto-increase \
    --storage-auto-increase-limit=30 \
    --backup \
    --backup-start-time=03:00 \
    --retained-backups-count=7 \
    --enable-point-in-time-recovery \
    --retained-transaction-log-days=7 \
    --deletion-protection \
    --ssl-mode=ENCRYPTED_ONLY \
    --connector-enforcement=REQUIRED \
    --project="$PROJECT_ID" >/dev/null
  echo "created $SQL_INSTANCE"
fi

echo "== database $SQL_DB"
if gcloud sql databases describe "$SQL_DB" --instance="$SQL_INSTANCE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "kept $SQL_DB"
else
  gcloud sql databases create "$SQL_DB" --instance="$SQL_INSTANCE" --project="$PROJECT_ID" >/dev/null
  echo "created $SQL_DB"
fi

echo "== database user and the DATABASE_URL secret"
HAS_VERSION="$(gcloud secrets versions list DATABASE_URL --filter='state=ENABLED' --limit=1 --format='value(name)' --project="$PROJECT_ID")"
if [ -n "$HAS_VERSION" ]; then
  echo "kept DATABASE_URL (it has a version; the password is not changed)"
else
  DB_PASSWORD="$(openssl rand -hex 24)"
  HAS_USER="$(gcloud sql users list --instance="$SQL_INSTANCE" --filter="name=${SQL_USER}" --format='value(name)' --project="$PROJECT_ID")"
  if [ -n "$HAS_USER" ]; then
    CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1 gcloud sql users set-password "$SQL_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD" --project="$PROJECT_ID" >/dev/null
  else
    CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1 gcloud sql users create "$SQL_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD" --project="$PROJECT_ID" >/dev/null
  fi
  printf 'postgres://%s:%s@/%s?host=/cloudsql/%s:%s:%s' "$SQL_USER" "$DB_PASSWORD" "$SQL_DB" "$PROJECT_ID" "$REGION" "$SQL_INSTANCE" |
    gcloud secrets versions add DATABASE_URL --data-file=- --project="$PROJECT_ID" >/dev/null
  unset DB_PASSWORD
  echo "stored a new version of DATABASE_URL (value not shown)"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
echo
echo "setup done. Non-secret facts you may paste back:"
echo "  region:            $REGION"
echo "  sql connection:    ${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
echo "  runtime account:   $RUNTIME_SA_NAME"
echo "  image repository:  ${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
echo "  expected service URL (UNVERIFIED form): https://unitmarket-sandbox-${PROJECT_NUMBER}.${REGION}.run.app"
echo "Next: run set-secret.sh once for every required name except DATABASE_URL. The optional names and the"
echo "UMS_OFFLINE_* names are set only when you want that feature or the second service."
