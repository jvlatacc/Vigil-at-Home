# The relay ships as one bundled file on node:22-slim (the repo's .nvmrc Node).
# The build stage needs the pnpm workspace (the relay imports @vigil/core
# sources); the runtime stage runs the standalone bundle alone.
#
# Build from the repository root (the context is the whole monorepo):
#   docker build -f apps/relay/Dockerfile -t vigil-relay .
FROM node:22-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY . .
# --ignore-scripts skips the desktop app's postinstall; the relay build only
# needs the workspace sources and esbuild.
RUN corepack enable pnpm \
  && ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm --filter @vigil/relay build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production RELAY_DATA_DIR=/data
# Telemetry and token hashes live under the volume; owned by the unprivileged
# user the container runs as.
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/apps/relay/build/relay.mjs /app/relay.mjs
USER node
VOLUME /data
EXPOSE 8443
# /healthz is unauthenticated and data-free by design.
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8443)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/relay.mjs"]
CMD ["serve"]
