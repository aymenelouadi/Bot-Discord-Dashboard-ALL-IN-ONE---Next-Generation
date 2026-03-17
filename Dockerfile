# ─────────────────────────────────────────────────────────────────────
# Bot Discord Dashboard ALL-IN-ONE — Dockerfile
# This project was programmed by the Code Nexus team.
# https://discord.gg/UvEYbFd2rj
# ─────────────────────────────────────────────────────────────────────

FROM node:20-alpine

# Metadata
LABEL maintainer="Code Nexus Team <https://discord.gg/UvEYbFd2rj>"
LABEL version="5.1.1"
LABEL description="Discord Bot Dashboard ALL-IN-ONE — Next Generation"

# Create app directory
WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Make sure database directory exists
RUN mkdir -p database

# Expose dashboard port (default 2000)
EXPOSE 2000

# Default command — starts the bot (which also boots the dashboard)
CMD ["node", "index.js"]
