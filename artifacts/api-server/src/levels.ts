import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type VoiceState,
} from "discord.js";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, guildConfigs, levelRoleRewards, userProfiles } from "@workspace/db";
import { logger } from "./lib/logger";

const XP_DEFAULTS = {
  xpEnabled: true,
  xpPerMessage: 10,
  xpPerVoiceMinute: 5,
  xpMessageCooldownSeconds: 60,
  levelUpMessage: "¡Enhorabuena {user}! Has alcanzado el nivel **{level}**.",
  keepPreviousLevelRoles: true,
  levelUpChannelId: null as string | null,
};
const VOICE_XP_INTERVAL_MS = 60_000;
const VOICE_XP_BATCH_SIZE = 20;

type LevelSettings = typeof XP_DEFAULTS;
type LevelSettingsUpdate = Partial<
  Pick<
    typeof guildConfigs.$inferInsert,
    | "xpEnabled"
    | "xpPerMessage"
    | "xpPerVoiceMinute"
    | "xpMessageCooldownSeconds"
    | "levelUpMessage"
    | "keepPreviousLevelRoles"
    | "levelUpChannelId"
  >
>;

type VoiceXpSession = {
  guildId: string;
  channelId: string;
  userId: string;
  eligibleSince: number;
};

const voiceXpSessions = new Map<string, VoiceXpSession>();
let voiceXpInterval: ReturnType<typeof setInterval> | undefined;
let voiceXpTickInFlight = false;

