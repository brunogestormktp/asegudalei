// Configuração do Supabase
const SUPABASE_CONFIG = {
    url: 'https://fajbxgvqptrnynpqkitx.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhamJ4Z3ZxcHRybnlucHFraXR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjU0ODAsImV4cCI6MjA4OTcwMTQ4MH0.T2ktmpTwH9Do7QL6hdNL0J8ffh3jaRyW5M0FkK3K2Cg'
};

// Inicializar cliente Supabase
const supabase = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
