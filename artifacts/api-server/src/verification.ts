import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, guildConfigs, verificationChallenges } from "@workspace/db";

export const verificationCommands = [
  new SlashCommandBuilder()
    .setName("verificacion")
    .setDescription("Configura y gestiona la verificación por código temporal")
    .addSubcommand((sub) =>
      sub.setName("configurar").setDescription("Configura los canales, roles y límites")
        .addChannelOption((o) => o.setName("canal").setDescription("Canal del panel").addChannelTypes(ChannelType.GuildText))
        .addRoleOption((o) => o.setName("rol_verificado").setDescription("Rol que se entrega al completar"))
        .addRoleOption((o) => o.setName("rol_previo").setDescription("Rol temporal mientras se verifica"))
        .addStringOption((o) => o.setName("mensaje").setDescription("Texto del panel").setMaxLength(1000))
        .addIntegerOption((o) => o.setName("expiracion").setDescription("Caducidad del código en segundos").setMinValue(60).setMaxValue(86400))
        .addIntegerOption((o) => o.setName("intentos").setDescription("Intentos antes del bloqueo temporal").setMinValue(1).setMaxValue(10))
        .addChannelOption((o) => o.setName("canal_logs").setDescription("Canal para registros de verificación").addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((sub) => sub.setName("activar").setDescription("Activa la verificación por código"))
    .addSubcommand((sub) => sub.setName("desactivar").setDescription("Desactiva la verificación por código"))
    .addSubcommand((sub) => sub.setName("estado").setDescription("Muestra la configuración actual"))
    .addSubcommand((sub) =>
      sub.setName("iniciar").setDescription("Solicita un código privado de verificación"),
    )
    .addSubcommand((sub) =>
      sub.setName("confirmar").setDescription("Comprueba tu código privado")
        .addStringOption((o) => o.setName("codigo").setDescription("Código de seis cifras").setMinLength(6).setMaxLength(6).setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("reiniciar").setDescription("Reinicia el bloqueo o código de un miembro")
        .addUserOption((o) => o.setName("usuario").setDescription("Miembro").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("verificar").setDescription("Verifica manualmente a un miembro")
        .addUserOption((o) => o.setName("usuario").setDescription("Miembro").setRequired(true)),
    ),
];

const LOCK_DURATION_MS = 15 * 60 * 1000;

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

function hashCode(guildId: string, userId: string, code: string) {
  const secret = process.env["SESSION_SECRET"];
  if (!secret) throw new Error("Falta SESSION_SECRET para proteger los códigos de verificación.");
  return createHmac("sha256", secret).update(`${guildId}:${userId}:${code}`).digest("hex");
}

async function logVerification(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  action: string,
  targetId: string,
  detail?: string,
) {
  const guildId = interaction.guildId!;
  await db.insert(auditLogs).values({
    guildId,
    actorId: interaction.user.id,
    action,
    targetType: "verificacion",
    targetId,
    metadata: detail ?? null,
  });
  const config = await getGuildConfig(guildId);
  if (!config?.verificationLogsChannelId) return;
  const channel = await interaction.guild!.channels.fetch(config.verificationLogsChannelId).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(action.includes("fallido") || action.includes("bloqueado") ? 0xed4245 : 0x57f287)
          .setTitle(`Verificación: ${action}`)
          .addFields(
            { name: "Miembro", value: `<@${targetId}> (${targetId})`, inline: true },
            { name: "Registrado por", value: `${interaction.user} (${interaction.user.id})`, inline: true },
            ...(detail ? [{ name: "Detalle", value: detail.slice(0, 1000) }] : []),
          )
          .setTimestamp(),
      ],
    }).catch((error: unknown) => console.error("No se pudo publicar el registro de verificación.", error));
  }
}

