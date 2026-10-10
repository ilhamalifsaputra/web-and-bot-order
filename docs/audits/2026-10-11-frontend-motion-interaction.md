# Audit frontend motion dan interaction Trustance

Tanggal: 11 Oktober 2026 (Asia/Jakarta). Baseline: `c7b081f8`; branch `worktree-frontend-motion-audit`. Bagian audit/rencana awal ditulis sebelum application source berubah. Hasil implementasi/validasi ditambahkan setelah pengujian.

## A. Executive summary dan RECON

FACT: integration checkout bersih pada master. Implementasi berlangsung dalam worktree terpisah `frontend-motion-audit`, port 8349/8350. Database task `trustance_motion_audit` dibuat terpisah dalam Postgres lokal yang sudah berjalan; bot tidak dijalankan. Env disalin ke file ignored tanpa mencatat nilainya.

FACT: monorepo pnpm 9.15.9; React 18.3.1, Router 7.18.2, Tailwind 4.3.1, Vite 6.4.3, TanStack Query 5; dua React SPA di `apps/storefront/client` dan `apps/web-admin/client`; backend Fastify/Prisma/PostgreSQL dan bot berada di luar perubahan. Versi berasal dari manifest/lockfile, bukan asumsi brief. Kedua main.tsx memasang StrictMode, QueryClientProvider, BrowserRouter dan MotionConfig reducedMotion=user. Admin menggunakan Radix, Sonner dan Recharts; storefront memiliki primitives sendiri. ErrorBoundary admin berada dalam shell; storefront memiliki ErrorPage dan server-meta override untuk setup/error.

FACT: graphify query dijalankan sebelum penelusuran source; hasil mengarah ke App, motion, ProductCard dan dokumentasi arsitektur. Dokumen `docs/archive/ui-refactor/**` mengandung temuan historis: klaim tidak adanya modal/toast/skeleton sudah tidak berlaku untuk source sekarang.

Baseline: install frozen lockfile, prisma:generate dan pnpm -r build PASS. Empat file tes yang ditemukan dari lima path kandidat: 35 tes PASS (tidak ada MobileDrawer.test.tsx pada lokasi kandidat). Browser Chromium lokal memakai bundle production dan mock API, tanpa pembayaran atau mutasi server. Screenshot awal: `.audit-data/motion/before-admin-mobile.png`, `before-admin-desktop.png`. Baseline browser menemukan 22 link di drawer mobile tertutup, Escape tidak menutup drawer, Escape tidak menutup quick actions, trigger quick actions tidak memiliki aria-expanded. Ini bukti baseline, bukan hasil seluruh route.

Root cause: overlay manual melewati primitive aksesibilitas yang sudah tersedia; dua sistem entrance (CSS main + route Motion); opacity/stagger pada daftar informasi utama; fallback reveal berbasis timeout; kebijakan reduced motion JS belum mencakup CSS/scroll. Tidak diperlukan redesign branding atau rewrite transaksi.

## B. Source evidence dan seluruh route aktual

Legenda: **planned** berarti perubahan shared shell/primitive atau page yang disebut; **no change needed** berarti tidak ditemukan alasan motion untuk mengubah page pada inspeksi ini, bukan sertifikasi bebas bug; **out of scope** untuk gallery dev. Audit route bersifat source-level; runtime yang diuji hanya tercantum di validation log. Kolom state adalah indikator yang benar-benar ditemukan dalam source page, bukan klaim seluruh state sudah lolos runtime.

