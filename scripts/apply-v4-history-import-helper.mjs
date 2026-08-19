import fs from 'node:fs';

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Missing anchor: ${label}`);
  return text.replace(from, to);
}

const pagePath='public/index.html';
let page=fs.readFileSync(pagePath,'utf8');

page=replaceOnce(
  page,
  '    <section class="card" id="v4SourceSection"><h3 style="margin-top:0">Nguồn Telegram V4</h3><div class="sub" style="margin-bottom:10px">Đăng ký thêm kênh làm nguồn bài học V4 mà không thay đổi MASTER của hệ thống clone. Bot phải có quyền truy cập kênh.</div><form id="registerV4Source" class="row"><input id="v4SourceChatId" placeholder="Chat ID hoặc @username của kênh nguồn V4" /><button class="primary">Đăng ký nguồn V4</button></form></section>',
  '    <section class="card" id="v4SourceSection"><h3 style="margin-top:0">Nguồn Telegram V4</h3><div class="sub" style="margin-bottom:10px">Đăng ký thêm kênh làm nguồn bài học V4 mà không thay đổi MASTER của hệ thống clone. Bot phải có quyền truy cập kênh.</div><form id="registerV4Source" class="row"><input id="v4SourceChatId" placeholder="Chat ID hoặc @username của kênh nguồn V4" /><button class="primary">Đăng ký nguồn V4</button></form><div class="sub" style="margin-top:10px"><b>Bài mới/sửa bài:</b> webhook tự cập nhật. <b>Bài cũ trước khi đăng ký:</b> dùng local history reader. Nút “Lệnh import” bên dưới chỉ sao chép command; Telegram API ID/hash, READER_INGEST_SECRET và file session vẫn chỉ nằm trên máy của bạn.</div></section>',
  'V4 history helper explanation'
);

page=replaceOnce(
  page,
  "function table(headers, rows){ if(!rows.length)return '<div class=\"empty\">Chưa có dữ liệu.</div>'; return `<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`; }",
  "function table(headers, rows){ if(!rows.length)return '<div class=\"empty\">Chưa có dữ liệu.</div>'; return `<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`; }\nfunction historicalImportCommand(channel){const safe=String(channel||'').replace(/\\\\/g,'\\\\\\\\').replace(/\"/g,'\\\\\"');return `python reader-cli/export_history.py --channel \"${safe}\" --cloner-url https://telegram-channel-cloner.vercel.app`;}\nasync function copyHistoricalImport(channel){const cmd=historicalImportCommand(channel);try{if(!navigator.clipboard?.writeText)throw new Error('clipboard_unavailable');await navigator.clipboard.writeText(cmd);alert('Đã sao chép lệnh import lịch sử. Chạy lệnh này trên máy đã cấu hình TELEGRAM_API_ID, TELEGRAM_API_HASH và READER_INGEST_SECRET.');}catch{window.prompt('Sao chép lệnh import lịch sử rồi chạy trên máy local:',cmd);}}",
  'history command helpers'
);

page=replaceOnce(
  page,
  "$('#sources').innerHTML=table(['Tên','Chat ID','Index','Vai trò'],d.sources.map(s=>`<tr><td>${esc(s.title||'—')}</td><td>${esc(s.chat_id)}</td><td>${esc(s.indexed_message_count||0)}</td><td>${s.active?'<span class=\"pill ok\">MASTER</span>':'<span class=\"pill\">Nguồn V4</span>'}</td></tr>`));",
  "$('#sources').innerHTML=table(['Tên','Chat ID','Index','Vai trò','Lịch sử'],d.sources.map(s=>{const historyChannel=s.username?'@'+s.username:s.chat_id;return `<tr><td>${esc(s.title||'—')}</td><td>${esc(s.chat_id)}</td><td>${esc(s.indexed_message_count||0)}</td><td>${s.active?'<span class=\"pill ok\">MASTER</span>':'<span class=\"pill\">Nguồn V4</span>'}</td><td><button class=\"secondary\" data-history-channel=\"${esc(historyChannel)}\">📋 Lệnh import</button></td></tr>`;}));",
  'source history column'
);

page=replaceOnce(
  page,
  "$('#registerV4Source').addEventListener('submit',async e=>{e.preventDefault();const chatId=$('#v4SourceChatId').value.trim();if(!chatId)return;try{const r=await api('/api/admin/v4-source',{method:'POST',body:JSON.stringify({chat_id:chatId})});$('#v4SourceChatId').value='';await load();alert(r.mirror_master?'Kênh này đã là MASTER và cũng dùng được cho V4.':'Đã đăng ký nguồn V4. MASTER hiện tại không thay đổi.');}catch(e){alert(e.message)}});",
  "$('#registerV4Source').addEventListener('submit',async e=>{e.preventDefault();const chatId=$('#v4SourceChatId').value.trim();if(!chatId)return;try{const r=await api('/api/admin/v4-source',{method:'POST',body:JSON.stringify({chat_id:chatId})});$('#v4SourceChatId').value='';await load();alert(r.mirror_master?'Kênh này đã là MASTER và cũng dùng được cho V4.':'Đã đăng ký nguồn V4. MASTER hiện tại không thay đổi.');}catch(e){alert(e.message)}});\n$('#sources').addEventListener('click',e=>{const b=e.target.closest('button[data-history-channel]');if(!b)return;copyHistoricalImport(b.dataset.historyChannel);});",
  'history click delegation'
);

fs.writeFileSync(pagePath,page);
console.log('V4 history import helper UI applied.');
