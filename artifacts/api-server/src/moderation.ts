import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
  type User,
} from "discord.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  auditLogs,
  automodAllowlist,
  automodBlocklist,
  automodRules,
  db,
  guildConfigs,
  moderationCases,
} from "@workspace/db";
import { logger } from "./lib/logger";

const RULES = [
  "spam",
  "flood",
  "repetidos",
  "menciones",
  "menciones-masivas",
  "invitaciones",
  "dominios",
  "palabras",
  "publicidad",
] as const;
type Rule = (typeof RULES)[number];
type RuleChoice = Rule | "avisos";
type AutomodAction = "eliminar" | "avisar" | "silenciar" | "expulsar" | "banear";
type PunitiveAction = Exclude<AutomodAction, "eliminar" | "avisar"> | "desilenciar";
type AllowlistKind = "usuario" | "rol" | "canal";
type BlocklistKind = "palabra" | "frase" | "dominio";

interface RuleSettings {
  enabled: boolean;
  action: AutomodAction;
  threshold: number;
  windowSeconds: number;
  durationSeconds: number;
}

interface ActivityMessage {
  content: string;
  timestamp: number;
}

interface LogEvent {
  action: string;
  targetUserId?: string;
  moderatorId: string;
  reason: string;
  durationSeconds?: number;
  ruleKey?: string;
  dmSent?: boolean;
  details?: string;
}

const defaultRules: Record<Rule, RuleSettings> = {
  spam: { enabled: true, action: "eliminar", threshold: 7, windowSeconds: 10, durationSeconds: 600 },
  flood: { enabled: true, action: "eliminar", threshold: 5, windowSeconds: 3, durationSeconds: 600 },
  repetidos: { enabled: true, action: "eliminar", threshold: 3, windowSeconds: 30, durationSeconds: 600 },
  menciones: { enabled: true, action: "eliminar", threshold: 5, windowSeconds: 10, durationSeconds: 600 },
  "menciones-masivas": { enabled: true, action: "eliminar", threshold: 10, windowSeconds: 10, durationSeconds: 600 },
  invitaciones: { enabled: true, action: "eliminar", threshold: 1, windowSeconds: 10, durationSeconds: 600 },
  dominios: { enabled: true, action: "eliminar", threshold: 1, windowSeconds: 10, durationSeconds: 600 },
  palabras: { enabled: true, action: "eliminar", threshold: 1, windowSeconds: 10, durationSeconds: 600 },
  publicidad: { enabled: true, action: "eliminar", threshold: 3, windowSeconds: 30, durationSeconds: 600 },
};

const ruleLabels: Record<Rule, string> = {
  spam: "Spam",
  flood: "Flood",
  repetidos: "Mensajes repetidos",
  menciones: "Exceso de menciones",
  "menciones-masivas": "Menciones masivas",
  invitaciones: "Invitaciones de Discord",
  dominios: "Dominios bloqueados",
  palabras: "Palabras o frases prohibidas",
  publicidad: "Publicidad",
};

function ruleLabel(ruleKey: string) {
  return ruleKey === "avisos" ? "Avisos" : ruleLabels[ruleKey as Rule] ?? ruleKey;
}

const activityByUser = new Map<string, ActivityMessage[]>();
const violationByUserRule = new Map<string, number[]>();
const urlPattern = /(?:https?:\/\/|www\.)[^\s<>()]+/giu;
const invitePattern = /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[a-z0-9-]+/iu;
const promotionalPattern =
  /\b(?:compra|vendo|venta|oferta|promoci[oó]n|descuento|c[oó]digo\s+promo|suscr[ií]bete|s[ií]gueme|mi\s+tienda)\b/iu;

const moderationCommands = [
  new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Configura la protección automática")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand((subcommand) =>
      subcommand.setName("activar").setDescription("Activa la protección automática"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("desactivar").setDescription("Desactiva la protección automática"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("estado").setDescription("Muestra el estado de la protección"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("configurar")
        .setDescription("Configura una regla o las sanciones por Avisos")
        .addStringOption((option) =>
          option
            .setName("regla")
            .setDescription("Regla que configurar")
            .setRequired(true)
            .addChoices(
              ...RULES.map((rule) => ({ name: ruleLabels[rule], value: rule })),
              { name: "Sanciones por Avisos", value: "avisos" },
            ),
        )
        .addBooleanOption((option) =>
          option.setName("activada").setDescription("Activa o desactiva esta regla"),
        )
        .addStringOption((option) =>
          option
            .setName("accion")
            .setDescription("Acción de la regla")
            .addChoices(
              { name: "Eliminar mensaje", value: "eliminar" },
              { name: "Avisar", value: "avisar" },
              { name: "Silenciar temporalmente", value: "silenciar" },
              { name: "Expulsar", value: "expulsar" },
              { name: "Banear", value: "banear" },
            ),
        )
        .addIntegerOption((option) =>
          option.setName("limite").setDescription("Número de incidencias").setMinValue(1).setMaxValue(100),
        )
        .addIntegerOption((option) =>
          option.setName("ventana").setDescription("Ventana en segundos").setMinValue(1).setMaxValue(3600),
        )
        .addIntegerOption((option) =>
          option
            .setName("duracion")
            .setDescription("Duración del silencio automático en segundos")
            .setMinValue(1)
            .setMaxValue(2419200),
        )
        .addIntegerOption((option) =>
          option.setName("silencio_en").setDescription("Silenciar al alcanzar este número de Avisos").setMinValue(1).setMaxValue(100),
        )
        .addIntegerOption((option) =>
          option.setName("expulsion_en").setDescription("Expulsar al alcanzar este número de Avisos").setMinValue(1).setMaxValue(100),
        )
        .addIntegerOption((option) =>
          option.setName("ban_en").setDescription("Banear al alcanzar este número de Avisos").setMinValue(1).setMaxValue(100),
        )
        .addIntegerOption((option) =>
          option
            .setName("duracion_silencio")
            .setDescription("Duración del silencio por Avisos en segundos")
            .setMinValue(1)
            .setMaxValue(2419200),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("lista-negra")
        .setDescription("Añade o quita palabras, frases y dominios")
        .addStringOption((option) =>
          option
            .setName("operacion")
            .setDescription("Operación")
            .setRequired(true)
            .addChoices({ name: "Añadir", value: "añadir" }, { name: "Quitar", value: "quitar" }),
        )
        .addStringOption((option) =>
          option
            .setName("tipo")
            .setDescription("Tipo de contenido")
            .setRequired(true)
            .addChoices(
              { name: "Palabra", value: "palabra" },
              { name: "Frase", value: "frase" },
              { name: "Dominio", value: "dominio" },
            ),
        )
        .addStringOption((option) =>
          option.setName("valor").setDescription("Palabra, frase o dominio").setMaxLength(200).setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("lista-blanca")
        .setDescription("Gestiona excepciones de usuarios, roles y canales")
        .addStringOption((option) =>
          option
            .setName("operacion")
            .setDescription("Operación")
            .setRequired(true)
            .addChoices({ name: "Añadir", value: "añadir" }, { name: "Quitar", value: "quitar" }),
        )
        .addStringOption((option) =>
          option
            .setName("tipo")
            .setDescription("Tipo de excepción")
            .setRequired(true)
            .addChoices(
              { name: "Usuario", value: "usuario" },
              { name: "Rol", value: "rol" },
              { name: "Canal", value: "canal" },
            ),
        )
        .addUserOption((option) => option.setName("usuario").setDescription("Usuario que excluir"))
        .addRoleOption((option) => option.setName("rol").setDescription("Rol que excluir"))
        .addChannelOption((option) => option.setName("canal").setDescription("Canal que excluir")),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("logs")
        .setDescription("Elige el canal de logs de moderación")
        .addChannelOption((option) =>
          option
            .setName("canal")
            .setDescription("Canal de texto para los logs")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Banea a un usuario")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers.toString())
    .addUserOption((option) => option.setName("usuario").setDescription("Usuario que banear").setRequired(true))
    .addStringOption((option) => option.setName("razon").setDescription("Razón del baneo").setMaxLength(500)),
  new SlashCommandBuilder()
    .setName("desban")
    .setDescription("Retira el baneo de un usuario")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers.toString())
    .addStringOption((option) =>
      option.setName("usuario").setDescription("ID numérico del usuario").setRequired(true).setMaxLength(25),
    )
    .addStringOption((option) => option.setName("razon").setDescription("Razón").setMaxLength(500)),
  new SlashCommandBuilder()
    .setName("expulsar")
    .setDescription("Expulsa a un miembro")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers.toString())
    .addUserOption((option) => option.setName("usuario").setDescription("Miembro que expulsar").setRequired(true))
    .addStringOption((option) => option.setName("razon").setDescription("Razón").setMaxLength(500)),
  new SlashCommandBuilder()
    .setName("silenciar")
    .setDescription("Silencia temporalmente a un miembro")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString())
    .addUserOption((option) => option.setName("usuario").setDescription("Miembro que silenciar").setRequired(true))
    .addStringOption((option) =>
      option.setName("duracion").setDescription("Ejemplos: 10m, 2h, 1d, 1w").setRequired(true),
    )
    .addStringOption((option) => option.setName("razon").setDescription("Razón").setMaxLength(500)),
  new SlashCommandBuilder()
    .setName("desilenciar")
    .setDescription("Retira el silencio de un miembro")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString())
    .addUserOption((option) => option.setName("usuario").setDescription("Miembro").setRequired(true))
    .addStringOption((option) => option.setName("razon").setDescription("Razón").setMaxLength(500)),
  new SlashCommandBuilder()
    .setName("avisar")
    .setDescription("Registra un Aviso para un miembro")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString())
    .addUserOption((option) => option.setName("usuario").setDescription("Miembro").setRequired(true))
    .addStringOption((option) => option.setName("razon").setDescription("Razón").setMaxLength(500)),
  new SlashCommandBuilder()
    .setName("desavisar")
    .setDescription("Retira un Aviso activo")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString())
    .addUserOption((option) => option.setName("usuario").setDescription("Miembro").setRequired(true))
    .addIntegerOption((option) => option.setName("caso").setDescription("Número de Aviso opcional").setMinValue(1)),
  new SlashCommandBuilder()
    .setName("avisos")
    .setDescription("Consulta el historial de Avisos")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers.toString())
    .addUserOption((option) => option.setName("usuario").setDescription("Miembro").setRequired(true)),
  new SlashCommandBuilder()
    .setName("limpiar")
    .setDescription("Elimina mensajes recientes del canal")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addIntegerOption((option) =>
      option.setName("cantidad").setDescription("Entre 1 y 100 mensajes").setMinValue(1).setMaxValue(100).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("lentitud")
    .setDescription("Configura el modo lento del canal")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString())
    .addStringOption((option) =>
      option.setName("duracion").setDescription("Ejemplos: 0, 10s, 1m (máximo 6h)").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("bloquear")
    .setDescription("Impide que los miembros escriban en este canal")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()),
  new SlashCommandBuilder()
    .setName("desbloquear")
    .setDescription("Permite que los miembros escriban en este canal")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels.toString()),
];

