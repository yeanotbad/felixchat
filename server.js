const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@libsql/client');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const app = express();
// Signup abuse protection is based on the email/username being submitted, not IP.
// This avoids blocking lots of legitimate people sharing the same school Wi-Fi.
const registrationRate = new Map();
function registrationKey(req){
  const email=String(req.body?.email||'').trim().toLowerCase();
  const username=String(req.body?.username||'').trim().toLowerCase();
  return email || username || 'unknown';
}
function checkRegistrationRate(req){
  const key=registrationKey(req), t=Date.now(), windowMs=10*60*1000;
  let r=registrationRate.get(key);
  if(!r || t-r.start>windowMs) r={start:t,count:0};
  r.count++;
  registrationRate.set(key,r);
  // Normal users get plenty of room; only rapid repeated attempts for the same
  // email/username are temporarily slowed down.
  return r.count<=8;
}
setInterval(()=>{const t=Date.now(); for(const [key,r] of registrationRate) if(t-r.start>10*60*1000) registrationRate.delete(key);},5*60*1000).unref?.();


const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const UPLOADS = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

// Turso is the persistent database. For local development without Turso,
// the app falls back to a local SQLite database when TURSO_DATABASE_URL is absent.
const db = process.env.TURSO_DATABASE_URL
  ? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: 'file:felix-local.db' });

const sockets = new Map();
if(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT){ webpush.setVapidDetails(process.env.VAPID_SUBJECT,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY); }
async function sendPush(uid,payload){ if(!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY||!process.env.VAPID_SUBJECT)return; const r=await db.execute({sql:'SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE uid=?',args:[uid]}); for(const x of r.rows){try{await webpush.sendNotification({endpoint:x.endpoint,keys:{p256dh:x.p256dh,auth:x.auth}},JSON.stringify(payload));}catch(e){if(e.statusCode===404||e.statusCode===410)await db.execute({sql:'DELETE FROM push_subscriptions WHERE endpoint=?',args:[x.endpoint]});}} }
const id = () => crypto.randomBytes(16).toString('hex');
const clean = s => String(s ?? '').trim().slice(0, 32);
const hash = (password, salt) => crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
const now = () => Date.now();
const chatKey = (a, b) => [a, b].sort().join(':');
const pairKey = (a,b) => [a,b].sort().join(':');
const utcDay = (ms=Date.now()) => new Date(ms).toISOString().slice(0,10);
async function touchFriendStreak(a,b){
  if(!a||!b||a===b||!(await areFriends(a,b))) return null;
  const key=pairKey(a,b), day=utcDay();
  const r=await db.execute({sql:'SELECT * FROM friend_streaks WHERE pair_key=?',args:[key]});
  const row=r.rows[0];
  let streak=1;
  if(row){
    if(row.last_day===day) streak=Number(row.streak||1);
    else {
      const prev=new Date(row.last_day+'T00:00:00Z');
      const cur=new Date(day+'T00:00:00Z');
      const diff=Math.round((cur-prev)/86400000);
      streak=diff===1?Number(row.streak||0)+1:1;
    }
    await db.execute({sql:'UPDATE friend_streaks SET streak=?,last_day=? WHERE pair_key=?',args:[streak,day,key]});
  }else{
    await db.execute({sql:'INSERT INTO friend_streaks(pair_key,user_a,user_b,streak,last_day) VALUES(?,?,?,?,?)',args:[key,...[a,b].sort(),1,day]});
  }
  return {pairKey:key,streak,lastDay:day,formed:!row};
}

