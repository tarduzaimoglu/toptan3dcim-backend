FROM node:22-bookworm-slim AS dependencies

WORKDIR /opt/app

COPY package.json package-lock.json ./
RUN npm ci


FROM node:22-bookworm-slim AS build

WORKDIR /opt/app

COPY --from=dependencies /opt/app/node_modules ./node_modules
COPY . .

# Strapi evaluates production configuration during the admin build. These
# non-secret placeholders satisfy validation without connecting to a database.
RUN NODE_ENV=production \
    DATABASE_CLIENT=postgres \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    npm run build && \
    npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1337 \
    TMPDIR=/opt/app/.tmp

WORKDIR /opt/app

COPY --from=build /opt/app/package.json /opt/app/package-lock.json ./
COPY --from=build /opt/app/node_modules ./node_modules
COPY --from=build /opt/app/dist/ ./
COPY --from=build /opt/app/public ./public
COPY --from=build /opt/app/favicon.png ./favicon.png

# Keep compiled application code immutable while granting the runtime user
# access only to Strapi's migration path and the WebP extension's temp path.
RUN mkdir -p /opt/app/database/migrations /opt/app/.tmp && \
    chown -R node:node /opt/app/database /opt/app/.tmp && \
    chmod 0755 /opt/app/database /opt/app/database/migrations /opt/app/.tmp

USER node

EXPOSE 1337

CMD ["npm", "run", "start"]