| App / boundary | Route | Main component / evidence | Status rencana | Indikator state/interaksi di source |
|---|---|---|---|---|
| storefront / auth/setup | `/login` | `apps/storefront/client/src/App.tsx:93` / `LoginPage` | no change needed | loading, error, selection, async |
| storefront / auth/setup | `/register` | `apps/storefront/client/src/App.tsx:94` / `RegisterPage` | no change needed | loading, error, async |
| storefront / auth/setup | `/forgot` | `apps/storefront/client/src/App.tsx:95` / `ForgotPage` | no change needed | loading, error, async |
| storefront / auth/setup | `/reset/:token` | `apps/storefront/client/src/App.tsx:96` / `ResetPage` | no change needed | loading, error, async, status |
| storefront / shop | `/__ui` | `apps/storefront/client/src/App.tsx:100` / `UiGalleryPage` | out of scope | loading, error, empty, selection, status |
| storefront / shop | `/` | `apps/storefront/client/src/App.tsx:103` / `HomePage` | planned (page + shared) | loading, error, empty, async, status |
| storefront / shop | `/c/:slug` | `apps/storefront/client/src/App.tsx:104` / `CategoryPage` | planned (page + shared) | loading, error, empty, async, status |
| storefront / shop | `/categories` | `apps/storefront/client/src/App.tsx:105` / `CategoriesPage` | planned (page + shared) | loading, empty, async |
| storefront / shop | `/products` | `apps/storefront/client/src/App.tsx:106` / `ProductsPage` | planned (page + shared) | loading, empty, async |
| storefront / shop | `/flash` | `apps/storefront/client/src/App.tsx:107` / `FlashPage` | planned (shared shell) | loading, error, empty, async |
| storefront / shop | `/p/:slug` | `apps/storefront/client/src/App.tsx:108` / `ProductPage` | planned (page + shared) | loading, error, empty, selection, async, status |
| storefront / shop | `/search` | `apps/storefront/client/src/App.tsx:112` / `SearchRedirect` | planned (shared shell) | static / inspect shell |
| storefront / shop | `/cart` | `apps/storefront/client/src/App.tsx:113` / `CartPage` | planned (shared shell) | loading, empty, async |
| storefront / shop | `/checkout` | `apps/storefront/client/src/App.tsx:114` / `CheckoutPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| storefront / shop | `/checkout/:code/pay` | `apps/storefront/client/src/App.tsx:115` / `PayPage` | planned (shared shell) | loading, error, selection, async, status |
| storefront / shop | `/track` | `apps/storefront/client/src/App.tsx:116` / `TrackOrderPage` | planned (shared shell) | loading, error, empty, async |
| storefront / account | `/wallet/topup` | `apps/storefront/client/src/App.tsx:119` / `WalletTopupPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| storefront / account | `/wallet/topup/:code/pay` | `apps/storefront/client/src/App.tsx:120` / `PayPage` | planned (shared shell) | loading, error, selection, async, status |
| storefront / account | `/account` | `apps/storefront/client/src/App.tsx:121` / `AccountPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| storefront / account | `/account/orders` | `apps/storefront/client/src/App.tsx:122` / `OrdersPage` | planned (shared shell) | loading, error, empty, async, status |
| storefront / account | `/account/orders/:code` | `apps/storefront/client/src/App.tsx:123` / `OrderDetailPage` | planned (page + shared) | loading, error, async, status |
| storefront / account | `/account/referral` | `apps/storefront/client/src/App.tsx:124` / `ReferralPage` | planned (shared shell) | loading, error, async, status |
| storefront / account | `/account/reviews` | `apps/storefront/client/src/App.tsx:125` / `ReviewsPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| storefront / account | `/account/support` | `apps/storefront/client/src/App.tsx:126` / `SupportPage` | planned (shared shell) | loading, error, empty, async, status |
| storefront / account | `/account/support/:id` | `apps/storefront/client/src/App.tsx:127` / `TicketDetailPage` | planned (shared shell) | loading, error, empty, async, status |
| storefront / account | `/account/settings` | `apps/storefront/client/src/App.tsx:128` / `SettingsPage` | planned (shared shell) | loading, error, async, status |
| storefront / shop | `/help` | `apps/storefront/client/src/App.tsx:129` / `HelpPage` | planned (page + shared) | loading, error, empty, selection, async, status |
| storefront / shop | `/about` | `apps/storefront/client/src/App.tsx:131` / `AboutPage` | planned (shared shell) | static / inspect shell |
| storefront / shop | `/contact` | `apps/storefront/client/src/App.tsx:132` / `ContactPage` | planned (shared shell) | static / inspect shell |
| storefront / shop | `/how-to-order` | `apps/storefront/client/src/App.tsx:133` / `HowToOrderPage` | planned (shared shell) | static / inspect shell |
| storefront / shop | `/terms` | `apps/storefront/client/src/App.tsx:134` / `TermsPage` | planned (shared shell) | static / inspect shell |
| storefront / shop | `/privacy` | `apps/storefront/client/src/App.tsx:135` / `PrivacyPage` | planned (shared shell) | static / inspect shell |
| storefront / shop | `/refund` | `apps/storefront/client/src/App.tsx:136` / `RefundPage` | planned (shared shell) | static / inspect shell |
| storefront / shop | `*` | `apps/storefront/client/src/App.tsx:139` / `ErrorPage` | planned (shared shell) | error, status |
| web-admin / admin shell (server auth) | `/` | `apps/web-admin/client/src/App.tsx:88` / `DashboardPage` | planned (shared shell) | static / inspect shell |
| web-admin / admin shell (server auth) | `/orders` | `apps/web-admin/client/src/App.tsx:89` / `OrdersPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/orders/:orderId` | `apps/web-admin/client/src/App.tsx:90` / `OrderDetailPage` | planned (page + shared) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/catalog` | `apps/web-admin/client/src/App.tsx:91` / `CatalogPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/catalog/digiflazz-sync` | `apps/web-admin/client/src/App.tsx:92` / `DigiflazzSyncPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/catalog/new` | `apps/web-admin/client/src/App.tsx:93` / `ProductCreatePage` | planned (shared shell) | loading, error, empty, async |
| web-admin / admin shell (server auth) | `/catalog/:productId/denominations/new` | `apps/web-admin/client/src/App.tsx:94` / `DenominationCreatePage` | planned (shared shell) | loading, error, empty, async |
| web-admin / admin shell (server auth) | `/catalog/:productId/denominations/:denomId/edit` | `apps/web-admin/client/src/App.tsx:95` / `DenominationEditPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/catalog/:productId` | `apps/web-admin/client/src/App.tsx:96` / `ProductDetailPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/categories` | `apps/web-admin/client/src/App.tsx:99` / `CategoriesPage` | planned (page + shared) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/stock` | `apps/web-admin/client/src/App.tsx:100` / `StockPage` | planned (shared shell) | loading, error, empty, async, status |
| web-admin / admin shell (server auth) | `/stock/:productId` | `apps/web-admin/client/src/App.tsx:101` / `StockProductPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/flash-sales` | `apps/web-admin/client/src/App.tsx:102` / `FlashSalesPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/users` | `apps/web-admin/client/src/App.tsx:103` / `UsersPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/users/:userId` | `apps/web-admin/client/src/App.tsx:104` / `UserDetailPage` | planned (shared shell) | loading, error, empty, async, status |
| web-admin / admin shell (server auth) | `/vouchers` | `apps/web-admin/client/src/App.tsx:105` / `VouchersPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/admins` | `apps/web-admin/client/src/App.tsx:106` / `AdminsPage` | planned (shared shell) | loading, error, empty, async |
| web-admin / admin shell (server auth) | `/payments` | `apps/web-admin/client/src/App.tsx:107` / `PaymentsPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/wallet-transactions` | `apps/web-admin/client/src/App.tsx:108` / `WalletTransactionsPage` | planned (shared shell) | loading, error, empty, status |
| web-admin / admin shell (server auth) | `/settlements` | `apps/web-admin/client/src/App.tsx:109` / `SettlementsPage` | planned (shared shell) | loading, error, empty, async, status |
| web-admin / admin shell (server auth) | `/outbox` | `apps/web-admin/client/src/App.tsx:110` / `OutboxPage` | planned (shared shell) | loading, error, empty, async, status |
| web-admin / admin shell (server auth) | `/reports` | `apps/web-admin/client/src/App.tsx:111` / `ReportsPage` | planned (shared shell) | loading, error, empty, async, status |
| web-admin / admin shell (server auth) | `/reviews` | `apps/web-admin/client/src/App.tsx:112` / `ReviewsPage` | planned (shared shell) | loading, error, empty, async, status |
| web-admin / admin shell (server auth) | `/audit` | `apps/web-admin/client/src/App.tsx:113` / `AuditPage` | planned (shared shell) | loading, error, status |
| web-admin / admin shell (server auth) | `/broadcast` | `apps/web-admin/client/src/App.tsx:114` / `BroadcastPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/support` | `apps/web-admin/client/src/App.tsx:115` / `SupportPage` | planned (shared shell) | loading, error, empty, selection, async, status |
| web-admin / admin shell (server auth) | `/support/:ticketId` | `apps/web-admin/client/src/App.tsx:116` / `TicketDetailPage` | planned (shared shell) | loading, error, selection, async, status |
| web-admin / admin shell (server auth) | `/tasks` | `apps/web-admin/client/src/App.tsx:117` / `TasksPage` | planned (shared shell) | loading, error, empty, async, status |
| web-admin / admin shell (server auth) | `/settings` | `apps/web-admin/client/src/App.tsx:118` / `SettingsPage` | planned (shared shell) | loading, error, selection, async, status |
| web-admin / admin shell (server auth) | `/branding` | `apps/web-admin/client/src/App.tsx:119` / `BrandingPage` | planned (shared shell) | loading, error, async |
| web-admin / admin shell (server auth) | `/storage` | `apps/web-admin/client/src/App.tsx:120` / `StoragePage` | planned (shared shell) | loading, error, async |
| web-admin / admin shell (server auth) | `/search` | `apps/web-admin/client/src/App.tsx:121` / `SearchPage` | planned (shared shell) | error, empty, async |
| web-admin / admin shell (server auth) | `*` | `apps/web-admin/client/src/App.tsx:122` / `NotFoundPage` | planned (shared shell) | static / inspect shell |
| web-admin / auth/setup | `/login` | `apps/web-admin/client/src/App.tsx:126` / `LoginPage` | no change needed | loading, error |
| web-admin / auth/setup | `/forgot` | `apps/web-admin/client/src/App.tsx:127` / `ForgotPage` | no change needed | loading, error |
| web-admin / auth/setup | `/reset` | `apps/web-admin/client/src/App.tsx:128` / `ResetPage` | no change needed | loading, error |
| web-admin / auth/setup | `/bootstrap` | `apps/web-admin/client/src/App.tsx:129` / `BootstrapPage` | no change needed | loading, error |
| web-admin / auth/setup | `/setup` | `apps/web-admin/client/src/App.tsx:132` / `SetupBotPage` | no change needed | loading, error |
| web-admin / auth/setup | `/setup/owner` | `apps/web-admin/client/src/App.tsx:133` / `SetupOwnerPage` | no change needed | loading, error |
| web-admin / auth/setup | `/setup/shop` | `apps/web-admin/client/src/App.tsx:134` / `SetupShopPage` | no change needed | loading, error |
| web-admin / auth/setup | `/setup/done` | `apps/web-admin/client/src/App.tsx:135` / `SetupDonePage` | no change needed | loading, error, async |

