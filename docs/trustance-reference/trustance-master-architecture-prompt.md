# Trustance — Master Implementation Prompt

## 0. Tujuan

Implementasikan dan/atau refactor arsitektur backend Trustance menjadi **modular monolith** yang mendukung:

- Website storefront
- Telegram bot
- Web admin
- Premium apps dengan:
  - manual delivery yang membutuhkan data customer, misalnya email
  - manual delivery berupa pemberian akun oleh admin
  - instant delivery
- Game top-up instant
- Transaction provider game top-up: **Digiflazz**
- Nickname-check providers:
  - **VIPReseller / VIPayment** (gunakan nama/provider yang benar sesuai codebase)
  - **Kokinpay**
  - **Melostore**
- Payment gateway yang dapat bertambah di masa depan
- Inventory/account pool
- Refund
- Pricing
- Financial ledger
- Notifications
- Webhook
- Audit log
- Background worker
- Outbox pattern
- Idempotency
- Provider fallback dan provider capability

Tujuan utama adalah membuat sistem yang mudah dikembangkan tanpa mengikat domain bisnis Trustance kepada API atau naming provider tertentu.

---

# 1. Prinsip Arsitektur

Gunakan prinsip:

> **Customer → Catalog → Cart → Checkout → Order → Payment → Fulfillment**

Provider hanya menjadi adapter/infrastructure.

Jangan membuat Digiflazz, VIPReseller, Kokinpay, atau Melostore sebagai pusat domain model.

Domain internal Trustance harus memiliki ID dan terminology sendiri.

Contoh:

```text
Internal Game ID:
mobile-legends

Digiflazz:
ML86

VIPReseller:
mobile_legends

Kokinpay:
ml

Melostore:
mobile-legends
```

Jangan pernah menganggap:

```text
SKU produk = game code = internal game ID
```

Ketiganya adalah entitas berbeda.

---

# 2. Arsitektur Channel

Website dan Telegram bot harus menggunakan business logic yang sama.

```text
Website ───────┐
               ├──> Trustance Application/API
Telegram Bot ──┘
                    │
                    ├── Catalog
                    ├── Customer
                    ├── Checkout
                    ├── Orders
                    ├── Payments
                    ├── Fulfillment
                    ├── Nickname
                    ├── Inventory
                    ├── Pricing
                    ├── Notifications
                    └── etc.
```

Jangan membuat:

```text
Website → business logic A
Telegram → business logic B
```

Bot hanya menjadi channel/presentation adapter.

Admin juga harus menggunakan application/domain service yang sama.

---

# 3. Existing Stack

Project menggunakan monorepo Node.js/TypeScript dengan architecture yang sudah ada.

Pertahankan architecture existing jika masih sesuai.

Target existing structure:

```text
apps/
├── server/
├── storefront/
├── web-admin/
└── order-bot/

packages/
├── core/
├── db/
├── outbox-dispatcher/
└── web-ui/
```

Jika repository sudah mempunyai module/service yang setara, gunakan dan refactor secara incremental.

Jangan membuat duplicate:

- PrismaClient
- DB repository
- provider client
- order service
- notification dispatcher

Gunakan **satu PrismaClient** dari composition root/server.

---

# 4. Target Domain Modules

Secara logical, domain dibagi menjadi:

```text
customer/
catalog/
checkout/
orders/
payments/
fulfillment/
inventory/
nickname/
pricing/
ledger/
tickets/
support/
notifications/
tasks/
providers/
webhooks/
audit/
```

Tidak wajib membuat seluruh module sebagai package fisik sejak awal.

Yang wajib adalah dependency boundary dan tanggung jawabnya jelas.

---

# 5. Customer Domain

Customer adalah identitas universal lintas channel.

Model konseptual:

```text
Customer
├── Account
├── Website identity
├── Telegram identity
├── Orders
├── Saved game identities
└── Notification preferences
```

Contoh:

```text
Customer #123
├── email
├── Telegram ID
└── Orders
    ├── #1001
    ├── #1002
    └── #1003
```

Telegram user dan website account harus dapat dikaitkan ke satu customer.

Jangan membuat dua customer terpisah hanya karena channel berbeda.

---

# 6. Catalog Domain

Catalog menjadi source of truth untuk produk yang dijual Trustance.

Konsep:

```text
Catalog
├── Category
├── Product
├── Product Variant
├── Game
├── Denomination
└── Product Requirements
```

Contoh:

```text
Premium Apps
├── CapCut Pro
│   ├── 7 Days
│   ├── 30 Days
│   └── 6 Months
└── Netflix
    └── 30 Days

Game Top Up
├── Mobile Legends
│   ├── 86 Diamonds
│   └── 172 Diamonds
└── Free Fire
    ├── 70 Diamonds
    └── 140 Diamonds
```

---

# 7. Product Model

Product minimal harus dapat menyimpan:

```text
id
name
slug
category_id
game_id?
fulfillment_type
transaction_provider?
provider_sku?
price
currency
is_active
metadata
created_at
updated_at
```

Jangan mengikat `fulfillment_type` ke nama provider.

Gunakan:

```text
MANUAL_USER_INFO
MANUAL_ACCOUNT
INSTANT
GAME_TOPUP
```

Bukan:

```text
DIGIFLAZZ
KOKINPAY
MELOSTORE
```

Provider adalah dependency dari fulfillment, bukan fulfillment type.

---

# 8. Product Requirements

Produk dapat membutuhkan data tambahan dari customer.

Contoh premium app:

```text
requirements:
- email
```

Game:

```text
requirements:
- user_id
- zone_id
```

Jangan hardcode form di website dan Telegram secara terpisah.

Gunakan metadata/schema dari catalog agar kedua channel menghasilkan input yang konsisten.

---

# 9. Game Domain

Gunakan canonical internal game ID.

Contoh:

```text
mobile-legends
free-fire
pubg-mobile
arena-breakout
genshin-impact
```

Model konseptual:

```text
Game
├── id
├── slug
├── name
├── category
├── nickname_supported
├── nickname_required
├── nickname_before_payment
├── input_schema
├── requires_zone
├── requires_server
├── is_active
└── metadata
```

---

# 10. Game Input Schema

Game tidak boleh diasumsikan hanya memiliki satu `customer_no`.

Buat schema fleksibel.

Contoh Mobile Legends:

```json
{
  "gameId": "mobile-legends",
  "fields": [
    {
      "key": "user_id",
      "label": "User ID",
      "type": "text",
      "required": true
    },
    {
      "key": "zone_id",
      "label": "Zone ID",
      "type": "text",
      "required": true
    }
  ]
}
```

Contoh Free Fire:

```json
{
  "gameId": "free-fire",
  "fields": [
    {
      "key": "user_id",
      "label": "Player ID",
      "type": "text",
      "required": true
    }
  ]
}
```

Schema harus dapat menangani:

- user ID
- zone ID
- server
- region
- character ID
- login ID
- field custom

Website dan Telegram harus menggunakan schema yang sama.

---

# 11. Cart

Checkout harus mendukung multiple product dalam satu cart.

Contoh:

```text
Cart
├── CapCut Pro
├── Canva Pro
└── MLBB 86 Diamonds
```

Setiap item memiliki fulfillment sendiri.

Jangan membuat satu Order hanya dapat memiliki satu fulfillment type.

---

# 12. Checkout

Flow:

```text
Catalog
 ↓
Cart
 ↓
Checkout
 ↓
Create Order
 ↓
Create Payment
```

Sebelum membuat order:

- validate product
- validate availability
- validate required customer information
- validate game input
- validate price
- validate promotion
- validate channel
- calculate totals
- reserve inventory jika diperlukan

---

# 13. Order Domain

Order adalah pusat lifecycle transaksi.

Model konseptual:

```text
Order
├── Customer
├── Items
├── Payment
├── Fulfillment records
├── Channel
├── Status
├── Pricing snapshot
├── Totals
├── External references
└── Audit timeline
```

Order item harus menyimpan snapshot penting:

```text
product name
SKU
unit price
quantity
discount
subtotal
fulfillment type
provider
provider SKU
game ID
input data
```

Tujuannya agar histori order tidak berubah ketika catalog/product berubah.

---

# 14. Order Status

Gunakan state machine.

Minimal:

```text
UNPAID
PAID
QUEUED
WAITING_FOR_INFO
INFO_SUBMITTED
PROCESSING
DELIVERED
FAILED
CANCELLED
EXPIRED
```

Tidak semua order harus melewati semua status.

Contoh premium manual:

```text
UNPAID
 ↓
PAID
 ↓
WAITING_FOR_INFO
 ↓
INFO_SUBMITTED
 ↓
QUEUED
 ↓
PROCESSING
 ↓
DELIVERED
```

Game top-up:

```text
UNPAID
 ↓
PAID
 ↓
QUEUED
 ↓
PROCESSING
 ↓
DELIVERED
```

---

# 15. Payment Domain

Payment harus independent dari fulfillment.

Model:

```text
Payment
├── provider
├── amount
├── currency
├── status
├── external_reference
├── payment_url
├── expires_at
├── fee
├── paid_at
└── metadata
```

Flow:

```text
Order
 ↓
Payment
 ↓
PAID
 ↓
Fulfillment
```

Payment gateway dapat ditambah tanpa mengubah order/fulfillment domain.

---

# 16. Payment Expiration

Order unpaid harus memiliki expiration.

Contoh:

```text
UNPAID
 ↓ 15 minutes
EXPIRED
```

Jika inventory sudah di-reserve:

```text
RESERVED
 ↓
EXPIRED
 ↓
AVAILABLE
```

Implementasikan worker untuk:

- menemukan payment expired
- update order/payment
- release reservation
- emit event

---

# 17. Fulfillment Engine

Buat abstraction:

```text
FulfillmentEngine
```

Supported strategies:

```text
MANUAL_USER_INFO
MANUAL_ACCOUNT
INSTANT
GAME_TOPUP
```

Fulfillment berada pada level **Order Item**.

Contoh:

```text
Order #123

Item 1:
CapCut → MANUAL_USER_INFO

Item 2:
Netflix → MANUAL_ACCOUNT

Item 3:
Canva → INSTANT

Item 4:
MLBB → GAME_TOPUP
```

Satu order boleh memiliki beberapa fulfillment strategy.

---

# 18. Manual User Info

Flow:

```text
PAID
 ↓
WAITING_FOR_INFO
 ↓
Customer submits required information
 ↓
INFO_SUBMITTED
 ↓
QUEUED
 ↓
Admin task
 ↓
PROCESSING
 ↓
DELIVERED
```

Contoh:

```text
Email:
customer@example.com
```

Data customer harus tersimpan pada struktur order/fulfillment yang tepat, bukan sekadar chat message.

---

# 19. Manual Account

Untuk produk yang delivery-nya dilakukan admin:

```text
PAID
 ↓
QUEUED
 ↓
ADMIN_TASK
 ↓
Account selected
 ↓
RESERVED
 ↓
DELIVERY
 ↓
SOLD
 ↓
DELIVERED
```

Delivery harus disimpan sebagai record.

Contoh:

```text
DeliveryRecord
├── order_item_id
├── type
├── payload
├── delivered_at
└── delivered_by
```

Credential tidak boleh dicetak di log biasa.

---

# 20. Instant Delivery

Flow:

