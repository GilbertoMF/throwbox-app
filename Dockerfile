# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy source code
COPY . .

# Build frontend and backend
RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Copy production dependencies
COPY package.json ./
RUN npm install --production

# Copy built frontend assets and backend bundle
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist-server/index.js"]
