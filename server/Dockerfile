FROM node:22-bookworm-slim

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium

COPY index.mjs ./

ENV PORT=8787
EXPOSE 8787
CMD ["node", "index.mjs"]
