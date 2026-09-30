import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Interaction,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
} from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import {
  auditLogs,
  colorRoles,
  db,
  guildConfigs,
  reports,
  ticketTranscripts,
  tickets,
  userProfiles,
} from "@workspace/db";
import { logger } from "./lib/logger";
import {
  handleAutoModMessage,
  handleModerationCommand,
  moderationCommands,
} from "./moderation";

const token = process.env["DISCORD_TOKEN"];
const applicationId = process.env["DISCORD_APPLICATION_ID"];
const guildId = process.env["DISCORD_GUILD_ID"];
const usePrivilegedIntents = process.env["DISCORD_ENABLE_PRIVILEGED_INTENTS"] === "true";

const rainbowPalette = [
  0xff3b30,
  0xff9500,
  0xffcc00,
  0x34c759,
  0x00c7be,
  0x007aff,
  0x5856d6,
  0xaf52de,
  0xff2d55,
];
const rainbowIntervalMs = 2_000;
let rainbowColorIndex = 0;
let rainbowRotationInFlight = false;

const commands = [
  new SlashCommandBuilder()
    .setName("setlogschannel")
    .setDescription("Elige el canal donde se guardarán los logs")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addChannelOption((option) =>
      option
        .setName("canal")
        .setDescription("Canal de texto para auditoría")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setreportschannel")
    .setDescription("Elige el canal que recibirá los reportes")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addChannelOption((option) =>
      option
        .setName("canal")
        .setDescription("Canal privado para el equipo")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setticketlogschannel")
    .setDescription("Elige el canal exclusivo para los eventos de tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addChannelOption((option) =>
      option
        .setName("canal")
        .setDescription("Canal de texto para aperturas y cierres de tickets")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("settranscriptschannel")
    .setDescription("Elige el canal exclusivo para las transcripciones de tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addChannelOption((option) =>
      option
        .setName("canal")
        .setDescription("Canal de texto para archivos de transcripción")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setwelcomechannel")
    .setDescription("Elige el canal de bienvenida")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addChannelOption((option) =>
      option
        .setName("canal")
        .setDescription("Canal de bienvenida")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setverificationchannel")
    .setDescription("Elige el canal de verificación")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addChannelOption((option) =>
      option
        .setName("canal")
        .setDescription("Canal donde se publicará la verificación")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setverifiedrole")
    .setDescription("Elige el rol que se entrega al verificar")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addRoleOption((option) =>
      option
        .setName("rol")
        .setDescription("Rol de miembro verificado")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setticketcategory")
    .setDescription("Configura la categoría donde se crearán los tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addChannelOption((option) =>
      option
        .setName("categoria")
        .setDescription("Categoría de tickets")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setticketsupport")
    .setDescription("Configura el rol que podrá ver los tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addRoleOption((option) =>
      option
        .setName("rol")
        .setDescription("Rol del equipo de soporte")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Personaliza los paneles del servidor")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand((subcommand) =>
      subcommand
        .setName("bienvenidas")
        .setDescription("Personaliza el mensaje de bienvenida")
        .addStringOption((option) => option.setName("titulo").setDescription("Título; puedes usar {user} y {server}").setMinLength(1).setMaxLength(256).setRequired(true))
        .addStringOption((option) => option.setName("texto").setDescription("Texto; admite {user}, {server} y {memberCount}").setMinLength(1).setMaxLength(1000).setRequired(true))
        .addStringOption((option) => option.setName("color").setDescription("Color hexadecimal, por ejemplo #5865F2").setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("tickets")
        .setDescription("Personaliza el panel para abrir tickets")
        .addStringOption((option) => option.setName("titulo").setDescription("Título del panel").setMinLength(1).setMaxLength(256).setRequired(true))
        .addStringOption((option) => option.setName("texto").setDescription("Descripción del panel").setMinLength(1).setMaxLength(1000).setRequired(true))
        .addStringOption((option) => option.setName("color").setDescription("Color hexadecimal, por ejemplo #5865F2").setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("autorroles")
        .setDescription("Personaliza el selector de autorroles")
        .addStringOption((option) => option.setName("titulo").setDescription("Título del panel").setMinLength(1).setMaxLength(256).setRequired(true))
        .addStringOption((option) => option.setName("texto").setDescription("Descripción del panel").setMinLength(1).setMaxLength(1000).setRequired(true))
        .addStringOption((option) => option.setName("color").setDescription("Color hexadecimal, por ejemplo #5865F2").setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("verificacion")
        .setDescription("Personaliza el panel de verificación")
        .addStringOption((option) => option.setName("titulo").setDescription("Título del panel").setMinLength(1).setMaxLength(256).setRequired(true))
        .addStringOption((option) => option.setName("texto").setDescription("Descripción del panel").setMinLength(1).setMaxLength(1000).setRequired(true))
        .addStringOption((option) => option.setName("color").setDescription("Color hexadecimal, por ejemplo #5865F2").setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("verification-panel")
    .setDescription("Publica el panel de verificación")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()),
  new SlashCommandBuilder()
    .setName("colores")
    .setDescription("Abre el selector de autoroles de colores"),
  new SlashCommandBuilder()
    .setName("create")
    .setDescription("Crea recursos del servidor")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles.toString())
    .addSubcommandGroup((group) =>
      group
        .setName("rb")
        .setDescription("Crea recursos rainbow")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("role")
            .setDescription("Crea un autorol multicolor")
            .addStringOption((option) =>
              option
                .setName("nombre")
                .setDescription("Nombre visible del rol")
                .setMaxLength(80)
                .setRequired(true),
            ),
        ),
    ),
  new SlashCommandBuilder()
    .setName("economia")
    .setDescription("Comandos de economía")
    .addSubcommand((subcommand) =>
      subcommand.setName("balance").setDescription("Mira tu saldo o el de otro miembro").addUserOption((option) =>
        option.setName("usuario").setDescription("Miembro opcional"),
      ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("daily").setDescription("Reclama tu recompensa diaria"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("work").setDescription("Trabaja para ganar monedas"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("pay")
        .setDescription("Paga monedas a otro miembro")
        .addUserOption((option) => option.setName("usuario").setDescription("Destinatario").setRequired(true))
        .addIntegerOption((option) =>
          option.setName("cantidad").setDescription("Cantidad a transferir").setMinValue(1).setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("nivel")
    .setDescription("Mira tu nivel y experiencia o la de otro miembro")
    .addUserOption((option) => option.setName("usuario").setDescription("Miembro opcional")),
  new SlashCommandBuilder()
    .setName("reportar")
    .setDescription("Envía un reporte al equipo de moderación")
    .addUserOption((option) => option.setName("usuario").setDescription("Miembro reportado").setRequired(true))
    .addStringOption((option) =>
      option.setName("motivo").setDescription("Explica lo ocurrido").setMaxLength(1000).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Abre un ticket privado con el equipo"),
  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Publica el panel para abrir tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Muestra la latencia del bot"),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Muestra la lista de comandos del bot"),
  ...moderationCommands,
].map((command) => command.toJSON());

function randomColor(): number {
  return rainbowPalette[Math.floor(Math.random() * rainbowPalette.length)] ?? 0x5865f2;
}

function nextRainbowColor(): number {
  const color = rainbowPalette[rainbowColorIndex % rainbowPalette.length] ?? 0x5865f2;
  rainbowColorIndex += 1;
  return color;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getConfig(serverId: string) {
  const existing = await db
    .select()
    .from(guildConfigs)
    .where(eq(guildConfigs.guildId, serverId))
    .limit(1);

  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(guildConfigs)
    .values({ guildId: serverId })
    .returning();
  return inserted[0];
}

async function updateConfig(serverId: string, values: Partial<typeof guildConfigs.$inferInsert>) {
  await getConfig(serverId);
  const updated = await db
    .update(guildConfigs)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(guildConfigs.guildId, serverId))
    .returning();
  return updated[0];
}

function createPanelEmbed(
  title: string | null | undefined,
  description: string | null | undefined,
  color: string | null | undefined,
  defaultTitle: string,
  defaultDescription: string,
) {
  const normalizedColor = color?.replace(/^#/, "");
  const colorValue =
    normalizedColor && /^[0-9a-fA-F]{6}$/.test(normalizedColor)
      ? Number.parseInt(normalizedColor, 16)
      : 0x5865f2;

  return new EmbedBuilder()
    .setTitle(title || defaultTitle)
    .setDescription(description || defaultDescription)
    .setColor(colorValue);
}

async function sendLog(
  guild: Guild,
  action: string,
  details: Record<string, string | number | null | undefined>,
  destination: "audit" | "tickets" = "audit",
) {
  const config = await getConfig(guild.id);
  const channelId = destination === "tickets" ? config?.ticketLogsChannelId : config?.logsChannelId;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Auditoría · ${action}`)
    .setTimestamp();

  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null)
    .slice(0, 25)
    .map(([name, value]) => ({ name, value: String(value).slice(0, 1024), inline: true }));
  if (fields.length) embed.addFields(fields);

  await channel.send({ embeds: [embed] }).catch((error: unknown) => {
    logger.warn({ error, guildId: guild.id }, "Could not write Discord audit log");
  });
}

async function recordLog(
  guild: Guild,
  action: string,
  details: Record<string, string | number | null | undefined>,
  actorId?: string,
  destination: "audit" | "tickets" = "audit",
) {
  await db.insert(auditLogs).values({
    guildId: guild.id,
    actorId,
    action,
    targetType: details.targetType ? String(details.targetType) : undefined,
    targetId: details.targetId ? String(details.targetId) : undefined,
    metadata: JSON.stringify(details),
  });
  await sendLog(guild, action, details, destination);
}

async function ensureProfile(serverId: string, userId: string) {
  const existing = await db
    .select()
    .from(userProfiles)
    .where(and(eq(userProfiles.guildId, serverId), eq(userProfiles.userId, userId)))
    .limit(1);

  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(userProfiles)
    .values({ guildId: serverId, userId })
    .returning();
  return inserted[0];
}

async function reply(
  interaction: ChatInputCommandInteraction,
  content: string,
  ephemeral = true,
) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, ephemeral });
  }
}

async function handleConfigCommand(interaction: ChatInputCommandInteraction) {
  const command = interaction.commandName;
  const channel = interaction.options.getChannel("canal");
  const role = interaction.options.getRole("rol");
  const category = interaction.options.getChannel("categoria");

  if (command === "setlogschannel" && channel) {
    const config = await getConfig(interaction.guildId!);
    if (channel.id === config?.ticketLogsChannelId || channel.id === config?.ticketTranscriptsChannelId) {
      await reply(interaction, "El canal de logs normales debe ser distinto de los canales de tickets y transcripciones.");
      return;
    }
    await updateConfig(interaction.guildId!, { logsChannelId: channel.id });
    await reply(interaction, `Los logs se guardarán en ${channel}.`);
    return;
  }
  if (command === "setticketlogschannel" && channel) {
    const config = await getConfig(interaction.guildId!);
    if (channel.id === config?.logsChannelId || channel.id === config?.ticketTranscriptsChannelId) {
      await reply(interaction, "El canal de eventos de tickets debe ser distinto del canal de logs normales y del canal de transcripciones.");
      return;
    }
    await updateConfig(interaction.guildId!, { ticketLogsChannelId: channel.id });
    await reply(interaction, `Los eventos de tickets se guardarán en ${channel}.`);
    return;
  }
  if (command === "settranscriptschannel" && channel) {
    const config = await getConfig(interaction.guildId!);
    if (channel.id === config?.logsChannelId || channel.id === config?.ticketLogsChannelId) {
      await reply(interaction, "El canal de transcripciones debe ser distinto del canal de logs normales y del canal de eventos de tickets.");
      return;
    }
    await updateConfig(interaction.guildId!, { ticketTranscriptsChannelId: channel.id });
    await reply(interaction, `Las transcripciones se guardarán en ${channel}.`);
    return;
  }
  if (command === "setreportschannel" && channel) {
    await updateConfig(interaction.guildId!, { reportsChannelId: channel.id });
    await reply(interaction, `Los reportes llegarán a ${channel}.`);
    return;
  }
  if (command === "setwelcomechannel" && channel) {
    await updateConfig(interaction.guildId!, { welcomeChannelId: channel.id });
    await reply(interaction, `Las bienvenidas se enviarán a ${channel}.`);
    return;
  }
  if (command === "setverificationchannel" && channel) {
    await updateConfig(interaction.guildId!, { verificationChannelId: channel.id });
    await reply(interaction, `La verificación usará ${channel}.`);
    return;
  }
  if (command === "setverifiedrole" && role) {
    await updateConfig(interaction.guildId!, { verifiedRoleId: role.id });
    await reply(interaction, `El rol de verificado será ${role}.`);
    return;
  }
  if (command === "setticketcategory" && category) {
    await updateConfig(interaction.guildId!, { ticketCategoryId: category.id });
    await reply(interaction, `Los tickets se crearán en ${category}.`);
    return;
  }
  if (command === "setticketsupport" && role) {
    await updateConfig(interaction.guildId!, { ticketSupportRoleId: role.id });
    await reply(interaction, `El equipo de soporte será ${role}.`);
  }
}

async function handlePanelCustomization(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const title = interaction.options.getString("titulo", true).trim();
  const description = interaction.options.getString("texto", true).trim();
  const rawColor = interaction.options.getString("color", true).trim();
  if (!title || !description) {
    await reply(interaction, "El título y el texto no pueden estar vacíos.");
    return;
  }
  const normalizedColor = rawColor.startsWith("#") ? rawColor : `#${rawColor}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalizedColor)) {
    await reply(interaction, "El color debe ser hexadecimal de seis caracteres, por ejemplo `#5865F2`.");
    return;
  }

  const settingsByPanel = {
    bienvenidas: {
      welcomePanelTitle: title,
      welcomePanelDescription: description,
      welcomePanelColor: normalizedColor.toUpperCase(),
    },
    tickets: {
      ticketPanelTitle: title,
      ticketPanelDescription: description,
      ticketPanelColor: normalizedColor.toUpperCase(),
    },
    autorroles: {
      colorPanelTitle: title,
      colorPanelDescription: description,
      colorPanelColor: normalizedColor.toUpperCase(),
    },
    verificacion: {
      verificationPanelTitle: title,
      verificationPanelDescription: description,
      verificationPanelColor: normalizedColor.toUpperCase(),
    },
  } as const;
  const settings = settingsByPanel[subcommand as keyof typeof settingsByPanel];
  if (!settings) {
    await reply(interaction, "Ese tipo de panel no existe.");
    return;
  }

  await updateConfig(interaction.guildId!, settings);
  const panelNames: Record<keyof typeof settingsByPanel, string> = {
    bienvenidas: "bienvenidas",
    tickets: "tickets",
    autorroles: "autorroles",
    verificacion: "verificación",
  };
  await reply(
    interaction,
    `Panel de ${panelNames[subcommand as keyof typeof settingsByPanel]} actualizado. Título, texto y color se guardaron.`,
  );
}

async function showPing(interaction: ChatInputCommandInteraction) {
  const roundTripMs = Date.now() - interaction.createdTimestamp;
  const websocketMs = Math.max(0, Math.round(interaction.client.ws.ping));
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Ping del bot")
        .addFields(
          { name: "Discord", value: `${websocketMs} ms`, inline: true },
          { name: "Respuesta", value: `${roundTripMs} ms`, inline: true },
        )
        .setColor(0x5865f2),
    ],
    ephemeral: true,
  });
}

async function showHelp(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle("Comandos de AlcaCore")
    .setDescription("Comandos disponibles en este servidor:")
    .setColor(0x5865f2)
    .addFields(
      { name: "Paneles y configuración", value: "`/panel` personaliza bienvenida, tickets, autorroles y verificación.\n`/setwelcomechannel` · `/setverificationchannel` · `/setverifiedrole`\n`/ticket-panel` · `/verification-panel` · `/colores`" },
      { name: "Tickets, reportes y auditoría", value: "`/ticket` abre un ticket privado.\n`/reportar` envía un reporte.\n`/setlogschannel` · `/setticketlogschannel` · `/settranscriptschannel`\n`/setreportschannel` · `/setticketcategory` · `/setticketsupport`" },
      { name: "Moderación", value: "`/ban` · `/desban` · `/expulsar` · `/silenciar` · `/desilenciar`\n`/avisar` · `/desavisar` · `/avisos` · `/limpiar` · `/lentitud` · `/bloquear` · `/desbloquear`" },
      { name: "AutoMod", value: "`/automod activar` · `/automod desactivar` · `/automod configurar` · `/automod estado`\n`/automod lista-negra` · `/automod lista-blanca` · `/automod logs`" },
      { name: "Roles y comunidad", value: "`/create rb role nombre` crea un rol rainbow.\n`/economia balance|daily|work|pay` · `/nivel`" },
      { name: "Estado y ayuda", value: "`/ping` muestra la latencia.\n`/help` muestra esta lista." },
    )
    .setFooter({ text: "La configuración de panel requiere permiso de Gestionar servidor." });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCreateColorRole(interaction: ChatInputCommandInteraction) {
  const name = interaction.options.getString("nombre", true).trim();
  const role = await interaction.guild!.roles.create({
    name,
    color: randomColor(),
    reason: `Autorol rainbow creado por ${interaction.user.tag}`,
  });

  await db.insert(colorRoles).values({
    guildId: interaction.guildId!,
    roleId: role.id,
    roleName: role.name,
    color: role.hexColor,
  });
  await recordLog(interaction.guild!, "Rol rainbow creado", {
    targetType: "role",
    targetId: role.id,
    name: role.name,
  }, interaction.user.id);
  await reply(
    interaction,
    `Rol ${role} creado y añadido al selector de colores. Su color cambiará automáticamente para crear el efecto multicolor.`,
  );
}

async function showColorRoles(interaction: ChatInputCommandInteraction) {
  const config = await getConfig(interaction.guildId!);
  const roles = await db
    .select()
    .from(colorRoles)
    .where(eq(colorRoles.guildId, interaction.guildId!))
    .orderBy(desc(colorRoles.createdAt));

  if (!roles.length) {
    await reply(interaction, "Todavía no hay roles de color. Un administrador puede crear uno con `/create rb role`.");
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("color-role:select")
    .setPlaceholder("Elige tu color")
    .addOptions(
      roles.slice(0, 25).map((role) => ({
        label: role.roleName.slice(0, 100),
        value: role.roleId,
        description: "Autorol rainbow",
      })),
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({
    embeds: [
      createPanelEmbed(
        config?.colorPanelTitle,
        config?.colorPanelDescription,
        config?.colorPanelColor,
        "Autoroles de color",
        "Selecciona un rol para aplicarlo. El bot retirará tus otros colores automáticamente.",
      ),
    ],
    components: [row],
    ephemeral: true,
  });
}

async function handleEconomy(interaction: ChatInputCommandInteraction) {
  const profile = await ensureProfile(interaction.guildId!, interaction.user.id);
  if (!profile) return;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "balance") {
    const user = interaction.options.getUser("usuario") ?? interaction.user;
    const target = await ensureProfile(interaction.guildId!, user.id);
    await reply(interaction, `**${user.username}** tiene **${target?.balance ?? 0} coins**.`);
    return;
  }

  if (subcommand === "daily") {
    const now = new Date();
    if (profile.lastDailyAt && now.getTime() - profile.lastDailyAt.getTime() < 86_400_000) {
      const remaining = Math.ceil((86_400_000 - (now.getTime() - profile.lastDailyAt.getTime())) / 3_600_000);
      await reply(interaction, `Tu recompensa diaria estará disponible en aproximadamente **${remaining} h**.`);
      return;
    }
    const reward = 250 + Math.floor(Math.random() * 251);
    await db
      .update(userProfiles)
      .set({ balance: profile.balance + reward, lastDailyAt: now, updatedAt: now })
      .where(and(eq(userProfiles.guildId, interaction.guildId!), eq(userProfiles.userId, interaction.user.id)));
    await reply(interaction, `Has recibido **${reward} coins**. Vuelve mañana para reclamar otra recompensa.`);
    return;
  }

  if (subcommand === "work") {
    const now = new Date();
    if (profile.lastWorkAt && now.getTime() - profile.lastWorkAt.getTime() < 3_600_000) {
      const remaining = Math.ceil((3_600_000 - (now.getTime() - profile.lastWorkAt.getTime())) / 60_000);
      await reply(interaction, `Podrás volver a trabajar en **${remaining} min**.`);
      return;
    }
    const reward = 50 + Math.floor(Math.random() * 151);
    await db
      .update(userProfiles)
      .set({ balance: profile.balance + reward, lastWorkAt: now, updatedAt: now })
      .where(and(eq(userProfiles.guildId, interaction.guildId!), eq(userProfiles.userId, interaction.user.id)));
    await reply(interaction, `Has trabajado y ganado **${reward} coins**.`);
    return;
  }

  const recipient = interaction.options.getUser("usuario", true);
  const amount = interaction.options.getInteger("cantidad", true);
  if (recipient.bot || recipient.id === interaction.user.id) {
    await reply(interaction, "Elige a otro miembro que no sea un bot.");
    return;
  }
  if (profile.balance < amount) {
    await reply(interaction, "No tienes suficientes coins para realizar ese pago.");
    return;
  }
  const recipientProfile = await ensureProfile(interaction.guildId!, recipient.id);
  await db
    .update(userProfiles)
    .set({ balance: profile.balance - amount, updatedAt: new Date() })
    .where(and(eq(userProfiles.guildId, interaction.guildId!), eq(userProfiles.userId, interaction.user.id)));
  await db
    .update(userProfiles)
    .set({ balance: (recipientProfile?.balance ?? 0) + amount, updatedAt: new Date() })
    .where(and(eq(userProfiles.guildId, interaction.guildId!), eq(userProfiles.userId, recipient.id)));
  await reply(interaction, `Has enviado **${amount} coins** a ${recipient}.`);
}

async function handleLevel(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser("usuario") ?? interaction.user;
  const profile = await ensureProfile(interaction.guildId!, user.id);
  const required = (profile?.level ?? 1) * 100;
  await reply(
    interaction,
    `**${user.username}** está en el nivel **${profile?.level ?? 1}** con **${profile?.xp ?? 0}/${required} XP**.`,
  );
}

async function handleReport(interaction: ChatInputCommandInteraction) {
  const config = await getConfig(interaction.guildId!);
  const target = interaction.options.getUser("usuario", true);
  const reason = interaction.options.getString("motivo", true);
  if (!config?.reportsChannelId) {
    await reply(interaction, "El equipo debe configurar primero un canal con `/setreportschannel`.");
    return;
  }
  const channel = await interaction.guild!.channels.fetch(config.reportsChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    await reply(interaction, "El canal de reportes configurado ya no existe o no es de texto.");
    return;
  }
  const inserted = await db
    .insert(reports)
    .values({
      guildId: interaction.guildId!,
      reporterId: interaction.user.id,
      reportedUserId: target.id,
      reason,
      reportChannelId: channel.id,
    })
    .returning();
  const report = inserted[0];
  const message = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle(`Nuevo reporte #${report?.id ?? "?"}`)
        .addFields(
          { name: "Reportado", value: `${target} (${target.id})`, inline: true },
          { name: "Reportante", value: `${interaction.user} (${interaction.user.id})`, inline: true },
          { name: "Motivo", value: reason },
        )
        .setTimestamp(),
    ],
  });
  if (report) {
    await db.update(reports).set({ reportMessageId: message.id }).where(eq(reports.id, report.id));
  }
  await recordLog(interaction.guild!, "Reporte recibido", {
    targetType: "user",
    targetId: target.id,
    reportId: report?.id,
  }, interaction.user.id);
  await reply(interaction, "Tu reporte se ha enviado al equipo de moderación. Gracias.");
}

async function publishVerificationPanel(interaction: ChatInputCommandInteraction) {
  const config = await getConfig(interaction.guildId!);
  if (!config?.verificationChannelId || !config.verifiedRoleId) {
    await reply(interaction, "Configura `/setverificationchannel` y `/setverifiedrole` antes de publicar el panel.");
    return;
  }
  const channel = await interaction.guild!.channels.fetch(config.verificationChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    await reply(interaction, "El canal de verificación configurado no es válido.");
    return;
  }
  const button = new ButtonBuilder().setCustomId("verify:complete").setLabel("Verificarme").setStyle(ButtonStyle.Success);
  await channel.send({
    embeds: [
      createPanelEmbed(
        config.verificationPanelTitle,
        config.verificationPanelDescription,
        config.verificationPanelColor,
        "Verificación",
        "Pulsa el botón para confirmar que has leído las normas y obtener acceso al servidor.",
      ),
    ],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
  });
  await reply(interaction, `Panel publicado en ${channel}.`);
}

async function createTicket(interaction: ChatInputCommandInteraction | ButtonInteraction) {
  const guild = interaction.guild;
  if (!guild) return;
  const config = await getConfig(guild.id);
  const existing = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.guildId, guild.id), eq(tickets.openerId, interaction.user.id), eq(tickets.status, "open")))
    .limit(1);
  if (existing[0]) {
    await reply(interaction as ChatInputCommandInteraction, `Ya tienes un ticket abierto: <#${existing[0].channelId}>`);
    return;
  }

  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || "usuario";
  const channel = await guild.channels.create({
    name: `ticket-${safeName}`,
    type: ChannelType.GuildText,
    parent: config?.ticketCategoryId ?? undefined,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      ...(config?.ticketSupportRoleId
        ? [
            {
              id: config.ticketSupportRoleId,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            },
          ]
        : []),
    ],
    reason: `Ticket abierto por ${interaction.user.tag}`,
  });
  const inserted = await db
    .insert(tickets)
    .values({ guildId: guild.id, channelId: channel.id, openerId: interaction.user.id })
    .returning();
  const ticket = inserted[0];
  const closeButton = new ButtonBuilder()
    .setCustomId(`ticket:close:${ticket?.id ?? "unknown"}`)
    .setLabel("Cerrar ticket")
    .setStyle(ButtonStyle.Danger);
  await channel.send({
    content: `${interaction.user} gracias por contactar con el equipo. Describe aquí tu solicitud.`,
    embeds: [
      new EmbedBuilder()
        .setTitle("Ticket abierto")
        .setDescription("El equipo responderá lo antes posible. Al cerrar se guardará una transcripción completa.")
        .setColor(0x5865f2),
    ],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton)],
  });
  await recordLog(guild, "Ticket abierto", {
    targetType: "channel",
    targetId: channel.id,
    ticketId: ticket?.id,
  }, interaction.user.id, "tickets");
  await reply(interaction as ChatInputCommandInteraction, `Tu ticket está listo: ${channel}`, true);
}

async function fetchAllMessages(channel: TextChannel): Promise<Message<true>[]> {
  const all: Message<true>[] = [];
  let before: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function closeTicket(interaction: ButtonInteraction, ticketId: number) {
  const ticket = (
    await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.guildId, interaction.guildId!)))
      .limit(1)
  )[0];
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({ content: "Este ticket ya está cerrado.", ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember | null;
  const config = await getConfig(interaction.guildId!);
  const canClose =
    interaction.user.id === ticket.openerId ||
    Boolean(member?.permissions.has(PermissionFlagsBits.ManageChannels)) ||
    Boolean(config?.ticketSupportRoleId && member?.roles.cache.has(config.ticketSupportRoleId));
  if (!canClose) {
    await interaction.reply({ content: "Solo el creador, soporte o un moderador puede cerrar este ticket.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.channel;
  if (!channel?.isTextBased() || channel.type !== ChannelType.GuildText) {
    await interaction.editReply({ content: "No puedo leer el canal del ticket." });
    return;
  }
  const messages = await fetchAllMessages(channel);
  const rows = messages.map(
    (message) =>
      `<article><strong>${escapeHtml(message.author.tag)}</strong> <time>${new Date(message.createdTimestamp).toISOString()}</time><p>${escapeHtml(message.content || "[sin texto]")}</p></article>`,
  );
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Transcripción ${escapeHtml(channel.name)}</title><style>body{font-family:system-ui;background:#111827;color:#e5e7eb;padding:32px}article{border-bottom:1px solid #374151;padding:12px 0}time{color:#9ca3af;font-size:.8rem;margin-left:8px}p{white-space:pre-wrap}</style></head><body><h1>${escapeHtml(channel.name)}</h1>${rows.join("")}</body></html>`;
  await db.insert(ticketTranscripts).values({
    ticketId,
    guildId: interaction.guildId!,
    channelId: channel.id,
    content: html,
    messageCount: messages.length,
  });
  await db
    .update(tickets)
    .set({ status: "closed", closedBy: interaction.user.id, closedAt: new Date() })
    .where(eq(tickets.id, ticketId));

  const transcriptChannel = config?.ticketTranscriptsChannelId
    ? await interaction.guild!.channels.fetch(config.ticketTranscriptsChannelId).catch(() => null)
    : null;
  let transcriptStatus: "sent" | "not-configured" | "failed" = "not-configured";
  if (transcriptChannel?.isTextBased()) {
    try {
      await transcriptChannel.send({
        content: `Transcripción del ticket #${ticketId} · ${channel.name}`,
        files: [new AttachmentBuilder(Buffer.from(html, "utf8"), { name: `ticket-${ticketId}.html` })],
      });
      transcriptStatus = "sent";
    } catch (error) {
      transcriptStatus = "failed";
      logger.warn({ error, guildId: interaction.guildId, ticketId }, "Could not send ticket transcript");
    }
  }
  await recordLog(interaction.guild!, "Ticket cerrado", {
    targetType: "channel",
    targetId: channel.id,
    ticketId,
    messageCount: messages.length,
  }, interaction.user.id, "tickets");
  await interaction.editReply({
    content: transcriptStatus === "sent"
      ? "Ticket cerrado y transcripción enviada al canal configurado."
      : transcriptStatus === "failed"
        ? "Ticket cerrado. La transcripción quedó guardada en la base de datos, pero no se pudo enviar al canal; revisa los permisos del bot."
        : "Ticket cerrado. La transcripción quedó guardada en la base de datos; configura `/settranscriptschannel` para enviarla a un canal.",
  });
  await channel.delete(`Ticket ${ticketId} cerrado por ${interaction.user.tag}`).catch(() => undefined);
}

async function handleInteraction(interaction: Interaction) {
  if (!interaction.guildId || !interaction.guild) return;

  if (interaction.isChatInputCommand()) {
    if (await handleModerationCommand(interaction)) return;
    if (interaction.commandName === "panel") {
      await handlePanelCustomization(interaction);
      return;
    }
    if (interaction.commandName === "ping") {
      await showPing(interaction);
      return;
    }
    if (interaction.commandName === "help") {
      await showHelp(interaction);
      return;
    }
    if (["setlogschannel", "setreportschannel", "setticketlogschannel", "settranscriptschannel", "setwelcomechannel", "setverificationchannel", "setverifiedrole", "setticketcategory", "setticketsupport"].includes(interaction.commandName)) {
      await handleConfigCommand(interaction);
      return;
    }
    if (interaction.commandName === "create") {
      await handleCreateColorRole(interaction);
      return;
    }
    if (interaction.commandName === "colores") {
      await showColorRoles(interaction);
      return;
    }
    if (interaction.commandName === "economia") {
      await handleEconomy(interaction);
      return;
    }
    if (interaction.commandName === "nivel") {
      await handleLevel(interaction);
      return;
    }
    if (interaction.commandName === "reportar") {
      await handleReport(interaction);
      return;
    }
    if (interaction.commandName === "verification-panel") {
      await publishVerificationPanel(interaction);
      return;
    }
    if (interaction.commandName === "ticket-panel") {
      const config = await getConfig(interaction.guildId);
      const button = new ButtonBuilder().setCustomId("ticket:create").setLabel("Abrir ticket").setStyle(ButtonStyle.Primary);
      const panelChannel = interaction.channel as TextChannel | null;
      await panelChannel?.send({
        embeds: [
          createPanelEmbed(
            config?.ticketPanelTitle,
            config?.ticketPanelDescription,
            config?.ticketPanelColor,
            "Soporte",
            "Pulsa el botón para crear un canal privado con el equipo.",
          ),
        ],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      });
      await reply(interaction, "Panel de tickets publicado.");
      return;
    }
    if (interaction.commandName === "ticket") {
      await createTicket(interaction);
      return;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === "verify:complete") {
      const config = await getConfig(interaction.guildId);
      if (!config?.verifiedRoleId) {
        await interaction.reply({ content: "El rol de verificación aún no está configurado.", ephemeral: true });
        return;
      }
      const member = interaction.member as GuildMember;
      await member.roles.add(config.verifiedRoleId, "Verificación completada");
      await interaction.reply({ content: "Verificación completada. Ya tienes acceso al servidor.", ephemeral: true });
      await recordLog(interaction.guild, "Usuario verificado", { targetType: "user", targetId: interaction.user.id }, interaction.user.id);
      return;
    }
    if (interaction.customId === "ticket:create") {
      await createTicket(interaction);
      return;
    }
    if (interaction.customId.startsWith("ticket:close:")) {
      const ticketId = Number(interaction.customId.split(":")[2]);
      if (Number.isInteger(ticketId)) await closeTicket(interaction, ticketId);
      return;
    }
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "color-role:select") {
    const selectedId = interaction.values[0];
    const availableRoles = await db.select().from(colorRoles).where(eq(colorRoles.guildId, interaction.guildId));
    const selected = availableRoles.find((role) => role.roleId === selectedId);
    const member = interaction.member as GuildMember;
    if (!selected) {
      await interaction.reply({ content: "Ese rol ya no está disponible.", ephemeral: true });
      return;
    }
    const colorRoleIds = new Set(availableRoles.map((role) => role.roleId));
    const rolesToRemove = member.roles.cache
      .filter((role) => role.id !== selected.roleId && colorRoleIds.has(role.id))
      .map((role) => role.id);
    if (rolesToRemove.length) await member.roles.remove(rolesToRemove, "Cambio de autorol de color");
    await member.roles.add(selected.roleId, "Autorol de color seleccionado");
    await interaction.reply({ content: `Has elegido el color **${selected.roleName}**.`, ephemeral: true });
  }
}

async function handleMessage(message: Message<boolean>) {
  if (!message.guild || message.author.bot) return;
  const profile = await ensureProfile(message.guild.id, message.author.id);
  if (!profile) return;
  const now = new Date();
  if (profile.lastXpAt && now.getTime() - profile.lastXpAt.getTime() < 60_000) return;
  const earned = 5 + Math.floor(Math.random() * 11);
  const nextXp = profile.xp + earned;
  const threshold = profile.level * 100;
  const leveledUp = nextXp >= threshold;
  const nextLevel = leveledUp ? profile.level + 1 : profile.level;
  const nextStoredXp = leveledUp ? nextXp - threshold : nextXp;
  await db
    .update(userProfiles)
    .set({ xp: nextStoredXp, level: nextLevel, lastXpAt: now, updatedAt: now })
    .where(and(eq(userProfiles.guildId, message.guild.id), eq(userProfiles.userId, message.author.id)));
  if (leveledUp) {
    const config = await getConfig(message.guild.id);
    const channel = config?.levelUpChannelId
      ? await message.guild.channels.fetch(config.levelUpChannelId).catch(() => null)
      : message.channel;
    const levelChannel = channel as TextChannel | null;
    await levelChannel?.send(`Enhorabuena ${message.author}, has alcanzado el nivel **${nextLevel}**.`);
    await recordLog(message.guild, "Nivel aumentado", { targetType: "user", targetId: message.author.id, level: nextLevel }, message.author.id);
  }
}

async function rotateRainbowRoles(client: Client) {
  if (rainbowRotationInFlight) return;
  rainbowRotationInFlight = true;
  try {
    const roles = await db.select().from(colorRoles);
    const nextColor = nextRainbowColor();
    for (const storedRole of roles) {
      const guild = client.guilds.cache.get(storedRole.guildId);
      if (!guild) continue;
      const role = guild.roles.cache.get(storedRole.roleId);
      if (role) {
        await role.setColors({ primaryColor: nextColor }, "Rotación rápida de color rainbow").catch((error: unknown) => {
          logger.warn({ err: error, roleId: role.id }, "Rainbow role color update was rate limited or rejected");
        });
      }
    }
  } finally {
    rainbowRotationInFlight = false;
  }
}

export async function startDiscordBot(): Promise<void> {
  if (!token || !applicationId) {
    logger.warn("Discord bot disabled: DISCORD_TOKEN and DISCORD_APPLICATION_ID are required");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ].filter((intent) =>
      usePrivilegedIntents ||
      (intent !== GatewayIntentBits.GuildMembers && intent !== GatewayIntentBits.MessageContent),
    ),
  });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info({ username: readyClient.user.tag }, "Discord bot connected");
    if (!usePrivilegedIntents) {
      logger.warn(
        "Privileged Discord intents are disabled; enable DISCORD_ENABLE_PRIVILEGED_INTENTS=true after enabling Server Members and Message Content intents in the Discord Developer Portal to activate welcomes, AutoMod, and full XP/message logs",
      );
    }
    const rest = new REST({ version: "10" }).setToken(token);
    const preferredRoute =
      guildId && readyClient.guilds.cache.has(guildId)
        ? Routes.applicationGuildCommands(applicationId, guildId)
        : Routes.applicationCommands(applicationId);
    try {
      await rest.put(preferredRoute, { body: commands });
      logger.info(
        { guildId: preferredRoute.includes("/guilds/") ? guildId : "global", commandCount: commands.length },
        "Discord slash commands registered",
      );
    } catch (error: unknown) {
      if (guildId && preferredRoute.includes("/guilds/")) {
        logger.warn(
          { err: error, guildId },
          "Guild command registration was not accessible; falling back to global commands",
        );
        await rest.put(Routes.applicationCommands(applicationId), { body: commands });
        logger.info({ guildId: "global", commandCount: commands.length }, "Discord global slash commands registered");
      } else {
        logger.error({ err: error }, "Discord slash command registration failed");
      }
    }
    await rotateRainbowRoles(client);
    setInterval(() => {
      void rotateRainbowRoles(client);
    }, rainbowIntervalMs);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch((error: unknown) => {
      logger.error({ error }, "Discord interaction failed");
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        void interaction.reply({ content: "Ha ocurrido un error procesando el comando.", ephemeral: true });
      }
    });
  });
  client.on("error", (error) => {
    logger.error({ err: error }, "Discord client error");
  });
  client.on(Events.MessageCreate, (message) => {
    void (async () => {
      let caughtByAutoMod = false;
      try {
        caughtByAutoMod = await handleAutoModMessage(message);
      } catch (error) {
        logger.error({ error }, "Discord AutoMod processing failed");
      }
      if (!caughtByAutoMod) await handleMessage(message);
    })().catch((error: unknown) => logger.error({ error }, "Discord message processing failed"));
  });
  client.on(Events.GuildMemberAdd, (member) => {
    void (async () => {
      const config = await getConfig(member.guild.id);
      if (config?.welcomeChannelId) {
        const channel = await member.guild.channels.fetch(config.welcomeChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          const title = config.welcomePanelTitle || "Bienvenido/a a {server}";
          const description =
            config.welcomePanelDescription ||
            "Hola {user}, lee las normas y verifica tu cuenta para comenzar. Ya somos {memberCount} miembros.";
          const replaceWelcomeVariables = (value: string) =>
            value
              .replaceAll("{user}", `${member}`)
              .replaceAll("{server}", member.guild.name)
              .replaceAll("{memberCount}", String(member.guild.memberCount));
          const welcomeChannel = channel as TextChannel;
          await welcomeChannel.send({
            embeds: [
              createPanelEmbed(
                replaceWelcomeVariables(title),
                replaceWelcomeVariables(description),
                config.welcomePanelColor,
                "Bienvenido/a",
                `Te damos la bienvenida a ${member.guild.name}.`,
              ),
            ],
          });
        }
      }
      await recordLog(member.guild, "Miembro unido", { targetType: "user", targetId: member.id }, member.id);
    })().catch((error: unknown) => logger.error({ error }, "Discord welcome handler failed"));
  });
  client.on(Events.GuildMemberRemove, (member) => {
    void recordLog(member.guild, "Miembro salió", { targetType: "user", targetId: member.id }, member.id).catch((error: unknown) =>
      logger.error({ error }, "Discord leave log failed"),
    );
  });
  client.on(Events.MessageDelete, (message) => {
    if (message.guild) void recordLog(message.guild, "Mensaje eliminado", { targetType: "message", targetId: message.id, preview: message.content });
  });
  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    if (newMessage.guild && oldMessage.content !== newMessage.content) {
      void recordLog(newMessage.guild, "Mensaje editado", { targetType: "message", targetId: newMessage.id, before: oldMessage.content, after: newMessage.content });
    }
  });
  client.on(Events.ChannelCreate, (channel) => {
    if (channel.guild) void recordLog(channel.guild, "Canal creado", { targetType: "channel", targetId: channel.id, name: channel.name });
  });
  client.on(Events.ChannelDelete, (channel) => {
    if ("guild" in channel && channel.guild) {
      void recordLog(channel.guild, "Canal eliminado", { targetType: "channel", targetId: channel.id, name: channel.name });
    }
  });
  client.on("roleCreate", (role) => {
    void recordLog(role.guild, "Rol creado", { targetType: "role", targetId: role.id, name: role.name });
  });
  client.on("roleDelete", (role) => {
    void recordLog(role.guild, "Rol eliminado", { targetType: "role", targetId: role.id, name: role.name });
  });

  await client.login(token);
}