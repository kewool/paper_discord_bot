import {
  ApplicationIntegrationType,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Interaction,
  type SlashCommandOptionsOnlyBuilder,
  type TextChannel,
} from "discord.js";
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { issueAccess } from "./auth.js";
import { AppError, League } from "./league.js";
import {
  RUBRIC,
  type Grade,
  type GuildSettings,
  type Round,
  type User,
} from "./types.js";

const guildCommand = <
  T extends SlashCommandBuilder | SlashCommandOptionsOnlyBuilder,
>(
  command: T,
) =>
  command
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

export function makeCommands(): Array<
  SlashCommandBuilder | SlashCommandOptionsOnlyBuilder
> {
  return [
    guildCommand(
      new SlashCommandBuilder()
        .setName("paper")
        .setDescription("오늘의 논문 읽기를 시작할 웹 페이지를 엽니다."),
    ),
    guildCommand(
      new SlashCommandBuilder()
        .setName("submit")
        .setDescription(
          "열람이 끝난 논문의 정리를 디스코드 작성 창에서 제출합니다.",
        ),
    ),
    guildCommand(
      new SlashCommandBuilder()
        .setName("ranking")
        .setDescription("전체 서버의 오늘 또는 최근 7일 순위를 봅니다.")
        .addStringOption((option) =>
          option
            .setName("period")
            .setDescription("순위 기간")
            .setRequired(false)
            .addChoices(
              { name: "오늘", value: "today" },
              { name: "최근 7일", value: "week" },
            ),
        ),
    ),
    guildCommand(
      new SlashCommandBuilder()
        .setName("my-score")
        .setDescription("오늘 나의 읽기·제출 상태와 점수를 봅니다."),
    ),
    guildCommand(
      new SlashCommandBuilder()
        .setName("setup")
        .setDescription("이 서버의 Paper League 공지와 참가 역할을 설정합니다.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("매일 논문 공지를 보낼 텍스트 또는 공지 채널")
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        )
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("참가 역할입니다. 생략하면 역할 제한을 해제합니다.")
            .setRequired(false),
        ),
    ),
  ];
}

export const commands = makeCommands().map((command) => command.toJSON());