async function init() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, display_name TEXT, bio TEXT DEFAULT '', avatar TEXT DEFAULT '', role TEXT DEFAULT 'member', verified INTEGER DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, streak INTEGER DEFAULT 0, felix_score INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(uid) REFERENCES users(uid))`,
    `CREATE TABLE IF NOT EXISTS friendships (user_id TEXT NOT NULL, friend_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, friend_id))`,
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL, text TEXT DEFAULT '', kind TEXT DEFAULT 'text', url TEXT DEFAULT '', name TEXT DEFAULT '', mime TEXT DEFAULT '', created_at INTEGER NOT NULL, read_at INTEGER, expires_at INTEGER, reply_to TEXT, edited INTEGER DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_key, created_at)`,
    `CREATE TABLE IF NOT EXISTS reactions (message_id TEXT NOT NULL, uid TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_id, uid))`,
    `CREATE TABLE IF NOT EXISTS stories (id TEXT PRIMARY KEY, uid TEXT NOT NULL, media_url TEXT NOT NULL, kind TEXT NOT NULL, caption TEXT DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS story_views (story_id TEXT NOT NULL, uid TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY(story_id, uid))`,
    `CREATE TABLE IF NOT EXISTS blocks (uid TEXT NOT NULL, blocked_uid TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(uid, blocked_uid))`,
    `CREATE TABLE IF NOT EXISTS groups (gid TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS group_members (gid TEXT NOT NULL, uid TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY(gid, uid))`,
    `CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, text TEXT DEFAULT '', kind TEXT DEFAULT 'text', url TEXT DEFAULT '', name TEXT DEFAULT '', mime TEXT DEFAULT '', audience TEXT DEFAULT 'all', targets_json TEXT DEFAULT '[]', created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS announcement_views (announcement_id TEXT NOT NULL, uid TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY(announcement_id, uid))`,
    `CREATE TABLE IF NOT EXISTS group_messages (id TEXT PRIMARY KEY, gid TEXT NOT NULL, sender_id TEXT NOT NULL, text TEXT DEFAULT '', kind TEXT DEFAULT 'text', url TEXT DEFAULT '', name TEXT DEFAULT '', mime TEXT DEFAULT '', created_at INTEGER NOT NULL, edited INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS group_notifications (id TEXT PRIMARY KEY, uid TEXT NOT NULL, gid TEXT NOT NULL, group_name TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_group_notifications_uid ON group_notifications(uid, created_at)` ,
    `CREATE INDEX IF NOT EXISTS idx_group_messages_time ON group_messages(gid, created_at)`,
    `CREATE TABLE IF NOT EXISTS pinned_messages (message_id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, pinned_by TEXT NOT NULL, pinned_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS friend_streaks (pair_key TEXT PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, streak INTEGER DEFAULT 0, last_day TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, question TEXT NOT NULL, options_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS poll_votes (poll_id TEXT NOT NULL, uid TEXT NOT NULL, option_index INTEGER NOT NULL, voted_at INTEGER NOT NULL, PRIMARY KEY(poll_id, uid))`,
    `CREATE TABLE IF NOT EXISTS poll_views (poll_id TEXT NOT NULL, uid TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY(poll_id, uid))`,
    `CREATE TABLE IF NOT EXISTS system_status (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, uid TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS collectibles (id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,rarity TEXT NOT NULL,value TEXT DEFAULT '',staff_only INTEGER DEFAULT 1,mod_grantable INTEGER DEFAULT 0,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS user_collectibles (uid TEXT NOT NULL,collectible_id TEXT NOT NULL,granted_by TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(uid,collectible_id))`,
    `CREATE TABLE IF NOT EXISTS equipped_tags (uid TEXT NOT NULL,collectible_id TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(uid,collectible_id))`,
    `CREATE TABLE IF NOT EXISTS trade_offers (id TEXT PRIMARY KEY,from_uid TEXT NOT NULL,to_uid TEXT NOT NULL,give_json TEXT NOT NULL,want_json TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_trade_to ON trade_offers(to_uid,status,created_at)`,
    `CREATE TABLE IF NOT EXISTS quest_claims (uid TEXT NOT NULL, quest_id TEXT NOT NULL, claimed_at INTEGER NOT NULL, PRIMARY KEY(uid,quest_id))`,
    `CREATE TABLE IF NOT EXISTS email_verifications (email TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS password_resets (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0, created_at INTEGER NOT NULL)`
  ], 'write');
  for (const sql of [
    `ALTER TABLE announcements ADD COLUMN audience TEXT DEFAULT 'all'`,
    `ALTER TABLE announcements ADD COLUMN targets_json TEXT DEFAULT '[]'`,
    `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'member'`,
    `ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN banned_at INTEGER`,
    `ALTER TABLE users ADD COLUMN banned_by TEXT`,
    `ALTER TABLE users ADD COLUMN status_text TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN banner TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN timeout_until INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN timeout_by TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN email TEXT`
  ]) { try { await db.execute(sql); } catch (e) {} }
  try { await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email COLLATE NOCASE) WHERE email IS NOT NULL`); } catch (e) { console.error('email index',e); }
  // The @felixchat account is the sole owner of the admin powers.
  // This does not change any other account's role.
  try { await db.execute({sql:`UPDATE users SET role='admin' WHERE username='felixchat'`,args:[]}); } catch (e) {}
  const starter=[
['developer','DEVELOPER','tag','mythic','developer',1,0],['legend','LEGEND','tag','legendary','rainbow',1,0],['og','OG','tag','rare','gold',1,1],['neon','NEON','name_effect','epic','neon',1,1],['fire','FIRE','name_effect','legendary','fire',1,0],['early','EARLY USER','tag','uncommon','blue',1,1],['halo','HALO','profile_frame','epic','halo',1,1],
['friend','FRIEND','tag','common','',1,1],['cool','COOL','tag','common','',1,1],['active','ACTIVE','tag','common','',1,1],['helper','HELPER','tag','common','',1,1],['chatter','CHATTER','tag','common','',1,1],['funny','FUNNY','tag','common','',1,1],['gamer','GAMER','tag','common','',1,1],['social','SOCIAL','tag','common','',1,1],['nightowl','NIGHT OWL','tag','common','',1,1],
['vip','VIP','tag','uncommon','',1,1],['supporter','SUPPORTER','tag','uncommon','',1,1],['creator','CREATOR','tag','uncommon','',1,1],['trending','TRENDING','tag','uncommon','',1,1],['explorer','EXPLORER','tag','uncommon','',1,1],['musicfan','MUSIC FAN','tag','uncommon','',1,1],['streaker','STREAKER','tag','uncommon','',1,1],['photographer','PHOTOGRAPHER','tag','uncommon','',1,1],['ogmember','OG MEMBER','tag','uncommon','',1,1],['team','TEAM','tag','uncommon','',1,1],
['rare','RARE','tag','rare','',1,0],['elite','ELITE','tag','rare','',1,0],['star','STAR','tag','rare','',1,0],['diamond','DIAMOND','tag','rare','',1,0],['champion','CHAMPION','tag','rare','',1,0],['influencer','INFLUENCER','tag','rare','',1,0],['dj','DJ','tag','rare','',1,0],['streamer','STREAMER','tag','rare','',1,0],['legendgamer','LEGEND GAMER','tag','rare','',1,0],['trusted','TRUSTED','tag','rare','',1,0],
['epic','EPIC','tag','epic','',1,0],['master','MASTER','tag','epic','',1,0],['royal','ROYAL','tag','epic','',1,0],['phoenix','PHOENIX','tag','epic','',1,0],['dragon','DRAGON','tag','epic','',1,0],['lightning','LIGHTNING','tag','epic','',1,0],['galaxy','GALAXY','tag','epic','',1,0],['cosmic','COSMIC','tag','epic','',1,0],['immortal','IMMORTAL','tag','epic','',1,0],['superstar','SUPERSTAR','tag','epic','',1,0],
['mythic','MYTHIC','tag','legendary','',1,0],['godlike','GODLIKE','tag','legendary','',1,0],['celestial','CELESTIAL','tag','legendary','',1,0],['titan','TITAN','tag','legendary','',1,0],['emperor','EMPEROR','tag','legendary','',1,0],['supreme','SUPREME','tag','legendary','',1,0],['theone','THE ONE','tag','legendary','',1,0],['eternal','ETERNAL','tag','legendary','',1,0],['felixelite','FELIX ELITE','tag','legendary','',1,0],
['friendly','FRIENDLY','tag','common','',1,1],['chill','CHILL','tag','common','',1,1],['memer','MEMER','tag','common','',1,1],['talkative','TALKATIVE','tag','common','',1,1],['speedy','SPEEDY','tag','common','',1,1],['curious','CURIOUS','tag','common','',1,1],['vibes','VIBES','tag','common','',1,1],['coolkid','COOL KID','tag','common','',1,1],['dailyuser','DAILY USER','tag','common','',1,1],['rookie','ROOKIE','tag','common','',1,1],
['vipmember','VIP MEMBER','tag','uncommon','',1,1],['superfan','SUPER FAN','tag','uncommon','',1,1],['contentcreator','CONTENT CREATOR','tag','uncommon','',1,1],['musicmaker','MUSIC MAKER','tag','uncommon','',1,1],['storyteller','STORYTELLER','tag','uncommon','',1,1],['socialstar','SOCIAL STAR','tag','uncommon','',1,1],['trendsetter','TRENDSETTER','tag','uncommon','',1,1],['nightrider','NIGHT RIDER','tag','uncommon','',1,1],['chatpro','CHAT PRO','tag','uncommon','',1,1],['loyal','LOYAL','tag','uncommon','',1,1],
['blueflame','BLUE FLAME','tag','rare','',1,0],['iceking','ICE KING','tag','rare','',1,0],['golden','GOLDEN','tag','rare','',1,0],['shadow','SHADOW','tag','rare','',1,0],['cyber','CYBER','tag','rare','',1,0],['neontag','NEON TAG','tag','rare','',1,0],['spacewalker','SPACE WALKER','tag','rare','',1,0],['timetraveler','TIME TRAVELER','tag','rare','',1,0],['treasurehunter','TREASURE HUNTER','tag','rare','',1,0],['risingstar','RISING STAR','tag','rare','',1,0],
['voidwalker','VOID WALKER','tag','epic','',1,0],['stormmaster','STORM MASTER','tag','epic','',1,0],['firelord','FIRE LORD','tag','epic','',1,0],['frostborn','FROSTBORN','tag','epic','',1,0],['cyberlegend','CYBER LEGEND','tag','epic','',1,0],['galactic','GALACTIC','tag','epic','',1,0],['phantom','PHANTOM','tag','epic','',1,0],['eternalflame','ETERNAL FLAME','tag','epic','',1,0],['dreamwalker','DREAM WALKER','tag','epic','',1,0],['dimensional','DIMENSIONAL','tag','epic','',1,0],
['king','KING','tag','legendary','',1,0],['queen','QUEEN','tag','legendary','',1,0],['thundergod','THUNDER GOD','tag','legendary','',1,0],['universe','UNIVERSE','tag','legendary','',1,0],['inferno','INFERNO','tag','legendary','',1,0],['dragonlord','DRAGON LORD','tag','legendary','',1,0],['rainbowlegend','RAINBOW LEGEND','tag','legendary','rainbow',1,0],['starborn','STARBORN','tag','legendary','',1,0],['ultimate','ULTIMATE','tag','legendary','',1,0],['watcher','THE WATCHER','tag','legendary','',1,0],
['chud','CHUD','tag','common','',1,1],['loser','LOSER','tag','common','',1,1],['dweeb','DWEEB','tag','common','',1,1],['dork','DORK','tag','common','',1,1],['mania','MANIA','tag','rare','',1,0],['kevinchatsucks','kevinchatsucks','tag','rare','',1,0],
['ohio','OHIO','tag','common','',1,1],['skibidi','SKIBIDI','tag','common','',1,1],['sigma','SIGMA','tag','uncommon','',1,1],['maxxer','MAXXER','tag','uncommon','',1,1],['aura','AURA','tag','common','',1,1],['aurafarmer','AURA FARMER','tag','rare','',1,0],['rizzler','RIZZLER','tag','uncommon','',1,1],['rizzgod','RIZZ GOD','tag','legendary','',1,0],['alpha','ALPHA','tag','uncommon','',1,1],['yapper','YAPPER','tag','common','',1,1],['crashout','CRASHOUT','tag','rare','',1,0],['balkanrage','BALKAN RAGE','tag','rare','',1,0],['stillwater','STILL WATER','tag','rare','',1,0],['mangomango','MANGO MANGO','tag','common','',1,1],['trollface','TROLLFACE','tag','uncommon','',1,1],['toiletking','TOILET KING','tag','epic','',1,0],['goated','GOATED','tag','rare','',1,0],['cooked','COOKED','tag','common','',1,1],['lockedin','LOCKED IN','tag','uncommon','',1,1],['thesigma','THE SIGMA','tag','epic','',1,0],['negativeaura','NEGATIVE AURA','tag','rare','',1,0],['auramaxxed','AURA MAXXED','tag','epic','',1,0],['brainrot','BRAINROT','tag','epic','',1,0],['gigachad','GIGA CHAD','tag','legendary','',1,0],['bananasigma','BANANA SIGMA','tag','rare','',1,0],['sus','SUS','tag','common','',1,1],['yapking','YAP KING','tag','rare','',1,0],['absolutecinema','ABSOLUTE CINEMA','tag','epic','',1,0],['peak','PEAK','tag','legendary','',1,0],['unhinged','UNHINGED','tag','epic','',1,0],
['bonus_tag_001','CHAOS KING','tag','common','',1,1],['bonus_tag_002','MEME KING','tag','uncommon','',1,1],['bonus_tag_003','SUS KING','tag','rare','',1,0],['bonus_tag_004','YAP KING','tag','epic','',1,0],['bonus_tag_005','AURA KING','tag','legendary','',1,0],['bonus_tag_006','NPC KING','tag','common','',1,1],['bonus_tag_007','SIGMA KING','tag','uncommon','',1,1],['bonus_tag_008','RIZZ KING','tag','rare','',1,0],['bonus_tag_009','OHIO KING','tag','epic','',1,0],['bonus_tag_010','GOOFY KING','tag','legendary','',1,0],['bonus_tag_011','CRINGE KING','tag','common','',1,1],['bonus_tag_012','COOKED KING','tag','uncommon','',1,1],['bonus_tag_013','LOCKED KING','tag','rare','',1,0],['bonus_tag_014','UNHINGED KING','tag','epic','',1,0],['bonus_tag_015','PEAK KING','tag','legendary','',1,0],['bonus_tag_016','BRAINROT KING','tag','common','',1,1],['bonus_tag_017','TROLL KING','tag','uncommon','',1,1],['bonus_tag_018','MANGO KING','tag','rare','',1,0],['bonus_tag_019','BANANA KING','tag','epic','',1,0],['bonus_tag_020','SKIBIDI KING','tag','legendary','',1,0],['bonus_tag_021','CHAOS LORD','tag','common','',1,1],['bonus_tag_022','MEME LORD','tag','uncommon','',1,1],['bonus_tag_023','SUS LORD','tag','rare','',1,0],['bonus_tag_024','YAP LORD','tag','epic','',1,0],['bonus_tag_025','AURA LORD','tag','legendary','',1,0],['bonus_tag_026','NPC LORD','tag','common','',1,1],['bonus_tag_027','SIGMA LORD','tag','uncommon','',1,1],['bonus_tag_028','RIZZ LORD','tag','rare','',1,0],['bonus_tag_029','OHIO LORD','tag','epic','',1,0],['bonus_tag_030','GOOFY LORD','tag','legendary','',1,0],['bonus_tag_031','CRINGE LORD','tag','common','',1,1],['bonus_tag_032','COOKED LORD','tag','uncommon','',1,1],['bonus_tag_033','LOCKED LORD','tag','rare','',1,0],['bonus_tag_034','UNHINGED LORD','tag','epic','',1,0],['bonus_tag_035','PEAK LORD','tag','legendary','',1,0],['bonus_tag_036','BRAINROT LORD','tag','common','',1,1],['bonus_tag_037','TROLL LORD','tag','uncommon','',1,1],['bonus_tag_038','MANGO LORD','tag','rare','',1,0],['bonus_tag_039','BANANA LORD','tag','epic','',1,0],['bonus_tag_040','SKIBIDI LORD','tag','legendary','',1,0],['bonus_tag_041','CHAOS MASTER','tag','common','',1,1],['bonus_tag_042','MEME MASTER','tag','uncommon','',1,1],['bonus_tag_043','SUS MASTER','tag','rare','',1,0],['bonus_tag_044','YAP MASTER','tag','epic','',1,0],['bonus_tag_045','AURA MASTER','tag','legendary','',1,0],['bonus_tag_046','NPC MASTER','tag','common','',1,1],['bonus_tag_047','SIGMA MASTER','tag','uncommon','',1,1],['bonus_tag_048','RIZZ MASTER','tag','rare','',1,0],['bonus_tag_049','OHIO MASTER','tag','epic','',1,0],['bonus_tag_050','GOOFY MASTER','tag','legendary','',1,0],['bonus_tag_051','CRINGE MASTER','tag','common','',1,1],['bonus_tag_052','COOKED MASTER','tag','uncommon','',1,1],['bonus_tag_053','LOCKED MASTER','tag','rare','',1,0],['bonus_tag_054','UNHINGED MASTER','tag','epic','',1,0],['bonus_tag_055','PEAK MASTER','tag','legendary','',1,0],['bonus_tag_056','BRAINROT MASTER','tag','common','',1,1],['bonus_tag_057','TROLL MASTER','tag','uncommon','',1,1],['bonus_tag_058','MANGO MASTER','tag','rare','',1,0],['bonus_tag_059','BANANA MASTER','tag','epic','',1,0],['bonus_tag_060','SKIBIDI MASTER','tag','legendary','',1,0],['bonus_tag_061','CHAOS GREMLIN','tag','common','',1,1],['bonus_tag_062','MEME GREMLIN','tag','uncommon','',1,1],['bonus_tag_063','SUS GREMLIN','tag','rare','',1,0],['bonus_tag_064','YAP GREMLIN','tag','epic','',1,0],['bonus_tag_065','AURA GREMLIN','tag','legendary','',1,0],['bonus_tag_066','NPC GREMLIN','tag','common','',1,1],['bonus_tag_067','SIGMA GREMLIN','tag','uncommon','',1,1],['bonus_tag_068','RIZZ GREMLIN','tag','rare','',1,0],['bonus_tag_069','OHIO GREMLIN','tag','epic','',1,0],['bonus_tag_070','GOOFY GREMLIN','tag','legendary','',1,0],['bonus_tag_071','CRINGE GREMLIN','tag','common','',1,1],['bonus_tag_072','COOKED GREMLIN','tag','uncommon','',1,1],['bonus_tag_073','LOCKED GREMLIN','tag','rare','',1,0],['bonus_tag_074','UNHINGED GREMLIN','tag','epic','',1,0],['bonus_tag_075','PEAK GREMLIN','tag','legendary','',1,0],['bonus_tag_076','BRAINROT GREMLIN','tag','common','',1,1],['bonus_tag_077','TROLL GREMLIN','tag','uncommon','',1,1],['bonus_tag_078','MANGO GREMLIN','tag','rare','',1,0],['bonus_tag_079','BANANA GREMLIN','tag','epic','',1,0],['bonus_tag_080','SKIBIDI GREMLIN','tag','legendary','',1,0],['bonus_tag_081','CHAOS WIZARD','tag','common','',1,1],['bonus_tag_082','MEME WIZARD','tag','uncommon','',1,1],['bonus_tag_083','SUS WIZARD','tag','rare','',1,0],['bonus_tag_084','YAP WIZARD','tag','epic','',1,0],['bonus_tag_085','AURA WIZARD','tag','legendary','',1,0],['bonus_tag_086','NPC WIZARD','tag','common','',1,1],['bonus_tag_087','SIGMA WIZARD','tag','uncommon','',1,1],['bonus_tag_088','RIZZ WIZARD','tag','rare','',1,0],['bonus_tag_089','OHIO WIZARD','tag','epic','',1,0],['bonus_tag_090','GOOFY WIZARD','tag','legendary','',1,0],['bonus_tag_091','CRINGE WIZARD','tag','common','',1,1],['bonus_tag_092','COOKED WIZARD','tag','uncommon','',1,1],['bonus_tag_093','LOCKED WIZARD','tag','rare','',1,0],['bonus_tag_094','UNHINGED WIZARD','tag','epic','',1,0],['bonus_tag_095','PEAK WIZARD','tag','legendary','',1,0],['bonus_tag_096','BRAINROT WIZARD','tag','common','',1,1],['bonus_tag_097','TROLL WIZARD','tag','uncommon','',1,1],['bonus_tag_098','MANGO WIZARD','tag','rare','',1,0],['bonus_tag_099','BANANA WIZARD','tag','epic','',1,0],['bonus_tag_100','SKIBIDI WIZARD','tag','legendary','',1,0],
];
  for(const x of starter) try{await db.execute({sql:'INSERT OR IGNORE INTO collectibles(id,name,type,rarity,value,staff_only,mod_grantable,created_at) VALUES(?,?,?,?,?,?,?,?)',args:[...x,now()]})}catch(e){}
  const tradeItems=[

    ['brainrot_item_001','OHIO ROCK 1','item','common','',1,0],
    ['brainrot_item_002','SKIBIDI TOILET 1','item','uncommon','',1,0],
    ['brainrot_item_003','SIGMA BANANA 1','item','rare','',1,0],
    ['brainrot_item_004','AURA POTION 1','item','epic','',1,0],
    ['brainrot_item_005','RIZZ CANNON 1','item','legendary','',1,0],
    ['brainrot_item_006','NPC REMOTE 1','item','common','',1,0],
    ['brainrot_item_007','YAP MEGAPHONE 1','item','uncommon','',1,0],
    ['brainrot_item_008','BRAINROT BRAIN 1','item','rare','',1,0],
    ['brainrot_item_009','SUS AMULET 1','item','epic','',1,0],
    ['brainrot_item_010','MANGO RELIC 1','item','legendary','',1,0],
    ['brainrot_item_011','COOKED PAN 1','item','common','',1,0],
    ['brainrot_item_012','STILL WATER 1','item','uncommon','',1,0],
    ['brainrot_item_013','TROLL MASK 1','item','rare','',1,0],
    ['brainrot_item_014','GIGA CHAD TROPHY 1','item','epic','',1,0],
    ['brainrot_item_015','NEGATIVE AURA RECEIPT 1','item','legendary','',1,0],
    ['brainrot_item_016','AURA FARM 1','item','common','',1,0],
    ['brainrot_item_017','GOOFY GOBLET 1','item','uncommon','',1,0],
    ['brainrot_item_018','CRINGE SHIELD 1','item','rare','',1,0],
    ['brainrot_item_019','PEAK POPCORN 1','item','epic','',1,0],
    ['brainrot_item_020','CHAOS CUBE 1','item','legendary','',1,0],
    ['brainrot_item_021','OHIO ROCK 2','item','common','',1,0],
    ['brainrot_item_022','SKIBIDI TOILET 2','item','uncommon','',1,0],
    ['brainrot_item_023','SIGMA BANANA 2','item','rare','',1,0],
    ['brainrot_item_024','AURA POTION 2','item','epic','',1,0],
    ['brainrot_item_025','RIZZ CANNON 2','item','legendary','',1,0],
    ['brainrot_item_026','NPC REMOTE 2','item','common','',1,0],
    ['brainrot_item_027','YAP MEGAPHONE 2','item','uncommon','',1,0],
    ['brainrot_item_028','BRAINROT BRAIN 2','item','rare','',1,0],
    ['brainrot_item_029','SUS AMULET 2','item','epic','',1,0],
    ['brainrot_item_030','MANGO RELIC 2','item','legendary','',1,0],
    ['brainrot_item_031','COOKED PAN 2','item','common','',1,0],
    ['brainrot_item_032','STILL WATER 2','item','uncommon','',1,0],
    ['brainrot_item_033','TROLL MASK 2','item','rare','',1,0],
    ['brainrot_item_034','GIGA CHAD TROPHY 2','item','epic','',1,0],
    ['brainrot_item_035','NEGATIVE AURA RECEIPT 2','item','legendary','',1,0],
    ['brainrot_item_036','AURA FARM 2','item','common','',1,0],
    ['brainrot_item_037','GOOFY GOBLET 2','item','uncommon','',1,0],
    ['brainrot_item_038','CRINGE SHIELD 2','item','rare','',1,0],
    ['brainrot_item_039','PEAK POPCORN 2','item','epic','',1,0],
    ['brainrot_item_040','CHAOS CUBE 2','item','legendary','',1,0],
    ['brainrot_item_041','OHIO ROCK 3','item','common','',1,0],
    ['brainrot_item_042','SKIBIDI TOILET 3','item','uncommon','',1,0],
    ['brainrot_item_043','SIGMA BANANA 3','item','rare','',1,0],
    ['brainrot_item_044','AURA POTION 3','item','epic','',1,0],
    ['brainrot_item_045','RIZZ CANNON 3','item','legendary','',1,0],
    ['brainrot_item_046','NPC REMOTE 3','item','common','',1,0],
    ['brainrot_item_047','YAP MEGAPHONE 3','item','uncommon','',1,0],
    ['brainrot_item_048','BRAINROT BRAIN 3','item','rare','',1,0],
    ['brainrot_item_049','SUS AMULET 3','item','epic','',1,0],
    ['brainrot_item_050','MANGO RELIC 3','item','legendary','',1,0],
    ['brainrot_item_051','COOKED PAN 3','item','common','',1,0],
    ['brainrot_item_052','STILL WATER 3','item','uncommon','',1,0],
    ['brainrot_item_053','TROLL MASK 3','item','rare','',1,0],
    ['brainrot_item_054','GIGA CHAD TROPHY 3','item','epic','',1,0],
    ['brainrot_item_055','NEGATIVE AURA RECEIPT 3','item','legendary','',1,0],
    ['brainrot_item_056','AURA FARM 3','item','common','',1,0],
    ['brainrot_item_057','GOOFY GOBLET 3','item','uncommon','',1,0],
    ['brainrot_item_058','CRINGE SHIELD 3','item','rare','',1,0],
    ['brainrot_item_059','PEAK POPCORN 3','item','epic','',1,0],
    ['brainrot_item_060','CHAOS CUBE 3','item','legendary','',1,0],
    ['brainrot_item_061','OHIO ROCK 4','item','common','',1,0],
    ['brainrot_item_062','SKIBIDI TOILET 4','item','uncommon','',1,0],
    ['brainrot_item_063','SIGMA BANANA 4','item','rare','',1,0],
    ['brainrot_item_064','AURA POTION 4','item','epic','',1,0],
    ['brainrot_item_065','RIZZ CANNON 4','item','legendary','',1,0],
    ['brainrot_item_066','NPC REMOTE 4','item','common','',1,0],
    ['brainrot_item_067','YAP MEGAPHONE 4','item','uncommon','',1,0],
    ['brainrot_item_068','BRAINROT BRAIN 4','item','rare','',1,0],
    ['brainrot_item_069','SUS AMULET 4','item','epic','',1,0],
    ['brainrot_item_070','MANGO RELIC 4','item','legendary','',1,0],
    ['brainrot_item_071','COOKED PAN 4','item','common','',1,0],
    ['brainrot_item_072','STILL WATER 4','item','uncommon','',1,0],
    ['brainrot_item_073','TROLL MASK 4','item','rare','',1,0],
    ['brainrot_item_074','GIGA CHAD TROPHY 4','item','epic','',1,0],
    ['brainrot_item_075','NEGATIVE AURA RECEIPT 4','item','legendary','',1,0],
    ['brainrot_item_076','AURA FARM 4','item','common','',1,0],
    ['brainrot_item_077','GOOFY GOBLET 4','item','uncommon','',1,0],
    ['brainrot_item_078','CRINGE SHIELD 4','item','rare','',1,0],
    ['brainrot_item_079','PEAK POPCORN 4','item','epic','',1,0],
    ['brainrot_item_080','CHAOS CUBE 4','item','legendary','',1,0],
    ['brainrot_item_081','OHIO ROCK 5','item','common','',1,0],
    ['brainrot_item_082','SKIBIDI TOILET 5','item','uncommon','',1,0],
    ['brainrot_item_083','SIGMA BANANA 5','item','rare','',1,0],
    ['brainrot_item_084','AURA POTION 5','item','epic','',1,0],
    ['brainrot_item_085','RIZZ CANNON 5','item','legendary','',1,0],
    ['brainrot_item_086','NPC REMOTE 5','item','common','',1,0],
    ['brainrot_item_087','YAP MEGAPHONE 5','item','uncommon','',1,0],
    ['brainrot_item_088','BRAINROT BRAIN 5','item','rare','',1,0],
    ['brainrot_item_089','SUS AMULET 5','item','epic','',1,0],
    ['brainrot_item_090','MANGO RELIC 5','item','legendary','',1,0],
    ['brainrot_item_091','COOKED PAN 5','item','common','',1,0],
    ['brainrot_item_092','STILL WATER 5','item','uncommon','',1,0],
    ['brainrot_item_093','TROLL MASK 5','item','rare','',1,0],
    ['brainrot_item_094','GIGA CHAD TROPHY 5','item','epic','',1,0],
    ['brainrot_item_095','NEGATIVE AURA RECEIPT 5','item','legendary','',1,0],
    ['brainrot_item_096','AURA FARM 5','item','common','',1,0],
    ['brainrot_item_097','GOOFY GOBLET 5','item','uncommon','',1,0],
    ['brainrot_item_098','CRINGE SHIELD 5','item','rare','',1,0],
    ['brainrot_item_099','PEAK POPCORN 5','item','epic','',1,0],
    ['brainrot_item_100','CHAOS CUBE 5','item','legendary','',1,0],
    ['bronze_coin','BRONZE COIN','item','common','',1,0],
    ['lucky_clover','LUCKY CLOVER','item','common','',1,0],
    ['smiley_cube','SMILEY CUBE','item','common','',1,0],
    ['tiny_trophy','TINY TROPHY','item','common','',1,0],
    ['paper_crown','PAPER CROWN','item','common','',1,0],
    ['blue_crystal','BLUE CRYSTAL','item','common','',1,0],
    ['chat_bubble','CHAT BUBBLE','item','common','',1,0],
    ['mini_rocket','MINI ROCKET','item','common','',1,0],
    ['pixel_heart','PIXEL HEART','item','common','',1,0],
    ['golden_key','GOLDEN KEY','item','common','',1,0],
    ['neon_orb','NEON ORB','item','uncommon','',1,0],
    ['silver_crown','SILVER CROWN','item','uncommon','',1,0],
    ['music_box','MUSIC BOX','item','uncommon','',1,0],
    ['cyber_gem','CYBER GEM','item','uncommon','',1,0],
    ['moon_token','MOON TOKEN','item','uncommon','',1,0],
    ['firework','FIREWORK','item','uncommon','',1,0],
    ['lucky_dice','LUCKY DICE','item','uncommon','',1,0],
    ['starlight_bottle','STARLIGHT BOTTLE','item','uncommon','',1,0],
    ['ghost_mask','GHOST MASK','item','uncommon','',1,0],
    ['treasure_map','TREASURE MAP','item','uncommon','',1,0],
    ['diamond_coin','DIAMOND COIN','item','rare','',1,0],
    ['plasma_sword','PLASMA BLADE','item','rare','',1,0],
    ['ice_crystal','ICE CRYSTAL','item','rare','',1,0],
    ['phoenix_feather','PHOENIX FEATHER','item','rare','',1,0],
    ['void_orb','VOID ORB','item','rare','',1,0],
    ['rainbow_gem','RAINBOW GEM','item','rare','',1,0],
    ['cyber_dragon','CYBER DRAGON','item','rare','',1,0],
    ['time_watch','TIME WATCH','item','rare','',1,0],
    ['star_key','STAR KEY','item','rare','',1,0],
    ['shadow_cube','SHADOW CUBE','item','rare','',1,0],
    ['galaxy_crown','GALAXY CROWN','item','epic','',1,0],
    ['storm_core','STORM CORE','item','epic','',1,0],
    ['dragon_egg','DRAGON EGG','item','epic','',1,0],
    ['cosmic_compass','COSMIC COMPASS','item','epic','',1,0],
    ['infinity_gem','INFINITY GEM','item','epic','',1,0],
    ['neon_wings','NEON WINGS','item','epic','',1,0],
    ['quantum_cube','QUANTUM CUBE','item','epic','',1,0],
    ['solar_flame','SOLAR FLAME','item','epic','',1,0],
    ['phantom_mask','PHANTOM MASK','item','epic','',1,0],
    ['legend_chest','LEGEND CHEST','item','epic','',1,0],
    ['mythic_crown','MYTHIC CROWN','item','legendary','',1,0],
    ['universe_orb','UNIVERSE ORB','item','legendary','',1,0],
    ['eternal_flame_item','ETERNAL FLAME','item','legendary','',1,0],
    ['celestial_wings','CELESTIAL WINGS','item','legendary','',1,0],
    ['dragon_relic','DRAGON RELIC','item','legendary','',1,0],
    ['god_key','GOD KEY','item','legendary','',1,0],
    ['infinity_crown','INFINITY CROWN','item','legendary','',1,0],
    ['rainbow_throne','RAINBOW THRONE','item','legendary','',1,0],
    ['felix_relic','FELIX RELIC','item','legendary','',1,0],
    ['one_of_one','ONE OF ONE','item','legendary','',1,0]
  ];
  for(const x of tradeItems) try{await db.execute({sql:'INSERT OR IGNORE INTO collectibles(id,name,type,rarity,value,staff_only,mod_grantable,created_at) VALUES(?,?,?,?,?,?,?,?)',args:[...x,now()]})}catch(e){}
  for(const x of [
['tag_comet','COMET','tag','common','',1,1],['tag_spark','SPARK','tag','common','',1,1],['tag_wanderer','WANDERER','tag','common','',1,1],['tag_wave','WAVE RIDER','tag','common','',1,1],['tag_builder','BUILDER','tag','common','',1,1],
['tag_lucky','LUCKY','tag','uncommon','',1,1],['tag_orbit','ORBIT','tag','uncommon','',1,1],['tag_glitch','GLITCH','tag','uncommon','',1,1],['tag_sonic','SONIC','tag','uncommon','',1,1],['tag_blaze','BLAZE','tag','uncommon','',1,1],
['tag_aurora','AURORA','tag','rare','',1,0],['tag_venom','VENOM','tag','rare','',1,0],['tag_nova','NOVA','tag','rare','',1,0],['tag_rift','RIFT WALKER','tag','rare','',1,0],['tag_crystal','CRYSTAL','tag','rare','',1,0],
['tag_eclipse','ECLIPSE','tag','epic','',1,0],['tag_thunder','THUNDERBORN','tag','epic','',1,0],['tag_astral','ASTRAL','tag','epic','',1,0],['tag_abyss','ABYSS','tag','epic','',1,0],['tag_quantum','QUANTUM','tag','epic','',1,0],
['tag_overlord','OVERLORD','tag','legendary','',1,0],['tag_starlord','STAR LORD','tag','legendary','',1,0],['tag_omega','OMEGA','tag','legendary','',1,0],['tag_infinite','INFINITE','tag','legendary','',1,0],['tag_voidking','VOID KING','tag','legendary','',1,0],
['item_coin_pouch','Coin Pouch','item','common','',0,0],['item_apple','Golden Apple','item','common','',0,0],['item_shell','Lucky Shell','item','common','',0,0],['item_feather','Silver Feather','item','common','',0,0],['item_ticket','Mystery Ticket','item','common','',0,0],
['item_neonfish','Neon Fish','item','uncommon','',0,0],['item_crate','Supply Crate','item','uncommon','',0,0],['item_orb','Energy Orb','item','uncommon','',0,0],['item_mask','Cyber Mask','item','uncommon','',0,0],['item_compass','Star Compass','item','uncommon','',0,0],
['item_blade','Crystal Blade','item','rare','',0,0],['item_core','Fusion Core','item','rare','',0,0],['item_fox','Spirit Fox','item','rare','',0,0],['item_relic','Ancient Relic','item','rare','',0,0],['item_prism','Rainbow Prism','item','rare','',0,0],
['item_wings','Nebula Wings','item','epic','',0,0],['item_crown_epic','Storm Crown','item','epic','',0,0],['item_portal','Pocket Portal','item','epic','',0,0],['item_phoenix','Phoenix Heart','item','epic','',0,0],['item_moon','Moonstone','item','epic','',0,0],
['item_dragon_king','Dragon King Relic','item','legendary','',0,0],['item_time','Time Crystal','item','legendary','',0,0],['item_sun','Sun Core','item','legendary','',0,0],['item_celestial','Celestial Crown','item','legendary','',0,0],['item_felix','Felix Trophy','item','legendary','',0,0]
]) try{await db.execute({sql:'INSERT OR IGNORE INTO collectibles(id,name,type,rarity,value,staff_only,mod_grantable,created_at) VALUES(?,?,?,?,?,?,?,?)',args:[...x,now()]})}catch(e){}


  // @felixchat automatically owns every collectible/tag. The DEVELOPER tag is exclusive.
  try {
    const owner=await db.execute({sql:`SELECT uid FROM users WHERE lower(username)='felixchat' LIMIT 1`,args:[]});
    if(owner.rows[0]) {
      const all=await db.execute({sql:`SELECT id FROM collectibles`,args:[]});
      for(const item of all.rows) await db.execute({sql:`INSERT OR IGNORE INTO user_collectibles(uid,collectible_id,granted_by,created_at) VALUES(?,?,?,?)`,args:[owner.rows[0].uid,item.id,owner.rows[0].uid,now()]});
    }
  } catch(e){}

}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function getUser(uid) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE uid=?', args: [uid] });
  return r.rows[0] || null;
}
async function getUidFromToken(token) {
  if (!token) return null;
  const r = await db.execute({ sql: 'SELECT uid FROM sessions WHERE token=?', args: [token] });
  return r.rows[0]?.uid || null;
}
async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const uid = await getUidFromToken(token);
    if (!uid) return res.status(401).json({ error: 'Not logged in' });
    const user = await getUser(uid);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (Number(user.banned || 0) === 1) return res.status(403).json({ error: 'This account has been banned.' });
    req.uid = uid;
    await db.execute({ sql: 'UPDATE users SET last_seen=? WHERE uid=?', args: [now(), uid] });
    next();
  } catch (e) { res.status(500).json({ error: 'Database error' }); }
}
async function areFriends(a, b) {
  const r = await db.execute({ sql: `SELECT 1 FROM friendships WHERE user_id=? AND friend_id=? AND status='accepted'`, args: [a, b] });
  return r.rows.length > 0;
}
async function blocked(a, b) {
  const r = await db.execute({ sql: 'SELECT 1 FROM blocks WHERE uid=? AND blocked_uid=?', args: [a, b] });
  return r.rows.length > 0;
}
function broadcast(uid, payload) {
  const set = sockets.get(uid);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function pair(a,b,payload){ broadcast(a,payload); broadcast(b,payload); }
function broadcastAll(payload, excludeUid=null) {
  const data=JSON.stringify(payload);
  for(const [targetUid,set] of sockets){
    if(excludeUid && targetUid===excludeUid) continue;
    for(const ws of set) if(ws.readyState===WebSocket.OPEN) ws.send(data);
  }
}

function broadcastPresence(uid, online){
  broadcastAll({type:'presence_update',uid:String(uid),online:!!online,lastSeen:Date.now()});
}


async function equippedTagsFor(uid){
  try{
    const r=await db.execute({sql:`SELECT c.id,c.name,c.rarity,c.value FROM equipped_tags e JOIN collectibles c ON c.id=e.collectible_id WHERE e.uid=? ORDER BY e.position LIMIT 5`,args:[uid]});
    return r.rows||[];
  }catch(_){ return []; }
}

function publicUser(u, online=false){
  return { uid:u.uid, username:u.username, displayName:u.display_name || u.username, bio:u.bio || '', avatar:u.avatar || '', banner:u.banner || '', statusText:u.status_text || '', role:u.role || 'member', verified:Number(u.verified||0)===1, online, lastSeen:u.last_seen || 0, streak:u.streak || 0, timeoutUntil:Number(u.timeout_until||0), timeoutBy:u.timeout_by || '' };
}

app.get('/api/health', async (_req,res)=>res.json({ok:true, database:process.env.TURSO_DATABASE_URL?'turso':'local'}));
app.get('/api/cloudinary-config', auth, async (_req,res)=>{
  const cloudName=String(process.env.CLOUDINARY_CLOUD_NAME||'').trim();
  const uploadPreset=String(process.env.CLOUDINARY_UPLOAD_PRESET||'').trim();
  if(!cloudName||!uploadPreset) return res.status(503).json({error:'Cloudinary is not configured on the server.'});
  res.json({cloudName,uploadPreset});
});

const DISPOSABLE_DOMAINS=new Set(['10minutemail.com','10minutemail.net','guerrillamail.com','guerrillamail.info','mailinator.com','tempmail.com','temp-mail.org','throwawaymail.com','yopmail.com','getnada.com','dispostable.com']);
function isDisposableEmail(email){ const domain=String(email).toLowerCase().split('@').pop(); return DISPOSABLE_DOMAINS.has(domain); }

async function sendPasswordResetEmail(email, code){
  const key=String(process.env.RESEND_API_KEY||'').trim();
  const from=String(process.env.FROM_EMAIL||'Felix Chat <onboarding@resend.dev>').trim();
  if(!key) throw new Error('Email sending is not configured.');
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({from,to:[email],subject:'Your Felix Chat password reset code',html:`<h2>Reset your Felix Chat password</h2><p>Your 6-digit reset code is:</p><h1 style="letter-spacing:6px">${code}</h1><p>This code expires in 10 minutes.</p>`})});
  if(!r.ok) throw new Error('Could not send reset email.');
}

async function sendVerificationEmail(email, code){
  const key=String(process.env.RESEND_API_KEY||'').trim();
  const from=String(process.env.FROM_EMAIL||'Felix Chat <onboarding@resend.dev>').trim();
  if(!key) throw new Error('Email sending is not configured. Add RESEND_API_KEY and FROM_EMAIL in Render.');
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({from,to:[email],subject:'Your Felix Chat verification code',html:`<h2>Verify your Felix Chat account</h2><p>Your verification code is:</p><h1 style="letter-spacing:6px">${code}</h1><p>This code expires in 10 minutes.</p>`})});
  if(!r.ok){const txt=await r.text();throw new Error('Email provider error: '+txt.slice(0,160));}
}

app.post('/api/register', async (req,res)=>{
  try {
    if(!checkRegistrationRate(req)) return res.status(429).json({error:'Too many signup attempts. Please try again later.'});
    // Refuse registration if the database/server is unavailable, preventing partial accounts.
    await db.execute('SELECT 1');
    const username=clean(req.body.username).toLowerCase();
    const email=String(req.body.email||'').trim().toLowerCase();
    const password=String(req.body.password||'');
    if(!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({error:'Username must be 3-20 letters, numbers or _'});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) return res.status(400).json({error:'Enter a valid email address'});
    if(isDisposableEmail(email)) return res.status(400).json({error:'Temporary or disposable email addresses are not allowed.'});
    if(password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
    const exists=await db.execute({sql:'SELECT uid FROM users WHERE username=? OR lower(email)=?',args:[username,email]});
    if(exists.rows.length) return res.status(409).json({error:'Username or email is already linked to an account'});
    const pending=await db.execute({sql:'SELECT email FROM email_verifications WHERE username=? AND expires_at>?',args:[username,now()]});
    if(pending.rows.length) return res.status(409).json({error:'That username is waiting for email verification'});
    const salt=id(), code=String(Math.floor(100000+Math.random()*900000));
    const expires=now()+10*60*1000;
    await db.execute({sql:`INSERT INTO email_verifications(email,username,password_hash,salt,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(email) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,salt=excluded.salt,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at`,args:[email,username,hash(password,salt),salt,hash(code,email),expires,now()]});
    await sendVerificationEmail(email,code);
    res.json({ok:true,needsVerification:true,email});
  } catch(e){console.error(e);res.status(500).json({error:e.message||'Could not send verification code'});}
});

app.post('/api/verify-email', async (req,res)=>{
  try{
    const email=String(req.body.email||'').trim().toLowerCase(), code=String(req.body.code||'').trim();
    const r=await db.execute({sql:'SELECT * FROM email_verifications WHERE email=?',args:[email]}); const v=r.rows[0];
    if(!v) return res.status(404).json({error:'No verification request found. Sign up again.'});
    if(Number(v.expires_at)<now()){await db.execute({sql:'DELETE FROM email_verifications WHERE email=?',args:[email]});return res.status(400).json({error:'That code expired. Please request a new one.'});}
    if(Number(v.attempts)>=8) return res.status(429).json({error:'Too many incorrect attempts. Request a new code.'});
    if(hash(code,email)!==v.code_hash){await db.execute({sql:'UPDATE email_verifications SET attempts=attempts+1 WHERE email=?',args:[email]});return res.status(400).json({error:'Incorrect verification code'});}
    const exists=await db.execute({sql:'SELECT uid FROM users WHERE username=? OR lower(email)=?',args:[v.username,email]}); if(exists.rows.length)return res.status(409).json({error:'That username or email is already in use'});
    const uid=id(), token=id(), t=now();
    await db.batch([{sql:'INSERT INTO users(uid,username,email,password_hash,salt,display_name,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',args:[uid,v.username,email,v.password_hash,v.salt,v.username,t,t]},{sql:'INSERT INTO sessions(token,uid,created_at) VALUES(?,?,?)',args:[token,uid,t]},{sql:'DELETE FROM email_verifications WHERE email=?',args:[email]}]);
    res.json({ok:true,token,username:v.username});
  }catch(e){console.error(e);res.status(500).json({error:'Verification failed'});}
});

app.post('/api/resend-verification', async (req,res)=>{
  try{const email=String(req.body.email||'').trim().toLowerCase();const r=await db.execute({sql:'SELECT * FROM email_verifications WHERE email=?',args:[email]});const v=r.rows[0];if(!v)return res.status(404).json({error:'No pending verification found'});const code=String(Math.floor(100000+Math.random()*900000));await db.execute({sql:'UPDATE email_verifications SET code_hash=?,expires_at=?,attempts=0 WHERE email=?',args:[hash(code,email),now()+10*60*1000,email]});await sendVerificationEmail(email,code);res.json({ok:true});}catch(e){console.error(e);res.status(500).json({error:e.message||'Could not resend code'});}
});

app.post('/api/forgot-password', async (req,res)=>{try{const email=String(req.body.email||'').trim().toLowerCase();const r=await db.execute({sql:"SELECT email FROM users WHERE lower(COALESCE(email,''))=? LIMIT 1",args:[email]});if(!r.rows[0])return res.status(404).json({error:'No account was found with that email.'});const code=String(Math.floor(100000+Math.random()*900000));await db.execute({sql:'INSERT INTO password_resets(email,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at',args:[email,hash(code,email),now()+10*60*1000,0,now()]});await sendPasswordResetEmail(email,code);res.json({ok:true});}catch(e){console.error(e);res.status(500).json({error:e.message||'Could not send reset code'});}});
app.post('/api/reset-password', async (req,res)=>{try{const email=String(req.body.email||'').trim().toLowerCase(),code=String(req.body.code||'').trim(),password=String(req.body.password||'');if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters.'});const r=await db.execute({sql:'SELECT * FROM password_resets WHERE email=?',args:[email]}),v=r.rows[0];if(!v)return res.status(404).json({error:'No reset request found.'});if(Number(v.expires_at)<now())return res.status(400).json({error:'That code expired. Request a new one.'});if(Number(v.attempts)>=8)return res.status(429).json({error:'Too many incorrect attempts.'});if(hash(code,email)!==v.code_hash){await db.execute({sql:'UPDATE password_resets SET attempts=attempts+1 WHERE email=?',args:[email]});return res.status(400).json({error:'Incorrect reset code.'});}const u=(await db.execute({sql:"SELECT uid FROM users WHERE lower(COALESCE(email,''))=? LIMIT 1",args:[email]})).rows[0];const salt=crypto.randomBytes(16).toString('hex');await db.batch([{sql:'UPDATE users SET salt=?,password_hash=? WHERE uid=?',args:[salt,hash(password,salt),u.uid]},{sql:'DELETE FROM password_resets WHERE email=?',args:[email]},{sql:'DELETE FROM sessions WHERE uid=?',args:[u.uid]}]);res.json({ok:true});}catch(e){console.error(e);res.status(500).json({error:'Password reset failed'});}});

app.post('/api/login', async (req,res)=>{
  try {
    const identifier=String(req.body.username||req.body.email||req.body.identifier||'').trim().toLowerCase();
    const password=String(req.body.password||'');
    const r=await db.execute({sql:`SELECT * FROM users WHERE username=? OR lower(COALESCE(email,''))=? LIMIT 1`,args:[identifier,identifier]});
    const u=r.rows[0];
    if(!u || u.password_hash!==hash(password,u.salt)) return res.status(401).json({error:'Wrong username/email or password'});
    if(Number(u.banned || 0) === 1) return res.status(403).json({error:'This account has been banned.'});
    const token=id(); await db.execute({sql:'INSERT INTO sessions(token,uid,created_at) VALUES(?,?,?)',args:[token,u.uid,now()]});
    await db.execute({sql:'UPDATE users SET last_seen=? WHERE uid=?',args:[now(),u.uid]});
    res.json({token,username:u.username});
  } catch(e){console.error(e);res.status(500).json({error:'Login failed'});}
});

app.post('/api/logout',auth,async(req,res)=>{const token=req.headers.authorization?.replace(/^Bearer\s+/i,'');await db.execute({sql:'DELETE FROM sessions WHERE token=?',args:[token]});res.json({ok:true});});

app.get('/api/me',auth,async(req,res)=>{
  const u=await getUser(req.uid);
  const fr=await db.execute({sql:`SELECT u.* FROM users u JOIN friendships f ON f.friend_id=u.uid WHERE f.user_id=? AND f.status='accepted' ORDER BY u.username`,args:[req.uid]});
  const incoming=await db.execute({sql:`SELECT u.uid,u.username,u.display_name,u.avatar FROM users u JOIN friendships f ON f.user_id=u.uid WHERE f.friend_id=? AND f.status='pending'`,args:[req.uid]});
  const friends=[]; for(const x of fr.rows){ const f=publicUser(x,(sockets.get(x.uid)?.size||0)>0); f.equippedTags=await equippedTagsFor(x.uid); const sr=await db.execute({sql:'SELECT streak,last_day FROM friend_streaks WHERE pair_key=?',args:[pairKey(req.uid,x.uid)]}); const srRow=sr.rows[0]; let sv=Number(srRow?.streak||0); if(srRow?.last_day){const diff=Math.round((Date.now()-new Date(srRow.last_day+'T00:00:00Z').getTime())/86400000); if(diff>1){sv=0; await db.execute({sql:'UPDATE friend_streaks SET streak=0 WHERE pair_key=?',args:[pairKey(req.uid,x.uid)]});}} f.streak=sv; f.streakLastDay=srRow?.last_day||''; friends.push(f); }
  res.json({uid:u.uid,username:u.username,displayName:u.display_name||u.username,bio:u.bio||'',avatar:u.avatar||'',role:u.role||'member',streak:u.streak||0,timeoutUntil:Number(u.timeout_until||0),timeoutBy:u.timeout_by||'',friends,requests:incoming.rows.map(x=>publicUser(x))});
});

const upload=multer({storage:multer.diskStorage({destination:(_r,_f,cb)=>cb(null,UPLOADS),filename:(_r,file,cb)=>cb(null,id()+path.extname(file.originalname||'').toLowerCase().slice(0,10))}),limits:{fileSize:50*1024*1024}});

app.patch('/api/profile',auth,async(req,res)=>{
  const display=clean(req.body.displayName||'').slice(0,40),bio=String(req.body.bio||'').slice(0,300),statusText=String(req.body.statusText||'').slice(0,80),banner=String(req.body.banner||'').trim();
  if(banner && !/^https:\/\/res\.cloudinary\.com\//i.test(banner)) return res.status(400).json({error:'Banner must be a Cloudinary URL'});
  const hasAvatar=Object.prototype.hasOwnProperty.call(req.body,'avatar');
  if(hasAvatar){const avatar=String(req.body.avatar||'').slice(0,1200000);await db.execute({sql:'UPDATE users SET display_name=?, bio=?, avatar=?, status_text=?, banner=? WHERE uid=?',args:[display||null,bio,avatar,statusText,banner,req.uid]});}
  else await db.execute({sql:'UPDATE users SET display_name=?, bio=?, status_text=?, banner=? WHERE uid=?',args:[display||null,bio,statusText,banner,req.uid]});
  res.json(publicUser(await getUser(req.uid),(sockets.get(req.uid)?.size||0)>0));
});

// Profile pictures are stored as permanent Cloudinary URLs in Turso.
app.get('/api/quick-add',auth,async(req,res)=>{
  try{
    const r=await db.execute({sql:`
      SELECT u.* FROM users u
      WHERE u.uid<>?
        AND COALESCE(u.banned,0)=0
        AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_id=? AND f.friend_id=u.uid AND f.status IN ('accepted','pending'))
        AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_id=u.uid AND f.friend_id=? AND f.status IN ('accepted','pending'))
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.uid=? AND b.blocked_uid=u.uid)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.uid=u.uid AND b.blocked_uid=?)
      ORDER BY RANDOM() LIMIT 10`,args:[req.uid,req.uid,req.uid,req.uid,req.uid]});
    res.json(r.rows.map(u=>publicUser(u,(sockets.get(u.uid)?.size||0)>0)));
  }catch(e){console.error('quick-add',e);res.status(500).json({error:'Could not load Quick Add users'});}
});

app.get('/api/users/:uid',auth,async(req,res)=>{
  const u=await getUser(req.params.uid);
  if(!u)return res.status(404).json({error:'User not found'});
  const isSelf=u.uid===req.uid;
  if(!isSelf && !(await areFriends(req.uid,u.uid)))return res.status(403).json({error:'You can only view profiles of friends.'});
  res.json(publicUser(u,(sockets.get(u.uid)?.size||0)>0));
});

app.get('/api/users/search',auth,async(req,res)=>{
  const q=String(req.query.q||'').trim().toLowerCase();
  const r=await db.execute({sql:`SELECT * FROM users WHERE lower(username) LIKE ? OR lower(COALESCE(display_name,'')) LIKE ? ORDER BY username LIMIT 30`,args:[`%${q}%`,`%${q}%`]});
  const out=[]; for(const u of r.rows){ if(u.uid===req.uid) continue; if(await blocked(req.uid,u.uid)||await blocked(u.uid,req.uid)) continue; out.push(publicUser(u,(sockets.get(u.uid)?.size||0)>0)); } res.json(out);
});
app.post('/api/account/change-password',auth,async(req,res)=>{const current=String(req.body.currentPassword||''), next=String(req.body.newPassword||'');if(next.length<6)return res.status(400).json({error:'New password must be at least 6 characters.'});const u=await getUser(req.uid);if(!u||hash(current,u.salt)!==u.password_hash)return res.status(400).json({error:'Current password is incorrect.'});const salt=crypto.randomBytes(16).toString('hex');await db.execute({sql:'UPDATE users SET salt=?,password_hash=? WHERE uid=?',args:[salt,hash(next,salt),req.uid]});res.json({ok:true});});
app.post('/api/account/logout-other-sessions',auth,async(req,res)=>{const current=req.headers.authorization?.replace(/^Bearer\s+/i,'');await db.execute({sql:'DELETE FROM sessions WHERE uid=? AND token<>?',args:[req.uid,current]});res.json({ok:true});});

app.post('/api/profile/avatar',auth,async(req,res)=>{
  try{
    const avatar=String(req.body?.avatar||'').trim().slice(0,2000);
    if(!/^https:\/\/res\.cloudinary\.com\//i.test(avatar)) return res.status(400).json({error:'Invalid Cloudinary image URL'});
    await db.execute({sql:'UPDATE users SET avatar=? WHERE uid=?',args:[avatar,req.uid]});
    res.json({ok:true,avatar});
  }catch(e){console.error(e);res.status(500).json({error:'Profile picture upload failed'});}
});

app.get('/api/friends',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT u.* FROM friendships f JOIN users u ON u.uid=f.friend_id WHERE f.user_id=? AND f.status='accepted' ORDER BY lower(u.username)`,args:[req.uid]});
  const out=[]; for(const u of r.rows){const f=publicUser(u,(sockets.get(u.uid)?.size||0)>0); f.equippedTags=await equippedTagsFor(u.uid); out.push(f);}
  res.json(out);
});

