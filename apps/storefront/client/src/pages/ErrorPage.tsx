/**
 * The SPA shell serves a real HTTP status (404 for an unmatched route, 500 for
 * a server fault) and renders this component for the body — a static bundle
 * can't ship a Nunjucks template per status. Task 12 moves it onto the design
 * system's §16 state components: a 404 is `NotFoundState`, a 5xx is
 * `ErrorState` (centered icon-in-a-well + title + description + a primary
 * action). The status number is never the headline (§16 "no raw status codes
 * in the UI") — it stays only as a small, muted caption for support
 * conversations. The `statusCode` / `message` prop API the shell passes is
 * unchanged, as is the `fadeUp` entrance.
 */
import { motion } from "framer-motion";
import { t } from "../lib/i18n";
import { fadeUp } from "../lib/motion";
import ErrorState from "../components/shop/ErrorState";
import NotFoundState from "../components/shop/NotFoundState";

export interface ErrorPageProps {
  statusCode?: number;
  message?: string;
}

export default function ErrorPage({ statusCode = 404, message }: ErrorPageProps) {
  const isServerError = statusCode >= 500;
  const description = message ?? (isServerError ? t("web.error_message") : t("web.not_found"));

  return (
    <motion.div variants={fadeUp} initial="initial" animate="animate">
      {isServerError ? (
        <ErrorState description={description} />
      ) : (
        <NotFoundState
          description={description}
          action={{ label: t("web.back_home"), to: "/" }}
        />
      )}
      {/* Not the headline — a quiet caption. `aria-hidden`: the state component
          above already carries the human-readable message a screen reader
          needs. */}
      <p aria-hidden="true" className="mt-4 text-center text-xs font-medium text-ink-faint">
        {statusCode}
      </p>
    </motion.div>
  );
}
