import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const guildConfigs = pgTable("guild_configs", {
  guildId: text("guild_id").primaryKey(),
  welcomeChannelId: text("welcome_channel_id"),
  verificationChannelId: text("verification_channel_id"),
  verifiedRoleId: text("verified_role_id"),
  logsChannelId: text("logs_channel_id"),
  ticketLogsChannelId: text("ticket_logs_channel_id"),
  ticketTranscriptsChannelId: text("ticket_transcripts_channel_id"),
  reportsChannelId: text("reports_channel_id"),
  ticketCategoryId: text("ticket_category_id"),
  ticketSupportRoleId: text("ticket_support_role_id"),
  ticketOpenLimit: integer("ticket_open_limit").default(1).notNull(),
  voiceCreateChannelId: text("voice_create_channel_id"),
  voiceCategoryId: text("voice_category_id"),
  voiceDefaultName: text("voice_default_name").default("Sala de {username}").notNull(),
  voiceDefaultLimit: integer("voice_default_limit").default(0).notNull(),
  voiceLogsChannelId: text("voice_logs_channel_id"),
  verificationEnabled: boolean("verification_enabled").default(false).notNull(),
  verificationPendingRoleId: text("verification_pending_role_id"),
  verificationMessage: text("verification_message"),
  verificationExpirySeconds: integer("verification_expiry_seconds").default(600).notNull(),
  verificationMaxAttempts: integer("verification_max_attempts").default(5).notNull(),
  verificationLogsChannelId: text("verification_logs_channel_id"),
  moderationLogsChannelId: text("moderation_logs_channel_id"),
  automodEnabled: boolean("automod_enabled").default(false).notNull(),
  warningTimeoutAt: integer("warning_timeout_at").default(2).notNull(),
  warningKickAt: integer("warning_kick_at").default(3).notNull(),
  warningBanAt: integer("warning_ban_at").default(4).notNull(),
  warningTimeoutSeconds: integer("warning_timeout_seconds").default(600).notNull(),
  levelUpChannelId: text("level_up_channel_id"),
  xpEnabled: boolean("xp_enabled").default(true).notNull(),
  xpPerMessage: integer("xp_per_message").default(10).notNull(),
  xpPerVoiceMinute: integer("xp_per_voice_minute").default(5).notNull(),
  xpMessageCooldownSeconds: integer("xp_message_cooldown_seconds").default(60).notNull(),
  levelUpMessage: text("level_up_message")
    .default("¡Enhorabuena {user}! Has alcanzado el nivel **{level}**.")
    .notNull(),
  keepPreviousLevelRoles: boolean("keep_previous_level_roles").default(true).notNull(),
  welcomePanelTitle: text("welcome_panel_title"),
  welcomePanelDescription: text("welcome_panel_description"),
  welcomePanelColor: text("welcome_panel_color"),
  ticketPanelTitle: text("ticket_panel_title"),
  ticketPanelDescription: text("ticket_panel_description"),
  ticketPanelColor: text("ticket_panel_color"),
  colorPanelTitle: text("color_panel_title"),
  colorPanelDescription: text("color_panel_description"),
  colorPanelColor: text("color_panel_color"),
  verificationPanelTitle: text("verification_panel_title"),
  verificationPanelDescription: text("verification_panel_description"),
  verificationPanelColor: text("verification_panel_color"),
  economyCurrency: text("economy_currency").default("coins").notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const colorRoles = pgTable("color_roles", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  roleId: text("role_id").notNull(),
  roleName: text("role_name").notNull(),
  color: text("color").notNull(),
  isRainbow: boolean("is_rainbow").default(true).notNull(),
  createdAt: createdAt(),
});

export const userProfiles = pgTable(
  "user_profiles",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    balance: integer("balance").default(100).notNull(),
    xp: integer("xp").default(0).notNull(),
    level: integer("level").default(1).notNull(),
    lastDailyAt: timestamp("last_daily_at", { withTimezone: true }),
    lastWorkAt: timestamp("last_work_at", { withTimezone: true }),
    lastXpAt: timestamp("last_xp_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.userId] }),
  }),
);

export const levelRoleRewards = pgTable(
  "level_role_rewards",
  {
    guildId: text("guild_id").notNull(),
    level: integer("level").notNull(),
    roleId: text("role_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.level] }),
  }),
);

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  reporterId: text("reporter_id").notNull(),
  reportedUserId: text("reported_user_id").notNull(),
  reason: text("reason").notNull(),
  reportChannelId: text("report_channel_id"),
  reportMessageId: text("report_message_id"),
  status: text("status").default("open").notNull(),
  createdAt: createdAt(),
});

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  openerId: text("opener_id").notNull(),
  status: text("status").default("open").notNull(),
  closedBy: text("closed_by"),
  claimedBy: text("claimed_by"),
  ticketTypeKey: text("ticket_type_key"),
  answers: text("answers"),
  createdAt: createdAt(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const ticketTypes = pgTable(
  "ticket_types",
  {
    guildId: text("guild_id").notNull(),
    typeKey: text("type_key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    emoji: text("emoji"),
    categoryId: text("category_id"),
    accessRoleIds: text("access_role_ids").default("[]").notNull(),
    questions: text("questions").default("[]").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.typeKey] }),
  }),
);

export const ticketTranscripts = pgTable("ticket_transcripts", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  content: text("content").notNull(),
  messageCount: integer("message_count").default(0).notNull(),
  createdAt: createdAt(),
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: text("metadata"),
  createdAt: createdAt(),
});

export const automodRules = pgTable(
  "automod_rules",
  {
    guildId: text("guild_id").notNull(),
    ruleKey: text("rule_key").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    action: text("action").default("eliminar").notNull(),
    threshold: integer("threshold"),
    windowSeconds: integer("window_seconds"),
    durationSeconds: integer("duration_seconds"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.ruleKey] }),
  }),
);

export const automodBlocklist = pgTable("automod_blocklist", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  kind: text("kind").notNull(),
  value: text("value").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

export const automodAllowlist = pgTable(
  "automod_allowlist",
  {
    guildId: text("guild_id").notNull(),
    kind: text("kind").notNull(),
    targetId: text("target_id").notNull(),
    addedBy: text("added_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.kind, table.targetId] }),
  }),
);

export const moderationCases = pgTable("moderation_cases", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  targetUserId: text("target_user_id").notNull(),
  moderatorId: text("moderator_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  source: text("source").notNull(),
  ruleKey: text("rule_key"),
  durationSeconds: integer("duration_seconds"),
  messageChannelId: text("message_channel_id"),
  dmSent: boolean("dm_sent"),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedBy: text("removed_by"),
  createdAt: createdAt(),
});

export const temporaryVoiceRooms = pgTable("temporary_voice_rooms", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  createdAt: createdAt(),
});

export const reactionRoleMappings = pgTable(
  "reaction_role_mappings",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    emojiKey: text("emoji_key").notNull(),
    emojiDisplay: text("emoji_display").notNull(),
    roleId: text("role_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.guildId, table.messageId, table.emojiKey],
    }),
  }),
);

export const verificationChallenges = pgTable(
  "verification_challenges",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.userId] }),
  }),
);

export const embedTemplates = pgTable(
  "embed_templates",
  {
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    definition: text("definition").notNull(),
    saved: boolean("saved").default(false).notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.guildId, table.name] }),
  }),
);

export type GuildConfig = typeof guildConfigs.$inferSelect;
export type ColorRole = typeof colorRoles.$inferSelect;
export type UserProfile = typeof userProfiles.$inferSelect;
export type LevelRoleReward = typeof levelRoleRewards.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type ModerationCase = typeof moderationCases.$inferSelect;