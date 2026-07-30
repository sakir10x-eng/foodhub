# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
# sharp needs these for its libvips bindings on musl.
RUN apk add --no-cache libc6-compat vips-dev build-base python3

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm ci --workspaces --include-workspace-root

FROM deps AS build
COPY . .
RUN npm run build -w @foodhub/shared \
  && npx prisma generate --schema apps/api/prisma/schema.prisma \
  && npm run build -w @foodhub/api

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/
WORKDIR /app/apps/api
EXPOSE 4000
# Migrations run on boot so a deploy is a single unit; `migrate deploy` is a no-op once current.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
