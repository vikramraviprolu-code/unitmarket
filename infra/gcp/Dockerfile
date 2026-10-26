# Container image for the Cloud Run service (GCP-1, D-049). Built by Cloud Build from the repository
# root: docker build -f infra/gcp/Dockerfile .   No secret is read, copied or baked in: every value
# arrives at run time from service.yaml (fixed values) and Secret Manager (secrets).
# Stage 1 builds the app. Local env files, node_modules and .git are removed first; this stage is
# not shipped, so even a stray file copied by "COPY . ." cannot reach the final image.
FROM node:22.22.0-bookworm-slim AS build
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

# Stage 2 is the image that runs: the built tree, as the non-root user "node".
FROM node:22.22.0-bookworm-slim
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
