/**
 * TSX port of the old apps/storefront/views/setup_pending.njk — shown while
 * the shop owner hasn't finished the setup wizard yet (server-side gate:
 * plugins/setupGate.ts). Mounted directly by main.tsx before the router (no
 * header/cart, no data fetching — the shop isn't configured yet), driven by
 * the `setup-pending` <meta> tag lib/spaFallback.ts injects into the shell.
 */
import { motion } from "framer-motion";
import { t } from "../lib/i18n";
import { fadeUp } from "../lib/motion";

export default function SetupPendingPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-sand text-ink">
      <motion.main
        variants={fadeUp}
        initial="initial"
        animate="animate"
        className="max-w-md text-center px-6"
      >
        <div className="wait-dot" aria-hidden="true" />
        <h1 className="font-display text-2xl font-semibold mb-3">{t("web.setup_pending_title")}</h1>
        <p className="text-ink-soft">{t("web.setup_pending_message")}</p>
      </motion.main>
    </div>
  );
}
