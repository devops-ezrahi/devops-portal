import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import ini from "highlight.js/lib/languages/ini";
import json from "highlight.js/lib/languages/json";
import nginx from "highlight.js/lib/languages/nginx";
import properties from "highlight.js/lib/languages/properties";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "highlight.js/styles/atom-one-dark.css";

// `highlight.js/lib/core` is one shared registry, so these sit beside the
// Jenkinsfile builder's grammar without disturbing it.
const LANGS = { bash, ini, json, nginx, properties, xml, yaml };
Object.entries(LANGS).forEach(([name, lang]) => hljs.registerLanguage(name, lang));

const BY_EXT: Record<string, keyof typeof LANGS> = {
  xml: "xml",
  html: "xml",
  xsd: "xml",
  properties: "properties",
  ini: "ini",
  toml: "ini",
  cfg: "ini",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  sh: "bash",
  bash: "bash",
};

/**
 * A ConfigMap file's contents, coloured as whatever its key says it is —
 * `log4j2.xml` as XML, `app.properties` as properties. A key with no telling
 * extension is guessed at from the text among the same few languages.
 */
export function highlightFile(fileName: string, text: string): string {
  const name = fileName.trim().toLowerCase();
  const ext = name.split(".").pop() ?? "";
  const lang = name.includes("nginx") ? "nginx" : BY_EXT[ext];
  return lang ? hljs.highlight(text, { language: lang }).value : hljs.highlightAuto(text, Object.keys(LANGS)).value;
}
