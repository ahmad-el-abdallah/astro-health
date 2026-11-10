import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import "./lib/liveUpdates.js";
import App from "./App.jsx";

// "Reduce glass effects" (Account drawer) -- applied before the first paint.
try {
  if (localStorage.getItem("ah-glass") === "lite") document.documentElement.dataset.glass = "lite";
} catch { /* storage blocked: keep full glass */ }

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
