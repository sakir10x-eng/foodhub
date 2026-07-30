# syntax=docker/dockerfile:1
# Builds either Next.js app; pass APP=web or APP=admin.
ARG APP=web

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm ci --workspaces --include-workspace-root

FROM deps AS build
ARG APP
COPY . .
RUN npm run build -w @foodhub/shared && npm run build -w @foodhub/${APP}

FROM base AS runtime
ARG APP
ENV NODE_ENV=production
ENV APP=${APP}
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/${APP} ./apps/${APP}
COPY --from=build /app/package.json ./package.json
WORKDIR /app
EXPOSE 3000 3001
CMD ["sh", "-c", "npm run start -w @foodhub/${APP}"]
