# Use Node.js LTS as base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set pnpm home and path for global packages
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Install pnpm
RUN npm install -g pnpm@10.33.0

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./

# Copy entire packages directory
COPY packages ./packages

# Install dependencies
RUN pnpm install --no-frozen-lockfile

# Build the project
RUN pnpm build

# Make the CLI available globally
WORKDIR /app/packages/cli
RUN pnpm link --global

# Set the working directory back to /app
WORKDIR /app

# Set the entrypoint to sh for normal Linux shell access (Alpine uses sh)
ENTRYPOINT ["/bin/sh"]