const noMentions = { parse: [] as never[] };
const markerFor = (round: Round) => `paper-league:${round.id}`;
const safeName = (name: string) =>
  name
    .replace(/@/g, "@\u200b")
    .replace(/[\\*_`~|[\]()<>#]/g, "\\$&")
    .slice(0, 100);
const unix = (millis: number) => Math.floor(millis / 1000);

function replyOptions(content: string) {
  return { content, allowedMentions: noMentions };
}

function isAllowed(interaction: Interaction, settings: GuildSettings): boolean {
  if (!settings.allowedRoleId || settings.allowedRoleId === settings.guildId)
    return true;
  const roles = interaction.member?.roles;
  return Boolean(
    roles &&
    (Array.isArray(roles)
      ? roles.includes(settings.allowedRoleId)
      : roles.cache.has(settings.allowedRoleId)),
  );
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  league: League,
): Promise<void> {
  if (interaction.commandName === "paper") {
    await sendPaperLink(interaction, league);
    return;
  }
  if (interaction.commandName === "ranking") {
    const period =
      interaction.options.getString("period") === "week" ? "week" : "today";
    const entries = league
      .leaderboard(period, interaction.user.id)
      .slice(0, 10);
    const title =
      period === "week"
        ? "전체 서버 · 최근 7일 순위"
        : "전체 서버 · 오늘의 순위";
    const description = entries.length
      ? entries
          .map(
            (entry) =>
              `${entry.rank}. ${safeName(entry.displayName)} — ${entry.score}점 (${entry.count}회)`,
          )
          .join("\n")
      : "아직 채점된 기록이 없습니다.";
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x315c8c)
          .setTitle(title)
          .setDescription(description),
      ],
      allowedMentions: noMentions,
    });
    return;
  }
  if (interaction.commandName === "my-score") {
    const attempt = league.currentAttempt(interaction.user.id);
    if (!attempt) {
      await interaction.editReply(
        replyOptions(
          "오늘은 아직 읽기 세션을 시작하지 않았습니다. 웹에서 시작해 주세요.",
        ),
      );
      return;
    }
    const view = league.view(attempt);
    if (view.phase === "graded" && view.grade) {
      const grade = view.grade;
      const embed = new EmbedBuilder()
        .setColor(0x315c8c)
        .setTitle(
          `오늘의 평가 · ${grade.total}/100점${grade.demo ? " (데모 예시)" : ""}`,
        )
        .setDescription(feedbackPreview(grade.overall, 1000))
        .addFields(
          ...RUBRIC.map((criterion) => {
            const value = grade.criteria.find(
              (item) => item.key === criterion.key,
            )!;
            return {
              name: `${criterion.label} · ${value.score}/${criterion.max}점`,
              value: feedbackPreview(value.feedback, 600),
            };
          }),
        )
        .addFields(
          {
            name: "잘한 점",
            value: feedbackPreview(grade.strengths.join("\n"), 650),
          },
          {
            name: "다음에 시도할 점",
            value: feedbackPreview(grade.improvements.join("\n"), 650),
          },
        )
        .setFooter({
          text: "전체 피드백은 첨부 파일, 전체 서버 순위는 /ranking에서 확인하실 수 있습니다.",
        });
      await interaction.editReply({
        embeds: [embed],
        files: [
          new AttachmentBuilder(Buffer.from(gradeReport(grade), "utf8"), {
            name: `paper-league-${attempt.roundId}-feedback.txt`,
          }),
        ],
        allowedMentions: noMentions,
      });
      return;
    }
    const statuses = {
      reading: "읽기 중",
      writing: "작성 중",
      queued: "채점 대기",
      grading: "채점 중",
      failed: "채점 실패",
      expired: "제출 마감",
    };
    const instruction =
      view.phase === "reading"
        ? `열람 종료: <t:${unix(view.readingEndsAt)}:R>\n열람이 끝나면 /submit으로 정리를 제출해 주세요.`
        : view.phase === "writing"
          ? `제출 마감: <t:${unix(view.submitBy)}:R>\n/submit으로 정리를 작성해 주세요. 작성 창을 열어도 마감 시간은 연장되지 않습니다.`
          : view.phase === "failed"
            ? "채점을 완료하지 못했습니다. 제출은 저장되어 있으며 운영자가 재시도할 수 있습니다."
            : view.phase === "expired"
              ? "오늘의 제출 시간이 종료되었습니다."
              : "제출을 접수했습니다. 잠시 후 /my-score에서 확인해 주세요.";
    const content = `현재 상태: **${statuses[view.phase as keyof typeof statuses] || "채점 완료"}**\n${instruction}`;
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x315c8c)
          .setTitle("나의 오늘 기록")
          .setDescription(content),
      ],
      allowedMentions: noMentions,
    });
  }
}

async function sendPaperLink(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  league: League,
): Promise<void> {
  const user: User = {
    id: interaction.user.id,
    displayName: interaction.user.globalName || interaction.user.username,
  };
  const access = issueAccess(
    league,
    user,
    interaction.guildId || "",
    interaction.channelId || "",
  );
  const expiresAt = Math.floor(access.expiresAt / 1000);
  const embed = new EmbedBuilder()
    .setColor(0x315c8c)
    .setTitle("오늘의 논문 읽기")
    .setDescription(
      `전용 링크가 발급되었습니다. 링크는 <t:${expiresAt}:R> 만료되며 한 번만 사용할 수 있습니다. 다시 발급해도 기존 읽기 타이머는 초기화되지 않습니다.\n웹에서는 논문만 읽고, 열람 종료 후 디스코드 /submit으로 정리를 제출해 주세요.`,
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("웹에서 시작하기")
      .setStyle(ButtonStyle.Link)
      .setURL(access.url),
  );
  await interaction.editReply({
    embeds: [embed],
    components: [row],
    allowedMentions: noMentions,
  });
}

const submitPrefix = "paper:submit:";
const summaryFields = [
  {
    id: "problem",
    label: "문제와 핵심 기여",
    prompt: "어떤 문제를 해결하며 무엇을 새롭게 제안했나요?",
  },
  {
    id: "method",
    label: "방법론",
    prompt: "핵심 방법과 실험 설계를 설명해 주세요.",
  },
  {
    id: "findings",
    label: "결과와 근거",
    prompt: "주요 결과를 비교 대상과 근거에 연결해 주세요.",
  },
  {
    id: "limits",
    label: "한계와 비판",
    prompt: "확인하지 못한 점, 한계와 대안 설명은 무엇인가요?",
  },
  {
    id: "synthesis",
    label: "나의 종합",
    prompt: "이 논문에서 얻은 이해와 자신의 생각을 정리해 주세요.",
  },
] as const;

function feedbackPreview(text: string, limit: number): string {
  const safe = escapeMarkdown(text).replace(/@/g, "@\u200b");
  return safe.length > limit ? `${safe.slice(0, limit - 1)}…` : safe;
}

function gradeReport(grade: Grade): string {
  return [
    `Paper League · ${grade.total}/100점${grade.demo ? " · 데모 예시 평가" : ""}`,
    grade.overall,
    ...RUBRIC.map((criterion) => {
      const value = grade.criteria.find((item) => item.key === criterion.key)!;
      return `${criterion.label} · ${value.score}/${criterion.max}점\n${value.feedback}`;
    }),
    `잘한 점\n${grade.strengths.join("\n")}`,
    `다음에 시도할 점\n${grade.improvements.join("\n")}`,
  ].join("\n\n");
}

function canManageGuild(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
}

function canUseAnnouncementChannel(
  channel: TextChannel,
  client: Client,
): boolean {
  const user = client.user;
  if (!user) return false;
  const permissions = channel.permissionsFor(user);
  return Boolean(
    permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
    ]),
  );
}

async function setupGuild(
  interaction: ChatInputCommandInteraction,
  league: League,
): Promise<void> {
  if (!canManageGuild(interaction))
    throw new AppError(
      403,
      "이 명령은 서버 관리 권한이 있는 분만 사용할 수 있습니다.",
    );
  const selected = interaction.options.getChannel("channel", true);
  const channel = await interaction.client.channels.fetch(selected.id);
  if (
    !channel ||
    !("guildId" in channel) ||
    channel.guildId !== interaction.guildId ||
    !isSendableTextChannel(channel) ||
    !canUseAnnouncementChannel(channel, interaction.client)
  ) {
    throw new AppError(
      422,
      "선택한 채널에서 봇의 채널 보기, 메시지 보내기, 임베드 링크, 파일 첨부, 메시지 기록 보기 권한을 확인해 주세요.",
    );
  }
  const role = interaction.options.getRole("role");
  league.store.saveGuildSettings(
    interaction.guildId!,
    channel.id,
    role?.id || "",
    league.now(),
  );
  await interaction.editReply(
    replyOptions(
      role
        ? `이 서버의 공지 채널을 <#${channel.id}>로 설정했고, <@&${role.id}> 역할에만 참가를 허용했습니다.`
        : `이 서버의 공지 채널을 <#${channel.id}>로 설정했고, 참가 역할 제한을 해제했습니다. /setup에서 역할을 생략하면 언제든 제한을 해제할 수 있습니다.`,
    ),
  );
}

