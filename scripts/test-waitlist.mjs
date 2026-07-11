// Periodic waitlist check (`npm run test:waitlist`). The browser can't read
// Google's response (no CORS), but Node can — this submits a real test row and
// inspects the reply, catching the silent-failure mode the site itself cannot.
// A passing run still warrants a glance at the form's Responses tab.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
let failed = false;
try {
  const { WAITLIST_ENDPOINT, GOOGLE_FORM_ENTRIES } = await server.ssrLoadModule("/src/config.ts");

  if (!WAITLIST_ENDPOINT) {
    console.error("FAIL: WAITLIST_ENDPOINT is empty — nothing is capturing signups.");
    process.exit(1);
  }

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const testRow = {
    email: "waitlist-test@sayre.dev",
    company: "periodic check",
    source: `manual-test ${stamp}`,
  };

  if (WAITLIST_ENDPOINT.includes("docs.google.com/forms")) {
    const action = WAITLIST_ENDPOINT.replace(/\/viewform.*$/, "/formResponse");
    const entries = Object.values(GOOGLE_FORM_ENTRIES);
    if (entries.some((e) => !e)) {
      console.error("FAIL: GOOGLE_FORM_ENTRIES has empty entry ids — submissions are being dropped.");
      process.exit(1);
    }
    const res = await fetch(action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [GOOGLE_FORM_ENTRIES.email]: testRow.email,
        [GOOGLE_FORM_ENTRIES.company]: testRow.company,
        [GOOGLE_FORM_ENTRIES.source]: testRow.source,
      }),
    });
    const body = await res.text();
    // on validation failure google re-renders the form (entry ids reappear);
    // the confirmation page contains none of them
    const rerendered = entries.some((e) => body.includes(e));
    if (!res.ok) {
      console.error(`FAIL: google returned http ${res.status} — form deleted, closed, or url wrong.`);
      failed = true;
    } else if (rerendered) {
      console.error("FAIL: google re-rendered the form (validation error) — entry ids probably no longer match.");
      failed = true;
    } else {
      console.log(`ok — google accepted the test row (source: "${testRow.source}").`);
      console.log("confirm it appears in the form's Responses tab / linked sheet, then delete it.");
    }
  } else {
    const res = await fetch(WAITLIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(testRow),
    });
    if (res.ok) {
      console.log(`ok — endpoint returned http ${res.status} (source: "${testRow.source}").`);
    } else {
      console.error(`FAIL: endpoint returned http ${res.status}.`);
      failed = true;
    }
  }
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
