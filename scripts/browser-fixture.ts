import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { seedDemo } from "./seed-demo.js";
import { startApplication } from "../src/main.js";
import { issueAccess } from "../src/auth.js";

await mkdir(resolve("work"), { recursive: true });
const dataDir = await mkdtemp(resolve("work", "browser-"));
const config = loadConfig({
  DEMO_MODE: "true",
  DATA_DIR: dataDir,
  PORT: "3117",
  PUBLIC_URL: "http://127.0.0.1:3117",
});
// Short durations apply only to this isolated browser test process.
config.readingMinutes = 0.2;
config.writingMinutes = 0.5;
const store = new Store(config.dbPath);
await seedDemo(store, dataDir);
store.close();
const application = await startApplication(config);
const invitation = issueAccess(application.league, {
  id: "423456789012345678",
  displayName: "브라우저 확인 참가자",
});
await writeFile(
  resolve("work/browser-invite.json"),
  JSON.stringify(invitation),
);