export { moderationCommands };

const knownCommands = new Set([
  "automod",
  "ban",
  "desban",
  "expulsar",
  "silenciar",
  "desilenciar",
  "avisar",
  "desavisar",
  "avisos",
  "limpiar",
  "lentitud",
  "bloquear",
  "desbloquear",
]);

const requiredPermissions: Record<string, bigint> = {
  automod: PermissionFlagsBits.ManageGuild,
  ban: PermissionFlagsBits.BanMembers,
  desban: PermissionFlagsBits.BanMembers,
  expulsar: PermissionFlagsBits.KickMembers,
  silenciar: PermissionFlagsBits.ModerateMembers,
  desilenciar: PermissionFlagsBits.ModerateMembers,
  avisar: PermissionFlagsBits.ModerateMembers,
  desavisar: PermissionFlagsBits.ModerateMembers,
  avisos: PermissionFlagsBits.ModerateMembers,
  limpiar: PermissionFlagsBits.ManageMessages,
  lentitud: PermissionFlagsBits.ManageChannels,
  bloquear: PermissionFlagsBits.ManageChannels,
  desbloquear: PermissionFlagsBits.ManageChannels,
};

const defaultWarningConfig = {
  warningTimeoutAt: 2,
  warningKickAt: 3,
  warningBanAt: 4,
  warningTimeoutSeconds: 600,
};

async function getGuildConfig(guildId: string) {
  const current = await db
    .select()
    .from(guildConfigs)
    .where(eq(guildConfigs.guildId, guildId))
    .limit(1);
  if (current[0]) return current[0];

  const inserted = await db
    .insert(guildConfigs)
    .values({ guildId })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  return (
    await db
      .select()
      .from(guildConfigs)
      .where(eq(guildConfigs.guildId, guildId))
      .limit(1)
  )[0];
}

async function sendReply(interaction: ChatInputCommandInteraction, content: string) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, ephemeral: true });
  }
}

function normalizeText(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es").trim();
}

function normalizeDomain(value: string): string | null {
  try {
    const host = new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
    const normalized = host.replace(/^www\./u, "");
    return normalized.includes(".") && !normalized.includes("..") ? normalized : null;
  } catch {
    return null;
  }
}

function formatDuration(seconds: number) {
  const parts: string[] = [];
  const units: Array<[number, string, string]> = [
    [86400, "día", "días"],
    [3600, "hora", "horas"],
    [60, "minuto", "minutos"],
  ];
  let remaining = seconds;
  for (const [unitSeconds, singular, plural] of units) {
    const count = Math.floor(remaining / unitSeconds);
    if (count > 0) {
      parts.push(`${count} ${count === 1 ? singular : plural}`);
      remaining %= unitSeconds;
    }
  }
  if (remaining > 0) parts.push(`${remaining} ${remaining === 1 ? "segundo" : "segundos"}`);
  return parts.join(" ") || "0 segundos";
}

