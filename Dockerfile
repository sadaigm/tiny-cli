# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm@10.33.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Isolate the CLI package and its production dependencies
RUN pnpm deploy --legacy --filter=./packages/cli --prod /app/pruned

# Stage 2: Runner — Bun runtime (required by OpenTUI)
FROM oven/bun:1-slim AS runner

WORKDIR /app

# OpenTUI text rendering needs fontconfig and at least one font
RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Copy only the pruned production files from the builder
COPY --from=builder /app/pruned ./

RUN rm -rf /app/src

# Install the CLI globally using bun (bin entries: tiny / tiny-cli)
RUN bun link

# Shell access; run the CLI with `tiny` or `bun /app/dist/index.js`
ENTRYPOINT ["/bin/bash"]
