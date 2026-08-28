from pathlib import Path
p=Path('/mnt/data/activitywork/public/index.html')
s=p.read_text()
# add styles
s=s.replace('</style>', '''.feature-typing{font-size:12px;color:#8f9db7;min-height:17px}.message-read-state{font-size:10px;color:#7f8da8;margin-top:3px;text-align:right}.profile-link{cursor:pointer}.profile-modal-banner{width:100%;height:130px;object-fit:cover;border-radius:14px;background:#11192c}.profile-modal-avatar{width:84px;height:84px;border-radius:50%;margin-top:-42px;border:4px solid #10182a;background:#11192c;position:relative}.activity-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#68748a;margin-right:6px}.activity-dot.online{background:#49e79a;box-shadow:0 0 8px #49e79a}.profile-card{background:#11192c;border:1px solid #2c3854;border-radius:16px;padding:14px}.profile-stat{color:#aab6cf;font-size:12px;margin-top:5px}''',1)
# insert typing indicator under friendStatus
s=s.replace('''<div\nclass="small"\nid="friendStatus"\n>\nChoose a friend\n</div>''','''<div class="small" id="friendStatus">Choose a friend</div>\n<div id="featureTypingIndicator" class="feature-typing"></div>''')
# make friend list names clickable via onclick currently whole friend. Add profile button-like class isn't needed; whole friend clicks chat. We need click actual name to profile, stop propagation.
old='''<b>\n@${friend.username}${friend.verified ? '<span class="verified-tick">✓</span>' : ''}${Number(friend.streak||0)>0 ? `<span class="streak-badge active">🔥 ${Number(friend.streak)}</span>` : ''}\n</b>'''
new='''<b class="profile-link" onclick="event.stopPropagation();openUserProfile('${friend.uid}')">\n@${friend.username}${friend.verified ? '<span class="verified-tick">✓</span>' : ''}${Number(friend.streak||0)>0 ? `<span class="streak-badge active">🔥 ${Number(friend.streak)}</span>` : ''}\n</b>'''
s=s.replace(old,new,1)
# message bubble outgoing read state
needle='''  if(message.from===me.uid){\n    const tools=document.createElement("div");'''
rep='''  if(message.from===me.uid){\n    const read=document.createElement("div");\n    read.className="message-read-state";\n    read.textContent=message.readAt ? "Seen" : "Sent";\n    read.dataset.readState=message.id;\n    bubble.appendChild(read);\n    const tools=document.createElement("div");'''
s=s.replace(needle,rep,1)
# mark loaded incoming messages read after render
old='''    messages.forEach(message=>fragment.appendChild(messageBubble(message)));\n    container.appendChild(fragment);'''
new='''    messages.forEach(message=>fragment.appendChild(messageBubble(message)));\n    container.appendChild(fragment);\n    messages.filter(m=>m.from!==me.uid && !m.readAt).forEach(m=>markMessageRead(m.id));'''
s=s.replace(old,new,1)
# append incoming message mark read
old='''  $("messages").appendChild(messageBubble(message));\n  if(scroll) $("messages").scrollTop=$("messages").scrollHeight;'''
new='''  $("messages").appendChild(messageBubble(message));\n  if(message.from!==me.uid) markMessageRead(message.id);\n  if(scroll) $("messages").scrollTop=$("messages").scrollHeight;'''
s=s.replace(old,new,1)
# add functions before feature hub section
marker='''/* Add a features button once the DOM is ready. */'''
insert='''async function markMessageRead(messageId){\n  if(!activeFriend||!messageId)return;\n  try{await api('/messages/'+activeFriend.uid+'/'+messageId+'/read',{method:'POST'});}catch{}\n}\nfunction updateReadState(messageId){const el=document.querySelector(`[data-read-state="${CSS.escape(messageId)}"]`);if(el)el.textContent='Seen';}\nfunction formatLastSeen(ts){if(!ts)return 'Last online: unknown';const d=Date.now()-Number(ts);if(d<60000)return 'Last online: just now';if(d<3600000)return 'Last online: '+Math.floor(d/60000)+' min ago';if(d<86400000)return 'Last online: '+Math.floor(d/3600000)+' hr ago';return 'Last online: '+new Date(Number(ts)).toLocaleString();}\nasync function openUserProfile(uid){\n  try{const u=await api('/users/'+encodeURIComponent(uid));const online=!!u.online;openModal(`<div class="profile-card"><button class="btn" style="float:right" onclick="closeModal()">Close</button>${u.banner?`<img class="profile-modal-banner" src="${escapeHtml(u.banner)}">`:''}<div class="profile-modal-avatar">${avatarMarkup(u)}</div><h2 style="margin:8px 0 2px">${userLabel(u)}</h2><div class="profile-stat"><span class="activity-dot ${online?'online':''}"></span>${online?'Online now':formatLastSeen(u.lastSeen)}</div>${u.statusText?`<p>${escapeHtml(u.statusText)}</p>`:''}<p>${escapeHtml(u.bio||'No bio yet.')}</p>${Number(u.streak||0)>0?`<div class="profile-stat">🔥 ${Number(u.streak)} day friend streak</div>`:''}</div>`);}catch(e){alert(e.message)}\n}\n\n'''
s=s.replace(marker,insert+marker,1)
# socket message_read handling
s=s.replace('''if(message.type === "message_deleted"){''','''if(message.type === "message_read"){ updateReadState(message.messageId); }\nif(message.type === "message_deleted"){''',1)
# typing existing is okay, but clear on select already.
p.write_text(s)

p=Path('/mnt/data/activitywork/server.js')
s=p.read_text()
# add profile endpoint before users search
needle="app.get('/api/users/search',auth,async(req,res)=>{"
route="""app.get('/api/users/:uid',auth,async(req,res)=>{\n  const u=await getUser(req.params.uid);\n  if(!u)return res.status(404).json({error:'User not found'});\n  const isSelf=u.uid===req.uid;\n  if(!isSelf && !(await areFriends(req.uid,u.uid)))return res.status(403).json({error:'You can only view profiles of friends.'});\n  res.json(publicUser(u,(sockets.get(u.uid)?.size||0)>0));\n});\n\n"""
s=s.replace(needle,route+needle,1)
p.write_text(s)
