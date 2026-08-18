// FELIX CHAT SERVER
// Run: npm install && npm start
// This is the small persistent backend Felix Chat needs.
// It stores accounts, friends, messages, and online connections.

const express=require("express");
const http=require("http");
const WebSocket=require("ws");
const crypto=require("crypto");
const fs=require("fs");
const path=require("path");

const PORT=process.env.PORT||3000;
const DATA=path.join(__dirname,"data.json");
let db={users:{},messages:{}};
try{if(fs.existsSync(DATA))db=JSON.parse(fs.readFileSync(DATA,"utf8"))}catch{}

const save=()=>fs.writeFileSync(DATA,JSON.stringify(db,null,2));
const id=()=>crypto.randomBytes(16).toString("hex");
const clean=s=>String(s||"").trim().slice(0,32);
const hash=(p,s)=>crypto.createHash("sha256").update(s+":"+p).digest("hex");
const sockets=new Map();

const app=express();
app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));

function auth(req,res,next){
 const token=req.headers.authorization?.replace("Bearer ","");
 const uid=Object.keys(db.users).find(x=>db.users[x].token===token);
 if(!uid)return res.status(401).json({error:"Not logged in"});
 req.uid=uid;next();
}

app.post("/api/register",(req,res)=>{
 const username=clean(req.body.username).toLowerCase();
 const password=String(req.body.password||"");
 if(!/^[a-z0-9_]{3,20}$/.test(username))return res.status(400).json({error:"Username must be 3-20 letters, numbers or _"});
 if(password.length<6)return res.status(400).json({error:"Password must be at least 6 characters"});
 if(Object.values(db.users).some(u=>u.username===username))return res.status(409).json({error:"Username already exists"});
 const uid=id(),salt=id(),token=id();
 db.users[uid]={username,hash:hash(password,salt),salt,token,friends:[]};save();
 res.json({token,username});
});

app.post("/api/login",(req,res)=>{
 const username=clean(req.body.username).toLowerCase(),password=String(req.body.password||"");
 const entry=Object.entries(db.users).find(([_,u])=>u.username===username);
 if(!entry)return res.status(401).json({error:"Wrong username or password"});
 const [uid,u]=entry;
 if(u.hash!==hash(password,u.salt))return res.status(401).json({error:"Wrong username or password"});
 u.token=id();save();res.json({token:u.token,username:u.username});
});

app.get("/api/me",auth,(req,res)=>{
 const u=db.users[req.uid];
 res.json({username:u.username,friends:u.friends.map(fid=>({username:db.users[fid]?.username||"Unknown",uid:fid,online:sockets.has(fid)}))});
});

app.post("/api/friends/request",auth,(req,res)=>{
 const target=Object.entries(db.users).find(([_,u])=>u.username===clean(req.body.username).toLowerCase());
 if(!target)return res.status(404).json({error:"User not found"});
 if(target[0]===req.uid)return res.status(400).json({error:"That's you"});
 const u=db.users[req.uid],t=db.users[target[0]];
 u.requests=u.requests||[];t.incoming=t.incoming||[];
 if(u.friends.includes(target[0]))return res.json({ok:true,message:"Already friends"});
 if(!t.incoming.includes(req.uid))t.incoming.push(req.uid);
 save();push(target[0],{type:"friend_request",from:u.username});
 res.json({ok:true});
});

app.get("/api/friends/requests",auth,(req,res)=>{
 const u=db.users[req.uid];u.incoming=u.incoming||[];
 res.json(u.incoming.map(x=>({uid:x,username:db.users[x]?.username})).filter(x=>x.username));
});

app.post("/api/friends/accept",auth,(req,res)=>{
 const other=req.body.uid,u=db.users[req.uid],o=db.users[other];
 if(!o)return res.status(404).json({error:"User not found"});
 u.incoming=(u.incoming||[]).filter(x=>x!==other);
 if(!u.friends.includes(other))u.friends.push(other);
 if(!o.friends.includes(req.uid))o.friends.push(req.uid);
 save();push(other,{type:"friend_accepted",username:u.username});
 res.json({ok:true});
});

app.get("/api/messages/:uid",auth,(req,res)=>{
 const other=req.params.uid;
 if(!db.users[other]||!db.users[req.uid].friends.includes(other))return res.status(403).json({error:"Not friends"});
 const k=[req.uid,other].sort().join(":");
 res.json(db.messages[k]||[]);
});

app.post("/api/messages/:uid",auth,(req,res)=>{
 const other=req.params.uid,u=db.users[req.uid];
 if(!u.friends.includes(other))return res.status(403).json({error:"Not friends"});
 const text=String(req.body.text||"").trim().slice(0,4000);
 if(!text)return res.status(400).json({error:"Empty message"});
 const k=[req.uid,other].sort().join(":");
 db.messages[k]=db.messages[k]||[];
 const m={id:id(),from:req.uid,text,time:Date.now()};
 db.messages[k].push(m);db.messages[k]=db.messages[k].slice(-1000);save();
 push(other,{type:"message",message:m});
 res.json(m);
});

app.post("/api/voice/:uid",auth,(req,res)=>{
 const other=req.params.uid,u=db.users[req.uid];
 if(!u.friends.includes(other))return res.status(403).json({error:"Not friends"});
 const data=String(req.body.data||"");
 if(data.length>1500000)return res.status(413).json({error:"Voice note too large"});
 const k=[req.uid,other].sort().join(":");
 db.messages[k]=db.messages[k]||[];
 const m={id:id(),from:req.uid,voice:data,time:Date.now()};
 db.messages[k].push(m);db.messages[k]=db.messages[k].slice(-1000);save();
 push(other,{type:"message",message:m});res.json(m);
});

const server=http.createServer(app);
const wss=new WebSocket.Server({server,path:"/ws"});
wss.on("connection",(ws)=>{
 let uid=null;
 ws.on("message",raw=>{
   try{
    const m=JSON.parse(raw);
    if(m.type==="auth"){
      uid=Object.keys(db.users).find(x=>db.users[x].token===m.token);
      if(uid){sockets.set(uid,ws);ws.send(JSON.stringify({type:"ready"}))}
    }
   }catch{}
 });
 ws.on("close",()=>{if(uid&&sockets.get(uid)===ws)sockets.delete(uid)});
});
function push(uid,m){const ws=sockets.get(uid);if(ws?.readyState===1)ws.send(JSON.stringify(m))}
server.listen(PORT,()=>console.log("Felix Chat server running on port "+PORT));
