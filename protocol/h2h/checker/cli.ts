/**
 * Reads one public thread with `gh api` and prints the claim ledger.
 * Comment bodies are never passed to a shell. The only spawned program is
 * `gh`, and its arguments are a fixed API path built from a repo name and
 * an integer.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { defaultAccountsPath, loadKnownAccounts } from "./accounts.ts";
import { formatJson, formatMarkdown, formatSummary } from "./format.ts";
import { buildLedger } from "./ledger.ts";
import { threadFromIssue, threadFromPull } from "./thread.ts";
import { LIMITS, type KnownAccounts, type Ledger, type ThreadEntry } from "./types.ts";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USAGE = `Usage: node --experimental-strip-types protocol/h2h/checker/cli.ts [--issue <n> | --pr <n> | --fixture <file>] [--repo owner/name] [--format both|markdown|json] [--accounts <file>] [--github-summary]

The checker reads an issue and its comments, or a pull request, and prints a claim ledger. It does not post, label, or write to the repo.`;

const SAFE_MESSAGES = new Set([
  "file exceeds the size cap",
  "file is not a regular file",
  "gh api failed",
  "gh api returned a body that is not JSON",
  "gh api response exceeds the size cap",
  "refusing api path",
  "GITHUB_STEP_SUMMARY is not set",
  "GITHUB_STEP_SUMMARY is not a safe path",
]);

export interface ParsedArgs {
  help: boolean;
  githubSummary: boolean;
  format: "both" | "markdown" | "json";
  fixture?: string;
  issue?: number;
  pr?: number;
  repo?: string;
  accounts?: string;
}

export interface CliDeps {
  ghApi: (apiPath: string) => unknown;
  readText: (file: string, maxBytes: number) => string;
  writeSummary: (file: string, text: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  accountsPath: string;
}

export function parseArgs(argv: readonly string[]): { ok: true; args: ParsedArgs } | { ok: false; message: string } {
  const args: ParsedArgs = { help: false, githubSummary: false, format: "both" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      args.help = true;
      continue;
    }
    if (flag === "--github-summary") {
      args.githubSummary = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === "--format") {
      if (value !== "both" && value !== "markdown" && value !== "json") return { ok: false, message: USAGE };
      args.format = value;
      i += 1;
      continue;
    }
    if (flag === "--fixture" || flag === "--accounts") {
      const path = pathArg(value);
      if (!path) return { ok: false, message: USAGE };
      if (flag === "--fixture") args.fixture = path;
      else args.accounts = path;
      i += 1;
      continue;
    }
    if (flag === "--repo") {
      if (!value || !REPO.test(value)) return { ok: false, message: "Repo must be owner/name." };
      args.repo = value;
      i += 1;
      continue;
    }
    if (flag === "--issue" || flag === "--pr") {
      const number = parseNumber(value);
      if (number === null) return { ok: false, message: "Issue and PR numbers must be positive integers." };
      if (flag === "--issue") args.issue = number;
      else args.pr = number;
      i += 1;
      continue;
    }
    return { ok: false, message: USAGE };
  }
  const modes = [args.fixture, args.issue, args.pr].filter((item) => item !== undefined).length;
  if (args.help) return { ok: true, args };
  if (modes > 1) return { ok: false, message: "Pass only one of --issue, --pr, or --fixture." };
  if (modes === 0 && !args.githubSummary) return { ok: false, message: USAGE };
  if ((args.issue !== undefined || args.pr !== undefined) && !args.repo && !args.githubSummary) {
    return { ok: false, message: "Pass --repo owner/name." };
  }
  return { ok: true, args };
}

export function targetFromGithubEvent(eventName: string, event: unknown, repoEnv: string | undefined): { kind: "issue" | "pr"; number: number; repo: string } | { error: string } {
  if (eventName !== "issue_comment" && eventName !== "pull_request_review_comment") {
    return { error: "This checker only reads issue_comment and pull_request_review_comment events." };
  }
  if (!isPlain(event)) return { error: "Event payload is not an object." };
  const repo = pickRepo(repoEnv, event);
  if (!repo) return { error: "Repository is not an owner/name pair." };
  if (eventName === "issue_comment") {
    const issue = own(event, "issue");
    if (!isPlain(issue)) return { error: "Event has no issue number." };
    const number = positiveInt(own(issue, "number"));
    if (number === null) return { error: "Event has no issue number." };
    return { kind: isPlain(own(issue, "pull_request")) ? "pr" : "issue", number, repo };
  }
  const pull = own(event, "pull_request");
  if (!isPlain(pull)) return { error: "Event has no pull request number." };
  const number = positiveInt(own(pull, "number"));
  if (number === null) return { error: "Event has no pull request number." };
  return { kind: "pr", number, repo };
}

export function githubApiPaths(repo: string, number: number, kind: "issue" | "pr"): string[] {
  if (!REPO.test(repo) || !Number.isInteger(number) || number < 1 || number > 1_000_000_000) {
    throw new Error("refusing api path");
  }
  const [owner, name] = repo.split("/");
  const base = `repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
  const n = String(number);
  if (kind === "issue") return [`${base}/issues/${n}`, `${base}/issues/${n}/comments?per_page=100`];
  return [`${base}/pulls/${n}`, `${base}/issues/${n}/comments?per_page=100`, `${base}/pulls/${n}/comments?per_page=100`];
}

export function ghArgv(apiPath: string): string[] {
  if (!apiPath.startsWith("repos/") || apiPath.includes("..") || hasControlOrSpace(apiPath)) {
    throw new Error("refusing api path");
  }
  return ["api", "--paginate", apiPath];
}

function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) <= 32) return true;
  }
  return false;
}

export function run(argv: readonly string[], deps: CliDeps = defaultDeps()): number {
  try {
    return runChecked(argv, deps);
  } catch (err) {
    const message = err instanceof Error && SAFE_MESSAGES.has(err.message) ? err.message : "checker failed";
    deps.stderr(`${message}\n`);
    return 1;
  }
}

function runChecked(argv: readonly string[], deps: CliDeps): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.stderr(`${parsed.message}\n`);
    return 1;
  }
  if (parsed.args.help) {
    deps.stdout(`${USAGE}\n`);
    return 0;
  }

  const accounts = readAccounts(deps, parsed.args.accounts);
  if (!("logins" in accounts)) {
    deps.stderr(`${accounts.message}\n`);
    return 1;
  }

  let target = parsed.args;
  if (parsed.args.githubSummary && parsed.args.issue === undefined && parsed.args.pr === undefined && !parsed.args.fixture) {
    const eventPath = deps.env.GITHUB_EVENT_PATH;
    const eventName = deps.env.GITHUB_EVENT_NAME ?? "";
    if (!eventPath) {
      deps.stderr("GITHUB_EVENT_PATH is not set.\n");
      return 1;
    }
    const event = JSON.parse(deps.readText(eventPath, LIMITS.maxFileBytes)) as unknown;
    const fromEvent = targetFromGithubEvent(eventName, event, deps.env.GITHUB_REPOSITORY);
    if ("error" in fromEvent) {
      deps.stderr(`${fromEvent.error}\n`);
      return 1;
    }
    target = { ...parsed.args, repo: fromEvent.repo, issue: fromEvent.kind === "issue" ? fromEvent.number : undefined, pr: fromEvent.kind === "pr" ? fromEvent.number : undefined };
  }

  const loaded = loadThread(target, deps);
  if ("message" in loaded) {
    deps.stderr(`${loaded.message}\n`);
    return 1;
  }
  const ledger = buildLedger(loaded.entries, accounts, loaded.errors);
  return emit(parsed.args, ledger, deps);
}

function readAccounts(deps: CliDeps, override: string | undefined): KnownAccounts | { message: string } {
  const file = override ?? deps.accountsPath;
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readText(file, 64 * 1024)) as unknown;
  } catch (err) {
    if (err instanceof Error && SAFE_MESSAGES.has(err.message)) return { message: err.message };
    return { message: "known-accounts.json could not be read." };
  }
  const loaded = loadKnownAccounts(parsed);
  if (!loaded.ok) return { message: loaded.message };
  return loaded.accounts;
}

function loadThread(args: ParsedArgs, deps: CliDeps): { entries: ThreadEntry[]; errors: Ledger["errors"] } | { message: string } {
  if (args.fixture) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(deps.readText(args.fixture, LIMITS.maxFileBytes)) as unknown;
    } catch (err) {
      if (err instanceof Error && SAFE_MESSAGES.has(err.message)) return { message: err.message };
      return { message: "The fixture could not be read." };
    }
    const entries = fixtureEntries(parsed);
    if (!entries) return { message: "The fixture is not a list of entries." };
    return { entries, errors: [] };
  }
  const repo = args.repo;
  if (!repo || !REPO.test(repo)) return { message: "Repo must be owner/name." };
  if (args.pr !== undefined) {
    const paths = githubApiPaths(repo, args.pr, "pr");
    const [pull, comments, reviews] = paths.map((apiPath) => deps.ghApi(apiPath));
    return threadFromPull(pull, comments, reviews);
  }
  if (args.issue !== undefined) {
    const paths = githubApiPaths(repo, args.issue, "issue");
    const [issue, comments] = paths.map((apiPath) => deps.ghApi(apiPath));
    return threadFromIssue(issue, comments);
  }
  return { message: USAGE };
}

function fixtureEntries(value: unknown): ThreadEntry[] | null {
  if (!isPlain(value) || !Array.isArray(value.entries)) return null;
  const entries: ThreadEntry[] = [];
  for (const item of value.entries) {
    if (!isPlain(item) || typeof item.body !== "string" || typeof item.author !== "string") return null;
    const source = item.source === "body" || item.source === "comment" || item.source === "review-comment" ? item.source : null;
    if (!source) return null;
    entries.push({ source, author: item.author, body: item.body });
  }
  return entries;
}

function emit(args: ParsedArgs, ledger: Ledger, deps: CliDeps): number {
  const markdown = formatMarkdown(ledger);
  const json = formatJson(ledger);
  if (args.githubSummary) {
    const file = summaryPath(deps.env.GITHUB_STEP_SUMMARY);
    if (!file) {
      deps.stderr(deps.env.GITHUB_STEP_SUMMARY ? "GITHUB_STEP_SUMMARY is not a safe path\n" : "GITHUB_STEP_SUMMARY is not set\n");
      return 1;
    }
    deps.writeSummary(file, formatSummary(markdown, json));
  }
  if (args.format === "markdown") deps.stdout(`${markdown}\n`);
  else if (args.format === "json") deps.stdout(`${json}\n`);
  else deps.stdout(`${markdown}\n<!-- h2h-ledger-json -->\n${json}\n`);
  return 0;
}

function summaryPath(value: string | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) return null;
  return value;
}

function pathArg(value: string | undefined): string | null {
  if (!value || value.startsWith("-") || value.includes("\0") || value.includes("\n") || value.length > 500) return null;
  return value;
}

function parseNumber(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,9}$/.test(value)) return null;
  return positiveInt(Number(value));
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000_000) return null;
  return value;
}

function pickRepo(repoEnv: string | undefined, event: Record<string, unknown>): string | null {
  if (repoEnv && REPO.test(repoEnv)) return repoEnv;
  const repository = own(event, "repository");
  if (!isPlain(repository) || typeof repository.full_name !== "string" || !REPO.test(repository.full_name)) return null;
  return repository.full_name;
}

function defaultDeps(): CliDeps {
  return {
    ghApi: defaultGhApi,
    readText: readCapped,
    writeSummary: (file, text) => appendFileSync(file, text),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    accountsPath: defaultAccountsPath(),
  };
}

function defaultGhApi(apiPath: string): unknown {
  const args = ghArgv(apiPath);
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: LIMITS.maxFileBytes,
    env: process.env,
  });
  if (result.error || result.status !== 0) throw new Error("gh api failed");
  const stdout = result.stdout ?? "";
  if (Buffer.byteLength(stdout, "utf8") > LIMITS.maxFileBytes) throw new Error("gh api response exceeds the size cap");
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("gh api returned a body that is not JSON");
  }
}

function readCapped(file: string, maxBytes: number): string {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error("file is not a regular file");
  if (stat.size > maxBytes) throw new Error("file exceeds the size cap");
  return readFileSync(file, "utf8");
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) process.exitCode = run(process.argv.slice(2));