Storefront `/search` adalah SearchRedirect ke overlay pada `/`, bukan page hasil baru. ProductPage mendelegasikan checkout instant ke InstantBuyPage berdasarkan data produk; tidak ada route `/instant-buy`. SetupPendingPage dan ErrorPage server-meta bukan route baru. Tidak ditemukan route khusus notification; cart/wallet/help/support ada. Tidak menambahkan route untuk gift-card/AI/VPN; taxonomy frontend nyata menggunakan PREMIUM_APPS/GAME_TOPUP dan resolver legacy, bukan identitas produk yang ditebak. Admin guard utama ada di server/API; tidak menciptakan role client.

## C. Findings inventory (AUDIT)

| Domain | Route/component verified | Current behavior (FACT) / evidence | Root cause / issue | Severity | Direction / confidence |
|---|---|---|---|---|---|
| Keyboard | Admin Sidebar.tsx:224+ | drawer tertutup hanya translateX; 22 anchor masih mounted; Escape browser tidak menutup | overlay manual tanpa modal semantics/inert/focus trap | P0 | Radix Dialog drawer, unmount closed, restore trigger; high |
| Keyboard | Admin TopBar.tsx:61-150 | quick/user menu manual; browser Escape tetap terbuka; trigger lacks expanded | menu manual tanpa keyboard/focus management | P0 | reuse DropdownMenu Radix; high |
| Dialog | Admin SearchModal.tsx:65-206 | focus timeout 50ms; overlay div; Escape ada, trap/restore/label input tidak ada | accessible primitive tidak dipakai | P0 | Radix Dialog + Motion panel, immediate initial focus, cleanup; high |
| Focus | Storefront useDialogA11y.ts:83-127; MobileDrawer.tsx:154-183 | effect depends on callback identity; caller Modal harness memberi inline callback; Layout sendiri sudah memoized | rerender bisa restore/refocus saat pengguna mengetik; inference didukung dependency effect | P0 | latest callback ref; stable focus lifecycle; high source, runtime regression test required |
| Overlay exit | Storefront Modal.tsx:76+ dan SearchOverlay.tsx:238+ | AnimatePresence mempertahankan overlay setelah open=false; a11y cleanup segera terjadi | exiting overlay berpotensi menutup target fokus; inference | P0 | exiting visual layer inert dan pointer-events:none; browser rapid reopen/close test; medium |
| Discovery | ProductsPage.tsx:81, CategoryPage.tsx:132, CategoriesPage.tsx:63; admin DataTable.tsx:137,223 | opacity 0 awal + staggerChildren .04/delay .02 | item terakhir pada 100 row dapat tertunda ~4s; source-derived, bukan benchmark | P1 | daftar langsung terlihat, tanpa stagger per data row; high |
| Content | HomePage.tsx:117-145 + HomePage.css:10 | opacity 0 sampai intersection/timeout 2000ms | informasi bergantung animasi/timer | P1 | visible default, hapus timer/observer reveal; high |
| Product | ProductPage.tsx:46 dan InstantBuyPage.tsx:75 | secondary sections initial opacity 0, whileInView | IO tidak tersedia dapat menyembunyikan informasi; high source | P1 | section native selalu terlihat; high |
| Route | dua PageTransition.tsx | AnimatePresence mode wait menahan mount route baru .15s; storefront CSS main juga rise .5s | choreography menyeluruh berlebihan untuk transaksi | P1 | Motion entrance tanpa exit wait, visible default, preserve Suspense/scroll; high |
| Reduced motion | admin index.css, storefront static/app.css; main.tsx | MotionConfig melindungi transform/layout JS tetapi opacity tetap jalan; CSS pulse/dialog transitions sebagian belum reduce | dua lapisan kebijakan | P1 | CSS reduced override; hero stagger off pada reduced; high |
| Scroll | storefront OrderDetailPage.tsx:84, HelpPage.tsx:182 | explicit behavior smooth tanpa matchMedia | CSS reduce tidak mengubah JS scroll option | P1 | shared scroll behavior preference; high |
| Touch | storefront index.css:122 | hover custom variant unconditional | sticky touch hover dan motion gambar pada pointer kasar | P1 | restore hover capability gate; press feedback + visible focus; high |
| Progress | kedua ProgressBar.tsx | transition-all pada width | mengizinkan animasi properti yang tidak diperlukan | P1 | transition width saja, reduced motion; high |

