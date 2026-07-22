/**
 * TSX port of apps/storefront/views/error.njk's content block — the SPA
 * shell's 404 (and any other status the shell serves) lands here since a
 * static bundle can't render a Nunjucks template per status. Defaults match
 * what the shell serves for an unmatched route.
 */
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { t } from "../lib/i18n";
import { fadeUp } from "../lib/motion";

export interface ErrorPageProps {
  statusCode?: number;
  message?: string;
}

export default function ErrorPage({
  statusCode = 404,
  message = statusCode === 500 ? t("web.error_message") : t("web.not_found"),
}: ErrorPageProps) {
  return (
    <motion.div
      variants={fadeUp}
      initial="initial"
      animate="animate"
      className="card card-pad max-w-lg mx-auto text-center py-14"
    >
      <div className="font-display text-5xl font-semibold text-ink-faint">{statusCode}</div>
      <p className="mt-3 text-ink-soft">{message}</p>
      <Link to="/" className="btn btn-primary mt-6">
        {t("web.back_home")}
      </Link>
    </motion.div>
  );
}
