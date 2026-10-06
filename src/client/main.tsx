import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installConsoleLogging, log } from "./log";
import "./styles.css";
import { applyTheme, loadChoice } from "./theme";

installConsoleLogging();
// Before the first render, so a chosen theme never flashes the default one.
applyTheme(loadChoice());
log("react", "mounting root");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
