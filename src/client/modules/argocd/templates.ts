import { createContext } from "react";
import { isPlainObject, type Values } from "./values";

/**
 * `{{ .Values.color }}` and `{{ .Release.Namespace }}` in a value: the converter
 * writes them into base so one file serves every folder (`--env-group`), and the
 * chart `tpl`s every value — and every key — against the folder's own layers.
 * On screen the raw braces say nothing about what a field becomes, so the
 * editor resolves them against each folder the release runs in.
 */
export const TEMPLATE_RE = /\{\{-?\s*\.(Values\.[A-Za-z_][\w.]*|Release\.Namespace)\s*-?\}\}/g;

export const hasTemplate = (text: string): boolean => new RegExp(TEMPLATE_RE.source).test(text);

/** One folder's view: its name and the values its templates read (defaults + its own override). */
export type TemplateScope = { folder: string; values: Values };

/** The folders the open file is rendered for — every running folder for base, one for an override. */
export const TemplateScopes = createContext<TemplateScope[]>([]);

const lookup = (values: Values, path: string[]): unknown =>
  path.reduce<unknown>((cur, key) => (isPlainObject(cur) ? cur[key] : undefined), values);

export type Resolution = { folder: string; text?: string; missing?: string };

/** `text` rendered for each scope, or which placeholder that folder leaves unset. */
export function resolveTemplate(text: string, scopes: TemplateScope[]): Resolution[] {
  return scopes.map(({ folder, values }) => {
    let missing: string | undefined;
    const out = text.replace(TEMPLATE_RE, (_, ref: string) => {
      if (ref === "Release.Namespace") return folder.split("/")[0];
      const v = lookup(values, ref.split(".").slice(1));
      if (v === undefined || v === null || isPlainObject(v)) {
        missing ??= `.${ref}`;
        return "";
      }
      return String(v);
    });
    return missing ? { folder, missing } : { folder, text: out };
  });
}

/** Split for display: plain runs and `{ ref }` placeholders, in order. */
export function templateParts(text: string): (string | { ref: string })[] {
  const parts: (string | { ref: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(TEMPLATE_RE)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push({ ref: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