export async function handleInteraction(
  interaction: Interaction,
  league: League,
  config: Config,
): Promise<void> {
  if (!interaction.inGuild()) return;
  if (
    !interaction.isChatInputCommand() &&
    !interaction.isButton() &&
    !interaction.isModalSubmit()
  )
    return;
  const recognized = interaction.isChatInputCommand()
    ? ["paper", "submit", "ranking", "my-score", "setup"].includes(
        interaction.commandName,
      )
    : interaction.isButton()
      ? interaction.customId === "paper:link"
      : interaction.customId.startsWith(submitPrefix);
  if (!recognized) return;
  try {
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "setup"
    ) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await setupGuild(interaction, league);
      return;
    }
    const settings = league.store.getGuildSettings(interaction.guildId!);
    if (settings && !isAllowed(interaction, settings))
      throw new AppError(
        403,
        "이 서버의 참가 역할이 있어야 사용할 수 있습니다.",
      );
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "submit"
    ) {
      const attempt = league.submissionTarget(interaction.user.id);
      const deadline = new Intl.DateTimeFormat("ko-KR", {
        timeZone: config.timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(attempt.submitBy);
      const modal = new ModalBuilder()
        .setCustomId(`${submitPrefix}${attempt.id}`)
        .setTitle("오늘의 논문 정리 제출")
        .addLabelComponents(
          ...summaryFields.map((field, index) =>
            new LabelBuilder()
              .setLabel(field.label)
              .setDescription(
                index === 0
                  ? `마감 ${deadline} (${config.timeZone}). 제출문은 Codex로 평가합니다. 각 항목 30~2,300자.`
                  : field.prompt,
              )
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId(field.id)
                  .setStyle(TextInputStyle.Paragraph)
                  .setMinLength(30)
                  .setMaxLength(2300)
                  .setRequired(true)
                  .setPlaceholder(field.prompt),
              ),
          ),
        );
      // A modal must be the initial interaction response, before any defer.
      await interaction.showModal(modal);
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.isModalSubmit()) {
      const parts = summaryFields.map((field) => {
        const value = interaction.fields.getTextInputValue(field.id).trim();
        if (value.length < 30 || value.length > 2300)
          throw new AppError(
            422,
            `${field.label} 항목을 30~2,300자로 작성해 주세요.`,
          );
        return `${field.label}\n${value}`;
      });
      league.submit(
        interaction.user.id,
        parts.join("\n\n"),
        interaction.customId.slice(submitPrefix.length),
      );
      await interaction.editReply(
        replyOptions(
          "정리를 접수했습니다. 한 번 제출한 내용은 수정할 수 없습니다.\n채점 결과와 항목별 피드백은 /my-score, 전체 서버 순위는 /ranking에서 확인해 주세요.",
        ),
      );
    } else if (interaction.isChatInputCommand()) {
      await handleCommand(interaction, league);
    } else {
      await sendPaperLink(interaction, league);
    }
  } catch (error) {
    if (!(error instanceof AppError))
      console.error(
        "[discord interaction failed]",
        error instanceof Error ? error.name : "unknown",
      );
    const content =
      error instanceof AppError
        ? error.message
        : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    try {
      if (interaction.deferred || interaction.replied)
        await interaction.editReply(replyOptions(content));
      else
        await interaction.reply({
          ...replyOptions(content),
          flags: MessageFlags.Ephemeral,
        });
    } catch (replyError) {
      console.error(
        "[discord interaction recovery failed]",
        replyError instanceof Error ? replyError.name : "unknown",
      );
    }
  }
}

