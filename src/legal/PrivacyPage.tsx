import { useEffect } from "react";
import { Link } from "react-router-dom";
import { CONTACT_EMAIL } from "../config";

export default function PrivacyPage(): JSX.Element {
  useEffect(() => {
    document.title = "Privacy policy — sayre_";
    window.scrollTo(0, 0);
  }, []);

  return (
    <main className="privacy-page">
      <nav className="privacy-nav" aria-label="Privacy page navigation">
        <Link className="wordmark" to="/">sayre_</Link>
        <Link className="privacy-nav__back" to="/">← back to site</Link>
      </nav>

      <article className="privacy-card">
        <header className="privacy-header">
          <span className="privacy-kicker">legal · privacy</span>
          <h1>Privacy, without the fog.</h1>
          <p className="privacy-lead">
            Sayre collects what you choose to send through the waitlist, plus limited technical information needed to serve this site. The public demo uses fictional sample data—it does not connect to or upload your repository.
          </p>
          <p className="privacy-date">Effective and last updated July 20, 2026</p>
        </header>

        <div className="privacy-sections">
          <section>
            <span className="privacy-section__num">01</span>
            <div>
              <h2>Information you provide</h2>
              <p>
                Joining the waitlist requires your name and email address. You may also share your company, company website, engineering team size, tools your team uses, what kind of Sayre conversation you want, how you found us, and any notes you choose to add. We also record which Sayre signup surface you used so we can understand where a request began.
              </p>
            </div>
          </section>

          <section>
            <span className="privacy-section__num">02</span>
            <div>
              <h2>How we use it</h2>
              <p>
                We use waitlist information to manage early access, respond to you about Sayre, arrange an intro or product demo when you ask for one, tailor that follow-up using optional answers, and understand how people discover the product. We do not currently use the site for behavioral advertising.
              </p>
            </div>
          </section>

          <section>
            <span className="privacy-section__num">03</span>
            <div>
              <h2>The demo and browser storage</h2>
              <p>
                The live demo runs in your browser using a hand-authored, fictional repository called <code>acme/monorepo</code>. It has no account connection, live AI, backend, or repository upload. The demo stores one first-party browser preference only to remember whether you dismissed or completed its guided tour. We do not use that preference for analytics, advertising, profiling, or cross-site tracking. You can remove it through your browser&apos;s site-data controls.
              </p>
            </div>
          </section>

          <section>
            <span className="privacy-section__num">04</span>
            <div>
              <h2>Services that receive data</h2>
              <p>
                Waitlist responses are submitted to Google Forms and may be stored in Google Sheets. Google Fonts also receives ordinary request information when the site loads its typefaces. Google handles that information under its <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">privacy policy</a>. Our hosting provider may process standard connection data and server logs needed to deliver and secure the site. If you email us, your email provider and ours process that message.
              </p>
              <p>
                Google and other providers may process information in countries other than your own, subject to their own policies and legal obligations.
              </p>
            </div>
          </section>

          <section>
            <span className="privacy-section__num">05</span>
            <div>
              <h2>Cookies and similar storage</h2>
              <p>
                The public Sayre site does not currently set cookies or use non-essential tracking technologies. We do not currently run third-party analytics, advertising pixels, session replay, or marketing trackers. If that changes, we will update this policy and, where required, ask for your choice before using them.
              </p>
            </div>
          </section>

          <section>
            <span className="privacy-section__num">06</span>
            <div>
              <h2>Retention and security</h2>
              <p>
                We keep waitlist information only as long as needed to manage early access, product research, and relevant follow-up, unless a longer period is required by law. We use reasonable safeguards appropriate to an early-stage service, but no storage or transmission method can be guaranteed completely secure.
              </p>
            </div>
          </section>

          <section>
            <span className="privacy-section__num">07</span>
            <div>
              <h2>Your choices</h2>
              <p>
                You can ask us to stop contacting you or request access to, correction of, or deletion of the waitlist information you submitted. Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the address you used to join so we can locate the right response.
              </p>
            </div>
          </section>

          <section>
            <span className="privacy-section__num">08</span>
            <div>
              <h2>Children</h2>
              <p>
                Sayre is a professional software product and is not directed to children under 13. We do not knowingly collect personal information from children under 13 through this site.
              </p>
            </div>
          </section>

          <section>
            <span className="privacy-section__num">09</span>
            <div>
              <h2>Changes and contact</h2>
              <p>
                We may update this page as the product and website evolve. Material changes will appear here with a new date. Questions about this policy can be sent to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
              </p>
            </div>
          </section>
        </div>
      </article>

      <footer className="privacy-footer">
        <span>© 2026 sayre</span>
        <Link to="/demo">live demo</Link>
      </footer>
    </main>
  );
}