```text
PAID
 ↓
QUEUED
 ↓
Automated fulfillment
 ↓
Delivery
 ↓
DELIVERED
```

Tetap buat fulfillment record dan audit trail walaupun sepenuhnya otomatis.

---

# 21. Inventory

Inventory diperlukan untuk produk yang menggunakan stock/account/license.

Model konseptual:

```text
InventoryItem
├── product_id
├── type
├── status
├── secret/reference
├── reserved_by
├── reserved_until
├── sold_at
└── metadata
```

Status:

```text
AVAILABLE
RESERVED
SOLD
EXPIRED
DISABLED
```

Jangan hanya menyimpan:

```text
stock = 10
```

jika stock terdiri dari akun/license individual.

---

# 22. Inventory Reservation

Saat checkout:

```text
AVAILABLE
 ↓
RESERVED
```

Jika payment sukses:

```text
RESERVED
 ↓
SOLD
```

Jika payment expired:

```text
RESERVED
 ↓
AVAILABLE
```

Gunakan transaction/locking yang aman agar stock tidak terkirim ke dua order.

---

# 23. Game Top-Up

Game top-up memiliki dua dependency berbeda:

```text
Nickname Provider
Transaction Provider
```

Contoh:

```text
Game:
Mobile Legends

Nickname:
VIPReseller

Transaction:
Digiflazz
```

Jangan menggabungkan keduanya.

---

# 24. Nickname Service

Buat:

```text
NicknameService
NicknameRouter
NicknameProvider interface
```

Interface konseptual:

```ts
interface NicknameRequest {
  gameId: string;
  target: string;
  zone?: string;
  server?: string;
  extra?: Record<string, string>;
}

interface NicknameResult {
  success: boolean;
  gameId: string;
  target: string;
  zone?: string;
  server?: string;
  nickname?: string;
  region?: string;
  provider: string;
  latencyMs: number;
  error?: {
    code: string;
    message: string;
  };
}
```

Sesuaikan dengan architecture/type conventions yang sudah ada.

---

# 25. Nickname Provider Mapping

Gunakan tabel:

```text
ProviderGameMapping

game_id
provider
provider_game_code
enabled
priority
created_at
updated_at
```

Contoh:

```text
mobile-legends | vipreseller | mobile_legends | true | 1
mobile-legends | melostore   | mobile-legends | true | 2
mobile-legends | kokinpay    | ml             | true | 3
```

Jangan hardcode mapping di controller/service.

---

# 26. Nickname Provider Adapters

Implementasikan:

```text
VipResellerNicknameProvider
KokinpayNicknameProvider
MelostoreNicknameProvider
```

Setiap adapter:

```text
Internal Request
 ↓
Provider-specific request
 ↓
Provider API
 ↓
Provider response
 ↓
Normalized NicknameResult
```

Frontend tidak boleh mengetahui format API provider.

---

# 27. Nickname Fallback

Provider harus memiliki priority.

Contoh:

```text
1. VIPReseller
2. Melostore
3. Kokinpay
```

Jika provider pertama gagal:

```text
VIPReseller → TIMEOUT
 ↓
Melostore → SUCCESS
 ↓
Return nickname
```

Tetapi jangan fallback pada error yang menunjukkan input customer salah.

Retryable:

```text
TIMEOUT
NETWORK_ERROR
PROVIDER_UNAVAILABLE
RATE_LIMITED
PROVIDER_ERROR
GAME_NOT_SUPPORTED
```

Non-retryable:

```text
INVALID_TARGET
INVALID_ZONE
INVALID_SERVER
INVALID_REQUEST
```

Jika `INVALID_TARGET`, hentikan flow.

---

# 28. Nickname Requirement

Game harus dapat mendefinisikan:

```text
nickname_supported
nickname_required
nickname_before_payment
```

Contoh:

```text
Mobile Legends:
supported = true
required = true
before_payment = true
```

Game lain:

```text
Game X:
supported = false
required = false
```

Jangan menganggap semua game membutuhkan nickname check.

---

# 29. Transaction Provider

Gunakan interface:

```text
TopupProvider
```

Digiflazz menjadi adapter:

```text
DigiflazzAdapter
```

Product menyimpan:

```text
transaction_provider = digiflazz
provider_sku = ML86
```

Tetapi:

```text
game_id = mobile-legends
```

Jangan gunakan:

```text
ML86
```

sebagai game code nickname.

---

# 30. Provider Capability

Provider harus dapat mendeskripsikan capability:

```text
nickname_check
topup
balance_check
transaction_status
webhook
```

Contoh:

```text
Digiflazz:
topup = true
nickname_check = false

VIPReseller:
nickname_check = true

Kokinpay:
nickname_check = true

Melostore:
nickname_check = true
```

Ini memungkinkan provider lain ditambahkan di masa depan.

---

# 31. Pricing Engine

Buat pricing layer terpisah.

Pricing dapat mempertimbangkan:

```text
HPP
base price
channel
customer group
promotion
bulk discount
fee
currency/FX
```

Contoh:

```text
HPP        Rp10.000
Website    Rp13.000
Telegram   Rp13.000
Reseller   Rp12.000
Promo      -Rp1.000
```

Saat order dibuat, snapshot harga final ke order item.

Jangan menghitung histori order berdasarkan harga product saat ini.

---

# 32. Ledger

Buat financial ledger sederhana dan immutable jika memungkinkan.

Model:

```text
LedgerEntry
├── account/type
├── order_id
├── payment_id
├── amount
├── currency
├── direction
├── reference
└── created_at
```

Contoh:

```text
Customer payment   +30.000
Provider cost      -20.000
Payment fee           -750
Refund                 0
```

Tujuannya agar laporan:

- omzet
- HPP
- payment fee
- refund
- gross profit
- net revenue

dapat dihitung dengan benar.

---

# 33. Refund

Buat domain:

```text
Refund
├── order_id
├── payment_id
├── amount
├── reason
├── status
├── external_reference
└── processed_at
```

Status:

```text
PENDING
PROCESSING
COMPLETED
FAILED
CANCELLED
```

Jangan menyamakan:

```text
order.cancelled
```

dengan:

```text
money refunded
```

Keduanya adalah state berbeda.

---

# 33A. Support & Ticketing Domain

Trustance must have a dedicated **Support/Ticketing domain**.

Ticketing is separate from Order and separate from internal Admin Tasks.

```text
Ticket
= customer-facing support conversation

Admin Task
= internal work item performed by staff
```

A ticket may optionally be linked to:

```text
customer_id
order_id?
order_item_id?
```

This allows both general support and order-specific support.

## Ticket model

Conceptually:

```text
Ticket
├── id
├── ticket_number
├── customer_id
├── order_id?
├── order_item_id?
├── category
├── priority
├── status
├── channel
├── subject
├── assigned_to?
├── first_response_at?
├── resolved_at?
├── closed_at?
├── created_at
└── updated_at
```

Categories:

```text
ORDER
PAYMENT
DELIVERY
GAME_TOPUP
ACCOUNT
REFUND
PRODUCT
TECHNICAL
GENERAL
```

Priority:

```text
LOW
NORMAL
HIGH
URGENT
```

Status:

```text
OPEN
WAITING_CUSTOMER
WAITING_ADMIN
PROCESSING
RESOLVED
CLOSED
```

Channels:

```text
WEBSITE
TELEGRAM
ADMIN
SYSTEM
```

## Ticket messages

Do not store the whole conversation directly in the Ticket record.

Use:

```text
Ticket
└── TicketMessage[]
```

Conceptually:

```text
TicketMessage
├── id
├── ticket_id
├── sender_type
├── sender_id?
├── message
├── attachments?
├── internal
└── created_at
```

Sender types:

```text
CUSTOMER
ADMIN
SYSTEM
```

`internal = true` means the message is an internal admin note and must never be shown to the customer.

Example:

```text
Customer:
"Top up saya belum masuk."

Admin:
"Saya cek dulu ya."

Internal note:
"Digiflazz transaction status masih pending."
```

The customer must not see the internal note.

## Ticket and order relationship

A ticket does not always need an order.

Example:

```text
"Apakah tersedia CapCut 6 bulan?"
```

```text
order_id = NULL
```

For order-related support:

```text
"Pesanan ORD-1001 belum masuk."
```

```text
order_id = ORD-1001
```

For mixed-cart orders, support should optionally reference the exact order item:

```text
Ticket
├── order_id = ORD-1001
└── order_item_id = ITEM-3
```

This allows a customer to report that one product failed while other products in the same order succeeded.

## Website and Telegram support

Website and Telegram must use the same ticket domain.

```text
Website
   │
   ├── Create ticket
   ├── View tickets
   └── Reply
   │
   ▼
Ticket Service
   ▲
   │
Telegram
   ├── Create ticket
   ├── View tickets
   └── Reply
```

A customer should be able to:

- create a ticket from the website
- create a ticket from Telegram
- view the same ticket from either channel
- reply from either channel
- receive admin replies through the appropriate channel

This depends on unified Customer identity.

## Ticket assignment

Tickets can be assigned to an admin/support agent.

```text
Ticket
├── assigned_to
├── assigned_at
└── priority
```

Admin actions:

```text
Assign
Unassign
Start
Reply
Add internal note
Resolve
Close
Reopen
Escalate
```

## Ticket and Admin Task relationship

A ticket can create or trigger one or more internal tasks.

Example:

```text
Customer
   ↓
Ticket #TCK-1001
"Top up belum masuk"
   ↓
Admin Task
"Investigate Digiflazz transaction"
   ↓
Provider investigation
   ↓
Resolve ticket
```

Do not use the Ticket itself as the operational task queue.

## Automatic ticket/task creation

Not every provider failure should automatically create a customer-facing ticket.

For example:

```text
Digiflazz FAILED
   ↓
Retry
   ↓
FAILED
   ↓
Admin Task
   ↓
Manual review
```

If a customer already opened a ticket, the task should be linked to that ticket.

Customer-facing ticket creation and internal operational task creation are separate decisions.

## Ticket SLA

Prepare the schema for SLA tracking:

```text
first_response_at
resolved_at
response_sla
resolution_sla
```

Admin dashboard can expose:

```text
Open Tickets
Waiting Customer
Waiting Admin
Urgent
Overdue
```

Do not overcomplicate SLA implementation until support volume requires it.

## Ticket notifications

Use the existing Notification Service and Outbox.

Events:

```text
TICKET_CREATED
TICKET_REPLY
TICKET_ASSIGNED
TICKET_WAITING_CUSTOMER
TICKET_RESOLVED
TICKET_CLOSED
```

Flow:

```text
TicketMessage
   ↓
Outbox
   ↓
Notification Service
   ├── Telegram
   ├── Email
   └── Web notification
```

Do not call Telegram directly from the Ticket domain.

---

# 33B. Knowledge Base / FAQ

Support should also have a lightweight Knowledge Base.

The purpose is to resolve common questions without creating a ticket.

Conceptually:

```text
KnowledgeBase
├── Category
├── Article
├── FAQ
├── Tags
├── Status
└── UpdatedAt
```

Examples:

```text
How to top up Mobile Legends
How to find User ID
What happens if payment expires
How long manual delivery takes
How to submit email for premium products
What to do if top-up nickname is incorrect
Refund policy
```

Website can expose:

```text
Help Center
FAQ
Knowledge Base
Create Ticket
```