Design inventory: Outfit/Manrope/JetBrains Mono; palette blue pine, paper/sand/card; storefront `styles/tokens.css` adalah sumber --gg-* (radius, typography, spacing, breakpoint, motion), static/app.css untuk .btn/.field/.card; admin index.css semantic shadcn tokens + theme brand. Product images sudah memiliki well/width/height pada ProductCard; sticky purchase bar dan spacer/safe-area sudah ditangani serta punya UI tests. Accordion storefront mendukung ARIA, invisible collapsed panel dan motion-reduce; admin Radix tabs/select/dialog ada. Price, stock, fulfillment dan payment memakai server verdict/Decimal; tidak diubah untuk motion.

State matrix: query screens memisahkan loading/ready/empty/error sejauh pattern source di tabel route; mutation forms memakai isPending/disabled dan error. PayPage status polling 5s mengikuti backend; OrderProgress/TransactionStatus menampilkan label/icon status nyata. Success tidak diberikan oleh animation completion. Underpaid/expired/processing tetap sesuai model yang ada. Wallet typed money/parser, exact fields admin, auth dan credential restriction tidak disentuh. Semua flow transaksi tidak diuji end-to-end dalam baseline; validation menyatakan coverage aktual.

### Unverified hypotheses dan out of scope

| Item | Classification | Pembuktian / next step |
|---|---|---|
| Seluruh contrast, zoom 200%, Safari/Firefox, low-end device, INP/LCP/CLS lapangan | HYPOTHESIS / belum diukur | Audit browser/device nyata dan RUM; jangan mengklaim WCAG certification |
| Error branch PayPage/OrderDetailPage mengembalikan null untuk sebagian kegagalan | FACT source; out of scope perubahan batch ini | Perubahan copy/error recovery transaksi perlu pengujian dedicated; jangan campur animasi dengan semantics payment |
| Role visibility admin | OUT OF SCOPE | Guard server authoritative; tidak menambah authorization client |
| Bot, provider, stock deduction, migration, credentials delivery | OUT OF SCOPE | Tidak ada perubahan backend/bot/schema |