async function startVerification(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
) {
  await interaction.deferReply({ ephemeral: true });
  const respond = (content: string) => interaction.editReply({ content });
  const guild = interaction.guild!;
  const config = await getGuildConfig(guild.id);
  if (!config?.verificationEnabled || !config.verifiedRoleId) {
    await respond("La verificación no está activa o todavía no tiene un rol verificado configurado.");
    return;
  }
  const member = await guild.members.fetch(interaction.user.id);
  if (member.roles.cache.has(config.verifiedRoleId)) {
    await respond("Ya tienes el rol de verificado.");
    return;
  }
  const now = new Date();
  const prior = (
    await db.select().from(verificationChallenges).where(and(
      eq(verificationChallenges.guildId, guild.id),
      eq(verificationChallenges.userId, member.id),
    )).limit(1)
  )[0];
  if (prior?.lockedUntil && prior.lockedUntil > now) {
    await respond(`La verificación está bloqueada temporalmente. Vuelve a intentarlo <t:${Math.floor(prior.lockedUntil.getTime() / 1000)}:R>.`);
    return;
  }

  const code = String(randomInt(100000, 1000000));
  const expiresAt = new Date(now.getTime() + (config.verificationExpirySeconds || 600) * 1000);
  let codeHash: string;
  try {
    codeHash = hashCode(guild.id, member.id, code);
  } catch (error) {
    await respond(error instanceof Error ? error.message : "No se pudo generar el código.");
    return;
  }
  await db.insert(verificationChallenges).values({
    guildId: guild.id,
    userId: member.id,
    codeHash,
    expiresAt,
    attempts: 0,
    lockedUntil: null,
    consumedAt: null,
  }).onConflictDoUpdate({
    target: [verificationChallenges.guildId, verificationChallenges.userId],
    set: { codeHash, expiresAt, attempts: 0, lockedUntil: null, consumedAt: null, createdAt: now },
  });
  try {
    await interaction.user.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`Código de verificación · ${guild.name}`)
          .setDescription(`Tu código es **${code}**.\n\nCaduca <t:${Math.floor(expiresAt.getTime() / 1000)}:R> y solo se puede usar una vez. No lo compartas.`)
          .setFooter({ text: "Introduce el código con /verificacion confirmar." })
          .setTimestamp(),
      ],
    });
  } catch {
    await db.delete(verificationChallenges).where(and(
      eq(verificationChallenges.guildId, guild.id),
      eq(verificationChallenges.userId, member.id),
    ));
    await respond("No pude enviarte un mensaje privado. Activa los mensajes privados del servidor e inténtalo de nuevo.");
    await logVerification(interaction, "envío fallido", member.id, "No se pudieron enviar mensajes privados.");
    return;
  }

  if (config.verificationPendingRoleId) {
    const pendingRole = await guild.roles.fetch(config.verificationPendingRoleId).catch(() => null);
    const botMember = guild.members.me;
    if (pendingRole && botMember?.permissions.has(PermissionFlagsBits.ManageRoles) && pendingRole.position < botMember.roles.highest.position) {
      await member.roles.add(pendingRole, "Verificación iniciada").catch(() => undefined);
    }
  }
  await logVerification(interaction, "código enviado", member.id, `Caduca en ${config.verificationExpirySeconds || 600} segundos.`);
  await respond("Te he enviado el código por mensaje privado. Cuando lo tengas, introdúcelo con `/verificacion confirmar`.");
}

