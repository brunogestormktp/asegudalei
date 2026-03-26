-- Criar tabela para armazenar dados dos usuários
CREATE TABLE IF NOT EXISTS user_data (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);

-- Criar índice para melhorar performance de queries por user_id
CREATE INDEX IF NOT EXISTS idx_user_data_user_id ON user_data(user_id);

-- Habilitar Row Level Security (RLS)
ALTER TABLE user_data ENABLE ROW LEVEL Security;

-- Política para usuários autenticados só poderem acessar seus próprios dados
CREATE POLICY "Users can only access their own data"
    ON user_data
    FOR ALL
    USING (auth.uid() = user_id);

-- Função para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger para atualizar updated_at
CREATE TRIGGER update_user_data_updated_at
    BEFORE UPDATE ON user_data
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ═══════════════════════════════════════════════════════════════
-- REALTIME: habilitar publicação para sincronização instantânea
-- Execute este bloco no SQL Editor do painel do Supabase
-- ═══════════════════════════════════════════════════════════════

-- Adicionar tabela user_data à publicação de Realtime do Supabase
-- (necessário para que postgres_changes funcione)
ALTER PUBLICATION supabase_realtime ADD TABLE user_data;

-- ═══════════════════════════════════════════════════════════════
-- STORAGE: bucket para imagens coladas nas notas
-- Execute no painel do Supabase > Storage > New bucket
-- OU via SQL Editor:
-- ═══════════════════════════════════════════════════════════════

-- Criar bucket para imagens de notas (público para leitura)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'note-images',
    'note-images',
    true,
    5242880,  -- 5 MB por arquivo
    ARRAY['image/png','image/jpeg','image/jpg','image/gif','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Política: usuário autenticado pode fazer upload para sua própria pasta
CREATE POLICY "Authenticated users can upload note images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'note-images' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Política: qualquer pessoa pode ler as imagens (bucket público)
CREATE POLICY "Note images are publicly readable"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'note-images');

-- Política: usuário pode deletar suas próprias imagens
CREATE POLICY "Users can delete their own note images"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'note-images' AND (storage.foldername(name))[1] = auth.uid()::text);
