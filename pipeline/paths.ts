import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved relative to this file so the CLI works from any cwd. */
export const ROOT = path.resolve(here, "..");

export const PATHS = {
  root: ROOT,
  rawDir: path.join(ROOT, "raw"),
  rawHtml: path.join(ROOT, "raw", "latest.html"),
  dataDir: path.join(ROOT, "data"),
  quizzes: path.join(ROOT, "data", "quizzes.json"),
  overrides: path.join(ROOT, "data", "overrides.json"),
  geocache: path.join(ROOT, "data", "geocache.json"),
  /** Official kommune register, fetched once and committed. */
  kommuner: path.join(ROOT, "data", "kommuner.json"),
  /** Source place name -> official kommune. Auto-resolved entries plus hand curation. */
  kommuneAlias: path.join(ROOT, "data", "kommune-alias.json"),
} as const;

export const SOURCE_URL =
  "https://www.norgesquizforbund.no/arrangementer/finn-din-pubquiz/";

export const USER_AGENT =
  "quizkveld/1.0 (+https://github.com/verdensherredomme/quizkveld; kontakt via GitHub issues)";
