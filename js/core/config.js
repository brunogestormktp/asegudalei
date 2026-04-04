// Configuração do Supabase
const SUPABASE_CONFIG = {
    url: 'https://fajbxgvqptrnynpqkitx.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhamJ4Z3ZxcHRybnlucHFraXR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjU0ODAsImV4cCI6MjA4OTcwMTQ4MH0.T2ktmpTwH9Do7QL6hdNL0J8ffh3jaRyW5M0FkK3K2Cg'
};

// Função para obter ou criar cliente Supabase
window.getSupabaseClient = function() {
    // Se já existe um cliente, retornar
    if (window._supabaseClient) {
        return window._supabaseClient;
    }
    
    // Verificar se a biblioteca Supabase foi carregada
    if (typeof supabase === 'undefined' || !supabase.createClient) {
        console.error('Biblioteca Supabase não carregada');
        return null;
    }
    
    // Criar e armazenar o cliente
    try {
        window._supabaseClient = supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
        return window._supabaseClient;
    } catch (error) {
        console.error('Erro ao criar cliente Supabase:', error);
        return null;
    }
};
