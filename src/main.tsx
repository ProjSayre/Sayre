import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { PLAUSIBLE_DOMAIN } from "./config";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/landing.css";
import "./styles/demo.css";
import "./styles/privacy.css";

if (import.meta.env.DEV) {
  void import("./data/validate").then((m) => m.validateDataset());
}

if (PLAUSIBLE_DOMAIN !== "") {
  const s = document.createElement("script");
  s.defer = true;
  s.dataset.domain = PLAUSIBLE_DOMAIN;
  s.src = "https://plausible.io/js/script.js";
  document.head.appendChild(s);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
