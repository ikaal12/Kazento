const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, AttachmentBuilder
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// =================== CONFIG ===================
const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;
const CH_PLAY   = process.env.CH_PLAY;
const CH_ADMIN  = process.env.CH_ADMIN;
const CH_LOGS   = process.env.CH_LOGS;
const CH_FAIR   = process.env.CH_FAIR;
const OWNER_ID  = process.env.OWNER_ID;

const REQUIRED_ENV = ['DISCORD_TOKEN','CLIENT_ID','GUILD_ID','CH_PLAY','CH_ADMIN','CH_LOGS','CH_FAIR','OWNER_ID','SUPABASE_URL','SUPABASE_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`❌ Missing env: ${key}`); process.exit(1); }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// =================== ASSETS ===================
const ASSET = {
  kazento: () => new AttachmentBuilder(path.join(__dirname, 'assets', 'Kazento.png'),      { name: 'Kazento.png'      }),
  heads:   () => new AttachmentBuilder(path.join(__dirname, 'assets', 'heads.png'),        { name: 'heads.png'        }),
  tails:   () => new AttachmentBuilder(path.join(__dirname, 'assets', 'tails.png'),        { name: 'tails.png'        }),
};

// =================== CONSTANTS ===================
const ROLES = [
  { role: 'Sultan Arab', min: 500000, daily: 120 },
  { role: 'Rich',        min: 100000, daily: 60  },
  { role: 'Ruby',        min: 50000,  daily: 20  },
  { role: 'Emerald',     min: 28000,  daily: 10  },
  { role: 'Diamond',     min: 18000,  daily: 8   },
  { role: 'Gold',        min: 12000,  daily: 6   },
  { role: 'Silver',      min: 5000,   daily: 4   },
  { role: 'Bronze',      min: 1000,   daily: 2.5 },
  { role: 'Unrank',      min: 0,      daily: 1   },
];

const BET_LIMITS = {
  default:  { min: 10,  max: 2000 },
  coinflip: { min: 1,   max: 1000 },
};

// Coinflip: chance menang = 50% / 2^index
const CF_MULTIPLIERS = [1.92, 3.84, 7.68, 15.36, 30.72, 61.44, 122.88, 245.76];

const COOLDOWNS  = new Map();
const pendingCF  = new Map(); // simpan bet coinflip sementara sebelum pilih multiplier

// =================== HELPERS ===================
function getRole(w) { for (const r of ROLES) if (w >= r.min) return r.role; return 'Unrank'; }
function getDailyBonus(role) { return ROLES.find(r => r.role === role)?.daily || 1; }
function fakeRTP() { return (Math.random() * 33 + 70).toFixed(1); }
function dl(n) { return `**${n}** <:DL:1497549302581563433>`; } // format angka + coin emoji

function checkCD(id) {
  const now = Date.now();
  const last = COOLDOWNS.get(id) || 0;
  if (now - last < 3000) return Math.ceil((3000 - (now - last)) / 1000);
  COOLDOWNS.set(id, now);
  return 0;
}

function validateBet(bet, game = 'default') {
  const lim = BET_LIMITS[game] || BET_LIMITS.default;
  if (isNaN(bet) || bet <= 0) return '❌ Bet tidak valid.';
  if (bet < lim.min) return `❌ Minimal bet **${lim.min}** <:DL:1497549302581563433>`;
  if (bet > lim.max) return `❌ Maksimal bet **${lim.max}** <:DL:1497549302581563433>`;
  return null;
}

// =================== DB ===================
async function getUser(id) {
  const { data, error } = await supabase.from('users').select('*').eq('phone', id).single();
  if (error && error.code !== 'PGRST116') console.error('getUser error:', error.message);
  return data || null;
}

async function createUser(id, name) {
  const { data, error } = await supabase.from('users').insert({ phone: id, name, role: 'Unrank', saldo: 0, total_wager: 0, profit_loss: 0, is_admin: false, is_owner: false }).select().single();
  if (error) console.error('createUser error:', error.message);
  return data || null;
}

async function getOrCreate(id, name) {
  let u = await getUser(id);
  if (!u) u = await createUser(id, name);
  else if (u.name !== name) {
    await supabase.from('users').update({ name }).eq('phone', id);
    u.name = name;
  }
  return u;
}

async function updateStats(id, saldoDelta, wagerDelta, plDelta) {
  const u = await getUser(id);
  if (!u) return { newSaldo: 0, newPL: 0, newRole: 'Unrank' };
  const ns = Number(u.saldo) + saldoDelta;
  const nw = Number(u.total_wager) + wagerDelta;
  const np = Number(u.profit_loss) + plDelta;
  const nr = getRole(nw);
  const { error } = await supabase.from('users').update({ saldo: ns, total_wager: nw, profit_loss: np, role: nr }).eq('phone', id);
  if (error) console.error('updateStats error:', error.message);
  return { newSaldo: ns, newPL: np, newRole: nr };
}

async function syncRole(guild, member, roleName) {
  try {
    for (const r of ROLES) {
      const dr = guild.roles.cache.find(x => x.name === r.role);
      if (dr && member.roles.cache.has(dr.id)) await member.roles.remove(dr);
    }
    const nr = guild.roles.cache.find(x => x.name === roleName);
    if (nr) await member.roles.add(nr);
  } catch { }
}

async function sendLog(client, msg) {
  try { const ch = await client.channels.fetch(CH_LOGS); if (ch) await ch.send(msg); } catch { }
}

// =================== BJ SESSION (Supabase persistent) ===================
async function bjGetSession(uid) {
  const { data } = await supabase.from('bj_sessions').select('*').eq('user_id', uid).single();
  return data ? data.session_data : null;
}

async function bjSetSession(uid, sess) {
  await supabase.from('bj_sessions').upsert({ user_id: uid, session_data: sess });
}

async function bjDeleteSession(uid) {
  await supabase.from('bj_sessions').delete().eq('user_id', uid);
}

// =================== GAMES ===================
function spinWheel() {
  let n = Math.floor(Math.random() * 100);
  let d = n.toString().padStart(2, '0').split('').map(Number);
  let s = d[0] + d[1];
  while (s >= 10) s = s.toString().split('').map(Number).reduce((a, b) => a + b, 0);
  return s;
}

// Reme — jackpot kalau player dapet 0
function calcReme(p, h, b) {
  if (p === 0) return { outcome: 'JACKPOT', payout: b * 3 };
  if (p === h) return { outcome: 'SERI',    payout: -b };
  if (p > h)   return { outcome: 'MENANG',  payout: b };
  return { outcome: 'KALAH', payout: -b };
}

function calcLeme(p, h, b) {
  if (h === 1 || h === 0) return { outcome: 'KALAH',      payout: -b    };
  if (p === 9 || p === 2) return { outcome: 'KALAH',      payout: -b    };
  if (p === 0)            return { outcome: 'JACKPOT 4x', payout: b * 4 };
  if (p === 1)            return { outcome: 'JACKPOT 3x', payout: b * 3 };
  if (p === h)            return { outcome: 'SERI',       payout: -b    };
  if (p > h)              return { outcome: 'MENANG',     payout: b     };
  return { outcome: 'KALAH', payout: -b };
}

function calcDice(p, h, b) {
  if (p === h) return { outcome: 'SERI',   payout: 0  };
  if (p > h)   return { outcome: 'MENANG', payout: b  };
  return { outcome: 'KALAH', payout: -b };
}

// Coinflip — chance menang = 50% / 2^index
function calcCoinflip(mIdx, bet) {
  const chanceWin = 0.5 / Math.pow(2, mIdx);
  if (Math.random() < chanceWin) {
    return { outcome: 'MENANG', side: 'heads', payout: Math.floor(bet * CF_MULTIPLIERS[mIdx]) };
  }
  return { outcome: 'KALAH', side: 'tails', payout: -bet };
}

// Blackjack
const CARDS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const VALS  = { A:11,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:10,Q:10,K:10 };

function drawCard() { return CARDS[Math.floor(Math.random() * 13)]; }
function handValue(cards) {
  let t = cards.reduce((a, c) => a + VALS[c], 0);
  let aces = cards.filter(c => c === 'A').length;
  while (t > 21 && aces > 0) { t -= 10; aces--; }
  return t;
}
function isBlackjack(cards) { return cards.length === 2 && handValue(cards) === 21; }
function dealerPlay(hand) { while (handValue(hand) < 17) hand.push(drawCard()); return hand; }

function bjPayout(ph, dh, bet, action, ins = 0) {
  const pv = handValue(ph), dv = handValue(dh);
  const pbj = isBlackjack(ph), dbj = isBlackjack(dh);
  let payout = 0, result = '';
  if (ins > 0) payout += dbj ? ins * 2 : -ins;
  if (action === 'surrender') return { result: 'SURRENDER', payout: payout - (bet / 2) };
  if (pbj && dbj) return { result: 'PUSH', payout };
  if (pbj) return { result: 'BLACKJACK', payout: payout + bet * 1.5 };
  if (dbj) return { result: 'KALAH', payout: payout - bet };
  if (pv > 21) return { result: 'BUST', payout: payout - bet };
  if (dv > 21) return { result: 'MENANG', payout: payout + bet };
  if (pv > dv) { result = 'MENANG'; payout += bet; }
  else if (pv === dv) { result = 'PUSH'; }
  else { result = 'KALAH'; payout -= bet; }
  return { result, payout };
}

// =================== UI BUILDERS ===================
function profileEmbed(u, du) {
  const pl = Number(u.profit_loss) >= 0 ? `+${u.profit_loss}` : `${u.profit_loss}`;
  return new EmbedBuilder().setTitle('👤 PROFIL').setColor(0x9B59B6)
    .setThumbnail('attachment://Kazento.png')
    .addFields(
      { name: '📱 User',  value: `<@${du.id}>`,    inline: true },
      { name: '💰 Saldo', value: dl(u.saldo),       inline: true },
      { name: '🏅 Role',  value: u.role,            inline: true },
      { name: '🎯 Wager', value: dl(u.total_wager), inline: true },
      { name: '📊 P/L',   value: `${pl} <:DL:1497549302581563433>`,       inline: true }
    ).setTimestamp();
}

function menuRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_game').setLabel('🎮 Game').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_deposit').setLabel('💳 Deposit').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('btn_withdraw').setLabel('💸 Withdraw').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_daily').setLabel('🎁 Daily').setStyle(ButtonStyle.Secondary)
  );
}

