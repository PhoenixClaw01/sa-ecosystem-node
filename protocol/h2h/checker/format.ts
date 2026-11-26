/**
 * Renders a ledger as Markdown and JSON. Field text is escaped.
 * Nothing here is executed.
 */
import { stripUnsafeSingleLine } from "./text.ts";
import { LIMITS, type Ledger } from "./types.ts";

export function formatJson(ledger: Ledger): string {
  return JSON.stringify(ledger, null, 2);
}

export function formatMarkdown(ledger: Ledger): string {
  const lines: string[] = ["## H2H claim ledger", ""];
  lines.push("### Claims", "");
  if (ledger.claims.length === 0) lines.push("None.", "");
  else {
    lines.push("| Id | Author | Owner | Scope | Status |", "|---|---|---|---|---|");
    for (const claim of ledger.claims) {
      lines.push(`| ${cell(claim.id)} | ${cell(claim.author)} | ${cell(claim.owner)} | ${cell(claim.scope)} | ${cell(claim.status)} |`);
    }
    lines.push("");
  }

  lines.push("### Conflicts", "");
  if (ledger.conflicts.length === 0) lines.push("None.", "");
  else {
    for (const conflict of ledger.conflicts) {
      const ids = conflict.claims.map((claim) => inline(claim.id)).join(", ");
      lines.push(`- ${inline(conflict.scope)}: ${ids}`);
    }
    lines.push("");
  }

  lines.push("### Released", "");
  lines.push(ledger.released.length === 0 ? "None." : ledger.released.map((id) => `- ${inline(id)}`).join("\n"), "");
  lines.push("### Superseded", "");
  lines.push(ledger.superseded.length === 0 ? "None." : ledger.superseded.map((id) => `- ${inline(id)}`).join("\n"), "");

  lines.push("### Deliverables", "");
  if (ledger.deliverables.length === 0) lines.push("None.", "");
  else {
    for (const item of ledger.deliverables) {
      const where = [item.pr ? `pr ${inline(item.pr)}` : "", item.ref ? `ref ${inline(item.ref)}` : ""].filter(Boolean).join(", ");
      const flag = item.unreferenced ? ", references no claim" : "";
      lines.push(`- ${inline(item.id)} by ${inline(item.author)} for claim ${inline(item.claim)} (${where}${flag})`);
    }
    lines.push("");
  }

  lines.push("### Verifies", "");
  if (ledger.verifies.length === 0) lines.push("None.", "");
  else {
    for (const item of ledger.verifies) {
      lines.push(`- ${inline(item.id)} by ${inline(item.author)} on ${inline(item.scope)} (${inline(item.status)})`);
      lines.push(`  - expected: ${inline(item.expected)}`);
      for (const command of item.commands) lines.push(`  - command: ${inline(command)}`);
    }
    lines.push("");
  }

  lines.push("### Unverified", "");
  lines.push("Blocks in this list are not claims.", "");
  if (ledger.unverified.length === 0) lines.push("None.", "");
  else {
    for (const item of ledger.unverified) {
      lines.push(`- ${inline(item.author || "(no login)")} kind ${inline(item.kind)} id ${inline(item.id)} scope ${inline(item.scope)}`);
    }
    lines.push("");
  }

  lines.push("### Ignored", "");
  if (ledger.ignored.length === 0) lines.push("None.", "");
  else {
    for (const item of ledger.ignored) lines.push(`- kind ${inline(item.kind)} id ${inline(item.id ?? "(none)")}`);
    lines.push("");
  }

  lines.push("### Errors", "");
  if (ledger.errors.length === 0) lines.push("None.", "");
  else {
    for (const item of ledger.errors) {
      lines.push(`- \`${item.code}\` (${inline(item.author || "(no login)")}, ${inline(item.source)}): ${inline(item.message)}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function formatSummary(markdown: string, json: string): string {
  const safeJson = stripUnsafeSingleLine(json).replace(/`/g, "'");
  const fenced = fence("json", safeJson);
  const text = `${markdown}\n\n### JSON\n\n${fenced}`;
  if (text.length <= LIMITS.summaryChars) return text;
  return `${text.slice(0, LIMITS.summaryChars)}\n\nTruncated.\n`;
}

function cell(value: string): string {
  return inline(value).replace(/\|/g, "\\|");
}

function inline(value: string): string {
  const flat = flattenControls(value).replace(/`/g, "'");
  const escaped = flat
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\]\(/g, "] (");
  return `\`${escaped}\``;
}

function flattenControls(value: string): string {
  const stripped = stripUnsafeSingleLine(value);
  let out = "";
  for (const char of stripped) out += char.charCodeAt(0) <= 31 ? " " : char;
  return out;
}

function fence(lang: string, body: string): string {
  let size = 3;
  while (body.includes("`".repeat(size))) size += 1;
  const ticks = "`".repeat(size);
  return `${ticks}${lang}\n${body}\n${ticks}\n`;
}