app.post('/api/friends/request',auth,async(req,res)=>{
  const username=clean(req.body.username).toLowerCase(); const r=await db.execute({sql:'SELECT * FROM users WHERE username=?',args:[username]}); const target=r.rows[0];
  if(!target)return res.status(404).json({error:'User not found'}); if(target.uid===req.uid)return res.status(400).json({error:"You can't add yourself"}); if(await blocked(req.uid,target.uid)||await blocked(target.uid,req.uid))return res.status(403).json({error:'Friend request unavailable'});
  const f=await db.execute({sql:'SELECT status FROM friendships WHERE user_id=? AND friend_id=?',args:[req.uid,target.uid]}); if(f.rows[0]?.status==='accepted')return res.json({ok:true,message:'Already friends'});
  await db.batch([
    {sql:`INSERT INTO friendships(user_id,friend_id,status,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,friend_id) DO UPDATE SET status='pending'`,args:[req.uid,target.uid,'pending',now()]},
    {sql:`INSERT INTO friendships(user_id,friend_id,status,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,friend_id) DO NOTHING`,args:[target.uid,req.uid,'none',now()]}
  ]); broadcast(target.uid,{type:'friend_request',from:(await getUser(req.uid)).username,uid:req.uid});res.json({ok:true});
});

app.post('/api/friends/accept',auth,async(req,res)=>{const other=req.body.uid; if(!await getUser(other))return res.status(404).json({error:'User not found'}); await db.batch([{sql:`UPDATE friendships SET status='accepted' WHERE user_id=? AND friend_id=?`,args:[other,req.uid]},{sql:`UPDATE friendships SET status='accepted' WHERE user_id=? AND friend_id=?`,args:[req.uid,other]}]); pair(req.uid,other,{type:'friend_accepted'});res.json({ok:true});});
app.post('/api/friends/decline',auth,async(req,res)=>{await db.execute({sql:`UPDATE friendships SET status='declined' WHERE user_id=? AND friend_id=?`,args:[req.body.uid,req.uid]});res.json({ok:true});});
app.delete('/api/friends/:uid',auth,async(req,res)=>{await db.batch([{sql:'DELETE FROM friendships WHERE user_id=? AND friend_id=?',args:[req.uid,req.params.uid]},{sql:'DELETE FROM friendships WHERE user_id=? AND friend_id=?',args:[req.params.uid,req.uid]}]);res.json({ok:true});});
app.post('/api/block/:uid',auth,async(req,res)=>{await db.execute({sql:'INSERT OR IGNORE INTO blocks(uid,blocked_uid,created_at) VALUES(?,?,?)',args:[req.uid,req.params.uid,now()]});res.json({ok:true});});
app.delete('/api/block/:uid',auth,async(req,res)=>{await db.execute({sql:'DELETE FROM blocks WHERE uid=? AND blocked_uid=?',args:[req.uid,req.params.uid]});res.json({ok:true});});