Telegram bot can use the same knowledge base for FAQ responses.

Do not build a complex AI support agent initially. Start with searchable/static knowledge articles and ticket escalation.

---

# 34. Notification Service

Semua notifikasi melalui service:

```text
NotificationService
├── Telegram
├── Email
└── Web notification
```

Events:

```text
ORDER_CREATED
PAYMENT_PENDING
PAYMENT_PAID
ORDER_WAITING_INFO
ORDER_PROCESSING
ORDER_DELIVERED
ORDER_FAILED
REFUND_COMPLETED
```

Jangan menaruh `Telegram.sendMessage()` langsung di OrderService.

Gunakan event/outbox.

---

# 35. Telegram Bot

Telegram bot menggunakan application service yang sama dengan website.

Bot dapat:

```text
Browse catalog
View product
Enter game ID
Nickname check
Add to cart
Checkout
Payment
View order
Submit required information
Receive delivery
Contact support
```

Jangan membuat database order terpisah untuk bot.

---

# 36. Website Storefront

Website menggunakan API/application layer yang sama.

Harus mendukung:

```text
Home
Catalog
Product
Cart
Checkout
Payment
Order history
Order detail
Delivery
Notifications
Profile
Support
```

Untuk game:

```text
Select game
 ↓
Enter player data
 ↓
Nickname check
 ↓
Confirm nickname
 ↓
Add to cart / Checkout
```

---

# 37. Admin Panel

Admin panel minimal:

```text
Dashboard

Orders
├── All
├── Unpaid
├── Waiting Info
├── Queued
├── Processing
├── Failed
└── Delivered

Tasks
├── Manual Delivery
├── Waiting Info
├── Failed Automation
└── Refund Review

Products
Categories
Games
Provider Mapping
Inventory
Customers
Payments
Refunds
Ledger
Tickets
Knowledge Base
Providers
Audit Logs
System Logs
```

---

# 38. Admin Task Queue

Manual operation harus menjadi task.

Contoh:

```text
Task
├── type
├── order_id
├── order_item_id
├── assigned_to
├── priority
├── status
├── due_at
└── completed_at
```

Task:

```text
REQUEST_CUSTOMER_INFO
MANUAL_DELIVERY
MANUAL_ACCOUNT_ASSIGNMENT
FAILED_TOPUP_REVIEW
REFUND_REVIEW
```

Admin dapat:

```text
Assign
Start
Complete
Escalate
```

---

# 39. Webhook Gateway

Buat endpoint terpisah:

```text
/api/webhooks/*
```

Contoh:

```text
/api/webhooks/digiflazz
/api/webhooks/xendit
/api/webhooks/midtrans
```

Flow:

```text
Provider
 ↓
Webhook endpoint
 ↓
Verify signature/authentication
 ↓
Idempotency check
 ↓
Normalize event
 ↓
Application service
 ↓
Update domain
 ↓
Outbox
```

Jangan membiarkan provider webhook langsung mengubah database secara acak.

---

# 40. Idempotency

Sistem harus aman terhadap duplicate:

- payment webhook
- provider callback
- top-up retry
- notification retry
- worker retry

Gunakan unique references:

```text
idempotency_key
external_reference
provider_transaction_id
```

Contoh:

```text
Payment SUCCESS
Payment SUCCESS
```

tetap hanya menghasilkan:

```text
1 paid order
1 fulfillment
1 delivery
```

---

# 41. Outbox Pattern

Gunakan SQLite WAL + transactional outbox.

Contoh:

```text
Payment confirmed

DB transaction:
├── payment.status = PAID
├── order.status = PAID
└── outbox.event = PAYMENT_PAID
```

Worker:

```text
Outbox
 ↓
Fulfillment
 ↓
Notification
```

Outbox worker harus:

- retry
- backoff
- idempotent
- record attempts
- record failure
- avoid duplicate fulfillment

---

# 42. Worker Jobs

Minimal worker dapat menangani:

```text
Expire unpaid payments
Release expired inventory reservations
Process outbox
Process instant fulfillment
Retry provider calls
Process notifications
Reconcile provider transactions
```

Jangan membuat cron logic tersebar di banyak tempat.

---

# 43. Provider Health

Jika memungkinkan, track:

```text
ProviderHealth
├── provider
├── game_id?
├── success_count
├── failure_count
├── average_latency
├── last_success_at
└── last_failure_at
```

Namun jangan membuat provider health terlalu kompleks pada phase pertama.

Priority-based fallback sudah cukup.

---

# 44. Audit Log

Semua tindakan penting harus dapat ditelusuri.

Contoh:

```text
Order #123

20:01 CREATED
20:02 PAYMENT_PENDING
20:03 PAID
20:03 QUEUED
20:04 PROCESSING
20:04 DIGIFLAZZ_REQUESTED
20:05 DIGIFLAZZ_SUCCESS
20:05 DELIVERED
```

Admin action:

```text
Admin A
PROCESSING → DELIVERED
```

Audit log harus mencatat:

```text
actor
action
entity
entity_id
before
after
timestamp
request/correlation ID
```

Jangan menyimpan password/account credential dalam audit log.

---

# 45. Correlation ID

Setiap request/order/provider operation sebaiknya memiliki correlation ID.

Contoh:

```text
request_id = req_abc123
order_id = ORD-20260823-0001
provider_reference = DF-xxxxx
```

Log harus dapat ditelusuri:

```text
Order
 ↓
Payment
 ↓
Nickname
 ↓
Digiflazz
 ↓
Notification
```

dengan correlation ID yang konsisten.

---

# 46. Security

Provider API keys:

```text
environment variables / secret manager
```

Contoh:

```text
DIGIFLAZZ_API_KEY
VIPRESELLER_API_KEY
KOKINPAY_API_KEY
MELOSTORE_API_KEY
```

Jangan:

- commit credential
- expose credential ke frontend
- simpan credential di game mapping
- log credential
- log full sensitive delivery data

Validasi webhook signature/provider authentication.

Gunakan rate limiting pada endpoint sensitif:

```text
nickname check
login
checkout
payment
```

---

# 47. Observability

Minimal:

```text
Structured logs
Error tracking
Provider latency
Provider success/failure
Order lifecycle
Webhook attempts
Worker failures
```

Dashboard admin dapat menampilkan:

```text
Orders today
Revenue
Profit estimate
Failed fulfillment
Pending manual tasks
Provider failure rate
Nickname check failure rate
```

---

# 48. Database

Untuk tahap sekarang:

```text
SQLite
+
WAL
+
single PrismaClient
```

Tetap gunakan transaction untuk operasi yang membutuhkan atomicity.

Contoh:

```text
Create order
+
reserve inventory
+
create payment
```

harus dirancang secara konsisten.

Jangan membuat koneksi database terpisah untuk setiap package.

---

# 49. Infrastruktur awal

Jangan langsung microservices.

Recommended:

```text
Cloudflare
    ↓
Nginx
    ↓
Node.js Trustance
    ├── Storefront
    ├── Admin
    ├── API
    └── Telegram Bot
    ↓
SQLite WAL
    ↓
Worker / Outbox Dispatcher
```

Satu VPS cukup untuk tahap awal.

---

# 50. Future Scaling

Jangan mendesain dengan asumsi SQLite akan selamanya.

Jika volume meningkat:

```text
Current:

1 VPS
SQLite WAL
Node.js
Worker

        ↓

Future:

Cloudflare
   ↓
Load Balancer
   ↓
API instances
   ↓
PostgreSQL
   ↓
Dedicated workers
```

Kemudian Redis dapat ditambahkan jika diperlukan untuk:

- distributed locking
- cache
- rate limiting
- queue
- multi-instance coordination

Jangan menambahkan Redis/Kafka/Kubernetes hanya karena terlihat lebih enterprise.

---

# 51. Target Repository Structure

Gunakan existing structure sebagai baseline:

```text
apps/
├── server/
│   └── src/
│       ├── index.ts
│       └── composition.ts
│
├── storefront/
├── web-admin/
└── order-bot/

packages/
├── core/
├── db/
├── catalog/
├── customer/
├── checkout/
├── orders/
├── payments/
├── fulfillment/
├── inventory/
├── nickname/
├── pricing/
├── ledger/
├── notifications/
├── tasks/
├── webhooks/
├── audit/
├── providers/
│   ├── digiflazz/
│   ├── vipreseller/
│   ├── kokinpay/
│   └── melostore/
└── web-ui/
```

Sesuaikan dengan codebase yang sudah ada.

---

# 52. Dependency Rules

Aturan penting:

```text
Channel
   ↓
Application
   ↓
Domain
   ↓
Infrastructure adapters
```

Jangan:

```text
Domain
 ↓
Telegram
```

atau:

```text
Order domain
 ↓
Digiflazz SDK
```

Domain harus bergantung pada interface.

Provider-specific implementation berada di infrastructure/provider layer.

---

# 53. Jangan Overengineering

Jangan langsung membuat:

- microservices
- Kafka
- Kubernetes
- Redis cluster
- distributed tracing kompleks
- event bus eksternal

Jika modular monolith + SQLite WAL + outbox + worker sudah cukup.

Fokus pada:

1. correctness
2. idempotency
3. transactional consistency
4. provider abstraction
5. fulfillment reliability
6. auditability
7. operational simplicity

---

# 54. Implementation Phases

## Phase 0 — Inspect

Sebelum coding:

- inspect repository
- inspect Prisma schema
- inspect existing order model
- inspect product model
- inspect Digiflazz integration
- inspect Telegram bot
- inspect storefront
- inspect admin
- inspect notification/outbox
- inspect existing provider abstraction
- inspect current nickname check implementation

Jangan langsung membuat model baru sebelum memahami codebase.

---

## Phase 1 — Core Commerce

Implement/refactor:

```text
Customer
Catalog
Product
Cart
Checkout
Order
OrderItem
```

Pastikan multi-item cart dapat bekerja.

---

## Phase 2 — Payment

Implement:

```text
Payment
Payment status
Expiration
Webhook
Idempotency
```

---

## Phase 3 — Fulfillment

Implement:

```text
Fulfillment Engine
Manual User Info
Manual Account
Instant
Game Top Up
```

Fulfillment wajib berada pada order item.

---

## Phase 4 — Inventory

Implement:

```text
InventoryItem
Reservation
Release
Assignment
Sold state
```

---

## Phase 5 — Game

Implement:

```text
Game
Game Input Schema
Product → Game
ProviderGameMapping
```

---

## Phase 6 — Nickname

Implement:

```text
NicknameProvider interface
VIPReseller adapter
Kokinpay adapter
Melostore adapter
Nickname Router
Fallback
Error classification
```

---

## Phase 7 — Digiflazz

Implement/refactor:

```text
TopupProvider interface
Digiflazz adapter
Transaction request
Transaction status
Webhook/reconciliation
Idempotency
```

---

## Phase 8 — Pricing & Financial

Implement:

```text
Pricing Engine
Price snapshot
Ledger
Refund
```

---

## Phase 9 — Admin Operations

Implement:

```text
Task Queue
Manual fulfillment
Failed automation
Refund review
Provider mapping
Inventory management
```

---

## Phase 10 — Notifications

Implement:

```text
Telegram
Email
Web notification
Outbox
Retry
```

---

## Phase 11 — Observability

Implement:

