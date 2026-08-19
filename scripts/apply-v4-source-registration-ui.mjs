import fs from 'node:fs';

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Missing anchor: ${label}`);
  return text.replace(from, to);
}

const path = 'public/index.html';
let page = fs.readFileSync(path, 'utf8');

page = replaceOnce(
  page,
  '    <section class="card"><h3 style="margin-top:0">MASTER</h3><form id="setSource" class="row"><input id="sourceChatId" placeholder="Chat ID hoặc @username của kênh MASTER" /><button class="primary">Đặt làm MASTER</button></form><div id="sources" style="margin-top:12px"></div></section>\n    <section class="card"><h3 style="margin-top:0">Kênh clone</h3>',
  '    <section class="card"><h3 style="margin-top:0">MASTER</h3><form id="setSource" class="row"><input id="sourceChatId" placeholder="Chat ID hoặc @username của kênh MASTER" /><button class="primary">Đặt làm MASTER</button></form><div id="sources" style="margin-top:12px"></div></section>\n    <section class="card" id="v4SourceSection"><h3 style="margin-top:0">Nguồn Telegram V4</h3><div class="sub" style="margin-bottom:10px">Đăng ký thêm kênh làm nguồn bài học V4 mà không thay đổi MASTER của hệ thống clone. Bot phải có quyền truy cập kênh.</div><form id="registerV4Source" class="row"><input id="v4SourceChatId" placeholder="Chat ID hoặc @username của kênh nguồn V4" /><button class="primary">Đăng ký nguồn V4</button></form></section>\n    <section class="card"><h3 style="margin-top:0">Kênh clone</h3>',
  'insert V4 source section'
);

page = replaceOnce(
  page,
  "$('#sources').innerHTML=table(['Tên','Chat ID','Index','Trạng thái'],d.sources.map(s=>`<tr><td>${esc(s.title||'—')}</td><td>${esc(s.chat_id)}</td><td>${esc(s.indexed_message_count||0)}</td><td>${s.active?pill('done'):pill('paused')}</td></tr>`));",
  "$('#sources').innerHTML=table(['Tên','Chat ID','Index','Vai trò'],d.sources.map(s=>`<tr><td>${esc(s.title||'—')}</td><td>${esc(s.chat_id)}</td><td>${esc(s.indexed_message_count||0)}</td><td>${s.active?'<span class=\"pill ok\">MASTER</span>':'<span class=\"pill\">Nguồn V4</span>'}</td></tr>`));",
  'source role table'
);

page = replaceOnce(
  page,
  "$('#setSource').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/admin/source',{method:'POST',body:JSON.stringify({chat_id:$('#sourceChatId').value.trim()})});$('#sourceChatId').value='';await load();}catch(e){alert(e.message)}});\n$('#addDest').addEventListener",
  "$('#setSource').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/admin/source',{method:'POST',body:JSON.stringify({chat_id:$('#sourceChatId').value.trim()})});$('#sourceChatId').value='';await load();}catch(e){alert(e.message)}});\n$('#registerV4Source').addEventListener('submit',async e=>{e.preventDefault();const chatId=$('#v4SourceChatId').value.trim();if(!chatId)return;try{const r=await api('/api/admin/v4-source',{method:'POST',body:JSON.stringify({chat_id:chatId})});$('#v4SourceChatId').value='';await load();alert(r.mirror_master?'Kênh này đã là MASTER và cũng dùng được cho V4.':'Đã đăng ký nguồn V4. MASTER hiện tại không thay đổi.');}catch(e){alert(e.message)}});\n$('#addDest').addEventListener",
  'V4 source submit listener'
);

page = replaceOnce(
  page,
  'load();\n</script>',
  "load().then(()=>{if(new URLSearchParams(location.search).get('mode')==='v4-source')setTimeout(()=>document.querySelector('#v4SourceSection')?.scrollIntoView({behavior:'smooth',block:'center'}),100)});\n</script>",
  'V4 source deep link'
);

fs.writeFileSync(path, page);
console.log('V4 source registration UI applied.');