function parseDuration(value: string): number | null {
  if (value.trim() === "0") return 0;
  const match = /^(\d+)\s*(s|m|min|h|d|w)$/iu.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const secondsPerUnit: Record<string, number> = {
    s: 1,
    m: 60,
    min: 60,
    h: 3600,
    d: 86400,
    w: 604800,
  };
  const seconds = amount * (secondsPerUnit[unit] ?? 0);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

async function getRuleSettings(guildId: string): Promise<Map<Rule, RuleSettings>> {
  const stored = await db
    .select()
    .from(automodRules)
    .where(eq(automodRules.guildId, guildId));
  const byRule = new Map(stored.map((row) => [row.ruleKey, row]));

  return new Map(
    RULES.map((rule) => {
      const base = defaultRules[rule];
      const row = byRule.get(rule);
      const action = row?.action as AutomodAction | undefined;
      const settings: RuleSettings = {
        enabled: row?.enabled ?? base.enabled,
        action:
          action && ["eliminar", "avisar", "silenciar", "expulsar", "banear"].includes(action)
            ? action
            : base.action,
        threshold: row?.threshold ?? base.threshold,
        windowSeconds: row?.windowSeconds ?? base.windowSeconds,
        durationSeconds: row?.durationSeconds ?? base.durationSeconds,
      };
      return [rule, settings];
    }),
  );
}

function moderatorLabel(moderatorId: string) {
  return /^\d{15,25}$/u.test(moderatorId) ? `<@${moderatorId}>` : moderatorId;
}

async function recordModerationLog(guild: Guild, event: LogEvent) {
  try {
    await db.insert(auditLogs).values({
      guildId: guild.id,
      actorId: /^\d{15,25}$/u.test(event.moderatorId) ? event.moderatorId : undefined,
      action: event.action,
      targetType: "moderación",
      targetId: event.targetUserId,
      metadata: JSON.stringify({
        ...event,
        createdAt: new Date().toISOString(),
      }),
    });
  } catch (error) {
    logger.error({ error, guildId: guild.id, action: event.action }, "Could not persist moderation audit event");
  }

  try {
    const config = await getGuildConfig(guild.id);
    if (!config?.moderationLogsChannelId) return;
    const channel = await guild.channels.fetch(config.moderationLogsChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const fields = [
      {
        name: "Usuario",
        value: event.targetUserId ? `<@${event.targetUserId}> (${event.targetUserId})` : "—",
        inline: true,
      },
      { name: "Moderador", value: moderatorLabel(event.moderatorId), inline: true },
      { name: "Razón", value: event.reason.slice(0, 1024) || "Sin razón indicada" },
    ];
    if (event.durationSeconds !== undefined) {
      fields.push({ name: "Duración", value: formatDuration(event.durationSeconds), inline: true });
    }
    if (event.ruleKey) {
      fields.push({
        name: "Regla",
        value: ruleLabel(event.ruleKey),
        inline: true,
      });
    }
    if (event.dmSent !== undefined) {
      fields.push({ name: "Mensaje privado", value: event.dmSent ? "Enviado" : "No se pudo enviar", inline: true });
    }
    if (event.details) fields.push({ name: "Detalles", value: event.details.slice(0, 1024) });

    await channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle(`Moderación · ${event.action}`.slice(0, 256))
            .addFields(fields)
            .setTimestamp(),
        ],
      })
      .catch((error: unknown) =>
        logger.warn({ error, guildId: guild.id }, "Could not send moderation log"),
      );
  } catch (error) {
    logger.warn({ error, guildId: guild.id }, "Could not prepare moderation log");
  }
}

interface NewCase {
  targetUserId: string;
  moderatorId: string;
  action: string;
  reason: string;
  source: string;
  ruleKey?: string;
  durationSeconds?: number;
  messageChannelId?: string;
  dmSent?: boolean;
}

async function insertModerationCase(guildId: string, data: NewCase) {
  const inserted = await db
    .insert(moderationCases)
    .values({
      guildId,
      targetUserId: data.targetUserId,
      moderatorId: data.moderatorId,
      action: data.action,
      reason: data.reason,
      source: data.source,
      ruleKey: data.ruleKey,
      durationSeconds: data.durationSeconds,
      messageChannelId: data.messageChannelId,
      dmSent: data.dmSent,
    })
    .returning();
  return inserted[0];
}

interface DmDetails {
  title: string;
  reason: string;
  moderatorId: string;
  durationSeconds?: number;
  details?: string;
}

async function sendSanctionDm(user: User, guild: Guild, details: DmDetails): Promise<boolean> {
  const fields = [
    { name: "Servidor", value: guild.name.slice(0, 256) || "Servidor" },
    { name: "Razón", value: details.reason.slice(0, 1024) || "Sin razón indicada" },
    { name: "Moderador", value: moderatorLabel(details.moderatorId) },
  ];
  if (details.durationSeconds !== undefined) {
    fields.push({ name: "Duración", value: formatDuration(details.durationSeconds) });
  }
  if (details.details) fields.push({ name: "Detalles", value: details.details.slice(0, 1024) });

  try {
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle(details.title)
          .addFields(fields)
          .setTimestamp(),
      ],
    });
    return true;
  } catch {
    return false;
  }
}

function actionTitle(action: PunitiveAction) {
  switch (action) {
    case "banear":
      return "Has sido baneado";
    case "expulsar":
      return "Has sido expulsado";
    case "silenciar":
      return "Has sido silenciado";
    case "desilenciar":
      return "Tu silencio ha sido retirado";
  }
}

function hasHigherRole(guild: Guild, actor: GuildMember, target: GuildMember): boolean {
  if (target.id === guild.ownerId || actor.id === target.id) return false;
  if (actor.id === guild.ownerId) return true;
  return actor.roles.highest.comparePositionTo(target.roles.highest) > 0;
}

async function canBotActOn(guild: Guild, target: GuildMember, permission: bigint): Promise<boolean> {
  if (target.id === guild.ownerId) return false;
  const botMember = await guild.members.fetchMe().catch(() => null);
  return Boolean(
    botMember &&
      botMember.permissions.has(permission) &&
      botMember.roles.highest.comparePositionTo(target.roles.highest) > 0,
  );
}

async function canBotIssueAviso(guild: Guild, target: GuildMember): Promise<boolean> {
  if (target.id === guild.ownerId) return false;
  const botMember = await guild.members.fetchMe().catch(() => null);
  return Boolean(botMember && botMember.roles.highest.comparePositionTo(target.roles.highest) > 0);
}

async function getTargetMember(guild: Guild, user: User): Promise<GuildMember | null> {
  return guild.members.fetch(user.id).catch(() => null);
}

function humanAction(action: PunitiveAction) {
  return actionTitle(action);
}

interface EnforcementResult {
  ok: boolean;
  dmSent?: boolean;
  error?: string;
}

async function enforceAction(
  guild: Guild,
  user: User,
  member: GuildMember | null,
  action: PunitiveAction,
  reason: string,
  moderatorId: string,
  source: string,
  options: { durationSeconds?: number; ruleKey?: string; channelId?: string } = {},
): Promise<EnforcementResult> {
  const requiredPermission =
    action === "banear"
      ? PermissionFlagsBits.BanMembers
      : action === "expulsar"
        ? PermissionFlagsBits.KickMembers
        : PermissionFlagsBits.ModerateMembers;

  if (action !== "banear" && !member) {
    return { ok: false, error: "El miembro ya no está en el servidor." };
  }
  if (member && !(await canBotActOn(guild, member, requiredPermission))) {
    return { ok: false, error: "El bot no tiene permiso o su rol no está por encima del miembro." };
  }
  if (!member) {
    const botMember = await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.BanMembers)) {
      return { ok: false, error: "El bot no tiene permiso para banear." };
    }
  }

  try {
    if (action === "banear") {
      await guild.members.ban(user.id, { reason });
    } else if (action === "expulsar") {
      await member!.kick(reason);
    } else if (action === "silenciar") {
      await member!.timeout((options.durationSeconds ?? 600) * 1000, reason);
    } else {
      await member!.timeout(null, reason);
    }
  } catch (error) {
    logger.warn({ error, guildId: guild.id, targetUserId: user.id, action }, "Discord rejected a moderation action");
    return { ok: false, error: "Discord rechazó la acción. Comprueba permisos y jerarquía de roles." };
  }

  const dmSent = await sendSanctionDm(user, guild, {
    title: humanAction(action),
    reason,
    moderatorId,
    durationSeconds: options.durationSeconds,
  });

  try {
    await insertModerationCase(guild.id, {
      targetUserId: user.id,
      moderatorId,
      action,
      reason,
      source,
      ruleKey: options.ruleKey,
      durationSeconds: options.durationSeconds,
      messageChannelId: options.channelId,
      dmSent,
    });
  } catch (error) {
    logger.error({ error, guildId: guild.id, targetUserId: user.id }, "Could not persist moderation case");
  }

  await recordModerationLog(guild, {
    action,
    targetUserId: user.id,
    moderatorId,
    reason,
    durationSeconds: options.durationSeconds,
    ruleKey: options.ruleKey,
    dmSent,
    details: source,
  });
  return { ok: true, dmSent };
}

