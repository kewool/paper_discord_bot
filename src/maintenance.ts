import { rmSync } from "node:fs";
import { parse, resolve } from "node:path";
import type { Store } from "./store.js";

type ResetCount = { table: string; rows: number };

export function resetUser(store: Store, userId: string, apply = false) {
  if (!/^\d{17,20}$/.test(userId))
    throw new Error("Discord 숫자 사용자 ID를 지정해 주세요.");
  return store.transaction(() => {
    const user = store.get<{ id: string; displayName: string }>(
      "SELECT id,displayName FROM users WHERE id=?",
      userId,
    );
    if (!user)
      throw new Error(
        "등록된 사용자가 없습니다. users 명령으로 ID를 확인해 주세요.",
      );
    const counts: ResetCount[] = [];
    for (const table of ["sessions", "accessTokens", "attempts", "users"]) {
      const column = table === "users" ? "id" : "userId";
      const rows = store.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`,
        userId,
      )!.count;
      counts.push({ table, rows });
      if (apply) store.run(`DELETE FROM ${table} WHERE ${column}=?`, userId);
    }
    return { user, counts };
  });
}

export function resetPapers(store: Store, dataDir: string, apply = false) {
  const root = resolve(dataDir);
  const database = store
    .all<{ name: string; file: string }>("PRAGMA database_list")
    .find((entry) => entry.name === "main");
  if (
    root === parse(root).root ||
    !database?.file ||
    resolve(database.file) !== resolve(root, "league.sqlite")
  )
    throw new Error("논문 DB와 DATA_DIR 경로가 일치하지 않습니다.");
  const directories = ["papers", "import-work"].map((name) =>
    resolve(root, name),
  );
  const counts = store.transaction(() => {
    const result: ResetCount[] = [];
    for (const table of [
      "sessions",
      "accessTokens",
      "attempts",
      "announcements",
      "guildAnnouncements",
      "rounds",
      "arxivImports",
      "translatedPages",
      "paperTranslations",
      "papers",
      "syncState",
      "sourceLocks",
    ]) {
      const where = ["syncState", "sourceLocks"].includes(table)
        ? " WHERE name='arxiv'"
        : "";
      const rows = store.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table}${where}`,
      )!.count;
      result.push({ table, rows });
      if (apply) store.run(`DELETE FROM ${table}${where}`);
    }
    return result;
  });
  if (apply) {
    for (const directory of directories) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        throw new Error(
          `DB 초기화는 완료됐지만 파일 삭제에 실패했습니다: ${directory}`,
          { cause: error },
        );
      }
    }
  }
  return { counts, directories };
}
