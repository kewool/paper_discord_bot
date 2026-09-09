import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { League } from "../src/league.js";
import { gradePaper } from "../src/grader.js";
import { seedDemo } from "./seed-demo.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const config = loadConfig({
  ...process.env,
  DEMO_MODE: "true",
  NODE_ENV: "development",
  DATA_DIR: "work/grade-smoke",
  PUBLIC_URL: "http://localhost:3000",
});
const store = new Store(config.dbPath);
try {
  await seedDemo(store, config.dataDir);
  const league = new League(store, config);
  const round = league.ensureRound()!;
  const paper = store.getPaper(round.paperId)!;
  console.log(`실제 Codex SDK 평가 확인을 시작합니다. 모델: ${round.model}`);
  const summary =
    "이 예시 연구는 논문을 읽은 뒤 짧은 회상 노트를 작성하는 학습 방법을 다룹니다. 단순히 읽기만 하는 조건과 읽은 내용을 스스로 설명하는 조건을 비교합니다. 중요한 것은 글의 길이가 아니라 문제와 방법, 실제 결과의 근거를 구분해 기억하는 능력입니다. 다만 작은 표본에서 관찰한 결과를 모든 학습자에게 일반화하기 어렵고, 연구 기간이나 사전 지식 등 교란요인을 따로 검토해야 합니다. 실제 수치를 정확히 기억하지 못해 효과의 크기를 단정할 수 없습니다.";
  const grade = await gradePaper(paper, summary, round, config);
  await mkdir(resolve("work"), { recursive: true });
  await writeFile(
    resolve("work/grade-smoke-result.json"),
    JSON.stringify({ checkedAt: new Date().toISOString(), grade }, null, 2),
  );
  console.log(
    JSON.stringify({
      realCodex: !grade.demo,
      model: grade.model,
      score: grade.total,
      criteria: grade.criteria.length,
    }),
  );
} catch (error) {
  // This administrator-only diagnostic redacts long CLI traces and never prints credentials or environment values.
  const message = error instanceof Error ? error.message : "UnknownError";
  console.error(message.slice(0, 2500));
  process.exitCode = 1;
} finally {
  store.close();
}
