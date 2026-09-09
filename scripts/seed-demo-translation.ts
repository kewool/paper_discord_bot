import { randomUUID } from "node:crypto";
import type { Store } from "../src/store.js";
import { saveTranslationPage } from "../src/translation.js";
import {
  TRANSLATION_VERSION,
  type PaperTranslation,
} from "../src/translation-types.js";

const pages = [
  [
    "목적과 설계",
    "이 자료는 Paper Reading League를 위해 제작한 데모 자료입니다. 출판된 연구가 아니며 실제 실험 결과를 보고하지 않습니다. 이 예시는 구조화된 읽기 노트가 학습자가 주장, 방법, 결과, 한계를 구별하는 데 도움이 되는지라는 교육적 질문을 제시합니다. 참가자가 근거에 주의하며 요약하는 연습을 할 수 있도록 가상의 읽기 세션 세 차례를 설명합니다.",
    "각 참가자에게 짧은 연구 형식의 글과 질문 네 가지가 적힌 노트지를 제공하는 교육 설계입니다. 질문은 연구의 동기가 된 문제, 관찰 방법, 주장을 뒷받침하는 결과, 여전히 불확실한 사항을 묻습니다. 기대하는 결과는 점수가 아니라, 독자가 자신의 말로 작성하며 근거를 추적할 수 있는 설명입니다.",
  ],
  [
    "방법과 예시 결과",
    "데모 절차에서는 가상의 참가자 열두 명이 제한시간 동안 동일한 세 페이지짜리 예시 자료를 읽습니다. 절반은 자유 형식으로 메모하고 나머지 절반은 질문 네 가지가 있는 노트지를 사용합니다. 진행자는 최종 요약에서 명시적인 근거와 한계가 나타나는지 비교합니다. 이 수치는 토론을 위해 만든 가상의 예시이며, 연구 결과로 인용해서는 안 됩니다.",
    "예시 비교는 구조화된 노트가 요약을 검토하기 쉽게 만들 수 있음을 시사합니다. 질문이 제공된 요약 여섯 개 중 다섯 개가 방법과 한계를 명시한 반면, 자유 형식 요약은 여섯 개 중 두 개가 이를 명시했습니다. 이 양상은 인과관계, 효과 또는 일반화 가능성을 입증하지 않습니다. 주의 깊은 독자가 매력적인 결론과 구별해야 할 근거가 어떤 것인지 보여 주는 예시일 뿐입니다.",
  ],
  [
    "해석과 한계",
    "이 예시가 뒷받침하는 교훈은 제한적입니다. 유용한 읽기 요약은 주장을 관련 관찰과 연결하고, 그 관찰로 무엇을 밝힐 수 없는지 명시합니다. 권위에 기대어 결과를 받아들이도록 요구하지 않습니다. 독자는 가상의 측정 방식이 적절한지, 두 집단을 비교할 수 있는지, 더 강한 권고를 하기 위해 어떤 정보가 필요한지 논의할 수 있습니다.",
    "여러 한계는 의도적으로 설정했습니다. 참가자, 세션, 측정치, 결과는 모두 가상입니다. 통계적 추론, 사전등록, 동료심사, 외부 재현 연구는 없습니다. 따라서 이 자료는 연구 내용을 전달하는 연습에만 적합합니다. 향후 실제 연구에서 교육적 주장을 하려면 모집단을 정의하고 투명한 측정 방식, 윤리적 절차, 독립적으로 수집한 자료를 갖춰야 합니다.",
  ],
] as const;

export async function seedDemoTranslation(store: Store) {
  const paper = store.getPaper("demo-reading-study");
  if (!paper?.demo)
    throw new Error("데모 논문만 예시 번역을 만들 수 있습니다.");
  store.run(
    "INSERT OR IGNORE INTO paperTranslations(paperId,model,version,updatedAt) VALUES(?,?,?,?)",
    paper.id,
    "demo-fixture",
    TRANSLATION_VERSION,
    Date.now(),
  );
  for (;;) {
    const row = store.get<PaperTranslation>(
      "SELECT * FROM paperTranslations WHERE paperId=?",
      paper.id,
    )!;
    if (row.status === "ready") return;
    const index = row.completedPages;
    const leaseOwner = randomUUID();
    store.run(
      "UPDATE paperTranslations SET leaseOwner=?,status='translating' WHERE paperId=?",
      leaseOwner,
      paper.id,
    );
    await saveTranslationPage(store, { ...row, leaseOwner }, paper, {
      page: index + 1,
      complete: true,
      glossary: [],
      blocks: pages[index].map((text, i) => ({
        kind: i === 0 ? "heading" : "paragraph",
        text,
        rows: [],
      })),
    });
  }
}
