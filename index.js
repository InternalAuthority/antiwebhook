const {
    Client,
    GatewayIntentBits,
    AuditLogEvent,
    PermissionsBitField,
    EmbedBuilder,
} = require("discord.js");
const fs   = require("fs");
const path = require("path");

// ===== CONFIG =====
const SUPERUSER_ID  = process.env.SUPERUSER_ID  || "1408086232948277370";
const BOT_TOKEN     = process.env.BOT_TOKEN     || "PASTE_YOUR_BOT_TOKEN_HERE";
const PREFIX        = process.env.PREFIX        || "!";
const MAX_OFFENSES  = 3;
// ==================

// ===== WHITELIST PERSISTENCE =====
const WHITELIST_PATH = path.join(__dirname, "whitelist.json");

/**
 * Load the whitelist from disk.
 * Returns a Set of user ID strings.
 */
function loadWhitelist() {
    try {
        const raw = fs.readFileSync(WHITELIST_PATH, "utf8");
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) throw new Error("Expected array");
        return new Set(arr);
    } catch {
        // If the file is missing or corrupt, start fresh and recreate it.
        saveWhitelist(new Set());
        return new Set();
    }
}

/**
 * Persist the whitelist Set to disk.
 */
function saveWhitelist(set) {
    fs.writeFileSync(WHITELIST_PATH, JSON.stringify([...set], null, 2) + "\n", "utf8");
}

// Seed the in-memory whitelist with the superuser so they are always allowed.
const whitelist = loadWhitelist();
whitelist.add(SUPERUSER_ID);
saveWhitelist(whitelist);
// =================================

// ===== LOGS CHANNEL PERSISTENCE =====
const LOGS_CONFIG_PATH = path.join(__dirname, "logsConfig.json");

/**
 * Load the logs config from disk.
 * Returns an object mapping guildId -> channelId.
 */
function loadLogsConfig() {
    try {
        const raw = fs.readFileSync(LOGS_CONFIG_PATH, "utf8");
        const obj = JSON.parse(raw);
        if (typeof obj !== "object" || Array.isArray(obj)) throw new Error("Expected object");
        return obj;
    } catch {
        saveLogsConfig({});
        return {};
    }
}

/**
 * Persist the logs config object to disk.
 */
