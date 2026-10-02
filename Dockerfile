# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts=false
COPY next.config.ts next-env.d.ts tsconfig.json ./
COPY public ./public
COPY src ./src
COPY scripts ./scripts
ENV NEXT_TELEMETRY_DISABLED=1 \
    APP_ORIGIN=https://glance.devve.space \
    DEMO_MODE=false
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app /app/data
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
# The TypeScript worker requires tsx and its source imports at runtime.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/tsconfig.json /app/next.config.ts /app/next-env.d.ts ./
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
