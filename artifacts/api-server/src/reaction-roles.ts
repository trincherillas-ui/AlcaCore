import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, reactionRoleMappings } from "@workspace/db";

export const reactionRoleCommands = [
  new SlashCommandBuilder()
    .setName("reacciones")
    .setDescription("Configura autoroles por reacciones")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles.toString())
    .addSubcommand((sub) =>
      sub.setName("asociar").setDescription("Asocia una reacción de un mensaje con un rol")
        .addChannelOption((o) => o.setName("canal").setDescription("Canal del mensaje").addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addStringOption((o) => o.setName("mensaje").setDescription("ID del mensaje del panel").setMinLength(17).setMaxLength(20).setRequired(true))
        .addStringOption((o) => o.setName("emoji").setDescription("Emoji Unicode o personalizado del servidor").setMaxLength(100).setRequired(true))
        .addRoleOption((o) => o.setName("rol").setDescription("Rol que se asignará").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("desasociar").setDescription("Elimina una asociación de reacción")
        .addChannelOption((o) => o.setName("canal").setDescription("Canal del mensaje").addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addStringOption((o) => o.setName("mensaje").setDescription("ID del mensaje").setMinLength(17).setMaxLength(20).setRequired(true))
        .addStringOption((o) => o.setName("emoji").setDescription("Emoji asociado").setMaxLength(100).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("listar").setDescription("Muestra las asociaciones de un mensaje")
        .addChannelOption((o) => o.setName("canal").setDescription("Canal del mensaje").addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addStringOption((o) => o.setName("mensaje").setDescription("ID del mensaje").setMinLength(17).setMaxLength(20).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("eliminar").setDescription("Elimina todas las asociaciones de un panel")
        .addChannelOption((o) => o.setName("canal").setDescription("Canal del mensaje").addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addStringOption((o) => o.setName("mensaje").setDescription("ID del mensaje").setMinLength(17).setMaxLength(20).setRequired(true)),
    ),
];

function parseEmoji(input: string) {
  const custom = input.match(/^<a?:([a-zA-Z0-9_]{2,32}):(\d{17,20})>$/);
  if (custom) {
    return { key: `custom:${custom[2]}`, display: input, reactValue: `${custom[1]}:${custom[2]}` };
  }
  if (/^\d{17,20}$/.test(input)) {
    return { key: `custom:${input}`, display: input, reactValue: input };
  }
  if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(input)) {
    throw new Error("Usa un emoji Unicode o una mención de emoji personalizado válida.");
  }
  return { key: `unicode:${input}`, display: input, reactValue: input };
}

export async function handleReactionRoleCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName !== "reacciones") return false;
  const subcommand = interaction.options.getSubcommand();
  const selectedChannel = interaction.options.getChannel("canal");
  const messageId = interaction.options.getString("mensaje", true);
  if (!selectedChannel || selectedChannel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "Elige un canal de texto válido.", ephemeral: true });
    return true;
  }
  const channel = await interaction.guild!.channels.fetch(selectedChannel.id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "No puedo acceder a ese canal de texto.", ephemeral: true });
    return true;
  }

  if (subcommand === "listar") {
    const rows = await db.select().from(reactionRoleMappings)
      .where(and(eq(reactionRoleMappings.guildId, interaction.guildId!), eq(reactionRoleMappings.messageId, messageId)));
    const inChannel = rows.filter((row) => row.channelId === channel.id);
    await interaction.reply({
      content: inChannel.length
        ? inChannel.map((row) => `${row.emojiDisplay} → <@&${row.roleId}>`).join("\n")
        : "Ese mensaje todavía no tiene autoroles configurados.",
      ephemeral: true,
    });
    return true;
  }

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) {
    await interaction.reply({ content: "No encuentro ese mensaje o el bot no puede leerlo.", ephemeral: true });
    return true;
  }

  if (subcommand === "eliminar") {
    const rows = await db.select().from(reactionRoleMappings)
      .where(and(eq(reactionRoleMappings.guildId, interaction.guildId!), eq(reactionRoleMappings.messageId, messageId)));
    const inChannel = rows.filter((row) => row.channelId === channel.id);
    await db.delete(reactionRoleMappings)
      .where(and(eq(reactionRoleMappings.guildId, interaction.guildId!), eq(reactionRoleMappings.messageId, messageId)));
    for (const row of inChannel) {
      const reaction = message.reactions.cache.find((candidate) => reactionKey(candidate) === row.emojiKey);
      if (reaction) await reaction.users.remove(interaction.client.user.id).catch(() => undefined);
    }
    await interaction.reply({ content: `He eliminado ${inChannel.length} asociación(es) de ese panel.`, ephemeral: true });
    return true;
  }

  let emoji: ReturnType<typeof parseEmoji>;
  try {
    emoji = parseEmoji(interaction.options.getString("emoji", true).trim());
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : "El emoji no es válido.", ephemeral: true });
    return true;
  }

  if (subcommand === "desasociar") {
    await db.delete(reactionRoleMappings).where(and(
      eq(reactionRoleMappings.guildId, interaction.guildId!),
      eq(reactionRoleMappings.messageId, messageId),
      eq(reactionRoleMappings.emojiKey, emoji.key),
    ));
    const reaction = message.reactions.cache.find((candidate) => reactionKey(candidate) === emoji.key);
    if (reaction) await reaction.users.remove(interaction.client.user.id).catch(() => undefined);
    await interaction.reply({ content: `He eliminado la asociación ${emoji.display}.`, ephemeral: true });
    return true;
  }

  if (subcommand === "asociar") {
    const role = interaction.options.getRole("rol", true);
    const botMember = interaction.guild!.members.me;
    if (role.id === interaction.guildId || role.managed ||
        !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
        role.position >= botMember.roles.highest.position) {
      await interaction.reply({ content: "El bot necesita Gestionar roles y tener su rol por encima del rol elegido.", ephemeral: true });
      return true;
    }
    try {
      await message.react(emoji.reactValue);
      await db.insert(reactionRoleMappings).values({
        guildId: interaction.guildId!,
        channelId: channel.id,
        messageId,
        emojiKey: emoji.key,
        emojiDisplay: emoji.display,
        roleId: role.id,
        createdBy: interaction.user.id,
      }).onConflictDoUpdate({
        target: [reactionRoleMappings.guildId, reactionRoleMappings.messageId, reactionRoleMappings.emojiKey],
        set: { channelId: channel.id, emojiDisplay: emoji.display, roleId: role.id, createdBy: interaction.user.id },
      });
      await interaction.reply({ content: `${emoji.display} ahora asigna ${role} y lo retira al quitar la reacción.`, ephemeral: true });
    } catch {
      await interaction.reply({ content: "No pude añadir la reacción. Revisa los permisos del bot y que el emoji esté disponible.", ephemeral: true });
    }
    return true;
  }
  return true;
}