## D. MOTION MAP dan specification

| Area/route | Technique / trigger | Token/duration | Reduced motion / touch | Benefit / acceptance |
|---|---|---|---|---|
| Semua route shell | Motion entrance translateY 4px, tanpa exit queue; navigation | base .22s / EASE [.22,1,.36,1], opacity tetap 1 | initial false jika reduced; native Back/Forward | route baru langsung tersedia; lazy fallback menjaga chrome |
| Admin drawer | Motion slide left + Radix modal; open/close | panel .28s enter, fast .15s exit | tanpa transform saat reduced; 44px close | Escape/trap/restore/outside close, closed links absent, resize cleanup |
| Admin search | Radix Dialog focus + Motion fade/scale panel | base .22s enter / fast .15s exit | reduced immediate; keyboard input/results | focus stays input during rerender; search error beda dari empty |
| Admin quick/user menu | Radix dropdown CSS state enter/exit | fast .15s | CSS reduced no animation, 44px trigger/item | ArrowDown/Escape/focus restore; route tujuan tetap |
| Storefront modal/search/drawer | existing Motion presence, stable a11y effect, inert exiting layers | fast/base/panel | simple opacity allowed; no stagger | typing/rerender tidak steal focus; close tidak intercept clicks |
| Home | bounded max 3 hero preview Motion; catalog/content always visible | .04s child stagger max 3 / fast | stagger disabled reduced; hover only fine pointer | no observer/timer needed for content |
| /products,/categories,/c/:slug; admin tables | NONE per-row entrance | immediate | same content for all input | last row visible immediately, no large animation list |
| /p/:slug (premium + game) | NONE for terms/reviews; current native selection | fast CSS feedback | focus/checked semantics retained | both families retain fields and picker; no product data mutation |
| Shared buttons/fields/cards | CSS press/color/shadow, focused outline | fast .15s + house easing | press instant reduced; hover capability gate | feedback on touch/key without layout shift |
| /help and /account/orders/:code#credentials | scroll respects matchMedia | native auto or smooth | auto reduced | scroll options preserve block/start and actual target |
| Checkout/pay/wallet/orders/account/auth/support/info | shared foundations only; no status celebration | immediate authoritative status | identical semantics | no fetch/amount/status change |

Motion hierarchy: functional feedback first; selective spatial continuity second; bounded existing hero third; no novelty layer. No reveal on purchase data or long stagger. No will-change globally, no new RAF loop, no delays that imitate loading. CSS durations fast=.15s, base=.22s, panel=.28s; JS matches these values. Reduced CSS disables animation loops and transitions, forces auto scrolling; Motion useReducedMotion handles explicit delay/route presets. No smooth-scroll interception.

Selection rubric (0..5, benefit/fit/cost/a11y-risk/complexity): accessible drawer 5/5/2/1/2; stable dialog lifecycle 5/5/1/1/2; visible data lists 5/5/0/0/1; bounded hero 2/4/1/1/1; shared-element product route 2/3/3/4/4. Scores are design judgments, not measured performance. Reject route shared-element until image/history stability has dedicated proof.

## E. PLAN dan dependency decision (pre-code gate)

User clarified Motion.dev usage. Migrate both manifest direct dependencies from framer-motion to `motion@12.42.2`, same engine version, imports to motion/react following official upgrade guide; lockfile changes require final full suite. No parallel animation engines. Existing API compatibility verified in installed types and official docs.

