#!/usr/bin/env node
/**
 * Email one encrypted backup file, as an attachment, to CONTACT_EMAIL_TO.
 *
 * Called by backup-offsite.sh. Separate from it because the SMTP settings and the mailer
 * already live in Node, and shelling out to sendmail would mean a second way of sending
 * mail in a project that already has one.
 *
 *   node send-backup.js /path/to/data.db.<stamp>.gz.gpg
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('send-backup: no such file:', file);
  process.exit(1);
}

const to = process.env.CONTACT_EMAIL_TO || process.env.OPS_EMAIL_TO || process.env.ALERT_EMAIL_TO;
if (!process.env.SMTP_HOST || !to) {
  console.error('send-backup: SMTP_HOST or a recipient is not configured');
  process.exit(1);
}

const port = parseInt(process.env.SMTP_PORT || '587', 10);
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: port === 465,
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    : undefined
});

const name = path.basename(file);
const size = (fs.statSync(file).size / 1024).toFixed(0);
const stamp = name.replace(/^data\.db\./, '').replace(/\.gz\.gpg$/, '');

transport.sendMail({
  from: process.env.ALERT_EMAIL_FROM || process.env.AUTH_EMAIL_FROM,
  to,
  subject: `Portfolio Tracker backup — ${stamp}`,
  text: [
    `An encrypted copy of the Portfolio Tracker database, taken ${stamp}.`,
    '',
    `File: ${name} (${size} KB)`,
    '',
    'This attachment is useless without the backup passphrase, which is deliberately',
    'not in this message. To restore:',
    '',
    `  gpg -d ${name} > data.db.gz`,
    '  gunzip data.db.gz',
    '',
    'Keep the most recent one. Older copies are also in the private backup repository.'
  ].join('\n'),
  attachments: [{ filename: name, path: file }]
})
  .then(() => { console.log(`  emailed ${name} (${size} KB) to ${to}`); process.exit(0); })
  .catch(err => { console.error('send-backup: send failed:', err.message); process.exit(1); });
