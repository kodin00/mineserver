FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/web/package.json apps/web/tsconfig*.json apps/web/vite.config.ts ./apps/web/
RUN npm install
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN npm run build -w @mineserver/shared && npm run build -w @mineserver/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