function gameEmbed() {
  return new EmbedBuilder().setTitle('🎮 PILIH GAME').setColor(0x9B59B6)
    .addFields(
      { name: '🎡 Reme',     value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🎰 Leme',     value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🎲 Dice',     value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🃏 Blackjack',value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '<:DL:1497549302581563433> Coinflip', value: `RTP ${fakeRTP()}%`, inline: true },
    );
}

function gameRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_reme').setLabel('🎡 Reme').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_leme').setLabel('🎰 Leme').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_dice').setLabel('🎲 Dice').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_bj').setLabel('🃏 Blackjack').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_coinflip').setLabel('<:DL:1497549302581563433> Coinflip').setStyle(ButtonStyle.Secondary)
  );
}

function betModal(gid, gl, minBet = 10, maxBet = 2000) {
  const m = new ModalBuilder().setCustomId('modal_' + gid).setTitle(gl + ' - Bet');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('bet_input')
      .setLabel(`Jumlah Bet (Min: ${minBet} | Max: ${maxBet})`)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(`${minBet} - ${maxBet}`)
      .setRequired(true)
  ));
  return m;
}

function coinflipSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cf_select')
      .setPlaceholder('Pilih multiplier...')
      .addOptions(CF_MULTIPLIERS.map((m, i) => {
        const chance = (0.5 / Math.pow(2, i) * 100).toFixed(2);
        return { label: `${m}x  —  ${chance}% menang`, value: `${i}` };
      }))
  );
}

