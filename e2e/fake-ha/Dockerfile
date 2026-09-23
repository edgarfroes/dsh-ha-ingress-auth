FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
WORKDIR /fake-ha
RUN npm init -y >/dev/null && npm install --no-audit --no-fund ws@8.21.3
COPY server.js ./
CMD ["node", "server.js"]