async function confirmVerification(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const respond = (content: string) => interaction.editReply({ content });
  const guild = interaction.guild!;
  const member = await guild.members.fetch(interaction.user.id);
  const config = await getGuildConfig(guild.id);
  if (!config?.verificationEnabled || !config.verifiedRoleId) {
    await respond("La verificación no está activa.");
    return;
  }
  const challenge = (
    await db.select().from(verificationChallenges).where(and(
      eq(verificationChallenges.guildId, guild.id),
      eq(verificationChallenges.userId, member.id),
    )).limit(1)
  )[0];
  const now = new Date();
  if (!challenge) {
    await respond("No tienes un código activo. Usa `/verificacion iniciar` para solicitarlo.");
    return;
  }
  if (challenge.lockedUntil && challenge.lockedUntil > now) {
    await respond(`Has alcanzado el límite de intentos. Vuelve a intentarlo <t:${Math.floor(challenge.lockedUntil.getTime() / 1000)}:R>.`);
    return;
  }
  if (challenge.consumedAt) {
    await respond("Ese código ya se ha usado. Solicita uno nuevo.");
    return;
  }
  if (challenge.expiresAt <= now) {
    await db.delete(verificationChallenges).where(and(
      eq(verificationChallenges.guildId, guild.id),
      eq(verificationChallenges.userId, member.id),
    ));
    await logVerification(interaction, "código caducado", member.id);
    await respond("El código ha caducado. Usa `/verificacion iniciar` para solicitar otro.");
    return;
  }

  const suppliedCode = interaction.options.getString("codigo", true);
  let actualHash: Buffer;
  try {
    actualHash = Buffer.from(hashCode(guild.id, member.id, suppliedCode), "hex");
  } catch {
    await respond("No se puede comprobar el código: falta la configuración segura del servidor.");
    return;
  }
  const expectedHash = Buffer.from(challenge.codeHash, "hex");
  const isCorrect = actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
  if (!isCorrect) {
    const attempts = challenge.attempts + 1;
    const maxAttempts = config.verificationMaxAttempts || 5;
    const lockedUntil = attempts >= maxAttempts ? new Date(now.getTime() + LOCK_DURATION_MS) : null;
    await db.update(verificationChallenges).set({ attempts, lockedUntil })
      .where(and(eq(verificationChallenges.guildId, guild.id), eq(verificationChallenges.userId, member.id)));
    await logVerification(interaction, lockedUntil ? "usuario bloqueado" : "intento fallido", member.id, `${attempts}/${maxAttempts}`);
    await respond(lockedUntil
      ? `Has alcanzado ${maxAttempts} intentos. La verificación queda bloqueada durante 15 minutos.`
      : `El código no es correcto. Intento ${attempts} de ${maxAttempts}.`);
    return;
  }

  const verifiedRole = await guild.roles.fetch(config.verifiedRoleId).catch(() => null);
  const botMember = guild.members.me;
  if (!verifiedRole || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || verifiedRole.position >= botMember.roles.highest.position) {
    await respond("El bot no puede asignar el rol verificado. Revisa sus permisos y la posición del rol.");
    return;
  }
  await member.roles.add(verifiedRole, "Código de verificación válido");
  if (config.verificationPendingRoleId && member.roles.cache.has(config.verificationPendingRoleId)) {
    await member.roles.remove(config.verificationPendingRoleId, "Verificación completada").catch(() => undefined);
  }
  await db.update(verificationChallenges).set({ consumedAt: now })
    .where(and(eq(verificationChallenges.guildId, guild.id), eq(verificationChallenges.userId, member.id)));
  await logVerification(interaction, "completada", member.id);
  await respond("Verificación completada. Ya tienes acceso al servidor.");
}

async function publishVerificationPanel(interaction: ChatInputCommandInteraction) {
  const config = await getGuildConfig(interaction.guildId!);
  if (!config?.verificationChannelId || !config.verifiedRoleId) {
    await interaction.reply({ content: "Configura el canal y el rol verificado con `/verificacion configurar` antes de publicar el panel.", ephemeral: true });
    return;
  }
  const channel = await interaction.guild!.channels.fetch(config.verificationChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "El canal de verificación configurado no es válido.", ephemeral: true });
    return;
  }
  const button = new ButtonBuilder().setCustomId("verify:complete").setLabel("Iniciar verificación").setStyle(ButtonStyle.Success);
  const embed = new EmbedBuilder()
    .setColor(config.verificationPanelColor ? Number.parseInt(config.verificationPanelColor.replace("#", ""), 16) : 0x5865f2)
    .setTitle(config.verificationPanelTitle || "Verificación")
    .setDescription(config.verificationMessage || config.verificationPanelDescription || "Pulsa el botón para recibir por mensaje privado un código temporal.")
    .setTimestamp();
  await (channel as TextChannel).send({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
  });
  await interaction.reply({ content: `Panel de verificación publicado en ${channel}.`, ephemeral: true });
}

