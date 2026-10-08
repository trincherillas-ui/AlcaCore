import {
  ChannelType,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, guildConfigs, temporaryVoiceRooms } from "@workspace/db";

export const voiceCommands = [
  new SlashCommandBuilder()
    .setName("voz")
    .setDescription("Configura y administra salas de voz temporales")
    .addSubcommand((sub) =>
      sub
        .setName("configurar")
        .setDescription("Configura el canal de creación y los valores predeterminados")
        .addChannelOption((o) => o.setName("canal_creacion").setDescription("Canal de voz que crea salas").addChannelTypes(ChannelType.GuildVoice))
        .addChannelOption((o) => o.setName("categoria").setDescription("Categoría para las salas").addChannelTypes(ChannelType.GuildCategory))
        .addStringOption((o) => o.setName("nombre").setDescription("Admite {username} y {user}").setMaxLength(90))
        .addIntegerOption((o) => o.setName("limite").setDescription("Límite predeterminado; 0 significa sin límite").setMinValue(0).setMaxValue(99))
        .addChannelOption((o) => o.setName("canal_logs").setDescription("Canal de registros").addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((sub) => sub.setName("bloquear").setDescription("Bloquea la entrada a tu sala"))
    .addSubcommand((sub) => sub.setName("desbloquear").setDescription("Permite la entrada a tu sala"))
    .addSubcommand((sub) => sub.setName("ocultar").setDescription("Oculta tu sala"))
    .addSubcommand((sub) => sub.setName("mostrar").setDescription("Muestra tu sala"))
    .addSubcommand((sub) =>
      sub.setName("nombre").setDescription("Cambia el nombre de tu sala")
        .addStringOption((o) => o.setName("nombre").setDescription("Nuevo nombre").setMinLength(1).setMaxLength(100).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("limite").setDescription("Cambia el límite de usuarios")
        .addIntegerOption((o) => o.setName("cantidad").setDescription("0 para quitar el límite").setMinValue(0).setMaxValue(99).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("expulsar").setDescription("Expulsa a un miembro de tu sala")
        .addUserOption((o) => o.setName("usuario").setDescription("Miembro").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("permitir").setDescription("Permite entrar a un miembro")
        .addUserOption((o) => o.setName("usuario").setDescription("Miembro").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("denegar").setDescription("Impide entrar a un miembro")
        .addUserOption((o) => o.setName("usuario").setDescription("Miembro").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("propietario").setDescription("Transfiere la propiedad de la sala")
        .addUserOption((o) => o.setName("usuario").setDescription("Nuevo propietario").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("informacion").setDescription("Muestra los datos de tu sala"))
    .addSubcommand((sub) => sub.setName("eliminar").setDescription("Elimina tu sala temporal")),
];

const creatingRooms = new Set<string>();

async function recordAutomaticVoiceEvent(guild: Guild, actorId: string | null, action: string, channelId: string) {
  await db.insert(auditLogs).values({
    guildId: guild.id,
    actorId,
    action,
    targetType: "canal_de_voz",
    targetId: channelId,
  });
  const config = await getGuildConfig(guild.id);
  if (!config?.voiceLogsChannelId) return;
  const channel = await guild.channels.fetch(config.voiceLogsChannelId).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send({
      embeds: [
        new EmbedBuilder().setColor(0x5865f2).setTitle(action)
          .addFields({ name: "Sala", value: `<#${channelId}>` })
          .setTimestamp(),
      ],
    }).catch((error: unknown) => console.error("No se pudo publicar el registro de sala temporal.", error));
  }
}

export async function cleanupTemporaryVoiceRooms(client: Client) {
  const rooms = await db.select().from(temporaryVoiceRooms);
  for (const room of rooms) {
    const guild = await client.guilds.fetch(room.guildId).catch(() => null);
    if (!guild) continue;
    const channel = await guild.channels.fetch(room.channelId).catch(() => null);
    if (!channel) {
      await db.delete(temporaryVoiceRooms).where(eq(temporaryVoiceRooms.id, room.id));
      continue;
    }
    if (channel.type !== ChannelType.GuildVoice) {
      await db.delete(temporaryVoiceRooms).where(eq(temporaryVoiceRooms.id, room.id));
      continue;
    }
    if (channel.members.size === 0) {
      await db.delete(temporaryVoiceRooms).where(eq(temporaryVoiceRooms.id, room.id));
      await channel.delete("Limpieza de salas temporales vacías al iniciar el bot").catch(() => undefined);
      await recordAutomaticVoiceEvent(guild, null, "Sala temporal vacía eliminada", room.channelId);
    }
  }
}

async function getGuildConfig(guildId: string) {
  return (
    await db.select().from(guildConfigs).where(eq(guildConfigs.guildId, guildId)).limit(1)
  )[0] ?? null;
}

async function updateGuildConfig(guildId: string, values: Partial<typeof guildConfigs.$inferInsert>) {
  await db.insert(guildConfigs)
    .values({ guildId, ...values })
    .onConflictDoUpdate({ target: guildConfigs.guildId, set: { ...values, updatedAt: new Date() } });
}

async function logVoiceAction(
  interaction: ChatInputCommandInteraction,
  action: string,
  room: VoiceChannel,
  detail?: string,
) {
  await db.insert(auditLogs).values({
    guildId: interaction.guildId!,
    actorId: interaction.user.id,
    action,
    targetType: "canal_de_voz",
    targetId: room.id,
    metadata: detail ?? null,
  });
  const config = await getGuildConfig(interaction.guildId!);
  if (!config?.voiceLogsChannelId) return;
  const channel = await interaction.guild!.channels.fetch(config.voiceLogsChannelId).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`Sala temporal: ${action}`)
          .addFields(
            { name: "Sala", value: `${room.name} (<#${room.id}>)`, inline: true },
            { name: "Usuario", value: `${interaction.user} (${interaction.user.id})`, inline: true },
            ...(detail ? [{ name: "Detalle", value: detail.slice(0, 1000) }] : []),
          )
          .setTimestamp(),
      ],
    }).catch((error: unknown) => console.error("No se pudo publicar el registro de voz.", error));
  }
}

async function getOwnedRoom(interaction: ChatInputCommandInteraction) {
  const member = interaction.member as GuildMember;
  const channelId = member.voice.channelId;
  if (!channelId) return null;
  const row = (
    await db.select().from(temporaryVoiceRooms)
      .where(and(eq(temporaryVoiceRooms.guildId, interaction.guildId!), eq(temporaryVoiceRooms.channelId, channelId)))
      .limit(1)
  )[0];
  if (!row) return null;
  const channel = await interaction.guild!.channels.fetch(row.channelId).catch(() => null);
  return channel?.type === ChannelType.GuildVoice ? { row, channel } : null;
}

function mayManageRoom(interaction: ChatInputCommandInteraction, ownerId: string) {
  const member = interaction.member as GuildMember;
  return ownerId === interaction.user.id ||
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild);
}

export async function handleVoiceCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName !== "voz") return false;
  const action = interaction.options.getSubcommand();
  const member = interaction.member as GuildMember;

  if (action === "configurar") {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Solo el equipo con permiso de gestionar el servidor puede configurar las salas.", ephemeral: true });
      return true;
    }
    const createChannel = interaction.options.getChannel("canal_creacion");
    const category = interaction.options.getChannel("categoria");
    const name = interaction.options.getString("nombre");
    const limit = interaction.options.getInteger("limite");
    const logs = interaction.options.getChannel("canal_logs");
    const values: Partial<typeof guildConfigs.$inferInsert> = {};
    if (createChannel) values.voiceCreateChannelId = createChannel.id;
    if (category) values.voiceCategoryId = category.id;
    if (name !== null) values.voiceDefaultName = name.trim();
    if (limit !== null) values.voiceDefaultLimit = limit;
    if (logs) values.voiceLogsChannelId = logs.id;
    if (!Object.keys(values).length) {
      await interaction.reply({ content: "Indica al menos un valor que quieras configurar.", ephemeral: true });
      return true;
    }
    await updateGuildConfig(interaction.guildId!, values);
    await interaction.reply({ content: "La configuración de voz temporal se ha guardado.", ephemeral: true });
    return true;
  }

  const result = await getOwnedRoom(interaction);
  if (!result) {
    await interaction.reply({ content: "Entra en tu sala temporal para usar este comando.", ephemeral: true });
    return true;
  }
  const { row, channel } = result;
  if (!mayManageRoom(interaction, row.ownerId)) {
    await interaction.reply({ content: "Solo el propietario de la sala o el equipo autorizado puede gestionarla.", ephemeral: true });
    return true;
  }
  const target = interaction.options.getUser("usuario");
  switch (action) {
    case "nombre":
      await channel.setName(interaction.options.getString("nombre", true).trim());
      await logVoiceAction(interaction, "nombre cambiado", channel);
      await interaction.reply({ content: "He cambiado el nombre de la sala.", ephemeral: true });
      break;
    case "limite": {
      const limit = interaction.options.getInteger("cantidad", true);
      await channel.setUserLimit(limit);
      await logVoiceAction(interaction, "límite cambiado", channel, String(limit));
      await interaction.reply({ content: limit ? `El límite ahora es ${limit}.` : "La sala ya no tiene límite.", ephemeral: true });
      break;
    }
    case "bloquear":
      await channel.permissionOverwrites.edit(interaction.guild!.roles.everyone, { Connect: false });
      await logVoiceAction(interaction, "entrada bloqueada", channel);
      await interaction.reply({ content: "He bloqueado la entrada a la sala.", ephemeral: true });
      break;
    case "desbloquear":
      await channel.permissionOverwrites.edit(interaction.guild!.roles.everyone, { Connect: null });
      await logVoiceAction(interaction, "entrada permitida", channel);
      await interaction.reply({ content: "La entrada a la sala vuelve a estar permitida.", ephemeral: true });
      break;
    case "ocultar":
      await channel.permissionOverwrites.edit(interaction.guild!.roles.everyone, { ViewChannel: false });
      await logVoiceAction(interaction, "sala ocultada", channel);
      await interaction.reply({ content: "He ocultado la sala.", ephemeral: true });
      break;
    case "mostrar":
      await channel.permissionOverwrites.edit(interaction.guild!.roles.everyone, { ViewChannel: null });
      await logVoiceAction(interaction, "sala visible", channel);
      await interaction.reply({ content: "La sala vuelve a estar visible.", ephemeral: true });
      break;
    case "expulsar": {
      if (!target) break;
      const targetMember = await interaction.guild!.members.fetch(target.id).catch(() => null);
      if (!targetMember || targetMember.voice.channelId !== channel.id) {
        await interaction.reply({ content: "Ese usuario no está en tu sala.", ephemeral: true });
        break;
      }
      await targetMember.voice.disconnect("Expulsado de una sala de voz temporal");
      await logVoiceAction(interaction, "miembro expulsado", channel, target.tag);
      await interaction.reply({ content: `He expulsado a ${target} de la sala.`, ephemeral: true });
      break;
    }
    case "permitir":
    case "denegar": {
      if (!target) break;
      await channel.permissionOverwrites.edit(target.id, action === "permitir"
        ? { ViewChannel: true, Connect: true }
        : { Connect: false });
      await logVoiceAction(interaction, action === "permitir" ? "usuario permitido" : "usuario denegado", channel, target.tag);
      await interaction.reply({ content: action === "permitir" ? `He permitido entrar a ${target}.` : `He bloqueado la entrada de ${target}.`, ephemeral: true });
      break;
    }
    case "propietario": {
      if (!target || target.bot) {
        await interaction.reply({ content: "El nuevo propietario debe ser un miembro del servidor.", ephemeral: true });
        break;
      }
      const targetMember = await interaction.guild!.members.fetch(target.id).catch(() => null);
      if (!targetMember || targetMember.voice.channelId !== channel.id) {
        await interaction.reply({ content: "El nuevo propietario debe estar en la sala.", ephemeral: true });
        break;
      }
      if (target.id === row.ownerId) {
        await interaction.reply({ content: "Ese usuario ya es el propietario de la sala.", ephemeral: true });
        break;
      }
      await channel.permissionOverwrites.edit(target.id, { ManageChannels: true, Connect: true, ViewChannel: true });
      await channel.permissionOverwrites.edit(row.ownerId, { ManageChannels: null });
      await db.update(temporaryVoiceRooms).set({ ownerId: target.id }).where(eq(temporaryVoiceRooms.id, row.id));
      await logVoiceAction(interaction, "propiedad transferida", channel, target.tag);
      await interaction.reply({ content: `${target} ahora es propietario de la sala.`, ephemeral: true });
      break;
    }
    case "informacion":
      await interaction.reply({
        content: `**Sala:** ${channel.name}\n**Propietario:** <@${row.ownerId}>\n**Miembros:** ${channel.members.size}\n**Límite:** ${channel.userLimit || "Sin límite"}`,
        ephemeral: true,
      });
      break;
    case "eliminar":
      await db.delete(temporaryVoiceRooms).where(eq(temporaryVoiceRooms.id, row.id));
      await logVoiceAction(interaction, "sala eliminada", channel);
      await interaction.reply({ content: "He eliminado la sala temporal.", ephemeral: true });
      await channel.delete(`Sala temporal eliminada por ${interaction.user.tag}`);
      break;
    default:
      await interaction.reply({ content: "Ese comando de voz no está disponible.", ephemeral: true });
  }
  return true;
}

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
  const member = newState.member ?? oldState.member;
  const guild = newState.guild;
  if (!member || member.user.bot) return;

  if (newState.channelId && newState.channelId !== oldState.channelId) {
    const config = await getGuildConfig(guild.id);
    if (config?.voiceCreateChannelId === newState.channelId) {
      const lockKey = `${guild.id}:${member.id}`;
      if (!creatingRooms.has(lockKey)) {
        creatingRooms.add(lockKey);
        try {
          const defaultName = config.voiceDefaultName || "Sala de {username}";
          const roomName = defaultName
            .replaceAll("{username}", member.user.username)
            .replaceAll("{user}", member.user.username)
            .slice(0, 100);
          const room = await guild.channels.create({
            name: roomName,
            type: ChannelType.GuildVoice,
            parent: config.voiceCategoryId ?? undefined,
            userLimit: config.voiceDefaultLimit ?? 0,
            permissionOverwrites: [
              { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
              { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ManageChannels] },
            ],
            reason: `Sala temporal creada para ${member.user.tag}`,
          });
          const record = await db.insert(temporaryVoiceRooms)
            .values({ guildId: guild.id, channelId: room.id, ownerId: member.id })
            .returning({ id: temporaryVoiceRooms.id });
          try {
            await member.voice.setChannel(room, "Entrada al canal de creación");
          } catch (error) {
            await db.delete(temporaryVoiceRooms).where(eq(temporaryVoiceRooms.channelId, room.id));
            await room.delete("No se pudo mover al propietario a la sala temporal").catch(() => undefined);
            throw error;
          }
          const currentConfig = await getGuildConfig(guild.id);
          await db.insert(auditLogs).values({
            guildId: guild.id,
            actorId: member.id,
            action: "Sala temporal creada",
            targetType: "canal_de_voz",
            targetId: room.id,
            metadata: `propietario:${member.id};registro:${record[0]?.id ?? ""}`,
          });
          if (currentConfig?.voiceLogsChannelId) {
            const logChannel = await guild.channels.fetch(currentConfig.voiceLogsChannelId).catch(() => null);
            if (logChannel?.isTextBased()) {
              await logChannel.send({
                embeds: [
                  new EmbedBuilder().setColor(0x5865f2).setTitle("Sala de voz creada")
                    .addFields({ name: "Sala", value: `${room} (${room.name})` }, { name: "Propietario", value: `${member} (${member.id})` })
                    .setTimestamp(),
                ],
              });
            }
          }
        } finally {
          creatingRooms.delete(lockKey);
        }
      }
    }
  }

  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const row = (
      await db.select().from(temporaryVoiceRooms)
        .where(and(eq(temporaryVoiceRooms.guildId, guild.id), eq(temporaryVoiceRooms.channelId, oldState.channelId)))
        .limit(1)
    )[0];
    if (row && oldState.channel?.members.size === 0) {
      await db.delete(temporaryVoiceRooms).where(eq(temporaryVoiceRooms.id, row.id));
      await oldState.channel.delete("Sala temporal vacía").catch(() => undefined);
      await recordAutomaticVoiceEvent(guild, member.id, "Sala temporal vacía eliminada", oldState.channelId);
    }
  }
}