function messageRow(x){return {id:x.id,from:x.sender_id,to:x.receiver_id,text:x.text||'',kind:x.kind,url:x.url||'',name:x.name||'',mime:x.mime||'',time:x.created_at,readAt:x.read_at,expiresAt:x.expires_at,replyTo:x.reply_to,edited:!!x.edited};}

// Developer / moderator fun commands. These are visual-only effects and are
// permission-checked server-side. No account/data changes are performed.
app.post('/api/dev-command',auth,async(req,res)=>{
  try{
    const actor=await getUser(req.uid);
    const role=String(actor?.role||'member').toLowerCase();
    const command=String(req.body?.command||'').trim().toLowerCase();
    const targetUid=String(req.body?.targetUid||'').trim();
    if(!actor || !['admin','mod'].includes(role)) return res.status(403).json({error:'Developer or moderator access required'});
    const isOwner = String(actor.username||'').toLowerCase()==='felixchat';
    if(role==='admin' && !isOwner) return res.status(403).json({error:'Only @felixchat can use developer commands'});
    if(!targetUid || targetUid===req.uid) return res.status(400).json({error:'Choose another user'});
    const target=await getUser(targetUid);
    if(!target) return res.status(404).json({error:'User not found'});
    if(target.username==='felixchat') return res.status(403).json({error:'The developer account cannot be targeted'});
    const modCommands=new Set(['shake','rainbow','jumpy','fakeban','fakepromoteadmin']);
    const devCommands=new Set(['shake','rainbow','spin','confetti','big','invert','troll','fakeDisconnect','upsideDown','jumpy','clown','chaos','fakeban','fakepromoteadmin']);
    if(role==='mod' && !modCommands.has(command)) return res.status(403).json({error:'That command is developer-only'});
    if(role==='admin' && !devCommands.has(command)) return res.status(400).json({error:'Unknown developer command'});
    if(command==='fakepromoteadmin'){
      broadcast(target.uid,{type:'dev_private_notice',title:'You’ve been promoted to Admin',text:'Your new role is now active.',fake:true,at:Date.now()});
      return res.json({ok:true,effect:command,target:target.username});
    }
    if(command==='fakeban'){
      broadcast(target.uid,{type:'dev_fakeban',duration:30,from:actor.username,at:Date.now()});
      return res.json({ok:true,effect:command,target:target.username});
    }
    const payload={type:'dev_effect',effect:command,from:actor.username,fromRole:role,at:Date.now()};
    broadcast(target.uid,payload);
    res.json({ok:true,effect:command,target:target.username});
  }catch(e){console.error(e);res.status(500).json({error:'Command failed'});}
});

