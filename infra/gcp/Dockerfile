# Container image for the Cloud Run service (GCP-1, D-049). Built by Cloud Build from the repository
# root: docker build -f infra/gcp/Dockerfile .   No secret is read, copied or baked in: every value
# arrives at run time from service.yaml (fixed values) and Secret Manager (secrets).
# Both stages start from the same base image, pinned by digest (GCP-2): a moved tag cannot change the
# image under a reviewed tag. To move it, take the digest of the new node:22.22.0-bookworm-slim from
# a build log, change both FROM lines, and have the change reviewed.
# Stage 1 builds the app. Local env files, node_modules and .git are removed first, so that a stray
# file copied by "COPY . ." is gone before the build. Stage 1 is not shipped itself, but stage 2 copies
# its whole /app tree (sources, node_modules and build output), so this cleaning step is what keeps
# env files out of the final image.
# Both stages must keep WORKDIR /app: the migrations path is resolved at build time, so the final
# image must hold the tree at the same absolute path as the build stage.
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS build
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.34.7 --activate
WORKDIR /app
COPY . .
RUN rm -rf .git \
    && find . -name node_modules -prune -exec rm -rf {} + \
    && find . -type f \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' -delete
RUN corepack pnpm install --frozen-lockfile \
    && corepack pnpm --filter @umsbx/web build

# Stage 2 is the image that runs: the whole built tree of stage 1, as the non-root user "node".
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY --from=build /opt/corepack /opt/corepack
RUN corepack enable
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["corepack", "pnpm", "--filter", "@umsbx/web", "start"]
