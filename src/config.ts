// Google Form "sayre waitlist" (https://forms.gle/ivAw32a5Az15wd7x5)
export const WAITLIST_ENDPOINT =
  "https://docs.google.com/forms/d/e/1FAIpQLSf29E9d0MhvfB61_IVZHoCI48wXssfpuX_TO3WDElmvGcKoaA/viewform";

// When WAITLIST_ENDPOINT is a Google Form, map our fields to its entry ids.
// NOTE the accepted tradeoff: browsers cannot read Google's response (no CORS),
// so a completed send is shown as success even if Google rejected it — test
// periodically with `npm run test:waitlist` (see README).
// IMPORTANT: the site only submits these three fields, so every OTHER question
// in the form must be optional or Google silently rejects the submission.
export const GOOGLE_FORM_ENTRIES = {
  email: "entry.106102431", // "Email Address"
  company: "entry.1721702441", // "Company: "
  source: "entry.1037634404", // "How did you hear about us?" — carries landing | demo-topbar | demo-tour
};
export const CONTACT_EMAIL = "hello@sayre.dev"; // TODO: confirm domain
export const SITE_URL = "https://sayre.dev"; // TODO: confirm — used for OG tags
export const PLAUSIBLE_DOMAIN = ""; // optional analytics; empty = no script injected