function checkActorTarget(guild: Guild, actor: GuildMember, target: GuildMember): string | null {
  if (target.id === guild.ownerId) return "No se puede sancionar al propietario del servidor.";
  if (actor.id === target.id) return "No puedes sancionarte a ti mismo.";
  if (!hasHigherRole(guild, actor, target)) {
    return "Tu rol debe estar por encima del rol del miembro.";
  }
  return null;
}

async function createAviso(
  guild: Guild,
  target: GuildMember,
  moderatorId: string,
  reason: string,
  source: string,
  options: { ruleKey?: string; channelId?: string } = {},
) {
  const active = await db
    .select()
    .from(moderationCases)
    .where(
      and(
        eq(moderationCases.guildId, guild.id),
        eq(moderationCases.targetUserId, target.id),
        eq(moderationCases.action, "avisar"),
        isNull(moderationCases.removedAt),
      ),
    );
  const count = active.length + 1;
  const config = await getGuildConfig(guild.id);
  const timeoutAt = config?.warningTimeoutAt ?? defaultWarningConfig.warningTimeoutAt;
  const kickAt = config?.warningKickAt ?? defaultWarningConfig.warningKickAt;
  const banAt = config?.warningBanAt ?? defaultWarningConfig.warningBanAt;
  const dmSent = await sendSanctionDm(target.user, guild, {
    title: "Has recibido un Aviso",
    reason,
    moderatorId,
    details: `Avisos: ${count}/${banAt} activos. Silencio a partir de ${timeoutAt}, expulsión a partir de ${kickAt} y baneo a partir de ${banAt}.`,
  });

  const warningCase = await insertModerationCase(guild.id, {
    targetUserId: target.id,
    moderatorId,
    action: "avisar",
    reason,
    source,
    ruleKey: options.ruleKey,
    messageChannelId: options.channelId,
    dmSent,
  });
  await recordModerationLog(guild, {
    action: "Aviso",
    targetUserId: target.id,
    moderatorId,
    reason,
    ruleKey: options.ruleKey,
    dmSent,
    details: `Aviso #${warningCase?.id ?? "?"} · ${count} activo(s)`,
  });

  let penalty: EnforcementResult | null = null;
  if (config && count >= config.warningBanAt) {
    penalty = await enforceAction(
      guild,
      target.user,
      target,
      "banear",
      "Acumulación de Avisos",
      moderatorId,
      "Sanción por acumulación de Avisos",
      { ruleKey: "avisos", channelId: options.channelId },
    );
  } else if (config && count >= config.warningKickAt) {
    penalty = await enforceAction(
      guild,
      target.user,
      target,
      "expulsar",
      "Acumulación de Avisos",
      moderatorId,
      "Sanción por acumulación de Avisos",
      { ruleKey: "avisos", channelId: options.channelId },
    );
  } else if (config && count >= config.warningTimeoutAt) {
    penalty = await enforceAction(
      guild,
      target.user,
      target,
      "silenciar",
      "Acumulación de Avisos",
      moderatorId,
      "Sanción por acumulación de Avisos",
      { durationSeconds: config.warningTimeoutSeconds, ruleKey: "avisos", channelId: options.channelId },
    );
  }
  if (penalty && !penalty.ok) {
    await recordModerationLog(guild, {
      action: "Sanción por Avisos no aplicada",
      targetUserId: target.id,
      moderatorId,
      reason: "Acumulación de Avisos",
      ruleKey: "avisos",
      details: penalty.error ?? "El bot no pudo aplicar la sanción.",
    });
  }
  return { count, caseId: warningCase?.id, dmSent, penalty };
}

async function requirePermission(
  interaction: ChatInputCommandInteraction,
  permission: bigint,
): Promise<boolean> {
  if (interaction.memberPermissions?.has(permission)) return true;
  await sendReply(interaction, "No tienes permiso para usar este comando.");
  return false;
}

async function performManualSanction(
  interaction: ChatInputCommandInteraction,
  user: User,
  action: PunitiveAction,
  reason: string,
  durationSeconds?: number,
) {
  const guild = interaction.guild!;
  const actor = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!actor) {
    await sendReply(interaction, "No pude comprobar tus permisos en este servidor.");
    return;
  }

  const target = await getTargetMember(guild, user);
  if (target) {
    const hierarchyError = checkActorTarget(guild, actor, target);
    if (hierarchyError) {
      await sendReply(interaction, hierarchyError);
      return;
    }
  } else if (action !== "banear") {
    await sendReply(interaction, "El miembro ya no está en el servidor.");
    return;
  }

  const result = await enforceAction(
    guild,
    user,
    target,
    action,
    reason,
    interaction.user.id,
    "manual",
    { durationSeconds, channelId: interaction.channelId },
  );
  if (!result.ok) {
    await sendReply(interaction, result.error ?? "No se pudo aplicar la sanción.");
    return;
  }
  await sendReply(
    interaction,
    `Sanción aplicada: ${actionTitle(action)}. MD ${result.dmSent ? "enviado" : "no enviado"}; la acción se aplicó igualmente.`,
  );
}

