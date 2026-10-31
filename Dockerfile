# Web app (Next.js). See Dockerfile.worker for the separate background-job
# worker image (Python3/LibreOffice/poppler-utils, no Next.js build).

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, so
# this one must be the real publishable key (it's meant to be public).
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}

# Everything else below is a placeholder ONLY to satisfy the app's eager
# `if (!process.env.X) throw` checks (src/db/client.ts and friends) during
# Next's "collecting page data" step — no network calls happen at build
# time, and none of these values are used at runtime (real secrets are
# supplied to the container via `fly secrets set`, not baked into the image).
ENV DATABASE_URL="postgresql://build:build@localhost/build"
ENV QUEUE_DATABASE_URL="postgresql://build:build@localhost/build"
ENV ANTHROPIC_API_KEY="sk-ant-build-placeholder"
ENV CLERK_SECRET_KEY="sk_test_build_placeholder"
ENV CLERK_WEBHOOK_SECRET="whsec_build_placeholder"
ENV AWS_REGION="us-east-1"
ENV AWS_ACCESS_KEY_ID="build-placeholder"
ENV AWS_SECRET_ACCESS_KEY="build-placeholder"
ENV S3_DOCUMENTS_BUCKET="build-placeholder"

RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
