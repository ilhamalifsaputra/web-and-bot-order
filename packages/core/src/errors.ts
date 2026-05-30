/**
 * Error with an i18n key — replacement for Python ValidationError carrying a
 * locale key. `humanize()` (in web/bot) resolves key+args to a message.
 */
export class AppError extends Error {
  constructor(
    public readonly key: string,
    public readonly formatArgs: Record<string, unknown> = {},
  ) {
    super(key);
    this.name = "AppError";
  }
}

/** Raised when input fails validation; same shape, distinct name for clarity. */
export class ValidationError extends AppError {
  constructor(key: string, formatArgs: Record<string, unknown> = {}) {
    super(key, formatArgs);
    this.name = "ValidationError";
  }
}
