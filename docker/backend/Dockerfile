FROM node:20

# We'll be running the app in /app
# Defined workdir inside the container during build AND runtime
WORKDIR /app

# Install dependencies (no dev) before copying application code
# Allows dependencies to be cached while application codes is updated
COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json
RUN npm ci

# Copy application code into the container
COPY src/ /app/src
# No build step required -- `npm run build` here if needed

# How to start the application
CMD ["npm","start"]

# Allow orchestrators to detect if the process has frozen or crashed
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 CMD curl -f http://localhost:${PORT}/.well-known/health || exit 1
