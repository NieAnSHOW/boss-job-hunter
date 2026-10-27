import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

try {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: node init.mjs [--data-dir <directory>]\nCreates config.json without overwriting an existing file.\nDefault: BOSS_JOB_HUNTER_HOME or ~/.boss-job-hunter");
  } else {
    if (args.length && (args.length !== 2 || args[0] !== "--data-dir" || !args[1] || args[1].startsWith("--"))) {
      throw new Error("Usage: node init.mjs [--data-dir <directory>]");
    }
    const dir = path.resolve(args[1] || process.env.BOSS_JOB_HUNTER_HOME || path.join(os.homedir(), ".boss-job-hunter"));
    const config = path.join(dir, "config.json");
    const example = await readFile(new URL("../assets/config.example.json", import.meta.url), "utf8");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let created = true;
    try {
      await writeFile(config, example, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      created = false;
    }
    console.log(JSON.stringify({ ok: true, created, config }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