app.get('/api/streaks',auth,async(req,res)=>{
  const r=await db.execute({sql:'SELECT * FROM friend_streaks WHERE user_a=? OR user_b=? ORDER BY streak DESC',args:[req.uid,req.uid]});
  const out=[]; for(const x of r.rows){ const other=x.user_a===req.uid?x.user_b:x.user_a; const u=await getUser(other); if(u) out.push({uid:other,username:u.username,streak:Number(x.streak||0),lastDay:x.last_day}); }
  res.json(out);
});
app.post('/api/dev/streak-restore',auth,async(req,res)=>{
  const actor=await getUser(req.uid); if(String(actor?.username||'').toLowerCase()!=='felixchat') return res.status(403).json({error:'Developer access required'});
  const target=await getUser(String(req.body.targetUid||'')); if(!target) return res.status(404).json({error:'User not found'});
  if(!await areFriends(req.uid,target.uid)) return res.status(400).json({error:'You can only restore a streak for a friend of the developer account'});
  const key=pairKey(req.uid,target.uid), r=await db.execute({sql:'SELECT * FROM friend_streaks WHERE pair_key=?',args:[key]});
  if(r.rows[0]) await db.execute({sql:'UPDATE friend_streaks SET streak=?,last_day=? WHERE pair_key=?',args:[Math.max(1,Number(req.body.streak||r.rows[0].streak||1)),utcDay(),key]});
  else await db.execute({sql:'INSERT INTO friend_streaks(pair_key,user_a,user_b,streak,last_day) VALUES(?,?,?,?,?)',args:[key,...[req.uid,target.uid].sort(),Math.max(1,Number(req.body.streak||1)),utcDay()]});
  const value=await db.execute({sql:'SELECT * FROM friend_streaks WHERE pair_key=?',args:[key]});
  pair(req.uid,target.uid,{type:'streak_update',streak:Number(value.rows[0].streak||1),lastDay:value.rows[0].last_day});
  res.json({ok:true,streak:Number(value.rows[0].streak||1)});
});
async function getSystemStatus(){
  try { const r=await db.execute({sql:'SELECT value FROM system_status WHERE key=?',args:['maintenance']}); return r.rows[0]?.value||''; } catch(e){ return ''; }
}
async function setSystemStatus(value){
  await db.execute({sql:'INSERT INTO system_status(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',args:['maintenance',value||'']});
}
app.get('/api/admin/system-status',auth,async(req,res)=>{
  const actor=await getUser(req.uid);
  if(String(actor?.username||'').toLowerCase()!=='felixchat' || String(actor?.role||'').toLowerCase()!=='admin') return res.status(403).json({error:'Admin access required'});
  res.json({status:await getSystemStatus()});
});
app.post('/api/admin/system-status',auth,async(req,res)=>{
  const actor=await getUser(req.uid);
  if(String(actor?.username||'').toLowerCase()!=='felixchat' || String(actor?.role||'').toLowerCase()!=='admin') return res.status(403).json({error:'Admin access required'});
  const value=['down','updating',''].includes(String(req.body?.status||'')) ? String(req.body?.status||'') : '';
  await setSystemStatus(value);
  for(const uid of sockets.keys()){
    if(String(uid)===String(req.uid)) continue;
    broadcast(uid,{type:'system_status',status:value});
  }
  res.json({ok:true,status:value});
});

app.post('/api/dev/poll',auth,async(req,res)=>{
  const actor=await getUser(req.uid); if(String(actor?.username||'').toLowerCase()!=='felixchat') return res.status(403).json({error:'Developer access required'});
  const question=String(req.body.question||'').trim().slice(0,200);
  const options=Array.isArray(req.body.options)?req.body.options.map(x=>String(x).trim().slice(0,80)).filter(Boolean).slice(0,8):[];
  if(!question||options.length<2) return res.status(400).json({error:'Poll needs a question and at least 2 options'});
  const poll={id:id(),question,options,createdAt:now(),expiresAt:now()+86400000,creator:actor.username};
  await db.execute({sql:'INSERT INTO polls(id,creator_id,question,options_json,created_at,expires_at) VALUES(?,?,?,?,?,?)',args:[poll.id,req.uid,poll.question,JSON.stringify(poll.options),poll.createdAt,poll.expiresAt]});
  for(const uid of sockets.keys()){ try { const seen=await db.execute({sql:'SELECT 1 FROM poll_views WHERE poll_id=? AND uid=?',args:[poll.id,uid]}); if(seen.rows[0]) continue; await db.execute({sql:'INSERT INTO poll_views(poll_id,uid,viewed_at) VALUES(?,?,?)',args:[poll.id,uid,now()]}); broadcast(uid,{type:'poll_new',poll}); } catch(e) {} }
  res.json({ok:true,poll});
});
app.get('/api/polls/active',auth,async(req,res)=>{
  const r=await db.execute({sql:'SELECT * FROM polls WHERE expires_at>? ORDER BY created_at DESC LIMIT 20',args:[now()]});
  const out=[]; for(const x of r.rows){ const seen=await db.execute({sql:'SELECT 1 FROM poll_views WHERE poll_id=? AND uid=?',args:[x.id,req.uid]}); if(seen.rows[0]) continue; await db.execute({sql:'INSERT INTO poll_views(poll_id,uid,viewed_at) VALUES(?,?,?)',args:[x.id,req.uid,now()]}); const v=await db.execute({sql:'SELECT option_index,COUNT(*) count FROM poll_votes WHERE poll_id=? GROUP BY option_index',args:[x.id]}); const mine=await db.execute({sql:'SELECT option_index FROM poll_votes WHERE poll_id=? AND uid=?',args:[x.id,req.uid]}); out.push({id:x.id,question:x.question,options:JSON.parse(x.options_json||'[]'),createdAt:x.created_at,expiresAt:x.expires_at,votes:Object.fromEntries(v.rows.map(z=>[z.option_index,Number(z.count)])),myVote:mine.rows[0]?.option_index??null});} res.json(out);
});
app.post('/api/polls/:id/vote',auth,async(req,res)=>{
  const idx=Number(req.body.optionIndex); const p=await db.execute({sql:'SELECT * FROM polls WHERE id=? AND expires_at>?',args:[req.params.id,now()]}); if(!p.rows[0]) return res.status(404).json({error:'Poll not found'});
  const opts=JSON.parse(p.rows[0].options_json||'[]'); if(!Number.isInteger(idx)||idx<0||idx>=opts.length)return res.status(400).json({error:'Invalid option'});
  await db.execute({sql:'INSERT INTO poll_votes(poll_id,uid,option_index,voted_at) VALUES(?,?,?,?) ON CONFLICT(poll_id,uid) DO UPDATE SET option_index=excluded.option_index,voted_at=excluded.voted_at',args:[req.params.id,req.uid,idx,now()]});
  const v=await db.execute({sql:'SELECT option_index,COUNT(*) count FROM poll_votes WHERE poll_id=? GROUP BY option_index',args:[req.params.id]}); const payload={type:'poll_update',pollId:req.params.id,votes:Object.fromEntries(v.rows.map(z=>[z.option_index,Number(z.count)])),myVote:idx};
  for(const uid of sockets.keys()) broadcast(uid,payload); res.json(payload);
});

app.get('/api/messages/:uid',auth,async(req,res)=>{if(!await areFriends(req.uid,req.params.uid))return res.status(403).json({error:'Not friends'});const r=await db.execute({sql:`SELECT * FROM messages WHERE chat_key=? AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at`,args:[chatKey(req.uid,req.params.uid),now()]});const out=[];for(const row of r.rows){const m=messageRow(row);const rr=await db.execute({sql:'SELECT uid,emoji FROM reactions WHERE message_id=? ORDER BY created_at',args:[m.id]});m.reactions=rr.rows;out.push(m)}res.json(out);});
app.post('/api/messages/:uid',auth,async(req,res)=>{
  const sender=await getUser(req.uid);if(Number(sender?.timeout_until||0)>now())return res.status(403).json({error:'You are currently timed out.'}); const other=req.params.uid;if(!await areFriends(req.uid,other))return res.status(403).json({error:'Not friends'});if(await blocked(req.uid,other)||await blocked(other,req.uid))return res.status(403).json({error:'Messaging unavailable'});
  const text=String(req.body.text||'').trim().slice(0,4000);if(!text)return res.status(400).json({error:'Empty message'});
  const m={id:id(),from:req.uid,to:other,text,kind:'text',url:'',name:'',mime:'',time:now(),readAt:null,expiresAt:req.body.disappearing?now()+86400000:null,replyTo:req.body.replyTo||null,edited:false};
  await db.execute({sql:`INSERT INTO messages(id,chat_key,sender_id,receiver_id,text,kind,created_at,expires_at,reply_to) VALUES(?,?,?,?,?,?,?,?,?)`,args:[m.id,chatKey(req.uid,other),req.uid,other,m.text,'text',m.time,m.expiresAt,m.replyTo]});
  broadcast(other,{type:'message',message:m});
  sendPush(other,{title:'Felix Chat',body:(sender?.display_name||sender?.username||'Someone')+': '+text,url:'/',tag:'chat-'+req.uid}).catch(()=>{});
  const streak=await touchFriendStreak(req.uid,other);
  if(streak) pair(req.uid,other,{type:'streak_update',streak:streak.streak,lastDay:streak.lastDay,formed:streak.formed});
  res.json(m);
});
app.patch('/api/messages/:uid/:messageId',auth,async(req,res)=>{const text=String(req.body.text||'').trim().slice(0,4000);const r=await db.execute({sql:'SELECT * FROM messages WHERE id=? AND sender_id=?',args:[req.params.messageId,req.uid]});if(!r.rows[0])return res.status(404).json({error:'Message not found'});await db.execute({sql:'UPDATE messages SET text=?, edited=1 WHERE id=?',args:[text,req.params.messageId]});const m=messageRow({...r.rows[0],text,edited:1});pair(req.uid,r.rows[0].receiver_id,{type:'message_edited',message:m});res.json(m);});
app.post('/api/messages/:uid/:messageId/read',auth,async(req,res)=>{await db.execute({sql:'UPDATE messages SET read_at=? WHERE id=? AND receiver_id=?',args:[now(),req.params.messageId,req.uid]});const r=await db.execute({sql:'SELECT sender_id FROM messages WHERE id=?',args:[req.params.messageId]});if(r.rows[0])broadcast(r.rows[0].sender_id,{type:'message_read',messageId:req.params.messageId,at:now()});res.json({ok:true});});
app.post('/api/messages/:uid/:messageId/react',auth,async(req,res)=>{const emoji=String(req.body.emoji||'❤️').slice(0,8);await db.execute({sql:'INSERT INTO reactions(message_id,uid,emoji,created_at) VALUES(?,?,?,?) ON CONFLICT(message_id,uid) DO UPDATE SET emoji=excluded.emoji,created_at=excluded.created_at',args:[req.params.messageId,req.uid,emoji,now()]});const r=await db.execute({sql:'SELECT * FROM reactions WHERE message_id=?',args:[req.params.messageId]});const mr=await db.execute({sql:'SELECT sender_id,receiver_id FROM messages WHERE id=?',args:[req.params.messageId]});if(mr.rows[0])pair(mr.rows[0].sender_id,mr.rows[0].receiver_id,{type:'reaction',messageId:req.params.messageId,reactions:r.rows});res.json(r.rows);});
app.get('/api/messages/:uid/pinned',auth,async(req,res)=>{if(!await areFriends(req.uid,req.params.uid))return res.status(403).json({error:'Not friends'});const r=await db.execute({sql:`SELECT p.*,m.text,m.kind,m.url,m.name,m.mime,m.sender_id,m.receiver_id,m.created_at FROM pinned_messages p JOIN messages m ON m.id=p.message_id WHERE p.chat_key=? ORDER BY p.pinned_at DESC`,args:[chatKey(req.uid,req.params.uid)]});res.json(r.rows.map(x=>({...messageRow(x),pinnedAt:x.pinned_at,pinnedBy:x.pinned_by})));});
app.post('/api/messages/:uid/:messageId/pin',auth,async(req,res)=>{if(!await areFriends(req.uid,req.params.uid))return res.status(403).json({error:'Not friends'});const r=await db.execute({sql:'SELECT id FROM messages WHERE id=? AND chat_key=?',args:[req.params.messageId,chatKey(req.uid,req.params.uid)]});if(!r.rows[0])return res.status(404).json({error:'Message not found'});await db.execute({sql:'INSERT OR REPLACE INTO pinned_messages(message_id,chat_key,pinned_by,pinned_at) VALUES(?,?,?,?)',args:[req.params.messageId,chatKey(req.uid,req.params.uid),req.uid,now()]});res.json({ok:true});});
app.delete('/api/messages/:uid/:messageId/pin',auth,async(req,res)=>{await db.execute({sql:'DELETE FROM pinned_messages WHERE message_id=? AND chat_key=?',args:[req.params.messageId,chatKey(req.uid,req.params.uid)]});res.json({ok:true});});
app.delete('/api/messages/:uid/:messageId',auth,async(req,res)=>{const r=await db.execute({sql:'SELECT * FROM messages WHERE id=? AND sender_id=?',args:[req.params.messageId,req.uid]});if(!r.rows[0])return res.status(404).json({error:'Message not found'});await db.execute({sql:'DELETE FROM messages WHERE id=?',args:[req.params.messageId]});pair(req.uid,r.rows[0].receiver_id,{type:'message_deleted',messageId:req.params.messageId});if(r.rows[0].url?.startsWith('/uploads/'))fs.unlink(path.join(UPLOADS,path.basename(r.rows[0].url)),()=>{});res.json({ok:true});});


