FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/pgdg.asc \
    && echo 'deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm build:api
ENV NODE_ENV=production
CMD ["sh", "-c", "pnpm db:deploy && pnpm start:api"]
