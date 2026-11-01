/**
 * The app's last line of defence against a white page (H6, UI-states audit).
 *
 * Without a boundary, any throw during render — a stale lazy chunk after a
 * deploy, a response with an unexpected shape — unmounted React's root and
 * left the buyer on a blank white page, shop chrome included. Two of these sit
 * in the tree: one around the whole app (main.tsx), and one around the routed
 * page inside Layout (PageTransition), so a failing page keeps the header, nav
 * and footer around it.
 *
 * A stale chunk gets one automatic reload (lib/chunkReload.ts guards against a
 * loop); anything else, or a second stale chunk inside the guard window, shows
 * a friendly message with a Reload button. `resetKey` (the route path) clears
 * the error when the buyer navigates elsewhere.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, reloadOnceForStaleChunk } from "../lib/chunkReload";
import { t } from "../lib/i18n";
import Button from "./ui/Button";
import Card from "./ui/Card";

interface Props {
  children: ReactNode;
  /** Changing it clears a caught error (the route path for the per-route boundary). */
  resetKey?: string;
}

interface State {
  error: unknown;
  reloading: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isChunkLoadError(error) && reloadOnceForStaleChunk()) {
      this.setState({ reloading: true });
      return;
    }
    console.error("A storefront page failed to render and was replaced by the error message.", error, info.componentStack);
  }

  override componentDidUpdate(prevProps: Props): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null, reloading: false });
    }
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    if (this.state.reloading) return null;
    return (
      <div role="alert" className="mx-auto max-w-md px-4 py-10">
        <Card className="text-center">
          <h1 className="section-title mb-2">{t("web.state_error_title")}</h1>
          <p className="mb-4 text-sm text-ink-soft">{t("shop.app_error_body")}</p>
          <Button type="button" onClick={() => window.location.reload()}>
            {t("web.state_reload")}
          </Button>
        </Card>
      </div>
    );
  }
}