| Candidate | Installed baseline | Decision / ownership | Cost/rationale |
|---|---|---|---|
| Motion for React | framer-motion 12.42.2 | Adopt official motion package, same 12.42.2; React presence/gestures/route/drawer | preserves tested engine; bundle before/after recorded; reduced API exists |
| Radix | radix-ui 1.6.0 admin | Reuse Dialog/DropdownMenu, keyboard/focus only | eliminates manual traps in admin; no new UI framework |
| Native CSS | yes | simple press, focus, hover, Radix state classes | no conflict with Motion transform ownership |
| GSAP/@gsap/react | no | Reject for this scope | no verified timeline/storytelling need |
| Auto-animate/AOS | no | Reject | overlaps Motion; long data lists should be immediate |
| Lenis | no | Reject | transaction storefront needs native scroll/history |
| Lottie | no | Reject | no new animated brand asset brief |

Sequence / affected files / acceptance:
1. P0 admin `components/layout/{Sidebar,TopBar,SearchModal,AppShell}.tsx`, existing Radix wrappers: trap, Escape, restore, aria names, resize close; search error/empty split. Storefront `components/ui/useDialogA11y.ts`, MobileDrawer callback effect, Modal/SearchOverlay exiting layers: rerender does not reset focus; close layers inert. Tests focused, mock API only.
2. P1 both `lib/motion.ts`, main.tsx imports, PageTransition.tsx, index.css; storefront HomePage.tsx/HomePage.css, ProductsPage/CategoryPage/CategoriesPage, ProductPage/InstantBuyPage; admin DataTable; both ProgressBar; storefront scroll utility/HelpPage/OrderDetailPage. Keep colors, API, forms, fields, currency, query keys and routes. Test both families and legacy catalog using existing tests + browser mocks.
3. Migrate all existing framer-motion imports/mocks and two manifests + lockfile coherently; build, focused tests, lint. Full typecheck/test once after sync with latest master; failed full-only test rerun individually.
4. Browser: mobile 360/375/390/430, tablet 768, desktop 1280/1440; keyboard/touch/reduced/rapid close/reopen; screenshots and console errors; bundle compare same production build method. Full payment E2E only if isolated fixtures/environment permit; otherwise explicitly skipped.

Risk/rollback: changes local to web presentation and dependency migration. Logical batches can be reverted together on feature branch; never roll back another session. Keep DB schema/API/bot unchanged. No production deploy. A11y behavior regressions require fixes before integration. Critical unknown transaction/state changes are deferred separately. P2 deferred until P0/P1 validated.

