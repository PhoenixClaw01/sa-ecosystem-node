FROM node:22-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY hub ./hub
COPY node.config.example.json ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/hub ./hub
COPY --from=build --chown=node:node /app/node.config.example.json /app/node.config.json
COPY --chown=node:node dashboard/data/treasury-cache.json ./dashboard/data/treasury-cache.json
COPY --chown=node:node bin ./bin
ENV HOST=0.0.0.0
ENV PORT=8787
ENV PUBLIC_NODE=1
# Set ALLOWED_HOSTS to the hostname clients use, such as your-app.fly.dev, the Render host, or a LAN name.
# Startup exits until it is set.
# ALLOWED_HOSTS=your-app.fly.dev
ENV NODE_CONFIG=/app/node.config.json
USER node
EXPOSE 8787
CMD ["node", "dist/http.js"]
