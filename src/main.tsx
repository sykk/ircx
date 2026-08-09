import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyOpeningTheme } from "@/lib/theme";
import { App } from "./App";
import "./styles/global.css";

// Before the first paint: a window that flashes the wrong theme is a window
// that told the user something untrue about their settings.
applyOpeningTheme();

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
