# One image per service, as a fleet is deployed. tsx runs the TypeScript directly: these services are small and the
# build step a bundler would add buys nothing here. This one is a Hono app on Node; the same app would run on Workers,
# Bun or Deno, but the fleet deploys containers, so it is a container like the others.
FROM node:24-alpine

WORKDIR /app
# the workspace manifests first, so a change to source does not reinstall the world
COPY package.json package-lock.json ./
COPY packages/service-kit/package.json packages/service-kit/
COPY services/feedback/package.json services/feedback/
RUN npm ci --omit=dev --workspace @apps/feedback --include-workspace-root

COPY packages/service-kit packages/service-kit
COPY services/feedback services/feedback

ENV NODE_ENV=production
EXPOSE 4000
# PID 1 in a container receives SIGTERM directly, which is what the drain is wired to
CMD ["npx", "tsx", "services/feedback/src/main.ts"]
