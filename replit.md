# GEMS Video AI

## Overview
GEMS Video AI is a full-stack AI SaaS platform designed for generating ultra-realistic cinematic videos from various inputs like stories, scripts, or images. It supports video lengths from 10 seconds to 3 hours and offers seven distinct video styles. The platform aims to revolutionize video content creation by making high-quality, AI-generated cinematic videos accessible, incorporating advanced AI for deep analysis, production planning, and a sophisticated pronunciation system. The project emphasizes a pnpm monorepo architecture, robust user management, real-time analytics, and an integrated ad system.

## User Preferences
I want iterative development. I prefer detailed explanations. Ask before making major changes. Do not make changes to the `artifacts/api-server/src/lib/pronunciation-engine.ts` file. Do not make changes to the folder `lib/integrations-openai-ai-server/`.

## System Architecture

### UI/UX Decisions
The frontend utilizes React, Vite, Tailwind CSS, Framer Motion, and shadcn/ui for a modern and responsive user interface, with Wouter for routing. Key UI elements include a user profile dashboard with tabs for profile, video history, and subscriptions, and an admin panel for platform management (Users, Videos, Languages, Ads, Analytics, System). The design incorporates status badges, progress bars, real-time data displays, and non-intrusive ad placements. A comprehensive character studio allows users to create character profiles with face angles and voice samples. An interactive Cinema Output card is present on the New Video form, and marketing asset generation is available on the video detail page.

### Technical Implementations
The platform is built on a pnpm monorepo using Node.js 24 and TypeScript 5.9. The backend is powered by Express 5, using PostgreSQL and Drizzle ORM for data persistence. Zod handles schema validation. Authentication is JWT-based with role-based access control (user, admin, super_admin). API codegen is handled by Orval from an OpenAPI specification, and esbuild is used for the build process. A production-grade security layer includes Helmet HTTP headers, tiered rate limiting, anti-bot middleware, JWT algorithm pinning, and an OpenAI Moderation API hook for video creation prompts.

### Feature Specifications
- **Video Generation**: Creates cinematic videos with customizable styles and durations from various inputs.
- **Role-Based Access Control (RBAC)**: Granular permissions for user roles.
- **Authentication**: JWT-based with token storage in `localStorage`.
- **User Management**: Admin panel for managing user statuses and a user profile dashboard.
- **Real-time Analytics**: Dashboards for platform statistics, user activity, render pipeline status, and ad performance, including a super-admin specific Analytics Dashboard with user, revenue, video, and GPU metrics.
- **Maintenance Mode**: Super-admin configurable with custom messages.
- **Smart Ad System**: Monetization system with a global toggle, per-ad CRUD, impression/click/CTR analytics, and user exemption rules.
- **High-Speed Rendering**: Priority-based, GPU-accelerated parallel rendering pipeline with tiered service levels and real-time progress updates.
- **AI Core Engine**: Utilizes OpenAI `gpt-5.2` for deep analysis, generating production plans, character profiles, emotional arcs, cultural profiles, scene breakdowns, and production blueprints.
- **Pronunciation System**: Ensures natural-sounding voices through a global dictionary, voice correction mechanisms, and AI script analysis.
- **Audio + Realism System**: Integrates audio profiles (voice science, performance directives, lip-sync criticals) and realism profiles (human truth statements, artifact prevention), including background music cues and emotion timelines.
- **API Platform**: Super-admin controlled system for managing API clients and keys.
- **Offers / Promotions System**: Super-admin can create discount offers with coupon codes, validity windows, and usage limits.
- **Special Access (VIP) System**: Super-admin can grant per-user privileges overriding normal plan limitations, with tracking and analytics.
- **Sound Prompt Validation + Auto-Replacement**: Detects and validates sound cues in scripts, replacing generic prompts with curated sounds from an admin-managed library, powered by `gpt-5.2`.
- **Paranormal & Supernatural VFX Intelligence (Auto)**: Automatically scans scripts for supernatural keywords, generating a structured profile for VFX requirements, atmosphere, physics rules, and style directives, which is injected into screenplay generation.
- **Cinema-Grade Output System**: Provides comprehensive cinema output configuration including aspect ratio, resolution (with auto-activated Cinema Mode at 4K+), color grade, film grain, depth of field, audio mastering, and multi-select export formats.
- **Long Video Split + Intermission System**: Automatically handles long videos by inserting cinematic intermissions and splitting ultra-long videos into parts with narrative continuity.
- **Auto Marketing Assets Generation**: Automatically generates promotional assets like cinematic trailers, posters, and YouTube thumbnails from completed videos, with user controls for generation and deletion.
- **Advanced Character Realism System**: Allows users to create character profiles with multiple face angles, voice samples (with cloning capabilities), ensuring consistent identity, realistic movement, and emotional voice variation.

### System Design Choices
The architecture separates `api-server` (Express backend) and `gems-video-ai` (React frontend) within an `artifacts` directory. Shared resources are in the `lib` directory, including `api-spec`, generated API clients (`api-client-react`, `api-zod`), `db` setup, and `integrations-openai-ai-server`. The `requireAuth` middleware performs live database status checks for immediate user status enforcement.

