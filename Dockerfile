# ---- builder: install deps (incl. native builds) and build frontend ----
FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The workspace package manifest must be present before `npm ci` so npm can set
# up the `@carelane/core` workspace symlink.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
# The @carelane/core workspace: node_modules/@carelane/core is a symlink into
# ./packages/core, so the package tree must be present in the runtime image too.
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./
RUN mkdir -p /app/data /app/uploads
EXPOSE 3778
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3778)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
