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
const OWNER_ID     = process.env.OWNER_ID;
const CH_LOGS_GAME = '1497870119148453979';
const CAT_TICKET   = '1496760499365351495'; // Category khusus ticket deposit/withdraw

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
};


const COOLDOWNS  = new Map();

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
  const { data, error } = await supabase.from('users').select('*').eq('phone', id).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) console.error('getUser error:', error.message);
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

async function updateStats(id, saldoDelta, wagerDelta, plDelta, guildRef) {
  const u = await getUser(id);
  if (!u) return { newSaldo: 0, newPL: 0, newRole: 'Unrank' };
  const ns = Number(u.saldo) + saldoDelta;
  const nw = Number(u.total_wager) + wagerDelta;
  const np = Number(u.profit_loss) + plDelta;
  const nr = getRole(nw);
  const { error } = await supabase.from('users').update({ saldo: ns, total_wager: nw, profit_loss: np, role: nr }).eq('phone', id);
  if (error) console.error('updateStats error:', error.message);
  // Auto sync role Discord kalau guildRef disediain
  if (guildRef) {
    try {
      const member = await guildRef.members.fetch(id);
      await syncRole(guildRef, member, nr);
    } catch { }
  }
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
async function sendGameLog(client, msg) {
  try { const ch = await client.channels.fetch(CH_LOGS_GAME); if (ch) await ch.send(msg); } catch { }
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


// =================== ROULETTE ===================
// 0 = Green (slot 0), 1-18 = Red angka ganjil / Black angka genap (simplified European style)
const ROULETTE_NUMBERS = [
  { n:0,  color:'green' },
  { n:1,  color:'red'   },{ n:2,  color:'black' },{ n:3,  color:'red'   },{ n:4,  color:'black' },
  { n:5,  color:'red'   },{ n:6,  color:'black' },{ n:7,  color:'red'   },{ n:8,  color:'black' },
  { n:9,  color:'red'   },{ n:10, color:'black' },{ n:11, color:'black' },{ n:12, color:'red'   },
  { n:13, color:'black' },{ n:14, color:'red'   },{ n:15, color:'black' },{ n:16, color:'red'   },
  { n:17, color:'black' },{ n:18, color:'red'   },{ n:19, color:'red'   },{ n:20, color:'black' },
  { n:21, color:'red'   },{ n:22, color:'black' },{ n:23, color:'red'   },{ n:24, color:'black' },
  { n:25, color:'red'   },{ n:26, color:'black' },{ n:27, color:'red'   },{ n:28, color:'black' },
  { n:29, color:'black' },{ n:30, color:'red'   },{ n:31, color:'black' },{ n:32, color:'red'   },
  { n:33, color:'black' },{ n:34, color:'red'   },{ n:35, color:'black' },{ n:36, color:'red'   },
];
const ROULETTE_EMOJI = { red: '🔴', black: '⚫', green: '🟢' };

function spinRoulette() {
  return ROULETTE_NUMBERS[Math.floor(Math.random() * ROULETTE_NUMBERS.length)];
}

function calcRoulette(pick, slot, bet) {
  // pick: 'red' | 'black' | 'green'
  if (slot.color === pick) {
    const mult = slot.color === 'green' ? 36 : 2;
    return { outcome: `MENANG ${mult}x`, payout: bet * (mult - 1) };
  }
  return { outcome: 'KALAH', payout: -bet };
}

function rouletteEmbed(pick, slot, payout, newSaldo, newPL, newRole, gid) {
  const win  = payout > 0;
  const color = win ? 0x2ECC71 : 0xE74C3C;
  const plt   = newPL >= 0 ? `+${newPL}` : `${newPL}`;
  const slotEmoji = ROULETTE_EMOJI[slot.color];
  const pickEmoji = ROULETTE_EMOJI[pick];
  return new EmbedBuilder()
    .setTitle('🎡 ROULETTE')
    .setColor(color)
    .setThumbnail('attachment://Kazento.png')
    .setDescription(`Bola berhenti di... **${slotEmoji} ${slot.n}** (${slot.color.toUpperCase()})`)
    .addFields(
      { name: '🎯 Pilihan',  value: `${pickEmoji} ${pick.toUpperCase()}`, inline: true },
      { name: '🎰 Hasil',    value: `${win ? '✅' : '❌'} ${win ? 'MENANG' : 'KALAH'}`, inline: true },
      { name: '\u200B',      value: '\u200B', inline: true },
      { name: '💸 Payout',   value: `${payout >= 0 ? '+' : ''}${payout} <:DL:1497549302581563433>`, inline: true },
      { name: '💰 Saldo',    value: dl(newSaldo),  inline: true },
      { name: '📊 P/L',      value: `${plt} <:DL:1497549302581563433>`, inline: true },
      { name: '🏅 Role',     value: newRole,        inline: true }
    )
    .setFooter({ text: `ID: ${gid}` })
    .setTimestamp();
}

// =================== BACCARAT ===================
function baccaratCardValue(card) {
  if (['10','J','Q','K'].includes(card)) return 0;
  if (card === 'A') return 1;
  return parseInt(card);
}

function baccaratHandValue(hand) {
  return hand.reduce((s, c) => s + baccaratCardValue(c), 0) % 10;
}

function dealBaccarat() {
  const deck = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const draw = () => deck[Math.floor(Math.random() * deck.length)];
  const player = [draw(), draw()];
  const banker = [draw(), draw()];
  const pv = baccaratHandValue(player);
  const bv = baccaratHandValue(banker);
  // Third card rules (simplified standard baccarat)
  if (pv <= 5 && !(pv >= 8)) player.push(draw());
  if (bv <= 5 && !(bv >= 8)) banker.push(draw());
  const finalP = baccaratHandValue(player);
  const finalB = baccaratHandValue(banker);
  let outcome;
  if (finalP === finalB)     outcome = 'TIE';
  else if (finalP > finalB)  outcome = 'PLAYER';
  else                        outcome = 'BANKER';
  return { player, banker, finalP, finalB, outcome };
}

// Fetch 10 history baccarat terakhir user untuk pattern
async function getBaccaratPattern(uid) {
  const { data } = await supabase
    .from('game_history')
    .select('result')
    .eq('phone', uid)
    .eq('game', 'baccarat')
    .order('created_at', { ascending: false })
    .limit(10);
  if (!data?.length) return null;
  return data.map(d => d.result).reverse(); // oldest → newest
}

function patternBar(history) {
  if (!history?.length) return '_Belum ada history_';
  const map = { PLAYER: '🔵', BANKER: '🔴', TIE: '🟢' };
  return history.map(r => map[r] || '❓').join(' ');
}

// Baccarat session (pilih taruhan dulu, baru reveal)
async function bacGetSession(uid) {
  const { data } = await supabase.from('baccarat_sessions').select('*').eq('user_id', uid).maybeSingle();
  return data ? data.session_data : null;
}
async function bacSetSession(uid, sess) {
  await supabase.from('baccarat_sessions').upsert({ user_id: uid, session_data: sess });
}
async function bacDeleteSession(uid) {
  await supabase.from('baccarat_sessions').delete().eq('user_id', uid);
}

function bacPickEmbed(bet, pattern, picks) {
  // picks = array of 'PLAYER'|'BANKER'|'TIE' yang udah dipilih
  const pickStr = picks.length
    ? picks.map(p => p === 'PLAYER' ? '🔵 Player' : p === 'BANKER' ? '🔴 Banker' : '🟢 Tie').join(' + ')
    : '_Belum pilih_';
  return new EmbedBuilder()
    .setTitle('🎴 BACCARAT')
    .setColor(0x1A237E)
    .setThumbnail('attachment://Kazento.png')
    .setDescription('Pilih **Player**, **Banker**, atau **Tie** (boleh kombinasi kecuali Player+Banker).\nTekan **DEAL** setelah pilih.')
    .addFields(
      { name: '📊 Pattern 10 Round Terakhir', value: patternBar(pattern), inline: false },
      { name: '💰 Bet',    value: dl(bet),    inline: true },
      { name: '🎯 Pilihan', value: pickStr,    inline: true }
    );
}

function bacResultEmbed(sess, deal, totalPayout, newSaldo, newPL, newRole, gid) {
  const { player, banker, finalP, finalB, outcome } = deal;
  const outcomeEmoji = outcome === 'PLAYER' ? '🔵' : outcome === 'BANKER' ? '🔴' : '🟢';
  const win = totalPayout > 0;
  const plt = newPL >= 0 ? `+${newPL}` : `${newPL}`;
  // Animated-style reveal: kartu satu per satu dalam teks
  const pCards = player.map(c => `\`${c}\``).join(' → ');
  const bCards = banker.map(c => `\`${c}\``).join(' → ');
  return new EmbedBuilder()
    .setTitle('🎴 BACCARAT — RESULT')
    .setColor(win ? 0x2ECC71 : totalPayout === 0 ? 0xF39C12 : 0xE74C3C)
    .setThumbnail('attachment://Kazento.png')
    .addFields(
      { name: '🔵 Player', value: `${pCards}\n**= ${finalP}**`, inline: true },
      { name: '🔴 Banker', value: `${bCards}\n**= ${finalB}**`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '🏆 Pemenang', value: `${outcomeEmoji} **${outcome}**`, inline: true },
      { name: '💸 Payout',   value: `${totalPayout >= 0 ? '+' : ''}${totalPayout} <:DL:1497549302581563433>`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '💰 Saldo',   value: dl(newSaldo), inline: true },
      { name: '📊 P/L',     value: `${plt} <:DL:1497549302581563433>`, inline: true },
      { name: '🏅 Role',    value: newRole, inline: true }
    )
    .setFooter({ text: `ID: ${gid}` })
    .setTimestamp();
}

function bacPickRow(picks) {
  const hasPlayer = picks.includes('PLAYER');
  const hasBanker = picks.includes('BANKER');
  const hasTie    = picks.includes('TIE');
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('bac_pick_PLAYER')
        .setLabel(hasPlayer ? '✅ Player' : '🔵 Player')
        .setStyle(hasPlayer ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(hasBanker), // disabled kalau sudah pilih Banker
      new ButtonBuilder()
        .setCustomId('bac_pick_BANKER')
        .setLabel(hasBanker ? '✅ Banker' : '🔴 Banker')
        .setStyle(hasBanker ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(hasPlayer), // disabled kalau sudah pilih Player
      new ButtonBuilder()
        .setCustomId('bac_pick_TIE')
        .setLabel(hasTie ? '✅ Tie' : '🟢 Tie')
        .setStyle(hasTie ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('bac_deal')
        .setLabel('🃠 DEAL')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(picks.length === 0),
    )
  ];
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
    .setThumbnail('attachment://Kazento.png')
    .addFields(
      { name: '🎡 Reme',      value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🎰 Leme',      value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🎲 Dice',      value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🃏 Blackjack', value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🎡 Roulette',  value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🎴 Baccarat',  value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🗼 Tower',     value: `RTP ${fakeRTP()}%`, inline: true },
      { name: '🃠 HiLo',      value: `RTP ${fakeRTP()}%`, inline: true },
    );
}

function gameRow() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_reme').setLabel('🎡 Reme').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_leme').setLabel('🎰 Leme').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_dice').setLabel('🎲 Dice').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_bj').setLabel('🃏 Blackjack').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_roulette').setLabel('🎡 Roulette').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_baccarat').setLabel('🎴 Baccarat').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_tower').setLabel('🗼 Tower').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_hilo').setLabel('🃠 HiLo').setStyle(ButtonStyle.Primary),
  );
  return [row1, row2];
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

