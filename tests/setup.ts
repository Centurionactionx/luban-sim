import { join } from "node:path";

process.env.LUBAN_DATABASE_PATH = join(
  process.cwd(),
  "data",
  "luban.test.sqlite",
);