function isSendableTextChannel(channel: unknown): channel is TextChannel {
  if (!channel || typeof channel !== "object") return false;
  const candidate = channel as TextChannel;
  return (
    (candidate.type === ChannelType.GuildText ||
      candidate.type === ChannelType.GuildAnnouncement) &&
    candidate.isTextBased() &&
    candidate.isSendable()
  );
}

function claimAnnouncement(
  league: League,
  settings: GuildSettings,
  round: Round,
  now: number,
): boolean {
  return league.store.transaction(() => {
    const existing = league.store.get<{ status: string; updatedAt: number }>(
      "SELECT status,updatedAt FROM guildAnnouncements WHERE guildId=? AND roundId=? AND channelId=?",
      settings.guildId,
      round.id,
      settings.channelId,
    );
    if (existing?.status === "sent") return false;
    if (
      existing?.status === "sending" &&
      now - existing.updatedAt <= 5 * 60_000
    )
      return false;
    league.store.run(
      `INSERT INTO guildAnnouncements(guildId,roundId,channelId,status,updatedAt,messageId) VALUES (?,?,?,?,?,NULL)
      ON CONFLICT(guildId,roundId,channelId) DO UPDATE SET status='sending',updatedAt=excluded.updatedAt,messageId=NULL`,
      settings.guildId,
      round.id,
      settings.channelId,
      "sending",
      now,
    );
    return true;
  });
}

const announcementNonce = (settings: GuildSettings, round: Round) =>
  createHash("sha256")
    .update(`${round.id}:${settings.guildId}:${settings.channelId}`)
    .digest("base64url")
    .slice(0, 24);