function saveLogsConfig(config) {
    fs.writeFileSync(LOGS_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// In-memory logs config: { [guildId]: channelId }
const logsConfig = loadLogsConfig();
// =====================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// In-memory offense tracking
// Map<guildId, Map<userId, offenseCount>>
const offenses = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post an embed to the configured logs channel for the given guild.
 * Silently does nothing if no logs channel is set or the channel is unreachable.
 *
 * @param {import("discord.js").Guild} guild
 * @param {import("discord.js").EmbedBuilder} embed
 */
async function postLog(guild, embed) {
    const channelId = logsConfig[guild.id];
    if (!channelId) return;

    try {
        const channel = await guild.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) return;
        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error(`[postLog] Failed to send log to channel ${channelId}:`, err);
    }
}

/**
 * Build a base embed with a consistent colour, footer, and timestamp.
 *
 * @param {number} color  Hex colour integer
 * @returns {EmbedBuilder}
 */
function baseEmbed(color) {
    return new EmbedBuilder()
        .setColor(color)
        .setTimestamp()
        .setFooter({ text: "AntiWebhook Guard" });
}

// ─────────────────────────────────────────────────────────────────────────────
// READY
// ─────────────────────────────────────────────────────────────────────────────
client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📋 Whitelist loaded with ${whitelist.size} entr${whitelist.size === 1 ? "y" : "ies"}`);
    console.log(`📣 Logs channel configured for ${Object.keys(logsConfig).length} guild(s)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SETLOGS COMMAND  —  !setlogs <#channel | channelId>
//
// Usage examples:
//   !setlogs #audit-log
//   !setlogs 123456789012345678
//
// Only the SUPERUSER_ID may run this command.
// Persists the chosen channel ID to logsConfig.json so it survives restarts.
// ─────────────────────────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.guild)     return;

    if (!message.content.startsWith(`${PREFIX}setlogs`)) return;

    // ── Auth check ──────────────────────────────────────────────────────────
    if (message.author.id !== SUPERUSER_ID) {
        return message.reply("🚫 You are not authorised to use this command.");
    }

    // ── Parse channel ────────────────────────────────────────────────────────
    const args = message.content.trim().split(/\s+/);
    // args[0] = "!setlogs", args[1] = channel mention or ID
    const raw = args[1];

    if (!raw) {
        return message.reply(
            `❓ Usage: \`${PREFIX}setlogs <#channel | channelId>\``
        );
    }

    // Strip channel mention formatting  <#123…>
    const channelId = raw.replace(/^<#(\d+)>$/, "$1");

    if (!/^\d{17,20}$/.test(channelId)) {
        return message.reply(
            "❌ Invalid channel. Provide a channel mention or a numeric channel ID."
        );
    }

    // ── Resolve the channel ──────────────────────────────────────────────────
    let targetChannel;
    try {
        targetChannel = await message.guild.channels.fetch(channelId);
    } catch {
        return message.reply(`❌ Could not find a channel with ID \`${channelId}\` in this server.`);
    }

    if (!targetChannel || !targetChannel.isTextBased()) {
        return message.reply("❌ That channel is not a text-based channel.");
    }

    // ── Bot permission check ─────────────────────────────────────────────────
    const botMember = message.guild.members.me;
    if (!targetChannel.permissionsFor(botMember).has(PermissionsBitField.Flags.SendMessages)) {
        return message.reply(
            `⚠️ I don't have permission to send messages in <#${channelId}>. ` +
            `Please grant me **Send Messages** access there first.`
        );
    }

    // ── Persist ──────────────────────────────────────────────────────────────
    logsConfig[message.guild.id] = channelId;
    saveLogsConfig(logsConfig);

    console.log(
        `📣 ${message.author.tag} set logs channel to #${targetChannel.name} (${channelId}) ` +
        `in guild ${message.guild.name} (${message.guild.id})`
    );

    // ── Confirm in the command channel ───────────────────────────────────────
    await message.reply(
        `✅ Logs channel set to <#${channelId}>. ` +
        `Webhook events will now be reported there.`
    );

    // ── Post a test/confirmation embed to the new logs channel ───────────────
    const confirmEmbed = baseEmbed(0x5865f2) // Discord blurple
        .setTitle("📣 Logs Channel Configured")
        .setDescription(
            `This channel has been designated as the **AntiWebhook Guard** logs channel.`
        )
        .addFields(
            { name: "Set by",   value: `<@${message.author.id}> (\`${message.author.tag}\`)`, inline: true },
            { name: "Guild",    value: `${message.guild.name}`,                               inline: true },
        );

    await postLog(message.guild, confirmEmbed);
});

