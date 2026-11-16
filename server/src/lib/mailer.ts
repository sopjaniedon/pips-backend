// Outgoing email. Outside production every message goes to the local capture server (Mailpit); see config.ts.
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config.js";

export interface Mail { to: string | string[]; subject: string; html: string; replyTo?: string }

export function createMailer(config: Config) {
  let transport: Transporter | null = null;
  const get = () => (transport ??= nodemailer.createTransport({
    host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465,
    // Mailpit locally needs no TLS; production SMTP settings come with the go-live configuration.
    ignoreTLS: config.MAIL_MODE === "capture",
  }));
  return {
    async send(m: Mail) {
      const text = m.html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      await get().sendMail({ from: config.MAIL_FROM, to: m.to, subject: m.subject, html: m.html, text, replyTo: m.replyTo });
    },
  };
}
export type Mailer = ReturnType<typeof createMailer>;