const levelCommand = new SlashCommandBuilder()
  .setName("nivel")
  .setDescription("Consulta, administra y configura los niveles del servidor")
  .addSubcommand((subcommand) =>
    subcommand.setName("perfil").setDescription("Muestra tu nivel, XP y progreso"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("usuario")
      .setDescription("Muestra el nivel y progreso de otro miembro")
      .addUserOption((option) =>
        option.setName("usuario").setDescription("Miembro del servidor").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("ranking").setDescription("Muestra el ranking de niveles del servidor"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set")
      .setDescription("Establece manualmente el nivel de un miembro")
      .addUserOption((option) =>
        option.setName("usuario").setDescription("Miembro del servidor").setRequired(true),
      )
      .addIntegerOption((option) =>
        option.setName("nivel").setDescription("Nuevo nivel").setMinValue(1).setMaxValue(1_000_000).setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("xp")
      .setDescription("Añade XP a un miembro")
      .addUserOption((option) =>
        option.setName("usuario").setDescription("Miembro del servidor").setRequired(true),
      )
      .addIntegerOption((option) =>
        option.setName("cantidad").setDescription("XP que se añade").setMinValue(1).setMaxValue(2_000_000_000).setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("quitar-xp")
      .setDescription("Quita XP a un miembro")
      .addUserOption((option) =>
        option.setName("usuario").setDescription("Miembro del servidor").setRequired(true),
      )
      .addIntegerOption((option) =>
        option.setName("cantidad").setDescription("XP que se quita").setMinValue(1).setMaxValue(2_000_000_000).setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reset")
      .setDescription("Reinicia el nivel y la XP de un miembro")
      .addUserOption((option) =>
        option.setName("usuario").setDescription("Miembro del servidor").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("rol")
      .setDescription("Configura el rol que se entrega al alcanzar un nivel")
      .addIntegerOption((option) =>
        option.setName("nivel").setDescription("Nivel que entrega el rol").setMinValue(1).setMaxValue(1_000_000).setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("rol").setDescription("Rol que recibirá el miembro").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("rol-quitar")
      .setDescription("Elimina la recompensa de rol de un nivel")
      .addIntegerOption((option) =>
        option.setName("nivel").setDescription("Nivel de la recompensa").setMinValue(1).setMaxValue(1_000_000).setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("roles").setDescription("Muestra los roles configurados por nivel"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("configurar")
      .setDescription("Consulta o modifica los ajustes de XP de este servidor")
      .addIntegerOption((option) =>
        option.setName("xp_mensaje").setDescription("XP fija por mensaje válido").setMinValue(0).setMaxValue(1000),
      )
      .addIntegerOption((option) =>
        option.setName("xp_voz").setDescription("XP por minuto en un canal con otra persona").setMinValue(0).setMaxValue(1000),
      )
      .addIntegerOption((option) =>
        option.setName("cooldown").setDescription("Segundos entre mensajes que dan XP").setMinValue(0).setMaxValue(86400),
      )
      .addChannelOption((option) =>
        option
          .setName("canal")
          .setDescription("Canal de anuncios de subida de nivel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addStringOption((option) =>
        option
          .setName("mensaje")
          .setDescription("Plantilla: {user}, {username}, {level}, {server}, {xp}, {required}")
          .setMinLength(1)
          .setMaxLength(1000),
      )
      .addBooleanOption((option) =>
        option.setName("mantener_roles").setDescription("Conservar los roles de niveles anteriores"),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("activar").setDescription("Activa la obtención de XP y niveles"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("desactivar").setDescription("Desactiva la obtención de XP y niveles"),
  );

export const levelCommands = [levelCommand];

function xpRequiredForLevel(level: number): number {
  return level * 100;
}

async function getLevelSettings(guildId: string): Promise<LevelSettings> {
  const row = (
    await db.select().from(guildConfigs).where(eq(guildConfigs.guildId, guildId)).limit(1)
  )[0];
  return {
    xpEnabled: row?.xpEnabled ?? XP_DEFAULTS.xpEnabled,
    xpPerMessage: row?.xpPerMessage ?? XP_DEFAULTS.xpPerMessage,
    xpPerVoiceMinute: row?.xpPerVoiceMinute ?? XP_DEFAULTS.xpPerVoiceMinute,
    xpMessageCooldownSeconds:
      row?.xpMessageCooldownSeconds ?? XP_DEFAULTS.xpMessageCooldownSeconds,
    levelUpMessage: row?.levelUpMessage ?? XP_DEFAULTS.levelUpMessage,
    keepPreviousLevelRoles: row?.keepPreviousLevelRoles ?? XP_DEFAULTS.keepPreviousLevelRoles,
    levelUpChannelId: row?.levelUpChannelId ?? XP_DEFAULTS.levelUpChannelId,
  };
}

async function updateLevelSettings(guildId: string, values: LevelSettingsUpdate): Promise<void> {
  await db
    .insert(guildConfigs)
    .values({ guildId, ...values })
    .onConflictDoUpdate({
      target: guildConfigs.guildId,
      set: { ...values, updatedAt: new Date() },
    });
}

async function ensureProfile(guildId: string, userId: string) {
  await db
    .insert(userProfiles)
    .values({ guildId, userId })
    .onConflictDoNothing();
  return (
    await db
      .select()
      .from(userProfiles)
      .where(and(eq(userProfiles.guildId, guildId), eq(userProfiles.userId, userId)))
      .limit(1)
  )[0] ?? null;
}

async function resolveGuildMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  return guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
}

async function announceLevelUp(
  guild: Guild,
  userId: string,
  level: number,
  xp: number,
  fallbackChannelId: string | null,
  settings: LevelSettings,
): Promise<void> {
  const targetChannelId =
    settings.levelUpChannelId ?? fallbackChannelId ?? guild.systemChannelId;
  if (!targetChannelId) return;
  const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    logger.warn({ guildId: guild.id, channelId: targetChannelId }, "Level-up announcement channel is unavailable");
    return;
  }

  const member = await resolveGuildMember(guild, userId);
  const username = member?.user.username ?? userId;
  const description = settings.levelUpMessage
    .replaceAll("{user}", `<@${userId}>`)
    .replaceAll("{username}", username)
    .replaceAll("{level}", String(level))
    .replaceAll("{server}", guild.name)
    .replaceAll("{xp}", String(xp))
    .replaceAll("{required}", String(xpRequiredForLevel(level)));
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("¡Subida de nivel!")
        .setDescription(description)
        .setTimestamp(),
    ],
    allowedMentions: { users: [userId], roles: [], parse: [] },
  }).catch((error: unknown) => {
    logger.warn({ err: error, guildId: guild.id, userId }, "Level-up announcement could not be sent");
  });
}

function canBotManageRole(botMember: GuildMember, roleId: string): boolean {
  const role = botMember.guild.roles.cache.get(roleId);
  return Boolean(
    role &&
    !role.managed &&
    botMember.permissions.has(PermissionFlagsBits.ManageRoles) &&
    botMember.roles.highest.comparePositionTo(role) > 0,
  );
}

async function applyLevelRoleChanges(
  guild: Guild,
  userId: string,
  oldLevel: number,
  newLevel: number,
  settings: LevelSettings,
  knownMember?: GuildMember | null,
): Promise<void> {
  if (oldLevel === newLevel) return;
  const rewards = await db
    .select()
    .from(levelRoleRewards)
    .where(eq(levelRoleRewards.guildId, guild.id))
    .orderBy(asc(levelRoleRewards.level));
  if (!rewards.length) return;

  const member = knownMember ?? await resolveGuildMember(guild, userId);
  if (!member) return;
  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    logger.warn({ guildId: guild.id }, "Level reward roles could not be applied: the bot needs Manage Roles");
    return;
  }

  const grantReward = async (roleId: string): Promise<boolean> => {
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.managed || botMember.roles.highest.comparePositionTo(role) <= 0) {
      logger.warn({ guildId: guild.id, roleId }, "Level reward role is above the bot or unavailable");
      return false;
    }
    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(role, "Recompensa de nivel").catch((error: unknown) => {
        logger.warn({ err: error, guildId: guild.id, userId, roleId }, "Level reward role could not be added");
      });
    }
    return true;
  };

  if (newLevel > oldLevel) {
    const earnedRewards = rewards.filter((reward) => reward.level > oldLevel && reward.level <= newLevel);
    if (settings.keepPreviousLevelRoles) {
      for (const reward of earnedRewards) await grantReward(reward.roleId);
      return;
    }

    const latestReward = earnedRewards.at(-1);
    if (!latestReward || !(await grantReward(latestReward.roleId))) return;
    const obsoleteRoleIds = rewards
      .filter((reward) => reward.roleId !== latestReward.roleId)
      .map((reward) => reward.roleId);
    const rolesToRemove = member.roles.cache
      .filter((role) => obsoleteRoleIds.includes(role.id))
      .map((role) => role.id);
    if (rolesToRemove.length) {
      await member.roles.remove(rolesToRemove, "Sustitución de rol de nivel").catch((error: unknown) => {
        logger.warn({ err: error, guildId: guild.id, userId }, "Previous level reward roles could not be removed");
      });
    }
    return;
  }

  if (!settings.keepPreviousLevelRoles) {
    const rolesToRemove = rewards
      .filter((reward) => reward.level > newLevel)
      .map((reward) => reward.roleId)
      .filter((roleId) => member.roles.cache.has(roleId));
    if (rolesToRemove.length) {
      await member.roles.remove(rolesToRemove, "Retirada de recompensa por pérdida de nivel").catch((error: unknown) => {
        logger.warn({ err: error, guildId: guild.id, userId }, "Level reward roles could not be removed after an XP reduction");
      });
    }
  }
}

async function awardXp(
  guild: Guild,
  userId: string,
  amount: number,
  source: "message" | "voice" | "admin",
  fallbackChannelId: string | null = null,
  settings?: LevelSettings,
  knownMember?: GuildMember | null,
): Promise<number[]> {
  if (!Number.isInteger(amount) || amount <= 0) return [];
  const currentSettings = settings ?? await getLevelSettings(guild.id);
  if (source !== "admin" && !currentSettings.xpEnabled) return [];

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    await tx.insert(userProfiles).values({ guildId: guild.id, userId }).onConflictDoNothing();
    const profile = (
      await tx
        .select()
        .from(userProfiles)
        .where(and(eq(userProfiles.guildId, guild.id), eq(userProfiles.userId, userId)))
        .for("update")
        .limit(1)
    )[0];
    if (!profile) return null;
    if (
      source === "message" &&
      profile.lastXpAt &&
      now.getTime() - profile.lastXpAt.getTime() < currentSettings.xpMessageCooldownSeconds * 1000
    ) {
      return null;
    }

    let xp = profile.xp + amount;
    let level = profile.level;
    const levelsGained: number[] = [];
    while (xp >= xpRequiredForLevel(level)) {
      xp -= xpRequiredForLevel(level);
      level += 1;
      levelsGained.push(level);
    }
    await tx
      .update(userProfiles)
      .set({
        xp,
        level,
        lastXpAt: source === "message" ? now : profile.lastXpAt,
        updatedAt: now,
      })
      .where(and(eq(userProfiles.guildId, guild.id), eq(userProfiles.userId, userId)));
    return { oldLevel: profile.level, level, xp, levelsGained };
  });

  if (!result) return [];
  await applyLevelRoleChanges(
    guild,
    userId,
    result.oldLevel,
    result.level,
    currentSettings,
    knownMember,
  );
  if (result.levelsGained.length) {
    await announceLevelUp(
      guild,
      userId,
      result.level,
      result.xp,
      fallbackChannelId,
      currentSettings,
    );
  }
  return result.levelsGained;
}

export async function awardMessageXp(message: Message<boolean>): Promise<number[]> {
  if (!message.guild || message.author.bot) return [];
  const settings = await getLevelSettings(message.guild.id);
  return awardXp(
    message.guild,
    message.author.id,
    settings.xpPerMessage,
    "message",
    message.channelId,
    settings,
    message.member,
  );
}

function voiceSessionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function clearVoiceSessionsForChannel(guildId: string, channelId: string): void {
  for (const [key, session] of voiceXpSessions) {
    if (session.guildId === guildId && session.channelId === channelId) {
      voiceXpSessions.delete(key);
    }
  }
}

function reconcileVoiceChannel(guild: Guild, channelId: string): void {
  const channel = guild.channels.cache.get(channelId);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)
  ) {
    clearVoiceSessionsForChannel(guild.id, channelId);
    return;
  }

  const humanMembers = channel.members.filter((member) => !member.user.bot);
  const eligible = humanMembers.size >= 2;
  const presentUserIds = new Set(humanMembers.keys());
  for (const [key, session] of voiceXpSessions) {
    if (
      session.guildId === guild.id &&
      session.channelId === channelId &&
      (!eligible || !presentUserIds.has(session.userId))
    ) {
      voiceXpSessions.delete(key);
    }
  }
  if (!eligible) return;

  const now = Date.now();
  for (const member of humanMembers.values()) {
    const key = voiceSessionKey(guild.id, member.id);
    const existing = voiceXpSessions.get(key);
    if (!existing || existing.channelId !== channelId) {
      voiceXpSessions.set(key, {
        guildId: guild.id,
        channelId,
        userId: member.id,
        eligibleSince: now,
      });
    }
  }
}

export function handleLevelVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
  const channelIds = new Set(
    [oldState.channelId, newState.channelId].filter((channelId): channelId is string => Boolean(channelId)),
  );
  for (const channelId of channelIds) reconcileVoiceChannel(newState.guild, channelId);
}