// =================== TICKET SYSTEM ===================
async function createTicket(interaction, type, user, guild) {
  try {
    // Cek apakah ticket sudah ada untuk user ini
    const existingChannel = guild.channels.cache.find(
      ch => ch.name === `${type}-${user.id}` && ch.parentId === CAT_TICKET
    );
    if (existingChannel) {
      return interaction.reply({
        content: `❌ Kamu udah punya ticket ${type} aktif: <#${existingChannel.id}>`,
        flags: 64
      });
    }

    // Ambil owner member untuk permission
    const ownerMember = await guild.members.fetch(OWNER_ID).catch(() => null);

    // Build permission overwrites pakai PermissionFlagsBits
    const { PermissionFlagsBits } = require('discord.js');
    const VIEW   = PermissionFlagsBits.ViewChannel;
    const SEND   = PermissionFlagsBits.SendMessages;
    const READ   = PermissionFlagsBits.ReadMessageHistory;
    const ATTACH = PermissionFlagsBits.AttachFiles;
    const MANAGE_MSG = PermissionFlagsBits.ManageMessages;
    const MANAGE_CH  = PermissionFlagsBits.ManageChannels;

    const permOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [VIEW, SEND, READ],
      },
      {
        id: user.id,
        allow: [VIEW, SEND, READ, ATTACH],
      },
    ];

    if (ownerMember) {
      permOverwrites.push({
        id: OWNER_ID,
        allow: [VIEW, SEND, READ, ATTACH, MANAGE_MSG, MANAGE_CH],
      });
    }

    // Kasih akses ke semua admin dari DB
    const { data: admins } = await supabase.from('users').select('phone').eq('is_admin', true);
    if (admins?.length) {
      for (const adm of admins) {
        if (adm.phone === OWNER_ID || adm.phone === user.id) continue;
        permOverwrites.push({
          id: adm.phone,
          allow: [VIEW, SEND, READ, ATTACH, MANAGE_MSG],
        });
      }
    }

    const emoji   = type === 'deposit' ? '💳' : '💸';
    const color   = type === 'deposit' ? 0x2ECC71 : 0xE74C3C;
    const typeStr = type === 'deposit' ? 'Deposit' : 'Withdraw';

    // Buat channel ticket
    const { ChannelType } = require('discord.js');
    const ticketCh = await guild.channels.create({
      name: `${type}-${user.id}`,
      type: ChannelType.GuildText,
      parent: CAT_TICKET,
      permissionOverwrites: permOverwrites,
      topic: `Ticket ${typeStr} | <@${user.id}> | ${new Date().toLocaleString('id-ID')}`,
    });

    // Fetch fresh user data
    const dbUser = await getUser(user.id);

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} Ticket ${typeStr}`)
      .setColor(color)
      .setThumbnail('attachment://Kazento.png')
      .setDescription(
        type === 'deposit'
          ? `Halo <@${user.id}>! 👋\nSilakan kirim **jumlah deposit** dan **bukti transfer** di sini.\nAdmin akan proses sesegera mungkin.`
          : `Halo <@${user.id}>! 👋\nSilakan kirim **jumlah withdraw** dan **nomor rekening / dompet digital** di sini.\nAdmin akan proses sesegera mungkin.`
      )
      .addFields(
        { name: '👤 User',   value: `<@${user.id}>`,                           inline: true },
        { name: '💰 Saldo',  value: dl(dbUser?.saldo ?? 0),                    inline: true },
        { name: '🏅 Role',   value: dbUser?.role ?? 'Unrank',                  inline: true },
        { name: '📋 Type',   value: typeStr,                                    inline: true },
        { name: '🕐 Dibuat', value: `<t:${Math.floor(Date.now()/1000)}:F>`,    inline: true }
      )
      .setFooter({ text: 'Tutup ticket dengan tombol di bawah setelah selesai.' })
      .setTimestamp();

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_close_${ticketCh.id}`)
        .setLabel('🔒 Tutup Ticket')
        .setStyle(ButtonStyle.Danger)
    );

    await ticketCh.send({
      content: `<@${user.id}>${ownerMember ? ` <@${OWNER_ID}>` : ''}`,
      embeds: [embed],
      files: [ASSET.kazento()],
      components: [closeRow],
    });

    await sendLog(interaction.client, `${emoji} **TICKET ${typeStr.toUpperCase()}** | <@${user.id}> | <#${ticketCh.id}>`);

    return interaction.reply({
      content: `✅ Ticket **${typeStr}** berhasil dibuat! → <#${ticketCh.id}>`,
      flags: 64,
    });
  } catch (err) {
    console.error('createTicket error:', err);
    // Kasih tau error spesifiknya ke admin/user
    const errMsg = err?.message || 'Unknown error';
    return interaction.reply({
      content: `❌ Gagal buat ticket.\n\`\`\`${errMsg}\`\`\`\nPastikan bot punya permission **Manage Channels** di category ticket.`,
      flags: 64
    });
  }
}

// =================== TOWER GAME ===================
const TOWER_DIFFICULTIES = {
  easy:    { grids: 4, bombs: 1, maxLayer: 12, label: '🟢 Easy',    color: 0x2ECC71 },
  medium:  { grids: 3, bombs: 1, maxLayer: 11, label: '🟡 Medium',  color: 0xF39C12 },
  hard:    { grids: 2, bombs: 1, maxLayer: 9,  label: '🔴 Hard',    color: 0xE74C3C },
  extreme: { grids: 3, bombs: 2, maxLayer: 9,  label: '💀 Extreme', color: 0x8E44AD },
};