function resultEmbed(gn, p, h, outcome, payout, ns, np, nr, gid) {
  const e = outcome.includes('JACKPOT') ? '🎉' : outcome === 'MENANG' ? '✅' : outcome === 'SERI' ? '🤝' : '❌';
  const c = outcome.includes('JACKPOT') ? 0xFFD700 : outcome === 'MENANG' ? 0x2ECC71 : outcome === 'SERI' ? 0xF39C12 : 0xE74C3C;
  const plt = np >= 0 ? `+${np}` : `${np}`;
  return new EmbedBuilder().setTitle(gn).setColor(c)
    .setThumbnail('attachment://Kazento.png')
    .addFields(
      { name: '🎯 Kamu',  value: `${p}`,                                    inline: true },
      { name: '🏠 House', value: `${h}`,                                    inline: true },
      { name: '\u200B',   value: '\u200B',                                  inline: true },
      { name: 'Hasil',    value: `${e} ${outcome}`,                         inline: true },
      { name: 'Payout',   value: `${payout >= 0 ? '+' : ''}${payout} <:DL:1497549302581563433>`,  inline: true },
      { name: '\u200B',   value: '\u200B',                                  inline: true },
      { name: '💰 Saldo', value: dl(ns),                                    inline: true },
      { name: '📊 P/L',   value: `${plt} <:DL:1497549302581563433>`,                             inline: true },
      { name: '🏅 Role',  value: nr,                                        inline: true }
    ).setFooter({ text: 'ID: ' + gid }).setTimestamp();
}

function coinflipEmbed(side, mIdx, payout, ns, np, nr, gid) {
  const menang = side === 'heads';
  const c   = menang ? 0x2ECC71 : 0xE74C3C;
  const e   = menang ? '✅' : '❌';
  const plt = np >= 0 ? `+${np}` : `${np}`;
  return new EmbedBuilder()
    .setTitle(`<:DL:1497549302581563433> COINFLIP`)
    .setColor(c)
    .addFields(
      { name: 'Hasil',    value: `${e} ${menang ? '<:Heads:1497549398819999795> HEADS' : '<:Tails:1497549457980522496> TAILS'} — ${CF_MULTIPLIERS[mIdx]}x`, inline: true },
      { name: 'Payout',   value: `${payout >= 0 ? '+' : ''}${payout} <:DL:1497549302581563433>`,                          inline: true },
      { name: '\u200B',   value: '\u200B',                                                          inline: true },
      { name: '💰 Saldo', value: dl(ns),                                                            inline: true },
      { name: '📊 P/L',   value: `${plt} <:DL:1497549302581563433>`,                                                     inline: true },
      { name: '🏅 Role',  value: nr,                                                               inline: true },
    ).setFooter({ text: 'ID: ' + gid }).setTimestamp();
}

function bjEmbed(sess) {
  const pv = handValue(sess.playerHand);
  return new EmbedBuilder().setTitle('🃏 BLACKJACK').setColor(0x2C3E50)
    .setThumbnail('attachment://Kazento.png')
    .addFields(
      { name: '🎴 Tangan Kamu', value: `${sess.playerHand.join(' ')} = **${pv}**`, inline: false },
      { name: '🏠 Dealer',      value: `${sess.dealerHand[0]} ??`,                 inline: false },
      { name: '💰 Bet',         value: dl(sess.bet),                               inline: true  }
    );
}

function bjEndEmbed(sess, result, payout, ns, np, nr, gid) {
  const pv = handValue(sess.playerHand), dv = handValue(sess.dealerHand);
  const c  = result === 'MENANG' || result === 'BLACKJACK' ? 0x2ECC71 : result === 'PUSH' ? 0xF39C12 : 0xE74C3C;
  const e  = result === 'BLACKJACK' ? '🎉' : result === 'MENANG' ? '✅' : result === 'PUSH' ? '🤝' : '❌';
  const plt = np >= 0 ? `+${np}` : `${np}`;
  return new EmbedBuilder().setTitle('🃏 BLACKJACK').setColor(c)
    .setThumbnail('attachment://Kazento.png')
    .addFields(
      { name: '🎴 Kamu',  value: `${sess.playerHand.join(' ')} = **${pv}**`, inline: true },
      { name: '🏠 Dealer',value: `${sess.dealerHand.join(' ')} = **${dv}**`, inline: true },
      { name: '\u200B',   value: '\u200B',                                    inline: true },
      { name: 'Hasil',    value: `${e} ${result}`,                            inline: true },
      { name: 'Payout',   value: `${payout >= 0 ? '+' : ''}${payout} <:DL:1497549302581563433>`,    inline: true },
      { name: '\u200B',   value: '\u200B',                                    inline: true },
      { name: '💰 Saldo', value: dl(ns),                                      inline: true },
      { name: '📊 P/L',   value: `${plt} <:DL:1497549302581563433>`,                               inline: true },
      { name: '🏅 Role',  value: nr,                                          inline: true }
    ).setFooter({ text: 'ID: ' + gid }).setTimestamp();
}

function bjActionRow(canDouble, canSplit, canSurrender) {
  const row = new ActionRowBuilder();
  row.addComponents(new ButtonBuilder().setCustomId('bj_hit').setLabel('👊 Hit').setStyle(ButtonStyle.Primary));
  row.addComponents(new ButtonBuilder().setCustomId('bj_stand').setLabel('✋ Stand').setStyle(ButtonStyle.Secondary));
  if (canDouble)    row.addComponents(new ButtonBuilder().setCustomId('bj_double').setLabel('⚡ Double').setStyle(ButtonStyle.Success));
  if (canSplit)     row.addComponents(new ButtonBuilder().setCustomId('bj_split').setLabel('✂️ Split').setStyle(ButtonStyle.Primary));
  if (canSurrender) row.addComponents(new ButtonBuilder().setCustomId('bj_surrender').setLabel('🏳️ Surrender').setStyle(ButtonStyle.Danger));
  return row;
}

function bjInsuranceRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bj_ins_yes').setLabel('🛡️ Insurance').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('bj_ins_no').setLabel('❌ Skip').setStyle(ButtonStyle.Secondary)
  );
}

