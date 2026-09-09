import { loadConfig, type Config } from "./config.js";
import { Store } from "./store.js";
import { League } from "./league.js";
import { createApp } from "./server.js";
import { startGradingWorker } from "./grader.js";
import { startBot } from "./bot.js";
import { startArxivWorker } from "./arxiv.js";
import { pathToFileURL } from "node:url";

export async function startApplication(config: Config) {
  if (!config.demo && !(config.discord.botToken && config.discord.clientId)) {
    throw new Error(
      ".env에 DISCORD_BOT_TOKEN과 DISCORD_CLIENT_ID를 설정해 주세요. 자동 공지가 필요한 서버만 /setup을 사용합니다. 로컬 체험은 npm run demo로 실행할 수 있습니다.",
    );
  }
  const store = new Store(config.dbPath);
  if (!config.demo)
    store.importLegacyGuild(
      config.discord.guildId,
      config.discord.channelId,
      config.discord.allowedRoleId,
    );
  const league = new League(store, config);
  const app = createApp(league, config);
  const server = await new Promise<ReturnType<typeof app.listen>>(
    (resolve, reject) => {
      const listening = app.listen(config.port, config.host, () =>
        resolve(listening),
      );
      listening.once("error", reject);
    },
  );
  const worker = startGradingWorker(league, config);
  const source = startArxivWorker(league, config);
  let bot;
  try {
    bot = await startBot(league, config);
  } catch (error) {
    await source.stop();
    await worker.stop();
    server.close();
    store.close();
    throw error;
  }
  console.log(
    `Paper League: ${config.publicUrl}${config.demo ? " [데모: 실제 Codex 평가 아님]" : ""}`,
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await bot.stop();
    await source.stop();
    await worker.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  return { server, store, league, stop };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startApplication(loadConfig()).catch((error) => {
    console.error(error instanceof Error ? error.message : "시작 실패");
    process.exitCode = 1;
  });
}
