# syntax=docker/dockerfile:1
#
# Live Futures Liquidity Dashboard — dashboard frontend image, built from the repository root because it is a member of the pnpm
# workspace. Tracked by SemVer tags only (DEPLOYMENT.md, *Promotion flow*).
#   docker build -t dashboard:dev -f src/dashboard/Dockerfile .

FROM node:24-alpine AS build
# Corepack runs the pnpm version pinned in package.json's packageManager.
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY src/dashboard/package.json src/dashboard/
RUN pnpm install --frozen-lockfile --filter dashboard...
COPY src/dashboard/ src/dashboard/
RUN pnpm --filter dashboard run build

# Lint and any tests: `docker build --target test -f src/dashboard/Dockerfile .`
FROM build AS test
RUN pnpm --filter dashboard run lint && if grep -q '"test":' src/dashboard/package.json; then pnpm --filter dashboard run test; fi

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="dashboard" \
      org.opencontainers.image.source="https://github.com/MarqSpec/futures-liquidity-dashboard" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
# envsubst '${API_UPSTREAM}' at container start (10-api-upstream.sh). The template is not placed
# under /etc/nginx/templates, so the image entrypoint does not substitute every environment variable.
# API_UPSTREAM defaults to the compose DNS name; override it where that name does not resolve
# (Railway private networking). Same-origin proxy: no CORS headers.
COPY src/dashboard/nginx.conf.template /etc/nginx/default.conf.template
COPY src/dashboard/10-api-upstream.sh /docker-entrypoint.d/10-api-upstream.sh
ENV API_UPSTREAM=http://futuresliquiditydashboard.api:8080
COPY --from=build /repo/src/dashboard/dist /usr/share/nginx/html
# The unprivileged nginx image runs as a non-root user and listens on 8080.
EXPOSE 8080
