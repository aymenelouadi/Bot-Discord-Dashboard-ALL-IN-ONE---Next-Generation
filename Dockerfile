# ─────────────────────────────────────────────────────────────────────
# Bot Discord Dashboard ALL-IN-ONE — Dockerfile
# This project was programmed by the Next Generation team.
# https://discord.gg/BhJStSa89s
# ─────────────────────────────────────────────────────────────────────

FROM node:20-alpine

# Metadata
LABEL maintainer="Next Generation Team <https://discord.gg/BhJStSa89s>"
LABEL version="5.7.0"
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
