#!/usr/bin/env bash
# deploy-offline.sh PROJECT_ID REGION TAG   (INFRA-A, D-049)
#
# Prepared for the judges, never run by an agent. Builds the image for the reviewed git tag TAG (the
# same image deploy.sh uses; an image that already exists is kept) and deploys it as a SECOND Cloud Run
# service, unitmarket-offline, in offline mode: in-memory data, no PayPal, no database, no payment
# secret, labelled Dry run from the stored data. A judge can always finish a purchase there, with no
# approval row, because nothing leaves the service. Manual only, in Cloud Shell, in a checkout of TAG,
# after setup.sh and after set-secret.sh for each of the five own secrets below.
#
# The data lives in memory: a restart or a new revision starts again from the seed. The service is one
# instance, always (min 1, max 1, CPU always allocated), so the memory is not split over instances.
# Its own runtime account (ums-offline) can read only the five own secrets. The fixed values come from
# service-offline.yaml, where UMS_PAYPAL_CONNECT is off.
#
# The five secrets are UMS_OFFLINE_SESSION_SECRET, UMS_OFFLINE_APPROVAL_SECRET, UMS_OFFLINE_LINK_SECRET,
# UMS_OFFLINE_DEMO_PASSCODE_HASH and UMS_OFFLINE_JUDGE_PASSCODE_HASH (HARD-OFFLINE). Each is mapped to the
# env name without OFFLINE_, which is the name the app reads. They are separate from the sandbox service's
# secrets on purpose: a session cookie signed on one service must not be valid on the other.
#
# Two passcode hashes, two passcodes. The judge hash is the one judges are told: it signs in the buyer
# personas only. The demo hash is the app's demo hash (the app needs it for any sign in) and belongs to
# a separate long random passcode that only the owners keep: it also opens the operator persona, so it
# is never given to a judge. The app refuses to boot when the two hashes are equal.
set -euo pipefail

die() {
  echo "deploy-offline: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || die "usage: deploy-offline.sh PROJECT_ID REGION TAG"
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
SERVICE="unitmarket-offline"
IMAGE_NAME="unitmarket-sandbox"
AR_REPO="unitmarket"
OFFLINE_SA="ums-offline@${PROJECT_ID}.iam.gserviceaccount.com"
OFFLINE_SECRET_NAMES="UMS_OFFLINE_SESSION_SECRET UMS_OFFLINE_APPROVAL_SECRET UMS_OFFLINE_LINK_SECRET UMS_OFFLINE_DEMO_PASSCODE_HASH UMS_OFFLINE_JUDGE_PASSCODE_HASH"

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
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${IMAGE_NAME}:${TAG}-${COMMIT}"

echo "== each of the five own secrets needs a value"
MISSING=""
for NAME in $OFFLINE_SECRET_NAMES; do
  HAS_VERSION="$(gcloud secrets versions list "$NAME" --filter='state=ENABLED' --limit=1 --format='value(name)' --project="$PROJECT_ID" 2>/dev/null || true)"
  [ -n "$HAS_VERSION" ] || MISSING="${MISSING} ${NAME}"
done
[ -z "$MISSING" ] || die "no value yet for:${MISSING}. Run setup.sh and set-secret.sh first"

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

# NAME is UMS_OFFLINE_<REST>; the env name the app reads is UMS_<REST>.
SECRET_FLAGS=""
for NAME in $OFFLINE_SECRET_NAMES; do
  SECRET_FLAGS="${SECRET_FLAGS:+${SECRET_FLAGS},}UMS_${NAME#UMS_OFFLINE_}=${NAME}:latest"
done

echo "== deploy $SERVICE (offline mode, one instance, CPU always allocated, public ingress, no database)"
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --service-account="$OFFLINE_SA" \
  --env-vars-file="${HERE}/service-offline.yaml" \
  --set-secrets="$SECRET_FLAGS" \
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
if ! grep -qxF "UMS_PUBLIC_ORIGIN: '${SERVICE_URL}'" "${HERE}/service-offline.yaml"; then
  echo "NOTE: UMS_PUBLIC_ORIGIN in service-offline.yaml is not this URL. Browser sign-in is refused until a"
  echo "reviewed change sets it to the URL above and you deploy the new tag."
fi
