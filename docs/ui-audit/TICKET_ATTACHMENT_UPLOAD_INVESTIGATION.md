# Ticket attachment upload investigation (P0)

**Symptom (owner report):** customers can attach images and videos to support
tickets; admins cannot, although Cloudflare R2 is configured.

**Result:** the first failing layer is the **browser's direct PUT to the R2
presigned URL** from the admin origin. The root cause is the **R2 bucket CORS
rule**: `AllowedOrigins` listed the shop origin but not the admin origin. The
owner confirmed this and saved a corrected rule. **The admin image and video
upload after that fix has not been confirmed by a runtime test**, so acceptance
is **Not Tested, awaiting owner confirmation** (finding [UPL-01](FINDINGS.md)).

The code change on this branch (commit `f0a7c8fb`, finding [UPL-02](FINDINGS.md))
does not fix the root cause. It makes the upload errors honest and adds tests.

Domains below are placeholders: `https://shop.<shop-domain>` (storefront) and
`https://admin.<shop-domain>` (web admin). No signed URLs, keys or customer
files appear in this document.

## 1. Architecture actually used

Presigned upload (spec C5, pattern 2):

```
browser ──POST intent──▶ app server ──sign──▶ presigned PUT URL (180 s)
browser ──PUT file──────────────────────────▶ R2 bucket (prefix support/)
browser ──POST finalize─▶ app server ──HEAD/GET/copy──▶ R2 (support-ready/)
browser ──POST reply with attachment_ids─▶ app server ──▶ DB (attach to message)
```

Both apps use this same pattern and the same core code. They differ only in
the client component, the route prefix, the auth check, and **the Origin the
browser sends with the PUT**.

### Customer flow vs admin flow

```
Customer (storefront)                         Admin (web admin)
---------------------                         -----------------
SupportUploadPicker (shop)                    SupportUploadPicker (support)
  apps/storefront/client/src/components/        apps/web-admin/client/src/components/
  shop/SupportUploadPicker.tsx                  support/SupportUploadPicker.tsx
        │                                             │
useSupportUploads                             useSupportUploads
  storefront/client/src/lib/supportUploads.ts   web-admin/client/src/lib/supportUploads.ts
        │ POST /api/v1/account/support/uploads        │ POST /api/support/uploads
        ▼                                             ▼
supportV2.ts:42 (requireCustomer + CSRF)      supportMedia.ts:10 (csrfProtect, admin session)
        └──────────────┬──────────────────────────────┘
                       ▼
    createSupportUpload  packages/db/src/crud/supportAttachments.ts:34
    supportObjectUrl     packages/core/src/supportMedia.ts:86-93 (SigV4 query signing,
                                                                 X-Amz-Expires=180)
                       │  { id, url, headers: { Content-Type }, expires_in }
        ┌──────────────┴──────────────────────────────┐
        ▼                                             ▼
xhr PUT intent.url  (lib/supportUploads.ts:48-52) xhr PUT intent.url (lib/supportUploads.ts:61-66)
Origin: https://shop.<shop-domain>             Origin: https://admin.<shop-domain>
        │  CORS preflight OK                          │  CORS preflight REFUSED (before fix)
        ▼                                             ▼
R2 PUT 200                                     xhr.onerror  →  "Network unavailable"
        │                                             ✗  finalize never reached
POST .../uploads/:id/finalize (supportV2.ts:55)
finalizeSupportUpload (supportAttachments.ts:52)
```

## 2. Layer comparison