async function awardVoiceXp(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const settings = await getLevelSettings(guild.id);
    if (!settings.xpEnabled || settings.xpPerVoiceMinute <= 0) {
      for (const [key, session] of voiceXpSessions) {
        if (session.guildId === guild.id) voiceXpSessions.delete(key);
      }
      continue;
    }

    const voiceChannelIds = new Set<string>();
    for (const channel of guild.channels.cache.values()) {
      if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        voiceChannelIds.add(channel.id);
        reconcileVoiceChannel(guild, channel.id);
      }
    }
    for (const [key, session] of voiceXpSessions) {
      if (session.guildId === guild.id && !voiceChannelIds.has(session.channelId)) {
        voiceXpSessions.delete(key);
      }
    }

    const now = Date.now();
    const dueSessions = [...voiceXpSessions.values()].filter(
      (session) =>
        session.guildId === guild.id &&
        now - session.eligibleSince >= VOICE_XP_INTERVAL_MS,
    );
    for (let offset = 0; offset < dueSessions.length; offset += VOICE_XP_BATCH_SIZE) {
      const batch = dueSessions.slice(offset, offset + VOICE_XP_BATCH_SIZE);
      await Promise.all(
        batch.map(async (session) => {
          const key = voiceSessionKey(session.guildId, session.userId);
          const currentSession = voiceXpSessions.get(key);
          if (currentSession !== session) return;
          const channel = guild.channels.cache.get(session.channelId);
          if (
            !channel ||
            (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)
          ) {
            voiceXpSessions.delete(key);
            return;
          }
          const member = channel.members.get(session.userId);
          const humanCount = channel.members.filter((voiceMember) => !voiceMember.user.bot).size;
          if (!member || member.user.bot || humanCount < 2) {
            voiceXpSessions.delete(key);
            return;
          }

          const minutes = Math.floor((now - session.eligibleSince) / VOICE_XP_INTERVAL_MS);
          if (minutes <= 0) return;
          await awardXp(
            guild,
            session.userId,
            minutes * settings.xpPerVoiceMinute,
            "voice",
            null,
            settings,
            member,
          );
          if (voiceXpSessions.get(key) === session) {
            session.eligibleSince += minutes * VOICE_XP_INTERVAL_MS;
          }
        }),
      );
    }
  }
}

