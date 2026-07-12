// Periodic waitlist check (`npm run test:waitlist`). The browser can't read
// Google's response (no CORS), but Node can — this submits a real test row
// (all required fields, exactly as the site does) and inspects the reply,
// catching the silent-failure mode the site itself cannot: deleted form,
// closed responses, changed entry ids, changed option strings, or a question
// flipped to required that the site doesn't send.
// A passing run still warrants a glance at the form's Responses tab.

let failed = false;
try {
  // node ≥23.6 strips types natively — no bundler needed to read the config
  const { WAITLIST_ENDPOINT, GOOGLE_FORM } = await import(new URL("../src/config.ts", import.meta.url));

  if (!WAITLIST_ENDPOINT) {
    console.error("FAIL: WAITLIST_ENDPOINT is empty — nothing is capturing signups.");
    process.exitCode = 1;
    throw new Error("unconfigured");
  }

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  if (WAITLIST_ENDPOINT.includes("docs.google.com/forms")) {
    const action = WAITLIST_ENDPOINT.replace(/\/viewform.*$/, "/formResponse");
    const en = GOOGLE_FORM.entries;
    const opt = GOOGLE_FORM.options;
    const body = new URLSearchParams();
    body.append(en.name, "waitlist test row");
    body.append(en.email, "waitlist-test@sayre.dev");
    body.append(en.company, "periodic check");
    body.append(en.website, "https://sayre.dev");
    body.append(en.teamSize, opt.teamSize[0]);
    body.append(en.tools, opt.tools[0]);
    body.append(en.interest, opt.interest[opt.interest.length - 1]);
    body.append(en.heardVia, "__other_option__");
    body.append(`${en.heardVia}.other_option_response`, `site: manual-test ${stamp}`);
    body.append(en.notes, `manual-test ${stamp} — safe to delete`);

    const res = await fetch(action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    // on validation failure google re-renders the form (entry ids reappear);
    // the confirmation page contains none of them
    const rerendered = Object.values(en).some((e) => text.includes(String(e).replace("entry.", "")) && text.includes("freebirdFormviewerViewItemList"));
    if (!res.ok) {
      console.error(`FAIL: google returned http ${res.status} — required/option mismatch, form closed, or url wrong.`);
      failed = true;
    } else if (rerendered) {
      console.error("FAIL: google re-rendered the form (validation error) — entry ids or option strings no longer match.");
      failed = true;
    } else {
      console.log(`ok — google accepted the test row (notes: "manual-test ${stamp}").`);
      console.log("confirm it appears in the form's Responses tab / linked sheet, then delete it.");
    }
  } else {
    const res = await fetch(WAITLIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: "waitlist-test@sayre.dev", source: `manual-test ${stamp}` }),
    });
    if (res.ok) {
      console.log(`ok — endpoint returned http ${res.status}.`);
    } else {
      console.error(`FAIL: endpoint returned http ${res.status}.`);
      failed = true;
    }
  }
} catch (err) {
  if (err?.message !== "unconfigured") console.error("FAIL:", err);
  failed = true;
}
// set the code and let the event loop drain — calling process.exit() while
// fetch's keep-alive sockets are open trips a libuv assertion on win+node24
process.exitCode = failed ? 1 : 0;