app.post('/api/upload/:uid',auth,async(req,res)=>{const other=req.params.uid;if(!await areFriends(req.uid,other))return res.status(403).json({error:'Not friends'});const url=String(req.body?.url||'').trim();if(!/^https:\/\/res\.cloudinary\.com\//i.test(url))return res.status(400).json({error:'Cloudinary media URL required'});const mime=String(req.body?.mime||'application/octet-stream');const kind=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'voice':'file';const m={id:id(),from:req.uid,to:other,text:'',kind,url,name:String(req.body?.name||'file').slice(0,120),mime,time:now(),readAt:null,expiresAt:null,replyTo:null,edited:false};await db.execute({sql:`INSERT INTO messages(id,chat_key,sender_id,receiver_id,text,kind,url,name,mime,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[m.id,chatKey(req.uid,other),req.uid,other,'',kind,m.url,m.name,mime,m.time]});broadcast(other,{type:'message',message:m});const u=await getUser(req.uid);sendPush(other,{title:'Felix Chat',body:(u?.display_name||u?.username||'Someone')+' sent you media',url:'/',tag:'chat-'+req.uid}).catch(()=>{});res.json(m);});

app.post('/api/typing/:uid',auth,async(req,res)=>{broadcast(req.params.uid,{type:'typing',uid:req.uid,typing:!!req.body.typing});res.json({ok:true});});
app.post('/api/screenshot/:uid',auth,async(req,res)=>{const other=req.params.uid;if(!await areFriends(req.uid,other))return res.status(403).json({error:'Not friends'});const u=await getUser(req.uid);broadcast(other,{type:'screenshot_taken',from:u?.username||'Someone',context:String(req.body?.context||'chat').slice(0,20)});res.json({ok:true});});

// Snapchat-style 24-hour stories.
app.get('/api/stories',auth,async(req,res)=>{const f=await db.execute({sql:`SELECT u.* FROM users u JOIN friendships f ON f.friend_id=u.uid WHERE f.user_id=? AND f.status='accepted'`,args:[req.uid]});const ids=[req.uid,...f.rows.map(x=>x.uid)];const placeholders=ids.map(()=>'?').join(',');const r=await db.execute({sql:`SELECT s.*,u.username,u.display_name,u.avatar,(SELECT COUNT(*) FROM story_views v WHERE v.story_id=s.id) AS views,EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.uid=?) AS seen FROM stories s JOIN users u ON u.uid=s.uid WHERE s.uid IN (${placeholders}) AND s.expires_at>? ORDER BY s.created_at DESC`,args:[req.uid,...ids,now()]});res.json(r.rows.map(x=>({id:x.id,uid:x.uid,username:x.username,displayName:x.display_name||x.username,avatar:x.avatar||'',url:x.media_url,kind:x.kind,caption:x.caption,time:x.created_at,expiresAt:x.expires_at,views:Number(x.views||0),seen:Boolean(x.seen)})));});
app.get('/api/stories/mine',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT s.*,(SELECT COUNT(*) FROM story_views v WHERE v.story_id=s.id) AS views FROM stories s WHERE s.uid=? AND s.expires_at>? ORDER BY s.created_at DESC`,args:[req.uid,now()]});
  const out=[];
  for(const s of r.rows){
    const vr=await db.execute({sql:`SELECT v.uid,v.viewed_at,u.username,u.display_name,u.avatar FROM story_views v JOIN users u ON u.uid=v.uid WHERE v.story_id=? ORDER BY v.viewed_at DESC`,args:[s.id]});
    out.push({id:s.id,uid:s.uid,url:s.media_url,kind:s.kind,caption:s.caption||'',time:s.created_at,expiresAt:s.expires_at,views:Number(s.views||0),viewers:vr.rows.map(v=>({uid:v.uid,username:v.username,displayName:v.display_name||v.username,avatar:v.avatar||'',viewedAt:v.viewed_at}))});
  }
  res.json(out);
});
app.post('/api/stories',auth,async(req,res)=>{const url=String(req.body?.url||'').trim();if(!/^https:\/\/res\.cloudinary\.com\//i.test(url))return res.status(400).json({error:'Cloudinary story URL required'});const mime=String(req.body?.mime||'image/*');const kind=mime.startsWith('video/')?'video':'image';const story={id:id(),uid:req.uid,url,kind,caption:String(req.body?.caption||'').slice(0,180),time:now(),expiresAt:now()+86400000};await db.execute({sql:'INSERT INTO stories(id,uid,media_url,kind,caption,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',args:[story.id,story.uid,story.url,story.kind,story.caption,story.time,story.expiresAt]});broadcast(req.uid,{type:'story_added',story});res.json(story);});
app.post('/api/stories/:id/view',auth,async(req,res)=>{await db.execute({sql:'INSERT OR REPLACE INTO story_views(story_id,uid,viewed_at) VALUES(?,?,?)',args:[req.params.id,req.uid,now()]});res.json({ok:true});});
app.delete('/api/stories/:id',auth,async(req,res)=>{const r=await db.execute({sql:'SELECT * FROM stories WHERE id=? AND uid=?',args:[req.params.id,req.uid]});if(!r.rows[0])return res.status(404).json({error:'Story not found'});await db.execute({sql:'DELETE FROM stories WHERE id=?',args:[req.params.id]});if(r.rows[0].media_url.startsWith('/uploads/'))fs.unlink(path.join(UPLOADS,path.basename(r.rows[0].media_url)),()=>{});res.json({ok:true});});

// Moderation and roles.
// Only @felixchat can grant/revoke roles. Moderators can ban/unban users,
// but can never grant powers or moderate the @felixchat account.
async function getRole(uid){
  const u=await getUser(uid);
  return String(u?.role||'member').toLowerCase();
}
async function requireAdmin(req,res){
  const u=await getUser(req.uid);
  if(!u || u.username!=='felixchat' || String(u.role||'')!=='admin'){
    res.status(403).json({error:'Admin access required'}); return false;
  }
  return true;
}
async function requireModerator(req,res){
  const u=await getUser(req.uid);
  const role=String(u?.role||'member').toLowerCase();
  if(!u || !['admin','mod'].includes(role)){
    res.status(403).json({error:'Moderator access required'}); return false;
  }
  return true;
}
app.post('/api/admin/soundboard',auth,async(req,res)=>{
  try{
    const u=await getUser(req.uid);
    if(String(u?.username||'').toLowerCase()!=='felixchat' || String(u?.role||'').toLowerCase()!=='admin')
      return res.status(403).json({error:'Only @felixchat can use the soundboard.'});
    const sound=String(req.body?.sound||'');
    if(!['verity','german','anime'].includes(sound)) return res.status(400).json({error:'Unknown sound.'});
    broadcastAll({type:'admin_sound',sound},req.uid);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:'Could not broadcast sound.'});}
});

app.get('/api/admin/status',auth,async(req,res)=>{
  const u=await getUser(req.uid);
  res.json({admin:u?.username==='felixchat' && String(u.role||'')==='admin', moderator:['admin','mod'].includes(String(u?.role||'').toLowerCase()), role:u?.role||'member'});
});
app.get('/api/admin/users',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const q=clean(req.query.q||'').toLowerCase();
  const r=await db.execute({sql:`SELECT uid,username,display_name,bio,avatar,role,verified,banned,timeout_until,timeout_by,created_at,last_seen FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT 100`,args:[`%${q}%`,`%${q}%`]});
  const users=[]; for(const u of r.rows){ const tr=await db.execute({sql:`SELECT c.id,c.name,c.type,c.rarity,c.value,c.mod_grantable FROM user_collectibles uc JOIN collectibles c ON c.id=uc.collectible_id WHERE uc.uid=? AND c.type='tag' ORDER BY uc.created_at`,args:[u.uid]}); users.push({uid:u.uid,username:u.username,displayName:u.display_name||u.username,bio:u.bio||'',avatar:u.avatar||'',role:u.role||'member',verified:Number(u.verified||0)===1,banned:Number(u.banned||0)===1,timeoutUntil:Number(u.timeout_until||0),timeoutBy:u.timeout_by||'',createdAt:u.created_at,lastSeen:u.last_seen,tags:tr.rows}); } res.json(users);
});

app.get('/api/admin/tags/catalog',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const actor=await getUser(req.uid); const role=String(actor?.role||'member').toLowerCase();
  const q=role==='mod' ? `SELECT id,name,type,rarity,value,mod_grantable FROM collectibles WHERE type='tag' AND mod_grantable=1 ORDER BY created_at` : `SELECT id,name,type,rarity,value,mod_grantable FROM collectibles WHERE type='tag' ORDER BY created_at`;
  const r=await db.execute({sql:q,args:[]}); res.json(r.rows);
});
app.post('/api/admin/tags/:uid',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const target=await getUser(req.params.uid); if(!target)return res.status(404).json({error:'User not found'});
  const actor=await getUser(req.uid); const role=String(actor?.role||'member').toLowerCase(); const id=String(req.body.collectibleId||'');
  const r=await db.execute({sql:`SELECT * FROM collectibles WHERE id=? AND type='tag'`,args:[id]}); const tag=r.rows[0]; if(!tag)return res.status(404).json({error:'Tag not found'});
  if(role==='mod' && Number(tag.mod_grantable||0)!==1)return res.status(403).json({error:'Mods can only grant approved smaller tags'});
  await db.execute({sql:`INSERT OR IGNORE INTO user_collectibles(uid,collectible_id,granted_by,created_at) VALUES(?,?,?,?)`,args:[target.uid,id,actor.uid,now()]});
  res.json({ok:true});
});
app.delete('/api/admin/tags/:uid/:tagId',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const actor=await getUser(req.uid); const role=String(actor?.role||'member').toLowerCase();
  const r=await db.execute({sql:`SELECT * FROM collectibles WHERE id=? AND type='tag'`,args:[req.params.tagId]}); const tag=r.rows[0]; if(!tag)return res.status(404).json({error:'Tag not found'});
  if(role==='mod' && Number(tag.mod_grantable||0)!==1)return res.status(403).json({error:'Mods can only remove approved smaller tags'});
  await db.execute({sql:`DELETE FROM user_collectibles WHERE uid=? AND collectible_id=?`,args:[req.params.uid,req.params.tagId]}); res.json({ok:true});
});


const QUESTS=[
{id:'first_chat',name:'First Steps',description:'Send 10 messages',goal:10,reward:'tag_comet',kind:'messages'},
{id:'social',name:'Social Butterfly',description:'Send 50 messages',goal:50,reward:'tag_lucky',kind:'messages'},
{id:'story',name:'Story Maker',description:'Post 1 story',goal:1,reward:'item_neonfish',kind:'stories'},
{id:'collector',name:'Collector',description:'Own 5 collectibles',goal:5,reward:'item_crystal',kind:'collectibles'},
{id:'legend_path',name:'Legend Path',description:'Send 200 messages',goal:200,reward:'tag_nova',kind:'messages'}
];
async function questProgress(uid,q){
 let sql=q.kind==='messages'?'SELECT COUNT(*) c FROM messages WHERE sender_id=?':q.kind==='stories'?'SELECT COUNT(*) c FROM stories WHERE uid=?':'SELECT COUNT(*) c FROM user_collectibles WHERE uid=?';
 const r=await db.execute({sql,args:[uid]}); return Number(r.rows[0]?.c||0);
}
app.get('/api/quests',auth,async(req,res)=>{const out=[];for(const q of QUESTS){const progress=await questProgress(req.uid,q);const c=await db.execute({sql:'SELECT 1 FROM quest_claims WHERE uid=? AND quest_id=?',args:[req.uid,q.id]});out.push({...q,progress,claimed:!!c.rows[0]})}res.json(out)});
app.post('/api/quests/:id/claim',auth,async(req,res)=>{const q=QUESTS.find(x=>x.id===req.params.id);if(!q)return res.status(404).json({error:'Quest not found'});const progress=await questProgress(req.uid,q);if(progress<q.goal)return res.status(400).json({error:'Quest not complete'});const old=await db.execute({sql:'SELECT 1 FROM quest_claims WHERE uid=? AND quest_id=?',args:[req.uid,q.id]});if(old.rows[0])return res.status(400).json({error:'Already claimed'});await db.batch([{sql:'INSERT INTO quest_claims(uid,quest_id,claimed_at) VALUES(?,?,?)',args:[req.uid,q.id,now()]},{sql:'INSERT OR IGNORE INTO user_collectibles(uid,collectible_id,granted_by,created_at) VALUES(?,?,?,?)',args:[req.uid,q.reward,'quest',now()]}]);res.json({ok:true,reward:q.reward})});
app.post('/api/admin/grant-collectible',auth,async(req,res)=>{if(!await requireAdmin(req,res))return;const ids=Array.isArray(req.body.uids)?req.body.uids:[];const cid=String(req.body.collectibleId||'');const c=await db.execute({sql:'SELECT id FROM collectibles WHERE id=?',args:[cid]});if(!c.rows[0])return res.status(404).json({error:'Item not found'});for(const uid of ids){await db.execute({sql:'INSERT OR IGNORE INTO user_collectibles(uid,collectible_id,granted_by,created_at) VALUES(?,?,?,?)',args:[uid,cid,req.uid,now()]});broadcast(uid,{type:'collectible_granted',collectibleId:cid})}res.json({ok:true,count:ids.length})});

app.post('/api/admin/ban/:uid',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const target=await getUser(req.params.uid);
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'The FelixChat admin account cannot be banned.'});
  await db.batch([{sql:'UPDATE users SET banned=1,banned_at=?,banned_by=? WHERE uid=?',args:[now(),req.uid,req.params.uid]},{sql:'DELETE FROM sessions WHERE uid=?',args:[req.params.uid]}]);
  broadcast(req.params.uid,{type:'banned'});
  res.json({ok:true});
});
app.post('/api/admin/unban/:uid',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const target=await getUser(req.params.uid);
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'The FelixChat admin account cannot be changed.'});
  await db.execute({sql:'UPDATE users SET banned=0,banned_at=NULL,banned_by=NULL WHERE uid=?',args:[req.params.uid]});
  res.json({ok:true});
});
app.post('/api/admin/role/:uid',auth,async(req,res)=>{
  if(!await requireAdmin(req,res))return;
  const target=await getUser(req.params.uid);
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'The FelixChat admin account always remains admin.'});
  const role=String(req.body.role||'member').toLowerCase();
  if(!['member','vip','mod'].includes(role))return res.status(400).json({error:'Role must be member, vip, or mod.'});
  const oldRole=String(target.role||'member').toLowerCase();
  await db.execute({sql:'UPDATE users SET role=? WHERE uid=?',args:[role,req.params.uid]});
  broadcast(req.params.uid,{type:'role_changed',role,oldRole});
  res.json({ok:true,role,oldRole});
});
app.post('/api/admin/verified/:uid',auth,async(req,res)=>{
  if(!await requireAdmin(req,res))return;
  const target=await getUser(req.params.uid);
  if(!target)return res.status(404).json({error:'User not found'});
  const verified=!!req.body?.verified;
  const oldVerified=Number(target.verified||0)===1;
  await db.execute({sql:'UPDATE users SET verified=? WHERE uid=?',args:[verified?1:0,req.params.uid]});
  broadcast(req.params.uid,{type:'verified_changed',verified,oldVerified});
  res.json({ok:true,verified,oldVerified});
});
app.post('/api/admin/timeout/:uid',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const target=await getUser(req.params.uid); const actor=await getUser(req.uid);
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'You cannot timeout the FelixChat admin account.'});
  const days=Math.max(0,Math.floor(Number(req.body.days)||0));
  const hours=Math.max(0,Math.floor(Number(req.body.hours)||0));
  const minutes=Math.max(0,Math.floor(Number(req.body.minutes)||0));
  const duration=(days*86400+hours*3600+minutes*60)*1000;
  if(duration<=0)return res.status(400).json({error:'Choose a timeout duration.'});
  const until=now()+duration; const by=actor?.username||'Moderator';
  await db.execute({sql:'UPDATE users SET timeout_until=?,timeout_by=? WHERE uid=?',args:[until,by,target.uid]});
  broadcast(target.uid,{type:'timeout',until,by,role:String(actor?.role||'mod').toLowerCase()});
  res.json({ok:true,until,by});
});
app.post('/api/admin/untimeout/:uid',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const target=await getUser(req.params.uid); if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'You cannot change the FelixChat admin account.'});
  await db.execute({sql:"UPDATE users SET timeout_until=0,timeout_by='' WHERE uid=?",args:[target.uid]});
  broadcast(target.uid,{type:'timeout_ended'}); res.json({ok:true});
});
app.post('/api/admin/command',auth,async(req,res)=>{
  const isMod=await getRole(req.uid);
  if(!['admin','mod'].includes(isMod))return res.status(403).json({error:'Moderator access required'});
  const command=String(req.body.command||'').trim().toLowerCase();
  const username=clean(req.body.username||'').toLowerCase();
  if(!['ban','unban'].includes(command))return res.status(400).json({error:'Use /ban username or /unban username'});
  const r=await db.execute({sql:'SELECT uid,username FROM users WHERE username=?',args:[username]});
  const target=r.rows[0];
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'You cannot moderate the FelixChat admin account.'});
  if(command==='ban'){
    await db.batch([{sql:'UPDATE users SET banned=1,banned_at=?,banned_by=? WHERE uid=?',args:[now(),req.uid,target.uid]},{sql:'DELETE FROM sessions WHERE uid=?',args:[target.uid]}]);
    broadcast(target.uid,{type:'banned'});
    return res.json({ok:true,action:'ban',username:target.username});
  }
  await db.execute({sql:'UPDATE users SET banned=0,banned_at=NULL,banned_by=NULL WHERE uid=?',args:[target.uid]});
  res.json({ok:true,action:'unban',username:target.username});
});


// Group chat features.
async function groupMember(gid,uid){const r=await db.execute({sql:'SELECT 1 FROM group_members WHERE gid=? AND uid=?',args:[gid,uid]});return r.rows.length>0;}
async function broadcastGroup(gid,payload){const r=await db.execute({sql:'SELECT uid FROM group_members WHERE gid=?',args:[gid]});for(const x of r.rows)broadcast(x.uid,payload);}
app.get('/api/groups/:gid/messages',auth,async(req,res)=>{if(!await groupMember(req.params.gid,req.uid))return res.status(403).json({error:'Not a group member'});const r=await db.execute({sql:'SELECT m.*,u.username,u.display_name,u.avatar FROM group_messages m JOIN users u ON u.uid=m.sender_id WHERE m.gid=? ORDER BY m.created_at LIMIT 1000',args:[req.params.gid]});res.json(r.rows.map(x=>({id:x.id,gid:x.gid,from:x.sender_id,text:x.text||'',kind:x.kind||'text',url:x.url||'',name:x.name||'',mime:x.mime||'',time:x.created_at,edited:!!x.edited,senderUsername:x.username,senderDisplayName:x.display_name||x.username,avatar:x.avatar||''})));});
app.post('/api/groups/:gid/messages',auth,async(req,res)=>{const timed=await getUser(req.uid);if(Number(timed?.timeout_until||0)>now())return res.status(403).json({error:'You are currently timed out.'});const gid=req.params.gid;if(!await groupMember(gid,req.uid))return res.status(403).json({error:'Not a group member'});const text=String(req.body.text||'').trim().slice(0,4000);if(!text)return res.status(400).json({error:'Empty message'});const m={id:id(),gid,from:req.uid,text,kind:'text',url:'',name:'',mime:'',time:now(),edited:false};await db.execute({sql:'INSERT INTO group_messages(id,gid,sender_id,text,kind,created_at) VALUES(?,?,?,?,?,?)',args:[m.id,gid,req.uid,text,'text',m.time]});await broadcastGroup(gid,{type:'group_message',message:m});const senderName=(await getUser(req.uid))?.display_name||(await getUser(req.uid))?.username||'Someone';const members=await db.execute({sql:'SELECT uid FROM group_members WHERE gid=? AND uid<>?',args:[gid,req.uid]});const gr=await db.execute({sql:'SELECT name FROM groups WHERE gid=?',args:[gid]});for(const row of members.rows)sendPush(row.uid,{title:gr.rows[0]?.name||'Felix Chat',body:senderName+': '+text,url:'/',tag:'group-'+gid}).catch(()=>{});res.json(m);});
app.post('/api/groups/:gid/members/remove',auth,async(req,res)=>{const gid=req.params.gid,other=req.body.uid;const g=await db.execute({sql:'SELECT owner_id FROM groups WHERE gid=?',args:[gid]});if(!g.rows[0]||g.rows[0].owner_id!==req.uid)return res.status(403).json({error:'Only the group owner can remove members'});await db.execute({sql:'DELETE FROM group_members WHERE gid=? AND uid=?',args:[gid,other]});res.json({ok:true});});

// Announcements: owners and moderators can send a full-screen announcement
// either to everybody or to a selected list of accounts.
app.get('/api/announcements/recent',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT a.*,u.username AS sender_username,u.display_name AS sender_display_name FROM announcements a JOIN users u ON u.uid=a.sender_id ORDER BY a.created_at DESC LIMIT 20`,args:[]});
  const out=[];
  for(const a of r.rows){
    let targets=[];try{targets=JSON.parse(a.targets_json||'[]');}catch{}
    if(a.audience==='all'||targets.includes(req.uid)){
      const seen=await db.execute({sql:'SELECT 1 FROM announcement_views WHERE announcement_id=? AND uid=?',args:[a.id,req.uid]});
      if(!seen.rows.length) out.push({id:a.id,text:a.text||'',kind:a.kind||'text',url:a.url||'',name:a.name||'',mime:a.mime||'',time:a.created_at,senderUsername:a.sender_username,senderDisplayName:a.sender_display_name||a.sender_username});
    }
  }
  res.json(out.slice(0,3));
});

