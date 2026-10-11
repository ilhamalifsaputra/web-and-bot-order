import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = new QueryClient();

// A tab left open across a deploy still references the old hashed chunks,
// which the new build deleted — reload once so it picks up the current
// index.html and chunk manifest instead of sticking on a failed lazy page.
window.addEventListener("vite:preloadError", () => {
  window.location.reload();
});

createRoot(root).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <App />
            </TooltipProvider>
          </QueryClientProvider>
        </BrowserRouter>
      </MotionConfig>
    </LazyMotion>
  </StrictMode>,
);
