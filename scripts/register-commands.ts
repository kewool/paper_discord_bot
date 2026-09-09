import { REST, Routes } from "discord.js";
import { loadConfig } from "../src/config.js";
import { makeCommands } from "../src/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { botToken, clientId } = config.discord;
  if (!botToken || !clientId)
    throw new Error("DISCORD_BOT_TOKEN과 DISCORD_CLIENT_ID가 필요합니다.");
  const rest = new REST({ version: "10" }).setToken(botToken);
  const body = makeCommands().map((command) => command.toJSON());
  await rest.put(Routes.applicationCommands(clientId), { body });
  console.log(`전역 명령어 ${body.length}개를 등록했습니다.`);
}

main().catch((error: unknown) => {
  console.error(
    `명령어 등록에 실패했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
  );
  process.exitCode = 1;
});
