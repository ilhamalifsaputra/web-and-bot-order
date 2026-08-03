---
name: ui-development-dispatch
description: Use when working on any frontend, admin panel, storefront, dashboard, or React component, before writing UI code
---

# UI Development Dispatch

## Overview

This project has a full authoritative UI design system under `docs/ui/`. This skill's only job is to be the active trigger that pulls you into that system before you write UI code — the documents themselves are the source of truth, not this file.

## When to Use

Any task touching `apps/web-admin/client`, `apps/storefront/client`, or any React component, layout, table, form, settings page, or dashboard widget.

## What to do

Read `docs/ui/00_AI_RULES.md` first — it is the entry point and decision tree for which of `01`–`10` governs your specific task (design system, admin layout, component library, CRUD template, table guidelines, settings guidelines, dashboard guidelines, UX rules, code style, and the pre-merge review checklist).

## The one rule worth repeating here

Never create new layouts, spacing systems, component variants, or interaction patterns unless the design system itself is being updated. Consistency always takes precedence over creativity.

## UI Implementation Priority

When implementing any frontend UI, respect this precedence, in order:

1. Existing shared component
2. Component Library
3. Design System
4. UI Guidelines
5. CRUD Template
6. Existing page patterns
7. Create a new component (only if none of the above applies)

Never skip this order. If an existing component can satisfy the requirement with small modifications, reuse it instead of creating a new implementation.

## Functional-First Admin UX

Admin pages are operational tools, not marketing pages. Every new UI element must answer at least one of these questions:

- Does it reduce the number of clicks?
- Does it improve scanning speed?
- Does it help admins make decisions faster?
- Does it reduce operational mistakes?

If the answer is "no", do not add the element. Prefer information density over decorative UI while preserving readability — consistency with the Design System outranks visual novelty.

## Progressive Disclosure

Admin interfaces should expose only the information required for the current task. Do not add filters, KPI cards, statistics, actions, or widgets simply because there is available space.

Additional information should only appear when it improves decision making, reduces clicks, reduces operational errors, or is frequently used by administrators. Empty space is preferable to unnecessary UI — prefer progressive disclosure (menus, drawers, dialogs, expandable sections) over permanently visible controls. The admin should feel calm, focused, and efficient, not crowded.
