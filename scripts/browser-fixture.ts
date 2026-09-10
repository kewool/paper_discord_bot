import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { seedDemo } from "./seed-demo.js";
import { seedDemoTranslation } from "./seed-demo-translation.js";
import { startApplication } from "../src/main.js";
import { issueAccess } from "../src/auth.js";
import { rerenderTranslations } from "../src/translation.js";
import { renderTranslatedPdf } from "../src/pdf-document.js";

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
const paper = store.get<{ directory: string }>(
  "SELECT directory FROM papers WHERE id=?",
  "demo-reading-study",
)!;
const artifactId = randomUUID();
const v4Directory = resolve(paper.directory, "ko-v4", artifactId);
await mkdir(v4Directory, { recursive: true });
const v4PdfPath = resolve(v4Directory, "translated.pdf");
execFileSync(
  "python",
  [
    "-c",
    `import fitz, sys
doc = fitz.open()
for number in range(1, 5):
    page = doc.new_page(width=560, height=760)
    page.insert_font(fontname="nanum", fontfile=sys.argv[2])
    page.insert_text((56, 80), f"한국어 번역 문서 {number}", fontname="nanum", fontsize=22, color=(0.1, 0.15, 0.24))
doc.save(sys.argv[1])`,
    v4PdfPath,
    resolve("public/fonts/NanumGothic-Regular.ttf"),
  ],
  { stdio: "pipe" },
);
const v4Rendered = await renderTranslatedPdf(v4PdfPath, v4Directory);
store.transaction(() => {
  store.run(
    "DELETE FROM translatedPages WHERE paperId=?",
    "demo-reading-study",
  );
  for (let page = 1; page <= v4Rendered.pageCount; page += 1)
    store.run(
      `INSERT INTO translatedPages(paperId,page,contentJson,partCount,artifactId,createdAt,renderVersion)
       VALUES(?,?,?,?,?,?,?)`,
      "demo-reading-study",
      page,
      "{}",
      1,
      artifactId,
      Date.now(),
      3,
    );
  store.run(
    `UPDATE paperTranslations SET status='ready',version='ko-v4',completedPages=3,
     leaseOwner=NULL,leaseUntil=0,error=NULL,updatedAt=? WHERE paperId=?`,
    Date.now(),
    "demo-reading-study",
  );
});
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
