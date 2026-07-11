export const WAITLIST_ENDPOINT = ""; // TODO: Google Form URL (viewform or formResponse) or Formspree-style JSON endpoint. Empty: dev = log + fake success; PRODUCTION = mailto fallback (§12)

// When WAITLIST_ENDPOINT is a Google Form, map our fields to its entry ids.
// NOTE the accepted tradeoff: browsers cannot read Google's response (no CORS),
// so a completed send is shown as success even if Google rejected it — test
// periodically with `npm run test:waitlist` (see README).
export const GOOGLE_FORM_ENTRIES = {
  email: "", // e.g. "entry.1234567890"
  company: "",
  source: "",
};
export const CONTACT_EMAIL = "hello@sayre.dev"; // TODO: confirm domain
export const SITE_URL = "https://sayre.dev"; // TODO: confirm — used for OG tags
export const PLAUSIBLE_DOMAIN = ""; // optional analytics; empty = no script injected