export function startLevelVoiceXp(client: Client): void {
  if (voiceXpInterval) return;
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        reconcileVoiceChannel(guild, channel.id);
      }
    }
  }
  voiceXpInterval = setInterval(() => {
    if (voiceXpTickInFlight) return;
    voiceXpTickInFlight = true;
    void awardVoiceXp(client)
      .catch((error: unknown) => logger.error({ err: error }, "Voice XP awarding failed"))
      .finally(() => {
        voiceXpTickInFlight = false;
      });
  }, VOICE_XP_INTERVAL_MS);
  voiceXpInterval.unref();
}

function totalXpForProfile(level: number, xp: number): number {
  return (level * (level - 1) * 100) / 2 + xp;
}

function progressFromTotalXp(totalXp: number): { level: number; xp: number } {
  let level = 1;
  let xp = Math.max(0, totalXp);
  while (xp >= xpRequiredForLevel(level)) {
    xp -= xpRequiredForLevel(level);
    level += 1;
  }
  return { level, xp };
}

async function removeXp(guild: Guild, userId: string, amount: number, member: GuildMember): Promise<void> {
  const settings = await getLevelSettings(guild.id);
  const result = await db.transaction(async (tx) => {
    await tx.insert(userProfiles).values({ guildId: guild.id, userId }).onConflictDoNothing();
    const profile = (
      await tx
        .select()
        .from(userProfiles)
        .where(and(eq(userProfiles.guildId, guild.id), eq(userProfiles.userId, userId)))
        .for("update")
        .limit(1)
    )[0];
    if (!profile) return null;
    const remainingTotalXp = Math.max(0, totalXpForProfile(profile.level, profile.xp) - amount);
    const progress = progressFromTotalXp(remainingTotalXp);
    await tx
      .update(userProfiles)
      .set({ level: progress.level, xp: progress.xp, updatedAt: new Date() })
      .where(and(eq(userProfiles.guildId, guild.id), eq(userProfiles.userId, userId)));
    return { oldLevel: profile.level, level: progress.level };
  });
  if (result && result.level !== result.oldLevel) {
    await applyLevelRoleChanges(guild, userId, result.oldLevel, result.level, settings, member);
  }
}

