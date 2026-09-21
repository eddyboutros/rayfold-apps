# One image per service, as a fleet is deployed. tsx runs the TypeScript directly: these services are small and the
# build step a bundler would add buys nothing here.
FROM node:24-alpine

WORKDIR /app
# the workspace manifests first, so a change to source does not reinstall the world
COPY package.json package-lock.json ./
COPY packages/service-kit/package.json packages/service-kit/
COPY services/workspace/package.json services/workspace/
RUN npm ci --omit=dev --workspace @apps/workspace --include-workspace-root

COPY packages/service-kit packages/service-kit
COPY services/workspace services/workspace

ENV NODE_ENV=production
EXPOSE 4000
# PID 1 in a container receives SIGTERM directly, which is what the drain is wired to
CMD ["npx", "tsx", "services/workspace/src/main.ts"]
