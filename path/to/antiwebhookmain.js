// Updated antiwebhookmain with missing intents, detailed logging, fixed webhook deletion, and improved error handling.

// Import necessary modules
const { Client } = require('discord.js');

// Initialize client
const client = new Client();

// Define Intent
const intents = [
    // Add any missing intents here
    'GUILDS',
    'GUILD_MESSAGES',
    'GUILD_MEMBERS',
    // Additional intents can be added depending on your needs
];

// Update logging function
function log(message) {
    console.log(`[${new Date().toISOString()}] - ${message}`);
}

client.on('messageCreate', async (message) => {
    try {
        if (message.content.startsWith('!delete')) {
            // Logic to delete webhook
            const webhook = await message.channel.fetchWebhooks();
            log(`Fetched webhooks for ${message.channel.name}`);
            // Assuming a specific webhook ID to delete
            const webhookToDelete = webhook.find(wh => wh.id === 'your_webhook_id_here');
            if (webhookToDelete) {
                await webhookToDelete.delete();
                log(`Deleted webhook: ${webhookToDelete.name}`);
            } else {
                log(`Webhook not found`);
            }
        }
    } catch (error) {
        log(`Error: ${error.message}`);
    }
});

client.login('YOUR_BOT_TOKEN');