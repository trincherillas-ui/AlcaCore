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
  ModalBuilder,
  PermissionFlagsBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type Message,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import {
  auditLogs,
  colorRoles,
  db,
  guildConfigs,
  reports,
  ticketTypes,
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
import {
  voiceCommands,
  handleVoiceCommand,
  handleVoiceStateUpdate,
  cleanupTemporaryVoiceRooms,
} from "./voice";
import {
  reactionRoleCommands,
  handleReactionRoleAdd,
  handleReactionRoleCommand,
  handleReactionRoleRemove,
} from "./reaction-roles";
import {
  verificationCommands,
  handleVerificationButton,
  handleVerificationCommand,
  handleVerificationPanelCommand,
} from "./verification";
import { embedBuilderCommands, handleEmbedBuilderCommand } from "./embed-builder";

const token = process.env["DISCORD_TOKEN"];
const applicationId = process.env["DISCORD_APPLICATION_ID"];
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
    .setName("tickets")
    .setDescription("Configura tipos y administra tickets abiertos")
    .addSubcommand((sub) =>
      sub.setName("configurar").setDescription("Configura el máximo de tickets abiertos por usuario")
        .addIntegerOption((o) => o.setName("limite").setDescription("Máximo de tickets abiertos").setMinValue(1).setMaxValue(10).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("tipo-crear").setDescription("Crea un tipo de ticket para el menú")
        .addStringOption((o) => o.setName("clave").setDescription("Clave corta sin espacios").setRequired(true).setMaxLength(32))
        .addStringOption((o) => o.setName("nombre").setDescription("Nombre visible").setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName("descripcion").setDescription("Descripción del tipo").setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName("emoji").setDescription("Emoji opcional").setMaxLength(100))
        .addChannelOption((o) => o.setName("categoria").setDescription("Categoría para este tipo").addChannelTypes(ChannelType.GuildCategory))
        .addStringOption((o) => o.setName("roles").setDescription("Roles permitidos, separados por coma").setMaxLength(500))
        .addStringOption((o) => o.setName("preguntas").setDescription("Hasta cinco preguntas, una por línea").setMaxLength(1000)),
    )
    .addSubcommand((sub) =>
      sub.setName("tipo-editar").setDescription("Edita un tipo de ticket")
        .addStringOption((o) => o.setName("clave").setDescription("Clave del tipo").setRequired(true).setMaxLength(32))
        .addStringOption((o) => o.setName("nombre").setDescription("Nuevo nombre").setMaxLength(100))
        .addStringOption((o) => o.setName("descripcion").setDescription("Nueva descripción").setMaxLength(100))
        .addStringOption((o) => o.setName("emoji").setDescription("Nuevo emoji").setMaxLength(100))
        .addChannelOption((o) => o.setName("categoria").setDescription("Nueva categoría").addChannelTypes(ChannelType.GuildCategory))
        .addStringOption((o) => o.setName("roles").setDescription("Roles permitidos, separados por coma").setMaxLength(500))
        .addStringOption((o) => o.setName("preguntas").setDescription("Hasta cinco preguntas, una por línea").setMaxLength(1000)),
    )
    .addSubcommand((sub) =>
      sub.setName("tipo-eliminar").setDescription("Elimina un tipo de ticket")
        .addStringOption((o) => o.setName("clave").setDescription("Clave del tipo").setRequired(true).setMaxLength(32)),
    )
    .addSubcommand((sub) => sub.setName("tipos").setDescription("Lista los tipos de ticket configurados"))
    .addSubcommand((sub) => sub.setName("reclamar").setDescription("Reclama el ticket actual"))
    .addSubcommand((sub) => sub.setName("liberar").setDescription("Libera el ticket actual"))
    .addSubcommand((sub) =>
      sub.setName("agregar").setDescription("Añade un miembro al ticket actual")
        .addUserOption((o) => o.setName("usuario").setDescription("Miembro").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("quitar").setDescription("Quita un miembro del ticket actual")
        .addUserOption((o) => o.setName("usuario").setDescription("Miembro").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("renombrar").setDescription("Cambia el nombre del ticket actual")
        .addStringOption((o) => o.setName("nombre").setDescription("Nuevo nombre").setMinLength(1).setMaxLength(100).setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("transcripcion").setDescription("Genera la transcripción del ticket actual"))
    .addSubcommand((sub) => sub.setName("cerrar").setDescription("Cierra el ticket actual"))
    .addSubcommand((sub) => sub.setName("eliminar").setDescription("Guarda la transcripción y elimina el ticket actual")),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Muestra la latencia del bot"),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Muestra la lista de comandos del bot"),
  ...voiceCommands,
  ...reactionRoleCommands,
  ...verificationCommands,
  ...embedBuilderCommands,
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
      { name: "Tickets", value: "`/ticket` abre el menú de soporte; `/ticket-panel` publica el menú.\n`/tickets tipo-crear` · `/tickets tipo-editar` · `/tickets tipos`\n`/tickets reclamar` · `/tickets liberar` · `/tickets agregar` · `/tickets transcripcion` · `/tickets cerrar`" },
      { name: "Voz temporal", value: "`/voz configurar` define el canal de creación, categoría, nombre, límite y logs.\n`/voz nombre` · `/voz limite` · `/voz bloquear` · `/voz ocultar` · `/voz permitir` · `/voz propietario` · `/voz eliminar`" },
      { name: "Autoroles por reacción", value: "`/reacciones asociar` vincula emoji, mensaje y rol.\n`/reacciones desasociar` · `/reacciones listar` · `/reacciones eliminar`" },
      { name: "Verificación", value: "`/verificacion configurar` · `/verificacion activar` · `/verificacion estado`.\n`/verificacion iniciar` y `/verificacion confirmar` usan un código privado de un solo uso." },
      { name: "Embed Builder", value: "`/embed crear` · `/embed editar` · `/embed campo agregar|editar|eliminar`.\n`/embed guardar` · `/embed cargar` · `/embed enviar` · `/embed lista` · `/embed eliminar`" },
      { name: "Paneles y configuración", value: "`/panel` personaliza bienvenida, tickets, autorroles y verificación.\n`/setwelcomechannel` · `/setverificationchannel` · `/setverifiedrole`\n`/verification-panel` · `/colores` · `/settranscriptschannel`" },
      { name: "Reportes y auditoría", value: "`/reportar` envía un reporte.\n`/setlogschannel` · `/setticketlogschannel` · `/setreportschannel` · `/setticketcategory` · `/setticketsupport`" },
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

type TicketUiInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

type TicketTypeConfig = {
  guildId: string;
  typeKey: string;
  name: string;
  description: string;
  emoji: string | null;
  categoryId: string | null;
  accessRoleIds: string;
  questions: string;
  enabled: boolean;
};

function parseJsonList(value: string | null | undefined): string[] {
  try {
    const result = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(result) ? result.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseTicketAnswers(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value ?? "[]") as Array<{ question?: unknown; answer?: unknown }>;
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item.question === "string" && typeof item.answer === "string")
      : [];
  } catch {
    return [];
  }
}

async function getTicketTypes(guildId: string) {
  const types = await db.select().from(ticketTypes).where(eq(ticketTypes.guildId, guildId));
  if (types.length) return types.filter((type) => type.enabled);
  const config = await getConfig(guildId);
  await db.insert(ticketTypes).values({
    guildId,
    typeKey: "general",
    name: "Soporte general",
    description: "Habla con el equipo de soporte",
    emoji: "📩",
    categoryId: config?.ticketCategoryId ?? null,
    accessRoleIds: "[]",
    questions: "[]",
    enabled: true,
  }).onConflictDoNothing();
  return (await db.select().from(ticketTypes).where(eq(ticketTypes.guildId, guildId))).filter((type) => type.enabled);
}

async function getTicketType(guildId: string, typeKey: string): Promise<TicketTypeConfig | null> {
  return (
    await db.select().from(ticketTypes).where(and(
      eq(ticketTypes.guildId, guildId),
      eq(ticketTypes.typeKey, typeKey),
      eq(ticketTypes.enabled, true),
    )).limit(1)
  )[0] ?? null;
}

async function ticketReply(interaction: TicketUiInteraction, content: string) {
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
  else await interaction.reply({ content, ephemeral: true });
}

async function showTicketTypeMenu(interaction: ChatInputCommandInteraction | ButtonInteraction) {
  const types = await getTicketTypes(interaction.guildId!);
  const options = types.slice(0, 25).map((type) => ({
    label: type.name.slice(0, 100),
    value: type.typeKey,
    description: type.description.slice(0, 100),
    ...(type.emoji ? { emoji: type.emoji } : {}),
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket:type")
    .setPlaceholder("Selecciona el tipo de ticket")
    .addOptions(options);
  const panel = new EmbedBuilder()
    .setColor(Number.parseInt((await getConfig(interaction.guildId!))?.ticketPanelColor?.replace("#", "") ?? "5865f2", 16))
    .setTitle((await getConfig(interaction.guildId!))?.ticketPanelTitle || "Centro de soporte")
    .setDescription((await getConfig(interaction.guildId!))?.ticketPanelDescription || "Selecciona el tipo de ticket que necesitas.");
  await interaction.reply({
    embeds: [panel],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    ephemeral: true,
  });
}

async function createTicketFromSelection(
  interaction: TicketUiInteraction,
  typeKey: string,
  answers: Array<{ question: string; answer: string }>,
) {
  const guild = interaction.guild;
  if (!guild) return;
  await interaction.deferReply({ ephemeral: true });
  const config = await getConfig(guild.id);
  const openTickets = await db.select().from(tickets).where(and(
    eq(tickets.guildId, guild.id),
    eq(tickets.openerId, interaction.user.id),
    eq(tickets.status, "open"),
  ));
  const limit = config?.ticketOpenLimit ?? 1;
  if (openTickets.length >= limit) {
    await interaction.editReply({ content: `Ya tienes ${openTickets.length} ticket(s) abierto(s), el máximo es ${limit}.` });
    return;
  }
  const type = await getTicketType(guild.id, typeKey);
  if (!type) {
    await interaction.editReply({ content: "Ese tipo de ticket ya no está disponible. Vuelve a abrir el menú." });
    return;
  }
  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 18) || "usuario";
  const safeType = type.typeKey.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 18) || "ticket";
  const roleIds = new Set([
    ...(config?.ticketSupportRoleId ? [config.ticketSupportRoleId] : []),
    ...parseJsonList(type.accessRoleIds),
  ]);
  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    ...Array.from(roleIds).map((id) => ({
      id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    })),
  ];
  const categoryId = type.categoryId ?? config?.ticketCategoryId ?? undefined;
  const channel = await guild.channels.create({
    name: `${safeType}-${safeName}`.slice(0, 100),
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites,
    reason: `Ticket ${type.name} abierto por ${interaction.user.tag}`,
  });
  const inserted = await db.insert(tickets).values({
    guildId: guild.id,
    channelId: channel.id,
    openerId: interaction.user.id,
    ticketTypeKey: type.typeKey,
    answers: JSON.stringify(answers),
  }).returning();
  const ticket = inserted[0];
  const closeButton = new ButtonBuilder()
    .setCustomId(`ticket:close:${ticket?.id ?? "unknown"}`)
    .setLabel("Cerrar ticket")
    .setStyle(ButtonStyle.Danger);
  const accessMentions = Array.from(roleIds).map((id) => `<@&${id}>`).join(" ");
  const ticketEmbed = new EmbedBuilder()
    .setTitle(type.name)
    .setDescription(`${type.description}\n\nEl equipo responderá aquí. Usa el control para cerrar el ticket.`)
    .setColor(0x5865f2)
    .addFields({ name: "Abierto por", value: `${interaction.user} (${interaction.user.id})`, inline: true });
  if (answers.length) {
    ticketEmbed.addFields(answers.map((item, index) => ({
      name: `${index + 1}. ${item.question}`.slice(0, 256),
      value: item.answer.slice(0, 1024) || "[sin respuesta]",
      inline: false,
    })));
  }
  ticketEmbed.setTimestamp();
  await channel.send({
    content: `${interaction.user} · ${type.name}${accessMentions ? ` · ${accessMentions}` : ""}`,
    embeds: [ticketEmbed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton)],
  });
  await recordLog(guild, "Ticket abierto", {
    targetType: "channel",
    targetId: channel.id,
    ticketId: ticket?.id,
    type: type.typeKey,
  }, interaction.user.id, "tickets");
  await interaction.editReply({ content: `Tu ticket está listo: ${channel}` });
}

async function handleTicketTypeSelect(interaction: StringSelectMenuInteraction) {
  if (interaction.customId !== "ticket:type") return false;
  const typeKey = interaction.values[0];
  if (!typeKey) {
    await interaction.reply({ content: "Selecciona un tipo de ticket válido.", ephemeral: true });
    return true;
  }
  const type = await getTicketType(interaction.guildId!, typeKey);
  if (!type) {
    await interaction.reply({ content: "Ese tipo de ticket ya no existe.", ephemeral: true });
    return true;
  }
  const questions = parseJsonList(type.questions).slice(0, 5);
  if (!questions.length) {
    await createTicketFromSelection(interaction, typeKey, []);
    return true;
  }
  const modal = new ModalBuilder()
    .setCustomId(`ticket:answers:${typeKey}`)
    .setTitle(`Preguntas · ${type.name}`.slice(0, 45))
    .addComponents(
      ...questions.map((question, index) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(`respuesta_${index}`)
            .setLabel(question.slice(0, 45))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000),
        ),
      ),
    );
  await interaction.showModal(modal);
  return true;
}

