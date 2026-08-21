import fs from 'node:fs';

function replaceOnce(path, from, to) {
  const before = fs.readFileSync(path, 'utf8');
  const count = before.split(from).length - 1;
  if (count !== 1) throw new Error(`${path}: expected exactly one match, found ${count}`);
  fs.writeFileSync(path, before.replace(from, to));
}

const path = 'public/index.html';

replaceOnce(
  path,
  '<div class="actions"><button id="setupWebhook" class="secondary">Kết nối webhook</button><button id="refresh" class="secondary">Làm mới</button><button id="runTick" class="primary">Chạy 1 nhịp queue</button></div>',
  '<div class="actions"><button id="returnToWizard" class="secondary" style="display:none">← Quay lại LMS Wizard</button><button id="setupWebhook" class="secondary">Kết nối webhook</button><button id="refresh" class="secondary">Làm mới</button><button id="runTick" class="primary">Chạy 1 nhịp queue</button></div>'
);

replaceOnce(
  path,
  "const esc=v=>String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',\"'\":'&#39;','\"':'&quot;'}[c]));",
  "const esc=v=>String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',\"'\":'&#39;','\"':'&quot;'}[c]));\nfunction safeWizardReturn(){const raw=new URLSearchParams(location.search).get('returnTo');if(!raw)return '';try{const u=new URL(raw);const host=u.hostname.toLowerCase();const preview=((host.startsWith('yeunauan-lms-clone-')||host.startsWith('yeunauan-lms-git-'))&&host.endsWith('.vercel.app'));if(u.protocol!=='https:'||u.pathname!=='/v4-course-wizard.html'||!(host==='yeunauan-lms-clone.vercel.app'||preview))return '';return u.origin+u.pathname}catch{return ''}}"
);

replaceOnce(
  path,
  "$('#refresh').addEventListener('click',load);",
  "const wizardReturn=safeWizardReturn();if(wizardReturn)$('#returnToWizard').style.display='inline-block';$('#returnToWizard').addEventListener('click',()=>{if(wizardReturn)location.assign(wizardReturn)});\n$('#refresh').addEventListener('click',load);"
);

replaceOnce(
  path,
  '<div class="sub" style="margin-top:10px"><b>Bài mới/sửa bài:</b> webhook tự cập nhật. <b>Bài cũ trước khi đăng ký:</b> bấm “Import 1 lệnh” bên dưới rồi chạy trên Windows. Helper tự cập nhật reader an toàn, tự cài dependency nếu thiếu và lưu Telegram API ID/hash + READER_INGEST_SECRET bằng Windows DPAPI trên chính máy local; không đưa secret vào command hay repo.</div>',
  '<div class="sub" style="margin-top:10px"><b>Bài mới/sửa bài:</b> webhook tự cập nhật. <b>Bài cũ trước khi đăng ký:</b> bấm “Import 1 lệnh” bên dưới rồi chạy trên Windows. Helper tự cập nhật reader an toàn, tự cài dependency nếu thiếu và lưu Telegram API ID/hash + READER_INGEST_SECRET bằng Windows DPAPI trên chính máy local; không đưa secret vào command hay repo. Nếu trang này được mở từ LMS Wizard, sau khi đăng ký/import xong hãy bấm <b>← Quay lại LMS Wizard</b> ở phía trên.</div>'
);

console.log('Patched safe LMS Wizard return link successfully.');
