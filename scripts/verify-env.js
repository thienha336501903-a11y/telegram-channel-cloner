const failures = [];

function present(name) {
  const value = process.env[name];
  if (!value) failures.push(`${name}: missing`);
  return value || '';
}

function minLength(name, min) {
  const value = present(name);
  if (value && value.length < min) failures.push(`${name}: must be at least ${min} characters`);
  return value;
}

const supabaseUrl = present('SUPABASE_URL');
if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
  failures.push('SUPABASE_URL: unexpected URL format');
}
if (!(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  failures.push('SUPABASE_SECRET_KEY: missing (legacy SUPABASE_SERVICE_ROLE_KEY is also accepted)');
}

minLength('ADMIN_PASSWORD', 12);
minLength('SESSION_SECRET', 32);

const botToken = present('TELEGRAM_BOT_TOKEN');
if (botToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) failures.push('TELEGRAM_BOT_TOKEN: unexpected BotFather token format');

const webhookSecret = minLength('TELEGRAM_WEBHOOK_SECRET', 32);
if (webhookSecret && !/^[A-Za-z0-9_-]+$/.test(webhookSecret)) {
  failures.push('TELEGRAM_WEBHOOK_SECRET: only A-Z a-z 0-9 _ - are allowed');
}

minLength('READER_INGEST_SECRET', 32);
minLength('CRON_SECRET', 32);

if (failures.length) {
  console.error('Runtime environment validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Runtime environment validation passed for ${process.env.VERCEL_ENV || 'local'} environment.`);
