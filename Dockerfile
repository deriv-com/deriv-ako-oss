# The Slack bot, `ako serve`, as a container.
#
# The image holds no secrets and no team settings: .env is passed as
# environment variables and release-flow.yaml is mounted into /config at run
# time (see docker-compose.yml). Keep the Node version on the FROM line, not
# behind an ARG, so image scanners can read it.
FROM node:22.23.5-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY manifests ./manifests
COPY LICENSE THIRD_PARTY_NOTICES.md ./

# AKO reads release-flow.yaml (and .env, if present) from the folder it runs in.
WORKDIR /config
USER node
CMD ["node", "/app/bin/ako.js", "serve"]