// Multiplier per layer berdasarkan probabilitas bertahan
function towerMultiplier(difficulty, layer) {
  const d = TOWER_DIFFICULTIES[difficulty];
  // Prob selamat per layer = (grids - bombs) / grids
  const probPerLayer = (d.grids - d.bombs) / d.grids;
  // Multiplier = 1 / (probPerLayer ^ layer) * house_edge(0.95)
  const raw = Math.pow(1 / probPerLayer, layer) * 0.95;
  return Math.round(raw * 100) / 100;
}

function towerBombLayer(grids, bombs) {
  // Posisi bom (0-indexed), random
  const positions = [];
  while (positions.length < bombs) {
    const p = Math.floor(Math.random() * grids);
    if (!positions.includes(p)) positions.push(p);
  }
  return positions;
}

async function towerGetSession(uid) {
  const { data } = await supabase.from('tower_sessions').select('*').eq('user_id', uid).maybeSingle();
  return data ? data.session_data : null;
}
async function towerSetSession(uid, sess) {
  await supabase.from('tower_sessions').upsert({ user_id: uid, session_data: sess, updated_at: new Date().toISOString() });
}
async function towerDeleteSession(uid) {
  await supabase.from('tower_sessions').delete().eq('user_id', uid);
}

function towerEmbed(sess, status = 'playing') {
  const d     = TOWER_DIFFICULTIES[sess.difficulty];
  const layer = sess.currentLayer; // layer yg sedang dimainkan (1-based)
  const mult  = towerMultiplier(sess.difficulty, layer - 1); // multiplier kalau cashout sekarang
  const nextMult = towerMultiplier(sess.difficulty, layer);
  const profit = Math.floor(sess.bet * mult) - sess.bet;
  const totalLayers = d.maxLayer;

  // Build visual tower (dari atas ke bawah, layer teratas = belum dimainkan)
  let towerVis = '';
  for (let i = totalLayers; i >= 1; i--) {
    if (i > layer) {
      towerVis += `\`L${String(i).padStart(2,'0')}\` ${'⬜'.repeat(d.grids)}\n`;
    } else if (i === layer) {
      towerVis += `\`L${String(i).padStart(2,'0')}\` ${'🟦'.repeat(d.grids)} ← **SEKARANG**\n`;
    } else {
      // Layer yang sudah dilalui — tunjukkan pilihan user
      const chosen = sess.history[i - 1]; // index 0 = layer 1
      let row = '';
      for (let g = 0; g < d.grids; g++) {
        row += chosen === g ? '✅' : '⬜';
      }
      towerVis += `\`L${String(i).padStart(2,'0')}\` ${row}\n`;
    }
  }

  const colorMap = { playing: d.color, win: 0x2ECC71, lose: 0xE74C3C, cashout: 0xF39C12 };

  return new EmbedBuilder()
    .setTitle(`🗼 TOWER — ${d.label}`)
    .setColor(colorMap[status] || d.color)
    .setThumbnail('attachment://Kazento.png')
    .setDescription(towerVis)
    .addFields(
      { name: '💰 Bet',         value: dl(sess.bet),           inline: true },
      { name: '📍 Layer',       value: `${layer} / ${totalLayers}`, inline: true },
      { name: '✖️ Multiplier',  value: `${mult}x`,             inline: true },
      { name: '💸 Profit skrg', value: `+${profit} <:DL:1497549302581563433>`, inline: true },
      { name: '⬆️ Next mult',   value: `${nextMult}x`,         inline: true },
      { name: '\u200B',         value: '\u200B',               inline: true },
    )
    .setFooter({ text: status === 'playing' ? 'Pilih grid atau Cashout!' : status === 'cashout' ? '💰 Cashout!' : status === 'win' ? '🏆 TOP REACHED!' : '💥 Kena Bom!' });
}

function towerPickRow(grids, disabled = false) {
  const labels = ['1️⃣','2️⃣','3️⃣','4️⃣'];
  const row = new ActionRowBuilder();
  for (let i = 0; i < grids; i++) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`tower_pick_${i}`)
        .setLabel(`Grid ${i + 1}`)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(labels[i])
        .setDisabled(disabled)
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('tower_cashout')
      .setLabel('💰 Cashout')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled)
  );
  return row;
}

function towerDiffRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tower_diff_easy').setLabel('🟢 Easy').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tower_diff_medium').setLabel('🟡 Medium').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tower_diff_hard').setLabel('🔴 Hard').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tower_diff_extreme').setLabel('💀 Extreme').setStyle(ButtonStyle.Danger),
  );
}

// =================== HILO GAME ===================
const HILO_DECK = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const HILO_VALUES = { A:1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, J:11, Q:12, K:13 };

function hiloMultiplier(currentCard, guess) {
  const val = HILO_VALUES[currentCard];
  let prob;
  if (guess === 'hi') {
    // Kartu lebih tinggi dari val: cards dari val+1 sampai K = (13 - val) / 13
    prob = Math.max(1, 13 - val) / 13;
  } else {
    // Kartu lebih rendah dari val: cards dari A sampai val-1 = (val - 1) / 13
    prob = Math.max(1, val - 1) / 13;
  }
  return Math.round((1 / prob) * 0.95 * 100) / 100;
}

function hiloDraw() {
  return HILO_DECK[Math.floor(Math.random() * HILO_DECK.length)];
}

function hiloCardEmoji(card) {
  const suits = ['♠️','♥️','♦️','♣️'];
  return `**${card}** ${suits[Math.floor(Math.random() * suits.length)]}`;
}

async function hiloGetSession(uid) {
  const { data } = await supabase.from('hilo_sessions').select('*').eq('user_id', uid).maybeSingle();
  return data ? data.session_data : null;
}
async function hiloSetSession(uid, sess) {
  await supabase.from('hilo_sessions').upsert({ user_id: uid, session_data: sess, updated_at: new Date().toISOString() });
}
async function hiloDeleteSession(uid) {
  await supabase.from('hilo_sessions').delete().eq('user_id', uid);
}

function hiloEmbed(sess, status = 'playing', newCard = null, correct = null) {
  const currentCard = newCard || sess.currentCard;
  const mult = Math.round(sess.currentMult * 100) / 100;
  const profit = Math.floor(sess.bet * mult) - sess.bet;
  const hiMult  = hiloMultiplier(currentCard, 'hi');
  const loMult  = hiloMultiplier(currentCard, 'lo');

  const colorMap = { playing: 0x3498DB, win: 0x2ECC71, lose: 0xE74C3C, cashout: 0xF39C12 };

  let desc = `Kartu sekarang: ${hiloCardEmoji(currentCard)}\n`;
  if (status === 'playing') {
    desc += `\nApakah kartu berikutnya **lebih tinggi** atau **lebih rendah**?\n`;
    desc += `_(A = terendah, K = tertinggi)_`;
  } else if (status === 'lose') {
    desc += `\nKartu berikutnya: ${hiloCardEmoji(newCard)}\n❌ **Salah tebak!**`;
  } else if (status === 'cashout') {
    desc += `\n💰 **Cashout!**`;
  }

  const prevHistory = sess.history.length
    ? sess.history.map(h => `${hiloCardEmoji(h.card)} ${h.guess === 'hi' ? '⬆️' : '⬇️'} ${h.correct ? '✅' : '❌'}`).join('\n')
    : '_Belum ada_';

  return new EmbedBuilder()
    .setTitle('🃠 HILO')
    .setColor(colorMap[status])
    .setThumbnail('attachment://Kazento.png')
    .setDescription(desc)
    .addFields(
      { name: '💰 Bet',         value: dl(sess.bet),       inline: true },
      { name: '✖️ Multiplier',  value: `${mult}x`,         inline: true },
      { name: '💸 Profit skrg', value: `+${profit} <:DL:1497549302581563433>`, inline: true },
      { name: '⬆️ Hi Mult',     value: `${hiMult}x`,       inline: true },
      { name: '⬇️ Lo Mult',     value: `${loMult}x`,       inline: true },
      { name: '\u200B',         value: '\u200B',           inline: true },
      { name: '📜 History',     value: prevHistory,        inline: false },
    )
    .setFooter({ text: status === 'playing' ? 'Hi atau Lo?' : status === 'cashout' ? '💰 Cashout!' : '❌ Game Over!' });
}

function hiloRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hilo_hi').setLabel('⬆️ Higher').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('hilo_lo').setLabel('⬇️ Lower').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('hilo_cashout').setLabel('💰 Cashout').setStyle(ButtonStyle.Success).setDisabled(disabled),
  );
}

