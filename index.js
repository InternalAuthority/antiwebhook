const {
    Client,
    GatewayIntentBits,
    AuditLogEvent,
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
// READY
// ─────────────────────────────────────────────────────────────────────────────
client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📋 Whitelist loaded with ${whitelist.size} entr${whitelist.size === 1 ? "y" : "ies"}`);
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

        const logs = await guild.fetchAuditLogs({
            type:  AuditLogEvent.WebhookCreate,
            limit: 1,
        });

        const entry = logs.entries.first();
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

        // Fetch member
        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (!member) return;

        // Kick on 3rd offense
        if (count >= MAX_OFFENSES) {
            await member.kick("3 unauthorized webhook creations").catch(() => null);
            console.log(`🚨 ${executor.tag} was KICKED`);
            guildOffenses.delete(executor.id);
        }

    } catch (err) {
        console.error("Webhook protection error:", err);
    }
});

client.login(BOT_TOKEN);
