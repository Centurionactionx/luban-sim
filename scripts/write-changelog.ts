/**
 * Rewrites CHANGELOG.md from lib/changelog.ts. Run with `pnpm changelog`
 * after adding a release there.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderChangelogMarkdown } from "../lib/changelog";

const path = join(process.cwd(), "CHANGELOG.md");
writeFileSync(path, renderChangelogMarkdown());
console.log(`Wrote ${path}`);
