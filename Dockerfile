# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm@10.33.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY packages ./packages

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

# Isolate the CLI package and its production dependencies
RUN pnpm deploy --legacy --filter=./packages/cli --prod /app/pruned

# Stage 2: Runner
FROM node:20-alpine AS runner

WORKDIR /app

# Copy only the pruned production files from the builder
COPY --from=builder /app/pruned ./

RUN rm -rf /app/src

# Install the CLI globally using npm
RUN npm install -g .

# Set the entrypoint to sh for normal Linux shell access (Alpine uses sh)
ENTRYPOINT ["/bin/sh"]
