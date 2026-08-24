FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && chown -R node:node /ms-playwright

COPY db ./db
COPY lib ./lib
COPY worker/sankhya ./worker/sankhya

USER node
EXPOSE 8080
CMD ["npx", "tsx", "worker/sankhya/index.ts"]
