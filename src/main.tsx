import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsWindow, isSettingsPage } from "@/components/settings";
import { applyOpeningTheme } from "@/lib/theme";
import { App } from "./App";
import "./styles/global.css";

// Before the first paint: a window that flashes the wrong theme is a window
// that told the user something untrue about their settings.
applyOpeningTheme();

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

// Both windows are this page, told apart by the query the settings window is
// opened at. One bundle rather than a second HTML file, so the settings window
// renders the client's own components against the client's own store — which
// is what makes the appearance preview the real thing rather than a drawing of
// it.
createRoot(root).render(
  <StrictMode>{isSettingsPage() ? <SettingsWindow /> : <App />}</StrictMode>,
);
