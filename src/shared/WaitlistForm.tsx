import { useState } from "react";
import type { FormEvent } from "react";
import { CONTACT_EMAIL, GOOGLE_FORM_ENTRIES, WAITLIST_ENDPOINT } from "../config";
import { Button } from "./Button";

const isGoogleForm = WAITLIST_ENDPOINT.includes("docs.google.com/forms");
// accept either the share link (…/viewform) or the raw submit url
const googleFormAction = WAITLIST_ENDPOINT.replace(/\/viewform.*$/, "/formResponse");

export type WaitlistSource = "landing" | "demo-topbar" | "demo-tour";

type Status = "idle" | "submitting" | "success" | "error";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WaitlistForm({ source }: { source: WaitlistSource }): JSX.Element {
  const [status, setStatus] = useState<Status>("idle");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [invalid, setInvalid] = useState(false);

  const endpointMissing = WAITLIST_ENDPOINT === "";
  const prodFallback = endpointMissing && !import.meta.env.DEV;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!EMAIL_RE.test(email)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setStatus("submitting");
    const payload = { email, company, source };

    if (endpointMissing) {
      // dev only — production renders the mailto fallback instead of this path
      console.info("[sayre] waitlist payload (no endpoint configured):", payload);
      window.setTimeout(() => setStatus("success"), 400);
      return;
    }

    if (isGoogleForm) {
      // Google Forms sends no CORS headers, so the response is opaque — a
      // completed send is treated as success (accepted tradeoff; verified
      // periodically via `npm run test:waitlist`). Network failures still
      // reject and surface the error state.
      try {
        await fetch(googleFormAction, {
          method: "POST",
          mode: "no-cors",
          body: new URLSearchParams({
            [GOOGLE_FORM_ENTRIES.email]: email,
            [GOOGLE_FORM_ENTRIES.company]: company,
            [GOOGLE_FORM_ENTRIES.source]: source,
          }),
        });
        setStatus("success");
      } catch {
        setStatus("error");
      }
      return;
    }

    try {
      const res = await fetch(WAITLIST_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      setStatus(res.ok ? "success" : "error");
    } catch {
      setStatus("error");
    }
  };

  if (status === "success") {
    return <p className="waitlist-success">you're on the list — we'll be in touch.</p>;
  }

  return (
    <form className="waitlist-form" onSubmit={submit} noValidate>
      <input type="hidden" name="source" value={source} />
      <input
        className="input"
        type="email"
        name="email"
        required
        placeholder="you@company.com"
        aria-label="email"
        aria-invalid={invalid}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        className="input"
        type="text"
        name="company"
        placeholder="company (optional)"
        aria-label="company (optional)"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
      />
      {prodFallback ? (
        <p className="waitlist-fallback">
          waitlist opens soon —{" "}
          <a href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("early access")}`}>email {CONTACT_EMAIL}</a>
        </p>
      ) : (
        <Button type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "joining…" : "join the waitlist"}
        </Button>
      )}
      {invalid && <p className="waitlist-error">that email doesn't look right</p>}
      {status === "error" && (
        <p className="waitlist-error">
          something broke — email us instead: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      )}
    </form>
  );
}