```text
Audit log
Correlation ID
Provider logs
Worker logs
Failure monitoring
```

---

# 55. Testing Requirements

Minimal test coverage harus mencakup:

## Catalog

```text
Product active
Product inactive
Game mapping
```

## Checkout

```text
Valid cart
Invalid product
Insufficient stock
Invalid game input
Price snapshot
```

## Payment

```text
Success
Failed
Expired
Duplicate webhook
```

## Inventory

```text
Reserve
Release
Sell
Concurrent reservation
```

## Nickname

```text
Provider success
Provider timeout
Fallback
Invalid target
Game not supported
Provider disabled
Priority
Normalized response
```

## Digiflazz

```text
Transaction success
Transaction pending
Transaction failed
Duplicate callback
Retry
```

## Fulfillment

```text
Manual info
Manual account
Instant
Game top-up
Mixed cart
```

## Refund

```text
Create refund
Complete
Failed
Duplicate request
```

---

# 56. Critical Business Scenarios

Pastikan architecture dapat menangani scenario berikut.

## Scenario A — Premium manual email

```text
Customer
→ checkout
→ payment
→ PAID
→ WAITING_FOR_INFO
→ customer submits email
→ admin fulfills
→ DELIVERED
```

## Scenario B — Premium manual account

```text
Customer
→ payment
→ PAID
→ account reserved
→ admin assigns
→ delivery
→ SOLD
```

## Scenario C — Premium instant

```text
Customer
→ payment
→ PAID
→ automated fulfillment
→ delivery
```

## Scenario D — Game topup

```text
Customer
→ select game
→ enter User ID / Zone
→ nickname check
→ confirm nickname
→ payment
→ Digiflazz
→ success
→ delivered
```

## Scenario E — Nickname provider fallback

```text
VIPReseller timeout
→ Melostore
→ success
```

## Scenario F — Invalid game ID

```text
Invalid target
→ stop
→ show customer-friendly error
```

## Scenario G — Digiflazz failure

```text
Payment successful
→ Digiflazz failed
→ retry/reconciliation
→ if permanently failed:
   manual review or refund
```

## Scenario H — Mixed cart

```text
Order
├── Premium manual
├── Premium instant
└── Game topup
```

Setiap order item harus dapat menjalankan fulfillment berbeda tanpa merusak order lainnya.

---

# 56A. Support Acceptance Scenarios

The support system must support:

## General question

```text
Customer
→ FAQ / Knowledge Base
→ answer
→ no ticket required
```

## Customer creates ticket from website

```text
Website
→ Create Ticket
→ Ticket OPEN
→ Admin reply
→ WAITING_CUSTOMER
→ Customer reply
→ WAITING_ADMIN
→ RESOLVED
→ CLOSED
```

## Customer creates ticket from Telegram

```text
Telegram
→ Create Ticket
→ same customer identity
→ same ticket system
→ Admin reply
→ Telegram notification
```

## Order-specific complaint

```text
Customer
→ Ticket
→ order_id = ORD-1001
→ order_item_id = ITEM-3
→ Admin investigates
→ Task created
→ Task completed
→ Ticket resolved
```

## Internal note

```text
Admin
→ Internal note
→ visible to staff only
→ never delivered to customer
```

## Reopen

```text
CLOSED
→ customer replies / reopen
→ OPEN
```

## Ticket and failed fulfillment

```text
Game Topup
→ Digiflazz failed
→ Admin Task
→ Customer has Ticket
→ Task linked to Ticket
→ investigation
→ resolution
→ customer notified
```

# 57. Acceptance Criteria

Implementasi dianggap benar jika:

- Website dan Telegram menggunakan business logic yang sama.
- Customer dapat memiliki identity lintas channel.
- Cart dapat berisi beberapa product.
- Order dapat memiliki banyak item.
- Setiap order item memiliki fulfillment sendiri.
- Premium manual email dapat meminta information.
- Premium manual account dapat menggunakan inventory/account pool.
- Instant product dapat fulfilled otomatis.
- Game top-up dapat menggunakan Digiflazz.
- Nickname check dapat menggunakan VIPReseller, Kokinpay, atau Melostore.
- Game code provider yang berbeda dapat dimapping melalui internal canonical `game_id`.
- Nickname provider dapat fallback berdasarkan priority.
- Invalid target tidak menyebabkan fallback yang tidak perlu.
- Provider API response dinormalisasi.
- Payment webhook idempotent.
- Digiflazz transaction idempotent.
- Inventory reservation aman.
- Payment expiration me-release reservation.
- Refund memiliki financial record.
- Harga order di-snapshot.
- Audit trail tersedia.
- Notifications tidak tightly coupled ke OrderService.
- Provider credentials tidak bocor.
- Worker dapat retry tanpa membuat duplicate fulfillment.
- Existing functionality tetap backward-compatible sejauh mungkin.

---

# 58. Golden Rules

Selama implementasi, ikuti aturan ini:

1. **SKU produk bukan Game ID.**
2. **Game ID bukan provider game code.**
3. **Transaction provider bukan nickname provider.**
4. **Provider bukan domain business logic.**
5. **Website dan Telegram bukan dua backend.**
6. **Fulfillment berada pada Order Item.**
7. **Payment success tidak otomatis berarti delivery success.**
8. **Cancelled tidak sama dengan refunded.**
9. **Stock count tidak menggantikan inventory reservation.**
10. **Webhook harus idempotent.**
11. **Provider retry harus idempotent.**
12. **Frontend tidak boleh mengetahui provider-specific logic.**
13. **Telegram bot tidak boleh mempunyai business logic duplikat.**
14. **API credentials tidak boleh berada di database catalog/mapping.**
15. **Gunakan canonical internal IDs.**
16. **Gunakan adapter untuk provider.**
17. **Gunakan outbox untuk reliable asynchronous work.**
18. **Gunakan audit log untuk operasi penting.**
19. **Jangan membuat microservices sebelum ada kebutuhan nyata.**
20. **Prioritaskan reliability dan correctness daripada kompleksitas infrastructure.**

---

# 59. Final Target Architecture

```text
                         TRUSTANCE
                            │
          ┌─────────────────┴─────────────────┐
          │                                   │
      WEBSITE                            TELEGRAM BOT
          │                                   │
          └─────────────────┬─────────────────┘
                            │
                            ▼
                    APPLICATION LAYER
                            │
       ┌────────────────────┼────────────────────┐
       │                    │                    │
       ▼                    ▼                    ▼
   CUSTOMER              CATALOG              CHECKOUT
       │                    │                    │
       └────────────────────┼────────────────────┘
                            ▼
                          ORDER
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
     PAYMENT           FULFILLMENT           LEDGER
                            │
            ┌───────────────┼────────────────┐
            │               │                │
            ▼               ▼                ▼
         MANUAL          INSTANT          GAME TOPUP
            │                                │
     ┌──────┴──────┐                         │
     │             │                         │
     ▼             ▼                         ▼
User Info       Account                   NICKNAME
     │          Inventory                     │
     │                               ┌────────┼────────┐
     │                               │        │        │
     │                               ▼        ▼        ▼
     │                             VIP     Kokin     Melo
     │
     └─────────────────────────────────────────────┐
                                                   ▼
                                              DELIVERY


GAME TOPUP TRANSACTION
        │
        ▼
   Digiflazz
        │
        ▼
   Transaction
        │
        ▼
     Delivery


CROSS-CUTTING
├── Pricing
├── Inventory
├── Notifications
├── Tasks
├── Webhooks
├── Idempotency
├── Outbox
├── Worker
├── Audit
└── Observability
```

---

# 60. Final Implementation Instruction

Do not blindly implement this document.

First inspect the existing Trustance codebase and identify:

1. Existing domain models
2. Existing Prisma schema
3. Existing order flow
4. Existing product flow
5. Existing Digiflazz integration
6. Existing nickname check
7. Existing Telegram bot
8. Existing storefront
9. Existing admin
10. Existing outbox/notification implementation
11. Existing provider abstractions
12. Existing authentication/customer model

Then produce an implementation plan showing:

```text
Existing
   ↓
Required change
   ↓
New module
   ↓
Migration
   ↓
Tests
```

Prefer incremental migration over rewriting the entire system.

Preserve working functionality.

Before changing database schema, identify migration/backward-compatibility implications.

Before creating a new abstraction, check whether an equivalent abstraction already exists.

Before creating a new provider client, check whether the project already has an HTTP client/config/provider infrastructure.

The final implementation should result in a **modular monolith that is simple enough to run on one VPS today, but architecturally prepared for PostgreSQL, multiple workers, additional payment gateways, additional top-up providers, additional nickname providers, additional channels, and eventual service extraction if scale requires it.**


AFTER PATCH:
# Review: Trustance Master Implementation Prompt

Dokumen aslinya sudah kuat pada **pemisahan domain vs provider**, **fulfillment per order item**, dan **anti-overengineering**. Kekurangannya hampir semuanya ada di lapisan yang lebih dalam: *korektnes uang, concurrency di SQLite, penanganan kegagalan yang ambigu, dan beberapa kontradiksi internal*. Sebagai **prompt untuk AI implementer**, banyak instruksi masih berupa niat ("gunakan locking yang aman") bukan aturan yang bisa dieksekusi — model akan mengarang detailnya, dan tiap sesi mengarang berbeda.

Satu hal yang tidak muncul sama sekali di dokumen asli tapi mengubah banyak keputusan: **Trustance memakai dua mata uang, IDR dan USDT.** Konsekuensinya dibahas di B1, B1a, B2a, B2b, dan B2c.

Format: **Kekurangan → Dampak → Perbaikan.**

---

## KEPUTUSAN DESAIN — Kebijakan komposisi cart

Bagian ini adalah **keputusan produk yang sudah diambil**, bukan temuan. Ditaruh paling atas karena mengubah cara membaca bagian-bagian di bawahnya.

### Keputusan

> Produk bertipe `GAME_TOPUP` **tidak boleh** berada dalam keranjang yang sama dengan tipe fulfillment lain.
> Satu checkout top-up = **satu item**.
> Cart multi-item hanya untuk produk premium apps (`MANUAL_USER_INFO`, `MANUAL_ACCOUNT`, `INSTANT`).

Dokumen asli (§11, Skenario H) mengizinkan mixed cart penuh. Kebijakan ini **membatalkan** izin itu di level aturan bisnis.

### Alasan

**UX.** Mixed cart memaksa customer menghadapi tiga hal yang tidak nyambung dalam satu alur: input User ID + nickname check *sebelum* bayar, email *sesudah* bayar, dan satu item selesai dalam 10 detik sementara item lain baru selesai tiga jam kemudian. Halaman "pesanan saya" jadi ambigu — sudah selesai atau belum.

**Finansial.** Kegagalan satu item dalam satu pembayaran menuntut refund parsial. QRIS dan VA di Indonesia sering tidak mendukung refund parsial, sehingga jalurnya menjadi transfer manual atau store credit. Mixed cart mengubah setiap kegagalan menjadi pekerjaan manual dan tiket support.

**Harga.** Harga Digiflazz bergerak. Item top-up yang duduk 20 menit di keranjang berisiko dijual di harga basi.

**Perilaku nyata.** Alur satu-item untuk top-up (pilih game → input ID → cek nickname → pilih nominal → bayar) adalah standar industri, bukan kompromi. Menambahkan keranjang di alur itu menurunkan konversi.

