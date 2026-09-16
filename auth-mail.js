/**
 * The two pieces of mail the web app itself sends: the login link and the contact form.
 *
 * WHY THIS IS ITS OWN FILE. Both were inline in server.js, which starts listening the
 * moment it is required — so nothing in that file can be called from a test, and neither
 * of these send paths had ever been executed by one. That is not academic. On 2026-09-15
 * `mailguard.sendGuarded(...)` was added to server.js without its `require`; the
 * ReferenceError landed in the catch that exists so a broken mailer cannot take out the
 * login endpoint, and magic-link login sent nothing for a day while still answering "a
 * login link is on its way". The suite stayed green because it runs with SMTP
 * unconfigured and takes the branch above the call.
 *
 * So: everything these need is passed in — the database, the mailer, the addresses. A
 * test hands them a mailer that records instead of sending and asserts that a message
 * with the link in it actually arrived there.
 *
 * Every send goes through mailguard, like every other send in the app.
 */
const mailguard = require('./mailguard');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** The link is the whole message; if it is not in here, nothing else matters. */
function magicLinkMessage({ from, to, link }) {
  return {
    from,
    to,
    subject: 'Your Portfolio Tracker login link',
    html: `<p>Click below to sign in. This link works once and expires in 15 minutes.</p>
             <p><a href="${escapeHtml(link)}">Sign in to Portfolio Tracker</a></p>
             <p style="color:#666;font-size:12px">If you didn't request this, you can ignore this email.</p>`
  };
}

function contactMessage({ from, to, replyTo, type, title, name, email, message }) {
  return {
    from,
    to,
    replyTo,
    subject: `[Portfolio Tracker] ${type}: ${title}`.replace(/[\r\n]+/g, ' ').slice(0, 200),
    html: `<p><strong>From:</strong> ${escapeHtml(name)} (${escapeHtml(email)})</p>
               <p><strong>Type:</strong> ${escapeHtml(type)}</p>
               <p><strong>Message:</strong></p>
               <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`
  };
}

/**
 * Send the login link, and never throw.
 *
 * A mailer that fails must not become "you cannot sign in at all": the link is written to
 * the log instead, which is where the account owner can still reach it. `onUnsent` is how
 * the caller is told that happened — and how a test sees it without reading stdout.
 */
async function sendMagicLink({ db, mailer, from, email, link, onUnsent = () => {}, log = () => {} }) {
  if (!mailer) {
    onUnsent('SMTP not configured');
    return { sent: false, reason: 'no mailer' };
  }
  try {
    const verdict = await mailguard.sendGuarded(db, mailer, 'login', magicLinkMessage({ from, to: email, link }), log);
    if (!verdict.sent) onUnsent(verdict.reason || 'not sent');
    return verdict;
  } catch (err) {
    onUnsent(`email send failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

/**
 * Send a contact message, and **do** throw if it fails.
 *
 * The opposite of the rule above, deliberately: this used to be swallowed and answered
 * with success, so the sender was thanked for a message that never arrived. The caller
 * needs the failure so it can say so.
 */
async function sendContact({ db, mailer, log = () => {}, ...fields }) {
  const verdict = await mailguard.sendGuarded(db, mailer, 'contact', contactMessage(fields), log);
  // A message stopped by the daily budget did not arrive either. Returning quietly here
  // would have the endpoint thank the sender for it, which is the exact failure the
  // caller's comment is about.
  if (!verdict.sent) throw new Error(verdict.reason || 'not sent');
  return verdict;
}

module.exports = { sendMagicLink, sendContact, magicLinkMessage, contactMessage, escapeHtml };
