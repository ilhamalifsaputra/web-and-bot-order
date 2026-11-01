import { QueryClient } from "@tanstack/react-query";
import { shouldRetryQuery } from "./sessionExpiry";

/** The one QueryClient the admin SPA runs on (and tests can build). */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery } } });
}
