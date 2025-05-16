FROM node:20
WORKDIR /app
COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json
RUN npm ci
COPY src/ /app/src
CMD ["npm","start"]
