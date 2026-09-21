# One image per service, as a fleet is deployed. tsx runs the TypeScript directly: these services are small and the
# build step a bundler would add buys nothing here.
FROM node:24-alpine

WORKDIR /app
# the workspace manifests first, so a change to source does not reinstall the world
COPY package.json package-lock.json ./
COPY packages/service-kit/package.json packages/service-kit/
COPY services/documents/package.json services/documents/
RUN npm ci --omit=dev --workspace @apps/documents --include-workspace-root

COPY packages/service-kit packages/service-kit
COPY services/documents services/documents

ENV NODE_ENV=production
# the volume the bytes live on; the row only ever carries their URL
VOLUME /var/lib/documents
EXPOSE 4000
# PID 1 in a container receives SIGTERM directly, which is what the drain is wired to
CMD ["npx", "tsx", "services/documents/src/main.ts"]