async function configureAutomod(
  interaction: ChatInputCommandInteraction,
  config = interaction.guild ? getGuildConfig(interaction.guild.id) : Promise.resolve(undefined),
) {
  const guild = interaction.guild!;
  const rule = interaction.options.getString("regla", true) as RuleChoice;
  const enabled = interaction.options.getBoolean("activada");
  const action = interaction.options.getString("accion") as AutomodAction | null;
  const limit = interaction.options.getInteger("limite");
  const windowSeconds = interaction.options.getInteger("ventana");
  const durationSeconds = interaction.options.getInteger("duracion");

  if (rule === "avisos") {
    const guildConfig = await config;
    if (!guildConfig) {
      await sendReply(interaction, "No se pudo cargar la configuración del servidor.");
      return;
    }
    const timeoutAt = interaction.options.getInteger("silencio_en") ?? guildConfig.warningTimeoutAt;
    const kickAt = interaction.options.getInteger("expulsion_en") ?? guildConfig.warningKickAt;
    const banAt = interaction.options.getInteger("ban_en") ?? guildConfig.warningBanAt;
    const timeoutSeconds =
      interaction.options.getInteger("duracion_silencio") ?? guildConfig.warningTimeoutSeconds;
    const provided = ["silencio_en", "expulsion_en", "ban_en", "duracion_silencio"].some((name) =>
      interaction.options.getInteger(name) !== null,
    );
    if (!provided) {
      await sendReply(interaction, "Indica al menos un umbral o duración de las sanciones por Avisos.");
      return;
    }
    if (!(timeoutAt < kickAt && kickAt < banAt)) {
      await sendReply(interaction, "Los umbrales deben ir en orden: silencio, expulsión y baneo.");
      return;
    }
    await db
      .update(guildConfigs)
      .set({
        warningTimeoutAt: timeoutAt,
        warningKickAt: kickAt,
        warningBanAt: banAt,
        warningTimeoutSeconds: timeoutSeconds,
        updatedAt: new Date(),
      })
      .where(eq(guildConfigs.guildId, guild.id));
    await recordModerationLog(guild, {
      action: "Configuración de sanciones por Avisos actualizada",
      moderatorId: interaction.user.id,
      reason: `Silencio: ${timeoutAt} · Expulsión: ${kickAt} · Baneo: ${banAt} · Duración del silencio: ${formatDuration(timeoutSeconds)}`,
    });
    await sendReply(interaction, "Se actualizaron los límites de sanción por Avisos.");
    return;
  }

  const settings = await getRuleSettings(guild.id);
  const current = settings.get(rule);
  if (!current) {
    await sendReply(interaction, "Esa regla no existe.");
    return;
  }
  if (enabled === null && !action && limit === null && windowSeconds === null && durationSeconds === null) {
    await sendReply(interaction, "Indica al menos el estado, la acción o un límite que quieras cambiar.");
    return;
  }

  const updated: RuleSettings = {
    enabled: enabled ?? current.enabled,
    action: action ?? current.action,
    threshold: limit ?? current.threshold,
    windowSeconds: windowSeconds ?? current.windowSeconds,
    durationSeconds: durationSeconds ?? current.durationSeconds,
  };
  const changes: Partial<typeof automodRules.$inferInsert> = { updatedAt: new Date() };
  if (enabled !== null) changes.enabled = enabled;
  if (action) changes.action = action;
  if (limit !== null) changes.threshold = limit;
  if (windowSeconds !== null) changes.windowSeconds = windowSeconds;
  if (durationSeconds !== null) changes.durationSeconds = durationSeconds;

  await db
    .insert(automodRules)
    .values({
      guildId: guild.id,
      ruleKey: rule,
      ...updated,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [automodRules.guildId, automodRules.ruleKey],
      set: changes,
    });
  await recordModerationLog(guild, {
    action: "Configuración de AutoMod actualizada",
    moderatorId: interaction.user.id,
    reason: `${ruleLabels[rule]} · ${updated.enabled ? "activa" : "desactivada"} · acción: ${updated.action} · límite: ${updated.threshold}`,
  });
  await sendReply(interaction, `Regla **${ruleLabels[rule]}** actualizada.`);
}

async function handleAutomodCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const subcommand = interaction.options.getSubcommand();
  const config = await getGuildConfig(guild.id);

  if (subcommand === "activar" || subcommand === "desactivar") {
    const enabled = subcommand === "activar";
    await db
      .update(guildConfigs)
      .set({ automodEnabled: enabled, updatedAt: new Date() })
      .where(eq(guildConfigs.guildId, guild.id));
    await recordModerationLog(guild, {
      action: `AutoMod ${enabled ? "activado" : "desactivado"}`,
      moderatorId: interaction.user.id,
      reason: enabled ? "Protección automática activada" : "Protección automática desactivada",
    });
    await sendReply(interaction, `AutoMod ${enabled ? "activado" : "desactivado"}.`);
    return;
  }

  if (subcommand === "estado") {
    const settings = await getRuleSettings(guild.id);
    const ruleSummary = RULES.map((rule) => {
      const current = settings.get(rule)!;
      return `${current.enabled ? "Activa" : "Desactivada"} · ${ruleLabels[rule]} · ${current.action} · límite ${current.threshold}`;
    }).join("\n");
    await sendReply(
      interaction,
      `**AutoMod:** ${config?.automodEnabled ? "activado" : "desactivado"}\n${ruleSummary}\n**Sanciones por Avisos:** silencio al ${config?.warningTimeoutAt ?? defaultWarningConfig.warningTimeoutAt}, expulsión al ${config?.warningKickAt ?? defaultWarningConfig.warningKickAt}, baneo al ${config?.warningBanAt ?? defaultWarningConfig.warningBanAt}.`,
    );
    return;
  }

  if (subcommand === "configurar") {
    await configureAutomod(interaction, Promise.resolve(config));
    return;
  }

  if (subcommand === "logs") {
    const channel = interaction.options.getChannel("canal", true);
    if (
      channel.id === config?.ticketLogsChannelId ||
      channel.id === config?.ticketTranscriptsChannelId
    ) {
      await sendReply(interaction, "El canal de moderación debe ser distinto de los canales exclusivos de tickets.");
      return;
    }
    await db
      .update(guildConfigs)
      .set({ moderationLogsChannelId: channel.id, updatedAt: new Date() })
      .where(eq(guildConfigs.guildId, guild.id));
    await recordModerationLog(guild, {
      action: "Canal de logs de moderación actualizado",
      moderatorId: interaction.user.id,
      reason: `Canal configurado: <#${channel.id}>`,
    });
    await sendReply(interaction, `Los logs de moderación se enviarán a ${channel}.`);
    return;
  }

  if (subcommand === "lista-negra") {
    await updateBlocklist(interaction);
    return;
  }
  if (subcommand === "lista-blanca") {
    await updateAllowlist(interaction);
  }
}

async function updateBlocklist(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const operation = interaction.options.getString("operacion", true);
  const kind = interaction.options.getString("tipo", true) as BlocklistKind;
  const rawValue = interaction.options.getString("valor", true).trim();
  if (!rawValue) {
    await sendReply(interaction, "El valor no puede estar vacío.");
    return;
  }

  let value = normalizeText(rawValue);
  if (kind === "dominio") {
    const domain = normalizeDomain(rawValue);
    if (!domain) {
      await sendReply(interaction, "Indica un dominio válido, como `ejemplo.com`.");
      return;
    }
    value = domain;
  }

  if (operation === "añadir") {
    const existing = await db
      .select()
      .from(automodBlocklist)
      .where(
        and(
          eq(automodBlocklist.guildId, guild.id),
          eq(automodBlocklist.kind, kind),
          eq(automodBlocklist.value, value),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await sendReply(interaction, "Ese valor ya está en la lista negra.");
      return;
    }
    await db.insert(automodBlocklist).values({
      guildId: guild.id,
      kind,
      value,
      createdBy: interaction.user.id,
    });
  } else {
    await db
      .delete(automodBlocklist)
      .where(
        and(
          eq(automodBlocklist.guildId, guild.id),
          eq(automodBlocklist.kind, kind),
          eq(automodBlocklist.value, value),
        ),
      );
  }
  await recordModerationLog(guild, {
    action: `Lista negra · ${operation}`,
    moderatorId: interaction.user.id,
    reason: `${kind}: ${value}`,
  });
  await sendReply(interaction, `Lista negra actualizada: ${operation} ${kind} **${value}**.`);
}

async function updateAllowlist(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const operation = interaction.options.getString("operacion", true);
  const kind = interaction.options.getString("tipo", true) as AllowlistKind;
  const user = interaction.options.getUser("usuario");
  const role = interaction.options.getRole("rol");
  const channel = interaction.options.getChannel("canal");
  const targetId =
    kind === "usuario" ? user?.id : kind === "rol" ? role?.id : channel?.id;
  if (!targetId) {
    await sendReply(interaction, `Selecciona el ${kind} que quieres ${operation === "añadir" ? "añadir" : "quitar"}.`);
    return;
  }

  if (operation === "añadir") {
    await db
      .insert(automodAllowlist)
      .values({ guildId: guild.id, kind, targetId, addedBy: interaction.user.id })
      .onConflictDoNothing();
  } else {
    await db
      .delete(automodAllowlist)
      .where(
        and(
          eq(automodAllowlist.guildId, guild.id),
          eq(automodAllowlist.kind, kind),
          eq(automodAllowlist.targetId, targetId),
        ),
      );
  }
  await recordModerationLog(guild, {
    action: `Lista blanca · ${operation}`,
    moderatorId: interaction.user.id,
    reason: `${kind}: ${targetId}`,
  });
  const mention =
    kind === "canal" ? `<#${targetId}>` : kind === "rol" ? `<@&${targetId}>` : `<@${targetId}>`;
  await sendReply(interaction, `Lista blanca actualizada: ${operation} ${kind} ${mention}.`);
}

function isCommandInGuild(interaction: ChatInputCommandInteraction) {
  return Boolean(interaction.guild && interaction.guildId);
}

async function performUnban(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const userId = interaction.options.getString("usuario", true).trim();
  if (!/^\d{15,25}$/u.test(userId)) {
    await sendReply(interaction, "Indica un ID de usuario válido.");
    return;
  }

  const reason = interaction.options.getString("razon")?.trim() || "Sin razón indicada";
  const user = await interaction.client.users.fetch(userId).catch(() => null);
  const removed = await guild.members.unban(userId, reason);
  const targetUser = removed ?? user;
  const dmSent = targetUser
    ? await sendSanctionDm(targetUser, guild, {
        title: "Tu baneo ha sido retirado",
        reason,
        moderatorId: interaction.user.id,
      })
    : false;

  await insertModerationCase(guild.id, {
    targetUserId: userId,
    moderatorId: interaction.user.id,
    action: "desbanear",
    reason,
    source: "manual",
    messageChannelId: interaction.channelId,
    dmSent,
  });
  await recordModerationLog(guild, {
    action: "Desbaneo",
    targetUserId: userId,
    moderatorId: interaction.user.id,
    reason,
    dmSent,
  });
  await sendReply(interaction, `Baneo retirado. MD ${dmSent ? "enviado" : "no enviado"}.`);
}

async function performWarningRemoval(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const user = interaction.options.getUser("usuario", true);
  const member = await getTargetMember(guild, user);
  if (!member) {
    await sendReply(interaction, "El miembro debe estar en el servidor para gestionar sus Avisos.");
    return;
  }
  const actor = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!actor) {
    await sendReply(interaction, "No pude comprobar tus permisos en este servidor.");
    return;
  }
  const hierarchyError = checkActorTarget(guild, actor, member);
  if (hierarchyError) {
    await sendReply(interaction, hierarchyError);
    return;
  }

  const caseId = interaction.options.getInteger("caso");
  const cases = await db
    .select()
    .from(moderationCases)
    .where(
      and(
        eq(moderationCases.guildId, guild.id),
        eq(moderationCases.targetUserId, user.id),
        eq(moderationCases.action, "avisar"),
        isNull(moderationCases.removedAt),
      ),
    )
    .orderBy(desc(moderationCases.id));
  const selected = caseId ? cases.find((item) => item.id === caseId) : cases[0];
  if (!selected) {
    await sendReply(interaction, "No hay un Aviso activo que retirar.");
    return;
  }

  await db
    .update(moderationCases)
    .set({ removedAt: new Date(), removedBy: interaction.user.id })
    .where(
      and(
        eq(moderationCases.id, selected.id),
        eq(moderationCases.guildId, guild.id),
      ),
    );
  await recordModerationLog(guild, {
    action: "Aviso retirado",
    targetUserId: user.id,
    moderatorId: interaction.user.id,
    reason: `Se retiró el Aviso #${selected.id}: ${selected.reason}`,
  });
  await sendReply(interaction, `Aviso #${selected.id} retirado.`);
}

async function showWarnings(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const user = interaction.options.getUser("usuario", true);
  const cases = await db
    .select()
    .from(moderationCases)
    .where(
      and(
        eq(moderationCases.guildId, guild.id),
        eq(moderationCases.targetUserId, user.id),
        eq(moderationCases.action, "avisar"),
      ),
    )
    .orderBy(desc(moderationCases.id));
  const active = cases.filter((item) => !item.removedAt).length;
  const lines = cases.slice(0, 10).map((item) => {
    const date = item.createdAt.toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
    const state = item.removedAt ? "retirado" : "activo";
    return `**#${item.id}** · ${state} · ${date}\n${item.reason.slice(0, 180)} · Moderador: ${moderatorLabel(item.moderatorId)}`;
  });
  await sendReply(
    interaction,
    `Avisos de **${user.username}**: **${active} activos**\n${lines.join("\n\n") || "No tiene Avisos registrados."}`,
  );
}

async function handleUtilityModerationCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const command = interaction.commandName;
  if (command === "desban") {
    await performUnban(interaction);
    return;
  }
  if (command === "desavisar") {
    await performWarningRemoval(interaction);
    return;
  }
  if (command === "avisos") {
    await showWarnings(interaction);
    return;
  }

  if (command === "limpiar") {
    const channel = interaction.channel;
    const botMember = await guild.members.fetchMe();
    if (!channel || !channel.isTextBased() || !("bulkDelete" in channel)) {
      await sendReply(interaction, "Este comando solo funciona en un canal de texto compatible.");
      return;
    }
    if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageMessages)) {
      await sendReply(interaction, "Al bot le falta el permiso Gestionar mensajes en este canal.");
      return;
    }
    const count = interaction.options.getInteger("cantidad", true);
    const deleted = await channel.bulkDelete(count, true);
    await recordModerationLog(guild, {
      action: "Mensajes eliminados",
      targetUserId: interaction.user.id,
      moderatorId: interaction.user.id,
      reason: "Limpieza manual del canal",
      details: `${deleted.size} de ${count} mensajes eliminados en <#${channel.id}>.`,
    });
    await sendReply(interaction, `Se eliminaron ${deleted.size} mensajes recientes.`);
    return;
  }

  if (command === "lentitud") {
    const channel = interaction.channel;
    const botMember = await guild.members.fetchMe();
    if (!channel || !channel.isTextBased() || !("setRateLimitPerUser" in channel)) {
      await sendReply(interaction, "Este comando solo funciona en un canal de texto compatible.");
      return;
    }
    if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)) {
      await sendReply(interaction, "Al bot le falta el permiso Gestionar canales en este canal.");
      return;
    }
    const value = interaction.options.getString("duracion", true);
    const seconds = parseDuration(value);
    if (seconds === null || seconds > 21600) {
      await sendReply(interaction, "Indica una duración válida de hasta 6 horas; usa `0` para desactivar el modo lento.");
      return;
    }
    await channel.setRateLimitPerUser(seconds);
    await recordModerationLog(guild, {
      action: "Modo lento actualizado",
      targetUserId: interaction.user.id,
      moderatorId: interaction.user.id,
      reason: seconds ? `Intervalo: ${formatDuration(seconds)}` : "Modo lento desactivado",
      details: `Canal: <#${channel.id}>`,
    });
    await sendReply(interaction, seconds ? `Modo lento configurado: ${formatDuration(seconds)}.` : "Modo lento desactivado.");
    return;
  }

  if (command === "bloquear" || command === "desbloquear") {
    const channel = interaction.channel;
    const botMember = await guild.members.fetchMe();
    if (!channel || !channel.isTextBased() || !("permissionOverwrites" in channel)) {
      await sendReply(interaction, "Este comando solo funciona en un canal con permisos de texto.");
      return;
    }
    if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)) {
      await sendReply(interaction, "Al bot le falta el permiso Gestionar canales en este canal.");
      return;
    }
    const lock = command === "bloquear";
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: lock ? false : null },
      { reason: `${lock ? "Canal bloqueado" : "Canal desbloqueado"} por ${interaction.user.tag}` },
    );
    await recordModerationLog(guild, {
      action: lock ? "Canal bloqueado" : "Canal desbloqueado",
      targetUserId: interaction.user.id,
      moderatorId: interaction.user.id,
      reason: lock ? "Se bloqueó el envío de mensajes" : "Se restauró el permiso heredado de envío",
      details: `Canal: <#${channel.id}>`,
    });
    await sendReply(interaction, lock ? "Canal bloqueado." : "Canal desbloqueado.");
  }
}

