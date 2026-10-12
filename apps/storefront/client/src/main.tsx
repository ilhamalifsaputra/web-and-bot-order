import { consumeTelegramFragment } from "./lib/telegramCallback";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import ErrorPage from "./pages/ErrorPage";
import SetupPendingPage from "./pages/SetupPendingPage";

void consumeTelegramFragment(window.location, {
  replace: path => window.history.replaceState(null, "", path),
  post: async (url, body) => {
    const response = await fetch(url, {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
    if (!response.ok) throw new Error("Telegram sign in failed");
    return response.json() as Promise<{redirect:string}>;
  },
  navigate: path => window.location.replace(path),
}).then(callbackHandled => { if (!callbackHandled) mountStorefront(); });
function mountStorefront() {
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
    <LazyMotion features={domAnimation}>
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
    </LazyMotion>
  </StrictMode>,
);

// Retire the crawler-visible fallback the server rendered (see seoShell() in
// apps/storefront/src/routes/spaShell.ts). It is a sibling of #root, so React
// never touches it — without this it would sit above the app as duplicated
// text. Left in place until now so a slow connection still shows the page's
// heading and links while the bundle loads.
document.getElementById("seo-shell")?.remove();

}