// =================== COMMANDS ===================
const commands = [
  new SlashCommandBuilder().setName('menu').setDescription('Lihat profil'),
  new SlashCommandBuilder().setName('game').setDescription('Pilih game'),
  new SlashCommandBuilder().setName('deposit').setDescription('Buat ticket deposit'),
  new SlashCommandBuilder().setName('withdraw').setDescription('Buat ticket withdraw'),
  new SlashCommandBuilder().setName('daily').setDescription('Claim daily bonus'),
  new SlashCommandBuilder().setName('history').setDescription('History 5 game terakhir'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top 5 player'),
  new SlashCommandBuilder().setName('verify').setDescription('Verify hasil game').addStringOption(o => o.setName('id').setDescription('Game ID').setRequired(true)),
  new SlashCommandBuilder().setName('redeem').setDescription('Redeem promo code').addStringOption(o => o.setName('kode').setDescription('Kode').setRequired(true)),
  new SlashCommandBuilder().setName('tower').setDescription('Main Tower'),
  new SlashCommandBuilder().setName('hilo').setDescription('Main HiLo (A rendah, K tinggi)'),
  new SlashCommandBuilder().setName('addbal').setDescription('[ADMIN] Tambah saldo').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addNumberOption(o => o.setName('jumlah').setDescription('DL').setRequired(true)),
  new SlashCommandBuilder().setName('removebal').setDescription('[ADMIN] Kurangi saldo').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addNumberOption(o => o.setName('jumlah').setDescription('DL').setRequired(true)),
  new SlashCommandBuilder().setName('setbal').setDescription('[ADMIN] Set saldo').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addNumberOption(o => o.setName('jumlah').setDescription('DL').setRequired(true)),
  new SlashCommandBuilder().setName('resetbal').setDescription('[ADMIN] Reset saldo').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('ceksaldo').setDescription('Cek saldo kamu atau user lain').addUserOption(o => o.setName('user').setDescription('User (opsional, admin only)').setRequired(false)),
  new SlashCommandBuilder().setName('setadmin').setDescription('[OWNER] Set admin').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('createpromo').setDescription('[ADMIN] Buat promo').addStringOption(o => o.setName('kode').setDescription('Kode').setRequired(true)).addNumberOption(o => o.setName('dl').setDescription('DL').setRequired(true)).addIntegerOption(o => o.setName('kuota').setDescription('Kuota').setRequired(true)).addStringOption(o => o.setName('role').setDescription('Min role').setRequired(true)),
  new SlashCommandBuilder().setName('setrole').setDescription('[ADMIN] Set role user di DB').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('role').setDescription('Role').setRequired(true).addChoices(
    { name: 'Unrank', value: 'Unrank' },
    { name: 'Bronze', value: 'Bronze' },
    { name: 'Silver', value: 'Silver' },
    { name: 'Gold', value: 'Gold' },
    { name: 'Diamond', value: 'Diamond' },
    { name: 'Emerald', value: 'Emerald' },
    { name: 'Ruby', value: 'Ruby' },
    { name: 'Rich', value: 'Rich' },
    { name: 'Sultan Arab', value: 'Sultan Arab' }
  )),
];

