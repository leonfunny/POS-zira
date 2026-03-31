#!/usr/bin/env node
// Thêm Discord channel vào access.json mà không cần mở Claude

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ACCESS_FILE = path.join(os.homedir(), '.claude', 'channels', 'discord', 'access.json');
const channelId   = process.argv[2];

if (!channelId || !/^\d+$/.test(channelId)) {
  console.error('❌ Channel ID không hợp lệ. Phải là số nguyên.');
  console.error('   Dùng: node add-discord-channel.js <channel_id>');
  process.exit(1);
}

let config = {};
try {
  config = JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8'));
} catch {
  config = { dmPolicy: 'allowlist', allowFrom: [], groups: {} };
}

if (!config.groups) config.groups = {};

if (config.groups[channelId]) {
  console.log(`⚠️  Channel ${channelId} đã có trong danh sách rồi.`);
} else {
  config.groups[channelId] = { requireMention: false, allowFrom: [] };
  fs.writeFileSync(ACCESS_FILE, JSON.stringify(config, null, 2));
  console.log(`✅ Đã thêm channel ${channelId}`);
}

console.log('\nKênh đang active:');
Object.keys(config.groups).forEach(id => {
  const g = config.groups[id];
  console.log(`  • ${id} (mention: ${g.requireMention ? 'bắt buộc' : 'không cần'})`);
});
