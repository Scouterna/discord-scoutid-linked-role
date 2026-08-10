# Dependencies are installed in a separate stage so that .npmrc — which may
# point at an internal registry and hold credentials for it — never becomes a
# layer in the published image.
FROM node:20-alpine AS deps

WORKDIR /app

# .npmrc is optional and gitignored: absent in a fresh clone, so installs go to
# registry.npmjs.org. Create one locally to use an internal npm proxy.
COPY package*.json .npmrc* ./

# `npm ci` is deterministic (installs exactly the lockfile), but it cannot be
# trusted to fail the build on its own: when a registry request breaks — e.g. a
# TLS-intercepting proxy — npm 10 can die with "Exit handler never called!" and
# still exit 0, leaving a half-written node_modules. `--no-audit --no-fund`
# removes two such requests, and the check below refuses to ship an image whose
# dependencies did not actually land.
RUN npm ci --omit=dev --no-audit --no-fund \
 && node -e "const fs=require('fs'),{dependencies={}}=require('./package.json');const missing=Object.keys(dependencies).filter(m=>!fs.existsSync('node_modules/'+m+'/package.json'));if(missing.length){console.error('npm ci left dependencies missing: '+missing.join(', '));process.exit(1)}"

FROM node:20-alpine

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

EXPOSE 3000

CMD ["npm", "start"]
