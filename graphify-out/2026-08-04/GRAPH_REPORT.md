# Graph Report - web-and-bot-order  (2026-08-04)

## Corpus Check
- 880 files · ~1,149,270 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 6618 nodes · 16819 edges · 316 communities (285 shown, 31 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 171 edges (avg confidence: 0.69)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `bcde1638`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- exports
- dependencies
- exports
- devDependencies
- dependencies
- dependencies
- dependencies
- scripts
- devDependencies
- components.json
- dependencies
- package.prod.json
- compilerOptions
- db/package.json
- compilerOptions
- storefront/client/tsconfig.json
- 5. Logging & auditability
- Backend Audit — Delta since 2026-07-06 + Full Pass on High-Risk Areas
- dependencies
- outbox-dispatcher/package.json
- include
- order-bot/tsconfig.json
- storefront/tsconfig.json
- web-admin/tsconfig.json
- core/tsconfig.json
- db/tsconfig.json
- outbox-dispatcher/tsconfig.json
- server/tsconfig.json
- storefront/client/src/api/types.ts
- ProductPage.tsx
- crud/support.ts
- t
- restore.sh
- t
- handlers.test.ts
- server/src/index.ts
- HomePage.tsx
- StaticPage.tsx
- api.ts
- crud/catalog.ts
- backup.sh
- docker-entrypoint.sh
- db/src/index.ts
- crud/users.ts
- 03 — Component Library
- t
- 11. MICRO-AND-MOTION-INTERACTIONS.md
- conversations/admin.ts
- REQUIRED INTERACTION DOMAINS
- Changelog
- Dokumentasi Teknis — `telegram-order-bot`
- Before / After
- Comprehensive Project Architecture Report
- Dashboard SPA Full Migration (Phase 4)
- Yang masih harus dikerjakan
- 5. FEATURE SYSTEM.md
- 8. CONTENT-STRATEGY.md
- 9. INDIVIDUAL-PAGES.md
- Audit UX/UI — Storefront + Web-Admin
- Troubleshooting
- Before / After
- Medium
- 3. LAYOUT-SYSTEM.md
- 4. PAGE-TEMPLATE-SYSTEM.md
- 7. DESIGN-LANGUAGE.md
- Design
- WHEN DISCUSSING ANY FEATURE
- Scope notes (decided during planning, not in the original spec)
- Storefront UI/UX Findings
- Audit: Per-SKU Delivery Flows — Ultra Code Review
- Migrasi Database
- Phase 1: Bybit BSC Confirmation Tracking (status model + live tracking screen)
- handlers/checkout.ts
- Plan: Admin Panel SaaS Redesign
- 1. PRODUCT-ARCHITECTURE.md
- File Structure
- 3. Section-by-section rules
- 08 — UX Rules
- 10. COMPONENT-LIBRARY.md
- Bagian 2 — Web-Admin (`apps/web-admin`)
- Plan — Integrasi NOWPayments (USDT) & PayDisini (IDR) sebagai metode bayar baru
- File Structure
- handlers/customer.ts
- 01 — Design System (Tokens & Foundations)
- Findings — Web Admin UI/UX Audit
- File Structure
- 10 — UI Review Checklist
- telegram-shop-ux-auditor.md
- check-migration-rebuild-quoting.ts
- Phase checklist
- Audit UI/UX Functional Fixes Implementation Plan
- Spec — Web Setup Wizard (onboarding pembeli, near-zero config)
- Referensi Variabel Environment
- Langkah instalasi
- Payments Page Redesign Implementation Plan
- Public channel ID editable in web admin — design
- Upload UX: foto produk yang terlihat + upload QR Binance
- UsersPage.test.tsx
- Model per domain
- Fase 0 — Pondasi Postgres Implementation Plan
- Dual credit balance (IDR + USDT) + credit-on-unfulfilled-order
- 06 — Settings Guidelines
- web-admin/client/src/pages/SupportPage.test.tsx
- Audit `fitur.md` — 2026-07-04
- §1 Findings
- Refactor catalog to Category → Product → Denomination
- File Structure
- Global Constraints
- Branding controls — favicon, hero, bot banner & identity
- Spec: Group-aware Home & Search (storefront) + admin "Denominasi" wording
- Migrasi Web (web-admin + storefront) ke Next.js + Postgres — Design
- Product Denominations (Product Groups) — Design
- 02 — Admin Layout
- Customer Journey Walkthrough
- SearchModal.tsx
- faqCommand
- howtopayCommand
- termsCommand
- jobs/index.ts
- web-admin/client/src/pages/SearchPage.tsx
- web-admin/client/src/pages/OrdersPage.test.tsx
- VouchersPage.test.tsx
- Money & Data Integrity
- Arsitektur
- Payment Gateway
- Release Notes
- Security
- Customers Module Upgrade — Task Plan
- broadcasts.ts
- Batch 6 — Data layer and schema
- Storefront Auth: Username+Password Login, Web Registration, Forgot Password, Telegram Linking
- Binance Internal Transfer → DB-driven config (like Bybit)
- Payment-method on/off toggle (web admin) — design
- Design
- keyboards/customer.ts
- Storefront homepage — visual polish design
- 07 — Dashboard Guidelines
- Design System / Component Consistency
- jobs.test.ts
- Plan: Admin Panel UX Pass v2 — adjusted from `ui.txt`
- H. Slice Infrastruktur, Secrets, DB Schema & Composition Root
- File Structure
- Batch 5 — Order bot
- Spec — Bybit di storefront + QRIS di bot (metode bayar lintas-front)
- Catalog — Create Product Flow
- 05 — Table Guidelines
- 09 — Code Style
- UX Recommendations
- Order Bot — Bot Telegram + Panel Admin + Toko Web
- Bot UX (grammY)
- Backup & Restore — SQLite WAL (execution/06, M-5)
- Audit Keamanan & Business-Logic — Full Repo
- E. Slice Admin Web Security (`apps/web-admin`)
- G. Slice Bot Concurrency, Idempotency & Admin Bot Security
- 2. Temuan per halaman
- Sistem Inventori (Stok)
- Admin UI Consistency Design
- callbacks.ts
- Design: Storefront Support Ticket Workspace (Phase 1)
- 00 — AI Development Rules
- Design System / Component Consistency
- Accessibility Findings
- Implementation Plan
- Performance UX Findings
- Responsive Findings
- storefront/client/package.json
- web-admin/client/package.json
- admin-ui.js
- UI Development Dispatch
- Web Conventions (Fastify + React SPA)
- Deployment — public release (execution/02)
- A. Slice Checkout & Order Creation (Ghost Orders)
- F. Slice Storefront Customer Auth & Checkout
- Backup & Restore
- bybitBscDeposit.ts
- Sistem Antrian (`notification_outbox`)
- Fase 1 — Migrasi web-admin ke Next.js (Planning Document)
- Plan: Perbaikan UX/UI Storefront + Web-Admin
- Storefront Homepage Visual Polish Implementation Plan
- Conversion Rate Optimization (CRO)
- Storefront UI/UX Audit — Overview
- FlashSalesPage.test.tsx
- web-admin/client/src/pages/ReviewsPage.test.tsx
- StockPage.test.tsx
- CLAUDE.md
- C. Slice Pricing, Voucher, Wallet & FX
- Rollback
- Fase 2 — Migrasi storefront ke Next.js (Planning Document)
- Catalog — Create Product Flow Implementation Plan
- Global Constraints
- Global Constraints
- Batch 2 — Auth, CSRF, route security
- Batch 4 — Payment gateways and webhooks
- Hero: replace default Unsplash photo with a brand gradient
- Accessibility Findings
- binance_internal.ts
- Checkout
- Navigation
- General UX Recommendations
- Panduan Update
- ReportsPage.test.tsx
- API Reference
- B. Slice Payment Gateway & Callback Security
- Batch 3 — Orders, checkout, stock, delivery
- core/package.json
- devDependencies
- bybitBscConfirmationTracker.ts
- Security Patch
- Konfigurasi
- Logging
- Fase 3 — Bersih-bersih & finalisasi (Planning Document)
- Global Constraints
- Batch 1 — Money, pricing, reconciliation
- Navigation Analysis
- Web Admin UI/UX Audit — Phase 1 (Audit & Document Only)
- Responsive Findings
- bybit-internal-probe.ts
- check-migration-timestamps.ts
- Order State Machine
- bybitDeposit.ts
- Panduan Patch (Bugfix)
- Backend Audit Fixes — High + Medium (2026-07-31)
- Homepage
- Product Listing and Product Detail
- Versioning
- locales.test.ts
- build-bundle.ts
- Dokumentasi `telegram-order-bot` — Indeks
- rules/graphify.md
- paydisiniReconcile.ts
- workflows/graphify.md
- lucide-react
- @testing-library/user-event
- @types/react-dom
- typescript
- storefront/client/vite.config.ts
- @fontsource/jetbrains-mono
- @fontsource/manrope
- lucide-react
- radix-ui
- react-router-dom
- recharts
- shadcn
- sonner
- audit-backend-2026-07-31-execution-ledger.md
- dispatcher.ts
- qr.ts
- FakeConversation
- TMP_DIR
- server/test/setup-env.ts
- TMP_DIR
- apiGet
- lib/i18n.ts
- storefront/client/src/pages/TicketDetailPage.tsx
- storefront/client/src/api/client.ts
- AccountPage.tsx
- storefront/client/src/pages/ReviewsPage.tsx
- TicketMessageThread.tsx
- storefront/client/src/App.tsx
- shop/StatusBadge.tsx
- storefront/src/plugins/auth.ts
- pageData.ts
- storefront/src/server.ts
- apiAccount.ts
- apiAuth.ts
- routes/checkout.ts
- crud/orders.ts
- buildApp
- TMP_DIR
- web-admin/client/src/api/client.ts
- web-admin/client/src/App.tsx
- additionalFields.ts
- CatalogPage.tsx
- web-admin/client/src/pages/ReviewsPage.tsx
- AppShell.tsx
- web-admin/client/src/pages/SupportPage.tsx
- VouchersPage.tsx
- AuditPage.tsx
- ErrorBoundary.tsx
- OrderStatusBadge.tsx
- button.tsx
- web-admin/client/src/pages/OrdersPage.tsx
- web-admin/client/src/pages/SettingsPage.tsx
- SettingsNav.tsx
- Sidebar.tsx
- cn
- sonner.tsx
- ImageUploadField.test.tsx
- setSetting
- web-admin/src/plugins/auth.ts
- displayDateTime
- currentAdmin
- connectionTest.ts
- telegramCheck.ts
- dashboard.ts
- api/orders.ts
- crud/reviews.ts
- web-admin/src/server.ts
- api/stock.ts
- api/support.ts
- crud/vouchers.ts
- TMP_DIR
- getSetting
- core.test.ts
- web.test.ts
- createDenomination
- config.ts
- n
- storageMaintenance.test.ts
- catalogRename.ts
- TMP_DIR

## God Nodes (most connected - your core abstractions)
1. `cn()` - 117 edges
2. `getSetting()` - 107 edges
3. `t()` - 105 edges
4. `t()` - 100 edges
5. `setSetting()` - 98 edges
6. `MyContext` - 90 edges
7. `createOrderDirect()` - 87 edges
8. `Config` - 80 edges
9. `createDenomination()` - 78 edges
10. `createCatalogProduct()` - 76 edges

## Surprising Connections (you probably didn't know these)
- `stockUploadConversation()` --indirect_call--> `n()`  [INFERRED]
  apps/order-bot/src/conversations/admin.ts → packages/db/src/migrate/catalogRename.test.ts
- `cacheBannerFileId()` --calls--> `setSetting()`  [EXTRACTED]
  apps/order-bot/src/handlers/customer.ts → packages/db/src/crud/settings.ts
- `browseProduct()` --indirect_call--> `unitPrice()`  [INFERRED]
  apps/order-bot/src/handlers/customer.ts → packages/db/src/crud/orders.ts
- `makeInternalOrder()` --calls--> `createInternalOrder()`  [EXTRACTED]
  apps/order-bot/test/binance-internal.test.ts → packages/db/src/crud/binance_internal.ts
- `makeBybitOrder()` --calls--> `createBybitOrder()`  [EXTRACTED]
  apps/order-bot/test/bybit-bsc-deposit.test.ts → packages/db/src/crud/bybit_deposit.ts

## Import Cycles
- 3-file cycle: `packages/db/src/crud/orders.ts -> packages/db/src/crud/referrals.ts -> packages/db/src/crud/pricing.ts -> packages/db/src/crud/orders.ts`

## Communities (316 total, 31 thin omitted)

### Community 0 - "exports"
Cohesion: 0.08
Nodes (24): exports, ./bulk, ./config, ./customEmoji, ./datetime, ./delivery, ./deliveryFields, ./enums (+16 more)

### Community 1 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, class-variance-authority, clsx, @fontsource/outfit, framer-motion, react, react-dom, tailwind-merge (+11 more)

### Community 2 - "exports"
Cohesion: 0.06
Nodes (32): dependencies, @app/core, @app/db, croner, grammy, @grammyjs/conversations, @grammyjs/runner, exports (+24 more)

### Community 3 - "devDependencies"
Cohesion: 0.09
Nodes (23): devDependencies, jsdom, tailwindcss, @tailwindcss/vite, @testing-library/jest-dom, @testing-library/react, @testing-library/user-event, @types/react (+15 more)

### Community 4 - "dependencies"
Cohesion: 0.06
Nodes (30): dependencies, @app/core, @app/db, fastify, @fastify/compress, @fastify/cookie, @fastify/formbody, @fastify/multipart (+22 more)

### Community 5 - "dependencies"
Cohesion: 0.07
Nodes (27): @app/order-bot, @app/outbox-dispatcher, @app/storefront, @app/web-admin, dependencies, @app/core, @app/db, @app/order-bot (+19 more)

### Community 6 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, @fontsource/jetbrains-mono, @fontsource/manrope, @fontsource/outfit, framer-motion, react, react-dom, react-router-dom (+9 more)

### Community 7 - "scripts"
Cohesion: 0.04
Nodes (48): esbuild, dependencies, @prisma/client, devDependencies, @app/core, @app/db, esbuild, prisma (+40 more)

### Community 8 - "devDependencies"
Cohesion: 0.12
Nodes (17): devDependencies, jsdom, tailwindcss, @tailwindcss/vite, @testing-library/jest-dom, @testing-library/react, @types/react, vite (+9 more)

### Community 9 - "components.json"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 10 - "dependencies"
Cohesion: 0.06
Nodes (35): dependencies, @app/core, @app/db, bcryptjs, fastify, @fastify/cookie, @fastify/formbody, @fastify/multipart (+27 more)

### Community 11 - "package.prod.json"
Cohesion: 0.10
Nodes (20): nunjucks, dependencies, nunjucks, pino, prisma, @prisma/client, thread-stream, description (+12 more)

### Community 12 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, baseUrl, jsx, lib, paths, rootDir, types, exclude (+11 more)

### Community 13 - "db/package.json"
Cohesion: 0.11
Nodes (18): dependencies, @app/core, decimal.js, @prisma/client, devDependencies, prisma, exports, ./client (+10 more)

### Community 14 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution, noEmit (+10 more)

### Community 15 - "storefront/client/tsconfig.json"
Cohesion: 0.12
Nodes (16): compilerOptions, jsx, lib, types, exclude, extends, include, DOM (+8 more)

### Community 16 - "5. Logging & auditability"
Cohesion: 0.04
Nodes (45): 1. Money and financial correctness, 2. Data integrity & transactions, 3. Security, 4. Outbox / notification delivery, 5. Logging & auditability, 6. Schema & deploy discipline, Backend Audit — Data, Money, Security, Logging, Cross-cutting pattern (+37 more)

### Community 17 - "Backend Audit — Delta since 2026-07-06 + Full Pass on High-Risk Areas"
Cohesion: 0.05
Nodes (38): 0. Status of prior audit findings, 1. Money, pricing, FX, reconciliation, 2. Orders, checkout, stock, delivery, 3. Payment gateways and webhooks, 4. Auth, CSRF, route security, 5. Order bot (delta since 2026-07-06), 6. Data layer and schema (delta since 2026-07-06), 7. Outbox, notifications, composition root (+30 more)

### Community 18 - "dependencies"
Cohesion: 0.13
Nodes (15): dotenv, luxon, nodemailer, dependencies, bcryptjs, decimal.js, dotenv, luxon (+7 more)

### Community 19 - "outbox-dispatcher/package.json"
Cohesion: 0.13
Nodes (14): dependencies, @app/core, @app/db, grammy, exports, @app/core, @app/db, grammy (+6 more)

### Community 20 - "include"
Cohesion: 0.13
Nodes (14): apps/**/*.test.ts, packages/**/*.test.ts, scripts/check-migration-rebuild-quoting.ts, scripts/lib/**/*.ts, tests/**/*.ts, vitest.config.ts, compilerOptions, jsx (+6 more)

### Community 21 - "order-bot/tsconfig.json"
Cohesion: 0.22
Nodes (8): compilerOptions, rootDir, exclude, extends, include, src/**/*.test.ts, src/**/*.ts, ../../tsconfig.base.json

### Community 22 - "storefront/tsconfig.json"
Cohesion: 0.22
Nodes (8): compilerOptions, rootDir, exclude, extends, include, src/**/*.test.ts, src/**/*.ts, ../../tsconfig.base.json

### Community 23 - "web-admin/tsconfig.json"
Cohesion: 0.22
Nodes (8): compilerOptions, rootDir, exclude, extends, include, src/**/*.test.ts, src/**/*.ts, ../../tsconfig.base.json

### Community 24 - "core/tsconfig.json"
Cohesion: 0.22
Nodes (8): compilerOptions, rootDir, exclude, extends, include, src/**/*.test.ts, src/**/*.ts, ../../tsconfig.base.json

### Community 25 - "db/tsconfig.json"
Cohesion: 0.22
Nodes (8): compilerOptions, rootDir, exclude, extends, include, src/**/*.test.ts, src/**/*.ts, ../../tsconfig.base.json

### Community 26 - "outbox-dispatcher/tsconfig.json"
Cohesion: 0.22
Nodes (8): compilerOptions, rootDir, exclude, extends, include, src/**/*.test.ts, src/**/*.ts, ../../tsconfig.base.json

### Community 27 - "server/tsconfig.json"
Cohesion: 0.29
Nodes (6): compilerOptions, rootDir, extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 28 - "storefront/client/src/api/types.ts"
Cohesion: 0.04
Nodes (39): AccountData, Category, CategoryPageData, CheckoutData, CustomerInfo, HomeCategory, HomePageData, HomeStats (+31 more)

### Community 29 - "ProductPage.tsx"
Cohesion: 0.08
Nodes (32): CartLineView, CartPageData, CheckoutItem, ProductDenomination, BreadcrumbItem, BreadcrumbProps, DenominationCard(), DenominationCardData (+24 more)

### Community 30 - "crud/support.ts"
Cohesion: 0.15
Nodes (22): TicketCategory, TicketPriority, buildTicketConditions(), bulkAssignTickets(), bulkCloseTickets(), bulkSetTicketPriority(), classifyTicket(), countTickets() (+14 more)

### Community 31 - "t"
Cohesion: 0.07
Nodes (28): PayData, PayState, PayStatusData, SupportTicketSummary, TicketOrderSummary, AttachmentPicker(), AttachmentPickerProps, IMAGE_TYPES (+20 more)

### Community 33 - "t"
Cohesion: 0.15
Nodes (44): MyContext, adminCommand(), adminEmojiIdCommand(), adminMarkStockDead(), adminWalletCommand(), closeTicketAdmin(), collectCustomEmoji(), deleteBulkPricingHandler() (+36 more)

### Community 34 - "handlers.test.ts"
Cohesion: 0.07
Nodes (42): SessionData, cache, invalidateRateCache(), entryAdmin(), customerCtx(), EMAIL_FIELD, GAME_ID_FIELD, userSession() (+34 more)

### Community 35 - "server/src/index.ts"
Cohesion: 0.05
Nodes (73): initialSession(), CONVERSATIONS, routeCallback(), scheduleFxRefresh(), buildBot(), guardRunnerTask(), setupCommandMenu(), start() (+65 more)

### Community 36 - "HomePage.tsx"
Cohesion: 0.07
Nodes (42): CategoriesPageData, SORT_KEYS, SortKey, EmptyStateAction, EmptyStateProps, MotionLink, ProductCard(), ProductCardProps (+34 more)

### Community 37 - "StaticPage.tsx"
Cohesion: 0.11
Nodes (9): CalloutProps, CalloutVariant, VARIANTS, StaticPage(), StaticPageProps, StaticPageStep, StepItem, StepTimelineProps (+1 more)

### Community 38 - "api.ts"
Cohesion: 0.10
Nodes (34): Customer, apiRoutes(), CategoryJson, clampJsonQty(), DenominationJson, ProductJson, apiCartRoutes(), cartPayload() (+26 more)

### Community 39 - "crud/catalog.ts"
Cohesion: 0.08
Nodes (49): categoryNameMap(), ImportRow, isNum(), parseDenominationCsv(), resolveOrCreateProduct(), catalogApiRoutes(), parseDecimal(), storefrontDetailFields() (+41 more)

### Community 42 - "db/src/index.ts"
Cohesion: 0.08
Nodes (47): fakeApi, CREDS, makeNowpaymentsOrder(), CREDS, makePaydisiniOrder(), CREDS, makeTokopayOrder(), NotificationEvent (+39 more)

### Community 43 - "crud/users.ts"
Cohesion: 0.09
Nodes (38): buildUserFilter(), csvField(), csvRow(), PAGE_SIZE_OPTIONS, parseBannedFilter(), parseDate(), parseIdsFilter(), parseRoleFilter() (+30 more)

### Community 44 - "03 — Component Library"
Cohesion: 0.05
Nodes (38): 03 — Component Library, Alert, Avatar, Badge, Breadcrumb, Button, Card, Charts (+30 more)

### Community 45 - "t"
Cohesion: 0.13
Nodes (30): BaseContext, BotState, DbUserSnap, isCmd(), voucherConversation(), customerInfoConversation(), fieldPrompt(), isCmd() (+22 more)

### Community 46 - "11. MICRO-AND-MOTION-INTERACTIONS.md"
Cohesion: 0.06
Nodes (33): Accessibility, COLLABORATION STYLE, Commerce Motion, Content Motion, CONTEXT, CURRENT GOAL, Data Updates, DESIGN SYSTEM INTEGRATION (+25 more)

### Community 47 - "conversations/admin.ts"
Cohesion: 0.17
Nodes (42): MyConversation, acquireBroadcastLock(), adminGate(), answerStaleTap(), broadcastConversation(), bulkPricingConversation(), denyAdmin(), downloadTgText() (+34 more)

### Community 48 - "REQUIRED INTERACTION DOMAINS"
Cohesion: 0.06
Nodes (33): Accessibility, Checkout Interaction, COLLABORATION STYLE, Confirmation, CONTEXT, CURRENT GOAL, Drawer Strategy, Empty States (+25 more)

### Community 49 - "Changelog"
Cohesion: 0.06
Nodes (32): Added, Added, Added, Added, Added, Added, Added, Added (+24 more)

### Community 50 - "Dokumentasi Teknis — `telegram-order-bot`"
Cohesion: 0.06
Nodes (31): 10. Tiket dukungan (support), 11. Ulasan & rating produk, 12.1 Health check, 12.2 Webhook Telegram, 12.3 Webhook gateway pembayaran (storefront, public), 12.4 Endpoint internal lain (bukan API publik), 12. Langganan restock, 13. Desain storefront (+23 more)

### Community 51 - "Before / After"
Cohesion: 0.06
Nodes (30): Batch 1 — Critical, Batch 2 — High, Batch 3 — Checkout/cart friction, Batch 4 — Homepage resilience, Batch 5 — Product listing & detail scaffolding, Batch 6 — Design-system primitives, Batch 7 — Polish, Before / After (+22 more)

### Community 52 - "Comprehensive Project Architecture Report"
Cohesion: 0.07
Nodes (29): 10. External Integrations & Payment Gateways, 11. Admin Panel Workflow, 12. User Storefront Workflow, 13. Potential Dead Code, 14. Architectural Inconsistencies & Weaknesses, 1. Tech Stack & Core Dependencies, 2. Monorepo Folder Structure, 3. Application Entry Points (+21 more)

### Community 53 - "Dashboard SPA Full Migration (Phase 4)"
Cohesion: 0.07
Nodes (29): Dashboard SPA Full Migration (Phase 4), File Structure, Foundation additions, Global Constraints, Migration Pattern (applied to every page), Notes on the pattern, Out of scope (future work), PATTERN: Migrate `/<page>` to React (+21 more)

### Community 54 - "Yang masih harus dikerjakan"
Cohesion: 0.07
Nodes (29): Apa yang sudah selesai, Cara melanjutkan sesi ini, Catatan teknis penting, Final verification results (2026-06-26), Hutang test frontend (kerjakan sebelum lanjut task baru), Migration Complete, SPA Migration Progress — Phase 4 Continuation, State saat ini (+21 more)

### Community 55 - "5. FEATURE SYSTEM.md"
Cohesion: 0.07
Nodes (26): COLLABORATION STYLE, CONTEXT, CURRENT GOAL, Customer Goal, Customer Journey, Dependencies, Edge Cases, FEATURE DISCOVERY (+18 more)

### Community 56 - "8. CONTENT-STRATEGY.md"
Cohesion: 0.07
Nodes (26): ACCESSIBILITY, BUTTON LANGUAGE, COLLABORATION STYLE, CONTENT FRAMEWORK, CONTENT PHILOSOPHY, CONTEXT, CURRENT GOAL, DEFINE CONTENT PERSONALITY (+18 more)

### Community 57 - "9. INDIVIDUAL-PAGES.md"
Cohesion: 0.07
Nodes (26): Account, COLLABORATION STYLE, Commerce, CONTEXT, CURRENT GOAL, CUSTOMER JOURNEYS, Discovery, FIRST TASK (+18 more)

### Community 58 - "Audit UX/UI — Storefront + Web-Admin"
Cohesion: 0.08
Nodes (25): 1.1 [HIGH] Login storefront tidak ter-center secara vertikal dan bisa overflow, 1.2 [INFO] Login admin sudah benar — jadikan acuan, 2.1 [MEDIUM] Input dengan `min-width` bisa memaksa overflow horizontal di HP, 2.2 [LOW] Tabel lebar — sudah dimitigasi, bisa ditingkatkan, 2.3 [INFO] Storefront umumnya sehat secara tinggi, 3.1 [MEDIUM] Widget terasa "tempelan", tidak menyatu dengan design system, 3.2 [INFO → KOREKSI BRIEF] "Avatar bentrok saat tertaut" tidak terjadi di settings, 3.3 [LOW] State "terhubung" di settings bisa lebih kaya (+17 more)

### Community 59 - "Troubleshooting"
Cohesion: 0.08
Nodes (26): 502/504 dari nginx, Baris `FAILED` permanen, Baris `notification_outbox` stuck `SENDING`, Bot crash: `String must contain at least 20 character(s)`, Bot Telegram, Bot tidak membalas `/start`, Bybit/Binance tidak auto-confirm, Channel testimoni tidak pernah posting (+18 more)

### Community 60 - "Before / After"
Cohesion: 0.08
Nodes (25): Audit closing summary, Before / After, F-001 — Removed duplicate "Awaiting Fulfillment" sidebar entry, F-002 — Logout was completely broken, F-003 — Human-readable order status labels, F-004 — Audit Log "Admin" column shows a name instead of a raw ID, F-005 — Audit Log Action column: humanized instead of raw backend codes, F-006 — Standardized "simple record" inline-create pattern (Admins ↔ Vouchers) (+17 more)

### Community 61 - "Medium"
Cohesion: 0.08
Nodes (25): 10. F-007 — Fix Denomination breadcrumb product-name bug, 11. F-010 — Semantic headings on Dashboard, 12. F-011 — Fix low-contrast muted text token, 13. F-013 — Settings gateway toggle/status display fix, 14. F-014 — Add labels to Voucher inline-create form, 15. F-008 — Remove redundant "← Back" button, 16. F-015 — Rename "Pwd" column header, 17. F-017 — Search returns no results for an existing product (+17 more)

### Community 62 - "3. LAYOUT-SYSTEM.md"
Cohesion: 0.08
Nodes (25): Accessibility, Cognitive Load, COLLABORATION STYLE, CONTENT CONTAINERS, Content Priority, CURRENT GOAL, Customer Goal, FIRST TASK (+17 more)

### Community 63 - "4. PAGE-TEMPLATE-SYSTEM.md"
Cohesion: 0.08
Nodes (25): CHALLENGE THIS ASSUMPTION, COLLABORATION STYLE, Content Hierarchy, CTA Strategy, CURRENT GOAL, Customer Goal, FIRST TASK, IMPORTANT (+17 more)

### Community 64 - "7. DESIGN-LANGUAGE.md"
Cohesion: 0.08
Nodes (24): ACCESSIBILITY, COLLABORATION STYLE, COLOR PHILOSOPHY, CONTENT LANGUAGE, CONTEXT, CURRENT GOAL, DEFINE THE VISUAL LANGUAGE, DESIGN LANGUAGE FRAMEWORK (+16 more)

### Community 65 - "Design"
Cohesion: 0.08
Nodes (22): 1. Backend — accept a currency on wallet adjustment, 2. Frontend types — match the real API shape, 3. Profile card — show both balances, 4. Wallet Adjustment form — currency toggle, 5. Wallet Ledger table — show currency, fix field mismatch, Admin panel: split wallet balance into IDR and USDT, Context, Design (+14 more)

### Community 66 - "WHEN DISCUSSING ANY FEATURE"
Cohesion: 0.08
Nodes (23): COLLABORATION STYLE, CURRENT GOAL, DESIGN PHILOSOPHY, Desktop Experience, Edge Cases, Empty State, Error State, Final Recommendation (+15 more)

### Community 68 - "Scope notes (decided during planning, not in the original spec)"
Cohesion: 0.09
Nodes (22): Admin UI Consistency Implementation Plan, Global Constraints, Scope notes (decided during planning, not in the original spec), Self-Review, Task 10: Migrate VouchersPage onto StatusBadge and Switch, Task 11: Migrate SettingsPage banners onto Sonner toast and fix the raw checkbox, Task 12: Migrate OutboxPage onto DataTable and StatusBadge, Task 13: Migrate ReportsPage onto Card/DataTable and fix hardcoded colors (+14 more)

### Community 69 - "Storefront UI/UX Findings"
Cohesion: 0.09
Nodes (22): Environment blocker (not a numbered finding), STO-001 — "Out of stock" badge misrepresents purchasable manual-delivery products, STO-002 — Blank "Signed in as" name for password-registered customers, STO-003 — Keyboard focus ring invisible on hero CTA buttons, STO-004 — Language switcher unreachable on mobile, STO-005 — Voucher error message disconnected from its input on desktop, STO-006 — Reveal-on-scroll leaves homepage sections invisible without an organic scroll, STO-007 — No sort, filter, or pagination on product listings (+14 more)

### Community 70 - "Audit: Per-SKU Delivery Flows — Ultra Code Review"
Cohesion: 0.09
Nodes (21): 10. `editCustomerInfo`'s `/skip` + narrow error handling can crash the wizard, 11. Hardcoded English string in the bot's admin approve flow, 12. Raw untranslated error key shown to admin on underpaid-manual-SKU delivery attempt, 13. Same raw-error-key pattern on the new manual-fulfillment route, 14. Admin's client-side "at least one field" check is weaker than the server's validation, 15. Two new notification-enqueue functions reimplement an existing helper, 1. Admin "Resend to Telegram" sends an empty file for manually-fulfilled orders, 2. No refund/reject/cancel path for a stuck `PROCESSING` order (+13 more)

### Community 71 - "Migrasi Database"
Cohesion: 0.09
Nodes (22): Apa arti kedua error itu, Boot-time drift check hanya menangkap TABEL hilang, bukan KOLOM hilang, Cara membuat migrasi (sebagai dokumentasi SQL, opsional), Cara menerapkan migrasi (yang sungguhan dipakai), Cara rollback migrasi, Catatan: sebagian folder migrasi dibuat manual, bukan via Prisma, Cek drift migrasi-vs-schema di CI, Cek tabrakan timestamp antar folder migrasi (+14 more)

### Community 72 - "Phase 1: Bybit BSC Confirmation Tracking (status model + live tracking screen)"
Cohesion: 0.09
Nodes (21): 1. Status model (`packages/core/src/enums.ts`, `prisma/schema.prisma`), 2. Deposit poller — sekarang menangkap status 1/2 juga (`packages/db/src/crud/bybit_bsc_deposit.ts`, `apps/order-bot/src/payments/bybitBscDeposit.ts`), 3. Confirmation tracker — poller baru (`apps/order-bot/src/payments/bybitBscConfirmationTracker.ts`), 4. Live tracking screen (bot + storefront), 5. Notifikasi, locale, settings, docs, Alternatif yang dipertimbangkan dan TIDAK dipilih, Bug yang ditemukan setelah Phase 1 merge (belum di-fix), Catatan deploy (+13 more)

### Community 73 - "handlers/checkout.ts"
Cohesion: 0.18
Nodes (36): buyNowBybit(), buyNowBybitBsc(), buyNowInternal(), buyNowNowpayments(), buyNowPaydisini(), buyNowTokopay(), cancelPendingOrder(), completeOrderWithWallet() (+28 more)

### Community 74 - "Plan: Admin Panel SaaS Redesign"
Cohesion: 0.09
Nodes (21): Context, Dark mode, Existing Assets to Reuse (Do Not Rewrite), File Change Summary, Modified files (~30), Modify existing files, New files, New files (~10) (+13 more)

### Community 75 - "1. PRODUCT-ARCHITECTURE.md"
Cohesion: 0.09
Nodes (21): Business Impact, COLLABORATION STYLE, CURRENT ASSUMPTION, CURRENT GOAL, Customer Expectations, Customer Goal, Edge Cases, FIRST TASK (+13 more)

### Community 76 - "File Structure"
Cohesion: 0.10
Nodes (20): File Structure, Global Constraints, Storefront Support Ticket Workspace Implementation Plan, Task 10: TicketMessageThread component, Task 11: TicketComposer component, Task 12: TicketOrderSummaryCard component, Task 13: OrderDetailPage — credentials anchor + scroll-to-hash, Task 14: TicketSidebar component (+12 more)

### Community 77 - "3. Section-by-section rules"
Cohesion: 0.10
Nodes (20): 04 — CRUD Template, 1. Two list-page tiers, 2. Full-tier page structure (annotated), 3. Section-by-section rules, 4. Create/Edit pattern, Bulk Actions, Choosing full-page vs. dialog, Empty State (+12 more)

### Community 78 - "08 — UX Rules"
Cohesion: 0.10
Nodes (20): 08 — UX Rules, 10. Scroll behavior, 11. Sticky elements, 12. Drawer usage, 13. Modal (Dialog) usage, 14. Hover, 15. Animation & transitions, 16. Reduced motion (+12 more)

### Community 79 - "10. COMPONENT-LIBRARY.md"
Cohesion: 0.10
Nodes (20): ACCESSIBILITY, COLLABORATION STYLE, COMPONENT CATEGORIES, COMPONENT DISCOVERY, COMPONENT GOVERNANCE, COMPONENT PHILOSOPHY, CONTEXT, CURRENT GOAL (+12 more)

### Community 80 - "Bagian 2 — Web-Admin (`apps/web-admin`)"
Cohesion: 0.10
Nodes (19): 1.1 [HIGH] "My Orders → Pay" menampilkan instruksi pembayaran yang salah/basi untuk semua metode pembayaran aktif, 1.2 [MEDIUM] Kegagalan re-validasi voucher ditelan diam-diam, subtotal berubah tanpa penjelasan, 1.3 [LOW/INFO] Locale key untuk resolusi order underpaid hilang dari kedua bahasa, 2.1 [HIGH] Tombol "Retry" Outbox dan "Hide/Unhide" Reviews gagal senyap — aksi sukses di server tapi UI tidak pernah update, 2.2 [HIGH] Resolusi order underpaid (deliver/refund/cancel) tidak punya UI sama sekali, 2.3 [MEDIUM] Ganti role customer tidak punya UI, 2.4 [MEDIUM] Fitur denomination baru: bisa create + toggle-active, tapi tidak ada edit/delete, 2.5 [LOW] `STORE_KEYS` di SettingsPage adalah kunci hantu — card "Store" tidak pernah render (+11 more)

### Community 81 - "Plan — Integrasi NOWPayments (USDT) & PayDisini (IDR) sebagai metode bayar baru"
Cohesion: 0.10
Nodes (19): Context, Global Constraints (berlaku di SEMUA task — reviewer pakai ini sebagai lensa), Plan — Integrasi NOWPayments (USDT) & PayDisini (IDR) sebagai metode bayar baru, Task 10: NOWPayments DB crud — `packages/db/src/crud/nowpayments.ts`, Task 11: NOWPayments reconcile poller + registrasi di DUA composition root, Task 12: NOWPayments di storefront — checkout, pay page, webhook IPN, Task 13: NOWPayments — admin settings whitelist + card UI, Task 14: NOWPayments — bot UI (keyboard, handler, dispatcher) + i18n (+11 more)

### Community 82 - "File Structure"
Cohesion: 0.10
Nodes (19): Backend response shapes (already merged — the contract every hook/type mirrors), Context, Dashboard Remaining Sections Implementation Plan (Phase 3), File Structure, Global Constraints, Out of scope (future work), Task 10: Quick Actions bar, Task 11: Assemble the full dashboard in App.tsx (+11 more)

### Community 83 - "handlers/customer.ts"
Cohesion: 0.06
Nodes (85): computeConfirmation(), showOrderConfirmation(), showUsdtMethods(), showWalletCreditMenu(), toggleWalletCredit(), allOrderHistory(), backToHome(), bannerArg() (+77 more)

### Community 84 - "01 — Design System (Tokens & Foundations)"
Cohesion: 0.10
Nodes (19): 01 — Design System (Tokens & Foundations), 10. Component size tokens (cross-reference), 11. Responsive breakpoints, 12. Dark mode — not supported (by design, not by omission), 1. Design philosophy, 2. Stack (what actually renders this), 3.1 Semantic layer (shadcn tokens), 3.2 Named palette (the tokens you'll use most in page code) (+11 more)

### Community 85 - "Findings — Web Admin UI/UX Audit"
Cohesion: 0.10
Nodes (19): F-001 — Duplicate nav item: "Orders" and "Awaiting Fulfillment" are the same page, F-002 — Logout is broken at both entry points (404, session stays active), F-003 — Orders status filter shows raw backend enum values, F-004 — Audit Log "Admin" column shows raw numeric user ID, F-005 — Audit Log "Action" column duplicates the readable Details sentence, F-006 — Three different "create new record" UI patterns across similar pages, F-007 — Denomination-create breadcrumb shows literal word "Product" instead of product name, F-008 — Redundant "Back" button duplicates the breadcrumb's job (+11 more)

### Community 86 - "File Structure"
Cohesion: 0.11
Nodes (18): Dashboard Backend API Implementation Plan, File Structure, Global Constraints, Task 10: `ordersByDay` and `combinedRevenueByDay`, Task 11: route scaffold + `GET /api/dashboard/kpis`, Task 12: `GET /api/dashboard/operations`, `/inventory`, `/expirations`, Task 13: `GET /api/dashboard/orders/recent`, `/health`, `/top-products`, Task 14: `GET /api/dashboard/analytics` (+10 more)

### Community 87 - "10 — UI Review Checklist"
Cohesion: 0.11
Nodes (18): 10 — UI Review Checklist, Accessibility (`08_UX_RULES.md` §8), Animation (`01_DESIGN_SYSTEM.md` §8, `08_UX_RULES.md` §15–16), Consistency / Component Reuse (`00_AI_RULES.md` §3, `09_CODE_STYLE.md` §8), CRUD Rules (`04_CRUD_TEMPLATE.md`), Dashboard Rules (`07_DASHBOARD_GUIDELINES.md`), Design Tokens (`01_DESIGN_SYSTEM.md`), Empty State (`03_COMPONENT_LIBRARY.md` §Empty State, `08_UX_RULES.md` §2) (+10 more)

### Community 88 - "telegram-shop-ux-auditor.md"
Cohesion: 0.11
Nodes (17): Before recommending from memory, Decision & Escalation Rules, How to save memories, Mandatory Workflow (do NOT skip or reorder), Marketplace UX Checklist (apply to every flow above), Memory and other forms of persistence, MEMORY.md, Out of Scope (never change without explicit confirmation) (+9 more)

### Community 89 - "check-migration-rebuild-quoting.ts"
Cohesion: 0.19
Nodes (14): GRANDFATHERED, grandfatheredCopies, GrandfatheredFolder, migrationsDir, offenders, problems, findClauseEnd(), findUnqualifiedSources() (+6 more)

### Community 90 - "Phase checklist"
Cohesion: 0.12
Nodes (16): API endpoints (all under `/api/v1`), Decisions (locked 2026-07-04), Migration complete 2026-07-05, Phase 0 — this doc, Phase 1 — client scaffolding (additive) — DONE 2026-07-04, Phase 2 — JSON API + SPA shell (additive; Nunjucks still serves all pages) — DONE 2026-07-04, Phase 3 — pixel harness — N/A, superseded 2026-07-04, Phase 4 — Cluster A: catalog + cart (React pages → verify → delete NJK) — DONE 2026-07-04 (+8 more)

### Community 91 - "Audit UI/UX Functional Fixes Implementation Plan"
Cohesion: 0.12
Nodes (16): Audit UI/UX Functional Fixes Implementation Plan, Bot Telegram (`apps/order-bot`), Global Constraints, Post-Execution Verification, Storefront (`apps/storefront`), Task 10: Fix restock form defaulting to a 404 action when JS hasn't set the denomination id yet, Task 1: Fix "My Orders → Pay" showing wrong payment instructions, Task 2: Fix voucher re-validation swallowing all errors silently (+8 more)

### Community 92 - "Spec — Web Setup Wizard (onboarding pembeli, near-zero config)"
Cohesion: 0.12
Nodes (16): 10. Testing (ikut CLAUDE.md), 11. Keputusan (FINAL — dikonfirmasi 2026-06-14), 1. Masalah & tujuan, 2. Ruang lingkup perubahan (ringkas), 3. Deteksi "belum di-setup" (setup mode), 4. Alur wizard (3 langkah, di web-admin), 5. Admin berbasis DB (perubahan inti), 6. Prasyarat env yang dilonggarkan (+8 more)

### Community 93 - "Referensi Variabel Environment"
Cohesion: 0.13
Nodes (15): Behaviour / Tuning, Database, Hanya di Settings (TIDAK ada di `.env`), Logging, Notifier (outbox dispatcher), Payment — Binance Internal Transfer (UID, auto-confirm), Payment — Binance Pay (manual, legacy fallback), Payment — Bybit Internal Transfer (UID, off-chain instant) (+7 more)

### Community 94 - "Langkah instalasi"
Cohesion: 0.13
Nodes (15): Build aplikasi, CI, Generate Prisma client, Instalasi, Jalur A — Docker (disarankan untuk produksi), Jalur B — tanpa Docker (dev lokal / VPS manual), Langkah instalasi, Migrasi/schema (+7 more)

### Community 95 - "Payments Page Redesign Implementation Plan"
Cohesion: 0.13
Nodes (14): Final verification (after Task 11), Global Constraints, Payments Page Redesign Implementation Plan, Task 10: Frontend — Ledger row actions as DropdownMenu + "Add to buyer's credit balance", Task 11: Frontend — swap hand-rolled pagination for the shared `Pagination` component, Task 1: Backend — `countProcessedBinanceTxToday` crud helper, Task 2: Backend — `q` search param on the ledger listing, Task 3: Backend route — wire `todayCount` and `q` into `GET /api/payments` (+6 more)

### Community 96 - "Public channel ID editable in web admin — design"
Cohesion: 0.13
Nodes (14): 1. Resolution (`packages/db/src/crud/credentials.ts`), 2. Runtime stamp (`packages/core/src/runtime.ts`), 3. Consumers stop reading `config.PUBLIC_CHANNEL_ID` directly, 4. Web admin field (`apps/web-admin/src/routes/settings.ts`), 5. Channel resolver (`apps/web-admin/src/lib/telegramCheck.ts`), Architecture, Data flow, Decisions (from brainstorming) (+6 more)

### Community 97 - "Upload UX: foto produk yang terlihat + upload QR Binance"
Cohesion: 0.13
Nodes (14): B1. Route web baru — `POST /settings/qr`, B2. Whitelist & cache key, B3. UI — kartu USDT/Binance, B4. Util bot — resolusi QR, B5. Checkout memakai util + cache, B6. Jalur lama tetap hidup, Bagian A — Foto produk mudah ditemukan (frontend saja), Bagian B — Upload QR Binance (full-stack, meniru pola banner) (+6 more)

### Community 98 - "UsersPage.test.tsx"
Cohesion: 0.15
Nodes (8): jsonResponse(), KPIS_DATA, mockFetchRouter(), USER_ANDI, USER_BUDI, USER_CITRA, USER_DEDI, USERS_DATA

### Community 99 - "Model per domain"
Cohesion: 0.14
Nodes (14): Database, ERD — inti Order/Stok/Pembayaran, Foreign key & cascade policy, Generate ERD penuh, Idempotency ledger pembayaran, Identitas & sesi, Index signifikan, Katalog (3 tier) (+6 more)

### Community 100 - "Fase 0 — Pondasi Postgres Implementation Plan"
Cohesion: 0.14
Nodes (13): Fase 0 — Pondasi Postgres Implementation Plan, File Structure, Global Constraints, Self-Review, Task 1: Switch Prisma datasource ke Postgres + presisi Decimal, Task 2: Buat Postgres tersedia + baseline migration, Task 3: `initDb()` aman-Postgres, Task 4: Test harness Postgres (schema unik per-run) (+5 more)

### Community 101 - "Dual credit balance (IDR + USDT) + credit-on-unfulfilled-order"
Cohesion: 0.14
Nodes (13): Component 1 — currency-aware `adjustWallet`, Component 2 — spend routing, Component 3 — credit-on-unfulfilled-order (the trigger), Component 4 — surfaces (display), Current system (facts the design builds on), Data model (Approach A — two columns + currency-tagged ledger), Dual credit balance (IDR + USDT) + credit-on-unfulfilled-order, Error handling / edge cases (+5 more)

### Community 102 - "06 — Settings Guidelines"
Cohesion: 0.14
Nodes (13): 06 — Settings Guidelines, 10. Progressive disclosure, 11. Save status, restart, and quick actions, 12. Never do, 1. Navigation, 2. Grouping, 3. Field display — `FieldRow`, 4. Save indicator / confirmation (+5 more)

### Community 103 - "web-admin/client/src/pages/SupportPage.test.tsx"
Cohesion: 0.19
Nodes (10): ADMIN_ROW, jsonResponse(), makeWrapper(), mockFetchRouter(), STATS, supportData(), TICKET_CLOSED, TICKET_OPEN (+2 more)

### Community 104 - "Audit `fitur.md` — 2026-07-04"
Cohesion: 0.15
Nodes (12): 1–2. Bot Telegram (`apps/order-bot`) — 24 + 13 + 6 item, 3. Panel Admin Web (`apps/web-admin`) — 38 item, 4. Toko Web Pelanggan (`apps/storefront`) — 17 item, 5. Lintas-Aplikasi / Infrastruktur — 26 item, Audit `fitur.md` — 2026-07-04, Fitur backend-lengkap tapi tidak ada tombol UI (BROKEN secara discoverability), Rekomendasi prioritas (jika ingin ditindaklanjuti), Ringkasan (+4 more)

### Community 105 - "§1 Findings"
Cohesion: 0.15
Nodes (12): §1 Findings, §2 Verified clean, §3 Files changed, Executive summary, F1 [HIGH] — the storefront quoted a total it would not charge, F2 [MEDIUM] — asymmetric zero-clamp between the two order creators, F3 [MEDIUM] — bulk-pricing rules were trusted at read time, F4 [MEDIUM] — the bulk discount had two spellings (+4 more)

### Community 106 - "Refactor catalog to Category → Product → Denomination"
Cohesion: 0.15
Nodes (12): 1a. Prisma schema (`prisma/schema.prisma`), 1b. Migration (`prisma/migrations/<ts>_catalog_rename/migration.sql` + cutover scripts), 1c. crud refactor (`packages/db/src/crud/`), Context, Implementation note (deviation accepted 2026-06-19), Phase 1 — Database schema + migration + crud (foundation), Phase 2 — Admin panel (`apps/web-admin`), Phase 3 — Storefront (`apps/storefront`) (+4 more)

### Community 107 - "File Structure"
Cohesion: 0.15
Nodes (12): Dashboard Frontend Foundation Implementation Plan, File Structure, Global Constraints, Task 1: Vite + React + TypeScript scaffold, Task 2: shadcn/ui CLI init + Card/Badge + ported theme tokens, Task 3: Vitest jsdom environment for the client package, Task 4: serve the SPA shell at `GET /`, replacing the Nunjucks dashboard, Task 5: CSRF header bridging (+4 more)

### Community 108 - "Global Constraints"
Cohesion: 0.15
Nodes (12): Final verification (after Task 9), Global Constraints, Task 1: `deriveVoucherStatus` + `listVouchersPaged` crud, Task 2: `getVoucherStats` crud, Task 3: `bulkSetVouchersActive` + `bulkDeleteVouchers` crud, Task 4: Wire `GET /api/vouchers` to pagination/search/status/stats, Task 5: `POST /api/vouchers/bulk-action` route, Task 6: Frontend — KPI row + PageHeader description (+4 more)

### Community 109 - "Branding controls — favicon, hero, bot banner & identity"
Cohesion: 0.15
Nodes (12): Bot: banner rendering, Branding controls — favicon, hero, bot banner & identity, File storage, Goals, Non-goals, Open questions, Problem, Security (+4 more)

### Community 110 - "Spec: Group-aware Home & Search (storefront) + admin "Denominasi" wording"
Cohesion: 0.15
Nodes (12): 1. Data layer — `packages/db/src/crud/catalog.ts`, 2. Routes — `apps/storefront/src/routes/`, 3. Templates — `apps/storefront/views/`, 4. Admin wording — `apps/web-admin/views/catalog.njk` (text only), Approach, Deploy, Edge cases, Goal (+4 more)

### Community 111 - "Migrasi Web (web-admin + storefront) ke Next.js + Postgres — Design"
Cohesion: 0.15
Nodes (12): Bagian 1 — Arsitektur target, Bagian 2 — Struktur monorepo, Bagian 3 — Data layer & migrasi Postgres, Bagian 4 — Auth (Auth.js / NextAuth), Bagian 5 — Design system (shadcn) + redesign panel produk (14 poin), Bagian 6 — Pemetaan fitur/endpoint (paritas, tanpa ubah logika), Bagian 7 — Urutan kerja (big-bang per app) & testing, Bagian 8 — Risiko (+4 more)

### Community 112 - "Product Denominations (Product Groups) — Design"
Cohesion: 0.15
Nodes (12): Bot (`apps/order-bot`), CRUD helpers (`packages/db/src/crud/catalog.ts`), Decisions (from brainstorming), Edge cases, Non-goals, Problem, Product Denominations (Product Groups) — Design, Schema (+4 more)

### Community 113 - "02 — Admin Layout"
Cohesion: 0.15
Nodes (12): 02 — Admin Layout, 1. The shell, 2. Sidebar, 3. TopBar, 4. Standard page hierarchy, 5. `PageHeader` and `PageLayout`, 6. Responsive behavior summary, 7. Never do (+4 more)

### Community 114 - "Customer Journey Walkthrough"
Cohesion: 0.15
Nodes (12): 1. Landing (`/`), 2. Browse products, 3. Search products, 4. Filter products, 5. Open product / View details (`/p/capcut-pro-1-month`), 6. Add to Cart / Buy Now, 7. Checkout gate (sign-in), 8. Checkout (`/checkout`) (+4 more)

### Community 115 - "SearchModal.tsx"
Cohesion: 0.20
Nodes (7): SearchApiResponse, SearchModal(), SearchModalProps, SearchResult, TYPE_ICONS, TYPE_LABELS, userLabel()

### Community 119 - "jobs/index.ts"
Cohesion: 0.16
Nodes (26): approve(), buildCredSections(), maybeAlertLowStock(), resendCredentials(), announceStartedFlashSales(), autoCancelExpiredOrders(), autoCloseStaleTickets(), binancePollWatchdog() (+18 more)

### Community 120 - "web-admin/client/src/pages/SearchPage.tsx"
Cohesion: 0.23
Nodes (7): SearchBar(), SearchBarProps, ProductHit, SearchPage(), SearchResult, UserHit, useSearch()

### Community 121 - "web-admin/client/src/pages/OrdersPage.test.tsx"
Cohesion: 0.18
Nodes (8): ELIGIBILITY_NONE, jsonResponse(), KPIS_DATA, mockFetchRouter(), ORDER_CAN_ACT, ORDER_CAN_FULFILL, ORDER_CAN_RESEND, ORDERS_DATA

### Community 122 - "VouchersPage.test.tsx"
Cohesion: 0.18
Nodes (9): EXPIRED_VOUCHER, EXPIRING_SOON_VOUCHER, FAR_FUTURE_VOUCHER, jsonResponse(), listResponse(), SELECTED_SCOPE_VOUCHER, STATS, USED_UP_VOUCHER (+1 more)

### Community 123 - "Money & Data Integrity"
Cohesion: 0.17
Nodes (11): Audit every state change, Money & Data Integrity, Money is always Decimal, Never log secrets, No raw SQL in routes or handlers, Overview, Pino logs are a separate, developer-facing channel, Schema changes on deploy (+3 more)

### Community 124 - "Arsitektur"
Cohesion: 0.17
Nodes (12): Alur order & state machine, Alur pembayaran, Apa yang TIDAK ada di stack ini, Arsitektur, Backend, Catatan desain yang diketahui (bukan bug, tapi batasan sadar), Database, Frontend (+4 more)

### Community 125 - "Payment Gateway"
Cohesion: 0.17
Nodes (12): Alert kegagalan delivery — "Manual action needed", Binance Internal Transfer (UID, USDT), Bybit BSC On-chain (BEP20, USDT), Bybit Internal Transfer (UID, USDT), Kontrak respons webhook (TokoPay/PayDisini/NOWPayments), NOWPayments (hosted invoice, USDT), PayDisini (QRIS/e-wallet, IDR), Payment Gateway (+4 more)

### Community 126 - "Release Notes"
Cohesion: 0.17
Nodes (12): Release Notes, v1.0.0 — 2026-05-30 s/d 2026-05-31, v1.10.0 — 2026-06-23, v1.1.0 — 2026-06-12, v1.2.0 — 2026-06-13, v1.3.0 — 2026-06-14 s/d 2026-06-16, v1.4.0 — 2026-06-17, v1.5.0 — 2026-06-18 (+4 more)

### Community 127 - "Security"
Cohesion: 0.17
Nodes (12): Bot Telegram, CSRF, Idempotensi & konkurensi pembayaran, Melaporkan temuan baru, Model otorisasi, Network/transport, Secrets handling, Security (+4 more)

### Community 128 - "Customers Module Upgrade — Task Plan"
Cohesion: 0.17
Nodes (11): Context, Customers Module Upgrade — Task Plan, Final Verification (after all tasks, whole-branch review), Global Constraints (binding on every task), Task 1: Customers list/count/sort/KPI/order-stats crud functions, Task 2: `touchLastSeen` + wire into the storefront, Task 3: `apps/web-admin/src/routes/api/users.ts` — list/export/kpis routes, Task 4: Frontend infra — relative time, Customers KPI hook/row, StatusBadge, Tooltip mount (+3 more)

### Community 129 - "broadcasts.ts"
Cohesion: 0.17
Nodes (25): broadcastFloodWaitMs(), drainBroadcasts(), sleep(), broadcastPhotoArg(), cacheBroadcastPhotoFileId(), broadcastApiRoutes(), BroadcastStatus, BROADCAST_SEGMENTS (+17 more)

### Community 130 - "Batch 6 — Data layer and schema"
Cohesion: 0.17
Nodes (12): Batch 6 — Data layer and schema, Task 36: H-8 — Generate the missing catch-up migration for 12 columns and 2 indexes that exist only in `schema.prisma`, Task 37: H-9 — Fix the unrunnable ticket-priority migration and its timestamp collision, Task 38: M-29 — Stamp `lastStatusChangeAt`/`firstResponseAt` on every ticket status transition, Task 39: M-30 — Expire the pre-auth `OWNER_TG_KEY` setup state so `/setup/owner` can't stay open indefinitely, Task 40: M-31 — Fix the overdue-ticket predicate to catch reopened/follow-up tickets, Task 41: M-32 — Add indexes for the new revenue/flash-sale queries' filter columns, Task 42: M-33 — Replace `topProducts`'s full-table scan with a bounded, grouped query (+4 more)

### Community 131 - "Storefront Auth: Username+Password Login, Web Registration, Forgot Password, Telegram Linking"
Cohesion: 0.17
Nodes (11): 1. Schema changes (additive, nullable — safe for the shared SQLite DB), 2. Login flow (`/login` reworked), 3. Web registration (`/register`, new), 4. Forgot password (`/forgot`, `/reset/:token`, new), 5. Member settings (`/account/settings`, new; linked from /account), 6. Session & system adjustments, 7. Security requirements, 8. Testing (+3 more)

### Community 132 - "Binance Internal Transfer → DB-driven config (like Bybit)"
Cohesion: 0.17
Nodes (11): 1. Resolver baru — `packages/db/src/crud/binance_internal.ts`, 2. Poller pakai resolver — `apps/order-bot/src/payments/binanceInternal.ts`, 3. Pemanggil lain `isBinanceInternalEnabled()` (sync → resolver async), 4. Web admin Settings — whitelist + UI, 5. Tes, Binance Internal Transfer → DB-driven config (like Bybit), Konteks penting — JANGAN keliru dua metode "Binance", Latar belakang (+3 more)

### Community 133 - "Payment-method on/off toggle (web admin) — design"
Cohesion: 0.17
Nodes (11): Caveat (surfaced in UI copy), Data layer, Design decisions (confirmed with user), Files touched (anticipated), Goal, Payment-method on/off toggle (web admin) — design, Problem, Scope (+3 more)

### Community 134 - "Design"
Cohesion: 0.17
Nodes (11): 1. Page composition (top to bottom), 2. Backend changes, 3. Frontend changes (`PaymentsPage.tsx`), 4. Error handling, 5. Testing, Design, Goals, Non-goals (+3 more)

### Community 135 - "keyboards/customer.ts"
Cohesion: 0.06
Nodes (75): ADM_TICKET_ICONS, adminMenu(), approvedResendKb(), backToAdminKb(), bannerRemovedUndoKb(), broadcastConfirmKb(), Btn, bulkPricingKb() (+67 more)

### Community 136 - "Storefront homepage — visual polish design"
Cohesion: 0.17
Nodes (11): A. Hero background — layered depth, no new colors, B. Hero right side — real product composition, C. CTA hierarchy, Current state (baseline), D. Below-the-fold card depth — interactive vs. decorative split, E. Color balance, Explicitly out of scope, F. Motion additions (+3 more)

### Community 137 - "07 — Dashboard Guidelines"
Cohesion: 0.17
Nodes (11): 07 — Dashboard Guidelines, 1. The three questions a dashboard answers, 2. Live composition (the canonical order), 3. KPI row, 4. Operational attention (`OperationCenter`), 5. Charts, 6. Recent activity, 7. Quick actions (+3 more)

### Community 138 - "Design System / Component Consistency"
Cohesion: 0.17
Nodes (11): Accordions, Alerts / Flash messages, Badges, Buttons, Cards, Design System / Component Consistency, Inputs, Modals / Drawers (+3 more)

### Community 139 - "jobs.test.ts"
Cohesion: 0.18
Nodes (4): dbMockState, makeExpiredOrder(), makeStaleTicket(), makeUnhealthy()

### Community 140 - "Plan: Admin Panel UX Pass v2 — adjusted from `ui.txt`"
Cohesion: 0.18
Nodes (10): 1. Product active/inactive toggle (`ui.txt` Catalog #10), 2. Add Category (`ui.txt` Catalog #9), 3. `apiGet` error parsing consistency, Already shipped — no work needed (cross-checked against `ui.txt`), Context, Explicitly descoped (not in this plan), Phase 1 — Catalog/Product real gaps (highest priority), Phase 2 — Per-page quick wins (existing data only, no new schema) (+2 more)

### Community 141 - "H. Slice Infrastruktur, Secrets, DB Schema & Composition Root"
Cohesion: 0.18
Nodes (11): H. Slice Infrastruktur, Secrets, DB Schema & Composition Root, Infra-10 [LOW], Infra-1 [HIGH] — lihat Admin-2 (digabung), Infra-2 [HIGH] ✅ DIPERBAIKI 2026-06-23, Infra-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Infra-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Infra-5 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Infra-6 [MEDIUM] ✅ DIPERBAIKI 2026-06-23 (+3 more)

### Community 142 - "File Structure"
Cohesion: 0.18
Nodes (10): File Structure, Global Constraints, Order-Bot Support Ticket Parity Implementation Plan, Task 1: Locale keys, Task 2: `summarizeTicketOrder` — order-summary formatter, Task 3: Keyboard changes — `ticketViewKb` reopen button + `orderPickerKb`, Task 4: `viewMyTicket` — show linked order, compute reopenable, Task 5: `callbacks.ts` — fix self-close, add reopen (+2 more)

### Community 143 - "Batch 5 — Order bot"
Cohesion: 0.18
Nodes (11): Batch 5 — Order bot, Task 26: H-6 — Don't consume restock subscriptions until each notification DM succeeds, and throttle the send loop, Task 27: H-7 — Stop the flash-sale announcement from holding one write transaction across a whole-customer-base enqueue, Task 28: M-21 — Answer `error.stale_screen` for unrecognized `v1:adm:*` admin callbacks, Task 29: M-22 — Answer unrecognized inline taps during conversation wait loops instead of leaving the button spinning, Task 30: M-23 — Route the support order-picker step through `menuAnchor` instead of leaving stray keyboards, Task 31: M-24 — Use `menuAnchor` (not `smartEdit`) for the quantity-input wizard's typed-input path, Task 32: M-25 — Exclude web-only users from the bot broadcast, and throttle it (+3 more)

### Community 144 - "Spec — Bybit di storefront + QRIS di bot (metode bayar lintas-front)"
Cohesion: 0.18
Nodes (10): 1. Masalah & tujuan, 2. Arsitektur & ekstraksi bersama (Approach A), 3. Storefront — Bybit sebagai opsi ke-3, 4. Bot — QRIS sebagai opsi ke-4, 5. Pengantaran kredensial untuk pembeli QRIS Telegram (perbaikan celah), 6. Gating, i18n, keamanan, 7. Ketergantungan webhook (ditandai), 8. Testing (ikut CLAUDE.md) (+2 more)

### Community 145 - "Catalog — Create Product Flow"
Cohesion: 0.18
Nodes (10): 1. Backend — `POST /api/catalog/products`, 2. Frontend — `ProductCreatePage`, 3. Router — `App.tsx`, 4. Tests, Architecture, Backend (`apps/web-admin/src/routes/api/catalog.test.ts` or similar), Background, Catalog — Create Product Flow (+2 more)

### Community 146 - "05 — Table Guidelines"
Cohesion: 0.18
Nodes (10): 05 — Table Guidelines, 1. Why one table component, 2. `DataTable` contract, 3. Built-in behaviors (don't reimplement these), 4. Columns, 5. Selection, 6. Row actions ("context menu"), 7. Keyboard navigation & accessibility (+2 more)

### Community 147 - "09 — Code Style"
Cohesion: 0.18
Nodes (10): 09 — Code Style, 1. Folder structure, 2. Naming conventions, 3. Composition patterns, 4. State management, 5. Design tokens in code, 6. CSS strategy, 7. Animation strategy (+2 more)

### Community 148 - "UX Recommendations"
Cohesion: 0.18
Nodes (10): 1. Fix the two broken core actions first, 2. Replace raw backend identifiers with human labels, everywhere, 3. Make empty states context-aware, not just "present", 4. Pick one "add a new record" pattern and use it consistently, 5. Settings needs wayfinding, not more content, 6. Small-viewport icon-only controls need names, not just icons, 7. Breadcrumb correctness and redundancy, 8. Search reliability (+2 more)

### Community 149 - "Order Bot — Bot Telegram + Panel Admin + Toko Web"
Cohesion: 0.18
Nodes (11): 1. Sebelum Mulai, 2. File `.env`, 3. Jalur A — Docker (disarankan), 4. Jalur B — tanpa Docker, 5. Buat Admin Pertama, 6. Pembayaran & Branding, 7. Update, Backup, Perawatan, 8. Masalah Umum (+3 more)

### Community 150 - "Bot UX (grammY)"
Cohesion: 0.20
Nodes (9): Bot UX (grammY), Edit the bubble, don't just toast, Never strand the user, No leaked English, One active keyboard per chat, Overview, Toast vs alert, When to Use (+1 more)

### Community 151 - "Backup & Restore — SQLite WAL (execution/06, M-5)"
Cohesion: 0.20
Nodes (9): Backup, Backup & Restore — SQLite WAL (execution/06, M-5), Disiplin migrasi aman (D-01 — konteks, bukan bagian skrip), Jadwal (cron, tiap 6 jam), Off-box (aturan 3-2-1), Prasyarat (host VPS), Restore (juga = rollback deploy/migrasi buruk), RTO / RPO (+1 more)

### Community 152 - "Audit Keamanan & Business-Logic — Full Repo"
Cohesion: 0.20
Nodes (9): 5 hal yang harus diperbaiki SEGERA (urutan dampak finansial), Audit Keamanan & Business-Logic — Full Repo, Catatan lintas-domain (root cause yang sama, muncul di >1 slice), D. Slice Stock, Delivery & Digital Product Security, Rekomendasi Urutan Perbaikan, Ringkasan Eksekutif, Stock-1 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Stock-2 [LOW] (+1 more)

### Community 153 - "E. Slice Admin Web Security (`apps/web-admin`)"
Cohesion: 0.20
Nodes (10): Admin-1 [HIGH] ✅ DIPERBAIKI 2026-06-23, Admin-2 [HIGH] — digabung (admin-web + infra) ✅ DIPERBAIKI 2026-06-23, Admin-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Admin-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Admin-5 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Admin-6 [LOW], Admin-7 [LOW], Admin-8 [LOW] — lihat juga Storefront-4 (+2 more)

### Community 154 - "G. Slice Bot Concurrency, Idempotency & Admin Bot Security"
Cohesion: 0.20
Nodes (10): Bot-1 [CRITICAL] ✅ DIPERBAIKI 2026-06-23, Bot-2 [HIGH] ✅ DIPERBAIKI 2026-06-23, Bot-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Bot-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Bot-5 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Bot-6 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Bot-7 [LOW], Bot-8 [LOW] (+2 more)

### Community 155 - "2. Temuan per halaman"
Cohesion: 0.20
Nodes (9): 1. Rubrik referensi (ringkasan), 2.1 Halaman List/Index (pola referensi berlaku penuh), 2.2 Halaman Detail (pola referensi sebagian besar tidak berlaku by design), 2.3 Halaman Form/Settings (pola `06_SETTINGS_GUIDELINES.md`, bukan pola list), 2.4 Dashboard, 2. Temuan per halaman, 3. Backlog terprioritaskan, 4. Pendekatan eksekusi yang disarankan (+1 more)

### Community 156 - "Sistem Inventori (Stok)"
Cohesion: 0.20
Nodes (10): Agregat status (`stockStatusCounts`), Dedup saat tambah stok massal (`bulkAddStock`), Download stok tersisa, Hapus stok (`bulkDeleteStock`) vs tandai rusak (`markStockDead`/`bulkMarkStockDead`), ⚠️ Limitasi yang diketahui: belum ada reaper TTL, Pelepasan reservasi (`releaseOrderHolds`), Reservasi atomik saat checkout (bukan saat approve), Restock subscription (+2 more)

### Community 157 - "Admin UI Consistency Design"
Cohesion: 0.20
Nodes (9): 1. Spacing convention, 2. Root fix: Dashboard's double-gap bug, 3. Component changes, 4. Page-by-page fixes, Admin UI Consistency Design, Context, Non-goals, Scope decisions (confirmed with user) (+1 more)

### Community 158 - "callbacks.ts"
Cohesion: 0.07
Nodes (11): closeTicketUser(), dispatchAdmin(), dispatchTicket(), DOMAIN_ROUTES, DomainDispatcher, Parts, sendStatic(), showFaq() (+3 more)

### Community 159 - "Design: Storefront Support Ticket Workspace (Phase 1)"
Cohesion: 0.20
Nodes (9): Backend Changes, Context, Data Model Change, Deferred to Phase 2 (needs its own spec), Design: Storefront Support Ticket Workspace (Phase 1), Error Handling, Existing Assets to Reuse (Do Not Rewrite), Information Architecture (+1 more)

### Community 160 - "00 — AI Development Rules"
Cohesion: 0.20
Nodes (9): 00 — AI Development Rules, 1. Before you touch any UI code, 2. Decision tree — which doc(s) govern this task, 3. Always reuse — never invent, 4. Components that are specified but not yet built, 5. Never do, 6. Reference implementations — read these before writing similar code, 7. Consistency over creativity (+1 more)

### Community 161 - "Design System / Component Consistency"
Cohesion: 0.20
Nodes (9): 1. Three different "create a new record" patterns (Finding F-006), 2. Breadcrumb + Back button redundancy (Finding F-008), 3. Breadcrumb label bug (Finding F-007), 4. Raw backend strings surfaced without a label map, 5. Table column header clarity, 6. Empty-state copy: contextual vs. generic, 7. Settings "Enabled" toggle + "not configured" label pairing, Design System / Component Consistency (+1 more)

### Community 162 - "Accessibility Findings"
Cohesion: 0.20
Nodes (9): Accessibility Findings, Accessible error messages, Color contrast, Form labels, Heading hierarchy, Images / alt text, Keyboard navigation, Recommendation summary (+1 more)

### Community 163 - "Implementation Plan"
Cohesion: 0.20
Nodes (9): Batch 1 — Critical correctness fix (do first, alone), Batch 2 — High-severity access/trust fixes (small, independent, safe to parallelize), Batch 3 — Checkout/cart friction pass (one PR, same files), Batch 4 — Homepage resilience (one PR), Batch 5 — Product listing & detail scaffolding (larger, plan ahead of catalog growth), Batch 6 — Design-system primitives (unlocks several Low findings at once), Batch 7 — Low-priority polish (bundle into a single cleanup PR), Implementation Plan (+1 more)

### Community 164 - "Performance UX Findings"
Cohesion: 0.20
Nodes (9): Image optimization, Interaction latency, Layout shift, Lazy loading, Loading indicators, Performance UX Findings, Recommendation summary, Skeleton loading (+1 more)

### Community 165 - "Responsive Findings"
Cohesion: 0.20
Nodes (9): Checkout, Footer, Forms, Hero, Navbar, Product grid, Responsive Findings, Summary (+1 more)

### Community 166 - "storefront/client/package.json"
Cohesion: 0.22
Nodes (8): name, private, scripts, build, dev, typecheck, type, version

### Community 167 - "web-admin/client/package.json"
Cohesion: 0.22
Nodes (8): name, private, scripts, build, dev, typecheck, type, version

### Community 168 - "admin-ui.js"
Cohesion: 0.33
Nodes (5): initAll(), initConfirm(), initDropzones(), initTabs(), refreshIcons()

### Community 169 - "UI Development Dispatch"
Cohesion: 0.22
Nodes (8): Functional-First Admin UX, Overview, Progressive Disclosure, The one rule worth repeating here, UI Development Dispatch, UI Implementation Priority, What to do, When to Use

### Community 170 - "Web Conventions (Fastify + React SPA)"
Cohesion: 0.22
Nodes (8): CSRF on every mutating route, Exposure and auth posture, Never send Telegram from the web, Overview, Settings are whitelist-only, The client is a build artifact, not source served directly, Web Conventions (Fastify + React SPA), When to Use

### Community 171 - "Deployment — public release (execution/02)"
Cohesion: 0.22
Nodes (8): 502 runbook, Access log (L-01), Deployment checklist (public release), Deployment — public release (execution/02), H-2 — TLS + reverse proxy, M-8 — container surfaces, Rollback, Topology

### Community 172 - "A. Slice Checkout & Order Creation (Ghost Orders)"
Cohesion: 0.22
Nodes (9): A. Slice Checkout & Order Creation (Ghost Orders), Checkout-1 [HIGH] ✅ DIPERBAIKI 2026-06-23, Checkout-2 [HIGH] — digabung dengan Stock-1 ✅ DIPERBAIKI 2026-06-23, Checkout-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Checkout-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Checkout-5 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Checkout-6 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Checkout-7 [LOW] (+1 more)

### Community 173 - "F. Slice Storefront Customer Auth & Checkout"
Cohesion: 0.22
Nodes (9): F. Slice Storefront Customer Auth & Checkout, Storefront-1 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Storefront-2 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Storefront-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Storefront-4 [MEDIUM] — lihat juga Admin-8 ✅ DIPERBAIKI 2026-06-23, Storefront-5 [LOW], Storefront-6 [LOW], Storefront-7 [LOW] (+1 more)

### Community 174 - "Backup & Restore"
Cohesion: 0.22
Nodes (9): Backup & Restore, Database backup, Disaster recovery, Off-box (aturan 3-2-1), Restore procedure, RTO / RPO, Uji restore (wajib berkala, bukan sekali saat setup), Uploads backup (+1 more)

### Community 175 - "bybitBscDeposit.ts"
Cohesion: 0.11
Nodes (30): paymentSuccessKb(), matchUnderpaidByAmount(), alertAdmins(), backoff, BybitBscDeposit, bybitGet(), DeliveredOrder, editBubbleToProcessing() (+22 more)

### Community 176 - "Sistem Antrian (`notification_outbox`)"
Cohesion: 0.22
Nodes (9): Backoff eksponensial (anti head-of-line blocking), Enqueue, Kapan baris outbox tidak terkirim — diagnosis cepat, Klaim atomik sebelum kirim (anti double-send), Loop dispatcher, Memantau & operasi manual, Penanganan error per jenis, Sistem Antrian (`notification_outbox`) (+1 more)

### Community 177 - "Fase 1 — Migrasi web-admin ke Next.js (Planning Document)"
Cohesion: 0.22
Nodes (8): Fase 1 — Migrasi web-admin ke Next.js (Planning Document), File structure (target), Global Constraints (warisan, berlaku untuk semua task), Inventory route lama → target (paritas), Paritas perilaku yang wajib direplika, Risiko, Testing, Urutan task (altitude tinggi)

### Community 178 - "Plan: Perbaikan UX/UI Storefront + Web-Admin"
Cohesion: 0.22
Nodes (8): Global Constraints (WAJIB dipatuhi semua task), Konteks teknis, Penyelesaian, Plan: Perbaikan UX/UI Storefront + Web-Admin, Task 1 — Login storefront muat 1 layar (HIGH), Task 2 — Telegram di settings: framing + state terhubung lebih kaya (Medium), Task 3 — Token desain: hilangkan hardcoded, tambah token radius (Medium, aman visual), Task 4 — Touch target & overflow input (Low)

### Community 179 - "Storefront Homepage Visual Polish Implementation Plan"
Cohesion: 0.22
Nodes (8): Global Constraints, Storefront Homepage Visual Polish Implementation Plan, Task 1: Shared `hoverLift` motion variant, Task 2: Hero background depth + CTA hover hierarchy, Task 3: Hero right-side product-preview composition, Task 4: Standardize interactive-card hover depth (category + contact cards), Task 5: Distinguish "coming soon" teaser cards as non-interactive, Task 6: Full verification and visual QA

### Community 180 - "Conversion Rate Optimization (CRO)"
Cohesion: 0.22
Nodes (8): Checkout friction affecting conversion, Conversion Rate Optimization (CRO), Cross-sell / upsell, CTA placement and clarity, Direct conversion blockers, Exit points, Recommendation summary (priority order), Trust and social proof

### Community 181 - "Storefront UI/UX Audit — Overview"
Cohesion: 0.22
Nodes (8): Catalog state at time of audit, Deliverables, Environment note (not a UI defect), Headline findings by severity, Most important issues, Scope, Storefront UI/UX Audit — Overview, What was tested

### Community 182 - "FlashSalesPage.test.tsx"
Cohesion: 0.25
Nodes (3): AUTO_FLASH_ROW, MANUAL_FLASH_ROW, NO_FLASH_ROW

### Community 183 - "web-admin/client/src/pages/ReviewsPage.test.tsx"
Cohesion: 0.29
Nodes (5): jsonResponse(), KPIS_DATA, mockFetchRouter(), REVIEW, REVIEWS_DATA

### Community 184 - "StockPage.test.tsx"
Cohesion: 0.25
Nodes (4): DENOM_HEALTHY, DENOM_LOW, DENOM_OUT, STOCK_DATA

### Community 185 - "CLAUDE.md"
Cohesion: 0.25
Nodes (7): Logging, Money, data, audit, Never do, Superpowers skill, Task tracking, Tests, Worktree isolation

### Community 186 - "C. Slice Pricing, Voucher, Wallet & FX"
Cohesion: 0.25
Nodes (8): C. Slice Pricing, Voucher, Wallet & FX, Pricing-1 [HIGH] ✅ DIPERBAIKI 2026-06-23, Pricing-2 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Pricing-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Pricing-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Pricing-5 [LOW], Pricing-6 [LOW], Pricing-7 [LOW]

### Community 187 - "Rollback"
Cohesion: 0.25
Nodes (8): Recovery dari deployment yang gagal, Restore dari backup (ringkasan — detail penuh di BACKUP_AND_RESTORE.md), Rollback, Rollback database, Rollback kode, Rollback migrasi skema, Rollback skrip migrasi data sekali-jalan, Verifikasi pasca-rollback

### Community 188 - "Fase 2 — Migrasi storefront ke Next.js (Planning Document)"
Cohesion: 0.25
Nodes (7): Fase 2 — Migrasi storefront ke Next.js (Planning Document), Global Constraints, Inventory route lama → target (paritas), Paritas perilaku yang wajib direplika, Risiko, Testing, Urutan task (altitude tinggi)

### Community 189 - "Catalog — Create Product Flow Implementation Plan"
Cohesion: 0.25
Nodes (7): Catalog — Create Product Flow Implementation Plan, File Map, Global Constraints, Self-Review, Task 1: Backend — `POST /api/catalog/products` + integration tests, Task 2: Frontend — `ProductCreatePage` + unit tests, Task 3: Register `/catalog/new` route in App.tsx + full suite run

### Community 190 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Admin Wallet IDR/USDT Split Implementation Plan, Global Constraints, Task 1: Backend — accept and validate `currency` on wallet adjustment, Task 2: Frontend — fix wallet types and show both balances on the Profile card, Task 3: Frontend — currency toggle on the Wallet Adjustment form, Task 4: Frontend — Currency column on the Wallet Ledger table, Task 5: Full verification

### Community 191 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Manual Verification (after Task 4), Task 1: `PaymentMethod.WALLET` + `finalizeOrderPayment` support, Task 2: `completeOrderWithWalletCredit` crud function, Task 3: Locale fixes — duplicate "USDT" + new wallet-credit strings, Task 4: Bot UI — wallet-credit submenu, zero-total Complete Order, routing, Wallet-Credit Checkout Submenu + Zero-Total Completion Implementation Plan

### Community 192 - "Batch 2 — Auth, CSRF, route security"
Cohesion: 0.25
Nodes (8): Batch 2 — Auth, CSRF, route security, Task 10: M-18 — Validate ticket attachments before writing them to disk, Task 11: M-19 — Strip the query string before logging the request URL in both error handlers, Task 12: M-20 — Add `Cache-Control: no-store` to the SPA shell responses, Task 6: H-4 — Stop serializing password hashes and emails into admin API responses, Task 7: H-5 — Lock `POST /setup/restart` after setup completes, Task 8: M-16 — Rotate the admin session jti on password change, Task 9: M-17 — Rate-limit storefront registration and password-reset submission

### Community 193 - "Batch 4 — Payment gateways and webhooks"
Cohesion: 0.25
Nodes (8): Batch 4 — Payment gateways and webhooks, Task 19: M-9 — Add a live re-check before delivering on a PayDisini callback, Task 20: M-10 — Alert admins when a webhook delivery outcome is `"stale"`, Task 21: M-11 — Stop the BSC confirmation tracker from permanently blocking delivery, Task 22: M-12 — Treat a blank NOWPayments `payment_id` as a verification failure, not a valid (empty) idempotency key, Task 23: M-13 — Flag and alert on Binance Internal overpayment, matching the other three rails, Task 24: M-14 — Make Bybit's amount-matching tolerance asymmetric so overpayment doesn't orphan the deposit, Task 25: M-15 — Move TokoPay/PayDisini credentials out of GET query strings

### Community 194 - "Hero: replace default Unsplash photo with a brand gradient"
Cohesion: 0.25
Nodes (7): Design, Docs, Goals, Hero: replace default Unsplash photo with a brand gradient, Non-goals, Problem, Testing

### Community 195 - "Accessibility Findings"
Cohesion: 0.25
Nodes (7): 1. Icon-only Search button loses its accessible name below `sm` (Finding F-009 — High), 2. Dashboard section titles are not real headings (Finding F-010 — Medium), 3. Low text contrast on muted/secondary text (Finding F-011 — Medium), Accessibility Findings, Confirmed issues, Not fully assessed (needs phase 2 follow-up), Spot-checked and passing

### Community 196 - "binance_internal.ts"
Cohesion: 0.07
Nodes (56): alertAdmins(), backoff, BinanceTx, classifyTx(), DeliveredOrder, editBubbleToProcessing(), fallThroughMirrors(), fetchIncomingTransfers() (+48 more)

### Community 197 - "Checkout"
Cohesion: 0.25
Nodes (7): Checkout, Form usability / required fields, Mobile experience, Payment selection, Recommendation summary, Steps and structure, Validation and error handling

### Community 198 - "Navigation"
Cohesion: 0.25
Nodes (7): Breadcrumbs, Categories, Footer, Header, Navigation, Recommendation summary, Search as navigation

### Community 199 - "General UX Recommendations"
Cohesion: 0.25
Nodes (7): Confirmations / toasts, Copy accuracy, Empty states (general), Forms, General UX Recommendations, Third-party integration leakage, What's already working well (worth protecting, not changing)

### Community 200 - "Panduan Update"
Cohesion: 0.25
Nodes (8): Breaking changes & restart order per jenis perubahan, Cache & "Redis", Jika update gagal, Mengapa urutannya kaku, Migrasi data sekali-jalan (`scripts/migrate-*.ts`), Panduan Update, Prosedur standar, Verifikasi pasca-update

### Community 202 - "API Reference"
Cohesion: 0.29
Nodes (7): API Reference, Mekanisme guard, storefront (`apps/storefront/src/plugins/auth.ts`), storefront — semua route, web-admin (`apps/web-admin/src/plugins/auth.ts`), web-admin — semua route, Webhook publik (di luar kedua app HTML)

### Community 203 - "B. Slice Payment Gateway & Callback Security"
Cohesion: 0.29
Nodes (7): B. Slice Payment Gateway & Callback Security, Payment-1 [HIGH] ✅ DIPERBAIKI 2026-06-23, Payment-2 [HIGH] ✅ DIPERBAIKI 2026-06-23, Payment-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Payment-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23, Payment-5 [LOW], Payment-6 [LOW]

### Community 204 - "Batch 3 — Orders, checkout, stock, delivery"
Cohesion: 0.29
Nodes (7): Batch 3 — Orders, checkout, stock, delivery, Task 13: H-2 — Let paid `PROCESSING` orders be credited to balance instead of only rejected, Task 14: H-3 — Let a failed gateway delivery be retried instead of permanently consuming its idempotency claim, Task 15: M-5 — Guard denomination `deliveryType` edits against in-flight orders, Task 16: M-6 — Wrap the bot's TokoPay/PayDisini/NOWPayments invoice caching in the existing atomic claim helpers, Task 17: M-7 — Cap storefront cart size and batch stock allocation into one insert, Task 18: M-8 — Guard `markStockDead` against altering delivered credentials

### Community 205 - "core/package.json"
Cohesion: 0.29
Nodes (6): name, private, scripts, typecheck, type, version

### Community 206 - "devDependencies"
Cohesion: 0.29
Nodes (7): devDependencies, @types/bcryptjs, @types/luxon, @types/nodemailer, @types/bcryptjs, @types/luxon, @types/nodemailer

### Community 207 - "bybitBscConfirmationTracker.ts"
Cohesion: 0.11
Nodes (21): backoff, BscScanProxyResponse, bscscanRpc(), computeConfirmations(), fetchConfirmations(), fetchLatestBlock(), fetchTxBlockNumber(), lookupFailureCounts (+13 more)

### Community 208 - "Security Patch"
Cohesion: 0.33
Nodes (5): Overview, Patch process, Security Patch, When to Use, Where this project is actually exposed

### Community 209 - "Konfigurasi"
Cohesion: 0.33
Nodes (6): Dua sumber konfigurasi, Konfigurasi, Multi-toko di satu VPS, Profil Development, Profil Produksi, Validasi (`packages/core/src/config.ts`)

### Community 210 - "Logging"
Cohesion: 0.33
Nodes (5): 1. Audit log — kalimat untuk admin toko, 2. Log Pino — pesan deskriptif untuk developer/ops, 3. Checklist singkat sebelum commit, Di mana kode-nya, Logging

### Community 211 - "Fase 3 — Bersih-bersih & finalisasi (Planning Document)"
Cohesion: 0.33
Nodes (5): Fase 3 — Bersih-bersih & finalisasi (Planning Document), Global Constraints, Risiko, Urutan task (altitude tinggi), Yang dihapus / diubah

### Community 212 - "Global Constraints"
Cohesion: 0.33
Nodes (5): Final verification (after Task 2), Global Constraints, Search Page Redesign Implementation Plan, Task 1: Replace the manual form with `FilterBar`+`SearchBar` (debounced), Task 2: Real per-table `empty` props (remove the length-guard hiding pattern)

### Community 213 - "Batch 1 — Money, pricing, reconciliation"
Cohesion: 0.33
Nodes (6): Batch 1 — Money, pricing, reconciliation, Task 1: H-1 — Fix TokoPay's QRIS fee base so discounted orders aren't rejected as short-paid, Task 2: M-1 — Prorate order-level discounts across line items so dashboard profit/margin reflect what the shop actually banked, Task 3: M-2 — Delete the VoucherRedemption row when an order holding it is released, Task 4: M-3 — Reject non-finite (`NaN`, `Infinity`) values in voucher/wallet amount guards, Task 5: M-4 — Show both wallet currencies in the bot's admin user card, and add a currency argument to `/wallet`

### Community 214 - "Navigation Analysis"
Cohesion: 0.33
Nodes (5): Current sidebar structure, Issue: duplicate page (Finding F-001), Navigation Analysis, Other IA observations, Summary recommendation for phase 2

### Community 215 - "Web Admin UI/UX Audit — Phase 1 (Audit & Document Only)"
Cohesion: 0.33
Nodes (5): Documents in this folder, Findings summary, How the app was run, Web Admin UI/UX Audit — Phase 1 (Audit & Document Only), What was covered

### Community 216 - "Responsive Findings"
Cohesion: 0.33
Nodes (5): Coverage gaps to close in phase 2, Desktop (1440×900), Mobile (375×812), Responsive Findings, Tablet (768×1024)

### Community 217 - "bybit-internal-probe.ts"
Cohesion: 0.53
Nodes (5): BybitResp, get(), internalStatusLabel(), main(), rowsOf()

### Community 218 - "check-migration-timestamps.ts"
Cohesion: 0.33
Nodes (5): foldersByTimestamp, GRANDFATHERED, GrandfatheredCollision, migrationsDir, problems

### Community 219 - "Order State Machine"
Cohesion: 0.40
Nodes (5): Diagram transisi, Invariant penting, Order State Machine, Siapa yang memicu transisi, Status & makna

### Community 220 - "bybitDeposit.ts"
Cohesion: 0.14
Nodes (22): alertAdmins(), backoff, BybitDeposit, bybitGet(), DeliveredOrder, editBubbleToProcessing(), fetchRecentDeposits(), normalizeInternalDeposit() (+14 more)

### Community 221 - "Panduan Patch (Bugfix)"
Cohesion: 0.40
Nodes (5): Contoh terisi — insiden `claimed_at` (2026-06-24), Kapan migrasi dianggap "required", Outbox notification gagal: `P2022 column claimed_at does not exist`, Panduan Patch (Bugfix), Template

### Community 222 - "Backend Audit Fixes — High + Medium (2026-07-31)"
Cohesion: 0.40
Nodes (4): Backend Audit Fixes — High + Medium (2026-07-31), Batch 7 — Operations Center cross-gateway payments visibility (added mid-execution), Global Constraints, Task 47: Make the "Failed Deliveries" Operation Center card show data from every payment gateway, not just Binance

### Community 223 - "Homepage"
Cohesion: 0.40
Nodes (4): Hero, Homepage, Recommendation summary, Sections below the fold

### Community 224 - "Product Listing and Product Detail"
Cohesion: 0.40
Nodes (4): Product detail (`/p/capcut-pro-1-month`), Product Listing and Product Detail, Product listing (Category `/c/premium-apps`, Search `/search`), Recommendation summary

### Community 225 - "Versioning"
Cohesion: 0.40
Nodes (5): Cara menandai rilis ke depan, Riwayat versi (rekonstruksi retroaktif dari git log), Skema: Semantic Versioning (MAJOR.MINOR.PATCH), Status saat ini, Versioning

### Community 229 - "Dokumentasi `telegram-order-bot` — Indeks"
Cohesion: 0.67
Nodes (3): Daftar dokumen, Dokumentasi `telegram-order-bot` — Indeks, Sumber kebenaran

### Community 231 - "paydisiniReconcile.ts"
Cohesion: 0.09
Nodes (35): alertAdmins(), AnchoredOrder, editBubbleToSuccess(), PendingOrder, pollOnce(), reconcileOrder(), startPolling(), sweepDeliveredAwaitingEdit() (+27 more)

### Community 259 - "dispatcher.ts"
Cohesion: 0.08
Nodes (46): DeliverableOrder, sendAccountFile(), accountFileName(), buildAccountFileContent(), buildDeliveryCaption(), DeliveredItem, groupCredentials(), warrantyDaysFor() (+38 more)

### Community 280 - "qr.ts"
Cohesion: 0.53
Nodes (4): HERE, qrPhotoArg(), QrValue, resolveQrValue()

### Community 306 - "server/test/setup-env.ts"
Cohesion: 0.40
Nodes (3): dir, file, ROOT

### Community 308 - "apiGet"
Cohesion: 0.08
Nodes (24): apiGet(), ReferralData, APP_VERSION, DRAWER_ICON, DrawerRow(), drawerRowClass(), FOOTER_LINKS, Layout() (+16 more)

### Community 309 - "lib/i18n.ts"
Cohesion: 0.12
Nodes (19): apiPatch(), AdditionalField, OrderDetailData, DeliveryFieldInput(), allFieldsValid(), fieldError(), emailField, numberField (+11 more)

### Community 310 - "storefront/client/src/pages/TicketDetailPage.tsx"
Cohesion: 0.08
Nodes (24): apiPost(), apiPostFormWithProgress(), csrfToken(), SupportData, TicketDetailData, ProgressBar(), ProgressBarProps, TicketComposer() (+16 more)

### Community 312 - "storefront/client/src/api/client.ts"
Cohesion: 0.08
Nodes (23): publicPost(), SettingsData, FlashProps, PasswordInput(), PasswordInputProps, Spinner(), TelegramWidgetOptions, useTelegramWidget() (+15 more)

### Community 314 - "AccountPage.tsx"
Cohesion: 0.08
Nodes (34): AccountOrdersData, AccountOrderSummary, Price(), PriceProps, formatIdr(), formatNativeUsdt(), formatUsdt(), formatUsdtAmount() (+26 more)

### Community 316 - "storefront/client/src/pages/ReviewsPage.tsx"
Cohesion: 0.14
Nodes (8): AccountReview, PendingReview, ReviewsData, StarsProps, PendingReviewCard(), ReviewsPage(), ReviewSubmission, reviewsData

### Community 342 - "TicketMessageThread.tsx"
Cohesion: 0.15
Nodes (14): TicketMessage, AttachmentGallery(), extOf(), VIDEO_EXT, dateGroupLabel(), MessageBubble(), SYSTEM_ICON, SystemEventRow() (+6 more)

### Community 346 - "storefront/client/src/App.tsx"
Cohesion: 0.06
Nodes (28): AboutPage, AccountPage, CartPage, CheckoutPage, ForgotPage, HowToOrderPage, LoginPage, OrderDetailPage (+20 more)

### Community 378 - "shop/StatusBadge.tsx"
Cohesion: 0.36
Nodes (8): AMBER, GRASS, PINE, RUST, STATUS_LABELS, StatusBadge(), StatusBadgeProps, titleCase()

### Community 413 - "storefront/src/plugins/auth.ts"
Cohesion: 0.11
Nodes (34): b64url(), constantTimeEqual(), cookieSecret(), CustomerSession, makeCustomerSession(), newJti(), readCustomerSession(), shopSessionJtiKey() (+26 more)

### Community 422 - "pageData.ts"
Cohesion: 0.11
Nodes (42): BulkMap, isSortKey(), ProductCard, RatingMap, shapeProducts(), SORT_KEYS, SortKey, sortProductCards() (+34 more)

### Community 431 - "storefront/src/server.ts"
Cohesion: 0.10
Nodes (33): esc(), HERE, renderSpecialShell(), SPA_INDEX_PATH, SpecialShellOpts, staticFallbackHtml(), EXCLUDED, isExcluded() (+25 more)

### Community 434 - "apiAccount.ts"
Cohesion: 0.14
Nodes (23): HERE, IMAGE_MIME, ParsedAttachment, parseTicketMultipart(), TICKET_DIR, TicketSubmission, VIDEO_MIME, writeAttachment() (+15 more)

### Community 444 - "apiAuth.ts"
Cohesion: 0.11
Nodes (32): accountFailures, accountLockedOut(), attempts, clientIp(), forgotEmailHits, forgotEmailRateLimited(), loginRateLimited(), pruneFailures() (+24 more)

### Community 458 - "routes/checkout.ts"
Cohesion: 0.08
Nodes (49): CachedGateway, checkoutRoutes(), checkoutView(), computeTotals(), OrderRow, parseCachedGateway(), parseCachedGatewayJson(), parseCachedNowpaymentsGateway() (+41 more)

### Community 462 - "crud/orders.ts"
Cohesion: 0.08
Nodes (39): performWalletCheckout(), addMinutes(), utcStamp(), computeUniqueCents(), generateOrderCode(), generatePaymentRef(), pick(), quantizeMoney() (+31 more)

### Community 464 - "buildApp"
Cohesion: 0.08
Nodes (18): buildApp(), redactPath(), seedProduct(), loginAs(), makeBuyerWithOrder(), mockCreateTransaction, disableNowpayments(), enableNowpayments() (+10 more)

### Community 475 - "web-admin/client/src/api/client.ts"
Cohesion: 0.06
Nodes (39): apiDelete(), apiGet(), apiPatch(), apiPost(), csrfToken(), logout(), throwForResponse(), useHealth() (+31 more)

### Community 480 - "web-admin/client/src/App.tsx"
Cohesion: 0.07
Nodes (20): publicPost(), Label(), BootstrapPage(), BootstrapResult, getAdminIds(), ForgotPage(), ForgotResult, LoginPage() (+12 more)

### Community 481 - "additionalFields.ts"
Cohesion: 0.16
Nodes (17): AdditionalField, AdditionalFieldDraft, AdditionalFieldsEditor(), DeliveryMethod, DeliveryTypeSection(), methodOf(), RadioGroup(), RadioGroupItem() (+9 more)

### Community 483 - "CatalogPage.tsx"
Cohesion: 0.03
Nodes (75): AnalyticsCurrency, AnalyticsMetric, AnalyticsPoint, AnalyticsRange, CurrencyProfit, DashboardKpis, ExpirationRow, HealthLevel (+67 more)

### Community 496 - "web-admin/client/src/pages/ReviewsPage.tsx"
Cohesion: 0.05
Nodes (50): App(), Tooltip(), TooltipContent(), TooltipProvider(), TooltipTrigger(), CustomersKpis, useCustomersKpis(), useDebouncedValue() (+42 more)

### Community 498 - "AppShell.tsx"
Cohesion: 0.15
Nodes (11): AppShell(), QUICK_ACTIONS, TopBar(), TopBarProps, PageTransition(), EASE, fadeIn, fadeUp (+3 more)

### Community 499 - "web-admin/client/src/pages/SupportPage.tsx"
Cohesion: 0.05
Nodes (53): CardRow(), CardRowProps, buildPageWindow(), Pagination(), TicketPriorityBadge(), TicketPriorityBadgeProps, TONE_CLASS, TicketStatusBadge() (+45 more)

### Community 500 - "VouchersPage.tsx"
Cohesion: 0.06
Nodes (62): ConfirmDialog(), ConfirmDialogProps, CurrencyStack(), formatCurrencyDisplay(), formatCurrencyParts(), formatUsdtAmount(), trimTrailingZeros(), Phase (+54 more)

### Community 506 - "AuditPage.tsx"
Cohesion: 0.13
Nodes (15): DateInput(), AdminRow, AdminsResponse, useAdmins(), AuditResponse, AuditRow, useAudit(), ACTION_LABELS (+7 more)

### Community 507 - "ErrorBoundary.tsx"
Cohesion: 0.29
Nodes (3): ErrorBoundary, ErrorBoundaryProps, ErrorBoundaryState

### Community 508 - "OrderStatusBadge.tsx"
Cohesion: 0.27
Nodes (7): BUCKET_STYLE, BucketStyle, FALLBACK_STYLE, OrderStatusBadge(), OrderStatusBadgeProps, ORDER_STATUS_LABELS, orderStatusLabel()

### Community 509 - "button.tsx"
Cohesion: 0.05
Nodes (71): FIELD_TYPES, FilterBar(), FilterBarProps, PageHeader(), PageHeaderProps, PageLayout(), PaginationProps, StatusBadge() (+63 more)

### Community 511 - "web-admin/client/src/pages/OrdersPage.tsx"
Cohesion: 0.10
Nodes (27): FAMILY_CLASS, PaymentMethodBadge(), PaymentMethodBadgeProps, RAIL_FAMILY, RailFamily, OrdersKpis, useOrdersKpis(), PAYMENT_METHOD_LABELS (+19 more)

### Community 512 - "web-admin/client/src/pages/SettingsPage.tsx"
Cohesion: 0.05
Nodes (43): EXT_MIME, ImageUploadField(), saveButtonContent(), UploadPhase, ProgressBar(), ProgressBarProps, ProgressBarTone, TONE_CLASS (+35 more)

### Community 515 - "SettingsNav.tsx"
Cohesion: 0.13
Nodes (13): prefersReducedMotion(), readExpandedStorage(), SettingsNav(), SettingsNavGroup, SettingsNavLink, SettingsNavProps, BOTTOM, GROUP (+5 more)

### Community 553 - "Sidebar.tsx"
Cohesion: 0.19
Nodes (8): NAV_GROUPS, NavGroup, NavItemConfig, Sidebar(), SidebarContent(), SidebarProps, ShopInfo, useShopInfo()

### Community 566 - "cn"
Cohesion: 0.03
Nodes (85): Column, DataTable(), DataTableProps, MotionCardRow, MotionTableBody, MotionTableRow, COLUMNS, Row (+77 more)

### Community 575 - "sonner.tsx"
Cohesion: 0.13
Nodes (10): Toaster(), ROW, SETTINGS_DATA, maskCredential(), STOCK_PRODUCT_DATA, ADMIN_ROW, BASE_DETAIL, BASE_TICKET (+2 more)

### Community 578 - "ImageUploadField.test.tsx"
Cohesion: 0.13
Nodes (3): FILE, BROADCAST, FakeXHR

### Community 579 - "setSetting"
Cohesion: 0.05
Nodes (69): accountFailures, accountLockedOut(), attempts, b64url(), base32Decode(), base32Encode(), consumeResetCode(), cookieSecret() (+61 more)

### Community 580 - "web-admin/src/plugins/auth.ts"
Cohesion: 0.13
Nodes (28): AdminSession, constantTimeEqual(), isWebRole(), readSession(), WEB_ROLES, WebRole, webRoleKey(), canMutate() (+20 more)

### Community 597 - "displayDateTime"
Cohesion: 0.16
Nodes (16): displayDate(), displayDateTime(), auditApiRoutes(), parseDate(), outboxApiRoutes(), STATUS_VALUES, NotificationStatus, AuditFilter (+8 more)

### Community 599 - "currentAdmin"
Cohesion: 0.08
Nodes (39): validateAttachment(), flashOrRedirect(), redirectWithFlash(), deleteOldUpload(), handleUpload(), HandleUploadOpts, CONVERTIBLE_EXTENSIONS, deleteWebpVariants() (+31 more)

### Community 607 - "connectionTest.ts"
Cohesion: 0.11
Nodes (24): signedIpn(), binanceSign(), bybitSignedGet(), classifyCheckError(), CONNECTION_TESTS, ConnectionTestResult, errorMessage(), testBinanceInternal() (+16 more)

### Community 613 - "telegramCheck.ts"
Cohesion: 0.17
Nodes (10): ChannelCheck, checkChannelWithTelegram(), checkTokenWithTelegram(), FileResolution, getFileResolver(), normalizeChannelInput(), setChannelValidator(), setFileResolver() (+2 more)

### Community 643 - "dashboard.ts"
Cohesion: 0.08
Nodes (47): dashboardApiRoutes(), shapeRevenue(), trendPct(), csvField(), csvRow(), reportsApiRoutes(), RFC-4180, addDays() (+39 more)

### Community 645 - "api/orders.ts"
Cohesion: 0.11
Nodes (29): buildOrderFilter(), BULK_ACTIONS, BulkAction, csvField(), csvRow(), ordersApiRoutes(), PAGE_SIZE_OPTIONS, parseDate() (+21 more)

### Community 649 - "crud/reviews.ts"
Cohesion: 0.12
Nodes (31): buildReviewFilter(), MANUAL_STATUS_VALUES, reviewsApiRoutes(), SENTIMENT_VALUES, SOURCE_VALUES, STATUS_VALUES, ReviewSentiment, ReviewSource (+23 more)

### Community 650 - "web-admin/src/server.ts"
Cohesion: 0.09
Nodes (26): authPlugin(), EXCLUDED, isExcluded(), setupGate(), searchApiRoutes(), DB_FILE, folderStats(), storageApiRoutes() (+18 more)

### Community 652 - "api/stock.ts"
Cohesion: 0.24
Nodes (16): csvField(), csvRow(), stockApiRoutes(), stockStatusLabel(), RFC-4180, listAllDenominations(), countRestockSubscribers(), restockSubscriberCounts() (+8 more)

### Community 654 - "api/support.ts"
Cohesion: 0.13
Nodes (25): buildTicketFilter(), BULK_ACTIONS, BulkAction, CATEGORY_VALUES, classifyDetails(), csvField(), csvRow(), deriveSubject() (+17 more)

### Community 656 - "crud/vouchers.ts"
Cohesion: 0.20
Nodes (20): VOUCHER_SCOPES, VOUCHER_STATUSES, VOUCHER_TYPES, vouchersApiRoutes(), VoucherScope, bulkDeleteVouchers(), bulkSetVouchersActive(), deleteVoucher() (+12 more)

### Community 677 - "getSetting"
Cohesion: 0.08
Nodes (54): Config, globalForPrisma, Tx, resolveAdminIds(), deliverPaidInternalOrder(), BybitBscPollHealth, deliverPaidBybitBscOrder(), EMPTY_BYBIT_BSC_HEALTH (+46 more)

### Community 727 - "core.test.ts"
Cohesion: 0.33
Nodes (7): fetchUsdIdrMarketRate(), roundRateToStep(), fmtMoney(), money(), moneyEq(), fxFetcher(), refreshUsdIdrRate()

### Community 770 - "web.test.ts"
Cohesion: 0.04
Nodes (46): pendingVerificationOrder(), makeProcessingOrder(), deliverOrder(), makeOrder(), makeProcessingOrder(), makeTokopayPendingOrder(), pendingVerificationOrder(), containsKeyDeep() (+38 more)

### Community 865 - "createDenomination"
Cohesion: 0.09
Nodes (39): makeManualDenom(), makeManualWithInfoDenom(), makeManualWithInfoDenom(), ensureStock(), makeManualDenom(), makeManualWithInfoDenom(), makeProductWithTwo(), seedLoose() (+31 more)

### Community 906 - "config.ts"
Cohesion: 0.15
Nodes (8): csvNumbers, Env, looseBool, rootEnv, orNull(), parseChannelId(), resolveBotCredentials(), ResolvedBotCredentials

### Community 908 - "n"
Cohesion: 0.53
Nodes (4): missingTables(), PAYMENT_LEDGER_TABLES, stubDb(), n()

### Community 1056 - "storageMaintenance.test.ts"
Cohesion: 0.24
Nodes (14): TicketStatus, checkpointWal(), clearBroadcastImage(), clearTicketAttachments(), listBroadcastsForImageCleanup(), listTicketsForAttachmentCleanup(), pruneExpiredPasswordResetTokens(), pruneSentOutbox() (+6 more)

### Community 1157 - "catalogRename.ts"
Cohesion: 0.13
Nodes (20): Cell, DEP_COLUMNS, DEP_DDL, hasColumn(), hasTable(), migrateCatalogRename(), POST_INDEXES, Row (+12 more)

## Knowledge Gaps
- **2955 isolated node(s):** `name`, `version`, `private`, `type`, `./main` (+2950 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **31 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `msg()` connect `conversations/admin.ts` to `web-admin/client/src/App.tsx`, `handlers.test.ts`?**
  _High betweenness centrality (0.071) - this node is a cross-community bridge._
- **Why does `LoginPage()` connect `web-admin/client/src/App.tsx` to `conversations/admin.ts`?**
  _High betweenness centrality (0.071) - this node is a cross-community bridge._
- **Why does `t()` connect `t` to `HomePage.tsx`, `StaticPage.tsx`, `storefront/client/src/App.tsx`, `apiGet`, `lib/i18n.ts`, `storefront/client/src/pages/TicketDetailPage.tsx`, `TicketMessageThread.tsx`, `storefront/client/src/api/client.ts`, `AccountPage.tsx`, `storefront/client/src/pages/ReviewsPage.tsx`, `ProductPage.tsx`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _2955 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `exports` be split into smaller, more focused modules?**
  _Cohesion score 0.08333333333333333 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._
- **Should `exports` be split into smaller, more focused modules?**
  _Cohesion score 0.06060606060606061 - nodes in this community are weakly interconnected._