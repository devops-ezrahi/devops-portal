import hljs from "highlight.js/lib/core";
import groovy from "highlight.js/lib/languages/groovy";
// rehype-highlight only tags code with .hljs-* classes and the AI module already
// pulls this theme in for the same reason — a duplicate import dedupes.
import "highlight.js/styles/atom-one-dark.css";

/**
 * Groovy's own grammar colours the strings and the named arguments but leaves
 * the step call itself — the one word on the line that says what it does —
 * plain, which is what makes a generated Jenkinsfile read as a wall of grey.
 * One extra mode ahead of the grammar names it. Control-flow words are excluded
 * so an imported file's `if (…)` stays a keyword rather than becoming a call.
 */
hljs.registerLanguage("jenkinsfile", (hl) => {
  const spec = groovy(hl);
  return {
    ...spec,
    contains: [
      {
        scope: "title.function",
        begin: /\b(?!if|else|for|while|switch|catch|return|new|assert)[A-Za-z_]\w*(?=\s*\()/,
      },
      ...spec.contains,
    ],
  };
});

/** Highlighted HTML for a Jenkinsfile — the same colours everywhere it is shown. */
export const highlightGroovy = (code: string) =>
  hljs.highlight(code, { language: "jenkinsfile" }).value;
