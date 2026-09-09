import { AudioPlayerStatus, EndBehaviorType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, type AudioReceiveStream, type VoiceConnection } from "@discordjs/voice";
import { ChannelType, Events, PermissionFlagsBits, type Client, type Message, type VoiceChannel } from "discord.js";
import OpusScript from "opusscript";
import { Readable } from "node:stream";
import { lifecycle } from "./lifecycle.js";
import { synthesizeSpeech, transcribeAudioBytes } from "./audio.js";
import { MAX_VOICE_SECONDS, PCM_BYTES_PER_SECOND, hasSpeechEnergy, pcmToWav, type VoiceDecision } from "./voice-audio.js";

type History = Array<{ role: "user" | "assistant"; content: string }>;
type Session = {
  channel: VoiceChannel; connection: VoiceConnection; player: ReturnType<typeof createAudioPlayer>;
  users: Set<string>; streams: Map<string, AudioReceiveStream>; pending: Array<{ userId: string; pcm: Buffer }>;
  busy: boolean; closed: boolean; history: History; lastActive: number; mutedUntil: number;
};
export class VoiceChat {
  private sessions = new Map<string, Session>();
  constructor(private client: Client, private answer: (text: string, history: History) => Promise<VoiceDecision>) {
    client.on(Events.VoiceStateUpdate, (_old, current) => {
      const session = this.sessions.get(current.guild.id);
      if (!session) return;
      if (current.id === client.user?.id && current.channelId !== session.channel.id) { this.close(session); return; }
      if (session.users.has(current.id) && current.channelId !== session.channel.id) {
        session.users.delete(current.id); session.streams.get(current.id)?.destroy();
        session.pending = session.pending.filter(x => x.userId !== current.id);
        if (!session.users.size) this.close(session);
      }
    });
    setInterval(() => {
      for (const s of this.sessions.values()) if (!s.busy && Date.now() - s.lastActive > 10 * 60_000) this.close(s);
    }, 30_000).unref();
  }
  async join(message: Message) {
    if (lifecycle.draining) throw new Error("更新中です。少し待ってもう一度呼んでください");
    if (!message.guild || !this.client.user) throw new Error("サーバーで呼んでください");
    const member = await message.guild.members.fetch(message.author.id);
    const channel = member.voice.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error("先に通常のボイスチャンネルに入ってから呼んでください");
    await message.guild.members.fetch(this.client.user.id);
    const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak;
    if (!channel.permissionsFor(member)?.has(required) || !channel.permissionsFor(this.client.user)?.has(required)) throw new Error("参加または発言の権限がありません");
    let session = this.sessions.get(message.guild.id);
    if (session && session.channel.id !== channel.id) throw new Error("別のボイスチャンネルで会話中です。先に退室してもらってください");
    if (!session) {
      const connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
      const player = createAudioPlayer();
      session = { channel, connection, player, users: new Set(), streams: new Map(), pending: [], busy: false, closed: false, history: [], lastActive: Date.now(), mutedUntil: 0 };
      const current = session;
      this.sessions.set(channel.guild.id, current);
      connection.subscribe(player);
      connection.on("error", error => { console.error("voice connection failed", error.message); this.close(current); });
      connection.on(VoiceConnectionStatus.Disconnected, () => this.close(current));
      player.on("error", error => console.error("voice playback failed", error.message));
      connection.receiver.speaking.on("start", userId => this.capture(current, userId));
      try { await entersState(connection, VoiceConnectionStatus.Ready, 30_000); }
      catch (error) { this.close(current); throw new Error("ボイス接続に失敗しました。もう一度呼んでください", { cause: error }); }
    }
    await entersState(session.connection, VoiceConnectionStatus.Ready, 30_000);
    session.users.add(member.id); session.lastActive = Date.now();
    return { joined: true, channel: channel.name, channelId: channel.id, listeningToRequester: true, note: "依頼した人の声だけを聞きます。他の人もスーへ会話を依頼すると参加できます。1発言30秒まで。返答の再生中は聞き取りを休みます。10分間会話がなければ退室します。" };
  }
  async leave(message: Message) {
    if (!message.guild) throw new Error("サーバーで呼んでください");
    const session = this.sessions.get(message.guild.id);
    if (!session) return { left: true, note: "今は通話に参加していません" };
    const member = await message.guild.members.fetch(message.author.id);
    if (!session.users.has(member.id) && !member.permissions.has(PermissionFlagsBits.MoveMembers)) throw new Error("会話を依頼した本人か管理者が退室を依頼できます");
    this.close(session); return { left: true };
  }
  stop() { for (const s of [...this.sessions.values()]) this.close(s); }
  private close(s: Session) {
    if (s.closed) return;
    s.closed = true; s.pending = []; s.history = [];
    for (const stream of s.streams.values()) stream.destroy();
    s.player.stop(true);
    if (s.connection.state.status !== VoiceConnectionStatus.Destroyed) s.connection.destroy();
    if (this.sessions.get(s.channel.guild.id) === s) this.sessions.delete(s.channel.guild.id);
  }
  private capture(s: Session, userId: string) {
    if (s.closed || lifecycle.draining || !s.users.has(userId) || s.streams.has(userId) || s.pending.length >= 2 || s.streams.size >= 3 || s.player.state.status !== AudioPlayerStatus.Idle || Date.now() < s.mutedUntil) return;
    // Never subscribe to unrequested people, including other bots.
    if (s.channel.members.get(userId)?.user.bot !== false) return;
    const stream = s.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
    s.streams.set(userId, stream);
    void lifecycle.run(async () => {
      const decoder = new OpusScript(48000, 2, OpusScript.Application.VOIP);
      const chunks: Buffer[] = []; let size = 0;
      const timer = setTimeout(() => stream.destroy(), MAX_VOICE_SECONDS * 1000);
      try {
        await new Promise<void>(resolve => {
          stream.on("data", (packet: Buffer) => {
            try {
              const pcm = Buffer.from(decoder.decode(packet));
              if (size + pcm.length > PCM_BYTES_PER_SECOND * MAX_VOICE_SECONDS) { stream.destroy(); return; }
              chunks.push(pcm); size += pcm.length;
            } catch { stream.destroy(); }
          });
          stream.once("end", resolve); stream.once("close", resolve); stream.once("error", () => resolve());
        });
      } finally { clearTimeout(timer); decoder.delete(); s.streams.delete(userId); }
      const pcm = Buffer.concat(chunks);
      if (!s.closed && !lifecycle.draining && s.player.state.status === AudioPlayerStatus.Idle && Date.now() >= s.mutedUntil && s.users.has(userId) && hasSpeechEnergy(pcm) && s.pending.length < 2) {
        console.log(`voice stage=received guild=${s.channel.guild.id} pcmBytes=${pcm.length}`);
        s.pending.push({ userId, pcm }); s.lastActive = Date.now();
        void this.process(s);
      }
    }).catch(error => console.error("voice capture failed", error.message));
  }
  private async process(s: Session) {
    if (s.busy || s.closed) return;
    s.busy = true;
    try {
      await lifecycle.run(async () => {
        while (s.pending.length && !s.closed && !lifecycle.draining) {
          const item = s.pending.shift()!;
          if (!s.users.has(item.userId)) continue;
          let shouldLeave = false;
          try {
            const transcript = await transcribeAudioBytes(pcmToWav(item.pcm));
            console.log(`voice stage=transcribed guild=${s.channel.guild.id} characters=${transcript.length}`);
            if (s.closed) break;
            const result = await this.answer(transcript, s.history);
            if (s.closed) break;
            console.log(`voice stage=decided guild=${s.channel.guild.id} action=${result.action}`);
            if (result.action === "ignore") continue;
            shouldLeave = result.action === "leave";
            s.history.push({ role: "user", content: transcript }, { role: "assistant", content: result.text });
            s.history = s.history.slice(-8);
            const audio = await synthesizeSpeech(result.text);
            console.log(`voice stage=synthesized guild=${s.channel.guild.id} audioBytes=${audio.length}`);
            if (s.closed || lifecycle.draining) break;
            // Discard overlapping speech before playback, preventing acoustic feedback.
            s.mutedUntil = Date.now() + 100_000;
            for (const stream of s.streams.values()) stream.destroy();
            const resource = createAudioResource(Readable.from([audio]));
            s.player.play(resource);
            try { await entersState(s.player, AudioPlayerStatus.Playing, 10_000); await entersState(s.player, AudioPlayerStatus.Idle, 90_000); }
            finally { s.player.stop(true); resource.playStream.destroy(); s.mutedUntil = Date.now() + 800; }
            s.lastActive = Date.now();
            console.log(`voice reply completed guild=${s.channel.guild.id} audioBytes=${audio.length}`);
            if (result.action === "leave") this.close(s);
          } catch (error) {
            s.player.stop(true); s.mutedUntil = Date.now() + 800;
            console.error("voice turn failed", error instanceof Error ? error.message : "unknown");
            if (!s.closed) await s.channel.send({ content: "すみません、今の音声への返答を完了できませんでした。少し待ってもう一度お願いします。", allowedMentions: { parse: [] } }).catch(() => {});
          } finally { if (shouldLeave) this.close(s); }
        }
      });
    } finally { s.busy = false; }
  }
}
