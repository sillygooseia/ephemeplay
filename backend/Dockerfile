FROM node:22-alpine

ARG NPM_TOKEN

WORKDIR /app

COPY package.json package-lock.json ./

# Configure private registry for @epheme scope, install, then scrub credentials
RUN echo "@epheme:registry=https://npm.sillygooseia.com" >> .npmrc && \
    echo "//npm.sillygooseia.com/:_authToken=${NPM_TOKEN}" >> .npmrc && \
    npm ci --omit=dev && \
    rm -f .npmrc

COPY . .

EXPOSE 8787

CMD ["node", "index.js"]