async function handleTicketAnswers(interaction: ModalSubmitInteraction) {
  if (!interaction.customId.startsWith("ticket:answers:")) return false;
  const typeKey = interaction.customId.slice("ticket:answers:".length);
  const type = await getTicketType(interaction.guildId!, typeKey);
  if (!type) {
    await interaction.reply({ content: "Ese tipo de ticket ya no está disponible.", ephemeral: true });
    return true;
  }
  const questions = parseJsonList(type.questions).slice(0, 5);
  const answers = questions.map((question, index) => ({
    question,
    answer: interaction.fields.getTextInputValue(`respuesta_${index}`).trim(),
  }));
  await createTicketFromSelection(interaction, typeKey, answers);
  return true;
}

async function fetchAllMessages(channel: TextChannel): Promise<Message<true>[]> {
  const all: Message<true>[] = [];
  let before: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function createTicketTranscript(
  ticket: typeof tickets.$inferSelect,
  guild: Guild,
  channel: TextChannel,
) {
  const messages = await fetchAllMessages(channel);
  const answers = parseTicketAnswers(ticket.answers);
  const answerSummary = answers.length
    ? `<section><h2>Respuestas iniciales</h2><pre>${escapeHtml(answers.map((item) => `${item.question}: ${item.answer}`).join("\n"))}</pre></section>`
    : "";
  const rows = messages.map((message) => {
    const attachments = Array.from(message.attachments.values())
      .map((attachment) => `<a href="${escapeHtml(attachment.url)}">${escapeHtml(attachment.name ?? "Archivo adjunto")}</a>`)
      .join("<br>");
    return `<article><strong>${escapeHtml(message.author.tag)}</strong> <small>(${escapeHtml(message.author.id)})</small> <time>${new Date(message.createdTimestamp).toISOString()}</time><p>${escapeHtml(message.content || "[sin texto]")}</p>${attachments ? `<p>${attachments}</p>` : ""}</article>`;
  });
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Transcripción ${escapeHtml(channel.name)}</title><style>body{font-family:system-ui;background:#111827;color:#e5e7eb;padding:32px}article{border-bottom:1px solid #374151;padding:12px 0}time,small{color:#9ca3af;font-size:.8rem;margin-left:8px}p,pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#93c5fd}</style></head><body><h1>${escapeHtml(channel.name)}</h1><p>Ticket #${ticket.id} · Servidor ${escapeHtml(guild.name)}</p><p>Usuario: ${escapeHtml(ticket.openerId)} · Staff: ${escapeHtml(ticket.claimedBy ?? "Sin asignar")} · Creado: ${ticket.createdAt.toISOString()}</p>${answerSummary}${rows.join("")}</body></html>`;
  await db.insert(ticketTranscripts).values({
    ticketId: ticket.id,
    guildId: guild.id,
    channelId: channel.id,
    content: html,
    messageCount: messages.length,
  });
  const config = await getConfig(guild.id);
  const transcriptChannel = config?.ticketTranscriptsChannelId
    ? await guild.channels.fetch(config.ticketTranscriptsChannelId).catch(() => null)
    : null;
  let status: "sent" | "not-configured" | "failed" = "not-configured";
  if (transcriptChannel?.isTextBased()) {
    try {
      await transcriptChannel.send({
        content: `Transcripción del ticket #${ticket.id} · ${channel.name} · ${messages.length} mensajes`,
        files: [new AttachmentBuilder(Buffer.from(html, "utf8"), { name: `ticket-${ticket.id}.html` })],
      });
      status = "sent";
    } catch (error) {
      status = "failed";
      logger.warn({ error, guildId: guild.id, ticketId: ticket.id }, "Could not send ticket transcript");
    }
  }
  return { status, messageCount: messages.length };
}

async function closeTicket(interaction: TicketUiInteraction, ticketId: number) {
  const ticket = (
    await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.guildId, interaction.guildId!)))
      .limit(1)
  )[0];
  if (!ticket || ticket.status !== "open") {
    await ticketReply(interaction, "Este ticket ya está cerrado.");
    return;
  }

  const member = interaction.member as GuildMember | null;
  const config = await getConfig(interaction.guildId!);
  const canClose =
    interaction.user.id === ticket.openerId ||
    Boolean(member?.permissions.has(PermissionFlagsBits.ManageChannels)) ||
    Boolean(config?.ticketSupportRoleId && member?.roles.cache.has(config.ticketSupportRoleId));
  if (!canClose) {
    await ticketReply(interaction, "Solo el creador, soporte o el equipo autorizado puede cerrar este ticket.");
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const channelResult = await interaction.guild!.channels.fetch(ticket.channelId).catch(() => null);
  if (!channelResult || channelResult.type !== ChannelType.GuildText) {
    await interaction.editReply({ content: "No puedo leer el canal del ticket." });
    return;
  }
  const channel = channelResult as TextChannel;
  const transcript = await createTicketTranscript(ticket, interaction.guild!, channel);
  await db
    .update(tickets)
    .set({ status: "closed", closedBy: interaction.user.id, closedAt: new Date() })
    .where(eq(tickets.id, ticketId));
  const transcriptStatus = transcript.status;
  await recordLog(interaction.guild!, "Ticket cerrado", {
    targetType: "channel",
    targetId: channel.id,
    ticketId,
    messageCount: transcript.messageCount,
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

function isTicketStaff(member: GuildMember, config: Awaited<ReturnType<typeof getConfig>>) {
  return member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    Boolean(config?.ticketSupportRoleId && member.roles.cache.has(config.ticketSupportRoleId));
}

async function findCurrentTicket(interaction: ChatInputCommandInteraction) {
  return (
    await db.select().from(tickets).where(and(
      eq(tickets.guildId, interaction.guildId!),
      eq(tickets.channelId, interaction.channelId!),
      eq(tickets.status, "open"),
    )).limit(1)
  )[0] ?? null;
}

function parseTicketRoles(input: string) {
  if (/^(ninguno|ninguna|ningún rol)$/i.test(input.trim())) return [];
  return Array.from(new Set(input.match(/\d{17,20}/g) ?? []));
}

function parseTicketQuestions(input: string) {
  if (/^(ninguna|ninguna pregunta|sin preguntas)$/i.test(input.trim())) return [];
  return input.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

async function showPublicTicketPanel(interaction: ChatInputCommandInteraction) {
  const types = await getTicketTypes(interaction.guildId!);
  if (!types.length) {
    await interaction.reply({ content: "No hay tipos de ticket activos. Crea uno con `/tickets tipo-crear`.", ephemeral: true });
    return;
  }
  const config = await getConfig(interaction.guildId!);
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket:type")
    .setPlaceholder("Selecciona el tipo de ticket")
    .addOptions(types.slice(0, 25).map((type) => ({
      label: type.name.slice(0, 100),
      value: type.typeKey,
      description: type.description.slice(0, 100),
      ...(type.emoji ? { emoji: type.emoji } : {}),
    })));
  const channel = interaction.channel;
  if (!channel?.isTextBased() || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "Publica el panel desde un canal de texto.", ephemeral: true });
    return;
  }
  await (channel as TextChannel).send({
    embeds: [
      createPanelEmbed(
        config?.ticketPanelTitle,
        config?.ticketPanelDescription,
        config?.ticketPanelColor,
        "Centro de soporte",
        "Selecciona el tipo de ticket que necesitas.",
      ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  });
  await reply(interaction, "Panel de tickets publicado con un menú desplegable.");
}

async function handleTicketsCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName !== "tickets") return false;
  const action = interaction.options.getSubcommand();
  const member = interaction.member as GuildMember;
  const config = await getConfig(interaction.guildId!);

  if (action === "configurar") {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await reply(interaction, "Solo el equipo con permiso de gestionar el servidor puede cambiar el límite.");
      return true;
    }
    const limit = interaction.options.getInteger("limite", true);
    await updateConfig(interaction.guildId!, { ticketOpenLimit: limit });
    await reply(interaction, `El límite ahora es de ${limit} tickets abiertos por usuario.`);
    return true;
  }

  if (["tipo-crear", "tipo-editar", "tipo-eliminar", "tipos"].includes(action)) {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await reply(interaction, "Solo el equipo con permiso de gestionar el servidor puede configurar los tipos de ticket.");
      return true;
    }
    if (action === "tipos") {
      const types = await db.select().from(ticketTypes).where(eq(ticketTypes.guildId, interaction.guildId!));
      await reply(interaction, types.length
        ? types.map((type) => `${type.emoji ?? "🎫"} **${type.name}** · clave \`${type.typeKey}\` · ${type.enabled ? "activo" : "inactivo"} · ${parseJsonList(type.questions).length} pregunta(s)`).join("\n")
        : "No hay tipos de ticket configurados.");
      return true;
    }
    const key = interaction.options.getString("clave", true).trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(key)) {
      await reply(interaction, "La clave solo puede contener letras sin acento, números, guiones o guiones bajos.");
      return true;
    }
    if (action === "tipo-eliminar") {
      await db.delete(ticketTypes).where(and(eq(ticketTypes.guildId, interaction.guildId!), eq(ticketTypes.typeKey, key)));
      await reply(interaction, `He eliminado el tipo \`${key}\`.`);
      return true;
    }

    const roleInput = interaction.options.getString("roles");
    const questionInput = interaction.options.getString("preguntas");
    const roleIds = roleInput === null ? undefined : parseTicketRoles(roleInput);
    const questions = questionInput === null ? undefined : parseTicketQuestions(questionInput);
    if (questions && questions.length > 5) {
      await reply(interaction, "Cada tipo admite como máximo cinco preguntas para el formulario.");
      return true;
    }
    if (roleIds) {
      const missingRoles = [];
      for (const roleId of roleIds) {
        if (!(await interaction.guild!.roles.fetch(roleId).catch(() => null))) missingRoles.push(roleId);
      }
      if (missingRoles.length) {
        await reply(interaction, `No encuentro estos roles: ${missingRoles.map((id) => `<@&${id}>`).join(", ")}.`);
        return true;
      }
    }
    const category = interaction.options.getChannel("categoria");
    if (action === "tipo-crear") {
      const existing = await db.select().from(ticketTypes).where(eq(ticketTypes.guildId, interaction.guildId!));
      if (existing.length >= 25) {
        await reply(interaction, "Discord admite como máximo 25 opciones en el menú; elimina un tipo antes de crear otro.");
        return true;
      }
      const exists = await getTicketType(interaction.guildId!, key);
      if (exists) {
        await reply(interaction, "Ya existe un tipo con esa clave.");
        return true;
      }
      await db.insert(ticketTypes).values({
        guildId: interaction.guildId!,
        typeKey: key,
        name: interaction.options.getString("nombre", true).trim(),
        description: interaction.options.getString("descripcion", true).trim(),
        emoji: interaction.options.getString("emoji")?.trim() || null,
        categoryId: category?.id ?? config?.ticketCategoryId ?? null,
        accessRoleIds: JSON.stringify(roleIds ?? []),
        questions: JSON.stringify(questions ?? []),
        enabled: true,
      });
      await reply(interaction, `Tipo de ticket **${interaction.options.getString("nombre", true)}** creado.`);
      return true;
    }
    const updates: Partial<typeof ticketTypes.$inferInsert> = {};
    const name = interaction.options.getString("nombre");
    const description = interaction.options.getString("descripcion");
    const emoji = interaction.options.getString("emoji");
    if (name !== null) updates.name = name.trim();
    if (description !== null) updates.description = description.trim();
    if (emoji !== null) updates.emoji = emoji.trim() || null;
    if (category) updates.categoryId = category.id;
    if (roleIds) updates.accessRoleIds = JSON.stringify(roleIds);
    if (questions) updates.questions = JSON.stringify(questions);
    if (!Object.keys(updates).length) {
      await reply(interaction, "Indica al menos un valor que quieras modificar.");
      return true;
    }
    const updated = await db.update(ticketTypes).set(updates).where(and(
      eq(ticketTypes.guildId, interaction.guildId!),
      eq(ticketTypes.typeKey, key),
    )).returning();
    await reply(interaction, updated.length ? `Tipo \`${key}\` actualizado.` : "No encuentro ese tipo de ticket.");
    return true;
  }

  const ticket = await findCurrentTicket(interaction);
  if (!ticket) {
    await reply(interaction, "Usa este comando dentro de un ticket abierto.");
    return true;
  }
  const staff = isTicketStaff(member, config);
  if (action === "cerrar") {
    await closeTicket(interaction, ticket.id);
    return true;
  }
  if (action === "transcripcion" && (staff || interaction.user.id === ticket.openerId)) {
    await interaction.deferReply({ ephemeral: true });
    const channel = await interaction.guild!.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply({ content: "No encuentro el canal del ticket." });
      return true;
    }
    const result = await createTicketTranscript(ticket, interaction.guild!, channel as TextChannel);
    await recordLog(interaction.guild!, "Transcripción de ticket generada", {
      targetType: "channel",
      targetId: ticket.channelId,
      ticketId: ticket.id,
      messageCount: result.messageCount,
    }, interaction.user.id, "tickets");
    await interaction.editReply({
      content: result.status === "sent"
        ? "La transcripción se guardó y se envió al canal configurado."
        : result.status === "failed"
          ? "La transcripción se guardó en la base de datos, pero no se pudo enviar al canal."
          : "La transcripción se guardó en la base de datos; configura `/settranscriptschannel` para enviarla a un canal.",
    });
    return true;
  }
  if (!staff) {
    await reply(interaction, "Solo el equipo de soporte autorizado puede gestionar este ticket.");
    return true;
  }

  if (action === "reclamar") {
    if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
      await reply(interaction, `Este ticket ya lo ha reclamado <@${ticket.claimedBy}>.`);
      return true;
    }
    await db.update(tickets).set({ claimedBy: interaction.user.id }).where(eq(tickets.id, ticket.id));
    await recordLog(interaction.guild!, "Ticket reclamado", {
      targetType: "channel",
      targetId: ticket.channelId,
      ticketId: ticket.id,
    }, interaction.user.id, "tickets");
    if (interaction.channel?.type === ChannelType.GuildText) await (interaction.channel as TextChannel).send(`Ticket reclamado por ${interaction.user}.`);
    await reply(interaction, "Has reclamado este ticket.");
    return true;
  }
  if (action === "liberar") {
    if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id &&
        !member.permissions.has(PermissionFlagsBits.ManageChannels) &&
        !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await reply(interaction, `Solo <@${ticket.claimedBy}> o un administrador puede liberar este ticket.`);
      return true;
    }
    await db.update(tickets).set({ claimedBy: null }).where(eq(tickets.id, ticket.id));
    await recordLog(interaction.guild!, "Ticket liberado", {
      targetType: "channel",
      targetId: ticket.channelId,
      ticketId: ticket.id,
    }, interaction.user.id, "tickets");
    if (interaction.channel?.type === ChannelType.GuildText) await (interaction.channel as TextChannel).send(`Ticket liberado por ${interaction.user}.`);
    await reply(interaction, "El ticket queda disponible para el equipo.");
    return true;
  }
  if (action === "agregar" || action === "quitar") {
    const target = interaction.options.getUser("usuario", true);
    if (action === "quitar" && target.id === ticket.openerId) {
      await reply(interaction, "No se puede quitar del ticket a la persona que lo abrió.");
      return true;
    }
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await reply(interaction, "Usa este comando desde el canal de texto del ticket.");
      return true;
    }
    await (channel as TextChannel).permissionOverwrites.edit(target.id, action === "agregar"
      ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }
      : { ViewChannel: false, SendMessages: false, ReadMessageHistory: false });
    await recordLog(interaction.guild!, action === "agregar" ? "Miembro añadido al ticket" : "Miembro retirado del ticket", {
      targetType: "user",
      targetId: target.id,
      ticketId: ticket.id,
      channelId: ticket.channelId,
    }, interaction.user.id, "tickets");
    await (channel as TextChannel).send(`${target} ${action === "agregar" ? "se ha añadido al" : "ya no tiene acceso al"} ticket.`);
    await reply(interaction, `${action === "agregar" ? "Añadido" : "Quitado"} ${target} ${action === "agregar" ? "al" : "del"} ticket.`);
    return true;
  }
  if (action === "renombrar") {
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await reply(interaction, "Usa este comando desde el canal de texto del ticket.");
      return true;
    }
    const name = interaction.options.getString("nombre", true).trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
    await (channel as TextChannel).setName(name);
    await recordLog(interaction.guild!, "Ticket renombrado", {
      targetType: "channel",
      targetId: ticket.channelId,
      ticketId: ticket.id,
      name,
    }, interaction.user.id, "tickets");
    await reply(interaction, `El ticket ahora se llama **${name}**.`);
    return true;
  }
  if (action === "eliminar") {
    await interaction.deferReply({ ephemeral: true });
    const channel = await interaction.guild!.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply({ content: "No encuentro el canal del ticket." });
      return true;
    }
    const transcript = await createTicketTranscript(ticket, interaction.guild!, channel as TextChannel);
    await db.update(tickets).set({ status: "closed", closedBy: interaction.user.id, closedAt: new Date() })
      .where(eq(tickets.id, ticket.id));
    await recordLog(interaction.guild!, "Ticket eliminado", {
      targetType: "channel",
      targetId: ticket.channelId,
      ticketId: ticket.id,
      messageCount: transcript.messageCount,
    }, interaction.user.id, "tickets");
    await interaction.editReply({ content: transcript.status === "sent"
      ? "La transcripción se guardó. Eliminando el canal del ticket."
      : "La transcripción quedó guardada en la base de datos. Eliminando el canal del ticket." });
    await channel.delete(`Ticket eliminado por ${interaction.user.tag}`);
    return true;
  }
  await reply(interaction, "Ese comando de gestión no está disponible aquí.");
  return true;
}

