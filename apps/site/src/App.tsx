import { Navigate, Route, Routes } from "react-router-dom";
import LandingPage from "./landing/LandingPage";
import PrivacyPage from "./legal/PrivacyPage";

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/demo" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