export async function handleModerationCommand(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (!knownCommands.has(interaction.commandName)) return false;
  if (!isCommandInGuild(interaction)) {
    await sendReply(interaction, "Este comando solo está disponible dentro de un servidor.");
    return true;
  }

  const permission = requiredPermissions[interaction.commandName];
  if (permission && !(await requirePermission(interaction, permission))) return true;

  try {
    if (interaction.commandName === "automod") {
      await handleAutomodCommand(interaction);
      return true;
    }

    const guild = interaction.guild!;
    const reason = interaction.options.getString("razon")?.trim() || "Sin razón indicada";
    if (
      interaction.commandName === "ban" ||
      interaction.commandName === "expulsar" ||
      interaction.commandName === "silenciar" ||
      interaction.commandName === "desilenciar"
    ) {
      const user = interaction.options.getUser("usuario", true);
      if (interaction.commandName === "ban") {
        await performManualSanction(interaction, user, "banear", reason);
      } else if (interaction.commandName === "expulsar") {
        await performManualSanction(interaction, user, "expulsar", reason);
      } else if (interaction.commandName === "silenciar") {
        const seconds = parseDuration(interaction.options.getString("duracion", true));
        if (seconds === null || seconds < 1 || seconds > 2419200) {
          await sendReply(interaction, "Indica una duración válida de hasta 28 días, por ejemplo `10m`, `2h` o `1d`.");
          return true;
        }
        await performManualSanction(interaction, user, "silenciar", reason, seconds);
      } else {
        await performManualSanction(interaction, user, "desilenciar", reason);
      }
      return true;
    }

    if (interaction.commandName === "avisar") {
      const user = interaction.options.getUser("usuario", true);
      const target = await getTargetMember(guild, user);
      if (!target) {
        await sendReply(interaction, "El miembro debe estar en el servidor para recibir un Aviso.");
        return true;
      }
      const actor = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!actor) {
        await sendReply(interaction, "No pude comprobar tus permisos en este servidor.");
        return true;
      }
      const hierarchyError = checkActorTarget(guild, actor, target);
      if (hierarchyError) {
        await sendReply(interaction, hierarchyError);
        return true;
      }
      if (!(await canBotIssueAviso(guild, target))) {
        await sendReply(interaction, "El rol o los permisos del bot no permiten emitir un Aviso a ese miembro.");
        return true;
      }
      const result = await createAviso(guild, target, interaction.user.id, reason, "manual", {
        channelId: interaction.channelId,
      });
      const penaltyText = result.penalty?.ok
        ? " También se aplicó la sanción automática correspondiente."
        : result.penalty
          ? ` El Aviso quedó registrado, pero la sanción automática no pudo aplicarse: ${result.penalty.error}`
          : "";
      await sendReply(
        interaction,
        `Aviso #${result.caseId ?? "?"} registrado. Avisos activos: ${result.count}. MD ${result.dmSent ? "enviado" : "no enviado"}.${penaltyText}`,
      );
      return true;
    }

    await handleUtilityModerationCommand(interaction);
    return true;
  } catch (error) {
    logger.error({ error, command: interaction.commandName, guildId: interaction.guildId }, "Moderation command failed");
    await sendReply(interaction, "No se pudo completar la acción. Comprueba los permisos del bot y la jerarquía de roles.");
    return true;
  }
}

function countInWindow(messages: ActivityMessage[], now: number, windowSeconds: number) {
  const cutoff = now - windowSeconds * 1000;
  return messages.filter((item) => item.timestamp >= cutoff).length;
}

function listMessageUrls(text: string) {
  return [...text.matchAll(urlPattern)].map((match) => match[0].replace(/[),.!?]+$/u, ""));
}

function hasBlockedDomain(urls: string[], blockedDomains: string[]) {
  const hosts = urls
    .map((value) => {
      try {
        const url = new URL(value.startsWith("www.") ? `https://${value}` : value);
        return url.hostname.toLowerCase().replace(/^www\./u, "");
      } catch {
        return null;
      }
    })
    .filter((host): host is string => Boolean(host));
  return blockedDomains.some((blocked) =>
    hosts.some((host) => host === blocked || host.endsWith(`.${blocked}`)),
  );
}

function findBlockedText(text: string, entries: Array<{ kind: string; value: string }>) {
  return entries.find((entry) => {
    if (entry.kind === "dominio") return false;
    if (entry.kind === "palabra") {
      const escaped = entry.value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, "iu").test(text);
    }
    return text.includes(entry.value);
  });
}

function detectRule(
  message: Message<boolean>,
  text: string,
  rules: Map<Rule, RuleSettings>,
  blocked: Array<{ kind: string; value: string }>,
  activity: ActivityMessage[],
): Rule | null {
  const now = Date.now();
  const incidentReached = (rule: Rule) => {
    const setting = rules.get(rule);
    if (!setting?.enabled) return false;
    const key = `${message.guildId}:${message.author.id}:${rule}`;
    const cutoff = now - setting.windowSeconds * 1000;
    const incidents = (violationByUserRule.get(key) ?? []).filter((timestamp) => timestamp >= cutoff);
    incidents.push(now);
    violationByUserRule.set(key, incidents);
    if (violationByUserRule.size > 5000) {
      for (const [incidentKey, values] of violationByUserRule) {
        const fresh = values.filter((timestamp) => now - timestamp < 3600000);
        if (fresh.length) violationByUserRule.set(incidentKey, fresh);
        else violationByUserRule.delete(incidentKey);
      }
    }
    return incidents.length >= setting.threshold;
  };
  const isHit = (rule: Rule, count: number) => {
    const setting = rules.get(rule);
    return Boolean(setting?.enabled && count >= setting.threshold);
  };
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  const massSettings = rules.get("menciones-masivas")!;
  if (
    massSettings.enabled &&
    (message.mentions.everyone || mentionCount >= massSettings.threshold)
  ) {
    return "menciones-masivas";
  }
  if (isHit("menciones", mentionCount)) return "menciones";

  const spam = rules.get("spam")!;
  if (spam.enabled && isHit("spam", countInWindow(activity, now, spam.windowSeconds))) return "spam";
  const flood = rules.get("flood")!;
  if (flood.enabled && isHit("flood", countInWindow(activity, now, flood.windowSeconds))) return "flood";

  const repeatSetting = rules.get("repetidos")!;
  const content = normalizeText(text);
  if (
    repeatSetting.enabled &&
    content.length > 0 &&
    activity.filter(
      (item) =>
        normalizeText(item.content) === content &&
        now - item.timestamp < repeatSetting.windowSeconds * 1000,
    ).length >= repeatSetting.threshold
  ) {
    return "repetidos";
  }
  if (invitePattern.test(text) && incidentReached("invitaciones")) return "invitaciones";

  const urls = listMessageUrls(text);
  const blockedDomains = blocked
    .filter((entry) => entry.kind === "dominio")
    .map((entry) => entry.value);
  if (hasBlockedDomain(urls, blockedDomains) && incidentReached("dominios")) return "dominios";
  if (findBlockedText(content, blocked) && incidentReached("palabras")) return "palabras";

  const advertising = rules.get("publicidad")!;
  if (
    advertising.enabled &&
    (urls.length >= advertising.threshold || promotionalPattern.test(text))
  ) {
    return "publicidad";
  }
  return null;
}

