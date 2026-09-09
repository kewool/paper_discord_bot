import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { importPaper } from "../src/papers.js";
import { Store } from "../src/store.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      title: { type: "string" },
      authors: { type: "string" },
      source: { type: "string" },
      license: { type: "string" },
    },
  });
  const required = ["file", "title", "authors", "source", "license"] as const;
  for (const key of required)
    if (!values[key]?.trim()) throw new Error(`--${key} 값을 입력해 주세요.`);
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const paper = await importPaper(
      values.file!,
      {
        title: values.title!,
        authors: values.authors!,
        sourceUrl: values.source!,
        license: values.license!,
      },
      config.dataDir,
    );
    store.addPaper(paper);
    console.log(`논문을 가져왔습니다: ${paper.id} (${paper.pageCount}쪽)`);
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `논문 가져오기에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
