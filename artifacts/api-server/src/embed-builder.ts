import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, embedTemplates } from "@workspace/db";

type EmbedField = { name: string; value: string; inline: boolean };
type EmbedDefinition = {
  title?: string;
  description?: string;
  color?: string;
  url?: string;
  author?: string;
  authorUrl?: string;
  authorIconUrl?: string;
  thumbnail?: string;
  image?: string;
  footer?: string;
  footerIconUrl?: string;
  timestamp?: boolean;
  fields: EmbedField[];
};

export const embedBuilderCommands = [
  new SlashCommandBuilder()
    .setName("embed")
    .setDescription("Crea, edita, guarda y envía embeds reutilizables")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand((sub) =>
      sub.setName("crear").setDescription("Crea un borrador de embed")
        .addStringOption((o) => o.setName("nombre").setDescription("Nombre para reutilizarlo").setMinLength(1).setMaxLength(50).setRequired(true))
        .addStringOption((o) => o.setName("titulo").setDescription("Título del embed").setMaxLength(256))
        .addStringOption((o) => o.setName("descripcion").setDescription("Descripción").setMaxLength(4096))
        .addStringOption((o) => o.setName("color").setDescription("Color hexadecimal, por ejemplo #5865F2")),
    )
    .addSubcommand((sub) =>
      sub.setName("editar").setDescription("Actualiza elementos y muestra una vista previa")
        .addStringOption((o) => o.setName("nombre").setDescription("Nombre del borrador o embed guardado").setMinLength(1).setMaxLength(50).setRequired(true))
        .addStringOption((o) => o.setName("titulo").setDescription("Nuevo título").setMaxLength(256))
        .addStringOption((o) => o.setName("descripcion").setDescription("Nueva descripción").setMaxLength(4096))
        .addStringOption((o) => o.setName("color").setDescription("Color hexadecimal"))
        .addStringOption((o) => o.setName("url").setDescription("Enlace del título"))
        .addStringOption((o) => o.setName("autor").setDescription("Nombre del autor").setMaxLength(256))
        .addStringOption((o) => o.setName("autor_url").setDescription("Enlace del autor"))
        .addStringOption((o) => o.setName("autor_icono").setDescription("URL del icono del autor"))
        .addStringOption((o) => o.setName("miniatura").setDescription("URL de la miniatura"))
        .addStringOption((o) => o.setName("imagen").setDescription("URL de la imagen"))
        .addStringOption((o) => o.setName("pie").setDescription("Texto del pie").setMaxLength(2048))
        .addStringOption((o) => o.setName("pie_icono").setDescription("URL del icono del pie"))
        .addBooleanOption((o) => o.setName("timestamp").setDescription("Muestra la fecha y hora actual")),
    )
    .addSubcommand((sub) =>
      sub.setName("guardar").setDescription("Guarda el borrador para reutilizarlo")
        .addStringOption((o) => o.setName("nombre").setDescription("Nombre del embed").setMinLength(1).setMaxLength(50).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("cargar").setDescription("Carga un embed y muestra su vista previa")
        .addStringOption((o) => o.setName("nombre").setDescription("Nombre guardado").setMinLength(1).setMaxLength(50).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("enviar").setDescription("Publica un embed guardado")
        .addStringOption((o) => o.setName("nombre").setDescription("Nombre guardado").setMinLength(1).setMaxLength(50).setRequired(true))
        .addChannelOption((o) => o.setName("canal").setDescription("Canal donde enviarlo").addChannelTypes(ChannelType.GuildText).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("eliminar").setDescription("Elimina un borrador o embed guardado")
        .addStringOption((o) => o.setName("nombre").setDescription("Nombre del embed").setMinLength(1).setMaxLength(50).setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("lista").setDescription("Lista tus borradores y embeds guardados"))
    .addSubcommandGroup((group) =>
      group.setName("campo").setDescription("Administra campos individuales")
        .addSubcommand((sub) =>
          sub.setName("agregar").setDescription("Añade un campo")
            .addStringOption((o) => o.setName("nombre").setDescription("Nombre del embed").setRequired(true).setMaxLength(50))
            .addStringOption((o) => o.setName("campo").setDescription("Nombre del campo").setRequired(true).setMaxLength(256))
            .addStringOption((o) => o.setName("valor").setDescription("Valor del campo").setRequired(true).setMaxLength(1024))
            .addBooleanOption((o) => o.setName("inline").setDescription("Muestra el campo en línea")),
        )
        .addSubcommand((sub) =>
          sub.setName("editar").setDescription("Edita un campo por su posición")
            .addStringOption((o) => o.setName("nombre").setDescription("Nombre del embed").setRequired(true).setMaxLength(50))
            .addIntegerOption((o) => o.setName("indice").setDescription("Posición, empezando por 1").setRequired(true).setMinValue(1).setMaxValue(25))
            .addStringOption((o) => o.setName("campo").setDescription("Nuevo nombre").setMaxLength(256))
            .addStringOption((o) => o.setName("valor").setDescription("Nuevo valor").setMaxLength(1024))
            .addBooleanOption((o) => o.setName("inline").setDescription("Muestra el campo en línea")),
        )
        .addSubcommand((sub) =>
          sub.setName("eliminar").setDescription("Elimina un campo por su posición")
            .addStringOption((o) => o.setName("nombre").setDescription("Nombre del embed").setRequired(true).setMaxLength(50))
            .addIntegerOption((o) => o.setName("indice").setDescription("Posición, empezando por 1").setRequired(true).setMinValue(1).setMaxValue(25)),
        ),
    ),
];

function parseDefinition(value: string): EmbedDefinition | null {
  try {
    const parsed = JSON.parse(value) as EmbedDefinition;
    return { ...parsed, fields: Array.isArray(parsed.fields) ? parsed.fields : [] };
  } catch {
    return null;
  }
}

function safeUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function toDiscordEmbed(definition: EmbedDefinition) {
  const embed = new EmbedBuilder();
  if (definition.title) embed.setTitle(definition.title);
  if (definition.description) embed.setDescription(definition.description);
  if (definition.color) embed.setColor(Number.parseInt(definition.color.replace("#", ""), 16));
  const url = safeUrl(definition.url);
  if (url) embed.setURL(url);
  if (definition.author) {
    embed.setAuthor({
      name: definition.author,
      ...(safeUrl(definition.authorUrl) ? { url: safeUrl(definition.authorUrl) } : {}),
      ...(safeUrl(definition.authorIconUrl) ? { iconURL: safeUrl(definition.authorIconUrl) } : {}),
    });
  }
  if (safeUrl(definition.thumbnail)) embed.setThumbnail(safeUrl(definition.thumbnail)!);
  if (safeUrl(definition.image)) embed.setImage(safeUrl(definition.image)!);
  if (definition.footer) {
    embed.setFooter({
      text: definition.footer,
      ...(safeUrl(definition.footerIconUrl) ? { iconURL: safeUrl(definition.footerIconUrl) } : {}),
    });
  }
  if (definition.timestamp) embed.setTimestamp();
  if (definition.fields?.length) embed.addFields(definition.fields);
  return embed;
}

function hasEmbedContent(definition: EmbedDefinition) {
  return Boolean(
    definition.title || definition.description || definition.author || definition.footer ||
    definition.fields.length || definition.image || definition.thumbnail,
  );
}

function validateDefinition(definition: EmbedDefinition) {
  if (definition.fields.length > 25) return "Discord permite como máximo 25 campos por embed.";
  if (definition.fields.some((field) => !field.name.trim() || !field.value.trim())) {
    return "El nombre y el valor de cada campo deben tener contenido.";
  }
  const textLength =
    (definition.title?.length ?? 0) +
    (definition.description?.length ?? 0) +
    (definition.author?.length ?? 0) +
    (definition.footer?.length ?? 0) +
    definition.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  if (textLength > 6000) return "El texto total del embed supera el límite de Discord de 6.000 caracteres.";
  return null;
}

async function getEmbed(guildId: string, name: string) {
  return (
    await db.select().from(embedTemplates).where(and(
      eq(embedTemplates.guildId, guildId),
      eq(embedTemplates.name, name.toLowerCase()),
    )).limit(1)
  )[0] ?? null;
}

async function saveDefinition(
  guildId: string,
  name: string,
  definition: EmbedDefinition,
  updatedBy: string,
  saved?: boolean,
) {
  const previous = await getEmbed(guildId, name);
  await db.insert(embedTemplates).values({
    guildId,
    name: name.toLowerCase(),
    definition: JSON.stringify(definition),
    saved: saved ?? previous?.saved ?? false,
    updatedBy,
  }).onConflictDoUpdate({
    target: [embedTemplates.guildId, embedTemplates.name],
    set: {
      definition: JSON.stringify(definition),
      updatedBy,
      updatedAt: new Date(),
      ...(saved === undefined ? {} : { saved }),
    },
  });
}

async function preview(interaction: ChatInputCommandInteraction, name: string, definition: EmbedDefinition, saved: boolean) {
  await interaction.reply({
    content: `Vista previa de **${name}** (${saved ? "guardado" : "borrador"}).`,
    ...(hasEmbedContent(definition) ? { embeds: [toDiscordEmbed(definition)] } : {}),
    ephemeral: true,
  });
}

async function handleBaseSubcommand(interaction: ChatInputCommandInteraction, action: string) {
  const name = interaction.options.getString("nombre", true).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,50}$/.test(name)) {
    await interaction.reply({ content: "Usa un nombre de 1 a 50 caracteres: letras, números, guion o guion bajo.", ephemeral: true });
    return;
  }
  const current = await getEmbed(interaction.guildId!, name);
  if (action === "crear") {
    if (current) {
      await interaction.reply({ content: "Ya existe un embed con ese nombre.", ephemeral: true });
      return;
    }
    const colorInput = interaction.options.getString("color");
    const color = colorInput?.trim();
    if (color && !/^#?[0-9a-fA-F]{6}$/.test(color)) {
      await interaction.reply({ content: "El color debe ser hexadecimal de seis caracteres.", ephemeral: true });
      return;
    }
    const definition: EmbedDefinition = {
      fields: [],
      ...(interaction.options.getString("titulo") ? { title: interaction.options.getString("titulo", true) } : {}),
      ...(interaction.options.getString("descripcion") ? { description: interaction.options.getString("descripcion", true) } : {}),
      ...(color ? { color: color.startsWith("#") ? color.toUpperCase() : `#${color.toUpperCase()}` } : {}),
    };
    await saveDefinition(interaction.guildId!, name, definition, interaction.user.id, false);
    await preview(interaction, name, definition, false);
    return;
  }
  if (!current) {
    await interaction.reply({ content: "No existe ningún embed con ese nombre.", ephemeral: true });
    return;
  }
  if (action === "eliminar") {
    await db.delete(embedTemplates).where(and(eq(embedTemplates.guildId, interaction.guildId!), eq(embedTemplates.name, name)));
    await interaction.reply({ content: `He eliminado **${name}**.`, ephemeral: true });
    return;
  }
  const definition = parseDefinition(current.definition);
  if (!definition) {
    await interaction.reply({ content: "El contenido guardado no es válido.", ephemeral: true });
    return;
  }
  if (action === "guardar") {
    const validation = validateDefinition(definition);
    if (validation) {
      await interaction.reply({ content: validation, ephemeral: true });
      return;
    }
    if (!hasEmbedContent(definition)) {
      await interaction.reply({ content: "Añade al menos un elemento antes de guardar el embed.", ephemeral: true });
      return;
    }
    await db.update(embedTemplates).set({ saved: true, updatedBy: interaction.user.id, updatedAt: new Date() })
      .where(and(eq(embedTemplates.guildId, interaction.guildId!), eq(embedTemplates.name, name)));
    await preview(interaction, name, definition, true);
    return;
  }
  if (action === "cargar") {
    if (!current.saved) {
      await interaction.reply({ content: "Ese embed aún es un borrador. Usa `/embed guardar` antes de cargarlo.", ephemeral: true });
      return;
    }
    await preview(interaction, name, definition, true);
    return;
  }
  if (action === "enviar") {
    if (!current.saved) {
      await interaction.reply({ content: "Guarda el embed antes de enviarlo.", ephemeral: true });
      return;
    }
    const validation = validateDefinition(definition);
    if (validation || !hasEmbedContent(definition)) {
      await interaction.reply({ content: validation ?? "Añade contenido antes de enviar el embed.", ephemeral: true });
      return;
    }
    const channel = interaction.options.getChannel("canal");
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Elige un canal de texto válido.", ephemeral: true });
      return;
    }
    await (channel as TextChannel).send({ embeds: [toDiscordEmbed(definition)] });
    await interaction.reply({ content: `Embed **${name}** enviado a ${channel}.`, ephemeral: true });
  }
}

async function editEmbed(interaction: ChatInputCommandInteraction) {
  const name = interaction.options.getString("nombre", true).trim().toLowerCase();
  const current = await getEmbed(interaction.guildId!, name);
  if (!current) {
    await interaction.reply({ content: "No existe ningún embed con ese nombre. Usa `/embed crear` primero.", ephemeral: true });
    return;
  }
  const definition = parseDefinition(current.definition);
  if (!definition) {
    await interaction.reply({ content: "El contenido guardado no es válido.", ephemeral: true });
    return;
  }
  const stringFields: Array<[string, keyof EmbedDefinition]> = [
    ["titulo", "title"], ["descripcion", "description"], ["url", "url"], ["autor", "author"],
    ["autor_url", "authorUrl"], ["autor_icono", "authorIconUrl"], ["miniatura", "thumbnail"],
    ["imagen", "image"], ["pie", "footer"], ["pie_icono", "footerIconUrl"],
  ];
  for (const [option, key] of stringFields) {
    const value = interaction.options.getString(option);
    if (value !== null) (definition as Record<string, unknown>)[key] = value.trim();
  }
  const color = interaction.options.getString("color");
  if (color !== null) {
    if (!/^#?[0-9a-fA-F]{6}$/.test(color.trim())) {
      await interaction.reply({ content: "El color debe ser hexadecimal de seis caracteres.", ephemeral: true });
      return;
    }
    definition.color = color.trim().startsWith("#") ? color.trim().toUpperCase() : `#${color.trim().toUpperCase()}`;
  }
  const timestamp = interaction.options.getBoolean("timestamp");
  if (timestamp !== null) definition.timestamp = timestamp;
  for (const key of ["url", "authorUrl", "authorIconUrl", "thumbnail", "image", "footerIconUrl"] as const) {
    const value = definition[key];
    if (value && !safeUrl(value)) {
      await interaction.reply({ content: `El valor de ${key} debe ser una URL HTTP o HTTPS válida.`, ephemeral: true });
      return;
    }
  }
  const validation = validateDefinition(definition);
  if (validation) {
    await interaction.reply({ content: validation, ephemeral: true });
    return;
  }
  await saveDefinition(interaction.guildId!, name, definition, interaction.user.id);
  await preview(interaction, name, definition, current.saved);
}

async function editField(interaction: ChatInputCommandInteraction, action: string) {
  const name = interaction.options.getString("nombre", true).trim().toLowerCase();
  const current = await getEmbed(interaction.guildId!, name);
  const definition = current ? parseDefinition(current.definition) : null;
  if (!current || !definition) {
    await interaction.reply({ content: "No existe un embed válido con ese nombre.", ephemeral: true });
    return;
  }
  if (action === "agregar") {
    if (definition.fields.length >= 25) {
      await interaction.reply({ content: "Discord permite como máximo 25 campos por embed.", ephemeral: true });
      return;
    }
    definition.fields.push({
      name: interaction.options.getString("campo", true).trim(),
      value: interaction.options.getString("valor", true).trim(),
      inline: interaction.options.getBoolean("inline") ?? false,
    });
  } else {
    const index = interaction.options.getInteger("indice", true) - 1;
    if (!definition.fields[index]) {
      await interaction.reply({ content: "No hay un campo en esa posición.", ephemeral: true });
      return;
    }
    if (action === "eliminar") definition.fields.splice(index, 1);
    else {
      const field = definition.fields[index]!;
      const fieldName = interaction.options.getString("campo");
      const value = interaction.options.getString("valor");
      const inline = interaction.options.getBoolean("inline");
      if (fieldName !== null) field.name = fieldName.trim();
      if (value !== null) field.value = value.trim();
      if (inline !== null) field.inline = inline;
    }
  }
  const validation = validateDefinition(definition);
  if (validation) {
    await interaction.reply({ content: validation, ephemeral: true });
    return;
  }
  await saveDefinition(interaction.guildId!, name, definition, interaction.user.id);
  await preview(interaction, name, definition, current.saved);
}

export async function handleEmbedBuilderCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName !== "embed") return false;
  if (!(interaction.member as GuildMember).permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Solo el equipo con permiso de gestionar el servidor puede usar el editor de embeds.", ephemeral: true });
    return true;
  }
  if (interaction.options.getSubcommandGroup(false) === "campo") {
    await editField(interaction, interaction.options.getSubcommand());
    return true;
  }
  const action = interaction.options.getSubcommand();
  if (action === "lista") {
    const rows = await db.select().from(embedTemplates).where(eq(embedTemplates.guildId, interaction.guildId!));
    await interaction.reply({
      content: rows.length
        ? rows.map((row) => `• **${row.name}** — ${row.saved ? "guardado" : "borrador"}`).join("\n")
        : "Todavía no hay borradores ni embeds guardados.",
      ephemeral: true,
    });
    return true;
  }
  if (action === "editar") {
    await editEmbed(interaction);
    return true;
  }
  await handleBaseSubcommand(interaction, action);
  return true;
}
