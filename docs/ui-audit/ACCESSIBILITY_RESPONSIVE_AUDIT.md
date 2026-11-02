# Accessibility and responsive audit (spec section 8)

Evidence is code reading and jsdom tests (roles, names, `aria-*`). No screen
reader, keyboard walk-through, contrast tool or viewport run was done on this
branch, so those items are **Not Tested**.

| Check | Result | Evidence |
|---|---|---|
| States reachable by keyboard | Not Tested | Native buttons/links used for every Retry, Log in, Reload, Try again |
| Visible focus indicator | Present in CSS | `:focus-visible` outline in both `index.css` |
| Field errors linked to inputs | Partly; storefront `FormField` wires `aria-describedby`; admin varies | not re-audited |
| Status announced via live regions | Yes for the states touched: `role="alert"` for failures and session end, `role="status"` for refresh failures and loading regions (`aria-busy`, `aria-labelledby`) | stateVisuals, loading-primitives, page tests |
| Loading keeps screen-reader context | Loading regions named by one sr-only label; pending buttons keep their label | LD-01 tests |
| Dialog focus management | Radix dialogs (admin), `useDialogA11y` (storefront); not re-audited | — |
| Colour not the only cue | Fixed for error vs warning (VIS-01, VIS-05); upload rows now have words + icons | stateVisuals tests |
| Text/control contrast | Not Tested on this branch; `ink-faint` was darkened earlier to about 5.1:1 (admin `index.css` comment) | — |
| No horizontal overflow on small viewports | Not Tested | Earlier ticketing screenshots in `docs/` cover 320 px for tickets only |
| Touch targets | Admin enforces 44 px on coarse pointers (`index.css`) | — |
| Viewports 360/390/768/1024/1440 | Not Tested | — |
| Reduced motion | Yes: `motion-safe:` utilities, global reduced-motion CSS, `MotionConfig reducedMotion="user"` | Spinner/Skeleton tests in both apps |