async function announceToGuild(
  league: League,
  client: Client,
  settings: GuildSettings,
  round: Round,
  shouldStop: () => boolean,
): Promise<void> {
  if (shouldStop() || !client.guilds.cache.has(settings.guildId)) return;
  const channel = await client.channels.fetch(settings.channelId);
  if (
    !channel ||
    !("guildId" in channel) ||
    channel.guildId !== settings.guildId ||
    !isSendableTextChannel(channel) ||
    !canUseAnnouncementChannel(channel, client)
  )
    return;
  const now = league.now();
  if (!claimAnnouncement(league, settings, round, now)) return;
  try {
    if (shouldStop() || league.now() >= round.closesAt)
      throw new Error("stopped");
    const marker = markerFor(round);
    const messages = await channel.messages.fetch({ limit: 100 });
    const prior = messages.find(
      (message) =>
        message.author.id === client.user?.id &&
        message.embeds.some((embed) => embed.footer?.text === marker),
    );
    if (prior) {
      league.store.run(
        "UPDATE guildAnnouncements SET status='sent',updatedAt=?,messageId=? WHERE guildId=? AND roundId=? AND channelId=?",
        league.now(),
        prior.id,
        settings.guildId,
        round.id,
        settings.channelId,
      );
      return;
    }
    if (shouldStop() || league.now() >= round.closesAt)
      throw new Error("stopped");
    const embed = new EmbedBuilder()
      .setColor(0x315c8c)
      .setTitle("오늘의 논문 읽기")
      .setDescription(
        `오늘의 논문이 열렸습니다. 웹에서 읽고 디스코드 /submit으로 정리를 제출해 주세요.\n읽기 ${round.readingMinutes}분 · 작성 ${round.writingMinutes}분 · <t:${unix(round.closesAt)}:R> 마감`,
      )
      .setFooter({ text: marker });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("paper:link")
        .setLabel("내 전용 링크 받기")
        .setStyle(ButtonStyle.Primary),
    );
    const message = await channel.send({
      embeds: [embed],
      components: [row],
      allowedMentions: noMentions,
      nonce: announcementNonce(settings, round),
      enforceNonce: true,
    });
    league.store.run(
      "UPDATE guildAnnouncements SET status='sent',updatedAt=?,messageId=? WHERE guildId=? AND roundId=? AND channelId=?",
      league.now(),
      message.id,
      settings.guildId,
      round.id,
      settings.channelId,
    );
  } catch (error) {
    league.store.run(
      "UPDATE guildAnnouncements SET status='pending',updatedAt=?,messageId=NULL WHERE guildId=? AND roundId=? AND channelId=?",
      league.now(),
      settings.guildId,
      round.id,
      settings.channelId,
    );
    if (!shouldStop())
      console.error(
        "[discord announcement failed]",
        error instanceof Error ? error.name : "unknown",
      );
  }
}

/** Announces the shared daily round once to every configured server. */
export async function announceDaily(
  league: League,
  client: Client,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const round = league.ensureRound();
  if (!round || league.now() < round.opensAt || shouldStop()) return;
  for (const settings of league.store.listGuildSettings()) {
    if (shouldStop()) return;
    try {
      await announceToGuild(league, client, settings, round, shouldStop);
    } catch (error) {
      console.error(
        "[discord announcement failed]",
        error instanceof Error ? error.name : "unknown",
      );
    }
  }
}

export async function startBot(
  league: League,
  config: Config,
): Promise<{ stop: () => Promise<void> }> {
  if (config.demo || !config.discord.botToken)
    return { stop: async () => undefined };
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let stopped = false;
  let inFlightTick: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      await announceDaily(league, client, () => stopped);
    } catch (error) {
      console.error(
        "[discord announcement failed]",
        error instanceof Error ? error.name : "unknown",
      );
    } finally {
      ticking = false;
    }
  };
  const triggerTick = (): Promise<void> | undefined => {
    if (stopped || ticking) return inFlightTick;
    inFlightTick = tick().finally(() => {
      inFlightTick = undefined;
    });
    return inFlightTick;
  };
  client.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction, league, config);
  });
  client.once("clientReady", async () => {
    if (stopped) return;
    await triggerTick();
    if (!stopped)
      timer = setInterval(() => {
        void triggerTick();
      }, 60_000);
  });
  try {
    await client.login(config.discord.botToken);
  } catch (error) {
    client.destroy();
    throw new Error(
      `Discord 봇 로그인에 실패했습니다: ${error instanceof Error ? error.name : "알 수 없는 오류"}`,
    );
  }
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlightTick;
      client.destroy();
    },
  };
}