### Yang TIDAK ikut dibatalkan

**Fulfillment tetap berada di level `OrderItem`.** Ini keputusan terpisah dan tetap wajib, meskipun mixed cart ditutup:

- **Qty > 1 sudah cukup menciptakan kegagalan parsial.** Beli 3 akun Netflix, akun ke-2 ternyata mati → satu order, tiga penyerahan, satu gagal.
- **Cart premium yang homogen pun tetap mencampur strategi** — CapCut `MANUAL_ACCOUNT` dan Canva `INSTANT` dalam satu keranjang.
- **Bundle/paket promo** di masa depan menuntut hal yang sama.

Menaruh fulfillment di order item **murah bila dikerjakan dari awal, sangat mahal untuk di-retrofit**. Yang mahal adalah *membuka* mixed cart ke publik, bukan *memodelkannya*. Jadi: model penuh, izin dibatasi.

### Tempat penegakan

Aturan ini ditegakkan di **cart/checkout service**, **bukan** di UI.

Kalau hanya divalidasi di frontend, bot Telegram akan melanggarnya dalam dua minggu — persis masalah "dua business logic" yang dilarang dokumen di §2 dan Golden Rule #13.

### Aturan siap tempel untuk master prompt

```text
CART COMPOSITION RULE

Cart memiliki atribut turunan: cart_kind.

cart_kind = TOPUP     jika berisi item GAME_TOPUP
cart_kind = PREMIUM   jika berisi item MANUAL_USER_INFO | MANUAL_ACCOUNT | INSTANT

Aturan:
1. Cart bertipe TOPUP hanya boleh berisi TEPAT SATU item, qty = 1.
2. Cart tidak boleh mencampur cart_kind yang berbeda.
3. Menambahkan item GAME_TOPUP ke cart PREMIUM (atau sebaliknya)
   ditolak dengan error CART_KIND_CONFLICT.
4. Cart PREMIUM boleh berisi banyak item dan qty > 1.
5. Validasi WAJIB berada di cart/checkout service.
   UI hanya mencerminkan aturan ini, tidak mendefinisikannya.
6. Bot Telegram, storefront, dan admin tunduk pada aturan yang sama.

Model data TIDAK dibatasi oleh aturan ini:
- OrderItem tetap menyimpan fulfillment_type sendiri
- Order tetap mampu menampung banyak item dengan strategi berbeda
- Aturan di atas adalah kebijakan runtime yang dapat dilonggarkan
  tanpa migrasi skema
```

### Dampak ke prioritas

Karena refund parsial jadi jarang, beberapa hal turun prioritas:

| Item | Sebelumnya | Sekarang |
|---|---|---|
| Wallet / store credit | syarat rilis | kenyamanan, bisa menyusul |
| `RefundItem` (refund per item) | wajib fase awal | tetap dimodelkan, eksekusi bisa manual dulu |
| Alokasi fee proporsional per item | wajib | tetap perlu (qty > 1 & cart premium), tapi kasusnya lebih sederhana |
| `PARTIALLY_DELIVERED` | wajib | **tetap wajib** — qty > 1 dan cart premium tetap memproduksinya |
| Agregasi notifikasi per order | wajib | tetap perlu, tapi lebih sederhana |

### Kapan dibuka kembali

Longgarkan aturan (hapus poin 2 dan 3 di atas) hanya setelah keempat hal ini siap:

1. `OrderItem.status` sudah jadi source of truth, `PARTIALLY_DELIVERED` berjalan
2. Wallet / store credit sudah jalan
3. `RefundItem` sudah bisa dieksekusi tanpa campur tangan manual
4. Admin queue sudah berbasis item, bukan berbasis order

Karena aturannya ada di service dan bukan di skema, pembukaan ini adalah perubahan satu kondisi — bukan migrasi.

### Cross-sell tanpa cart

Kehilangan cross-sell dalam satu transaksi itu nyata. Obatnya bukan cart: tawarkan "beli lagi" di **halaman sukses pembayaran**, saat customer paling mungkin membeli lagi dan tidak ada satu pun pembayaran yang perlu dicampur.

### Skenario penerimaan

> **Given** cart berisi 1 item `GAME_TOPUP`
> **When** customer menambahkan produk premium apps
> **Then** ditolak dengan `CART_KIND_CONFLICT`, dan hal yang sama terjadi bila permintaan datang dari bot Telegram maupun API langsung.

> **Given** cart berisi 2 item premium (`MANUAL_ACCOUNT` + `INSTANT`)
> **When** checkout dan pembayaran berhasil
> **Then** item `INSTANT` `DELIVERED` dalam hitungan detik, item `MANUAL_ACCOUNT` masuk `QUEUED` + `AdminTask`, dan `order.status` = `PARTIALLY_DELIVERED` — tanpa salah satu memblokir yang lain.

---

## BAGIAN A — Kontradiksi & inkonsistensi internal

### A1. Product terikat ke satu transaction provider, tapi dokumen menjanjikan provider fallback

**Kekurangan.** §7 menaruh `transaction_provider` + `provider_sku` langsung di tabel `Product`. Tapi §0 dan §30 menjanjikan "provider fallback dan provider capability", dan §25 sudah benar memakai tabel mapping untuk nickname.

**Dampak.** Saat Digiflazz down atau SKU-nya kosong, tidak ada jalur ke provider kedua tanpa migrasi skema. Ini persis kesalahan desain yang dilarang dokumen di §1.

**Perbaikan.** Simetriskan dengan `ProviderGameMapping`:

```text
ProductProviderMapping
├── product_id
├── provider            (digiflazz | ...)
├── provider_sku        (ML86)
├── provider_cost       (HPP terakhir dari price list)
├── cost_synced_at
├── enabled
├── priority
└── updated_at
```

`Product.transaction_provider` dihapus (atau dijadikan kolom cache read-only hasil resolusi priority tertinggi). Aturan: **routing provider adalah keputusan runtime, bukan atribut katalog.**

### A2. Order status vs Order item status tidak pernah didamaikan

**Kekurangan.** §14 mendefinisikan status di level Order. §17 menyatakan fulfillment ada di level Order Item. Tidak pernah dijawab: item 1 DELIVERED, item 2 FAILED → `order.status` = apa? Menutup mixed cart **tidak** menghilangkan masalah ini — cart premium multi-item dan qty > 1 tetap memproduksinya.

**Dampak.** Ini akan jadi bug pertama yang muncul di produksi, dan setiap developer/AI akan menebak berbeda.

**Perbaikan.** Nyatakan eksplisit:
- **`OrderItem.status` adalah source of truth.** Enum sendiri: `PENDING, WAITING_FOR_INFO, INFO_SUBMITTED, QUEUED, PROCESSING, IN_DOUBT, DELIVERED, FAILED, REFUNDED, CANCELLED`.
- **`Order.status` adalah nilai turunan (derived)**, dihitung ulang setiap kali item berubah, dengan fungsi tunggal `recomputeOrderStatus(orderId)`.
- Tambahkan status order yang hilang: `PARTIALLY_DELIVERED`, `PARTIALLY_REFUNDED`.
- Aturan turunan ditulis eksplisit, contoh: semua item DELIVERED → `DELIVERED`; ada DELIVERED & ada FAILED → `PARTIALLY_DELIVERED`; semua FAILED → `FAILED`.

### A3. `IN_DOUBT` tidak ada di seluruh dokumen

**Kekurangan.** Status yang tersedia hanya SUCCESS/FAILED. Padahal kasus paling sering di top-up adalah **timeout**: request terkirim, response tidak diterima. Bukan sukses, bukan gagal.

**Dampak.** AI implementer akan memperlakukan timeout sebagai FAILED → retry → **double top-up** (uang hilang, tidak bisa ditarik kembali) atau refund padahal barang sudah masuk.

**Perbaikan.** Tambahkan state `IN_DOUBT` / `UNKNOWN` di fulfillment & provider transaction, dengan aturan mati:
> Timeout atau network error pada operasi **write** (top-up, refund, payment charge) **tidak pernah** boleh di-retry dengan membuat transaksi baru. Wajib masuk `IN_DOUBT`, lalu diselesaikan oleh reconciliation worker yang melakukan *status check* memakai `ref_id` yang sama. Hanya operasi **read** (nickname check, balance) yang boleh retry bebas.

### A4. Struktur repo (§51) tidak sinkron dengan daftar modul (§4)

**Kekurangan.** §4 menyebut `tickets/`, `support/`; §51 tidak memuatnya, juga tidak ada `refunds/`, `knowledge-base/`, `promotions/`, `wallet/`.

**Perbaikan.** Samakan kedua daftar, atau lebih baik: hapus §51 sebagai daftar folder dan ganti jadi **aturan dependency + rule linting** (lihat F3). Daftar folder yang tidak sinkron membuat AI membuat package kosong.

### A5. Bahasa dokumen campur Indonesia–Inggris

**Kekurangan.** §33A, §33B, §56A dalam bahasa Inggris; sisanya Indonesia.

**Dampak.** Kecil tapi nyata untuk prompt: model cenderung mengikuti bahasa section terdekat saat menulis komentar kode, pesan error, dan commit message → codebase jadi campur.

**Perbaikan.** Pilih satu bahasa untuk dokumen, lalu tambahkan aturan terpisah: *"identifier, kode, dan log berbahasa Inggris; pesan yang menghadap customer berbahasa Indonesia melalui layer i18n."*

---

## BAGIAN B — Korektnes uang, mata uang ganda & data

### B1. Tipe data uang tidak pernah ditentukan

**Kekurangan.** `price`, `amount`, `fee`, `subtotal` disebut tanpa tipe. Prisma + SQLite default ke `Float`.

**Dampak.** Float untuk uang = selisih pembulatan di ledger, laporan profit tidak pernah balance. Sulit diperbaiki setelah ada data produksi.

**Perbaikan.** Aturan wajib:
> Semua nilai uang disimpan sebagai **`BigInt` dalam satuan terkecil mata uang tersebut**. Dilarang `Float`, `Decimal`, dan `Int` 32-bit untuk uang. Uang tidak pernah berupa angka telanjang — selalu pasangan `(amount: BigInt, currency: string)`. Pembulatan hanya terjadi di layer presentasi, dengan mode yang ditulis eksplisit (`ROUND_HALF_UP`).

**Kenapa `BigInt`, bukan `Int`.** Trustance memakai **dua mata uang: IDR dan USDT**, dan `Int` 32-bit pecah pada keduanya:

| | Skala | Batas `Int` (2.147.483.647) | Batas `BigInt` (9,22 × 10¹⁸) |
|---|---|---|---|
| IDR | 0 desimal | Rp2,1 miliar — cukup untuk satu order, **tidak cukup** untuk total ledger | aman |
| USDT | 6 desimal | **2.147 USDT** — pecah di hari pertama | ~9,2 triliun USDT |

Jangan mencampur tipe (`Int` untuk IDR, `BigInt` untuk USDT). Begitu ada satu fungsi yang menangani keduanya, itu jadi bug yang menunggu waktu. **Semua kolom uang `BigInt`, tanpa pengecualian.**

