const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "data.json");
const UPLOADS = path.join(__dirname, "public", "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

let db = { users: {}, messages: {} };
try {
  if (fs.existsSync(DATA)) db = JSON.parse(fs.readFileSync(DATA, "utf8"));
} catch {}

const save = () => fs.writeFileSync(DATA, JSON.stringify(db, null, 2));
const id = () => crypto.randomBytes(16).toString("hex");
const clean = s => String(s || "").trim().slice(0, 32);
const hash = (password, salt) => crypto.createHash("sha256").update(salt + ":" + password).digest("hex");
const sockets = new Map();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const uid = Object.keys(db.users).find(x => db.users[x].token === token);
  if (!uid) return res.status(401).json({ error: "Not logged in" });
  req.uid = uid;
  next();
}
function areFriends(a,b){ return !!db.users[a] && !!db.users[b] && db.users[a].friends.includes(b); }
function chatKey(a,b){ return [a,b].sort().join(":"); }
function list(a,b){ return db.messages[chatKey(a,b)] || (db.messages[chatKey(a,b)] = []); }
function broadcast(uid, message){
  const set = sockets.get(uid); if(!set) return;
  const payload = JSON.stringify(message);
  for(const ws of set) if(ws.readyState === WebSocket.OPEN) ws.send(payload);
}
function pair(a,b,message){ broadcast(a,message); broadcast(b,message); }
function saveMessage(a,b,m){ const arr=list(a,b); arr.push(m); db.messages[chatKey(a,b)] = arr.slice(-2000); save(); }