## External Dependencies
- **OpenAI**: Used for AI Core Engine (`gpt-5.2`), Pronunciation System, Sound Prompt Validation, and content moderation.
- **PostgreSQL**: Primary database.
- **Drizzle ORM**: ORM for PostgreSQL.
- **jsonwebtoken (JWT)**: For authentication.
- **bcryptjs**: For password hashing.
- **Orval**: API codegen tool.
- **Vite**: Frontend build tool.
- **Tailwind CSS**: CSS framework.
- **Framer Motion**: Animation library.
- **shadcn/ui**: UI component library.
- **Wouter**: React routing library.
- **React Query**: For data fetching and state management.

## Bug Fixes (Session)

### Round 1 — Comprehensive Bug Audit
Five bugs identified and fixed across the web app and backend:

1. **Settings Plan Card hardcoded** (`artifacts/gems-video-ai/src/pages/settings.tsx`): "Pro Features Enabled" was shown for all users regardless of role. Now shows role-aware plan info: Free Plan for `user`, Pro Plan for `paid`, Enterprise for `admin`/`super_admin`.

2. **AdUnit impression tracking broken** (`artifacts/gems-video-ai/src/components/ad-unit.tsx`): `tracked` was a single `ref<boolean>` — only tracked the first ad impression per session. Fixed to `useRef<Set<string>>` keyed by ad ID so every unique ad is tracked once.

3. **ProjectsPage missing queryKey** (`artifacts/gems-video-ai/src/pages/projects/index.tsx`): `useListProjects()` was called without an explicit `queryKey`, causing React Query cache collisions. Added explicit `queryKey: ['projects']`.

4. **Settings password change not implemented** (`artifacts/gems-video-ai/src/pages/settings.tsx`): Clicking "Update Password" showed a "not implemented" toast. Fully implemented: three fields (Current, New, Confirm), client-side validation (match + min 8 chars), and a real `POST /api/auth/change-password` fetch call with success/error toasts.

5. **Backend `POST /auth/change-password` missing** (`artifacts/api-server/src/routes/auth.ts`): Added endpoint that verifies the current password via bcrypt, then updates the hash. Returns 401 on wrong password, 200 on success.

### OpenAPI + Codegen
- Added `POST /auth/change-password` to `lib/api-spec/openapi.yaml` with `ChangePasswordBody` schema.
- Ran `pnpm --filter @workspace/api-spec run codegen` — generated updated `api.ts` + `api.schemas.ts` in both `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/`.
- Fixed orval incorrectly adding `export * from "./generated/api.schemas"` to `lib/api-zod/src/index.ts` (that file doesn't exist in api-zod's output) — removed spurious line.

### Round 2 — Third-Party API Platform System (Full Build)

**Backend (`artifacts/api-server/src/routes/`):**
- `api-platform.ts`: Added routes for listing/status/transfer/delete of `api_client_users`, request logs per client, key renewal (`POST /api/platform/clients/:id/keys/:keyId/renew`), and real `requestsToday`/`totalApiUsers`/`pendingTransfers` stats.
- `api-v1.ts` (new): Full third-party API — API key auth middleware, per-key rate limiting, request logging to `api_request_logs`, user CRUD (`/api/v1/users`), health endpoint (`/api/v1/health`).
- `routes/index.ts`: Registers `api-v1.ts` first (before all other routers) so `/api/v1/*` paths are caught.

**Database (`lib/db/src/schema/api_platform.ts`):**
- New `api_client_users` table: `id`, `clientId`, `name`, `email`, `externalId`, `status` (active/blocked/pending_transfer/transferred), `createdAt`.
- `api_request_logs` extended with `method` and `responseTimeMs` columns.
- Migration pushed to Supabase.

**OpenAPI + Codegen:**
- Added schemas: `ApiClientUser`, `ApiRequestLog`, `ApiV1User`, `RenewApiKeyBody`, `ApiV1HealthResponse`, `TransferApiClientUserResponse`.
- Added routes: list/update/transfer/delete client users, get client logs, renew key.
- Ran codegen → regenerated `api.ts` + `api.schemas.ts` in both client libs.
- Confirmed `lib/api-zod/src/index.ts` only exports `"./generated/api"` (not `api.schemas`).

**Frontend (`artifacts/gems-video-ai/src/pages/admin.tsx` — `ApiPlatformTab`):**
- **Stats row**: Updated from 4 to 7 cards — Total Clients, Active Keys, Total Requests, Today's Requests, API Users, Pending Transfers, Revenue (USD).
- **Detail panel**: Replaced single Keys panel with a tabbed panel (Keys / Users / Logs) that shows the correct content based on active tab.
  - *Keys tab*: Same as before + new "Renew" option in dropdown.
  - *Users tab*: Shows API-created users with status badges, actions (activate/block/transfer/delete).
  - *Logs tab*: Live table (15s auto-refresh) showing method, endpoint, status code, IP, key name, response time.
- **Renew Key dialog**: Extend a key's expiry by N days.
- **Transfer User dialog**: Move an API-created user to the main platform system.
- New hook calls: `useRenewApiKey`, `useListApiClientUsers`, `useUpdateApiClientUserStatus`, `useTransferApiClientUser`, `useDeleteApiClientUser`, `useGetApiClientLogs`.

### Important Notes
- `lib/integrations-openai-ai-server/` and `lib/integrations-openai-ai-react/` have pre-existing TS errors — **do NOT modify these files**.
- After any OpenAPI spec change: run `pnpm --filter @workspace/api-spec run codegen`.
- After codegen: manually verify `lib/api-zod/src/index.ts` only exports `"./generated/api"` (not `api.schemas` — that file only exists in api-client-react).
- `/api/v1/*` routes MUST be registered first in `routes/index.ts` to avoid being shadowed by other routers.