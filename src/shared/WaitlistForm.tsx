import { useState } from "react";
import type { FormEvent } from "react";
import { CONTACT_EMAIL, GOOGLE_FORM, WAITLIST_ENDPOINT } from "../config";
import { Button } from "./Button";

export type WaitlistSource = "landing" | "demo-topbar" | "demo-tour";

type Status = "idle" | "submitting" | "success" | "error";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isGoogleForm = WAITLIST_ENDPOINT.includes("docs.google.com/forms");
// accept either the share link (…/viewform) or the raw submit url
const googleFormAction = WAITLIST_ENDPOINT.replace(/\/viewform.*$/, "/formResponse");

/**
 * The waitlist form mirrors the team's Google Form field-for-field (those
 * questions are logistically load-bearing) and posts straight into it. The
 * site's source tag rides along automatically via the form's "How did you
 * hear about us?" Other option — visitors are never asked.
 */
export function WaitlistForm({ source }: { source: WaitlistSource }): JSX.Element {
  const [status, setStatus] = useState<Status>("idle");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [website, setWebsite] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [interest, setInterest] = useState("");
  const [notes, setNotes] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  const endpointMissing = WAITLIST_ENDPOINT === "";
  const prodFallback = endpointMissing && !import.meta.env.DEV;

  const missing = {
    name: name.trim() === "",
    email: !EMAIL_RE.test(email),
    company: company.trim() === "",
    website: website.trim() === "",
    teamSize: teamSize === "",
    tools: tools.length === 0,
    interest: interest === "",
  };
  const anyMissing = Object.values(missing).some(Boolean);

  const toggleTool = (tool: string): void => {
    setTools((t) => (t.includes(tool) ? t.filter((x) => x !== tool) : [...t, tool]));
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (anyMissing) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setStatus("submitting");
    const payload = { name, email, company, website, teamSize, tools, interest, notes, source };

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
        const body = new URLSearchParams();
        const en = GOOGLE_FORM.entries;
        body.append(en.name, name);
        body.append(en.email, email);
        body.append(en.company, company);
        body.append(en.website, website);
        body.append(en.teamSize, teamSize);
        for (const tool of tools) body.append(en.tools, tool);
        body.append(en.interest, interest);
        // source attribution rides the "Other" slot of "How did you hear about us?"
        body.append(en.heardVia, "__other_option__");
        body.append(`${en.heardVia}.other_option_response`, `site: ${source}`);
        if (notes.trim() !== "") body.append(en.notes, notes.trim());
        await fetch(googleFormAction, { method: "POST", mode: "no-cors", body });
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

  const err = (bad: boolean): boolean => showErrors && bad;

  return (
    <form className="waitlist-form" onSubmit={submit} noValidate>
      <input type="hidden" name="source" value={source} />

      <div className="waitlist-form__grid">
        <input
          className="input"
          type="text"
          placeholder="name"
          aria-label="name"
          aria-invalid={err(missing.name)}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          type="email"
          placeholder="you@company.com"
          aria-label="email"
          aria-invalid={err(missing.email)}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="input"
          type="text"
          placeholder="company"
          aria-label="company"
          aria-invalid={err(missing.company)}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
        <input
          className="input"
          type="url"
          placeholder="company website"
          aria-label="company website url"
          aria-invalid={err(missing.website)}
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      <fieldset className={err(missing.teamSize) ? "waitlist-group is-invalid" : "waitlist-group"}>
        <legend className="waitlist-group__label">engineering team size</legend>
        <div className="waitlist-chips" role="radiogroup" aria-label="engineering team size">
          {GOOGLE_FORM.options.teamSize.map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={teamSize === opt}
              className={teamSize === opt ? "waitlist-chip is-on" : "waitlist-chip"}
              onClick={() => setTeamSize(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className={err(missing.tools) ? "waitlist-group is-invalid" : "waitlist-group"}>
        <legend className="waitlist-group__label">tools your team uses</legend>
        <div className="waitlist-chips" role="group" aria-label="tools your team uses">
          {GOOGLE_FORM.options.tools.map((opt) => (
            <button
              key={opt}
              type="button"
              aria-pressed={tools.includes(opt)}
              className={tools.includes(opt) ? "waitlist-chip is-on" : "waitlist-chip"}
              onClick={() => toggleTool(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className={err(missing.interest) ? "waitlist-group is-invalid" : "waitlist-group"}>
        <legend className="waitlist-group__label">what would you be interested in?</legend>
        <div className="waitlist-chips" role="radiogroup" aria-label="what would you be interested in">
          {GOOGLE_FORM.options.interest.map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={interest === opt}
              className={interest === opt ? "waitlist-chip is-on" : "waitlist-chip"}
              onClick={() => setInterest(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      </fieldset>

      <textarea
        className="input waitlist-notes"
        placeholder="anything else we should know? (optional)"
        aria-label="anything else we should know"
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
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
      {showErrors && anyMissing && <p className="waitlist-error">a few required fields are missing — they're marked above</p>}
      {status === "error" && (
        <p className="waitlist-error">
          something broke — email us instead: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      )}
    </form>
  );
}
