# DeepSeek Harness as a Home Assistant app, with Home Assistant users and roles.
#
# Debian (glibc) Node: dsh's native addon ships linux-x64-gnu and
# linux-arm64-gnu builds only. Pinned by exact version and digest.
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

ARG BUILD_VERSION=dev
ARG BUILD_ARCH=amd64
LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="DeepSeek Harness for Home Assistant" \
  org.opencontainers.image.licenses="MIT"

# Tools admins' agents commonly use in a shell. Non-admins get no shell.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git procps \
  && rm -rf /var/lib/apt/lists/*

# Exact dsh version from a committed lockfile: never `latest`, never a range.
WORKDIR /opt/dsh-ha
COPY runtime/package.json runtime/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# The gateway and host plugin (copied in by `npm run app:context`).
COPY plugin/ /opt/dsh-ha/plugin/

ENV NODE_ENV=production
EXPOSE 8099
CMD ["node", "/opt/dsh-ha/plugin/src/gateway/cli.js", "--data", "/data", "--port", "8099"]
