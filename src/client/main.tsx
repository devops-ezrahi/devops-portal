import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installConsoleLogging, log } from "./log";
import "./styles.css";

installConsoleLogging();
log("react", "mounting root");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
