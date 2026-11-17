# Full node:20 image (buildpack-deps based) so better-sqlite3's native build
# always succeeds without extra apt steps.
FROM node:20

WORKDIR /app

# Install deps first for better layer caching.
COPY backend/package.json ./
RUN npm install --omit=dev

# Backend source (web/ and data/ are bind-mounted at runtime, not baked in).
COPY backend/ ./

ENV PORT=3000 \
    WEB_DIR=/web \
    DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]
