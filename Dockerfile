FROM node:26-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN rm -f .env && chmod +x /app/docker/start.sh && chown -R node:node /app

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${UI_PORT:-8787}/healthz >/dev/null || exit 1

CMD ["/app/docker/start.sh"]
