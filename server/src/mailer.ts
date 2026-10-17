import nodemailer from 'nodemailer';

// L'envoi d'e-mails est actif seulement si SMTP_URL est défini (ex. smtps://user:pass@smtp.exemple.com).
const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
export const mailEnabled = !!transport;
const FROM = process.env.MAIL_FROM || 'LinkLink <no-reply@linklink.local>';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export function sendMail(to: string, subject: string, text: string, link?: string) {
  if (!transport) return;
  const url = link && APP_URL ? `${APP_URL}/${link.startsWith('#') ? link : `#${link}`}` : '';
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#081B4B;max-width:520px">
    <h2 style="margin:0 0 8px;color:#135FEA">LinkLink</h2><p style="white-space:pre-line">${esc(text)}</p>
    ${url ? `<p><a href="${esc(url)}" style="background:#135FEA;color:#fff;padding:10px 16px;border-radius:12px;text-decoration:none">Ouvrir dans LinkLink</a></p>` : ''}
    <p style="color:#526079;font-size:12px">Vous recevez cet e-mail car les notifications sont activées dans votre profil.</p></div>`;
  transport.sendMail({ from: FROM, to, subject, text: url ? `${text}\n\n${url}` : text, html }).catch((e) => {
    console.error('E-mail non envoyé :', e.message);
  });
}
