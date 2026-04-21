const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    setTimeout(() => {
        client.user.setPresence({
            activities: [{ name: 'Hail Authority .gg/auths', type: ActivityType.Watching, }],
            status: 'online'
        }).catch(err => console.error('Status failed:', err));
    }, 500);
});

client.on('guildCreate', (guild) => {
    console.log(`Joined a new guild: ${guild.name} (id: ${guild.id})`);
});

client.on('error', (error) => {
    console.error('WebSocket Error:', error);
});

client.on('warn', (info) => {
    console.warn('Warning:', info);
});

client.login(process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN');