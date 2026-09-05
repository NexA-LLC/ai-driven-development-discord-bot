const applicationId = required("DISCORD_APPLICATION_ID");
const token = required("DISCORD_BOT_TOKEN");
const guildId = process.env.DISCORD_GUILD_ID?.trim();

const STRING = 3;
const BOOLEAN = 5;
const GUILD_INSTALL = 0;
const USER_INSTALL = 1;
const GUILD_CONTEXT = 0;
const BOT_DM_CONTEXT = 1;
const PRIVATE_CHANNEL_CONTEXT = 2;

const sharedContexts = [
  GUILD_CONTEXT,
  BOT_DM_CONTEXT,
  PRIVATE_CHANNEL_CONTEXT,
];

const commands = [
  {
    name: "ask",
    description: "AIに質問し、次の実行候補まで出します",
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    contexts: sharedContexts,
    options: [
      {
        type: STRING,
        name: "prompt",
        description: "質問・作りたいもの・困っていること",
        required: true,
      },
      {
        type: BOOLEAN,
        name: "public",
        description: "サーバー内で回答を公開する（既定は自分だけ）",
        required: false,
      },
    ],
  },
  {
    name: "pitch",
    description: "アイデアや成果を15秒ピッチにします",
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    contexts: sharedContexts,
    options: [
      {
        type: STRING,
        name: "idea",
        description: "紹介したいアイデア・プロジェクト・募集内容",
        required: true,
      },
      {
        type: BOOLEAN,
        name: "public",
        description: "サーバー内で回答を公開する（既定は自分だけ）",
        required: false,
      },
    ],
  },
  {
    name: "about",
    description: "このCommunity AIの能力とデータ方針を表示します",
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    contexts: sharedContexts,
  },
  {
    name: "agents",
    description: "このサーバーで承認済みのAgentを表示します",
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
  },
  {
    name: "agent-submit",
    description: "自作Bot・Agentのmanifest URLを申請します",
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
    options: [
      {
        type: STRING,
        name: "manifest_url",
        description: "公開HTTPSのagent-manifest.json URL",
        required: true,
      },
    ],
  },
];

const endpoint = guildId
  ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const response = await fetch(endpoint, {
  method: "PUT",
  headers: {
    authorization: `Bot ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});

const responseText = await response.text();
if (!response.ok) {
  console.error(`Discord returned ${response.status}: ${responseText}`);
  process.exit(1);
}

const registered = JSON.parse(responseText);
console.log(
  `Registered ${registered.length} commands ${guildId ? `for guild ${guildId}` : "globally"}.`,
);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
