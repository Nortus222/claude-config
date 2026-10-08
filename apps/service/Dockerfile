FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/service/package.json apps/service/package.json
COPY packages/hosted-protocol/package.json packages/hosted-protocol/package.json
RUN npm ci --omit=dev --workspace=apps/service --workspace=packages/hosted-protocol --ignore-scripts

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY apps/service/package.json apps/service/package.json
COPY apps/service/src apps/service/src
COPY packages/hosted-protocol/package.json packages/hosted-protocol/package.json
COPY packages/hosted-protocol/src packages/hosted-protocol/src
USER node
EXPOSE 8080
ENTRYPOINT ["node", "apps/service/src/main.ts"]