Official technical references: [Motion upgrade](https://motion.dev/docs/react-upgrade-guide), [MotionConfig reduced policy](https://motion.dev/docs/react-motion-config), [Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog), [Radix Dropdown](https://www.radix-ui.com/primitives/docs/components/dropdown-menu). MotionConfig disables transform/layout for reduced preference but retains opacity/color; explicit stagger policy therefore needed. Local ui-ux-pro-max search verified focus visibility / focus-not-obscured guidance; no generated redesign persisted.

## F. Validation log

Environment: Windows, Chromium Playwright, production Vite bundles; semua browser API di-mock. Test DB terpisah untuk suite integration. Tidak ada bot/provider/live payment yang dijalankan.

| Command / area | Hasil aktual |
|---|---|
| Baseline install frozen lockfile, prisma:generate, recursive build | PASS |
| Install setelah migrasi dependency | PASS; motion 12.42.2, transitive engine framer-motion tetap satu versi 12.42.2 |
| Typecheck kedua client; storefront lint | PASS; diulang oleh final gate |
| Build kedua client | PASS; warning large chunk dan mixed CheckoutPage import sudah ada di baseline |
| Baseline modal/search/table tests | 4 files, 35 tests PASS |
| Focused changed UI tests | Perbaikan selama iterasi: pointerEvents Radix harus auto saat present; Suspense harus stabil di luar keyed Motion; expectation selected fill diperbarui; jsdom tanpa matchMedia ditangani. Failure tersebut diverifikasi ulang dengan file terkait. |
| Layout/Tabs/scrollBehavior/SearchModal follow-up | 4 files, 54 tests PASS, sebelum tambahan rapid-tab dan clear-search |
| Layout setelah resize listener | 36 tests PASS; Tabs + DenominationCard 26 tests PASS |
| SearchModal + Alert final focused run | 18 tests PASS |
| Typecheck harness browser | Menemukan fixture index tanpa non-null assertion dan reducedMotion harus melalui contextOptions. Diperbaiki; tiap case browser kini mengassert matchMedia benar-benar sesuai preference sebelum menguji UI. |
| Rapid reopen follow-up | Run ulang menemukan reuse portal tidak mengulang mount-autofocus. MotionDialog mengembalikan fokus saat re-enter dan mengabaikan delayed close-focus milik scope lama bila sudah open. Skenario 5 rapid toggles diulang 5 kali: 5 PASS. Full gate pertama dihentikan untuk memasukkan perbaikan ini. |
| Full run diagnostic | 607 files: 604 PASS, 3 failed; 11,261 tests PASS, 7 failed. Semua failure direproduksi dalam run file terpisah: Flash 2 ekspektasi warna lama, TopBar mencari button sementara Radix menuitem, integrity 4 assertions karena public schema database audit baru masih kosong. Ekspektasi UI diperbarui, POST logout assertion dipertahankan; schema hanya database trustance_motion_audit diinisialisasi dengan prisma db push setelah memastikan nama DB, tanpa accept-data-loss/perubahan schema source. |
| Focused correction | Flash/TopBar/InstantBuyPage/locales: 4 files, 51 tests PASS; label instant netral untuk kedua keluarga, picker katalog tetap plan. |
| `pnpm exec playwright test -c tests/ui/frontend-motion.playwright.config.ts` | **32 PASS**: 360/375/390/430/768/1280/1440px, normal/reduced, trap/Escape/restore, Back/Forward, 48-card immediate visibility, premium/game/legacy filters, account retention/selected total, rapid search reopen, touch, drawer resize, overflow, no pageerror/unexpected API |
| `pnpm exec playwright test -c tests/ui/checkout.playwright.config.ts` | **10 PASS**: 320–1280px, primary/sticky/footer, selected amount/account payload, blur constraints, duplicate submit guard |
| `node tests/ui/measure-frontend-motion.mjs` | Bundle inventory and opaque-pair contrast recorded in metrics.json |
| Final sync + `pnpm typecheck && pnpm test` | Pending final integration gate |

Browser fixtures menguji katalog admin, home/products dan dua jenis product page storefront; bukan semua state seluruh route. Touch memakai emulasi Chromium, bukan iOS nyata. Full live-provider payment/fulfillment E2E, Safari/Firefox, zoom 200%, RUM INP/LCP/CLS belum dijalankan. Hasil tidak menyatakan sertifikasi WCAG atau seluruh halaman bebas bug.

## G. Before/after

| Before (source/runtime) | After |
|---|---|
| 22 link drawer mobile admin mounted saat tertutup; Escape tidak menutup | Closed drawer unmounts; modal trap/Escape/restore/resize lulus Chromium |
| Quick/user menu manual; expanded state tidak ada | Radix menu keyboard/ARIA, trigger 44px, focus restore |
| Callback berubah dapat mengulang focus modal; search failure dianggap empty | Lifecycle stabil, exiting layers inert, error/retry/clear terpisah |
| Route exit queue dan CSS entrance berlapis | Visible 4px entrance, stable Suspense, no exit queue |
| Long list stagger, scroll-gated catalog/terms | Data/informasi produk langsung tersedia |
| White card berulang/border tiap data row | Sand inset tanpa border/shadow, separator total selektif, whitespace/judul responsive |
| Warning panel merah, tip hijau | Warning amber, guidance blue, success green, error red; label/icon mendukung makna |
| Selection hanya border, ring bercampur checked | Radio checked + blue surface/border; focus ring terpisah; scoped Motion tab indicator |
| CSS/explicit smooth scroll belum mengikuti reduced | CSS reduced override, automatic scroll preference, no reduced stagger |

Evidence: [baseline browser JSON](frontend-motion-evidence/baseline-browser.json), [before mobile](frontend-motion-evidence/before-admin-mobile.png), [before desktop](frontend-motion-evidence/before-admin-desktop.png), [after admin mobile](frontend-motion-evidence/after-admin-mobile.png), [after admin desktop](frontend-motion-evidence/after-admin-desktop.png), [after game mobile](frontend-motion-evidence/after-game-mobile.png), [after game desktop](frontend-motion-evidence/after-game-desktop.png). Baseline katalog kosong, after memakai fixture katalog: bukti shell/surface, bukan perbandingan pixel dengan dataset identik. Full-page screenshot tidak mewakili satu viewport.

[Metrics](frontend-motion-evidence/metrics.json) menggunakan gzip per file, bukan transfer sebuah page: storefront JS inventory 297,963 → sekitar 298,192 bytes; admin 502,292 → sekitar 500,489 bytes. Largest admin index 295,668 → sekitar 309,988 gzip bytes (+14.3kB) karena accessible Dialog/Dropdown sekarang masuk shell; total JS hampir tetap. Storefront largest index hampir tetap (~236kB gzip). Tidak ada klaim peningkatan LCP/INP; chunk splitting tetap follow-up. Angka presisi akhir ada dalam JSON build terakhir.

Kontras opaque pair: blue guidance 5.79:1; success banner body 5.36:1; warning body 5.19:1; error 5.47:1; ink-soft pada inset 5.29:1; white pada primary 5.17:1. Ikon warning/success 4.06/4.49:1, melampaui 3:1 untuk nontext. Legacy ink-faint pada sand 4.27:1 tetap belum memenuhi 4.5:1; bukan audit semua copy.

Changed-file groups: kedua manifest/lockfile/main/motion presets; admin shell/Sidebar/TopBar/SearchModal/MotionDialog, PageTransition/DataTable/PageHeader/Card/Button/ProgressBar/CSS; storefront PageTransition/dialog lifecycle/Modal/SearchOverlay/MobileDrawer/Navbar, Card/Alert/Tabs/selection/payment/summary, catalog/home/product sections, scroll helper/CSS. ErrorPage/FlashPage/SetupPendingPage/ProductCard/Toast hanya migrasi import. Regression tests colocated; browser specs/preview/metrics di tests/ui. API, schema, uang dan bot tidak berubah.

## H. Deferred

Contrast/device/RUM verification; payment error recovery audit; large initial chunks and CheckoutPage static+dynamic import warning (already in baseline); full live-provider/payment/credential scenarios. ProductTemplate server juga memakai template game untuk non-game instant; pemisahan family menyeluruh pada flow legacy ini memerlukan audit transaksi sendiri. Caption instant di batch ini netral agar tidak menambah terminology game pada Premium Apps. Owners: frontend/accessibility follow-up, transaction owner for state recovery.

## I. Rejected effects

Cursor trails, magnetic buttons, parallax, continuous blobs/gradients, full-page smooth scrolling and fullscreen route exits: no transaction benefit; motion sensitivity or CPU/input cost. Long list stagger and scroll-gated product information are removed for immediate discovery. New hero choreography/P2 is deferred.

## Steering pengguna dan perluasan visual sebelum batch terkait

Pengguna meminta Motion.dev, nested card bila diperlukan, psikologi warna, microinteractions, hierarchy, whitespace, selective borders dan surface contrast. Adopsi package motion sudah termasuk rencana. Keputusan visual: biru untuk aksi/pilihan/informasi, hijau untuk hasil sukses, amber untuk perhatian, merah untuk error; ini konvensi desain, bukan klaim ilmiah tentang efek psikologis universal. Alert panel warning sebelumnya merah dan tip hijau (FACT `Alert.tsx`); warna diselaraskan ke warning amber/guidance blue. Label/icon/ARIA tetap menjadi pembawa makna.

Admin Card/PageHeader shared mendapat ruang antar heading/deskripsi dan skala judul responsive; nested Card/DataTable memakai sand tanpa border tambahan yang terlihat. Storefront Card ditambah variant inset dan accountSummary di checkout menggunakan surface tersebut; rincian biaya memakai satu separator di total. Metode bayar/denomination mempertahankan radio native, mendapat selected fill biru dan border fokus. Tabs mempertahankan ARIA/keyboard dengan shared-layout indicator Motion yang di-scope useId, reduced tanpa spring dan target 44px. Tidak mengubah urutan DOM, data, biaya, pilihan keluarga produk, submit atau API.

Acceptance tambahan: heading/action dapat wrap di 360px; field akun panjang tetap lengkap; total dapat dibaca di kedua keluarga produk; guidance tidak menyerupai success/error; selected radio terlihat melalui radio checked serta fill/border; tab cepat hanya satu aria-selected; dua Tab instances tidak berbagi layout identity. Touch admin mendapat target minimum 44px tanpa menghilangkan density desktop. Validasi screenshot/kontras/focused tests pada batch ini.

Pemeriksaan lanjutan sebelum batch touch: FACT `MobileDrawer.tsx` disembunyikan `sm:hidden`, sementara lifecycle open tidak mengikuti resize; panel bisa hilang dengan scroll-lock masih aktif. Tambah listener breakpoint yang menutup drawer, mengikuti kebijakan admin. FACT target Navbar/close drawer 40px dan beberapa item admin lebih kecil dari 44px. Perbesar kontrol navigasi dan item menu untuk touch, validasi tap dan perubahan breakpoint. Skenario rapid search close/reopen juga ditambahkan untuk menguji presence/focus pada lifecycle nyata.

Pengukuran kontras sebelum batch terkait: warna teks success/amber pada tint masing-masing 4.49:1/4.06:1. Banner kecil memakai ink-soft untuk body (lebih dari 4.5:1), sementara ikon/tint tetap semantic; ikon memenuhi 3:1. Tidak mengubah brand tokens secara global. Ink-faint pada sand juga hanya 4.27:1; nested summary menggunakan ink-soft/ink, pemeriksaan seluruh legacy tertiary copy tetap deferred.

Review istilah sebelum batch label: FACT InstantBuyPage heading menggunakan web.choose_plan. Verifikasi lanjut `apps/storefront/src/productTemplate.ts` dan tesnya menunjukkan template game juga dipakai kategori PREMIUM_APPS/legacy yang memilih instant flow. Jadi template bukan discriminator keluarga yang aman untuk label top-up. Gunakan heading netral web.choose_option (id/en) hanya di InstantBuyPage; ProductPage katalog tetap web.choose_plan. Caption netral justified karena component memang melayani selection untuk kedua keluarga. Tidak menebak keluarga dari nama/category slug atau mengubah resolver/API. Acceptance browser: game tidak menampilkan choose plan; Premium Apps katalog tetap plan tanpa Player ID. Penambahan locale mengharuskan final full suite, bukan changed-only. Pemisahan template non-game instant secara menyeluruh memerlukan audit transaksi terpisah.