// =================== COMMANDS ===================
const commands = [
  new SlashCommandBuilder().setName('menu').setDescription('Lihat profil'),
  new SlashCommandBuilder().setName('game').setDescription('Pilih game'),
  new SlashCommandBuilder().setName('deposit').setDescription('Info deposit'),
  new SlashCommandBuilder().setName('withdraw').setDescription('Info withdraw'),
  new SlashCommandBuilder().setName('daily').setDescription('Claim daily bonus'),
  new SlashCommandBuilder().setName('history').setDescription('History 5 game terakhir'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top 5 player'),
  new SlashCommandBuilder().setName('verify').setDescription('Verify hasil game').addStringOption(o => o.setName('id').setDescription('Game ID').setRequired(true)),
  new SlashCommandBuilder().setName('redeem').setDescription('Redeem promo code').addStringOption(o => o.setName('kode').setDescription('Kode').setRequired(true)),
  new SlashCommandBuilder().setName('addbal').setDescription('[ADMIN] Tambah saldo').addStringOption(o => o.setName('user').setDescription('Discord ID').setRequired(true)).addNumberOption(o => o.setName('jumlah').setDescription('DL').setRequired(true)),
  new SlashCommandBuilder().setName('setbal').setDescription('[ADMIN] Set saldo').addStringOption(o => o.setName('user').setDescription('Discord ID').setRequired(true)).addNumberOption(o => o.setName('jumlah').setDescription('DL').setRequired(true)),
  new SlashCommandBuilder().setName('resetbal').setDescription('[ADMIN] Reset saldo').addStringOption(o => o.setName('user').setDescription('Discord ID').setRequired(true)),
  new SlashCommandBuilder().setName('ceksaldo').setDescription('[ADMIN] Cek saldo').addStringOption(o => o.setName('user').setDescription('Discord ID').setRequired(true)),
  new SlashCommandBuilder().setName('setadmin').setDescription('[OWNER] Set admin').addStringOption(o => o.setName('user').setDescription('Discord ID').setRequired(true)),
  new SlashCommandBuilder().setName('createpromo').setDescription('[ADMIN] Buat promo').addStringOption(o => o.setName('kode').setDescription('Kode').setRequired(true)).addNumberOption(o => o.setName('dl').setDescription('DL').setRequired(true)).addIntegerOption(o => o.setName('kuota').setDescription('Kuota').setRequired(true)).addStringOption(o => o.setName('role').setDescription('Min role').setRequired(true)),
];

// =================== CLIENT ===================
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
  console.log('✅ Bot nyala: ' + client.user.tag);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
  console.log('✅ Commands registered!');
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.guild) {
      if (interaction.isRepliable()) await interaction.reply({ content: '❌ Bot hanya bisa digunakan di server.', flags: 64 });
      return;
    }

    const uid   = interaction.user.id;
    const uname = interaction.user.username;
    const guild = interaction.guild;
    const chId  = interaction.channelId;

    const user = await getOrCreate(uid, uname);
    if (!user) {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Error load user, coba lagi.', flags: 64 });
      return;
    }

    const isOwner = uid === OWNER_ID || user.is_owner === true;
    const isAdmin = isOwner || user.is_admin === true;

    // =================== SLASH COMMANDS ===================
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (['menu','game','deposit','withdraw','daily','history','leaderboard'].includes(cmd) && chId !== CH_PLAY && !isAdmin)
        return interaction.reply({ content: `❌ Command ini hanya di <#${CH_PLAY}>`, flags: 64 });

      if (['addbal','setbal','resetbal','ceksaldo','setadmin','createpromo'].includes(cmd) && chId !== CH_ADMIN && !isAdmin)
        return interaction.reply({ content: `❌ Command ini hanya di <#${CH_ADMIN}>`, flags: 64 });

      if (cmd === 'verify' && chId !== CH_FAIR)
        return interaction.reply({ content: `❌ Command ini hanya di <#${CH_FAIR}>`, flags: 64 });

      if (cmd === 'menu') {
        const freshUser = await getUser(uid);
        if (!freshUser) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
        return interaction.reply({ embeds: [profileEmbed(freshUser, interaction.user)], files: [ASSET.kazento()], components: [menuRow()], flags: 64 });
      }
      if (cmd === 'game')     return interaction.reply({ embeds: [gameEmbed()], components: [gameRow()], flags: 64 });
      if (cmd === 'deposit')  return interaction.reply({ content: '💳 Make a ticket to **Deposit**', flags: 64 });
      if (cmd === 'withdraw') return interaction.reply({ content: '💸 Make a ticket to **Withdraw**', flags: 64 });

      if (cmd === 'daily') {
        const now = new Date();
        const freshUser = await getUser(uid);
        const lcFresh = freshUser?.last_daily ? new Date(freshUser.last_daily) : null;
        if (lcFresh && (now - lcFresh) < 86400000) {
          const r = Math.ceil((86400000 - (now - lcFresh)) / 3600000);
          return interaction.reply({ content: `❌ Balik lagi dalam **${r} jam**.`, flags: 64 });
        }
        const bonus = getDailyBonus(freshUser.role);
        const ns = Number(freshUser.saldo) + bonus;
        await supabase.from('users').update({ saldo: ns, last_daily: now.toISOString() }).eq('phone', uid);
        await sendLog(client, `📅 **DAILY** | <@${uid}> +${bonus} DL | ${freshUser.role}`);
        return interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🎁 Daily!').setColor(0x2ECC71).setThumbnail('attachment://Kazento.png').setDescription(`+**${bonus}** <:DL:1497549302581563433>\nSaldo: ${dl(ns)}`)],
          files: [ASSET.kazento()], flags: 64
        });
      }

      if (cmd === 'history') {
        const { data: h } = await supabase.from('game_history').select('*').eq('phone', uid).order('created_at', { ascending: false }).limit(5);
        if (!h?.length) return interaction.reply({ content: '❌ Belum ada history.', flags: 64 });
        const e = new EmbedBuilder().setTitle('📜 History').setColor(0x9B59B6);
        for (const x of h) {
          const em = x.payout > 0 ? '✅' : x.payout === 0 ? '🤝' : '❌';
          e.addFields({ name: `${em} ${x.game.toUpperCase()}`, value: `Bet: ${x.bet} <:DL:1497549302581563433> | ${x.payout >= 0 ? '+' : ''}${x.payout} <:DL:1497549302581563433>`, inline: false });
        }
        return interaction.reply({ embeds: [e], flags: 64 });
      }

      if (cmd === 'leaderboard') {
        const { data: lb } = await supabase.from('users').select('phone,name,total_wager,role').order('total_wager', { ascending: false }).limit(5);
        if (!lb?.length) return interaction.reply({ content: '❌ Belum ada data.', flags: 64 });
        const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
        const e = new EmbedBuilder().setTitle('🏆 Leaderboard').setColor(0xFFD700);
        lb.forEach((u, i) => e.addFields({ name: `${medals[i]} ${u.name || u.phone}`, value: `${u.total_wager} <:DL:1497549302581563433> | ${u.role}`, inline: false }));
        return interaction.reply({ embeds: [e], flags: 64 });
      }

      if (cmd === 'verify') {
        const id = interaction.options.getString('id');
        const { data: gh } = await supabase.from('game_history').select('*').eq('id', id).single();
        if (!gh) return interaction.reply({ content: '❌ ID tidak ditemukan.', flags: 64 });
        const e = new EmbedBuilder().setTitle('🔍 Provably Fair').setColor(0x3498DB)
          .addFields(
            { name: '🎮 Game',   value: gh.game.toUpperCase(),                           inline: true  },
            { name: '🎯 Player', value: `${gh.player_number}`,                           inline: true  },
            { name: '🏠 House',  value: `${gh.house_number}`,                            inline: true  },
            { name: '📊 Result', value: gh.result,                                       inline: true  },
            { name: '💰 Bet',    value: `${gh.bet} <:DL:1497549302581563433>`,                                 inline: true  },
            { name: '💸 Payout', value: `${gh.payout} <:DL:1497549302581563433>`,                              inline: true  },
            { name: '🕐 Waktu',  value: new Date(gh.created_at).toLocaleString('id-ID'), inline: false }
          ).setFooter({ text: 'ID: ' + gh.id });
        return interaction.reply({ embeds: [e], flags: 64 });
      }

      if (cmd === 'redeem') {
        const kode = interaction.options.getString('kode').toUpperCase();
        const { data: promo } = await supabase.from('promos').select('*').eq('kode', kode).single();
        if (!promo) return interaction.reply({ content: '❌ Kode tidak valid.', flags: 64 });
        if (promo.kuota <= 0) return interaction.reply({ content: '❌ Kode habis.', flags: 64 });
        const ui = ROLES.findIndex(r => r.role === user.role);
        const mi = ROLES.findIndex(r => r.role === promo.min_role);
        if (ui > mi) return interaction.reply({ content: `❌ Khusus role **${promo.min_role}** ke atas.`, flags: 64 });
        const { data: used } = await supabase.from('promo_usage').select('*').eq('kode', kode).eq('user_id', uid).single();
        if (used) return interaction.reply({ content: '❌ Udah pernah redeem.', flags: 64 });
        const ns = Number(user.saldo) + promo.dl;
        await supabase.from('users').update({ saldo: ns }).eq('phone', uid);
        await supabase.from('promos').update({ kuota: promo.kuota - 1 }).eq('kode', kode);
        await supabase.from('promo_usage').insert({ kode, user_id: uid });
        await sendLog(client, `🎟️ **REDEEM** | <@${uid}> ${kode} +${promo.dl} DL`);
        return interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🎟️ Redeemed!').setColor(0x2ECC71).setThumbnail('attachment://Kazento.png').setDescription(`+**${promo.dl}** <:DL:1497549302581563433>\nSaldo: ${dl(ns)}`)],
          files: [ASSET.kazento()], flags: 64
        });
      }

      // ADMIN COMMANDS
      if (cmd === 'addbal') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const tid = interaction.options.getString('user');
        const amt = interaction.options.getNumber('jumlah');
        const t   = await getOrCreate(tid, tid);
        const ns  = Number(t.saldo) + amt;
        await supabase.from('users').update({ saldo: ns }).eq('phone', tid);
        await supabase.from('transactions').insert({ phone: tid, type: 'deposit', amount: amt, note: 'addbal by ' + uid });
        await sendLog(client, `💰 **ADDBAL** | <@${uid}>→<@${tid}> +${amt} DL`);
        return interaction.reply({ content: `✅ +${amt} <:DL:1497549302581563433> → <@${tid}>. Saldo: ${dl(ns)}`, flags: 64 });
      }

      if (cmd === 'setbal') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const tid = interaction.options.getString('user');
        const amt = interaction.options.getNumber('jumlah');
        await supabase.from('users').update({ saldo: amt }).eq('phone', tid);
        await sendLog(client, `⚙️ **SETBAL** | <@${uid}>→<@${tid}> ${amt} DL`);
        return interaction.reply({ content: `✅ Saldo <@${tid}> = ${dl(amt)}`, flags: 64 });
      }

      if (cmd === 'resetbal') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const tid = interaction.options.getString('user');
        await supabase.from('users').update({ saldo: 0 }).eq('phone', tid);
        await sendLog(client, `🔄 **RESETBAL** | <@${uid}>→<@${tid}>`);
        return interaction.reply({ content: `✅ Saldo <@${tid}> reset ke 0.`, flags: 64 });
      }

      if (cmd === 'ceksaldo') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const tid = interaction.options.getString('user');
        const t   = await getUser(tid);
        if (!t) return interaction.reply({ content: '❌ User tidak ada.', flags: 64 });
        const pl = Number(t.profit_loss) >= 0 ? `+${t.profit_loss}` : `${t.profit_loss}`;
        return interaction.reply({
          embeds: [new EmbedBuilder().setTitle('👤 ' + (t.name || tid)).setColor(0x9B59B6)
            .addFields(
              { name: '💰 Saldo', value: dl(t.saldo),       inline: true },
              { name: '🏅 Role',  value: t.role,            inline: true },
              { name: '🎯 Wager', value: dl(t.total_wager), inline: true },
              { name: '📊 P/L',   value: `${pl} <:DL:1497549302581563433>`,       inline: true }
            )], flags: 64
        });
      }

      if (cmd === 'setadmin') {
        if (!isOwner) return interaction.reply({ content: '❌ Bukan owner.', flags: 64 });
        const tid = interaction.options.getString('user');
        await getOrCreate(tid, tid);
        await supabase.from('users').update({ is_admin: true }).eq('phone', tid);
        return interaction.reply({ content: `✅ <@${tid}> sekarang admin.`, flags: 64 });
      }

      if (cmd === 'createpromo') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const kode    = interaction.options.getString('kode').toUpperCase();
        const dl_amt  = interaction.options.getNumber('dl');
        const kuota   = interaction.options.getInteger('kuota');
        const minRole = interaction.options.getString('role');
        await supabase.from('promos').insert({ kode, dl: dl_amt, kuota, min_role: minRole });
        return interaction.reply({ content: `✅ Promo **${kode}** | ${dl_amt} <:DL:1497549302581563433> | ${kuota} orang | Min: ${minRole}`, flags: 64 });
      }
    }

    // =================== BUTTONS ===================
    if (interaction.isButton()) {
      const cid = interaction.customId;

      if (cid === 'btn_game')     return interaction.update({ embeds: [gameEmbed()], components: [gameRow()] });
      if (cid === 'btn_deposit')  return interaction.reply({ content: '💳 Make a ticket to **Deposit**', flags: 64 });
      if (cid === 'btn_withdraw') return interaction.reply({ content: '💸 Make a ticket to **Withdraw**', flags: 64 });

      if (cid === 'btn_daily') {
        const now = new Date();
        const freshUser = await getUser(uid);
        const lc = freshUser?.last_daily ? new Date(freshUser.last_daily) : null;
        if (lc && (now - lc) < 86400000) {
          const r = Math.ceil((86400000 - (now - lc)) / 3600000);
          return interaction.reply({ content: `❌ Balik lagi dalam **${r} jam**.`, flags: 64 });
        }
        const bonus = getDailyBonus(freshUser.role);
        const ns    = Number(freshUser.saldo) + bonus;
        await supabase.from('users').update({ saldo: ns, last_daily: now.toISOString() }).eq('phone', uid);
        await sendLog(client, `📅 **DAILY** | <@${uid}> +${bonus} DL`);
        return interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🎁 Daily!').setColor(0x2ECC71).setThumbnail('attachment://Kazento.png').setDescription(`+**${bonus}** <:DL:1497549302581563433>\nSaldo: ${dl(ns)}`)],
          files: [ASSET.kazento()], flags: 64
        });
      }

      if (cid === 'btn_reme')     return interaction.showModal(betModal('reme', '🎡 Reme'));
      if (cid === 'btn_leme')     return interaction.showModal(betModal('leme', '🎰 Leme'));
      if (cid === 'btn_dice')     return interaction.showModal(betModal('dice', '🎲 Dice'));
      if (cid === 'btn_bj')       return interaction.showModal(betModal('bj', '🃏 Blackjack'));
      if (cid === 'btn_coinflip') return interaction.showModal(betModal('coinflip', '<:DL:1497549302581563433> Coinflip', 1, 1000));

      // =================== BLACKJACK BUTTONS ===================
      if (['bj_hit','bj_stand','bj_double','bj_split','bj_surrender','bj_ins_yes','bj_ins_no'].includes(cid)) {
        const cd = checkCD(uid + '_bj');
        if (cd > 0) return interaction.reply({ content: `⏳ Cooldown ${cd}s.`, flags: 64 });

        const sess = await bjGetSession(uid);
        if (!sess) return interaction.reply({ content: '❌ Sesi BJ tidak ditemukan. Mulai game baru.', flags: 64 });

        const u2 = await getUser(uid);
        if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });

        if (cid === 'bj_ins_yes') {
          const insBet = sess.bet / 2;
          if (Number(u2.saldo) < insBet) return interaction.reply({ content: '❌ Saldo kurang untuk insurance.', flags: 64 });
          sess.insuranceBet = insBet;
          await supabase.from('users').update({ saldo: Number(u2.saldo) - insBet }).eq('phone', uid);
          await bjSetSession(uid, sess);
          const canDouble = Number(u2.saldo) - insBet >= sess.bet;
          const canSplit  = sess.playerHand[0] === sess.playerHand[1] && Number(u2.saldo) - insBet >= sess.bet;
          try { return await interaction.update({ embeds: [bjEmbed(sess)], files: [ASSET.kazento()], components: [bjActionRow(canDouble, canSplit, true)] }); } catch { return; }
        }

        if (cid === 'bj_ins_no') {
          sess.insuranceBet = 0;
          await bjSetSession(uid, sess);
          const canDouble = Number(u2.saldo) >= sess.bet;
          const canSplit  = sess.playerHand[0] === sess.playerHand[1] && Number(u2.saldo) >= sess.bet;
          try { return await interaction.update({ embeds: [bjEmbed(sess)], files: [ASSET.kazento()], components: [bjActionRow(canDouble, canSplit, true)] }); } catch { return; }
        }

        if (cid === 'bj_hit') {
          sess.playerHand.push(drawCard());
          await bjSetSession(uid, sess);
          const pv = handValue(sess.playerHand);
          if (pv >= 21) {
            sess.dealerHand = dealerPlay(sess.dealerHand);
            const { result, payout } = bjPayout(sess.playerHand, sess.dealerHand, sess.bet, 'stand', sess.insuranceBet);
            const { newSaldo, newPL, newRole } = await updateStats(uid, payout + sess.bet, sess.bet, payout);
            const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: 'blackjack', bet: sess.bet, result, player_number: pv, house_number: handValue(sess.dealerHand), payout }).select().single();
            await bjDeleteSession(uid);
            try { const m = await guild.members.fetch(uid); await syncRole(guild, m, newRole); } catch { }
            await sendLog(client, `🃏 **BJ** | <@${uid}> | ${result} | ${payout >= 0 ? '+' : ''}${payout} DL`);
            try { return await interaction.update({ embeds: [bjEndEmbed(sess, result, payout, newSaldo, newPL, newRole, gh?.id || '-')], files: [ASSET.kazento()], components: [] }); } catch { return; }
          }
          try { return await interaction.update({ embeds: [bjEmbed(sess)], files: [ASSET.kazento()], components: [bjActionRow(false, false, false)] }); } catch { return; }
        }

        if (cid === 'bj_stand') {
          sess.dealerHand = dealerPlay(sess.dealerHand);
          const { result, payout } = bjPayout(sess.playerHand, sess.dealerHand, sess.bet, 'stand', sess.insuranceBet);
          const { newSaldo, newPL, newRole } = await updateStats(uid, payout + sess.bet, sess.bet, payout);
          const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: 'blackjack', bet: sess.bet, result, player_number: handValue(sess.playerHand), house_number: handValue(sess.dealerHand), payout }).select().single();
          await bjDeleteSession(uid);
          try { const m = await guild.members.fetch(uid); await syncRole(guild, m, newRole); } catch { }
          await sendLog(client, `🃏 **BJ** | <@${uid}> | ${result} | ${payout >= 0 ? '+' : ''}${payout} DL`);
          try { return await interaction.update({ embeds: [bjEndEmbed(sess, result, payout, newSaldo, newPL, newRole, gh?.id || '-')], files: [ASSET.kazento()], components: [] }); } catch { return; }
        }

        if (cid === 'bj_double') {
          if (Number(u2.saldo) < sess.bet) return interaction.reply({ content: '❌ Saldo kurang untuk double.', flags: 64 });
          await supabase.from('users').update({ saldo: Number(u2.saldo) - sess.bet }).eq('phone', uid);
          sess.bet = sess.bet * 2;
          sess.playerHand.push(drawCard());
          sess.dealerHand = dealerPlay(sess.dealerHand);
          const { result, payout } = bjPayout(sess.playerHand, sess.dealerHand, sess.bet, 'stand', sess.insuranceBet);
          const { newSaldo, newPL, newRole } = await updateStats(uid, payout + sess.bet, sess.bet, payout);
          const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: 'blackjack', bet: sess.bet, result, player_number: handValue(sess.playerHand), house_number: handValue(sess.dealerHand), payout }).select().single();
          await bjDeleteSession(uid);
          try { const m = await guild.members.fetch(uid); await syncRole(guild, m, newRole); } catch { }
          await sendLog(client, `🃏 **BJ DOUBLE** | <@${uid}> | ${result} | ${payout >= 0 ? '+' : ''}${payout} DL`);
          try { return await interaction.update({ embeds: [bjEndEmbed(sess, result, payout, newSaldo, newPL, newRole, gh?.id || '-')], files: [ASSET.kazento()], components: [] }); } catch { return; }
        }

        if (cid === 'bj_split') {
          if (Number(u2.saldo) < sess.bet) return interaction.reply({ content: '❌ Saldo kurang untuk split.', flags: 64 });
          await supabase.from('users').update({ saldo: Number(u2.saldo) - sess.bet }).eq('phone', uid);
          const splitCard = sess.playerHand[1];
          sess.playerHand = [sess.playerHand[0], drawCard()];
          sess.splitHand  = [splitCard, drawCard()];
          if (splitCard === 'A') {
            sess.dealerHand = dealerPlay(sess.dealerHand);
            const r1 = bjPayout(sess.playerHand, sess.dealerHand, sess.bet / 2, 'stand', 0);
            const r2 = bjPayout(sess.splitHand,  sess.dealerHand, sess.bet / 2, 'stand', 0);
            const totalPayout = r1.payout + r2.payout;
            const { newSaldo, newPL, newRole } = await updateStats(uid, totalPayout + sess.bet, sess.bet, totalPayout);
            const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: 'blackjack', bet: sess.bet, result: `SPLIT: ${r1.result}/${r2.result}`, player_number: handValue(sess.playerHand), house_number: handValue(sess.dealerHand), payout: totalPayout }).select().single();
            await bjDeleteSession(uid);
            const emb = new EmbedBuilder().setTitle('🃏 BJ SPLIT ACE').setColor(totalPayout >= 0 ? 0x2ECC71 : 0xE74C3C)
              .setThumbnail('attachment://Kazento.png')
              .addFields(
                { name: 'Hand 1', value: `${sess.playerHand.join(' ')} = ${handValue(sess.playerHand)} → ${r1.result}`, inline: false },
                { name: 'Hand 2', value: `${sess.splitHand.join(' ')} = ${handValue(sess.splitHand)} → ${r2.result}`,   inline: false },
                { name: 'Dealer', value: `${sess.dealerHand.join(' ')} = ${handValue(sess.dealerHand)}`,                 inline: false },
                { name: 'Total',  value: `${totalPayout >= 0 ? '+' : ''}${totalPayout} <:DL:1497549302581563433>`,                             inline: true  },
                { name: 'Saldo',  value: dl(newSaldo),                                                                   inline: true  }
              ).setFooter({ text: 'ID: ' + (gh?.id || '-') });
            try { return await interaction.update({ embeds: [emb], files: [ASSET.kazento()], components: [] }); } catch { return; }
          }
          await bjSetSession(uid, sess);
          try { return await interaction.update({ embeds: [bjEmbed(sess)], files: [ASSET.kazento()], components: [bjActionRow(false, false, false)] }); } catch { return; }
        }

        if (cid === 'bj_surrender') {
          const { result, payout } = bjPayout(sess.playerHand, sess.dealerHand, sess.bet, 'surrender', sess.insuranceBet);
          const { newSaldo, newPL, newRole } = await updateStats(uid, payout + sess.bet, sess.bet, payout);
          await bjDeleteSession(uid);
          await sendLog(client, `🃏 **BJ SURRENDER** | <@${uid}> | ${payout} DL`);
          try { return await interaction.update({ embeds: [bjEndEmbed(sess, result, payout, newSaldo, newPL, newRole, '-')], files: [ASSET.kazento()], components: [] }); } catch { return; }
        }
      }
    }

    // =================== SELECT MENU (Coinflip multiplier) ===================
    if (interaction.isStringSelectMenu() && interaction.customId === 'cf_select') {
      const pending = pendingCF.get(uid);
      if (!pending) return interaction.reply({ content: '❌ Session expired. Mulai lagi.', flags: 64 });
      pendingCF.delete(uid);

      const mIdx = parseInt(interaction.values[0]);
      const bet  = pending.bet;
      const u2   = await getUser(uid);
      if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
      if (Number(u2.saldo) < bet) return interaction.reply({ content: `❌ Saldo kurang. Saldo: ${dl(u2.saldo)}`, flags: 64 });

      const { outcome, side, payout } = calcCoinflip(mIdx, bet);
      const { newSaldo, newPL, newRole } = await updateStats(uid, payout, bet, payout);
      const { data: gh } = await supabase.from('game_history').insert({
        phone: uid, game: 'coinflip', bet,
        result: outcome, player_number: mIdx,
        house_number: side === 'heads' ? 1 : 0, payout
      }).select().single();

      try { const m = await guild.members.fetch(uid); await syncRole(guild, m, newRole); } catch { }
      await sendLog(client, `<:DL:1497549302581563433> **COINFLIP** | <@${uid}> | ${CF_MULTIPLIERS[mIdx]}x | ${outcome} | ${payout >= 0 ? '+' : ''}${payout} DL`);

      return interaction.update({
        embeds: [coinflipEmbed(side, mIdx, payout, newSaldo, newPL, newRole, gh?.id || '-')],
        files: [ASSET.kazento()],
        components: []
      });
    }

    // =================== MODALS ===================
    if (interaction.isModalSubmit()) {
      const cid = interaction.customId;
      const bet = parseFloat(interaction.fields.getTextInputValue('bet_input'));

      // Coinflip
      if (cid === 'modal_coinflip') {
        const err = validateBet(bet, 'coinflip');
        if (err) return interaction.reply({ content: err, flags: 64 });
        const cd = checkCD(uid);
        if (cd > 0) return interaction.reply({ content: `⏳ Cooldown ${cd}s.`, flags: 64 });
        const u2 = await getUser(uid);
        if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
        if (Number(u2.saldo) < bet) return interaction.reply({ content: `❌ Saldo kurang. Saldo: ${dl(u2.saldo)}`, flags: 64 });
        pendingCF.set(uid, { bet });
        const e = new EmbedBuilder().setTitle('<:DL:1497549302581563433> COINFLIP').setColor(0x9B59B6)
          .setDescription(`Bet: ${dl(bet)}\nPilih multiplier:`);
        return interaction.reply({ embeds: [e], components: [coinflipSelectRow()], flags: 64 });
      }

      // Game lain
      if (isNaN(bet) || bet <= 0) return interaction.reply({ content: '❌ Bet tidak valid.', flags: 64 });

      const errBet = validateBet(bet);
      if (errBet) return interaction.reply({ content: errBet, flags: 64 });

      const cd = checkCD(uid);
      if (cd > 0) return interaction.reply({ content: `⏳ Cooldown ${cd}s.`, flags: 64 });

      const u2 = await getUser(uid);
      if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
      if (Number(u2.saldo) < bet) return interaction.reply({ content: `❌ Saldo kurang. Saldo: ${dl(u2.saldo)}`, flags: 64 });

      // Blackjack
      if (cid === 'modal_bj') {
        const playerHand = [drawCard(), drawCard()];
        const dealerHand = [drawCard(), drawCard()];
        const { error: deductErr } = await supabase.from('users').update({ saldo: Number(u2.saldo) - bet }).eq('phone', uid);
        if (deductErr) return interaction.reply({ content: '❌ Gagal memulai game, coba lagi.', flags: 64 });
        const sess = { playerHand, dealerHand, bet, insuranceBet: 0 };
        await bjSetSession(uid, sess);

        if (dealerHand[0] === 'A') {
          const e = bjEmbed(sess);
          e.setDescription('🛡️ Dealer tunjukkan **Ace**! Mau insurance?');
          return interaction.reply({ embeds: [e], files: [ASSET.kazento()], components: [bjInsuranceRow()], flags: 64 });
        }
        if (isBlackjack(playerHand) || isBlackjack(dealerHand)) {
          dealerPlay(dealerHand);
          const { result, payout } = bjPayout(playerHand, dealerHand, bet, 'stand', 0);
          const { newSaldo, newPL, newRole } = await updateStats(uid, payout + bet, bet, payout);
          const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: 'blackjack', bet, result, player_number: handValue(playerHand), house_number: handValue(dealerHand), payout }).select().single();
          await bjDeleteSession(uid);
          return interaction.reply({ embeds: [bjEndEmbed(sess, result, payout, newSaldo, newPL, newRole, gh?.id || '-')], files: [ASSET.kazento()], components: [], flags: 64 });
        }
        const canDouble = Number(u2.saldo) - bet >= bet;
        const canSplit  = playerHand[0] === playerHand[1] && Number(u2.saldo) - bet >= bet;
        return interaction.reply({ embeds: [bjEmbed(sess)], files: [ASSET.kazento()], components: [bjActionRow(canDouble, canSplit, true)], flags: 64 });
      }

      // Reme / Leme / Dice
      let player, house, result, gameName;
      if (cid === 'modal_reme')      { player = spinWheel(); house = spinWheel(); result = calcReme(player, house, bet); gameName = '🎡 REME'; }
      else if (cid === 'modal_leme') { player = spinWheel(); house = spinWheel(); result = calcLeme(player, house, bet); gameName = '🎰 LEME'; }
      else if (cid === 'modal_dice') { player = Math.floor(Math.random() * 6) + 1; house = Math.floor(Math.random() * 6) + 1; result = calcDice(player, house, bet); gameName = '🎲 DICE'; }
      else return;

      const { outcome, payout } = result;
      const { newSaldo, newPL, newRole } = await updateStats(uid, payout, bet, payout);
      const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: cid.replace('modal_', ''), bet, result: outcome, player_number: player, house_number: house, payout }).select().single();
      try { const m = await guild.members.fetch(uid); await syncRole(guild, m, newRole); } catch { }
      const le = outcome.includes('JACKPOT') ? '🎉' : outcome === 'MENANG' ? '✅' : '❌';
      await sendLog(client, `${le} **${gameName}** | <@${uid}> | Bet:${bet} DL | ${outcome} | ${payout >= 0 ? '+' : ''}${payout} DL`);
      return interaction.reply({
        embeds: [resultEmbed(gameName, player, house, outcome, payout, newSaldo, newPL, newRole, gh?.id || '-')],
        files: [ASSET.kazento()],
        flags: 64
      });
    }

  } catch (e) {
    console.error('Handler error:', e);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Terjadi kesalahan, coba lagi.', flags: 64 });
    } catch { }
  }
});

client.login(TOKEN);
