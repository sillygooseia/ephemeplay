FROM node:22-alpine AS deps

ARG NPM_TOKEN

WORKDIR /app

COPY package.json package-lock.json ./

# Configure private registry for @epheme scope, install, then scrub credentials
RUN echo "@epheme:registry=https://npm.sillygooseia.com" >> .npmrc && \
    echo "//npm.sillygooseia.com/:_authToken=${NPM_TOKEN}" >> .npmrc && \
    npm ci --omit=dev && \
    rm -f .npmrc

# ── Final image — strip npm / corepack / C++ headers not needed at runtime ──
FROM node:22-alpine

WORKDIR /app

# Remove tooling that isn't needed to run a Node app
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /usr/local/include/node

COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 8787

CMD ["node", "index.js"]
