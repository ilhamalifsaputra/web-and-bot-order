import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Retire the crawler-visible fallback the server rendered (see seoShell() in
// apps/storefront/src/routes/spaShell.ts). It is a sibling of #root, so React
// never touches it — without this it would sit above the app as duplicated
// text. Left in place until now so a slow connection still shows the page's
// heading and links while the bundle loads.
document.getElementById("seo-shell")?.remove();
