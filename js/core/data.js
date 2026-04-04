// Data structure for the app
const APP_DATA = {
    clientes: [
        { id: 'wolf', name: '✅ Wolf' },
        { id: 'bronx', name: '✅ Bronx' },
        { id: 'beeyond', name: '✅ BEEyond' },
        { id: 'xenon', name: '✅ Xenon' },
        { id: 'amcc', name: '✅ Grupo AMCC' },
        { id: 'tiger', name: '✅ Tiger Saut' },
        { id: 'gaia', name: '✅ Instituto Gaia Soul' },
        { id: 'marcelo', name: '✅ Marcelo D Telles' },
        { id: 'ferny', name: '✅ Ferny Boutique' },
        { id: 'premium', name: '✅ Premium' },
        { id: 'lia', name: '✅ Lia toss' },
        { id: 'aa-flooring', name: '✅ A&A flooring' }
    ],
    categorias: [
        { id: 'empresa', name: '🏢 Empresa' },
        { id: 'time', name: '👶 Time' },
        { id: 'comercial', name: '💲 Comercial' },
        { id: 'clientes-cat', name: '🧑‍💼 Clientes' },
        { id: 'app', name: '📱 App' },
        { id: 'vendas', name: '💰 Vendas' },
        { id: 'financeiro', name: '🌑 Financeiro' },
        { id: 'bsc', name: '📊 BSC' },
        { id: 'referencias', name: '©️ Referências' },
        { id: 'ia', name: '🤖 IA/Ferramentas' },
        { id: 'ghl', name: '📅 GHL - Mediagrowth' },
        { id: 'mkt-usa', name: '🇺🇸 Mkt Contractors - USA' }
    ],
    atividades: [
        { id: 'oratoria', name: '💼 Oratória' },
        { id: 'meditacao', name: '🧘 Meditação' },
        { id: 'aleatorios', name: '� Segunda lei App' },
        { id: 'organizar', name: '🗂️ Organizar algo' },
        { id: 'segunda-lei-conteudo', name: '🪐 A segunda lei (CONTEÚDO)' },
        { id: 'networking', name: '🗣️ Networking Down & Up' },
        { id: 'ingles', name: '🇺🇸 Ingles' },
        { id: 'programacao', name: '💻 Programação/Cyber' },
        { id: 'mais-dinheiro', name: '🤑 Mais Dinheiro' },
        { id: 'oracao', name: '✝️ Oração/palavra de deus' },
        { id: 'investimentos', name: '💵 Investimentos/renda/juros/bancos/' },
        { id: 'ler', name: '📚 Ler' },
        { id: 'dj', name: '🎧 Sovc - DJ' },
        { id: 'conexoes', name: '❤️ Conexões/amizades' },
        { id: 'criar-video', name: '📹 Criar/editar/publicar um vídeo' },
        { id: 'ads', name: '🎯 Ads/Marketing' },
        { id: 'algoritmo', name: '📱 Algoritmo' },
        { id: 'agua', name: '💧 2 litros d\'água' },
        { id: 'sol', name: '☀️ 30 min sol' },
        { id: 'fruta', name: '🍍 Eating Fruit' },
        { id: 'abdomen', name: '🏃 Abdomen definido' },
        { id: 'academia', name: '💪 Academia' },
        { id: 'walk', name: '🚶 Walk' }
    ]
};

const STATUS_CONFIG = {
    'none': { emoji: '', label: '', score: null },
    'em-andamento': { emoji: '', label: 'Em andamento', score: 0.5 },
    'bloqueado': { emoji: '', label: 'Bloqueado', score: 0 },
    'concluido': { emoji: '', label: 'Concluído', score: 1 },
    'aguardando': { emoji: '', label: 'Aguardando', score: 0.3 },
    'nao-feito': { emoji: '', label: 'Não feito', score: 0 },
    'pular': { emoji: '', label: 'Pular', score: null },
    'concluido-ongoing': { emoji: '', label: 'Concluído/On going time', score: 1 },
    'parcialmente': { emoji: '', label: 'Parcialmente concluído', score: 0.7 },
    'prioridade': { emoji: '', label: 'Prioridade', score: 0 }
};

// Snapshot imutável dos itens originais — usado por applySettings() para rebuild
const APP_DATA_ORIGINAL = {
    clientes:   APP_DATA.clientes.map(i => ({ ...i })),
    categorias: APP_DATA.categorias.map(i => ({ ...i })),
    atividades: APP_DATA.atividades.map(i => ({ ...i })),
};
