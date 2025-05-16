FROM node:20
WORKDIR /app
COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json
RUN npm ci
COPY src/ /app/src
CMD ["npm","start"]
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 CMD curl -f http://localhost:${PORT}/.well-known/health || exit 1