**Jebakan `BigInt` di Node/Prisma yang wajib ditulis di dokumen.** `JSON.stringify` melempar `TypeError` pada `BigInt`. Tanpa serializer terpusat, setiap response API yang memuat uang akan crash. Sediakan satu serializer global, dan **kirim uang sebagai string di JSON, bukan number** — `Number` JS kehilangan presisi di atas 2⁵³.

### B1a. Skala mata uang harus jadi data, bukan asumsi

**Kekurangan.** Dokumen menyebut `currency` sebagai kolom, tapi tidak pernah mendefinisikan skalanya. Dengan dua mata uang berskala berbeda (IDR 0 desimal, USDT 6 desimal), "satuan terkecil" tidak lagi punya arti tunggal.

**Perbaikan.**

```text
Currency
├── code        IDR | USDT
├── scale       0 | 6
├── symbol
└── is_active
```

Tegakkan satu invariant di level tipe: **dilarang menjumlahkan atau membandingkan dua Money dengan `currency` berbeda.** Operasi lintas mata uang wajib melewati konversi eksplisit yang mencatat rate-nya.

**Jebakan USDT yang paling sering menjatuhkan orang: desimal berbeda per chain.** TRC20 dan ERC20 memakai 6 desimal, tapi **BEP20 memakai 18**. Menyimpan nilai on-chain mentah dari BSC ke `BigInt` 64-bit meluap di sekitar **9,2 USDT**. Aturannya: **normalisasi ke skala internal 6 di dalam adapter payment**, segera setelah membaca dari chain. Nilai mentah on-chain tidak pernah boleh masuk ke domain.

### B2. Ledger bukan double-entry, dan "immutable jika memungkinkan" terlalu longgar

**Kekurangan.** §32 modelnya satu sisi (`amount` + `direction`), tanpa pasangan debit/kredit dan tanpa larangan UPDATE. Dokumen juga tidak pernah membahas bagaimana pendapatan USDT dipertemukan dengan HPP rupiah.

**Dampak.** Tidak ada invariant yang bisa diuji. Salah hitung tidak akan ketahuan sampai rekonsiliasi manual. Dan tanpa FX, **profit tidak bisa dihitung sama sekali** untuk order berbayar USDT, karena Digiflazz menagih dalam IDR.

**Perbaikan.**
- Ganti jadi entri berpasangan dalam satu `LedgerTransaction`, dengan invariant yang diuji di test: **Σ debit = Σ kredit per transaksi, per mata uang**.
- Chart of accounts minimal: `CASH_GATEWAY`, `CASH_CRYPTO`, `GATEWAY_FEE`, `NETWORK_FEE`, `REVENUE`, `COGS`, `PROVIDER_BALANCE`, `REFUND`, `CUSTOMER_WALLET`, `FX_ROUNDING`, `WRITE_OFF`.
- Ledger **append-only, tanpa pengecualian**. Koreksi dilakukan lewat *reversing entry*, bukan UPDATE/DELETE. Tegakkan lewat trigger DB, bukan sekadar konvensi kode.
- **HPP dicatat saat fulfillment, bukan saat checkout**, karena harga Digiflazz bergerak. Simpan `provider_cost` aktual dari response provider.

### B2a. Reporting currency dan FX

**Kekurangan.** Tidak ada di dokumen sama sekali, padahal wajib begitu ada dua mata uang.

**Perbaikan.** Tetapkan **IDR sebagai reporting currency** — di situlah biaya (HPP Digiflazz, gaji, operasional) berada. Setiap entri ledger menyimpan nilai asli **dan** nilai terkonversi:

```text
LedgerEntry
├── amount           BigInt   (nilai asli)
├── currency         IDR | USDT
├── base_amount      BigInt   (selalu IDR)
├── base_currency    IDR
├── fx_rate_num      BigInt
├── fx_rate_den      BigInt
├── fx_source
└── fx_at
```

Simpan rate sebagai **pasangan numerator/denominator**, bukan angka desimal. Contoh 1 USDT = Rp16.250:

```text
fx_rate_num = 16250        (IDR minor, scale 0)
fx_rate_den = 1_000_000    (USDT minor, scale 6)

idr_minor = usdt_minor × fx_rate_num / fx_rate_den
```

Rasio eksak menghilangkan pembulatan ganda, bekerja langsung antar skala berbeda, dan bisa diaudit ulang tiga bulan kemudian.

Aturan tambahan:
- Sisa pembulatan konversi masuk akun **`FX_ROUNDING`**. Tanpa itu, invariant Σ debit = Σ kredit akan gagal dan kamu akan mencari bug di tempat yang salah.
- **Rate di-snapshot ke order saat checkout**, tidak pernah diambil ulang saat pelaporan. Kalau tidak, laporan bulan lalu berubah setiap kali kurs bergerak.
- Simpan `fx_source` (nama penyedia rate) — dibutuhkan saat angka dipertanyakan.

### B2b. Pricing USDT tidak boleh mengikuti kurs real-time

**Kekurangan.** Tidak dibahas. Perilaku default yang akan dipilih AI implementer adalah menghitung harga USDT dari kurs saat request — dan itu salah secara produk.

**Dampak.** Harga bergoyang setiap kali halaman di-refresh. Customer kehilangan kepercayaan, dan harga bisa berubah antara halaman produk dan halaman pembayaran.

**Perbaikan.** Gunakan **price book per mata uang**: harga USDT ditetapkan sebagai nilai tetap, di-refresh oleh worker berkala terhadap kurs dengan **margin buffer** (mis. 2%) untuk menyerap volatilitas. Harga hanya berubah saat price book diperbarui, tidak per request. Perubahan price book dicatat di audit log.

### B2c. Pembayaran USDT tidak pernah pas

**Kekurangan.** Model `Payment` di §15 hanya punya satu kolom `amount`. Itu mengasumsikan jumlah yang diminta sama dengan jumlah yang diterima — asumsi yang selalu salah untuk crypto.

**Dampak.** Customer mengirim 9,999998 USDT karena fee jaringan, atau kelebihan bayar, dan sistem menganggapnya belum lunas. Ini akan jadi sumber tiket support nomor satu untuk jalur USDT.

**Perbaikan.**
- Pisahkan `amount_expected` dan `amount_received` sebagai kolom berbeda.
- **Toleransi kurang bayar** eksplisit (mis. ≤ 0,5% atau ≤ nilai fee jaringan tertentu → tetap dianggap lunas).
- **Kebijakan kelebihan bayar**: selisih masuk `CUSTOMER_WALLET`, tidak pernah diabaikan diam-diam.
- **Jumlah konfirmasi minimum** per chain sebelum status menjadi `PAID`, dan penanganan reorg.
- **Pencocokan berdasarkan alamat atau memo unik per pembayaran — bukan berdasarkan nominal.** Mencocokkan pembayaran crypto lewat nominal saja adalah lubang keamanan: dua order berharga sama akan saling tertukar.
- Simpan `tx_hash` sebagai unique key — inilah idempotency key alami untuk webhook crypto.

### B3. Late payment (bayar setelah expired) tidak ditangani

**Kekurangan.** §16 hanya membahas expire → release. Tidak ada jalur untuk: order sudah `EXPIRED`, stok sudah dilepas, lalu webhook `PAID` masuk di menit ke-17. Ini kejadian sehari-hari di QRIS/VA.

**Dampak.** Uang masuk tapi tidak ada order aktif. Dana menggantung, customer komplain, tidak ada proses baku.

**Perbaikan.** Definisikan kebijakan eksplisit:
> Webhook `PAID` pada order `EXPIRED` **tidak boleh diabaikan**. Sistem harus: (1) mencatat pembayaran dan ledger tetap, (2) mencoba re-acquire stok/harga, (3) jika stok masih ada **dan** harga masih sama → order dihidupkan kembali ke `PAID`; (4) jika tidak → buat `Refund` otomatis berstatus `PENDING` + `AdminTask REFUND_REVIEW` + notifikasi customer. Order tidak pernah "hilang" secara diam-diam.

Tambahkan juga aturan TTL: **`reservation_ttl` = `payment_expiry` + buffer (mis. 3 menit)**, tidak boleh sama persis.

### B4. Refund tidak bisa parsial

**Kekurangan.** `Refund` hanya terhubung ke `order_id` + `payment_id`. Padahal refund satu item tetap dibutuhkan meski mixed cart ditutup — cart premium multi-item dan qty > 1 sudah cukup memproduksinya.

**Perbaikan.** Tambahkan `RefundItem { refund_id, order_item_id, amount, currency, reason }`, dan `refund_method` (`GATEWAY_REVERSAL | CRYPTO_TRANSFER | MANUAL_TRANSFER | STORE_CREDIT`). Tambahkan invariant: **Σ refund per order item ≤ subtotal item tersebut, dalam mata uang yang sama dengan pembayaran aslinya**.

**Khusus USDT:** refund wajib dikembalikan dalam **jumlah USDT yang sama**, bukan hasil konversi ulang dari IDR — kalau tidak, pergerakan kurs membuat customer menerima lebih sedikit dari yang ia bayar, dan itu jadi sengketa. Fee jaringan untuk pengembalian ditanggung siapa harus ditulis sebagai kebijakan eksplisit, bukan diputuskan admin per kasus.

### B5. Snapshot harga disebut, snapshot HPP dan pajak/fee tidak

**Perbaikan.** `OrderItem` juga menyimpan `cost_snapshot`, `fee_snapshot`, `pricing_rule_id`, `pricing_version`. Tanpa `pricing_rule_id`, pertanyaan "kenapa order ini dapat harga segini?" tidak bisa dijawab tiga bulan kemudian.

**Untuk order berbayar USDT**, `Order` juga wajib menyimpan snapshot FX: `fx_rate_num`, `fx_rate_den`, `fx_source`, `fx_at`, plus `price_book_version` yang dipakai. Ini yang membuat laporan periode lalu tetap stabil saat kurs bergerak.

---

## BAGIAN C — Concurrency & SQLite (paling berisiko)

### C1. "Gunakan transaction/locking yang aman" bukan instruksi yang bisa dieksekusi

**Kekurangan.** §22 dan §48 hanya menyuruh "aman". SQLite **tidak punya `SELECT ... FOR UPDATE`**. AI implementer yang terbiasa Postgres akan menulis `SELECT FOR UPDATE`, Prisma akan menerimanya di beberapa raw query atau diam-diam mengabaikannya → **race condition yang tidak terdeteksi di test single-thread**.

**Perbaikan.** Tulis pola konkret:

```text
Reservasi inventory (SQLite):
1. BEGIN IMMEDIATE   ← wajib, bukan BEGIN biasa
2. UPDATE inventory_items
   SET status='RESERVED', reserved_by=?, reserved_until=?
   WHERE id = (SELECT id FROM inventory_items
               WHERE product_id=? AND status='AVAILABLE'
               ORDER BY id LIMIT 1)
3. Jika changes() = 0 → stok habis → rollback → error OUT_OF_STOCK
4. COMMIT
```

Plus konfigurasi wajib saat boot:
`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`

### C2. Worker berjalan sebagai proses terpisah, tapi SQLite hanya punya satu writer

**Kekurangan.** §49 menggambarkan `outbox-dispatcher` sebagai proses terpisah dari API. Dengan SQLite, dua proses yang menulis bersamaan = `SQLITE_BUSY`.

