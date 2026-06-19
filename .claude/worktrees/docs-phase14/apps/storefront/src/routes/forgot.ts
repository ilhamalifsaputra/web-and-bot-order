import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { config, isSmtpEnabled } from "@app/core/config";
import { t } from "@app/core/i18n";
import { logger } from "@app/core/logger";
import { sendMail } from "@app/core/mailer";
import { hashPassword } from "@app/core/password";
import {
  prisma,
  setSetting,
  createPasswordResetToken,
  consumePasswordResetToken,
  setLoginCredentials,
} from "@app/db";
import { newJti, shopSessionJtiKey } from "../auth";
import { shopContext } from "../shop";

function publicBase(req: FastifyRequest): string {
  const fromConfig = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL;
  if (fromConfig) return fromConfig.replace(/\/+$/, "");
  return `${req.protocol}://${req.headers.host ?? "localhost"}`;
}

const forgotRoutes: FastifyPluginAsync = async (app) => {
  app.get("/forgot", async (req, reply) => {
    const ctx = await shopContext(req, "/login");
    return reply.view("forgot.njk", { ...ctx, sent: false, unavailable: !isSmtpEnabled() });
  });

  app.post<{ Body: { email?: string } }>("/forgot", async (req, reply) => {
    const ctx = await shopContext(req, "/login");
    if (!isSmtpEnabled()) {
      return reply.view("forgot.njk", { ...ctx, sent: false, unavailable: true });
    }
    const email = (req.body.email ?? "").trim().toLowerCase();
    if (email) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (user && !user.banned) {
        const { token } = await createPasswordResetToken(prisma, user.id);
        const link = `${publicBase(req)}/reset/${token}`;
        try {
          await sendMail({
            to: email,
            subject: `${ctx.shop_name} — reset password`,
            text:
              `Click to set a new password (valid 1 hour):\n${link}\n\n` +
              `If you didn't request this, ignore this email — your password is unchanged.\n\n` +
              `Klik untuk membuat kata sandi baru (berlaku 1 jam):\n${link}\n\n` +
              `Abaikan email ini jika kamu tidak memintanya — kata sandimu tidak berubah.`,
          });
        } catch (e) {
          logger.error({ err: e }, "Failed to send password reset mail");
        }
      }
    }
    return reply.view("forgot.njk", { ...ctx, sent: true, unavailable: false });
  });

  app.get<{ Params: { token: string } }>("/reset/:token", async (req, reply) => {
    const ctx = await shopContext(req, "/login");
    return reply.view("reset.njk", { ...ctx, token: req.params.token, error: null });
  });

  app.post<{ Params: { token: string }; Body: { password?: string; password2?: string } }>(
    "/reset/:token",
    async (req, reply) => {
      const ctx = await shopContext(req, "/login");
      const password = req.body.password ?? "";
      const back = (error: string) =>
        reply.code(400).view("reset.njk", { ...ctx, token: req.params.token, error });

      if (password.length < 8) return back(t("web.register_password_short", ctx.lang));
      if (password !== (req.body.password2 ?? "")) return back(t("web.register_password_mismatch", ctx.lang));

      const user = await consumePasswordResetToken(prisma, req.params.token);
      if (!user) return back(t("web.reset_invalid", ctx.lang));

      await setLoginCredentials(prisma, user.id, { passwordHash: hashPassword(password) });
      await setSetting(prisma, shopSessionJtiKey(user.id), newJti());
      return reply.code(303).redirect("/login?reset=1");
    },
  );
};

export default forgotRoutes;