| Layer | Customer flow | Admin flow | Difference / evidence |
|---|---|---|---|
| File input/component | `shop/SupportUploadPicker.tsx` | `support/SupportUploadPicker.tsx` | Separate components, same hook shape |
| Accepted MIME types | `image/jpeg,image/png,image/webp,video/mp4` | same | Same `accept` attribute |
| File size/count limits | from options (defaults 5 MB image, 20 MB video), max 3 files | same | Same `supportMediaLimits()` |
| Client validation | type and size in `useSupportUploads.add` | same | Same logic |
| Upload hook/service | `useSupportUploads` (storefront copy) | `useSupportUploads` (admin copy) | Same structure |
| API method + URL | `POST /api/v1/account/support/uploads` | `POST /api/support/uploads` | Prefix only |
| Request Content-Type (intent) | JSON | JSON | Same |
| FormData field name | n/a: the file is the raw PUT body, not multipart | n/a | Not a multipart flow |
| Auth header/cookie | customer session cookie | admin session cookie | Different session, same mechanism |
| CSRF handling | `csrfHeaderOk` in route (`supportV2.ts:44`) | `csrfProtect` preHandler (`supportMedia.ts:10`) | Both enforced |
| Backend route | `supportV2.ts:42, :55, :61, :67` | `supportMedia.ts:9, :10, :18, :22, :26` | Separate routes |
| Auth middleware | `requireCustomer` | admin session (`csrfProtect` + `req.admin`) | — |
| Role/permission | ticket owned by the customer | readonly refused on intent (test: 403) and on media GET (`blockReadonlyReads`) | — |
| Multipart parser | none (direct PUT) | none | — |
| Server-side validation | `createSupportUpload` (MIME, size, empty) | same function | Same |
| R2 binding/config | `r2Credentials()`, `resolveSupportBucket()` | same | Same bucket |
| Object key generation | `support/` staging prefix | same | Same |
| R2 put/upload operation | browser PUT to presigned URL | browser PUT to presigned URL | **Origin differs → CORS** |
| Public/private / signed URL | private; presigned PUT 180 s; media via app route | same | Same |
| Attachment DB record | `SupportAttachment` PENDING → READY on finalize | same | Same |
| Ticket/message association | `attachment_ids` on reply | same | Same |
| Response schema | `{ id, url, headers, expires_in }` | same | Same |
| Frontend response handling | XHR, `upload.onprogress` | XHR, `upload.onprogress` | Same |
| Preview/download authorization | `/api/v1/account/support/media/:id/:filename` (owner) | `/api/support/media/:id/:filename` (`blockReadonlyReads`) | Both private |

## 3. First confirmed divergence

**The PUT from the admin origin to R2.** Evidence:

- The admin error text "Network unavailable" was produced only by `xhr.onerror`
  on that PUT. Before `f0a7c8fb`, `onerror` always rejected with
  `helpdesk.upload_network`. Today the same line is
  `apps/web-admin/client/src/lib/supportUploads.ts:65`.
- `onerror` fires only when the browser gets no usable response (network or
  CORS failure). If R2 had answered with an error status, `xhr.onload` at line
  64 would have rejected with "Storage upload refused." instead.
- The intent request (step 1) had to succeed for the PUT to start, so admin
  authentication, CSRF, server validation and URL signing were working.
- The request shape is identical for both apps (same signer, same headers). The
  only input that differs is the `Origin` header, which is what R2's CORS rule
  checks. The repository's own setup guide already says the admin origin must
  be listed: [docs/TICKETING_V2.md](../TICKETING_V2.md) (CORS section).

Failure category (spec C6 step 8): **R2 upload**, at the browser CORS layer.
Not before the request, not auth/permission, not parsing, not validation, not
metadata persistence.

## 4. Reproduction steps and sanitized evidence

No local reproduction was possible: the failure depends on the production
bucket's CORS rule and the deployed admin origin, and the Playwright MCP server
did not connect in the investigating session. The evidence came from the owner:

1. Owner report: admin upload shows "Network unavailable"; customer upload works.
2. Code trace above: that string has one source, `xhr.onerror` on the PUT.
3. Owner shared the bucket CORS editor. A first reading suggested the admin
   origin was already listed; the owner then confirmed it was **not** in the
   saved rule (the visible text was an unsaved edit with a syntax error).
4. Owner edited the rule to include the admin origin with `PUT` and the
   `Content-Type` header, and saved it.

Sanitized rule shape (placeholders, keep any existing fields such as
`MaxAgeSeconds`):

```json
[{
  "AllowedOrigins": ["https://shop.<shop-domain>", "https://admin.<shop-domain>"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["Content-Type"]
}]
```

