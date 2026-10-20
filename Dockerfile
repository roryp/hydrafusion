# The app, Google Chrome for the browser tools and the checks, and the Copilot runtime (from npm).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    BROWSER_NO_SANDBOX=1 \
    COPILOT_USE_LOGGED_IN_USER=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# Installing Chrome needs root. Chrome stable works with any recent Playwright.
RUN npx --yes playwright@1.64.0 install --with-deps chrome \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json .npmrc ./
COPY --chown=node:node scripts/public-lockfile.mjs scripts/
RUN node scripts/public-lockfile.mjs \
 && npm ci --omit=dev --no-audit \
 && npm cache clean --force

COPY --chown=node:node . .

EXPOSE 8080
CMD ["node", "src/server.mjs"]