// =================== CLIENT ===================
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

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

    if (!isOwner && OWNER_ID && !user.is_owner) {
      // Jika user ini OWNER_ID tapi DB belum di-set, auto-set is_owner
      if (uid === OWNER_ID) {
        await supabase.from('users').update({ is_owner: true, is_admin: true }).eq('phone', uid);
      }
    }

    // =================== SLASH COMMANDS ===================
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (['menu','game','deposit','withdraw','daily','history','leaderboard','ceksaldo'].includes(cmd) && chId !== CH_PLAY && !isAdmin)
        return interaction.reply({ content: `❌ Command ini hanya di <#${CH_PLAY}>`, flags: 64 });

      if (['addbal','removebal','setbal','resetbal','setadmin','createpromo','setrole','closeticket'].includes(cmd) && chId !== CH_ADMIN && !isAdmin)
        return interaction.reply({ content: `❌ Command ini hanya di <#${CH_ADMIN}>`, flags: 64 });

      if (cmd === 'verify' && chId !== CH_FAIR)
        return interaction.reply({ content: `❌ Command ini hanya di <#${CH_FAIR}>`, flags: 64 });

      if (cmd === 'menu') {
        const freshUser = await getUser(uid);
        if (!freshUser) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
        // Auto assign role Discord sesuai DB
        try {
          const member = await guild.members.fetch(uid);
          await syncRole(guild, member, freshUser.role || 'Unrank');
        } catch { }
        return interaction.reply({ embeds: [profileEmbed(freshUser, interaction.user)], files: [ASSET.kazento()], components: [menuRow()], flags: 64 });
      }
      if (cmd === 'tower') {
        const existing = await towerGetSession(uid);
        if (existing) {
          const d = TOWER_DIFFICULTIES[existing.difficulty];
          return interaction.reply({
            content: `⚠️ Kamu masih punya sesi Tower aktif! (Layer ${existing.currentLayer}/${d.maxLayer})`,
            embeds: [towerEmbed(existing)],
            files: [ASSET.kazento()],
            components: [towerPickRow(d.grids)],
            flags: 64
          });
        }
        const diffEmbed = new EmbedBuilder()
          .setTitle('🗼 TOWER — Pilih Difficulty')
          .setColor(0x9B59B6)
          .setThumbnail('attachment://Kazento.png')
          .addFields(
            { name: '🟢 Easy',    value: '4 grid, 1 bom, 12 layer',  inline: true },
            { name: '🟡 Medium',  value: '3 grid, 1 bom, 11 layer',  inline: true },
            { name: '🔴 Hard',    value: '2 grid, 1 bom, 9 layer',   inline: true },
            { name: '💀 Extreme', value: '3 grid, 2 bom, 9 layer',   inline: true },
          );
        return interaction.reply({ embeds: [diffEmbed], files: [ASSET.kazento()], components: [towerDiffRow()], flags: 64 });
      }

      if (cmd === 'hilo') {
        const existing = await hiloGetSession(uid);
        if (existing) {
          return interaction.reply({
            content: `⚠️ Kamu masih punya sesi HiLo aktif! (Mult: ${existing.currentMult}x)`,
            embeds: [hiloEmbed(existing)],
            files: [ASSET.kazento()],
            components: [hiloRow()],
            flags: 64
          });
        }
        return interaction.showModal(betModal('hilo', '🃠 HiLo'));
      }

      if (cmd === 'game')     return interaction.reply({ embeds: [gameEmbed()], components: gameRow(), flags: 64 });
      if (cmd === 'deposit')  return interaction.reply({ content: '💳 Untuk deposit, hubungi admin atau Owner.', flags: 64 });
      if (cmd === 'withdraw') return interaction.reply({ content: '💸 Untuk withdraw, hubungi admin atau Owner.', flags: 64 });

      if (cmd === 'daily') {
        const now = new Date();
        const freshUser = await getUser(uid);
        const lcFresh = freshUser?.last_daily ? new Date(freshUser.last_daily) : null;
        if (lcFresh && (now - lcFresh) < 86400000) {
          const r = Math.ceil((86400000 - (now - lcFresh)) / 3600000);
          return interaction.reply({ content: `❌ Balik lagi dalam **${r} jam**.`, flags: 64 });
        }
        // Bronze+ wajib deposit dalam 7 hari terakhir (owner skip)
        if (!isOwner && freshUser.role !== 'Unrank') {
          const lastDep = freshUser?.last_deposit ? new Date(freshUser.last_deposit) : null;
          const sevenDays = 7 * 24 * 60 * 60 * 1000;
          if (!lastDep || (now - lastDep) > sevenDays) {
            return interaction.reply({
              content: `❌ Kamu harus deposit minimal **1x dalam 7 hari** untuk claim daily.\nDeposit terakhir: ${lastDep ? `<t:${Math.floor(lastDep.getTime()/1000)}:R>` : '_belum pernah_'}`,
              flags: 64
            });
          }
        }
        const bonus = getDailyBonus(freshUser.role);
        const ns = Number(freshUser.saldo) + bonus;
        await supabase.from('users').update({ saldo: ns, last_daily: now.toISOString() }).eq('phone', uid);
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
      if (cmd === 'closeticket') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const targetCh = interaction.options.getChannel('channel');
        if (!targetCh) return interaction.reply({ content: '❌ Channel tidak valid.', flags: 64 });
        await interaction.reply({ content: `🔒 Menutup ticket <#${targetCh.id}>...`, flags: 64 });
        await sendLog(client, `🔒 **TICKET FORCE CLOSED** | <#${targetCh.id}> | by <@${uid}>`);
        setTimeout(async () => {
          try { await targetCh.delete(`Force closed by admin ${uid}`); } catch { }
        }, 2000);
        return;
      }

      if (cmd === 'addbal') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const targetUser = interaction.options.getUser('user');
        const tid = targetUser.id;
        const amt = interaction.options.getNumber('jumlah');
        if (!amt || amt <= 0) return interaction.reply({ content: '❌ Jumlah harus lebih dari 0.', flags: 64 });

        // Pastikan user exist di DB dulu
        let t = await getUser(tid);
        if (!t) t = await createUser(tid, targetUser.username);
        if (!t) return interaction.reply({ content: '❌ Gagal load/create user.', flags: 64 });

        const ns = Number(t.saldo) + amt;
        const nw = Number(t.total_wager || 0);
        const nr = getRole(nw);

        // Update saldo + last_deposit (catat deposit 7 hari)
        const { error: updateErr } = await supabase
          .from('users')
          .update({ saldo: ns, role: nr, last_deposit: new Date().toISOString() })
          .eq('phone', tid);

        if (updateErr) {
          if (updateErr.message.includes('last_deposit')) {
            // Kolom belum ada, fallback tanpa last_deposit
            const { error: fallbackErr } = await supabase.from('users').update({ saldo: ns, role: nr }).eq('phone', tid);
            if (fallbackErr) {
              console.error('addbal fallback error:', fallbackErr.message);
              return interaction.reply({ content: `❌ Gagal update saldo: ${fallbackErr.message}`, flags: 64 });
            }
            console.warn('⚠️ Kolom last_deposit belum ada. Jalankan: ALTER TABLE users ADD COLUMN last_deposit TIMESTAMPTZ;');
          } else {
            console.error('addbal update error:', updateErr.message);
            return interaction.reply({ content: `❌ Gagal update saldo: ${updateErr.message}`, flags: 64 });
          }
        }

        // Sync role Discord
        try {
          const m = await guild.members.fetch(tid);
          await syncRole(guild, m, nr);
        } catch { }

        await sendLog(client, `💰 **ADDBAL** | <@${uid}>→<@${tid}> +${amt} DL | Saldo baru: ${ns} DL`);
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('✅ Addbal Berhasil')
            .setColor(0x2ECC71)
            .addFields(
              { name: '👤 User',       value: `<@${tid}>`,  inline: true },
              { name: '➕ Ditambah',   value: dl(amt),       inline: true },
              { name: '💰 Saldo Baru', value: dl(ns),        inline: true },
              { name: '🏅 Role',       value: nr,            inline: true },
            )
            .setTimestamp()
          ],
          flags: 64
        });
      }

      if (cmd === 'removebal') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const targetUser = interaction.options.getUser('user');
        const tid = targetUser.id;
        const amt = interaction.options.getNumber('jumlah');
        if (!amt || amt <= 0) return interaction.reply({ content: '❌ Jumlah harus lebih dari 0.', flags: 64 });

        let t = await getUser(tid);
        if (!t) return interaction.reply({ content: '❌ User tidak ada di DB.', flags: 64 });

        const ns = Math.max(0, Number(t.saldo) - amt); // ga bisa minus
        const nw = Number(t.total_wager || 0);
        const nr = getRole(nw);

        const { error: updateErr } = await supabase
          .from('users')
          .update({ saldo: ns, role: nr })
          .eq('phone', tid);

        if (updateErr) {
          console.error('removebal update error:', updateErr.message);
          return interaction.reply({ content: `❌ Gagal update saldo: ${updateErr.message}`, flags: 64 });
        }

        try { const m = await guild.members.fetch(tid); await syncRole(guild, m, nr); } catch { }
        await sendLog(client, `🔻 **REMOVEBAL** | <@${uid}>→<@${tid}> -${amt} DL | Saldo baru: ${ns} DL`);
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('✅ Removebal Berhasil')
            .setColor(0xE74C3C)
            .addFields(
              { name: '👤 User',       value: `<@${tid}>`, inline: true },
              { name: '➖ Dikurangi',  value: dl(amt),      inline: true },
              { name: '💰 Saldo Baru', value: dl(ns),       inline: true },
              { name: '🏅 Role',       value: nr,           inline: true },
            )
            .setTimestamp()
          ],
          flags: 64
        });
      }

      if (cmd === 'setbal') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const tid = interaction.options.getUser('user').id;
        const amt = interaction.options.getNumber('jumlah');
        await supabase.from('users').update({ saldo: amt }).eq('phone', tid);
        await sendLog(client, `⚙️ **SETBAL** | <@${uid}>→<@${tid}> ${amt} DL`);
        return interaction.reply({ content: `✅ Saldo <@${tid}> = ${dl(amt)}`, flags: 64 });
      }

      if (cmd === 'resetbal') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const tid = interaction.options.getUser('user').id;
        await supabase.from('users').update({ saldo: 0 }).eq('phone', tid);
        await sendLog(client, `🔄 **RESETBAL** | <@${uid}>→<@${tid}>`);
        return interaction.reply({ content: `✅ Saldo <@${tid}> reset ke 0.`, flags: 64 });
      }

      if (cmd === 'ceksaldo') {
        const targetOption = interaction.options.getUser('user');
        // User biasa cuma bisa cek diri sendiri
        if (targetOption && !isAdmin) return interaction.reply({ content: '❌ Kamu hanya bisa cek saldo sendiri.', flags: 64 });
        const tid = targetOption ? targetOption.id : uid;
        const t   = await getUser(tid);
        if (!t) return interaction.reply({ content: '❌ User tidak ada.', flags: 64 });
        const pl  = Number(t.profit_loss) >= 0 ? `+${t.profit_loss}` : `${t.profit_loss}`;
        const isSelf = tid === uid;
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle(`${isSelf ? '💰 Saldo Kamu' : '👤 ' + (t.name || tid)}`)
            .setColor(0x9B59B6)
            .setThumbnail('attachment://Kazento.png')
            .addFields(
              { name: '💰 Saldo',  value: dl(t.saldo),        inline: true },
              { name: '🏅 Role',   value: t.role || 'Unrank', inline: true },
              { name: '🎯 Wager',  value: dl(t.total_wager),  inline: true },
              { name: '📊 P/L',    value: `${pl} <:DL:1497549302581563433>`, inline: true }
            )
            .setTimestamp()
          ],
          files: [ASSET.kazento()],
          flags: 64
        });
      }

      if (cmd === 'setadmin') {
        if (!isOwner) return interaction.reply({ content: '❌ Bukan owner.', flags: 64 });
        const tid = interaction.options.getUser('user').id;
        await getOrCreate(tid, tid);
        await supabase.from('users').update({ is_admin: true }).eq('phone', tid);
        return interaction.reply({ content: `✅ <@${tid}> sekarang admin.`, flags: 64 });
      }

      if (cmd === 'setrole') {
        if (!isAdmin) return interaction.reply({ content: '❌ Bukan admin.', flags: 64 });
        const tid     = interaction.options.getUser('user').id;
        const newRole = interaction.options.getString('role');
        const validRoles = ['Unrank','Bronze','Silver','Gold','Diamond','Emerald','Ruby','Rich','Sultan Arab'];
        if (!validRoles.includes(newRole)) return interaction.reply({ content: '❌ Role tidak valid.', flags: 64 });
        const t = await getUser(tid);
        if (!t) return interaction.reply({ content: '❌ User tidak ada di DB.', flags: 64 });
        await supabase.from('users').update({ role: newRole }).eq('phone', tid);
        await sendLog(client, `🎭 **SETROLE** | <@${uid}>→<@${tid}> role: ${newRole}`);
        return interaction.reply({ content: `✅ Role <@${tid}> → **${newRole}**`, flags: 64 });
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

      if (cid === 'btn_game')     return interaction.update({ embeds: [gameEmbed()], components: gameRow() });
      if (cid === 'btn_deposit')  return interaction.reply({ content: '💳 Untuk deposit, hubungi admin atau Owner.', flags: 64 });
      if (cid === 'btn_withdraw') return interaction.reply({ content: '💸 Untuk withdraw, hubungi admin atau Owner.', flags: 64 });

      if (cid === 'btn_daily') {
        const now = new Date();
        const freshUser = await getUser(uid);
        const lc = freshUser?.last_daily ? new Date(freshUser.last_daily) : null;
        if (lc && (now - lc) < 86400000) {
          const r = Math.ceil((86400000 - (now - lc)) / 3600000);
          return interaction.reply({ content: `❌ Balik lagi dalam **${r} jam**.`, flags: 64 });
        }
        // Bronze+ wajib deposit dalam 7 hari terakhir (owner skip)
        if (!isOwner && freshUser.role !== 'Unrank') {
          const lastDep = freshUser?.last_deposit ? new Date(freshUser.last_deposit) : null;
          const sevenDays = 7 * 24 * 60 * 60 * 1000;
          if (!lastDep || (now - lastDep) > sevenDays) {
            return interaction.reply({
              content: `❌ Kamu harus deposit minimal **1x dalam 7 hari** untuk claim daily.\nDeposit terakhir: ${lastDep ? `<t:${Math.floor(lastDep.getTime()/1000)}:R>` : '_belum pernah_'}`,
              flags: 64
            });
          }
        }
        const bonus = getDailyBonus(freshUser.role);
        const ns    = Number(freshUser.saldo) + bonus;
        await supabase.from('users').update({ saldo: ns, last_daily: now.toISOString() }).eq('phone', uid);
        return interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🎁 Daily!').setColor(0x2ECC71).setThumbnail('attachment://Kazento.png').setDescription(`+**${bonus}** <:DL:1497549302581563433>\nSaldo: ${dl(ns)}`)],
          files: [ASSET.kazento()], flags: 64
        });
      }

      if (cid === 'btn_tower') {
        const existing = await towerGetSession(uid);
        if (existing) {
          const d = TOWER_DIFFICULTIES[existing.difficulty];
          return interaction.reply({
            content: `⚠️ Kamu masih punya sesi Tower aktif! (Layer ${existing.currentLayer}/${d.maxLayer})`,
            embeds: [towerEmbed(existing)],
            files: [ASSET.kazento()],
            components: [towerPickRow(d.grids)],
            flags: 64
          });
        }
        const diffEmbed = new EmbedBuilder()
          .setTitle('🗼 TOWER — Pilih Difficulty')
          .setColor(0x9B59B6)
          .setThumbnail('attachment://Kazento.png')
          .addFields(
            { name: '🟢 Easy',    value: '4 grid, 1 bom, 12 layer',  inline: true },
            { name: '🟡 Medium',  value: '3 grid, 1 bom, 11 layer',  inline: true },
            { name: '🔴 Hard',    value: '2 grid, 1 bom, 9 layer',   inline: true },
            { name: '💀 Extreme', value: '3 grid, 2 bom, 9 layer',   inline: true },
          );
        return interaction.reply({ embeds: [diffEmbed], files: [ASSET.kazento()], components: [towerDiffRow()], flags: 64 });
      }

      if (cid === 'btn_hilo') return interaction.showModal(betModal('hilo', '🃠 HiLo'));

      // =================== TOWER DIFFICULTY PICK ===================
      if (cid.startsWith('tower_diff_')) {
        const diff = cid.replace('tower_diff_', '');
        if (!TOWER_DIFFICULTIES[diff]) return interaction.reply({ content: '❌ Difficulty tidak valid.', flags: 64 });
        // Tampilkan modal bet setelah pilih difficulty — simpan difficulty di customId via modal
        const modal = new ModalBuilder()
          .setCustomId(`modal_tower_${diff}`)
          .setTitle(`🗼 Tower ${TOWER_DIFFICULTIES[diff].label} — Bet`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('bet').setLabel('Jumlah Bet (DL)').setStyle(TextInputStyle.Short).setPlaceholder('Min 10, Max 2000').setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      // =================== TOWER GRID PICK ===================
      if (cid.startsWith('tower_pick_')) {
        const gridPick = parseInt(cid.replace('tower_pick_', ''));
        const sess = await towerGetSession(uid);
        if (!sess) return interaction.reply({ content: '❌ Sesi Tower tidak ditemukan. Mulai game baru.', flags: 64 });

        const d = TOWER_DIFFICULTIES[sess.difficulty];
        // Generate bom untuk layer ini
        const bombs = towerBombLayer(d.grids, d.bombs);
        const hit   = bombs.includes(gridPick);

        if (hit) {
          // GAME OVER
          await towerDeleteSession(uid);
          const { newSaldo, newPL, newRole } = await updateStats(uid, -sess.bet, sess.bet, -sess.bet, guild);
          await supabase.from('game_history').insert({
            phone: uid, game: 'tower', bet: sess.bet,
            result: 'LOSE', player_number: sess.currentLayer, house_number: 0, payout: -sess.bet
          });
          await sendGameLog(client, `💥 **TOWER** | <@${uid}> | ${d.label} | Layer ${sess.currentLayer} | KENA BOM | -${sess.bet} DL`);

          // Reveal bom
          let revealRow = new ActionRowBuilder();
          for (let i = 0; i < d.grids; i++) {
            revealRow.addComponents(
              new ButtonBuilder()
                .setCustomId(`tower_dead_${i}`)
                .setLabel(bombs.includes(i) ? '💣' : i === gridPick ? '💥' : `Grid ${i+1}`)
                .setStyle(bombs.includes(i) ? ButtonStyle.Danger : ButtonStyle.Secondary)
                .setDisabled(true)
            );
          }

          // Update embed dengan status lose
          sess.history[sess.currentLayer - 1] = gridPick;
          return interaction.update({
            embeds: [towerEmbed(sess, 'lose')],
            files: [ASSET.kazento()],
            components: [revealRow]
          });
        }

        // AMAN — naik layer
        sess.history[sess.currentLayer - 1] = gridPick;
        sess.currentLayer++;

        // Cek apakah sudah sampai puncak
        if (sess.currentLayer > d.maxLayer) {
          // WIN — sampai puncak
          const mult   = towerMultiplier(sess.difficulty, d.maxLayer);
          const payout = Math.floor(sess.bet * mult);
          const profit = payout - sess.bet;
          await towerDeleteSession(uid);
          const { newSaldo, newPL, newRole } = await updateStats(uid, profit, sess.bet, profit, guild);
          const { data: gh } = await supabase.from('game_history').insert({
            phone: uid, game: 'tower', bet: sess.bet,
            result: 'WIN', player_number: d.maxLayer, house_number: 0, payout: profit
          }).select().single();
          await sendGameLog(client, `🏆 **TOWER** | <@${uid}> | ${d.label} | TOP! | +${profit} DL`);
          return interaction.update({
            embeds: [towerEmbed(sess, 'win')],
            files: [ASSET.kazento()],
            components: []
          });
        }

        // Lanjut ke layer berikutnya
        await towerSetSession(uid, sess);
        return interaction.update({
          embeds: [towerEmbed(sess)],
          files: [ASSET.kazento()],
          components: [towerPickRow(d.grids)]
        });
      }

      // =================== TOWER CASHOUT ===================
      if (cid === 'tower_cashout') {
        const sess = await towerGetSession(uid);
        if (!sess) return interaction.reply({ content: '❌ Sesi Tower tidak ditemukan.', flags: 64 });
        if (sess.currentLayer <= 1) return interaction.reply({ content: '❌ Minimal selesaikan 1 layer dulu sebelum cashout!', flags: 64 });

        const layerDone = sess.currentLayer - 1;
        const mult   = towerMultiplier(sess.difficulty, layerDone);
        const payout = Math.floor(sess.bet * mult);
        const profit = payout - sess.bet;
        await towerDeleteSession(uid);
        const { newSaldo, newPL, newRole } = await updateStats(uid, profit, sess.bet, profit, guild);
        const { data: gh } = await supabase.from('game_history').insert({
          phone: uid, game: 'tower', bet: sess.bet,
          result: 'CASHOUT', player_number: layerDone, house_number: 0, payout: profit
        }).select().single();
        await sendGameLog(client, `💰 **TOWER CASHOUT** | <@${uid}> | ${TOWER_DIFFICULTIES[sess.difficulty].label} | Layer ${layerDone} | +${profit} DL`);
        return interaction.update({
          embeds: [towerEmbed(sess, 'cashout')],
          files: [ASSET.kazento()],
          components: []
        });
      }

      // =================== HILO BUTTONS ===================
      if (['hilo_hi','hilo_lo','hilo_cashout'].includes(cid)) {
        const sess = await hiloGetSession(uid);
        if (!sess) return interaction.reply({ content: '❌ Sesi HiLo tidak ditemukan. Mulai game baru.', flags: 64 });

        if (cid === 'hilo_cashout') {
          const payout = Math.floor(sess.bet * sess.currentMult);
          const profit = payout - sess.bet;
          await hiloDeleteSession(uid);
          const { newSaldo, newPL, newRole } = await updateStats(uid, profit, sess.bet, profit, guild);
          await supabase.from('game_history').insert({
            phone: uid, game: 'hilo', bet: sess.bet,
            result: 'CASHOUT', player_number: Math.round(sess.currentMult * 100), house_number: 0, payout: profit
          });
          await sendGameLog(client, `💰 **HILO CASHOUT** | <@${uid}> | ${sess.currentMult}x | +${profit} DL`);
          return interaction.update({
            embeds: [hiloEmbed(sess, 'cashout')],
            files: [ASSET.kazento()],
            components: [hiloRow(true)]
          });
        }

        const guess    = cid === 'hilo_hi' ? 'hi' : 'lo';
        const newCard  = hiloDraw();
        const newVal   = HILO_VALUES[newCard];
        const curVal   = HILO_VALUES[sess.currentCard];
        const correct  = guess === 'hi' ? newVal > curVal : newVal < curVal;

        if (!correct) {
          // LOSE
          await hiloDeleteSession(uid);
          const { newSaldo, newPL, newRole } = await updateStats(uid, -sess.bet, sess.bet, -sess.bet, guild);
          await supabase.from('game_history').insert({
            phone: uid, game: 'hilo', bet: sess.bet,
            result: 'LOSE', player_number: HILO_VALUES[sess.currentCard], house_number: HILO_VALUES[newCard], payout: -sess.bet
          });
          await sendGameLog(client, `❌ **HILO** | <@${uid}> | ${sess.currentCard}→${newCard} | guess:${guess} | -${sess.bet} DL`);
          // Tambah ke history sebelum update embed
          sess.history.push({ card: sess.currentCard, guess, correct: false });
          return interaction.update({
            embeds: [hiloEmbed(sess, 'lose', newCard, false)],
            files: [ASSET.kazento()],
            components: [hiloRow(true)]
          });
        }

        // CORRECT — update multiplier
        const addMult     = hiloMultiplier(sess.currentCard, guess);
        sess.currentMult  = Math.round((sess.currentMult * addMult) * 100) / 100;
        sess.history.push({ card: sess.currentCard, guess, correct: true });
        sess.currentCard  = newCard;
        await hiloSetSession(uid, sess);
        await sendGameLog(client, `✅ **HILO** | <@${uid}> | ${sess.currentCard}→${newCard} | guess:${guess} | mult:${sess.currentMult}x`);
        return interaction.update({
          embeds: [hiloEmbed(sess, 'playing')],
          files: [ASSET.kazento()],
          components: [hiloRow()]
        });
      }
      if (cid === 'btn_leme')     return interaction.showModal(betModal('leme', '🎰 Leme'));
      if (cid === 'btn_dice')     return interaction.showModal(betModal('dice', '🎲 Dice'));
      if (cid === 'btn_bj')       return interaction.showModal(betModal('bj', '🃏 Blackjack'));
      if (cid === 'btn_roulette') return interaction.showModal(betModal('roulette', '🎡 Roulette'));

      if (cid === 'btn_baccarat') {
        const u2 = await getUser(uid);
        if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
        return interaction.showModal(betModal('baccarat', '🎴 Baccarat'));
      }

      // =================== BACCARAT PICK/DEAL BUTTONS ===================
      if (['bac_pick_PLAYER','bac_pick_BANKER','bac_pick_TIE','bac_deal'].includes(cid)) {
        const sess = await bacGetSession(uid);
        if (!sess) return interaction.reply({ content: '❌ Sesi Baccarat tidak ditemukan. Mulai game baru.', flags: 64 });

        if (cid === 'bac_deal') {
          if (sess.picks.length === 0) return interaction.reply({ content: '❌ Pilih minimal 1 (Player/Banker/Tie) dulu!', flags: 64 });

          const u2 = await getUser(uid);
          if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });

          const deal = dealBaccarat();
          // Hitung payout: Player menang 1:1, Banker menang 0.95:1 (5% komisi), Tie menang 8:1
          let totalPayout = 0;
          for (const pick of sess.picks) {
            const betPortion = sess.bet / sess.picks.length; // bagi rata kalau pilih 2
            if (pick === deal.outcome) {
              if (pick === 'TIE')    totalPayout += betPortion * 8;
              else if (pick === 'BANKER') totalPayout += betPortion * 0.95;
              else                    totalPayout += betPortion * 1;
            } else {
              totalPayout -= betPortion;
            }
          }
          totalPayout = Math.round(totalPayout);

          const { newSaldo, newPL, newRole } = await updateStats(uid, totalPayout, sess.bet, totalPayout, guild);
          const { data: gh } = await supabase.from('game_history').insert({
            phone: uid, game: 'baccarat', bet: sess.bet,
            result: deal.outcome,
            player_number: deal.finalP, house_number: deal.finalB,
            payout: totalPayout
          }).select().single();
          await bacDeleteSession(uid);
          const le = totalPayout > 0 ? '🎴' : totalPayout === 0 ? '🤝' : '❌';
          await sendGameLog(client, `${le} **BACCARAT** | <@${uid}> | Picks:${sess.picks.join('+')} | ${deal.outcome} | ${totalPayout >= 0 ? '+' : ''}${totalPayout} DL`);
          try {
            return await interaction.update({
              embeds: [bacResultEmbed(sess, deal, totalPayout, newSaldo, newPL, newRole, gh?.id || '-')],
              files: [ASSET.kazento()],
              components: []
            });
          } catch { return; }
        }

        // Toggle pick
        const pickType = cid.replace('bac_pick_', ''); // PLAYER | BANKER | TIE
        let picks = sess.picks || [];

        if (picks.includes(pickType)) {
          picks = picks.filter(p => p !== pickType); // unselect
        } else {
          // Validasi: Player + Banker tidak boleh bersamaan
          if ((pickType === 'PLAYER' && picks.includes('BANKER')) ||
              (pickType === 'BANKER' && picks.includes('PLAYER'))) {
            return interaction.reply({ content: '❌ Tidak bisa pilih **Player** dan **Banker** sekaligus!', flags: 64 });
          }
          picks.push(pickType);
        }
        sess.picks = picks;
        await bacSetSession(uid, sess);

        const pattern = await getBaccaratPattern(uid);
        try {
          return await interaction.update({
            embeds: [bacPickEmbed(sess.bet, pattern, picks)],
            files: [ASSET.kazento()],
            components: bacPickRow(picks)
          });
        } catch { return; }
      }

      // =================== ROULETTE COLOR PICK ===================
      if (cid.startsWith('rou_bet_')) {
        // format: rou_bet_{color}_{bet}
        const parts = cid.split('_'); // ['rou','bet',color,bet]
        const pick  = parts[2]; // red | black | green
        const bet   = parseFloat(parts[3]);

        if (isNaN(bet) || bet <= 0) return interaction.reply({ content: '❌ Bet tidak valid.', flags: 64 });
        const cd = checkCD(uid);
        if (cd > 0) return interaction.reply({ content: `⏳ Cooldown ${cd}s.`, flags: 64 });
        const u2 = await getUser(uid);
        if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
        if (Number(u2.saldo) < bet) return interaction.reply({ content: `❌ Saldo kurang.`, flags: 64 });

        const slot = spinRoulette();
        const { outcome, payout } = calcRoulette(pick, slot, bet);
        const { newSaldo, newPL, newRole } = await updateStats(uid, payout, bet, payout, guild);
        const { data: gh } = await supabase.from('game_history').insert({
          phone: uid, game: 'roulette', bet,
          result: outcome, player_number: slot.n, house_number: 0, payout
        }).select().single();
        const le = payout > 0 ? '✅' : '❌';
        await sendGameLog(client, `${le} **ROULETTE** | <@${uid}> | Pick:${pick} | Slot:${slot.n}(${slot.color}) | ${payout >= 0 ? '+' : ''}${payout} DL`);
        try {
          return await interaction.update({
            embeds: [rouletteEmbed(pick, slot, payout, newSaldo, newPL, newRole, gh?.id || '-')],
            files: [ASSET.kazento()],
            components: []
          });
        } catch { return; }
      }

      // =================== TICKET CLOSE ===================
      if (cid.startsWith('ticket_close_')) {
        const targetChId = cid.replace('ticket_close_', '');
        // Hanya owner/admin atau user pemilik ticket yg bisa tutup
        const ch = guild.channels.cache.get(targetChId) || await guild.channels.fetch(targetChId).catch(() => null);
        if (!ch) return interaction.reply({ content: '❌ Channel tidak ditemukan.', flags: 64 });

        // Cek apakah user punya akses tutup (owner ticket = nama channel mengandung uid, atau admin/owner)
        const isTicketOwner = ch.name.endsWith(`-${uid}`);
        if (!isTicketOwner && !isAdmin) return interaction.reply({ content: '❌ Hanya pemilik ticket atau admin yang bisa menutup.', flags: 64 });

        const closeEmbed = new EmbedBuilder()
          .setTitle('🔒 Ticket Ditutup')
          .setColor(0x95A5A6)
          .setDescription(`Ticket ditutup oleh <@${uid}>\nChannel akan dihapus dalam **5 detik**...`)
          .setTimestamp();

        await interaction.reply({ embeds: [closeEmbed] });
        await sendLog(interaction.client, `🔒 **TICKET CLOSED** | <#${targetChId}> | by <@${uid}>`);
        setTimeout(async () => {
          try { await ch.delete(`Ticket closed by ${uid}`); } catch { }
        }, 5000);
        return;
      }

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
            const { newSaldo, newPL, newRole } = await updateStats(uid, payout + sess.bet, sess.bet, payout, guild);
            const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: 'blackjack', bet: sess.bet, result, player_number: pv, house_number: handValue(sess.dealerHand), payout }).select().single();
            await bjDeleteSession(uid);
            await sendGameLog(client, `🃏 **BJ** | <@${uid}> | ${result} | ${payout >= 0 ? '+' : ''}${payout} DL`);
            try { return await interaction.update({ embeds: [bjEndEmbed(sess, result, payout, newSaldo, newPL, newRole, gh?.id || '-')], files: [ASSET.kazento()], components: [] }); } catch { return; }
          }
          try { return await interaction.update({ embeds: [bjEmbed(sess)], files: [ASSET.kazento()], components: [bjActionRow(false, false, false)] }); } catch { return; }
        }

        if (cid === 'bj_stand') {
          sess.dealerHand = dealerPlay(sess.dealerHand);
          const { result, payout } = bjPayout(sess.playerHand, sess.dealerHand, sess.bet, 'stand', sess.insuranceBet);
          const { newSaldo, newPL, newRole } = await updateStats(uid, payout + sess.bet, sess.bet, payout, guild);
          const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: 'blackjack', bet: sess.bet, result, player_number: handValue(sess.playerHand), house_number: handValue(sess.dealerHand), payout }).select().single();
          await bjDeleteSession(uid);
          await sendGameLog(client, `🃏 **BJ** | <@${uid}> | ${result} | ${payout >= 0 ? '+' : ''}${payout} DL`);
          try { return await interaction.update({ embeds: [bjEndEmbed(sess, result, payout, newSaldo, newPL, newRole, gh?.id || '-')], files: [ASSET.kazento()], components: [] }); } catch { return; }
        }

        if (cid === 'bj_double') {
          if (Number(u2.saldo) < sess.bet) return interaction.reply({ content: '❌ Saldo kurang untuk double.', flags: 64 });
          await supabase.from('users').update({ saldo: Number(u2.saldo) - sess.bet }).eq('phone', uid);
          sess.bet = sess.bet * 2;
          sess.playerHand.push(drawCard());
          sess.dealerHand = dealerPlay(sess.dealerHand);
          const { result, payout } = bjPayout(sess.playerHand, sess.dealerHand, sess.bet, 'stand', sess.insuranceBet);
          const { newSaldo, newPL, newRole } = await updateStats(uid, payout + sess.bet, sess.bet, payout, guild);
          const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: 'blackjack', bet: sess.bet, result, player_number: handValue(sess.playerHand), house_number: handValue(sess.dealerHand), payout }).select().single();
          await bjDeleteSession(uid);
          await sendGameLog(client, `🃏 **BJ DOUBLE** | <@${uid}> | ${result} | ${payout >= 0 ? '+' : ''}${payout} DL`);
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
            const { newSaldo, newPL, newRole } = await updateStats(uid, totalPayout + sess.bet, sess.bet, totalPayout, guild);
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
          const { newSaldo, newPL, newRole } = await updateStats(uid, payout + sess.bet, sess.bet, payout, guild);
          await bjDeleteSession(uid);
          await sendGameLog(client, `🃏 **BJ SURRENDER** | <@${uid}> | ${payout} DL`);
          try { return await interaction.update({ embeds: [bjEndEmbed(sess, result, payout, newSaldo, newPL, newRole, '-')], files: [ASSET.kazento()], components: [] }); } catch { return; }
        }
      }
    }

    // =================== MODALS ===================
    if (interaction.isModalSubmit()) {
      const cid = interaction.customId;
      const bet = parseFloat(interaction.fields.getTextInputValue('bet_input'));


      // Game lain
      if (isNaN(bet) || bet <= 0) return interaction.reply({ content: '❌ Bet tidak valid.', flags: 64 });

      const errBet = validateBet(bet);
      if (errBet) return interaction.reply({ content: errBet, flags: 64 });

      const cd = checkCD(uid);
      if (cd > 0) return interaction.reply({ content: `⏳ Cooldown ${cd}s.`, flags: 64 });

      const u2 = await getUser(uid);
      if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
      if (Number(u2.saldo) < bet) return interaction.reply({ content: `❌ Saldo kurang. Saldo: ${dl(u2.saldo)}`, flags: 64 });

      // Tower modal — format: modal_tower_{difficulty}
      if (cid.startsWith('modal_tower_')) {
        const diff = cid.replace('modal_tower_', '');
        if (!TOWER_DIFFICULTIES[diff]) return interaction.reply({ content: '❌ Difficulty tidak valid.', flags: 64 });
        const betStr = interaction.fields.getTextInputValue('bet');
        const bet = parseFloat(betStr);
        const betErr = validateBet(bet);
        if (betErr) return interaction.reply({ content: betErr, flags: 64 });
        const u2 = await getUser(uid);
        if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
        if (Number(u2.saldo) < bet) return interaction.reply({ content: '❌ Saldo kurang.', flags: 64 });

        // Deduct bet dari saldo dulu
        await supabase.from('users').update({ saldo: Number(u2.saldo) - bet }).eq('phone', uid);

        const sess = {
          difficulty: diff,
          bet,
          currentLayer: 1,
          currentMult: 1,
          history: [],
        };
        await towerSetSession(uid, sess);

        const d = TOWER_DIFFICULTIES[diff];
        return interaction.reply({
          embeds: [towerEmbed(sess)],
          files: [ASSET.kazento()],
          components: [towerPickRow(d.grids)],
          flags: 64
        });
      }

      // HiLo modal
      if (cid === 'modal_hilo') {
        const u2 = await getUser(uid);
        if (!u2) return interaction.reply({ content: '❌ Error load user.', flags: 64 });
        if (Number(u2.saldo) < bet) return interaction.reply({ content: '❌ Saldo kurang.', flags: 64 });

        // Deduct bet dari saldo dulu
        await supabase.from('users').update({ saldo: Number(u2.saldo) - bet }).eq('phone', uid);

        const firstCard = hiloDraw();
        const sess = {
          bet,
          currentCard: firstCard,
          currentMult: 1,
          history: [],
        };
        await hiloSetSession(uid, sess);
        return interaction.reply({
          embeds: [hiloEmbed(sess)],
          files: [ASSET.kazento()],
          components: [hiloRow()],
          flags: 64
        });
      }

      // Roulette — munculin pilihan warna setelah input bet
      if (cid === 'modal_roulette') {
        const rouRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rou_bet_red_${bet}`).setLabel('🔴 Red (2x)').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`rou_bet_black_${bet}`).setLabel('⚫ Black (2x)').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rou_bet_green_${bet}`).setLabel('🟢 Green (36x)').setStyle(ButtonStyle.Success),
        );
        const rouEmbed = new EmbedBuilder()
          .setTitle('🎡 ROULETTE')
          .setColor(0x8E44AD)
          .setThumbnail('attachment://Kazento.png')
          .setDescription(`Bet: ${dl(bet)}\nPilih warna taruhan kamu!`)
          .addFields(
            { name: '🔴 Red',   value: 'Bayar **2x**',  inline: true },
            { name: '⚫ Black', value: 'Bayar **2x**',  inline: true },
            { name: '🟢 Green', value: 'Bayar **36x**', inline: true },
          );
        return interaction.reply({ embeds: [rouEmbed], files: [ASSET.kazento()], components: [rouRow], flags: 64 });
      }

      // Baccarat — simpan bet, munculin pick embed
      if (cid === 'modal_baccarat') {
        const existing = await bacGetSession(uid);
        if (existing) await bacDeleteSession(uid);
        await bacSetSession(uid, { bet, picks: [] });
        const pattern = await getBaccaratPattern(uid);
        return interaction.reply({
          embeds: [bacPickEmbed(bet, pattern, [])],
          files: [ASSET.kazento()],
          components: bacPickRow([]),
          flags: 64
        });
      }

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
          const { newSaldo, newPL, newRole } = await updateStats(uid, payout + bet, bet, payout, guild);
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
      const { newSaldo, newPL, newRole } = await updateStats(uid, payout, bet, payout, guild);
      const { data: gh } = await supabase.from('game_history').insert({ phone: uid, game: cid.replace('modal_', ''), bet, result: outcome, player_number: player, house_number: house, payout }).select().single();
      const le = outcome.includes('JACKPOT') ? '🎉' : outcome === 'MENANG' ? '✅' : '❌';
      await sendGameLog(client, `${le} **${gameName}** | <@${uid}> | Bet:${bet} DL | ${outcome} | ${payout >= 0 ? '+' : ''}${payout} DL`);
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