async function isAllowlisted(message: Message<boolean>, member: GuildMember | null) {
  const records = await db
    .select()
    .from(automodAllowlist)
    .where(eq(automodAllowlist.guildId, message.guild!.id));
  return records.some(
    (entry) =>
      (entry.kind === "usuario" && entry.targetId === message.author.id) ||
      (entry.kind === "canal" && entry.targetId === message.channelId) ||
      (entry.kind === "rol" && member?.roles.cache.has(entry.targetId)),
  );
}

async function executeAutoModAction(
  message: Message<boolean>,
  rule: Rule,
  settings: RuleSettings,
  member: GuildMember | null,
): Promise<void> {
  const guild = message.guild!;
  const reason = `Regla de AutoMod: ${ruleLabels[rule]}`;
  const action = settings.action;
  let target = member;
  if (!target) target = await guild.members.fetch(message.author.id).catch(() => null);

  if (action !== "eliminar" && target) {
    const canApply = action === "avisar"
      ? await canBotIssueAviso(guild, target)
      : await canBotActOn(
          guild,
          target,
          action === "banear"
            ? PermissionFlagsBits.BanMembers
            : action === "expulsar"
              ? PermissionFlagsBits.KickMembers
              : PermissionFlagsBits.ModerateMembers,
        );
    if (!canApply) {
      await recordModerationLog(guild, {
        action: "Sanción de AutoMod no aplicada",
        targetUserId: message.author.id,
        moderatorId: "AutoMod",
        reason,
        ruleKey: rule,
        details: `Acción configurada: ${action}. Jerarquía o permisos insuficientes.`,
      });
      return;
    }
  } else if (action !== "eliminar" && !target) {
    await recordModerationLog(guild, {
      action: "Sanción de AutoMod no aplicada",
      targetUserId: message.author.id,
      moderatorId: "AutoMod",
      reason,
      ruleKey: rule,
      details: `Acción configurada: ${action}. No se pudo obtener el miembro.`,
    });
    return;
  }

  let messageDeleted = false;
  if (action !== "avisar") {
    try {
      await message.delete();
      messageDeleted = true;
    } catch (error) {
      logger.warn({ error, guildId: guild.id, channelId: message.channelId }, "AutoMod could not delete a message");
    }
  }

  if (action === "eliminar") {
    if (!messageDeleted) {
      await recordModerationLog(guild, {
        action: "AutoMod no pudo eliminar el mensaje",
        targetUserId: message.author.id,
        moderatorId: "AutoMod",
        reason,
        ruleKey: rule,
        details: `Canal: <#${message.channelId}>. Comprueba que el bot tenga permiso para gestionar mensajes.`,
      });
      return;
    }
    const dmSent = await sendSanctionDm(message.author, guild, {
      title: "Tu mensaje fue eliminado",
      reason,
      moderatorId: "AutoMod",
    });
    try {
      await insertModerationCase(guild.id, {
        targetUserId: message.author.id,
        moderatorId: "AutoMod",
        action: "eliminar",
        reason,
        source: "automod",
        ruleKey: rule,
        messageChannelId: message.channelId,
        dmSent,
      });
    } catch (error) {
      logger.error({ error, guildId: guild.id }, "Could not persist AutoMod deletion case");
    }
    await recordModerationLog(guild, {
      action: "Mensaje eliminado por AutoMod",
      targetUserId: message.author.id,
      moderatorId: "AutoMod",
      reason,
      ruleKey: rule,
      dmSent,
      details: `Canal: <#${message.channelId}>`,
    });
    return;
  }

  if (action === "avisar") {
    if (target) {
      await createAviso(guild, target, "AutoMod", reason, "automod", {
        ruleKey: rule,
        channelId: message.channelId,
      });
    }
    return;
  }

  if (target) {
    const result = await enforceAction(
      guild,
      message.author,
      target,
      action,
      reason,
      "AutoMod",
      "automod",
      {
        durationSeconds: action === "silenciar" ? settings.durationSeconds : undefined,
        ruleKey: rule,
        channelId: message.channelId,
      },
    );
    if (!result.ok) {
      await recordModerationLog(guild, {
        action: "Sanción de AutoMod no aplicada",
        targetUserId: message.author.id,
        moderatorId: "AutoMod",
        reason,
        ruleKey: rule,
        details: result.error ?? `Acción configurada: ${action}.`,
      });
    }
  }
}

export async function handleAutoModMessage(message: Message<boolean>): Promise<boolean> {
  if (!message.guild || message.author.bot) return false;

  try {
    const config = await getGuildConfig(message.guild.id);
    if (!config?.automodEnabled) {
      const prefix = `${message.guild.id}:`;
      for (const key of activityByUser.keys()) {
        if (key.startsWith(prefix)) activityByUser.delete(key);
      }
      for (const key of violationByUserRule.keys()) {
        if (key.startsWith(prefix)) violationByUserRule.delete(key);
      }
      return false;
    }
    if (message.author.id === message.guild.ownerId) return false;
    let member = message.member;
    if (!member) member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (
      member?.permissions.has(PermissionFlagsBits.ManageMessages) ||
      member?.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member?.permissions.has(PermissionFlagsBits.Administrator)
    ) {
      return false;
    }
    if (await isAllowlisted(message, member)) return false;

    const settings = await getRuleSettings(message.guild.id);
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const history = (activityByUser.get(key) ?? []).filter((entry) => now - entry.timestamp < 3600000);
    history.push({ content: message.content.slice(0, 500), timestamp: now });
    activityByUser.set(key, history.slice(-200));

    if (activityByUser.size > 5000) {
      for (const [userKey, entries] of activityByUser) {
        const fresh = entries.filter((entry) => now - entry.timestamp < 3600000);
        if (fresh.length) activityByUser.set(userKey, fresh);
        else activityByUser.delete(userKey);
      }
    }

    const blocked = await db
      .select({ kind: automodBlocklist.kind, value: automodBlocklist.value })
      .from(automodBlocklist)
      .where(eq(automodBlocklist.guildId, message.guild.id));
    const rule = detectRule(message, message.content, settings, blocked, history);
    if (!rule) return false;

    await executeAutoModAction(message, rule, settings.get(rule)!, member);
    return true;
  } catch (error) {
    logger.error({ error, guildId: message.guild.id }, "AutoMod message check failed");
    return false;
  }
}
