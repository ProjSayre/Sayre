// Google Form "sayre waitlist" (https://forms.gle/ivAw32a5Az15wd7x5)
// The site's waitlist form mirrors this form — name and email are required;
// qualification questions are optional. Option strings must match the form
// VERBATIM (Google validates choice answers). If the form changes, update this
// block and run `npm run test:waitlist`.
// NOTE the accepted tradeoff: browsers cannot read Google's response (no CORS),
// so a completed send is shown as success even if Google rejected it — test
// periodically with `npm run test:waitlist` (see README).
export const WAITLIST_ENDPOINT: string =
  "https://docs.google.com/forms/d/e/1FAIpQLSf29E9d0MhvfB61_IVZHoCI48wXssfpuX_TO3WDElmvGcKoaA/viewform";

export const GOOGLE_FORM = {
  entries: {
    name: "entry.1644159777", // "Name: " (required)
    email: "entry.106102431", // "Email Address" (required)
    company: "entry.1721702441", // "Company: " (optional)
    website: "entry.1700760512", // "Company website url: " (optional)
    teamSize: "entry.950612422", // radio (optional)
    tools: "entry.8290515", // checkboxes (optional, has Other)
    interest: "entry.24371813", // radio (optional)
    heardVia: "entry.1037634404", // checkboxes (optional, has Other) — also carries the site source
    notes: "entry.1803818157", // paragraph (optional)
  },
  options: {
    teamSize: ["1-5 engineers", "6-15 engineers", "16-50 engineers", "51-100 engineers", "100+ engineers"],
    tools: ["GitHub", "Linear", "Jira", "Slack", "Notion", "Google Docs", "Confluence", "Cursor", "GitHub Copilot", "Claude"],
    interest: ["A 15-minute intro call", "A 30-minute product demo", "Just want to learn more"],
    heardVia: ["Cold email", "LinkedIn", "Referral", "University network", "Startup community", "Website / Google search", "Social Media"],
  },
};
export const CONTACT_EMAIL = "hello@sayre.dev"; // TODO: confirm domain
export const SITE_URL = "https://sayre.dev"; // TODO: confirm — used for OG tags
export const PLAUSIBLE_DOMAIN = ""; // optional analytics; empty = no script injected
