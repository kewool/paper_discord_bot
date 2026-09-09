import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { resetPapers, resetUser } from "../src/maintenance.js";
import {
  classifyPublication,
  type PublicationMetadata,
} from "../src/paper-selection.js";

const [command = "status", ...args] = process.argv.slice(2);
const id = args[0];
const config = loadConfig();
const store = new Store(config.dbPath);
try {
  if (command === "papers") {
    console.table(
      store
        .all<
          {
            id: string;
            title: string;
            pageCount: number;
            demo: number;
          } & PublicationMetadata
        >(
          `SELECT p.id,p.title,p.pageCount,p.demo,ai.journalRef,ai.comment FROM papers p
         LEFT JOIN arxivImports ai ON ai.arxivId=(
           SELECT arxivId FROM arxivImports WHERE paperId=p.id AND status='imported'
           ORDER BY updatedAt DESC LIMIT 1
         ) ORDER BY p.createdAt`,
        )
        .map(({ journalRef, comment, ...paper }) => {
          const publication = classifyPublication(
            { journalRef, comment },
            config.paperSelection.preferredVenues,
          );
          return {
            ...paper,
            publication: publication.tier,
            venue: publication.venue || "-",
            weight: config.paperSelection.weights[publication.tier],
          };
        }),
    );
  } else if (command === "users") {
    console.table(
      store.all(`SELECT u.id,u.displayName,COUNT(a.id) AS attempts
      FROM users u LEFT JOIN attempts a ON a.userId=u.id
      GROUP BY u.id ORDER BY u.displayName,u.id`),
    );
  } else if (command === "reset-user") {
    if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== "--yes"))
      throw new Error(
        "사용법: node dist/scripts/admin.js reset-user <사용자 ID> [--yes]",
      );
    const apply = args[1] === "--yes";
    const result = resetUser(store, id, apply);
    console.log(
      `${result.user.displayName} (${result.user.id}): 전체 서버의 참여·점수·열람 세션 및 사용자 정보`,
    );
    console.table(result.counts);
    console.log(
      apply
        ? "사용자 초기화 완료. 봇을 다시 켠 뒤 /paper로 새 링크를 받으세요."
        : "미리보기입니다. 봇을 중지한 뒤 같은 명령에 --yes를 붙이면 삭제합니다.",
    );
  } else if (command === "reset-papers") {
    if (args.length > 1 || (id && id !== "--yes"))
      throw new Error(
        "사용법: node dist/scripts/admin.js reset-papers [--yes]",
      );
    const apply = id === "--yes";
    const result = resetPapers(store, config.dataDir, apply);
    console.log(
      "모든 논문과 전체 서버의 라운드·참여·점수·열람 세션 및 arXiv 수집 기록",
    );
    console.table(result.counts);
    console.log("논문 파일 경로:", result.directories.join(", "));
    console.log(
      apply
        ? "논문 초기화 완료. 서버 설정·사용자 프로필·Codex 로그인은 유지됩니다. 봇 재시작 시 자동 수집합니다."
        : "미리보기입니다. 봇을 중지한 뒤 같은 명령에 --yes를 붙이면 삭제합니다.",
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
      "사용법: node dist/scripts/admin.js status | papers | users | retry <제출 ID> | reset-user <사용자 ID> [--yes] | reset-papers [--yes]",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "관리 작업 실패");
  process.exitCode = 1;
} finally {
  store.close();
}
