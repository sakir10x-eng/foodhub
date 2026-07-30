# syntax=docker/dockerfile:1
#
# One image, three services.
#
# The api / web / admin containers all run from this single image with different
# commands. On a small shared box that matters: three separate images would each repeat
# `npm ci` (the slowest step by far) and each carry their own copy of node_modules.
# One build, one layer cache, one thing to ship.

FROM node:22-alpine AS base
WORKDIR /app
# sharp's libvips bindings on musl; python3/make/g++ for any node-gyp fallback.
RUN apk add --no-cache libc6-compat vips-dev build-base python3 openssl

# ── dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/mapkit/package.json packages/mapkit/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm ci --workspaces --include-workspace-root --no-audit --no-fund

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build

# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so they must be
# build args — setting them at runtime does nothing. Empty NEXT_PUBLIC_API_URL means
# "call the same origin", which is what the edge is configured for.
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_MARKETPLACE_HOST
ARG NEXT_PUBLIC_PLATFORM_DOMAIN
ARG NEXT_PUBLIC_GOOGLE_MAPS_KEY=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_MARKETPLACE_HOST=$NEXT_PUBLIC_MARKETPLACE_HOST \
    NEXT_PUBLIC_PLATFORM_DOMAIN=$NEXT_PUBLIC_PLATFORM_DOMAIN \
    NEXT_PUBLIC_GOOGLE_MAPS_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_KEY \
    NEXT_TELEMETRY_DISABLED=1

COPY . .

# Shared first — both the API and the Next apps compile against its emitted types.
RUN npm run build -w @foodhub/shared \
 && npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w @foodhub/api \
 && npm run build -w @foodhub/web \
 && npm run build -w @foodhub/admin

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/

# Source-only: the Next apps transpile it into their own build output, but the workspace
# symlink in node_modules points here and a dangling link breaks module resolution.
COPY --from=build /app/packages/mapkit ./packages/mapkit

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/
# ts-node needs a tsconfig to run prisma/seed.ts; without one it picks incompatible
# module/moduleResolution defaults and refuses to compile.
COPY --from=build /app/apps/api/tsconfig.json ./apps/api/

COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/package.json ./apps/web/
COPY --from=build /app/apps/web/next.config.mjs ./apps/web/

COPY --from=build /app/apps/admin/.next ./apps/admin/.next
COPY --from=build /app/apps/admin/package.json ./apps/admin/
COPY --from=build /app/apps/admin/next.config.mjs ./apps/admin/

# Uploaded media lives on a volume mounted here.
RUN mkdir -p /app/apps/api/storage/media

EXPOSE 3000 3001 4000
# Overridden per service in the compose file.
CMD ["node", "apps/api/dist/main.js"]