export async function handleVerificationCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName !== "verificacion") return false;
  const action = interaction.options.getSubcommand();
  const member = interaction.member as GuildMember;

  if (action === "iniciar") {
    await startVerification(interaction);
    return true;
  }
  if (action === "confirmar") {
    await confirmVerification(interaction);
    return true;
  }

  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Solo el equipo con permiso de gestionar el servidor puede administrar la verificación.", ephemeral: true });
    return true;
  }

  if (action === "configurar") {
    const channel = interaction.options.getChannel("canal");
    const verifiedRole = interaction.options.getRole("rol_verificado");
    const pendingRole = interaction.options.getRole("rol_previo");
    const message = interaction.options.getString("mensaje");
    const expiry = interaction.options.getInteger("expiracion");
    const attempts = interaction.options.getInteger("intentos");
    const logs = interaction.options.getChannel("canal_logs");
    const values: Partial<typeof guildConfigs.$inferInsert> = {};
    if (channel) values.verificationChannelId = channel.id;
    if (verifiedRole) values.verifiedRoleId = verifiedRole.id;
    if (pendingRole) values.verificationPendingRoleId = pendingRole.id;
    if (message !== null) values.verificationMessage = message;
    if (expiry !== null) values.verificationExpirySeconds = expiry;
    if (attempts !== null) values.verificationMaxAttempts = attempts;
    if (logs) values.verificationLogsChannelId = logs.id;
    if (!Object.keys(values).length) {
      await interaction.reply({ content: "Indica al menos un valor que quieras configurar.", ephemeral: true });
      return true;
    }
    await updateGuildConfig(interaction.guildId!, values);
    await interaction.reply({ content: "La configuración de verificación se ha guardado.", ephemeral: true });
    return true;
  }
  if (action === "activar") {
    const config = await getGuildConfig(interaction.guildId!);
    if (!config?.verificationChannelId || !config.verifiedRoleId) {
      await interaction.reply({ content: "Configura primero el canal y el rol verificado con `/verificacion configurar`.", ephemeral: true });
      return true;
    }
    await updateGuildConfig(interaction.guildId!, { verificationEnabled: true });
    await interaction.reply({ content: "La verificación por código está activa.", ephemeral: true });
    return true;
  }
  if (action === "desactivar") {
    await updateGuildConfig(interaction.guildId!, { verificationEnabled: false });
    await interaction.reply({ content: "La verificación por código está desactivada.", ephemeral: true });
    return true;
  }
  if (action === "estado") {
    const config = await getGuildConfig(interaction.guildId!);
    await interaction.reply({
      content: `**Estado:** ${config?.verificationEnabled ? "activa" : "inactiva"}\n**Canal:** ${config?.verificationChannelId ? `<#${config.verificationChannelId}>` : "sin configurar"}\n**Rol verificado:** ${config?.verifiedRoleId ? `<@&${config.verifiedRoleId}>` : "sin configurar"}\n**Rol previo:** ${config?.verificationPendingRoleId ? `<@&${config.verificationPendingRoleId}>` : "sin configurar"}\n**Caducidad:** ${config?.verificationExpirySeconds ?? 600} s\n**Intentos:** ${config?.verificationMaxAttempts ?? 5}\n**Canal de registros:** ${config?.verificationLogsChannelId ? `<#${config.verificationLogsChannelId}>` : "sin configurar"}`,
      ephemeral: true,
    });
    return true;
  }
  if (action === "reiniciar") {
    const target = interaction.options.getUser("usuario", true);
    await db.delete(verificationChallenges).where(and(
      eq(verificationChallenges.guildId, interaction.guildId!),
      eq(verificationChallenges.userId, target.id),
    ));
    await logVerification(interaction, "reiniciada", target.id);
    await interaction.reply({ content: `He reiniciado la verificación de ${target}.`, ephemeral: true });
    return true;
  }
  if (action === "verificar") {
    const target = interaction.options.getUser("usuario", true);
    const targetMember = await interaction.guild!.members.fetch(target.id).catch(() => null);
    const config = await getGuildConfig(interaction.guildId!);
    if (!targetMember || !config?.verifiedRoleId) {
      await interaction.reply({ content: "No encuentro al miembro o no se ha configurado el rol verificado.", ephemeral: true });
      return true;
    }
    const role = await interaction.guild!.roles.fetch(config.verifiedRoleId).catch(() => null);
    const botMember = interaction.guild!.members.me;
    if (!role || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= botMember.roles.highest.position) {
      await interaction.reply({ content: "El bot no puede asignar el rol verificado. Revisa sus permisos y la posición del rol.", ephemeral: true });
      return true;
    }
    await targetMember.roles.add(role, `Verificado manualmente por ${interaction.user.tag}`);
    if (config.verificationPendingRoleId) {
      await targetMember.roles.remove(config.verificationPendingRoleId, "Verificación manual").catch(() => undefined);
    }
    await db.update(verificationChallenges).set({ consumedAt: new Date() }).where(and(
      eq(verificationChallenges.guildId, interaction.guildId!),
      eq(verificationChallenges.userId, target.id),
    ));
    await logVerification(interaction, "verificada manualmente", target.id);
    await interaction.reply({ content: `${target} ha sido marcado como verificado.`, ephemeral: true });
    return true;
  }
  return true;
}

export async function handleVerificationButton(interaction: ButtonInteraction) {
  if (interaction.customId !== "verify:complete") return false;
  await startVerification(interaction);
  return true;
}

export async function handleVerificationPanelCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName !== "verification-panel") return false;
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Solo el equipo con permiso de gestionar el servidor puede publicar el panel.", ephemeral: true });
    return true;
  }
  await publishVerificationPanel(interaction);
  return true;
}