app.post("/api/register", (req,res)=>{
  const username=clean(req.body.username).toLowerCase(), password=String(req.body.password||"");
  if(!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({error:"Username must be 3-20 letters, numbers or _"});
  if(password.length<6) return res.status(400).json({error:"Password must be at least 6 characters"});
  if(Object.values(db.users).some(u=>u.username===username)) return res.status(409).json({error:"Username already exists"});
  const uid=id(),salt=id(),token=id();
  db.users[uid]={username,hash:hash(password,salt),salt,token,friends:[],incoming:[],stories:[]};
  save(); res.json({token,username,uid});
});

app.post("/api/login", (req,res)=>{
  const username=clean(req.body.username).toLowerCase(),password=String(req.body.password||"");
  const entry=Object.entries(db.users).find(([_,u])=>u.username===username);
  if(!entry || entry[1].hash!==hash(password,entry[1].salt)) return res.status(401).json({error:"Wrong username or password"});
  // Keep the existing token when possible. This prevents another device/tab from being logged out.
  if(!entry[1].token) entry[1].token=id();
  save(); res.json({token:entry[1].token,username,uid:entry[0]});
});

app.get("/api/me",auth,(req,res)=>{
  const u=db.users[req.uid];
  res.json({uid:req.uid,username:u.username,
    friends:u.friends.map(fid=>({uid:fid,username:db.users[fid]?.username||"Unknown",online:(sockets.get(fid)?.size||0)>0})),
    requests:(u.incoming||[]).map(x=>({uid:x,username:db.users[x]?.username})).filter(x=>x.username)
  });
});

app.post("/api/friends/request",auth,(req,res)=>{
  const entry=Object.entries(db.users).find(([_,u])=>u.username===clean(req.body.username).toLowerCase());
  if(!entry)return res.status(404).json({error:"User not found"});
  const [targetId,target]=entry,u=db.users[req.uid];
  if(targetId===req.uid)return res.status(400).json({error:"You can't add yourself"});
  if(u.friends.includes(targetId))return res.json({ok:true,message:"Already friends"});
  target.incoming=target.incoming||[];
  if(!target.incoming.includes(req.uid))target.incoming.push(req.uid);
  save(); broadcast(targetId,{type:"friend_request",from:u.username}); res.json({ok:true});
});
app.post("/api/friends/accept",auth,(req,res)=>{
  const otherId=req.body.uid,u=db.users[req.uid],o=db.users[otherId];
  if(!o)return res.status(404).json({error:"User not found"});
  u.incoming=(u.incoming||[]).filter(x=>x!==otherId);
  if(!u.friends.includes(otherId))u.friends.push(otherId); if(!o.friends.includes(req.uid))o.friends.push(req.uid);
  save(); pair(req.uid,otherId,{type:"friend_accepted",username:u.username}); res.json({ok:true});
});
app.post("/api/friends/decline",auth,(req,res)=>{ const u=db.users[req.uid]; u.incoming=(u.incoming||[]).filter(x=>x!==req.body.uid); save(); res.json({ok:true}); });

app.get("/api/messages/:uid",auth,(req,res)=>{
  const other=req.params.uid; if(!areFriends(req.uid,other))return res.status(403).json({error:"Not friends"});
  const after=Number(req.query.after||0); const messages=list(req.uid,other).filter(m=>m.time>after);
  res.json(messages);
});

app.post("/api/messages/:uid",auth,(req,res)=>{
  const other=req.params.uid; if(!areFriends(req.uid,other))return res.status(403).json({error:"Not friends"});
  const text=String(req.body.text||"").trim().slice(0,4000); if(!text)return res.status(400).json({error:"Empty message"});
  const m={id:id(),from:req.uid,text,time:Date.now(),kind:"text",status:"sent"}; saveMessage(req.uid,other,m);
  pair(req.uid,other,{type:"message",message:m}); res.json(m);
});

app.patch("/api/messages/:uid/:messageId",auth,(req,res)=>{
  const other=req.params.uid; if(!areFriends(req.uid,other))return res.status(403).json({error:"Not friends"});
  const m=list(req.uid,other).find(x=>x.id===req.params.messageId); if(!m)return res.status(404).json({error:"Message not found"});
  if(m.from!==req.uid)return res.status(403).json({error:"You can only edit your own messages"});
  if(m.kind!=="text")return res.status(400).json({error:"Only text messages can be edited"});
  const text=String(req.body.text||"").trim().slice(0,4000); if(!text)return res.status(400).json({error:"Empty message"});
  m.text=text;m.edited=true;m.editTime=Date.now();save();pair(req.uid,other,{type:"message_updated",message:m});res.json(m);
});

app.delete("/api/messages/:uid/:messageId",auth,(req,res)=>{
  const other=req.params.uid; if(!areFriends(req.uid,other))return res.status(403).json({error:"Not friends"});
  const arr=list(req.uid,other),i=arr.findIndex(x=>x.id===req.params.messageId); if(i<0)return res.status(404).json({error:"Message not found"});
  const m=arr[i]; if(m.from!==req.uid)return res.status(403).json({error:"You can only delete your own messages"});
  arr.splice(i,1);save();pair(req.uid,other,{type:"message_deleted",messageId:m.id});
  if(m.url?.startsWith("/uploads/"))fs.unlink(path.join(UPLOADS,path.basename(m.url)),()=>{});
  res.json({ok:true,messageId:m.id});
});

app.post("/api/messages/:uid/react",auth,(req,res)=>{
  const other=req.params.uid;if(!areFriends(req.uid,other))return res.status(403).json({error:"Not friends"});
  const m=list(req.uid,other).find(x=>x.id===req.body.messageId);if(!m)return res.status(404).json({error:"Message not found"});
  const emoji=String(req.body.emoji||"").slice(0,8);if(!emoji)return res.status(400).json({error:"Emoji required"});
  m.reactions=m.reactions||{};m.reactions[req.uid]=m.reactions[req.uid]===emoji?null:emoji;if(!m.reactions[req.uid])delete m.reactions[req.uid];save();pair(req.uid,other,{type:"message_updated",message:m});res.json(m);
});

app.post("/api/read/:uid",auth,(req,res)=>{
  const other=req.params.uid;if(!areFriends(req.uid,other))return res.status(403).json({error:"Not friends"});
  const upTo=Number(req.body.upTo||Date.now()); const arr=list(req.uid,other);
  arr.forEach(m=>{if(m.from===other&&m.time<=upTo)m.seenBy=m.seenBy||[],m.seenBy.includes(req.uid)||m.seenBy.push(req.uid);}); save();
  pair(req.uid,other,{type:"read",uid:req.uid,upTo});res.json({ok:true});
});

app.get("/api/stories",auth,(req,res)=>{
  const ids=[req.uid,...db.users[req.uid].friends];
  const now=Date.now();
  const out=[];
  for(const uid of ids){
    const u=db.users[uid];
    for(const story of (u?.stories||[])){ if(now-story.time<24*60*60*1000) out.push({uid,username:u.username,text:story.text,time:story.time}); }
  }
  out.sort((a,b)=>b.time-a.time);
  res.json(out);
});
app.post("/api/stories",auth,(req,res)=>{
  const text=String(req.body.text||"").trim().slice(0,500);
  if(!text)return res.status(400).json({error:"Story is empty"});
  const u=db.users[req.uid]; u.stories=u.stories||[];
  u.stories.push({id:id(),text,time:Date.now()});
  u.stories=u.stories.filter(s=>Date.now()-s.time<24*60*60*1000).slice(-20); save();
  for(const fid of u.friends) broadcast(fid,{type:"story",username:u.username});
  res.json({ok:true});
});

const upload=multer({storage:multer.diskStorage({destination:(_r,_f,cb)=>cb(null,UPLOADS),filename:(_r,f,cb)=>cb(null,id()+path.extname(f.originalname||"").toLowerCase().slice(0,10))}),limits:{fileSize:50*1024*1024}});
app.post("/api/upload/:uid",auth,upload.single("file"),(req,res)=>{
  const other=req.params.uid;if(!areFriends(req.uid,other)){if(req.file)fs.unlink(req.file.path,()=>{});return res.status(403).json({error:"Not friends"});}
  if(!req.file)return res.status(400).json({error:"No file"});
  const mime=req.file.mimetype||"application/octet-stream";
  const kind=mime.startsWith("image/")?"image":mime.startsWith("video/")?"video":mime.startsWith("audio/")?"voice":"file";
  const m={id:id(),from:req.uid,time:Date.now(),kind,url:"/uploads/"+path.basename(req.file.path),name:String(req.file.originalname||"file").slice(0,120),mime,status:"sent"};
  saveMessage(req.uid,other,m);pair(req.uid,other,{type:"message",message:m});res.json(m);
});

// Typing / live presence events never touch the database.
app.post("/api/presence/:uid",auth,(req,res)=>{const other=req.params.uid;if(areFriends(req.uid,other))broadcast(other,{type:"presence",uid:req.uid,typing:!!req.body.typing});res.json({ok:true});});

const server=http.createServer(app);const wss=new WebSocket.Server({server,path:"/ws"});
wss.on("connection",ws=>{
  let uid=null;
  ws.on("message",raw=>{try{const m=JSON.parse(raw);if(m.type!=="auth")return;uid=Object.keys(db.users).find(x=>db.users[x].token===m.token);if(!uid)return ws.close(1008,"Unauthorized");if(!sockets.has(uid))sockets.set(uid,new Set());sockets.get(uid).add(ws);ws.send(JSON.stringify({type:"ready",serverTime:Date.now()}));}catch{}});
  ws.on("close",()=>{if(!uid)return;const set=sockets.get(uid);if(!set)return;set.delete(ws);if(!set.size)sockets.delete(uid);});
});

server.listen(PORT,()=>console.log("Felix Chat running on "+PORT));