async function setLevel(guild: Guild, userId: string, level: number, member: GuildMember): Promise<void> {
  const profile = await ensureProfile(guild.id, userId);
  if (!profile) return;
  const settings = await getLevelSettings(guild.id);
  await db
    .update(userProfiles)
    .set({ level, xp: 0, updatedAt: new Date() })
    .where(and(eq(userProfiles.guildId, guild.id), eq(userProfiles.userId, userId)));
  await applyLevelRoleChanges(guild, userId, profile.level, level, settings, member);
}

async function resetProfile(guildId: string, userId: string): Promise<void> {
  await db
    .insert(userProfiles)
    .values({ guildId, userId })
    .onConflictDoNothing();
  await db
    .update(userProfiles)
    .set({ level: 1, xp: 0, lastXpAt: null, updatedAt: new Date() })
    .where(and(eq(userProfiles.guildId, guildId), eq(userProfiles.userId, userId)));
}

function progressBar(xp: number, required: number): string {
  const filled = Math.min(10, Math.floor((xp / required) * 10));
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`;
}

async function showLevelProfile(
  interaction: ChatInputCommandInteraction,
  userId: string,
): Promise<void> {
  const user = await interaction.client.users.fetch(userId).catch(() => null);
  if (!user) {
    await interaction.reply({ content: "No se pudo encontrar a ese usuario.", ephemeral: true });
    return;
  }
  const profile = await ensureProfile(interaction.guildId!, userId);
  if (!profile) {
    await interaction.reply({ content: "No se pudieron cargar las estadísticas de nivel.", ephemeral: true });
    return;
  }
  const required = xpRequiredForLevel(profile.level);
  const settings = await getLevelSettings(interaction.guildId!);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
    .setTitle(`Nivel ${profile.level}`)
    .setDescription(
      `**XP actual:** ${profile.xp}/${required}\n**Progreso:** ${progressBar(profile.xp, required)} ${Math.floor((profile.xp / required) * 100)}%`,
    )
    .setFooter({ text: settings.xpEnabled ? interaction.guild!.name : `${interaction.guild!.name} · niveles desactivados` });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function showLevelRanking(interaction: ChatInputCommandInteraction): Promise<void> {
  const profiles = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.guildId, interaction.guildId!))
    .orderBy(desc(userProfiles.level), desc(userProfiles.xp))
    .limit(10);
  if (!profiles.length) {
    await interaction.reply({ content: "Todavía no hay miembros en el ranking.", ephemeral: true });
    return;
  }
  const lines = profiles.map((profile, index) => {
    const name =
      interaction.guild!.members.cache.get(profile.userId)?.displayName ?? `<@${profile.userId}>`;
    return `**${index + 1}.** ${name} — nivel **${profile.level}** · ${profile.xp} XP`;
  });
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Ranking de niveles · ${interaction.guild!.name}`)
        .setDescription(lines.join("\n")),
    ],
  });
}

