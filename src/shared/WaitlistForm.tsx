import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { CONTACT_EMAIL, GOOGLE_FORM, WAITLIST_ENDPOINT } from "../config";
import { Button } from "./Button";

export type WaitlistSource = "landing" | "demo-topbar" | "demo-tour";

type Status = "idle" | "submitting" | "success" | "error";
type Step = 1 | 2;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isGoogleForm = WAITLIST_ENDPOINT.includes("docs.google.com/forms");
// accept either the share link (…/viewform) or the raw submit url
const googleFormAction = WAITLIST_ENDPOINT.replace(/\/viewform.*$/, "/formResponse");

/**
 * The live Google Form requires only name and email. Everything else stays
 * available on a second, optional screen and is omitted when left blank.
 */
export function WaitlistForm({ source }: { source: WaitlistSource }): JSX.Element {
  const [step, setStep] = useState<Step>(1);
  const [status, setStatus] = useState<Status>("idle");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [website, setWebsite] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [toolsOtherOn, setToolsOtherOn] = useState(false);
  const [toolsOther, setToolsOther] = useState("");
  const [interest, setInterest] = useState("");
  const [heardVia, setHeardVia] = useState<string[]>([]);
  const [heardViaOtherOn, setHeardViaOtherOn] = useState(false);
  const [heardViaOther, setHeardViaOther] = useState("");
  const [notes, setNotes] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  const endpointMissing = WAITLIST_ENDPOINT === "";
  const prodFallback = endpointMissing && !import.meta.env.DEV;
  const missingName = name.trim() === "";
  const missingEmail = !EMAIL_RE.test(email.trim());
  const firstStepInvalid = missingName || missingEmail;

  const toggleValue = (value: string, values: string[], setValues: (next: string[]) => void): void => {
    setValues(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  };

  const submit = async (): Promise<void> => {
    if (firstStepInvalid) {
      setStep(1);
      setShowErrors(true);
      return;
    }

    setShowErrors(false);
    setStatus("submitting");
    const payload = {
      name: name.trim(),
      email: email.trim(),
      company: company.trim(),
      website: website.trim(),
      teamSize,
      tools,
      toolsOther: toolsOtherOn ? toolsOther.trim() : "",
      interest,
      heardVia,
      heardViaOther: heardViaOtherOn ? heardViaOther.trim() : "",
      notes: notes.trim(),
      source,
    };

    if (endpointMissing) {
      // dev only — production renders the mailto fallback instead of this path
      console.info("[sayre] waitlist payload (no endpoint configured):", payload);
      window.setTimeout(() => setStatus("success"), 400);
      return;
    }

    if (isGoogleForm) {
      // Google Forms sends no CORS headers, so the response is opaque — a
      // completed send is treated as success (accepted tradeoff; verified
      // periodically via `npm run test:waitlist`).
      try {
        const body = new URLSearchParams();
        const en = GOOGLE_FORM.entries;
        body.append(en.name, payload.name);
        body.append(en.email, payload.email);
        if (payload.company) body.append(en.company, payload.company);
        if (payload.website) body.append(en.website, payload.website);
        if (payload.teamSize) body.append(en.teamSize, payload.teamSize);
        for (const tool of payload.tools) body.append(en.tools, tool);
        if (payload.toolsOther) {
          body.append(en.tools, "__other_option__");
          body.append(`${en.tools}.other_option_response`, payload.toolsOther);
        }
        if (payload.interest) body.append(en.interest, payload.interest);
        for (const channel of payload.heardVia) body.append(en.heardVia, channel);

        // Google gives this checkbox question one Other slot. Keep the site's
        // attribution there, combining it with a visitor-supplied Other answer.
        body.append(en.heardVia, "__other_option__");
        body.append(
          `${en.heardVia}.other_option_response`,
          payload.heardViaOther ? `${payload.heardViaOther} · site: ${source}` : `site: ${source}`,
        );
        if (payload.notes) body.append(en.notes, payload.notes);
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

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (step === 1) {
      if (firstStepInvalid) {
        setShowErrors(true);
        return;
      }
      setShowErrors(false);
      setStep(2);
      return;
    }
    void submit();
  };

  if (status === "success") {
    return <p className="waitlist-success">you're on the list — we'll be in touch.</p>;
  }

  return (
    <form className="waitlist-form" onSubmit={handleSubmit} noValidate>
      <input type="hidden" name="source" value={source} />

      {step === 1 ? (
        <div className="waitlist-form__screen" key="required">
          <div className="waitlist-form__stephead">
            <span>01 / 02</span>
            <p>Start with the essentials.</p>
          </div>
          <div className="waitlist-form__grid">
            <input
              className="input"
              type="text"
              placeholder="name"
              aria-label="name"
              aria-invalid={showErrors && missingName}
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="input"
              type="email"
              placeholder="you@company.com"
              aria-label="email"
              aria-invalid={showErrors && missingEmail}
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="waitlist-form__actions waitlist-form__actions--forward">
            <Button type="submit">continue</Button>
          </div>
          <p className="waitlist-privacy">
            We use these details for early-access follow-up. <Link to="/privacy">Privacy policy</Link>
          </p>
          {showErrors && firstStepInvalid && <p className="waitlist-error">add your name and a valid email to continue.</p>}
        </div>
      ) : (
        <div className="waitlist-form__screen" key="optional">
          <div className="waitlist-form__stephead">
            <span>02 / 02</span>
            <p>A little context helps us tailor the conversation. Everything here is optional.</p>
          </div>

          <div className="waitlist-form__grid">
            <input
              className="input"
              type="text"
              placeholder="company (optional)"
              aria-label="company"
              autoComplete="organization"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
            />
            <input
              className="input"
              type="url"
              placeholder="company website (optional)"
              aria-label="company website url"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </div>

          <fieldset className="waitlist-group">
            <legend className="waitlist-group__label">engineering team size <span>optional</span></legend>
            <div className="waitlist-chips" role="radiogroup" aria-label="engineering team size">
              {GOOGLE_FORM.options.teamSize.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={teamSize === option}
                  className={teamSize === option ? "waitlist-chip is-on" : "waitlist-chip"}
                  onClick={() => setTeamSize(teamSize === option ? "" : option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="waitlist-group">
            <legend className="waitlist-group__label">tools your team uses <span>optional</span></legend>
            <div className="waitlist-chips" role="group" aria-label="tools your team uses">
              {GOOGLE_FORM.options.tools.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={tools.includes(option)}
                  className={tools.includes(option) ? "waitlist-chip is-on" : "waitlist-chip"}
                  onClick={() => toggleValue(option, tools, setTools)}
                >
                  {option}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={toolsOtherOn}
                className={toolsOtherOn ? "waitlist-chip is-on" : "waitlist-chip"}
                onClick={() => setToolsOtherOn((on) => !on)}
              >
                Other
              </button>
            </div>
            {toolsOtherOn && (
              <input
                className="input waitlist-other"
                type="text"
                placeholder="other tool"
                aria-label="other tool"
                value={toolsOther}
                onChange={(event) => setToolsOther(event.target.value)}
              />
            )}
          </fieldset>

          <fieldset className="waitlist-group">
            <legend className="waitlist-group__label">what would you be interested in? <span>optional</span></legend>
            <div className="waitlist-chips" role="radiogroup" aria-label="what would you be interested in">
              {GOOGLE_FORM.options.interest.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={interest === option}
                  className={interest === option ? "waitlist-chip is-on" : "waitlist-chip"}
                  onClick={() => setInterest(interest === option ? "" : option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="waitlist-group">
            <legend className="waitlist-group__label">how did you hear about us? <span>optional</span></legend>
            <div className="waitlist-chips" role="group" aria-label="how did you hear about us">
              {GOOGLE_FORM.options.heardVia.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={heardVia.includes(option)}
                  className={heardVia.includes(option) ? "waitlist-chip is-on" : "waitlist-chip"}
                  onClick={() => toggleValue(option, heardVia, setHeardVia)}
                >
                  {option}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={heardViaOtherOn}
                className={heardViaOtherOn ? "waitlist-chip is-on" : "waitlist-chip"}
                onClick={() => setHeardViaOtherOn((on) => !on)}
              >
                Other
              </button>
            </div>
            {heardViaOtherOn && (
              <input
                className="input waitlist-other"
                type="text"
                placeholder="other source"
                aria-label="other source"
                value={heardViaOther}
                onChange={(event) => setHeardViaOther(event.target.value)}
              />
            )}
          </fieldset>

          <textarea
            className="input waitlist-notes"
            placeholder="anything else we should know? (optional)"
            aria-label="anything else we should know"
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />

          <div className="waitlist-form__actions">
            <Button type="button" variant="secondary" onClick={() => setStep(1)}>back</Button>
            {prodFallback ? (
              <p className="waitlist-fallback">
                waitlist opens soon — <a href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("early access")}`}>email {CONTACT_EMAIL}</a>
              </p>
            ) : (
              <Button type="submit" disabled={status === "submitting"}>
                {status === "submitting" ? "joining…" : "join the waitlist"}
              </Button>
            )}
          </div>
          <p className="waitlist-privacy">
            Optional answers help tailor the conversation. <Link to="/privacy">Privacy policy</Link>
          </p>
          {status === "error" && (
            <p className="waitlist-error">
              something broke — email us instead: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </p>
          )}
        </div>
      )}
    </form>
  );
}
