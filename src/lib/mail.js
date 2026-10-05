// Email through the Cloudflare Email Sending binding (env.EMAIL).

export const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Never throws. Returns true when the message was handed to the mail service.
export async function sendMail(env, to, subject, text, link) {
  if (!to) return false;
  const safe = escapeHtml(text).replace(/\n/g, "<br>");
  const button = link
    ? `<p><a href="${link}" style="background:#3ddc7a;color:#000;padding:12px 22px;text-decoration:none;font-weight:bold">Open link</a></p>`
    : "";
  try {
    await env.EMAIL.send({
      to,
      from: env.FROM_EMAIL,
      subject,
      text: link ? `${text}\n\n${link}` : text,
      html:
        `<div style="font-family:Courier New,monospace;background:#000;color:#eee;padding:24px">` +
        `<h2 style="color:#b983e8;margin:0 0 12px">&#9827; Clubs Deuce Mugger</h2><p>${safe}</p>${button}</div>`,
    });
    return true;
  } catch (err) {
    console.error("email failed", err && err.message);
    return false;
  }
}
