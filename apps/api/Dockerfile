FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
RUN npm install
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN npm run build -w @mineserver/shared && npm run build -w @mineserver/api

FROM docker:27-cli AS docker-cli

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# ca-certificates ships with the node:bookworm-slim base image, and tar/gzip
# are part of the base Debian system, so no apt-get step (which requires
# network access at build time) is needed here.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
