import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { League } from "../src/league.js";
import { Store } from "../src/store.js";
import { syncArxiv } from "../src/arxiv.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { count: { type: "string", default: "2" } },
  });
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 5)
    throw new Error("--count는 1~5 정수여야 합니다.");
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const league = new League(store, config);
  try {
    const result = await syncArxiv(league, config, { force: true, count });
    console.log(
      `arXiv 동기화 완료: 가져옴 ${result.imported}건, 건너뜀 ${result.skipped}건${result.cached ? " (캐시)" : ""}`,
    );
  } finally {
    store.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    `arXiv 동기화 실패: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
