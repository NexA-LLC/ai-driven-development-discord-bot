/**
 * Discord application command definitions.
 *
 * Shared by the Worker's `/internal/register-commands` endpoint so the
 * registration can run with the bot token that already lives in Worker
 * secrets, without copying the token to a developer machine.
 */

const STRING = 3;
const BOOLEAN = 5;
const GUILD_INSTALL = 0;
const USER_INSTALL = 1;
const GUILD_CONTEXT = 0;
const BOT_DM_CONTEXT = 1;
const PRIVATE_CHANNEL_CONTEXT = 2;

const sharedContexts = [GUILD_CONTEXT, BOT_DM_CONTEXT, PRIVATE_CHANNEL_CONTEXT];

export interface DiscordCommandOption {
  type: number;
  name: string;
  description: string;
  required: boolean;
  max_length?: number;
}

export interface DiscordCommandDefinition {
  name: string;
  description: string;
  integration_types: number[];
  contexts: number[];
  options?: DiscordCommandOption[];
}

export const discordCommands: DiscordCommandDefinition[] = [
  {
    name: "quiz",
    description: "日次クイズと同じ、正解のない4択投票を出します",
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    contexts: sharedContexts,
    options: [
      {
        type: STRING,
        name: "topic",
        description: "必須：出したい問い（例：ClaudeとCodex、どちらが流行る？）",
        required: true,
        max_length: 120,
      },
      {
        type: BOOLEAN,
        name: "public",
        description: "サーバー内で公開する（既定は公開。falseで自分だけ）",
        required: false,
      },
    ],
  },
  {
    name: "ask",
    description: "レジ横で相談。答えと、次に取れる一手を返します",
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
    description: "張り紙を作ります。アイデアや成果を15秒ピッチに",
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
    name: "feedback",
    description: "スーへの感想・違和感・要望。改善の材料にします（本文は保存されます）",
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    contexts: sharedContexts,
    options: [
      {
        type: STRING,
        name: "message",
        description: "返答がおかしかった、こうしてほしい、など",
        required: true,
      },
    ],
  },
  {
    name: "inquiry",
    description: "店長（運営）へのお問い合わせ。CaseFlow に起票して受付番号を返します",
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    contexts: sharedContexts,
    options: [
      {
        type: STRING,
        name: "message",
        description: "問い合わせ内容（10文字以上）",
        required: true,
      },
    ],
  },
  {
    name: "inquiry-status",
    description: "受付番号（CF-…）で、お問い合わせの状況を確認します",
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    contexts: sharedContexts,
    options: [
      {
        type: STRING,
        name: "case_number",
        description: "受付番号。例: CF-20260906-78X0",
        required: true,
      },
    ],
  },
  {
    name: "about",
    description: "この店員（Bot）の説明とデータ方針",
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    contexts: sharedContexts,
  },
  {
    name: "agents",
    description: "このサーバーで働いている新人バイト（承認済みAgent）一覧",
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
  },
  {
    name: "agent-submit",
    description: "新人バイトの紹介。自作Bot・Agentのmanifest URLを申請",
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
