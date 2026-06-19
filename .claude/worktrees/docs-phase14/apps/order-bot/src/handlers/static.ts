/**
 * Static informational pages: /faq, /terms, /howtopay — port of static_pages.py.
 * Content lives in the locale tables so admins can edit copy without code.
 */
import type { MyContext } from "../context";
import { smartEdit } from "../util/chat";
import { t } from "../util/i18n";
import { backToMain } from "../keyboards/customer";

async function sendStatic(ctx: MyContext, key: string): Promise<void> {
  const lang = ctx.session.lang;
  await smartEdit(ctx, t(ctx, key), backToMain(lang));
}

export const showFaq = (ctx: MyContext) => sendStatic(ctx, "faq.content");
export const showTerms = (ctx: MyContext) => sendStatic(ctx, "terms.content");
export const showHowtopay = (ctx: MyContext) => sendStatic(ctx, "howtopay.content");

// Command handlers (registered in main.ts behind rate-limit + registeredUser).
export const faqCommand = showFaq;
export const termsCommand = showTerms;
export const howtopayCommand = showHowtopay;
