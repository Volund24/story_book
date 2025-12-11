# Build Stage
FROM node:20-alpine AS builder

# Install build dependencies for sqlite3
RUN apk add --no-cache python3 make g++ py3-setuptools

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src

RUN npm ci
RUN npm run build

# Production Stage
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# Create a volume for the sqlite database (if using sqlite)
VOLUME /app/data

# Environment variables should be passed in at runtime
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
