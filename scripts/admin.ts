import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

const [command = "status", id] = process.argv.slice(2);
const config = loadConfig();
const store = new Store(config.dbPath);
try {
  if (command === "papers") {
    console.table(
      store.all(
        "SELECT id,title,pageCount,demo FROM papers ORDER BY createdAt",
      ),
    );
  } else if (command === "status") {
    console.table(store.all("SELECT * FROM syncState"));
    console.table(
      store.all(
        "SELECT status,COUNT(*) AS count FROM arxivImports GROUP BY status",
      ),
    );
    console.table(
      store.all(
        "SELECT gradingStatus,COUNT(*) AS count FROM attempts GROUP BY gradingStatus",
      ),
    );
    console.table(
      store.all(
        "SELECT id,roundId,gradingAttempts,error FROM attempts WHERE gradingStatus='failed' ORDER BY submittedAt",
      ),
    );
  } else if (command === "retry" && id) {
    const result = store.run(
      "UPDATE attempts SET gradingStatus='queued',gradingAttempts=0,nextGradeAt=0,error=NULL WHERE id=? AND gradingStatus='failed'",
      id,
    );
    if (!result.changes)
      throw new Error(
        "실패 상태인 제출 ID를 지정해 주세요. 이미 채점된 제출은 변경할 수 없습니다.",
      );
    console.log(
      "원래 제출 내용을 다시 채점하도록 대기열에 넣었습니다. 실행 중인 봇이 처리합니다.",
    );
  } else
    throw new Error(
      "사용법: npm run admin -- status | papers | retry <제출 ID>",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "관리 작업 실패");
  process.exitCode = 1;
} finally {
  store.close();
}