No Network-panel capture of the failing OPTIONS/PUT pair was collected. To
collect it: on the admin origin, DevTools → Network → Preserve log, upload one
small image, and record Status and Type of the `OPTIONS` and `PUT` rows to the
storage host, with everything after `?` redacted.

## 5. Root cause

R2 bucket CORS `AllowedOrigins` did not contain the admin origin. Not a code
defect. Files involved in the failing step:
`apps/web-admin/client/src/lib/supportUploads.ts:61-66` (PUT),
`packages/core/src/supportMedia.ts:86-93` (presigned URL).

## 6. Minimal fix and regression risks

- **Root cause fix (configuration, done by the owner):** add the admin origin
  to the bucket CORS rule. Risk: dropping the shop origin while editing would
  break customer uploads, so the customer re-test is part of acceptance.
- **Code change on this branch (`f0a7c8fb`):**
  - `xhr.onerror` says "Network unavailable" only when `navigator.onLine` is
    false; otherwise `helpdesk.upload_storage_blocked` (both clients). The
    admin copy hints at storage access settings; the customer copy does not
    mention CORS.
  - Admin picker shows distinct states for options loading, failed (with
    Retry) and disabled, so a failed options request no longer reads as "R2
    not configured".
  - A failed file now explains why Send is disabled (both clients). Draft text
    and chosen files are kept.
  - Visual follow-up on this branch (`5162acb7`, `d158b647`): per-file state
    icons, no made-up "Uploading 0%" in admin.
  - Regression risk: copy and component props only; no server behaviour change.

## 7. Acceptance matrix (spec C7 / C8)

"Automated" = covered by tests on this branch (jsdom client tests or Fastify
inject tests with a stubbed storage). "Runtime" = real browser against real R2.

| Scenario | Customer | Admin | Evidence |
|---|---|---|---|
| Valid image | No server test of the happy path; runtime works per owner report | Automated pass (intent + finalize, stubbed storage); **runtime Not Tested** | `apps/web-admin/test/support-media-api.test.ts` |
| Valid video (MP4) | Not Tested | Automated pass (intent accepts MP4); **runtime Not Tested** | same |
| Unsupported MIME | Malformed intent metadata refused (`support-api.test.ts`); MIME case not separately tested | Automated: 400, no row | same |
| File too large | Client-side check tested in `lib/supportUploads.test.tsx`; server not separately tested | Automated: 400, no row (image and video limits) | same |
| Missing authentication | n/a | Automated: 401 | same |
| Authenticated unauthorized role | n/a | Automated: readonly 403 on intent and media GET | same |
| R2 unavailable | Automated: options disabled path | Automated: options disabled/error states | `SupportUploadPicker.test.tsx` |
| Multipart field mismatch | n/a (no multipart) | n/a | — |
| Metadata persistence failure | Not Tested | Not Tested | staging prefix lifecycle documented in TICKETING_V2.md |
| Duplicate submit | Reply `request_id` dedupe (pre-existing) | Same; not re-tested | — |
| Slow upload | Automated: no fake 0%, real % once measured | Automated: same (`5162acb7`) | picker tests |
| Network disconnect | Automated: offline → "Network unavailable" | Automated: same | `lib/supportUploads.test.tsx` |
| Online but storage blocked | Automated: storage-blocked copy | Automated: same | same |
| Private attachment retrieval | Automated: foreign file access blocked (`support-api.test.ts`) | Automated: 302 attached, 404 unattached, 403 readonly, 401 anon | `support-media-api.test.ts` |
| Expired signed URL | Not Tested | Not Tested | 180 s expiry |
| Ticket closed/locked | Not Tested (route code returns 404, `supportV2.ts:48-50`) | Automated: 404 on intent | same |
| Finalize by another owner | — | Automated: refused, row stays PENDING | same |

C8 criteria "Admin can upload a supported image" and "...video": **Not Tested,
awaiting owner confirmation** after the CORS change. Owner steps: upload one
image and one MP4 from the admin ticket screen, send the reply, check the
attachments in admin and on the customer side, then do one customer upload.
