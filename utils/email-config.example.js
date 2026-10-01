/**
 * email-config.example.js — template for utils/email-config.js
 *
 * The real file is gitignored (keys stay out of the public repo) but the
 * extension imports it, so copy this file to email-config.js before loading
 * the extension, then fill in the values.
 *
 * EmailJS account used to send every user's email alerts.
 *
 * Users only enter their own address in Settings; the extension sends through
 * this shared account. Get the values from emailjs.com:
 *   serviceId  — Email Services → your Gmail service
 *   templateId — Email Templates → template with To Email = {{to_email}},
 *                Subject = {{subject}}, and {{item_name}}, {{message}}, {{item_url}}
 *   publicKey  — Account → General → Public Key
 *
 * These ship inside the extension, so anyone can read them. Keep EmailJS
 * rate limits on, and move sending to a backend before a wide release.
 */

export const EMAILJS = {
  serviceId:  '',
  templateId: '',
  publicKey:  '',
};

// The Gmail account connected to the EmailJS service above — alerts arrive
// from this address. Shown in Settings so users can add it to their contacts
// (new senders tend to land in spam). Update it if the service changes.
export const SENDER_ADDRESS = '';

export function isEmailConfigured() {
  return !!(EMAILJS.serviceId && EMAILJS.templateId && EMAILJS.publicKey);
}