function reactionKey(reaction: MessageReaction | PartialMessageReaction) {
  return reaction.emoji.id ? `custom:${reaction.emoji.id}` : `unicode:${reaction.emoji.name ?? ""}`;
}

async function applyReactionRole(
  reactionInput: MessageReaction | PartialMessageReaction,
  userInput: User | PartialUser,
  add: boolean,
) {
  const user = userInput.partial ? await userInput.fetch().catch(() => null) : userInput;
  if (!user) return;
  if (user.bot) return;
  const reaction = reactionInput.partial ? await reactionInput.fetch().catch(() => null) : reactionInput;
  if (!reaction) return;
  const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
  if (!message?.guild) return;
  const mapping = (
    await db.select().from(reactionRoleMappings).where(and(
      eq(reactionRoleMappings.guildId, message.guild.id),
      eq(reactionRoleMappings.messageId, message.id),
      eq(reactionRoleMappings.emojiKey, reactionKey(reaction)),
    )).limit(1)
  )[0];
  if (!mapping) return;
  const member = await message.guild.members.fetch(user.id).catch(() => null);
  const role = await message.guild.roles.fetch(mapping.roleId).catch(() => null);
  if (!member || !role || role.position >= (message.guild.members.me?.roles.highest.position ?? 0)) return;
  if (add) await member.roles.add(role, "Autorol por reacción");
  else await member.roles.remove(role, "Reacción de autorol retirada");
}

export async function handleReactionRoleAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
  await applyReactionRole(reaction, user, true);
}

export async function handleReactionRoleRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
  await applyReactionRole(reaction, user, false);
}