async function handleInteraction(interaction: Interaction) {
  if (!interaction.guildId || !interaction.guild) return;

  if (interaction.isChatInputCommand()) {
    if (await handleModerationCommand(interaction)) return;
    if (await handleVoiceCommand(interaction)) return;
    if (await handleReactionRoleCommand(interaction)) return;
    if (await handleVerificationCommand(interaction)) return;
    if (await handleVerificationPanelCommand(interaction)) return;
    if (await handleEmbedBuilderCommand(interaction)) return;
    if (await handleTicketsCommand(interaction)) return;
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
    if (interaction.commandName === "ticket-panel") {
      await showPublicTicketPanel(interaction);
      return;
    }
    if (interaction.commandName === "ticket") {
      await showTicketTypeMenu(interaction);
      return;
    }
  }

  if (interaction.isButton()) {
    if (await handleVerificationButton(interaction)) return;
    if (interaction.customId === "ticket:create") {
      await showTicketTypeMenu(interaction);
      return;
    }
    if (interaction.customId.startsWith("ticket:close:")) {
      const ticketId = Number(interaction.customId.split(":")[2]);
      if (Number.isInteger(ticketId)) await closeTicket(interaction, ticketId);
      return;
    }
  }

  if (interaction.isStringSelectMenu() && await handleTicketTypeSelect(interaction)) return;

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

  if (interaction.isModalSubmit() && await handleTicketAnswers(interaction)) return;
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
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
    ].filter((intent) =>
      usePrivilegedIntents ||
      (intent !== GatewayIntentBits.GuildMembers && intent !== GatewayIntentBits.MessageContent),
    ),
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info({ username: readyClient.user.tag }, "Discord bot connected");
    if (!usePrivilegedIntents) {
      logger.warn(
        "Privileged Discord intents are disabled; enable DISCORD_ENABLE_PRIVILEGED_INTENTS=true after enabling Server Members and Message Content intents in the Discord Developer Portal to activate welcomes, AutoMod, and full XP/message logs",
      );
    }
    const rest = new REST({ version: "10" }).setToken(token);
    try {
      await rest.put(Routes.applicationCommands(applicationId), { body: commands });
      logger.info({ guildId: "global", commandCount: commands.length }, "Discord slash commands registered globally");
    } catch (error: unknown) {
      logger.error({ err: error }, "Discord global slash command registration failed");
    }
    await cleanupTemporaryVoiceRooms(readyClient).catch((error: unknown) =>
      logger.error({ error }, "Temporary voice room startup cleanup failed"),
    );
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
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    void handleVoiceStateUpdate(oldState, newState).catch((error: unknown) =>
      logger.error({ error, guildId: newState.guild.id }, "Temporary voice room processing failed"),
    );
  });
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReactionRoleAdd(reaction, user).catch((error: unknown) =>
      logger.error({ error }, "Reaction role assignment failed"),
    );
  });
  client.on(Events.MessageReactionRemove, (reaction, user) => {
    void handleReactionRoleRemove(reaction, user).catch((error: unknown) =>
      logger.error({ error }, "Reaction role removal failed"),
    );
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