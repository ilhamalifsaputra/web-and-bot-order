import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import App from "./App";
import ErrorPage from "./pages/ErrorPage";
import SetupPendingPage from "./pages/SetupPendingPage";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = new QueryClient();

/**
 * Full-page states the server injects a <meta> tag for (see
 * apps/storefront/src/lib/spaFallback.ts) that must override normal routing —
 * the first-run setup gate and Fastify's own error handler both serve the SPA
 * shell now, so the page these render is decided here rather than by path.
 */
function specialServerState(): { kind: "setup-pending" } | { kind: "server-error"; status: number } | null {
  if (document.querySelector('meta[name="setup-pending"]')?.getAttribute("content") === "true") {
    return { kind: "setup-pending" };
  }
  const errorStatus = document.querySelector('meta[name="server-error-status"]')?.getAttribute("content");
  if (errorStatus) return { kind: "server-error", status: Number(errorStatus) };
  return null;
}

const special = specialServerState();

createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      {special?.kind === "setup-pending" ? (
        <SetupPendingPage />
      ) : special?.kind === "server-error" ? (
        // ErrorPage's "back home" link needs a Router context even standalone.
        <BrowserRouter>
          <ErrorPage statusCode={special.status} />
        </BrowserRouter>
      ) : (
        <BrowserRouter>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </BrowserRouter>
      )}
    </MotionConfig>
  </StrictMode>,
);

// Retire the crawler-visible fallback the server rendered (see seoShell() in
// apps/storefront/src/routes/spaShell.ts). It is a sibling of #root, so React
// never touches it — without this it would sit above the app as duplicated
// text. Left in place until now so a slow connection still shows the page's
// heading and links while the bundle loads.
document.getElementById("seo-shell")?.remove();