app.get('/api/announcement/users',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const q=clean(req.query.q||'').toLowerCase();
  const r=await db.execute({sql:`SELECT uid,username,display_name,avatar,role FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT 100`,args:[`%${q}%`,`%${q}%`]});
  res.json(r.rows.map(u=>({uid:u.uid,username:u.username,displayName:u.display_name||u.username,avatar:u.avatar||'',role:u.role||'member'})));
});
app.post('/api/announcements',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  try{
    const text=String(req.body?.text||'').trim().slice(0,5000);
    const targetMode=String(req.body?.targetMode||'all').toLowerCase();
    let targets=[];
    if(targetMode==='selected'){
      try{targets=JSON.parse(String(req.body?.targets||'[]'));}catch{targets=[];}
      targets=[...new Set(targets.map(x=>String(x)).filter(Boolean))];
      if(!targets.length)return res.status(400).json({error:'Select at least one person.'});
    }else if(targetMode!=='all')return res.status(400).json({error:'Invalid announcement audience.'});
    const url=String(req.body?.url||'').trim();
    const mime=String(req.body?.mime||'');
    const name=String(req.body?.name||'announcement').slice(0,120);
    if(!text&&!url)return res.status(400).json({error:'Add text or attach an image, video, or audio file.'});
    if(url&&!/^https:\/\/res\.cloudinary\.com\//i.test(url))return res.status(400).json({error:'Invalid Cloudinary media URL'});
    let kind='text';
    if(url)kind=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'file';
    const a={id:id(),senderId:req.uid,text,kind,url,name,mime,time:now()};
    await db.execute({sql:'INSERT INTO announcements(id,sender_id,text,kind,url,name,mime,audience,targets_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',args:[a.id,a.senderId,a.text,a.kind,a.url,a.name,a.mime,targetMode,JSON.stringify(targets),a.time]});
    const sender=await getUser(req.uid);
    const payload={type:'announcement',announcement:{...a,senderUsername:sender?.username||'Moderator',senderDisplayName:sender?.display_name||sender?.username||'Moderator'}};
    if(targetMode==='all'){for(const [uid] of sockets)broadcast(uid,payload);}else{const valid=await db.execute({sql:`SELECT uid FROM users WHERE uid IN (${targets.map(()=>'?').join(',')})`,args:targets});for(const row of valid.rows)broadcast(row.uid,payload);}
    res.json({ok:true,announcement:a,targetMode,targetCount:targetMode==='all'?null:targets.length});
  }catch(e){console.error(e);res.status(500).json({error:'Announcement failed'});}
});

