/**
 * Stand-in for pages not yet migrated (clusters land in
 * docs/REACT_STOREFRONT_MIGRATION.md order). Unreachable in production until a
 * page's Nunjucks route is deleted — the server serves the old HTML until
 * then — so this renders nothing rather than a half-styled screen.
 */
export default function Placeholder() {
  return null;
}
