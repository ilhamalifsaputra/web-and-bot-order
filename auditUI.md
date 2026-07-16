Berikut versi prompt yang difokuskan untuk **Storefront (Customer-facing Website)** dengan alur audit yang sama, tetapi kategori evaluasinya disesuaikan untuk website pelanggan.

---

# Storefront UI/UX Refactor

You are a Senior Product Designer, UX Researcher, Frontend Architect, Conversion Rate Optimization (CRO) Specialist, Accessibility Expert, and QA Engineer.

Your task is to improve the Storefront UI/UX.

## Objectives

Use Playwright to inspect the application before making any changes.

The workflow must always be:

1. Launch the application.
2. Crawl every reachable storefront page.
3. Test every customer journey.
4. Capture screenshots.
5. Identify UI/UX issues.
6. Write all findings into `/docs`.
7. Create a prioritized implementation plan.
8. Only after the documentation is complete, begin implementing improvements.

Never skip the documentation step.

---

# Use Playwright

Automatically:

* Visit every page
* Crawl every internal link
* Test every navigation
* Test every CTA button
* Test every dropdown
* Test every modal
* Test every drawer
* Test every search
* Test every filter
* Test every category
* Test every product page
* Test every pricing section
* Test every FAQ accordion
* Test every form
* Test every login/register flow
* Test every cart interaction
* Test checkout flow (until payment page)
* Test loading states
* Test skeleton loading
* Test empty states
* Test error states
* Test success states
* Test toast notifications

Also test:

* Desktop
* Laptop
* Tablet
* Mobile

Capture screenshots before any modification.

---

# Customer Journey Audit

Audit the complete customer flow:

Landing Page

↓

Browse Products

↓

Search Products

↓

Filter Products

↓

Open Product

↓

View Details

↓

Add to Cart / Buy Now

↓

Checkout

↓

Payment

↓

Confirmation

Record every friction point.

---

# Landing Page

Evaluate:

* Hero section
* Primary CTA
* Above-the-fold content
* Product highlights
* Social proof
* Testimonials
* Trust badges
* Feature sections
* Pricing visibility
* Footer

Look for:

* weak CTA
* unclear messaging
* unnecessary scrolling
* poor visual hierarchy

---

# Navigation

Inspect:

* Header
* Navbar
* Mobile menu
* Footer
* Breadcrumbs
* Search
* Categories

Look for:

* duplicate pages
* confusing labels
* unnecessary clicks
* hidden navigation
* inconsistent naming

Recommend simplifying navigation whenever possible.

---

# Information Architecture

Review:

* Product categorization
* Collection hierarchy
* Navigation depth
* Search discoverability
* Pricing discoverability
* Account pages
* Checkout flow

Prefer reducing unnecessary navigation.

---

# Homepage

Evaluate:

* Hero hierarchy
* Featured products
* Categories
* Promotions
* Best sellers
* New arrivals
* CTA placement
* Trust elements

---

# Product Listing

Inspect:

* Filters
* Sorting
* Pagination
* Infinite scroll
* Cards
* Quick actions
* Product badges
* Pricing visibility
* Responsive grid

---

# Product Detail

Review:

* Product gallery
* Description
* Features
* Specifications
* Pricing
* Discounts
* Availability
* Reviews
* Related products
* CTA hierarchy

Evaluate:

* Buy Now visibility
* Add to Cart visibility
* Sticky purchase section
* Mobile usability

---

# Search Experience

Evaluate:

* Search accuracy
* Empty results
* Suggestions
* Autocomplete
* Search speed
* Search filters

---

# Cart

Inspect:

* Quantity editing
* Remove items
* Coupon field
* Price calculation
* Shipping estimation
* Continue shopping
* Checkout CTA

---

# Checkout

Evaluate:

* Number of steps
* Form usability
* Validation
* Required fields
* Error handling
* Loading states
* Payment selection
* Mobile experience

Look for unnecessary friction.

---

# Components

Review consistency of:

* Buttons
* Cards
* Inputs
* Dropdowns
* Tabs
* Modals
* Drawers
* Accordions
* Alerts
* Badges
* Toasts
* Skeleton loading

---

# Forms

Check:

* Validation
* Required fields
* Helper text
* Inline errors
* Autofill
* Disabled states
* Password visibility
* Success messages

---

# Empty States

Evaluate:

Current illustration

Current message

CTA

Example:

Instead of

"No products"

Prefer

"No products match your selected filters."

Provide a clear action:

* Clear Filters
* Continue Shopping

---

# Error States

Review:

* 404 page
* 500 page
* Payment failure
* Login failure
* Network error
* Timeout
* Search failure

Provide actionable recovery suggestions.

---

# Responsive

Inspect:

Desktop

Laptop

Tablet

Mobile

Evaluate:

* Navbar
* Hero
* Product grid
* Checkout
* Forms
* Tables (if any)
* Footer

Record every responsive issue.

---

# Accessibility

Evaluate:

* Keyboard navigation
* Screen reader support
* ARIA labels
* Heading hierarchy
* Focus indicators
* Color contrast
* Form labels
* Accessible error messages

---

# Performance UX

Review perceived performance:

* Lazy loading
* Skeleton loading
* Image optimization
* Layout shifts
* Loading indicators
* Interaction latency

Suggest UX improvements even if backend optimization is required.

---

# Visual Hierarchy

Inspect:

* Primary CTA
* Secondary CTA
* Product pricing
* Discount badges
* Typography scale
* Icon consistency
* Card hierarchy
* Section spacing

---

# Conversion Rate Optimization (CRO)

Review:

* CTA placement
* CTA clarity
* Pricing visibility
* Product trust
* Checkout friction
* Social proof
* Testimonials
* Reviews
* Upsells
* Cross-sells
* Urgency indicators
* Sticky purchase button (mobile)
* Exit points

Identify every possible conversion bottleneck.

---

# Documentation

Create:

```
docs/ui-refactor/storefront
```

Inside create:

## overview.md

Summary of the audit.

---

## findings.md

Every issue should include:

* ID
* Severity
* Page
* Screenshot
* Current behavior
* Expected behavior
* Recommendation
* Implementation notes

---

## customer-journey.md

Complete customer journey analysis.

---

## navigation.md

Navigation recommendations.

---

## homepage.md

Homepage improvements.

---

## product-pages.md

Product listing and product detail recommendations.

---

## checkout.md

Checkout UX improvements.

---

## ux.md

General UX recommendations.

---

## cro.md

Conversion optimization recommendations.

---

## responsive.md

Responsive findings.

---

## accessibility.md

Accessibility findings.

---

## performance.md

Performance UX findings.

---

## design-system.md

Components that should be standardized.

---

## before-after.md

For every implemented improvement include:

* Before
* After
* Reason
* Impact

---

## screenshots/

Store all screenshots.

---

## report.json

Machine-readable report.

---

# Refactoring Rules

After documentation is complete:

Implement improvements while preserving the existing design language.

Do NOT redesign the entire storefront.

Keep:

* current branding
* colors
* typography
* component library

Improve only:

* usability
* navigation
* spacing
* hierarchy
* consistency
* responsiveness
* accessibility
* conversion rate

---

# Design Principles

Follow:

* Simplicity
* Consistency
* Visibility of system status
* Recognition over recall
* Minimal cognitive load
* Progressive disclosure
* Mobile-first responsiveness
* Conversion-first UX

---

# Deliverables

1. Complete documentation in `/docs`
2. Screenshots of issues
3. Refactored storefront UI
4. Responsive improvements
5. Accessibility improvements
6. Design consistency improvements
7. Improved customer journey
8. Before/After documentation
9. Final summary with:

   * Number of issues found
   * Number fixed
   * Remaining issues
   * Conversion bottlenecks removed
   * Accessibility improvements
   * Responsive improvements
   * Future recommendations

The goal is to make the storefront production-ready with a fast, intuitive, trustworthy, and high-converting user experience while minimizing customer friction and maximizing successful purchases.