app.get('/api/push/public-key',auth,(req,res)=>res.json({publicKey:process.env.VAPID_PUBLIC_KEY||''}));
app.post('/api/push/subscribe',auth,async(req,res)=>{const sub=req.body?.subscription||{};if(!sub.endpoint||!sub.keys?.p256dh||!sub.keys?.auth)return res.status(400).json({error:'Invalid push subscription'});await db.execute({sql:'INSERT INTO push_subscriptions(endpoint,uid,p256dh,auth,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET uid=excluded.uid,p256dh=excluded.p256dh,auth=excluded.auth,created_at=excluded.created_at',args:[sub.endpoint,req.uid,sub.keys.p256dh,sub.keys.auth,now()]});res.json({ok:true});});
app.get('/api/notifications/unread',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT m.id,m.sender_id,m.text,m.kind,m.created_at,u.username,u.display_name FROM messages m JOIN users u ON u.uid=m.sender_id WHERE m.receiver_id=? AND m.read_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY m.created_at DESC LIMIT 50`,args:[req.uid,now()]});
  res.json(r.rows.map(m=>({id:m.id,uid:m.sender_id,username:m.username,displayName:m.display_name||m.username,text:m.text||'',kind:m.kind,time:m.created_at})));
});

// Group chat backend: membership is the source of truth. A user can only see groups
// they belong to, and adding a member creates a realtime + persistent notification.
async function notifyGroupAdded(uid,gid,name){
  const n={id:id(),uid,gid,groupName:name,createdAt:now()};
  await db.execute({sql:'INSERT INTO group_notifications(id,uid,gid,group_name,created_at) VALUES(?,?,?,?,?)',args:[n.id,uid,gid,name,n.createdAt]});
  broadcast(uid,{type:'group_added',notification:n});
}
app.post('/api/groups',auth,async(req,res)=>{
  try{
    const name=String(req.body.name||'New Group').trim().slice(0,40)||'New Group';
    let memberIds=Array.isArray(req.body.memberIds)?req.body.memberIds.map(x=>String(x)).filter(Boolean):[];
    memberIds=[...new Set(memberIds)].filter(x=>x!==req.uid);
    // Only accepted friends may be added to a group.
    for(const uid of memberIds){ if(!await areFriends(req.uid,uid)) return res.status(403).json({error:'You can only add your friends to a group.'}); }
    const gid=id(), created=now();
    const ops=[
      {sql:'INSERT INTO groups(gid,name,owner_id,created_at) VALUES(?,?,?,?)',args:[gid,name,req.uid,created]},
      {sql:'INSERT INTO group_members(gid,uid,joined_at) VALUES(?,?,?)',args:[gid,req.uid,created]}
    ];
    for(const uid of memberIds)ops.push({sql:'INSERT INTO group_members(gid,uid,joined_at) VALUES(?,?,?)',args:[gid,uid,created]});
    await db.batch(ops,'write');
    for(const uid of memberIds) await notifyGroupAdded(uid,gid,name);
    res.json({gid,name,owner_id:req.uid,members:[req.uid,...memberIds]});
  }catch(e){console.error(e);res.status(500).json({error:'Could not create group.'});}
});
app.get('/api/groups',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT g.* FROM groups g JOIN group_members m ON m.gid=g.gid WHERE m.uid=? ORDER BY g.created_at DESC`,args:[req.uid]});
  const out=[];
  for(const g of r.rows){
    const m=await db.execute({sql:`SELECT u.uid,u.username,u.display_name,u.avatar FROM users u JOIN group_members gm ON gm.uid=u.uid WHERE gm.gid=?`,args:[g.gid]});
    out.push({...g,members:m.rows.map(u=>publicUser(u,(sockets.get(u.uid)?.size||0)>0))});
  }
  res.json(out);
});
app.get('/api/groups/notifications',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT id,gid,group_name,created_at FROM group_notifications WHERE uid=? AND read_at IS NULL ORDER BY created_at DESC LIMIT 20`,args:[req.uid]});
  res.json(r.rows.map(x=>({id:x.id,gid:x.gid,groupName:x.group_name,createdAt:x.created_at})));
});
app.post('/api/groups/notifications/:id/read',auth,async(req,res)=>{await db.execute({sql:'UPDATE group_notifications SET read_at=? WHERE id=? AND uid=?',args:[now(),req.params.id,req.uid]});res.json({ok:true});});
app.post('/api/groups/:gid/members',auth,async(req,res)=>{
  const gid=req.params.gid,other=String(req.body.uid||'');
  const member=await db.execute({sql:'SELECT 1 FROM group_members WHERE gid=? AND uid=?',args:[gid,req.uid]});
  if(!member.rows.length)return res.status(403).json({error:'Not a group member'});
  const g=await db.execute({sql:'SELECT name FROM groups WHERE gid=?',args:[gid]});
  if(!g.rows[0])return res.status(404).json({error:'Group not found'});
  if(!other||other===req.uid)return res.status(400).json({error:'Invalid member'});
  if(!await areFriends(req.uid,other))return res.status(403).json({error:'You can only add your friends to a group.'});
  const exists=await db.execute({sql:'SELECT 1 FROM group_members WHERE gid=? AND uid=?',args:[gid,other]});
  if(exists.rows.length)return res.json({ok:true,alreadyMember:true});
  await db.execute({sql:'INSERT INTO group_members(gid,uid,joined_at) VALUES(?,?,?)',args:[gid,other,now()]});
  await notifyGroupAdded(other,gid,g.rows[0].name);
  res.json({ok:true});
});
app.post('/api/groups/:gid/members/remove',auth,async(req,res)=>{const gid=req.params.gid,other=req.body.uid;const g=await db.execute({sql:'SELECT owner_id FROM groups WHERE gid=?',args:[gid]});if(!g.rows[0]||g.rows[0].owner_id!==req.uid)return res.status(403).json({error:'Only the group owner can remove members'});await db.execute({sql:'DELETE FROM group_members WHERE gid=? AND uid=?',args:[gid,other]});res.json({ok:true});});
app.delete('/api/groups/:gid/leave',auth,async(req,res)=>{
  const gid=String(req.params.gid||'');
  try{
    const g=await db.execute({sql:'SELECT gid,name,owner_id FROM groups WHERE gid=?',args:[gid]});
    if(!g.rows[0]) return res.status(404).json({error:'Group not found'});
    const member=await db.execute({sql:'SELECT 1 FROM group_members WHERE gid=? AND uid=?',args:[gid,req.uid]});
    if(!member.rows.length)return res.status(403).json({error:'You are not a member of this group'});
    const user=await getUser(req.uid);
    const leavingName=user?.display_name||user?.username||'Someone';
    const t=now(), mid=id();
    // Remove only this user's membership. Never delete the group, its owner, or its history.
    await db.batch([
      {sql:'DELETE FROM group_members WHERE gid=? AND uid=?',args:[gid,req.uid]},
      {sql:'UPDATE group_notifications SET read_at=? WHERE uid=? AND gid=? AND read_at IS NULL',args:[t,req.uid,gid]},
      {sql:'INSERT INTO group_messages(id,gid,sender_id,text,kind,created_at) VALUES(?,?,?,?,?,?)',args:[mid,gid,req.uid,`${leavingName} left the group`, 'system', t]}
    ],'write');
    const systemMessage={id:mid,gid,from:req.uid,text:`${leavingName} left the group`,kind:'system',url:'',name:'',mime:'',time:t,edited:false,senderUsername:user?.username||'',senderDisplayName:leavingName,avatar:user?.avatar||''};
    await broadcastGroup(gid,{type:'group_message',message:systemMessage});
    res.json({ok:true,gid,name:g.rows[0].name,left:true});
  }catch(e){
    console.error('group leave failed',e);
    res.status(500).json({error:'Could not leave group. Please try again.'});
  }
});

wss.on('connection',ws=>{let uid=null;ws.on('message',async raw=>{try{const m=JSON.parse(raw);if(m.type==='auth'){uid=await getUidFromToken(m.token);if(!uid)return ws.close(1008,'Unauthorized');if(!sockets.has(uid))sockets.set(uid,new Set());
        const wasOffline=(sockets.get(uid).size===0);
        sockets.get(uid).add(ws);
        if(wasOffline) broadcastPresence(uid,true);
        ws.send(JSON.stringify({type:'ready'}));
        try { const status=await getSystemStatus(); const authedUser=await getUser(uid); if(status && String(authedUser?.username||'').toLowerCase()!=='felixchat') ws.send(JSON.stringify({type:'system_status',status})); } catch(e) {}
        try{const r=await db.execute({sql:`SELECT a.*,u.username AS sender_username,u.display_name AS sender_display_name FROM announcements a JOIN users u ON u.uid=a.sender_id ORDER BY a.created_at DESC LIMIT 20`,args:[]});for(const a of r.rows){let ts=[];try{ts=JSON.parse(a.targets_json||'[]')}catch{}if(!(a.audience==='all'||ts.includes(uid)))continue;const seen=await db.execute({sql:'SELECT 1 FROM announcement_views WHERE announcement_id=? AND uid=?',args:[a.id,uid]});if(seen.rows.length)continue;const announcement={id:a.id,text:a.text||'',kind:a.kind||'text',url:a.url||'',name:a.name||'',mime:a.mime||'',time:a.created_at,senderUsername:a.sender_username,senderDisplayName:a.sender_display_name||a.sender_username};ws.send(JSON.stringify({type:'announcement',announcement}));await db.execute({sql:'INSERT OR IGNORE INTO announcement_views(announcement_id,uid,viewed_at) VALUES(?,?,?)',args:[a.id,uid,now()]});break;}}catch(e){}
        return;}if(uid&&m.type==='typing'&&m.to)broadcast(m.to,{type:'typing',uid,typing:!!m.typing});
        if(uid&&m.groupCall&&m.gid&&['group_call_invite','group_call_join','group_call_signal','group_call_leave','group_call_end'].includes(m.type)&&await groupMember(m.gid,uid)){
          const members=await db.execute({sql:'SELECT uid FROM group_members WHERE gid=?',args:[m.gid]});
          const grow=await db.execute({sql:'SELECT name FROM groups WHERE gid=?',args:[m.gid]}); const payload={type:m.type,from:uid,fromUsername:(await getUser(uid))?.username||'',gid:m.gid,groupName:grow.rows[0]?.name||'Group',groupCall:true,target:m.target||null,callType:m.callType||'audio',payload:m.payload||null};
          for(const row of members.rows){if(row.uid===uid)continue;if(m.type!=='group_call_join' && m.target && row.uid!==m.target)continue;broadcast(row.uid,payload);}
        }
        if(uid&&m.type==='live_location'&&m.to&&await areFriends(uid,m.to)){
          const p=m.payload||{}; const lat=Number(p.lat),lon=Number(p.lon);
          if(Number.isFinite(lat)&&Number.isFinite(lon)) broadcast(m.to,{type:'live_location',from:uid,payload:{lat,lon,accuracy:Number(p.accuracy)||0,active:p.active!==false,at:Date.now()}});
        }if(uid&&m.type==='group_typing'&&m.gid&&await groupMember(m.gid,uid))await broadcastGroup(m.gid,{type:'group_typing',uid,typing:!!m.typing});if(uid&&['call_invite','call_accept','call_reject','call_signal','call_end'].includes(m.type)&&m.to&&await areFriends(uid,m.to)){broadcast(m.to,{type:m.type,from:uid,payload:m.payload||null,callType:m.callType||'audio'});}}catch(e){}});ws.on('close',async()=>{
  if(!uid)return;
  const set=sockets.get(uid);
  if(!set)return;
  set.delete(ws);
  if(!set.size){
    sockets.delete(uid);
    const seen=Date.now();
    try{await db.execute({sql:'UPDATE users SET last_seen=? WHERE uid=?',args:[seen,uid]});}catch(_){}
    broadcastPresence(uid,false);
  }
});});

setInterval(async()=>{try{await db.execute({sql:'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at<=?',args:[now()]});await db.execute({sql:'DELETE FROM stories WHERE expires_at<=?',args:[now()]});await db.execute({sql:'DELETE FROM polls WHERE expires_at<=?',args:[now()]});}catch(e){}},60000);

init().then(()=>{
// Collectibles, staff-issued tags, polls, themes and chat mini-games.
app.get('/api/collectibles/me', auth, async (req,res)=>{
  const rows=await db.execute({sql:`SELECT c.* FROM user_collectibles uc JOIN collectibles c ON c.id=uc.collectible_id WHERE uc.uid=? ORDER BY uc.created_at DESC`,args:[req.uid]});
  res.json({items:rows.rows});
});
app.get('/api/collectibles', auth, async (req,res)=>{
  const rows=await db.execute(`SELECT id,name,type,rarity,value,staff_only FROM collectibles ORDER BY created_at DESC`);
  res.json({items:rows.rows});
});
app.post('/api/collectibles/:id/grant', auth, async (req,res)=>{
  const actor=await getUser(req.uid), item=(await db.execute({sql:'SELECT * FROM collectibles WHERE id=?',args:[req.params.id]})).rows[0];
  if(!item)return res.status(404).json({error:'Not found'});
  const target=String(req.body.uid||''); const isDev=actor.role==='admin'||actor.role==='developer';
  if(!(isDev || (actor.role==='mod' && Number(item.mod_grantable)===1)))return res.status(403).json({error:'Not allowed'});
  await db.execute({sql:'INSERT OR IGNORE INTO user_collectibles(uid,collectible_id,granted_by,created_at) VALUES(?,?,?,?)',args:[target,item.id,req.uid,now()]});
  res.json({ok:true});
});
app.post('/api/collectibles/:id/revoke', auth, async (req,res)=>{
  const actor=await getUser(req.uid); if(!['admin','developer'].includes(actor.role))return res.status(403).json({error:'Not allowed'});
  await db.execute({sql:'DELETE FROM user_collectibles WHERE uid=? AND collectible_id=?',args:[String(req.body.uid||''),req.params.id]}); res.json({ok:true});
});
app.get('/api/polls', auth, async (req,res)=>{
  const rows=await db.execute({sql:'SELECT * FROM polls WHERE expires_at>? ORDER BY created_at DESC LIMIT 50',args:[now()]}); res.json({polls:rows.rows});
});
app.post('/api/polls', auth, async (req,res)=>{
  const q=String(req.body.question||'').trim().slice(0,160), options=Array.isArray(req.body.options)?req.body.options.map(x=>String(x).trim().slice(0,60)).filter(Boolean).slice(0,8):[];
  if(!q||options.length<2)return res.status(400).json({error:'Need question and 2 options'});
  const pid=id(); await db.execute({sql:'INSERT INTO polls(id,creator_id,question,options_json,created_at,expires_at) VALUES(?,?,?,?,?,?)',args:[pid,req.uid,q,JSON.stringify(options),now(),now()+7*86400000]}); res.json({id:pid});
});
app.post('/api/polls/:id/vote', auth, async(req,res)=>{
  await db.execute({sql:'INSERT OR REPLACE INTO poll_votes(poll_id,uid,option_index,voted_at) VALUES(?,?,?,?)',args:[req.params.id,req.uid,Number(req.body.option),now()]});res.json({ok:true});
});

// Trading: friends can offer tradable collectibles, including tags. Official verification is never an inventory item.
const getTradeInventory = async (req,res)=>{
  const uid=(req.params.uid||req.uid);
  if(uid!==req.uid && !await areFriends(req.uid,uid)) return res.status(403).json({error:'Trade only with friends'});
  const r=await db.execute({sql:`SELECT c.* FROM user_collectibles uc JOIN collectibles c ON c.id=uc.collectible_id WHERE uc.uid=? ORDER BY uc.created_at DESC`,args:[uid]});
  res.json({items:r.rows.filter(x=>x.id!=='verified')});
};
app.get('/api/trades/inventory',auth,getTradeInventory);
app.get('/api/trades/inventory/:uid',auth,getTradeInventory);
app.get('/api/trades',auth,async(req,res)=>{const r=await db.execute({sql:'SELECT * FROM trade_offers WHERE from_uid=? OR to_uid=? ORDER BY created_at DESC LIMIT 100',args:[req.uid,req.uid]});res.json({trades:r.rows});});
app.post('/api/trades',auth,async(req,res)=>{
 const to=String(req.body.toUid||''); if(!to||to===req.uid)return res.status(400).json({error:'Choose a friend'}); if(!await areFriends(req.uid,to))return res.status(403).json({error:'You can only trade with friends'});
 const give=[...new Set(Array.isArray(req.body.give)?req.body.give.map(String):[])].filter(Boolean),want=[...new Set(Array.isArray(req.body.want)?req.body.want.map(String):[])].filter(Boolean);
 if(!give.length&&!want.length)return res.status(400).json({error:'Choose items'});
 for(const cid of give){const own=await db.execute({sql:'SELECT 1 FROM user_collectibles WHERE uid=? AND collectible_id=?',args:[req.uid,cid]});if(!own.rows.length)return res.status(400).json({error:'You do not own '+cid});}
 for(const cid of want){const own=await db.execute({sql:'SELECT 1 FROM user_collectibles WHERE uid=? AND collectible_id=?',args:[to,cid]});if(!own.rows.length)return res.status(400).json({error:'Friend no longer owns '+cid});}
 const tid=id(),t=now();await db.execute({sql:'INSERT INTO trade_offers(id,from_uid,to_uid,give_json,want_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',args:[tid,req.uid,to,JSON.stringify(give),JSON.stringify(want),'pending',t,t]});
 const from=(await getUser(req.uid))?.display_name||(await getUser(req.uid))?.username||'Someone'; broadcast(to,{type:'trade_request',tradeId:tid,from:req.uid,fromName:from}); sendPush(to,{title:'Felix Chat',body:from+' has sent you a trade request!',url:'/',tag:'trade-'+tid}).catch(()=>{});res.json({id:tid,status:'pending'});
});
app.post('/api/trades/:id/decline',auth,async(req,res)=>{const r=await db.execute({sql:'SELECT * FROM trade_offers WHERE id=?',args:[req.params.id]});const tr=r.rows[0];if(!tr||tr.to_uid!==req.uid)return res.status(404).json({error:'Trade not found'});if(tr.status!=='pending')return res.status(400).json({error:'Trade already closed'});await db.execute({sql:'UPDATE trade_offers SET status=?,updated_at=? WHERE id=?',args:['declined',now(),tr.id]});res.json({ok:true});});
app.post('/api/trades/:id/accept',auth,async(req,res)=>{const r=await db.execute({sql:'SELECT * FROM trade_offers WHERE id=?',args:[req.params.id]});const tr=r.rows[0];if(!tr||tr.to_uid!==req.uid)return res.status(404).json({error:'Trade not found'});if(tr.status!=='pending')return res.status(400).json({error:'Trade already closed'});const give=JSON.parse(tr.give_json||'[]'),want=JSON.parse(tr.want_json||'[]');
 for(const cid of give){const q=await db.execute({sql:'SELECT * FROM user_collectibles WHERE uid=? AND collectible_id=?',args:[tr.from_uid,cid]});if(!q.rows.length)return res.status(400).json({error:'Trade changed: sender no longer owns '+cid});}
 for(const cid of want){const q=await db.execute({sql:'SELECT * FROM user_collectibles WHERE uid=? AND collectible_id=?',args:[tr.to_uid,cid]});if(!q.rows.length)return res.status(400).json({error:'Trade changed: requested item unavailable'});}
 for(const cid of give){await db.execute({sql:'DELETE FROM user_collectibles WHERE uid=? AND collectible_id=?',args:[tr.from_uid,cid]});await db.execute({sql:'DELETE FROM equipped_tags WHERE uid=? AND collectible_id=?',args:[tr.from_uid,cid]});await db.execute({sql:'INSERT OR IGNORE INTO user_collectibles(uid,collectible_id,granted_by,created_at) VALUES(?,?,?,?)',args:[tr.to_uid,cid,tr.from_uid,now()]});}
 for(const cid of want){await db.execute({sql:'DELETE FROM user_collectibles WHERE uid=? AND collectible_id=?',args:[tr.to_uid,cid]});await db.execute({sql:'DELETE FROM equipped_tags WHERE uid=? AND collectible_id=?',args:[tr.to_uid,cid]});await db.execute({sql:'INSERT OR IGNORE INTO user_collectibles(uid,collectible_id,granted_by,created_at) VALUES(?,?,?,?)',args:[tr.from_uid,cid,tr.to_uid,now()]});}
 await db.execute({sql:'UPDATE trade_offers SET status=?,updated_at=? WHERE id=?',args:['accepted',now(),tr.id]});res.json({ok:true});
});

app.get('/api/games',auth,async(req,res)=>res.json({games:['Tic Tac Toe','Rock Paper Scissors','Connect 4','Trivia']}));
server.listen(PORT,()=>console.log('Felix Chat running on '+PORT));
}).catch(e=>{console.error('DB init failed',e);process.exit(1);});

// Public collectible inventory + equipped tags
app.get('/api/collectibles/:uid',auth,async(req,res)=>{try{const u=await getUser(req.params.uid);if(!u)return res.status(404).json({error:'User not found'});const isSelf=u.uid===req.uid;if(!isSelf && !(await areFriends(req.uid,u.uid)))return res.status(403).json({error:'Friends only'});const r=await db.execute({sql:`SELECT c.id,c.name,c.type,c.rarity,c.value,c.mod_grantable,uc.created_at FROM user_collectibles uc JOIN collectibles c ON c.id=uc.collectible_id WHERE uc.uid=? ORDER BY uc.created_at DESC`,args:[u.uid]});res.json({items:r.rows});}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/collectibles/me/equipped',auth,async(req,res)=>{try{const r=await db.execute({sql:`SELECT c.id,c.name,c.rarity,c.value FROM equipped_tags e JOIN collectibles c ON c.id=e.collectible_id WHERE e.uid=? ORDER BY e.position LIMIT 5`,args:[req.uid]});res.json({tags:r.rows});}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/collectibles/:uid/equipped',auth,async(req,res)=>{try{const r=await db.execute({sql:`SELECT c.id,c.name,c.rarity,c.value FROM equipped_tags e JOIN collectibles c ON c.id=e.collectible_id WHERE e.uid=? ORDER BY e.position LIMIT 5`,args:[req.params.uid]});res.json({tags:r.rows});}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/collectibles/me/equipped/:tagId',auth,async(req,res)=>{try{const own=await db.execute({sql:`SELECT 1 FROM user_collectibles uc JOIN collectibles c ON c.id=uc.collectible_id WHERE uc.uid=? AND uc.collectible_id=? AND c.type='tag'`,args:[req.uid,req.params.tagId]});if(!own.rows.length)return res.status(400).json({error:'You do not own this tag'});const count=await db.execute({sql:'SELECT COUNT(*) AS n FROM equipped_tags WHERE uid=?',args:[req.uid]});if(Number(count.rows[0].n)>=5)return res.status(400).json({error:'You can only equip 5 tags'});await db.execute({sql:'INSERT OR IGNORE INTO equipped_tags(uid,collectible_id,position) VALUES(?,?,?)',args:[req.uid,req.params.tagId,Date.now()]});res.json({ok:true});}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/collectibles/me/equipped/:tagId',auth,async(req,res)=>{try{await db.execute({sql:'DELETE FROM equipped_tags WHERE uid=? AND collectible_id=?',args:[req.uid,req.params.tagId]});res.json({ok:true});}catch(e){res.status(500).json({error:e.message})}});
