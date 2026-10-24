window.SUPABASE_URL  = 'https://xsqpefvtttmskaocbkey.supabase.co';
window.SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcXBlZnZ0dHRtc2thb2Nia2V5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MjY0MjQsImV4cCI6MjEwNjAwMjQyNH0.RwZSrenewugnc5jMzgd0FMpH-gRKBw-E69Bdub1xww0';

if (window.supabase && window.SUPABASE_URL.indexOf('ВСТАВЬ') === -1) {
  window.sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
} else {
  window.sb = null;
  console.warn('[supabase] не сконфигурирован');
}