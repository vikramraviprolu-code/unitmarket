#!/usr/bin/env bash
# deploy.sh PROJECT_ID REGION TAG   (GCP-1, D-049)
#
# Builds the image for the reviewed git tag TAG with Cloud Build and deploys it to Cloud Run. Manual
# only: nothing here is wired to a trigger, and no deploy starts from a Git push (RLR-1). Run it yourself
# in Cloud Shell, in a checkout of TAG, after setup.sh and after set-secret.sh for every secret.
#
# The service is one instance, always: min 1, max 1, CPU always allocated, because the job loop runs
# inside the app (D-049). Ingress is public because PayPal's webhooks must reach it; the app verifies
# every delivery itself. Secrets are mapped from Secret Manager by name. Fixed values come from
# service.yaml. UMS_PAYPAL_CONNECT is off in that file, so a deploy always leaves the connection off.
# The image is tagged TAG-COMMIT (the first 12 characters of the commit id), so a moved git tag builds a new
# image and never reuses an old one.
#
# Optional secrets (INFRA-A): UMS_PUBLISHER_PASSCODE_HASH, UMS_OFFER_MAX_MINOR, UMS_AI_ADAPTER and
# UMS_ANTHROPIC_API_KEY are mapped only when they have an enabled version. A secret with no value leaves
# its feature off and never stops the deploy. The adapter name is left out when the API key has no value,
# because the app refuses to start on the Claude adapter without a key. This script reads no value.
set -euo pipefail