**Perbaikan.** Pilih salah satu dan tulis di dokumen:
- **(Direkomendasikan untuk fase awal)** Worker jalan **in-process** di `apps/server` sebagai interval job, dengan lock in-memory. Satu proses = satu writer = tidak ada `SQLITE_BUSY`.
- Atau tetap terpisah, tapi wajib `busy_timeout` + transaksi tulis yang sangat pendek + retry pada `SQLITE_BUSY`.

Tulis juga alasannya, supaya keputusan ini tidak "dioptimasi" oleh AI di sesi berikutnya.

### C3. Job claiming tidak didefinisikan

**Kekurangan.** §41 hanya bilang worker "retry, backoff, idempotent". Bagaimana worker mengambil job tanpa mengambil job yang sama dua kali? Tidak ada.

**Perbaikan.** Pola lease:

```text
UPDATE outbox
SET locked_by=?, locked_until=?, attempts=attempts+1
WHERE id IN (
  SELECT id FROM outbox
  WHERE status='PENDING'
    AND available_at <= now
    AND (locked_until IS NULL OR locked_until < now)
  ORDER BY id LIMIT 10
)
```
Job yang lease-nya kedaluwarsa otomatis bisa diambil lagi → aman terhadap worker crash.

### C4. Prisma interactive transaction bisa membekukan seluruh sistem

**Kekurangan.** Tidak ada larangan memanggil provider HTTP di dalam transaksi.

**Perbaikan.** Aturan mati:
> **Dilarang** melakukan I/O jaringan di dalam transaksi database. Pola wajib: `transaksi → commit → panggil provider → transaksi baru untuk menulis hasil`. Timeout transaksi maksimal 5 detik.

### C5. Nomor order (`ORD-20260823-0001`) rawan tabrakan

**Perbaikan.** Tentukan mekanisme: tabel counter dengan `UPDATE ... RETURNING` di dalam `BEGIN IMMEDIATE`, atau ULID + nomor tampilan terpisah. Tentukan juga timezone: **simpan UTC, tampilkan Asia/Jakarta**, dan tanggal pada nomor order memakai Asia/Jakarta.

---

## BAGIAN D — Provider & kegagalan

### D1. Klasifikasi error mencampur dua sumbu yang berbeda

**Kekurangan.** §27 hanya punya "retryable" vs "non-retryable", dan menaruh `GAME_NOT_SUPPORTED` di retryable. Padahal itu bukan "coba lagi ke provider yang sama", melainkan "lompat ke provider berikutnya" — dua hal berbeda.

**Perbaikan.** Pisahkan tiga sumbu:

| Kelas error | Retry provider sama | Failover provider lain | Tampilkan ke customer |
|---|---|---|---|
| `TIMEOUT`, `NETWORK_ERROR` | ya (read) / **tidak** (write) | ya | tidak |
| `RATE_LIMITED` | ya, setelah backoff | ya | tidak |
| `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR` | terbatas | ya | tidak |
| `GAME_NOT_SUPPORTED`, `SKU_NOT_FOUND` | tidak | **ya** | tidak |
| `INSUFFICIENT_PROVIDER_BALANCE` | tidak | ya | tidak (alert admin) |
| `INVALID_TARGET/ZONE/SERVER` | tidak | tidak | **ya** |
| `UNKNOWN` (default) | tidak | tidak | tidak → `IN_DOUBT` |

Tambahkan aturan: **error yang tidak dikenali wajib jatuh ke `UNKNOWN`, bukan diasumsikan retryable.**

### D2. Nickname check adalah endpoint publik yang memanggil API berbayar

**Kekurangan.** §46 menyebut rate limiting sekilas, tapi tidak ada cache, kuota per provider, atau circuit breaker.

**Dampak.** Satu skrip iseng bisa menghabiskan kuota VIPReseller dalam hitungan menit, dan itu memblokir customer yang membayar.

**Perbaikan.**
- **Cache** hasil sukses: key `game_id:target:zone`, TTL 5–15 menit. Nickname jarang berubah.
- **Rate limit berlapis**: per IP, per customer, per game.
- **Circuit breaker** per provider: setelah N kegagalan berturut-turut, buka sirkuit selama M detik dan langsung failover — jangan tunggu timeout tiap request.
- **Timeout eksplisit** per provider (mis. 3 detik) dan **budget total** untuk seluruh rantai fallback (mis. 8 detik), supaya request user tidak menggantung.

### D3. Nickname yang dikonfirmasi customer tidak pernah diikat ke order

**Kekurangan.** §36 menyuruh "confirm nickname" lalu checkout. Tidak ada instruksi untuk memverifikasi ulang di server sebelum mengirim top-up.

**Dampak.** Client bisa mengirim `user_id` A untuk nickname yang ditampilkan B (langsung, atau karena user mengedit field setelah cek). Top-up masuk ke akun orang lain — **tidak bisa ditarik kembali**.

**Perbaikan.** Simpan `NicknameVerification { id, customer_id, game_id, input_hash, nickname, provider, verified_at, expires_at }`. `checkout` menerima `verification_id`, server memverifikasi bahwa `hash(input pada order item) == input_hash`. Jika tidak cocok atau kedaluwarsa → tolak dan minta cek ulang.

### D4. Sinkronisasi price list & saldo provider tidak ada sama sekali

**Kekurangan.** §30 menyebut capability `balance_check`, tapi tidak ada job yang memakainya, dan tidak ada sinkronisasi harga Digiflazz.

**Dampak.** Dua kegagalan bisnis paling umum di bisnis ini: (a) harga provider naik, produk tetap dijual → **rugi tiap transaksi**; (b) saldo provider habis → **semua top-up gagal serentak** tanpa peringatan.

**Perbaikan.** Tambahkan worker:
- `SyncProviderPriceList` (harian/berkala) → update `provider_cost`, dan **auto-disable produk** jika `cost >= selling_price - margin_minimum`, lalu buat `AdminTask PRICING_REVIEW`.
- `CheckProviderBalance` (tiap 15 menit) → alert saat di bawah ambang; opsional auto-disable `GAME_TOPUP` saat saldo kritis, dengan pesan customer-friendly.

### D5. Kebijakan degradasi tidak ada

**Kekurangan.** Kalau `nickname_required = true` tapi semua nickname provider mati: blokir checkout atau lanjut tanpa verifikasi? Dokumen diam.

**Perbaikan.** Tulis matriks degradasi eksplisit per komponen (nickname down, gateway down, Digiflazz down, Telegram down) berisi: apa yang tetap jalan, apa yang diblokir, pesan apa ke customer. Untuk nickname: **blokir checkout** (risiko salah kirim lebih mahal daripada kehilangan satu penjualan) — tapi keputusan ini harus tertulis, bukan diserahkan ke implementer.

---

## BAGIAN E — Keamanan & data pribadi

### E1. Kredensial akun disimpan di database tanpa enkripsi

**Kekurangan.** `InventoryItem.secret/reference` dan `DeliveryRecord.payload` berisi username/password akun premium. §46 hanya melarang **logging** kredensial — tidak menyebut penyimpanan.

**Dampak.** Satu file SQLite bocor (backup, snapshot VPS, salah taruh) = seluruh akun bocor. Pada satu VPS, file DB relatif mudah tersalin.

**Perbaikan.**
- Enkripsi di level aplikasi: **AES-256-GCM**, kunci dari env/secret manager, simpan `ciphertext + iv + tag + key_version` (siap rotasi kunci).
- Admin melihat kredensial lewat **reveal sekali-pakai** yang tercatat di audit log (`CREDENTIAL_REVEALED`, siapa, kapan, item mana).
- Default tampilan di admin: **masked**.

### E2. Autentikasi dan otorisasi tidak dibahas sama sekali

**Kekurangan.** Ini lubang terbesar dari sisi cakupan. Dokumen mensyaratkan "Telegram user dan website account harus dapat dikaitkan ke satu customer" (§5) tapi tidak menjelaskan **caranya** — padahal itu justru mekanisme yang rawan pengambilalihan akun.

**Perbaikan.** Tambahkan section baru:
- **Auth customer**: metode login web (email OTP / password + rate limit), sesi, refresh, logout semua perangkat.
- **Auth Telegram**: verifikasi `initData` HMAC untuk WebApp, atau **deep-link token sekali pakai berumur pendek** untuk linking bot. Jangan pernah percaya `telegram_user_id` mentah dari update.
- **Account linking**: alur eksplisit (login web → generate token 6 digit berumur 5 menit → kirim ke bot → verifikasi → link), plus aturan: satu Telegram ID hanya boleh terhubung ke satu customer; unlink butuh re-autentikasi.
- **Auth admin**: RBAC (`SUPER_ADMIN, OPS, SUPPORT, FINANCE, READONLY`), **2FA wajib**, dan matriks izin per aksi. Contoh yang wajib dibedakan: siapa boleh melihat kredensial inventory, siapa boleh menyetujui refund, siapa boleh mengubah harga.
- **Four-eyes**: refund atau penyesuaian ledger di atas ambang butuh approval admin kedua.

### E3. Detail verifikasi webhook terlalu umum

**Kekurangan.** §39 hanya bilang "verify signature". Kesalahan implementasinya sangat khas dan sangat mudah terjadi.

**Perbaikan.** Tulis eksplisit:
- **Simpan raw body** sebelum JSON parsing — HMAC dihitung atas byte mentah. (`express.json()` merusak ini; ini penyebab nomor satu signature check yang "kadang gagal".)
- Perbandingan signature **constant-time**.
- **Replay window**: tolak timestamp lebih tua dari 5 menit.
- **Verifikasi nilai**: `amount` dan `currency` dari webhook wajib dicocokkan dengan order. Jangan pernah mempercayai jumlah yang dikirim provider.
- **Toleransi urutan**: webhook bisa datang tidak berurutan. Transisi mundur (`PAID` → `PENDING`) harus diabaikan, bukan diterapkan.
- Balas **200 cepat**, proses berat lewat outbox. Simpan raw payload untuk forensik.
- Event tipe tidak dikenal → simpan + 200, jangan error.

### E4. Idempotency hanya untuk provider, tidak untuk client

**Kekurangan.** §40 menyebut webhook/callback/retry, tapi tidak menyebut request dari customer.

**Dampak.** Double-tap tombol bayar di Telegram = dua order, dua pembayaran.

**Perbaikan.** Endpoint mutasi (checkout, submit info, create refund) menerima header `Idempotency-Key`. Tabel `IdempotencyRecord { key, endpoint, request_hash, response_body, status_code, created_at }`. Key sama + payload berbeda → `409`. Key sama + payload sama → kembalikan response tersimpan.

### E5. Retensi data & UU PDP tidak disinggung

**Perbaikan.** Tambahkan: kebijakan retensi (log provider 90 hari, payload delivery ter-enkripsi 1 tahun, audit log 3 tahun), alur penghapusan data customer (anonymisasi, bukan hard delete pada order — karena order dibutuhkan untuk ledger), dan daftar field PII yang dimasking di log.

---

## BAGIAN F — Operasional yang hilang

### F1. Tidak ada backup / disaster recovery — padahal seluruh bisnis di satu file SQLite

**Kekurangan.** Ini kelalaian paling serius secara operasional. Satu VPS, satu file, tanpa strategi backup yang disebutkan.

