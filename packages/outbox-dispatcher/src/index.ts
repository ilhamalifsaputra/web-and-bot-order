/**
 * Public API of the outbox dispatcher: the polling loop that drains
 * `notification_outbox` and delivers each row to Telegram (channel post / DM).
 * Consumed in-process by the composition root (`apps/server`).
 */
export { runDispatcher } from "./dispatcher";