// ─────────────────────────────────────────────────────────────────────────────
// WHITELIST COMMAND  —  !whitelist <userId | @mention>
//
// Usage examples:
//   !whitelist 123456789012345678
//   !whitelist @SomeUser
//
// Only the SUPERUSER_ID may run this command.
// ─────────────────────────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
    // Ignore bots and DMs
    if (message.author.bot) return;
    if (!message.guild)     return;

    if (!message.content.startsWith(`${PREFIX}whitelist`)) return;

    // ── Auth check ──────────────────────────────────────────────────────────
    if (message.author.id !== SUPERUSER_ID) {
        return message.reply("🚫 You are not authorised to use this command.");
    }

    // ── Parse target user ID ─────────────────────────────────────────────────
    const args = message.content.trim().split(/\s+/);
    // args[0] = "!whitelist", args[1] = user id or mention
    const raw = args[1];

    if (!raw) {
        return message.reply(
            `❓ Usage: \`${PREFIX}whitelist <userId | @mention>\``
        );
    }

    // Strip mention formatting  <@123…>  or  <@!123…>
    const targetId = raw.replace(/^<@!?(\d+)>$/, "$1");

    if (!/^\d{17,20}$/.test(targetId)) {
        return message.reply(
            "❌ Invalid user ID. Provide a numeric Discord user ID or a mention."
        );
    }

    // ── Resolve the user from Discord ────────────────────────────────────────
    let targetUser;
    try {
        targetUser = await client.users.fetch(targetId);
    } catch {
        return message.reply(`❌ Could not find a Discord user with ID \`${targetId}\`.`);
    }

    // ── Already whitelisted? ─────────────────────────────────────────────────
    if (whitelist.has(targetId)) {
        return message.reply(
            `ℹ️ **${targetUser.tag}** (\`${targetId}\`) is already whitelisted.`
        );
    }

    // ── Persist to whitelist ─────────────────────────────────────────────────
    whitelist.add(targetId);
    saveWhitelist(whitelist);

    console.log(
        `✅ ${message.author.tag} whitelisted ${targetUser.tag} (${targetId})`
    );

    // ── Post log ─────────────────────────────────────────────────────────────
    const whitelistEmbed = baseEmbed(0x57f287) // Discord green
        .setTitle("✅ User Whitelisted")
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .addFields(
            { name: "User",           value: `<@${targetId}> (\`${targetUser.tag}\`)`,              inline: false },
            { name: "User ID",        value: `\`${targetId}\``,                                     inline: true  },
            { name: "Whitelisted by", value: `<@${message.author.id}> (\`${message.author.tag}\`)`, inline: true  },
        );

    await postLog(message.guild, whitelistEmbed);

    // ── Confirm ──────────────────────────────────────────────────────────────
    return message.reply(
        `✅ **${targetUser.tag}** (\`${targetId}\`) has been whitelisted.`
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK PROTECTION
// ─────────────────────────────────────────────────────────────────────────────
client.on("webhooksUpdate", async (channel) => {
    try {
        const guild = channel.guild;
        if (!guild) return;

        const auditLogs = await guild.fetchAuditLogs({
            type:  AuditLogEvent.WebhookCreate,
            limit: 1,
        });

        const entry = auditLogs.entries.first();
        if (!entry) return;

        const { executor, target } = entry;
        if (!executor || !target) return;

        // Ignore the bot itself
        if (executor.id === client.user.id) return;

        // Allow anyone on the whitelist (includes the superuser)
        if (whitelist.has(executor.id)) {
            console.log(`✔ Webhook allowed (whitelisted): ${executor.tag}`);
            return;
        }

        // Delete the unauthorised webhook
        await target.delete("Unauthorized webhook creation").catch(() => null);

        // Track offenses
        if (!offenses.has(guild.id)) {
            offenses.set(guild.id, new Map());
        }

        const guildOffenses = offenses.get(guild.id);
        const count = (guildOffenses.get(executor.id) || 0) + 1;
        guildOffenses.set(executor.id, count);

        console.log(
            `❌ Unauthorized webhook by ${executor.tag} (${count}/${MAX_OFFENSES})`
        );

        // ── Log: webhook deleted + offense count ─────────────────────────────
        const isLastWarning = count === MAX_OFFENSES - 1;
        const webhookEmbed = baseEmbed(0xfee75c) // Discord yellow
            .setTitle("⚠️ Unauthorized Webhook Deleted")
            .setThumbnail(executor.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: "User",         value: `<@${executor.id}> (\`${executor.tag}\`)`, inline: false },
                { name: "User ID",      value: `\`${executor.id}\``,                      inline: true  },
                { name: "Channel",      value: `<#${channel.id}>`,                        inline: true  },
                { name: "Webhook name", value: `\`${target.name}\``,                      inline: true  },
                {
                    name:  "Offense count",
                    value: `**${count} / ${MAX_OFFENSES}**${isLastWarning ? " — ⚠️ next offense triggers a kick!" : ""}`,
                    inline: false,
                },
            );

        await postLog(guild, webhookEmbed);

        // Fetch member
        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (!member) return;

        // Kick on 3rd offense
        if (count >= MAX_OFFENSES) {
            await member.kick("3 unauthorized webhook creations").catch(() => null);
            console.log(`🚨 ${executor.tag} was KICKED`);
            guildOffenses.delete(executor.id);

            // ── Log: user kicked ──────────────────────────────────────────────
            const kickEmbed = baseEmbed(0xed4245) // Discord red
                .setTitle("🚨 User Kicked")
                .setThumbnail(executor.displayAvatarURL({ dynamic: true }))
                .setDescription(
                    `<@${executor.id}> was **kicked** after reaching ${MAX_OFFENSES} unauthorized webhook creations.`
                )
                .addFields(
                    { name: "User",    value: `\`${executor.tag}\``, inline: true },
                    { name: "User ID", value: `\`${executor.id}\``,  inline: true },
                    { name: "Reason",  value: `${MAX_OFFENSES} unauthorized webhook creations`, inline: false },
                );

            await postLog(guild, kickEmbed);
        }

    } catch (err) {
        console.error("Webhook protection error:", err);
    }
});

client.login(BOT_TOKEN);
