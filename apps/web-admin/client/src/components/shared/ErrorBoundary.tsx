import * as React from "react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled render error", error, info);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <p className="font-semibold text-ink">Something went wrong.</p>
          <p className="text-sm text-ink-soft">This page hit an unexpected error and couldn't be displayed.</p>
          <Button variant="default" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
