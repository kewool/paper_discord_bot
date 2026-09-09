import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { resetPapers, resetUser } from "../src/maintenance.js";
import {
  queueTranslations,
  retryTranslation,
  retranslatePapers,
  rerenderTranslations,
} from "../src/translation.js";
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
  } else if (command === "translations") {
    console.table(
      store.all(`SELECT p.id,p.title,t.status,t.completedPages AS readyPages,
      p.pageCount,t.model,t.version,t.attempts,t.error FROM papers p
      LEFT JOIN paperTranslations t ON t.paperId=p.id ORDER BY p.createdAt`),
    );
  } else if (command === "retry-translation" && id && args.length === 1) {
    if (!config.translation.enabled)
      throw new Error("TRANSLATION_ENABLED가 꺼져 있습니다.");
    queueTranslations(store, config);
    if (!retryTranslation(store, id))
      throw new Error(
        "대기 또는 실패 상태인 논문 ID를 지정해 주세요. 완료된 번역은 다시 생성하지 않습니다.",
      );
    console.log(
      "저장된 번역 페이지를 유지하고 남은 페이지부터 다시 처리합니다.",
    );
  } else if (command === "rerender-translations" && args.length === 0) {
    console.log(
      `번역 이미지 ${await rerenderTranslations(store, 1000, config)}쪽의 원문 배치와 글꼴을 갱신했습니다.`,
    );
  } else if (command === "retranslate" && id) {
    if (args.length > 2 || (args[1] && args[1] !== "--yes"))
      throw new Error(
        "사용법: node dist/scripts/admin.js retranslate <논문 ID|all> [--yes]",
      );
    const apply = args[1] === "--yes";
    console.table(retranslatePapers(store, config, id, apply));
    console.log(
      apply
        ? `전체 번역과 원문 대조를 다시 대기열에 넣었습니다. 모델: ${config.translation.model}`
        : "미리보기입니다. --yes를 붙이면 기존 번역을 교체합니다. 논문 원본·참여·점수는 유지합니다.",
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
    console.table(
      store.all(
        "SELECT status,COUNT(*) AS count,SUM(completedPages) AS readyPages FROM paperTranslations GROUP BY status",
      ),
    );
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
      "사용법: node dist/scripts/admin.js status | papers | translations | users | retry <제출 ID> | retry-translation <논문 ID> | rerender-translations | retranslate <논문 ID|all> [--yes] | reset-user <사용자 ID> [--yes] | reset-papers [--yes]",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "관리 작업 실패");
  process.exitCode = 1;
} finally {
  store.close();
}