**Perbaikan.** Wajib di Phase 0, bukan nanti:
- **Litestream** (atau `VACUUM INTO` + upload berkala) untuk replikasi berkelanjutan ke object storage.
- Backup **sebelum setiap migrasi**, otomatis.
- **Uji restore terjadwal** — backup yang tidak pernah di-restore bukan backup.
- Tulis **RPO/RTO** yang ditargetkan (mis. RPO 5 menit, RTO 1 jam).

### F2. Migrasi skema pada SQLite live tidak dibahas

**Kekurangan.** §60 menyebut "identify migration implications" tanpa aturan.

**Perbaikan.** Wajibkan pola **expand → migrate → contract**: tambah kolom nullable → backfill → tulis ganda → baca dari kolom baru → baru hapus kolom lama. Catat batasan SQLite (`ALTER TABLE` terbatas; Prisma melakukan rebuild tabel yang mengunci DB). Migrasi berat dilakukan di jendela pemeliharaan dengan backup terlebih dulu.

### F3. "Dependency boundary harus jelas" tidak ditegakkan apa pun

**Kekurangan.** §52 memberi aturan yang benar, tapi tanpa penegakan mekanis aturan itu akan dilanggar dalam beberapa minggu.

**Perbaikan.** Tegakkan lewat tooling: `eslint-plugin-boundaries` atau `dependency-cruiser` di CI, dengan aturan konkret — mis. `packages/orders` tidak boleh mengimpor apa pun dari `packages/providers/*`, dan tidak ada package domain yang boleh mengimpor `telegraf`/SDK provider. Aturan yang tidak bisa gagal di CI bukan aturan.

### F4. Non-functional requirement tidak ada angkanya

**Kekurangan.** Tidak ada target latensi, timeout, ukuran retry, atau volume.

**Dampak.** Untuk sebuah *prompt*, ini berarti setiap timeout akan dikarang dan berbeda-beda di tiap adapter.

**Perbaikan.** Tabel konstanta tunggal di dokumen: timeout nickname 3 detik, timeout topup 15 detik, timeout status check 10 detik, payment expiry 15 menit, reservation TTL 18 menit, outbox max attempts 8 dengan backoff eksponensial + jitter, retensi outbox selesai 7 hari, target p95 API 500 ms.

Untuk jalur USDT tambahkan: expiry pembayaran crypto (lebih panjang, mis. 30 menit — konfirmasi on-chain butuh waktu), jumlah konfirmasi minimum per chain, toleransi kurang bayar, interval refresh price book, dan umur maksimal FX rate sebelum dianggap basi.

### F5. Duplikasi notifikasi tidak dicegah

**Kekurangan.** Outbox at-least-once + notifikasi = customer bisa menerima "pesanan terkirim" lima kali saat worker retry.

**Perbaikan.** `NotificationLog` dengan unique constraint `(customer_id, event_type, entity_id, channel)`. Kirim hanya jika insert berhasil. Tambahkan juga throttle Telegram (limit ~30 pesan/detik global, 1 pesan/detik per chat) di dispatcher.

### F6. Dead-letter queue dan poison message tidak ada

**Perbaikan.** Setelah `max_attempts`, event pindah ke `status=DEAD` (bukan retry selamanya), buat `AdminTask`, dan tampilkan di admin dengan tombol replay. Tambahkan juga **ordering per aggregate**: event untuk `order_id` yang sama diproses berurutan, supaya `PAID` tidak diproses setelah `DELIVERED`.

---

## BAGIAN G — Domain yang belum ada

| Domain | Kenapa dibutuhkan |
|---|---|
| **Promotions / Voucher** | §12 sudah menyuruh "validate promotion" tapi model-nya tidak pernah didefinisikan. Butuh: kode, tipe (persen/nominal), kuota, batas per customer, syarat minimum, tanggal berlaku, dan **penguncian kuota saat checkout** (rawan race). |
| **Wallet / Store credit** | Jalan keluar termurah untuk refund top-up gagal dan kompensasi. **Turun prioritas** setelah keputusan cart (top-up = satu item, jadi refund penuh lebih sering daripada parsial), tapi tetap dibutuhkan. Butuh ledger sendiri, saldo tidak boleh negatif. |
| **Customer group / Reseller tier** | §31 memakai "Reseller" dalam contoh pricing, tapi entitasnya tidak ada di mana pun. |
| **Provider transaction log** | Tabel eksplisit `ProviderTransaction { provider, ref_id (unik), order_item_id, request, response, status, attempts }`. `ref_id` unik inilah yang membuat idempotency top-up benar-benar bekerja — sekarang hanya disebut sebagai konsep. |
| **Fraud / risk** | Aturan minimal: batas order per customer per jam, deteksi `user_id` game yang sama dipakai banyak akun, blokir customer, penanganan chargeback. |

---

## BAGIAN H — Masalah pada dokumen sebagai *prompt*

### H1. Urutan fase punya dependensi yang terbalik

**Kekurangan.**
- Phase 3 (Fulfillment) butuh outbox + worker, tapi outbox baru di Phase 10.
- Phase 3 butuh Admin Task, tapi Task baru di Phase 9.
- Phase 8 (Ledger) datang setelah order sudah mengalir → data ledger untuk periode sebelumnya harus di-backfill.
- Phase 11 (Correlation ID, audit) paling akhir → sembilan fase sebelumnya di-debug tanpa alat debug.

**Perbaikan.** Susun ulang:

```text
Phase 0   Inspect + backup + config validation + correlation ID + audit skeleton
Phase 1   Money type (BigInt) + Currency + FX, state machine engine, outbox + worker, idempotency
Phase 2   Customer + Auth + account linking
Phase 3   Catalog + Game + Input schema + Provider mapping
Phase 4   Cart + Checkout + Order + Pricing snapshot + Ledger (bersamaan)
Phase 5   Payment + webhook + expiry + late-payment policy + jalur USDT (konfirmasi, toleransi)
Phase 6   Inventory + reservation
Phase 7   Fulfillment engine + Admin task
Phase 8   Nickname (router, fallback, cache, circuit breaker)
Phase 9   Digiflazz + reconciliation + IN_DOUBT
Phase 10  Refund + wallet
Phase 11  Notifications + Ticketing + KB
Phase 12  Observability lanjutan + laporan
```

Prinsipnya: **hal yang sulit di-retrofit didahulukan** (tipe uang, idempotency, outbox, audit, auth). Hal yang mudah ditambahkan belakangan (ticketing, KB, dashboard) ditaruh belakang.

### H2. Acceptance criteria tidak bisa diuji

**Kekurangan.** §57 berisi kalimat seperti "Audit trail tersedia", "Inventory reservation aman". Tidak ada satu pun yang bisa jadi assertion.

**Perbaikan.** Ubah tiap kriteria jadi skenario Given/When/Then dengan angka. Contoh:

> **Given** 1 unit stok tersedia untuk produk X
> **When** 20 request checkout bersamaan masuk
> **Then** tepat 1 order berstatus PAID-able, 19 lainnya menerima `OUT_OF_STOCK`, dan `inventory_items` berjumlah tepat 1 baris berstatus `RESERVED`.

> **Given** webhook `PAID` untuk order Y
> **When** webhook identik dikirim 5 kali dalam 1 detik
> **Then** tepat 1 baris payment `PAID`, 1 event outbox, 1 fulfillment, 1 notifikasi.

### H3. "Do not blindly implement" ditaruh di halaman terakhir

**Perbaikan.** Instruksi terpenting untuk model — inspeksi dulu, jangan langsung tulis kode — ada di §60, setelah 2.800 baris. Pindahkan ke bagian paling atas dokumen. Model memberi bobot lebih besar pada instruksi di awal dan akhir, dan §0 saat ini justru berisi daftar fitur yang mendorong model langsung menulis kode.

### H4. Dokumen terlalu besar untuk satu sesi implementasi

**Kekurangan.** ~2.900 baris untuk satu prompt. Model akan kehilangan detail di tengah, dan tidak mungkin diselesaikan dalam satu sesi.

**Perbaikan.** Pecah jadi:
- `ARCHITECTURE.md` — prinsip, boundary, golden rules (dibaca setiap sesi, ringkas).
- `DOMAIN-<nama>.md` — spesifikasi rinci per domain (dibaca saat mengerjakan domain itu).
- `CONVENTIONS.md` — tipe uang, error envelope, timeout, penamaan, pola transaksi.
- `PHASES.md` — rencana bertahap + definition of done per fase.

Lalu tiap sesi implementasi hanya memuat `ARCHITECTURE.md` + `CONVENTIONS.md` + satu `DOMAIN-*.md`.

### H5. Kontrak API antar-channel tidak pernah ditentukan

**Kekurangan.** Seluruh dokumen bersandar pada "website dan Telegram memakai logic yang sama", tapi tidak menentukan transport (REST? tRPC? panggilan fungsi langsung?), bentuk error, atau versioning.

**Perbaikan.** Tetapkan: satu **error envelope** kanonik (`{ code, message_key, details, correlation_id }`) di mana `code` bersifat stabil dan bisa dipetakan ke pesan berbahasa Indonesia oleh masing-masing channel. Provider error **tidak pernah** bocor ke customer — selalu dipetakan ke kode internal terlebih dulu.

---

## Prioritas perbaikan

**Kerjakan sebelum baris kode berikutnya ditulis** (mahal atau mustahil di-retrofit):

1. Tipe uang `BigInt` + skala per mata uang + serializer terpusat (B1, B1a)
2. `ref_id` unik + `IN_DOUBT` + reconciliation untuk top-up (A3, D1, G)
3. Idempotency untuk client & webhook (E4, E3)
4. Pola concurrency SQLite yang konkret (C1, C2, C3)
5. Backup/Litestream (F1)
6. Auth + account linking Telegram (E2)
7. `OrderItem.status` sebagai source of truth (A2)
8. Enkripsi kredensial inventory (E1)
9. **Cart composition rule** di cart service (lihat bagian Keputusan Desain) — murah untuk ditulis sekarang, mahal untuk dicabut setelah ada order campuran di produksi
10. **Snapshot FX di order + kolom `base_amount` di ledger** (B2a) — tanpa ini, order USDT yang sudah terjadi tidak bisa dilaporkan secara retroaktif

**Berikutnya:** late-payment policy (B3), ledger double-entry (B2), price book USDT (B2b), penanganan bayar-tidak-pas USDT (B2c), sinkronisasi harga & saldo provider (D4), verification binding nickname (D3), ProductProviderMapping (A1).

**Bisa menyusul:** ticketing, knowledge base, SLA, dashboard, provider health, wallet/store credit.

**Ditunda sampai kriteria pembukaan terpenuhi:** mixed cart lintas tipe fulfillment.

---

## Yang sudah benar dan jangan diubah

Supaya perbaikan di atas tidak dipakai untuk merombak hal yang sudah tepat:

- Pemisahan **internal game ID vs provider game code vs SKU** — ini keputusan terbaik di dokumen.
- **Fulfillment di level order item**, bukan order — tetap dipertahankan meski mixed cart ditutup. Yang dibatasi adalah izin komposisi cart, bukan model datanya.
- **Nickname provider terpisah dari transaction provider**.
- **Cancelled ≠ refunded**.
- **Stock count ≠ inventory reservation**.
- Penolakan eksplisit terhadap microservices/Kafka/Kubernetes di fase awal.
- Instruksi inspeksi codebase sebelum menulis model baru (tinggal dipindah ke atas).