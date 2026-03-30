FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S ombot && adduser -S ombot -G ombot
COPY --from=base /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /var/lib/ombot && chown -R ombot:ombot /app /var/lib/ombot
USER ombot

EXPOSE 8082 8083
ENV PORT=8082
ENV HEALTH_PORT=8083
ENV OPENCLAW_DATA_DIR=/var/lib/ombot
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- "http://127.0.0.1:${HEALTH_PORT}/healthz" || exit 1

CMD ["node", "index.js"]