function isLevelManager(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

async function showLevelSettings(interaction: ChatInputCommandInteraction): Promise<void> {
  const settings = await getLevelSettings(interaction.guildId!);
  const channel = settings.levelUpChannelId
    ? `<#${settings.levelUpChannelId}>`
    : "canal del mensaje o canal principal del servidor";
  await interaction.reply({
    content: [
      `**Niveles:** ${settings.xpEnabled ? "activos" : "inactivos"}`,
      `**XP por mensaje:** ${settings.xpPerMessage}`,
      `**XP por voz:** ${settings.xpPerVoiceMinute} por minuto conectado con otra persona`,
      `**Cooldown de mensajes:** ${settings.xpMessageCooldownSeconds} segundos`,
      `**Canal de anuncios:** ${channel}`,
      `**Roles anteriores:** ${settings.keepPreviousLevelRoles ? "se conservan" : "se sustituyen"}`,
      `**Mensaje:** ${settings.levelUpMessage}`,
    ].join("\n"),
    ephemeral: true,
  });
}

export async function handleLevelCommand(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (interaction.commandName !== "nivel") return false;
  const action = interaction.options.getSubcommand();
  const adminActions = new Set([
    "set",
    "xp",
    "quitar-xp",
    "reset",
    "rol",
    "rol-quitar",
    "configurar",
    "activar",
    "desactivar",
  ]);
  if (adminActions.has(action) && !isLevelManager(interaction)) {
    await interaction.reply({
      content: "Necesitas el permiso **Gestionar servidor** para cambiar la configuración de niveles.",
      ephemeral: true,
    });
    return true;
  }

  const guild = interaction.guild!;
  if (action === "perfil") {
    await showLevelProfile(interaction, interaction.user.id);
    return true;
  }
  if (action === "usuario") {
    const user = interaction.options.getUser("usuario", true);
    await showLevelProfile(interaction, user.id);
    return true;
  }
  if (action === "ranking") {
    await showLevelRanking(interaction);
    return true;
  }
  if (action === "configurar") {
    const values: LevelSettingsUpdate = {};
    const messageXp = interaction.options.getInteger("xp_mensaje");
    const voiceXp = interaction.options.getInteger("xp_voz");
    const cooldown = interaction.options.getInteger("cooldown");
    const channel = interaction.options.getChannel("canal");
    const announcement = interaction.options.getString("mensaje");
    const keepRoles = interaction.options.getBoolean("mantener_roles");
    if (messageXp !== null) values.xpPerMessage = messageXp;
    if (voiceXp !== null) values.xpPerVoiceMinute = voiceXp;
    if (cooldown !== null) values.xpMessageCooldownSeconds = cooldown;
    if (channel) values.levelUpChannelId = channel.id;
    if (announcement !== null) values.levelUpMessage = announcement.trim();
    if (keepRoles !== null) values.keepPreviousLevelRoles = keepRoles;
    if (!Object.keys(values).length) {
      await showLevelSettings(interaction);
      return true;
    }
    await updateLevelSettings(guild.id, values);
    await interaction.reply({ content: "He guardado la configuración de niveles de este servidor.", ephemeral: true });
    return true;
  }
  if (action === "activar" || action === "desactivar") {
    const enabled = action === "activar";
    await updateLevelSettings(guild.id, { xpEnabled: enabled });
    await interaction.reply({
      content: enabled ? "El sistema de niveles está activo en este servidor." : "El sistema de niveles está desactivado en este servidor.",
      ephemeral: true,
    });
    return true;
  }
  if (action === "roles") {
    const rewards = await db
      .select()
      .from(levelRoleRewards)
      .where(eq(levelRoleRewards.guildId, guild.id))
      .orderBy(asc(levelRoleRewards.level));
    const description = rewards.length
      ? rewards
          .map((reward) => `**Nivel ${reward.level}:** <@&${reward.roleId}>`)
          .join("\n")
          .slice(0, 4000)
      : "No hay roles de nivel configurados.";
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Roles por nivel").setDescription(description)],
      ephemeral: true,
    });
    return true;
  }
  if (action === "rol") {
    const level = interaction.options.getInteger("nivel", true);
    const role = interaction.options.getRole("rol", true);
    const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (
      !botMember ||
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      role.managed ||
      botMember.roles.highest.comparePositionTo(role) <= 0
    ) {
      await interaction.reply({
        content: "No puedo asignar ese rol. Comprueba que el bot tenga **Gestionar roles** y que el rol esté por debajo del rol más alto del bot.",
        ephemeral: true,
      });
      return true;
    }
    await db
      .insert(levelRoleRewards)
      .values({ guildId: guild.id, level, roleId: role.id })
      .onConflictDoUpdate({
        target: [levelRoleRewards.guildId, levelRoleRewards.level],
        set: { roleId: role.id },
      });
    await interaction.reply({
      content: `Al alcanzar el nivel **${level}**, los miembros recibirán el rol ${role}.`,
      ephemeral: true,
    });
    return true;
  }
  if (action === "rol-quitar") {
    const level = interaction.options.getInteger("nivel", true);
    await db
      .delete(levelRoleRewards)
      .where(and(eq(levelRoleRewards.guildId, guild.id), eq(levelRoleRewards.level, level)));
    await interaction.reply({ content: `He eliminado la recompensa de rol del nivel **${level}**.`, ephemeral: true });
    return true;
  }

  const user = interaction.options.getUser("usuario", true);
  if (user.bot) {
    await interaction.reply({ content: "Los bots no pueden tener niveles ni XP.", ephemeral: true });
    return true;
  }
  const member = await resolveGuildMember(guild, user.id);
  if (!member) {
    await interaction.reply({ content: "Ese usuario ya no pertenece a este servidor.", ephemeral: true });
    return true;
  }

  if (action === "set") {
    const level = interaction.options.getInteger("nivel", true);
    await setLevel(guild, user.id, level, member);
    await interaction.reply({ content: `He establecido el nivel de ${user} en **${level}**.`, ephemeral: true });
    return true;
  }
  if (action === "xp") {
    const amount = interaction.options.getInteger("cantidad", true);
    await awardXp(guild, user.id, amount, "admin", interaction.channelId, undefined, member);
    await interaction.reply({ content: `He añadido **${amount} XP** a ${user}.`, ephemeral: true });
    return true;
  }
  if (action === "quitar-xp") {
    const amount = interaction.options.getInteger("cantidad", true);
    await removeXp(guild, user.id, amount, member);
    await interaction.reply({ content: `He quitado **${amount} XP** a ${user}.`, ephemeral: true });
    return true;
  }
  if (action === "reset") {
    await resetProfile(guild.id, user.id);
    await interaction.reply({ content: `He reiniciado el nivel y la XP de ${user}.`, ephemeral: true });
    return true;
  }

  await interaction.reply({ content: "Ese comando de niveles no está disponible.", ephemeral: true });
  return true;
}
