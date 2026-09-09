import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { seedDemo } from "./seed-demo.js";
import { seedDemoTranslation } from "./seed-demo-translation.js";
import { startApplication } from "../src/main.js";
import { issueAccess } from "../src/auth.js";
import { rerenderTranslations } from "../src/translation.js";

await mkdir(resolve("work"), { recursive: true });
const dataDir = await mkdtemp(resolve("work", "browser-"));
const config = loadConfig({
  DEMO_MODE: "true",
  TRANSLATION_ENABLED: "true",
  DATA_DIR: dataDir,
  PORT: "3117",
  PUBLIC_URL: "http://127.0.0.1:3117",
});
// Short durations apply only to this isolated browser test process.
config.readingMinutes = 0.4;
config.writingMinutes = 0.5;
const store = new Store(config.dbPath);
await seedDemo(store, dataDir);
await seedDemoTranslation(store);
const translated = store.get<{ contentJson: string }>(
  "SELECT contentJson FROM translatedPages WHERE paperId=? AND page=2",
  "demo-reading-study",
)!;
const pageTwo = JSON.parse(translated.contentJson) as {
  blocks: Array<{ kind: string; text: string }>;
};
const paragraph = pageTwo.blocks.find((block) => block.kind === "paragraph")!;
paragraph.text = `${paragraph.text} `.repeat(20);
store.run(
  "UPDATE translatedPages SET contentJson=?,renderVersion=1 WHERE paperId=? AND page=2",
  JSON.stringify(pageTwo),
  "demo-reading-study",
);
await rerenderTranslations(store);
store.close();
const application = await startApplication(config);
const invitation = issueAccess(
  application.league,
  {
    id: "423456789012345678",
    displayName: "브라우저 확인 참가자",
  },
  "700000000000000001",
  "710000000000000001",
);
await writeFile(
  resolve("work/browser-invite.json"),
  JSON.stringify(invitation),
);
