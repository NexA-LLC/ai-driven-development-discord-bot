#!/usr/bin/env node
// Fixed managed-runtime launcher. No secrets or arbitrary commands in launchd.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root=path.join(os.homedir(),'Library','Application Support','AI Development Discord');
const envPath=path.join(root,'gateway.env');
function blocked(code) { console.error(JSON.stringify({state:'blocked',code})); process.exit(78); }
if (!fs.existsSync(envPath)) blocked('gateway_env_missing');
const stat=fs.lstatSync(envPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid() || (stat.mode&0o077)) blocked('gateway_env_permissions');
process.loadEnvFile(envPath);
for (const key of ['DISCORD_APPLICATION_ID','DISCORD_GUILD_ID','DISCORD_BOT_TOKEN','WORKER_INTERNAL_URL','INTERNAL_SHARED_SECRET']) {
  if (!process.env[key]?.trim()) blocked('missing_'+key.toLowerCase());
}
let worker;
try { worker=new URL(process.env.WORKER_INTERNAL_URL); } catch { blocked('worker_url_invalid'); }
if (worker.protocol!=='https:' || worker.username || worker.password || worker.search || worker.hash || worker.hostname==='replace-me.workers.dev') blocked('worker_url_invalid');
const binary=path.join(root,'runtime','current','dist','gateway','index.js');
if (!fs.existsSync(binary)) blocked('gateway_release_missing');
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({state:'configured',workerHost:worker.hostname,discordConnectionVerified:false}));
} else {
  // The product Gateway owns Discord login and graceful termination.
  await import(pathToFileURL(binary).href);
}
