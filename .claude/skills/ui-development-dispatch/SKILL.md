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