die() {
  echo "deploy: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || die "usage: deploy.sh PROJECT_ID REGION TAG"
PROJECT_ID="$1"
REGION="$2"
TAG="$3"
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "PROJECT_ID is not a Google Cloud project id"
[[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || die "REGION is not a region name such as europe-west1"
[[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] || die "TAG is not a plain git tag name"
command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed"
command -v git >/dev/null 2>&1 || die "git is not installed"
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
[ -n "$ACTIVE_ACCOUNT" ] || die "gcloud has no active account; sign in first, then run this again"
unset ACTIVE_ACCOUNT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
SERVICE="unitmarket-sandbox"
AR_REPO="unitmarket"
SQL_INSTANCE="unitmarket-sbx-pg"
RUNTIME_SA="ums-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
CONNECTION="${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
SECRET_NAMES="DATABASE_URL PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_WEBHOOK_ID UMS_OUTBOUND_APPROVAL_REF UMS_SESSION_SECRET UMS_APPROVAL_SECRET UMS_LINK_SECRET UMS_DEMO_PASSCODE_HASH UMS_OWN_MERCHANT_ID UMS_OPERATOR_TOTP_KEYS"
OPTIONAL_SECRET_NAMES="UMS_PUBLISHER_PASSCODE_HASH UMS_OFFER_MAX_MINOR UMS_AI_ADAPTER UMS_ANTHROPIC_API_KEY"

# 0 when the named secret has an enabled version. A missing secret or a failed lookup counts as no value.
has_secret_value() {
  local found
  found="$(gcloud secrets versions list "$1" --filter='state=ENABLED' --limit=1 --format='value(name)' --project="$PROJECT_ID" 2>/dev/null || true)"
  [ -n "$found" ]
}

echo "== the checkout must be exactly the reviewed tag $TAG"
cd "$REPO_ROOT"
TAG_COMMIT="$(git rev-parse --verify "refs/tags/${TAG}^{commit}" 2>/dev/null || true)"
[ -n "$TAG_COMMIT" ] || die "no git tag $TAG here; fetch tags and check it out"
[ "$TAG_COMMIT" = "$(git rev-parse HEAD)" ] || die "HEAD is not the tag $TAG; check it out first"
[ -z "$(git status --porcelain)" ] || die "the working tree differs from the tag; deploy from a clean checkout"
# The image tag carries the commit as well as the tag name, so a git tag that was moved can never
# reuse an image built from another commit.
COMMIT="${TAG_COMMIT:0:12}"
[[ "$COMMIT" =~ ^[0-9a-f]{12}$ ]] || die "could not read the commit id of $TAG"
unset TAG_COMMIT
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE}:${TAG}-${COMMIT}"

echo "== every secret needs a value"
MISSING=""
for NAME in $SECRET_NAMES; do
  HAS_VERSION="$(gcloud secrets versions list "$NAME" --filter='state=ENABLED' --limit=1 --format='value(name)' --project="$PROJECT_ID" 2>/dev/null || true)"
  [ -n "$HAS_VERSION" ] || MISSING="${MISSING} ${NAME}"
done
[ -z "$MISSING" ] || die "no value yet for:${MISSING}. Run setup.sh and set-secret.sh first"

echo "== optional secrets (no value means the feature stays off)"
OPTIONAL_ON=""
for NAME in $OPTIONAL_SECRET_NAMES; do
  if has_secret_value "$NAME"; then
    OPTIONAL_ON="${OPTIONAL_ON} ${NAME}"
    echo "on: ${NAME}"
  else
    echo "off: ${NAME} has no value"
  fi
done
if [[ " ${OPTIONAL_ON} " == *" UMS_AI_ADAPTER "* && " ${OPTIONAL_ON} " != *" UMS_ANTHROPIC_API_KEY "* ]]; then
  OPTIONAL_ON="${OPTIONAL_ON/ UMS_AI_ADAPTER/}"
  echo "off: UMS_AI_ADAPTER is left out because UMS_ANTHROPIC_API_KEY has no value"
fi

echo "== the database instance must be running"
SQL_STATE="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(state)' --project="$PROJECT_ID" 2>/dev/null || true)"
[ "$SQL_STATE" = "RUNNABLE" ] || die "the Cloud SQL instance is not running (state: ${SQL_STATE:-missing}); run setup.sh"

echo "== image $IMAGE"
if gcloud artifacts docker images describe "$IMAGE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "kept the image already built for $TAG at $COMMIT"
else
  BUILD_CONFIG="$(mktemp)"
  trap 'rm -f "$BUILD_CONFIG"' EXIT
  cat >"$BUILD_CONFIG" <<CONFIG
steps:
  - name: gcr.io/cloud-builders/docker
    args: ["build", "-f", "infra/gcp/Dockerfile", "-t", "${IMAGE}", "."]
images:
  - "${IMAGE}"
CONFIG
  gcloud builds submit "$REPO_ROOT" --config="$BUILD_CONFIG" --project="$PROJECT_ID"
fi

SECRET_FLAGS=""
for NAME in $SECRET_NAMES; do
  SECRET_FLAGS="${SECRET_FLAGS:+${SECRET_FLAGS},}${NAME}=${NAME}:latest"
done
for NAME in $OPTIONAL_ON; do
  SECRET_FLAGS="${SECRET_FLAGS},${NAME}=${NAME}:latest"
done

echo "== deploy $SERVICE (one instance, CPU always allocated, public ingress)"
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$RUNTIME_SA" \
  --env-vars-file="${HERE}/service.yaml" \
  --set-secrets="$SECRET_FLAGS" \
  --add-cloudsql-instances="$CONNECTION" \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --cpu=1 \
  --memory=2Gi \
  --concurrency=20 \
  --timeout=60 \
  --port=8080 \
  --ingress=all \
  --allow-unauthenticated \
  --startup-probe=httpGet.path=/healthz,httpGet.port=8080,initialDelaySeconds=5,timeoutSeconds=5,periodSeconds=5,failureThreshold=24

SERVICE_URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
echo
echo "deployed $SERVICE from tag $TAG at commit $COMMIT"
echo "service URL: $SERVICE_URL"
if ! grep -qxF "UMS_PUBLIC_ORIGIN: '${SERVICE_URL}'" "${HERE}/service.yaml"; then
  echo "NOTE: UMS_PUBLIC_ORIGIN in service.yaml is not this URL. Browser sign-in is refused until a reviewed"
  echo "change sets it to the URL above and you deploy the new tag."
fi
