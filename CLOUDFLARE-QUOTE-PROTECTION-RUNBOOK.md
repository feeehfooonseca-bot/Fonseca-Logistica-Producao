# Cloudflare — ativação segura do orçamento protegido

## Objetivo

Ativar a infraestrutura da PR #13 sem alterar tarifas, rotas ou o frontend.

Código de referência em produção no GitHub:

- main: `52516cb5b62889cfcbf6fd131570a502e2792715`;
- binding D1 esperado pelo Worker: `QUOTE_DB`;
- secret esperado: `QUOTE_SIGNING_SECRET`;
- TTL opcional: `QUOTE_PROOF_TTL_SECONDS` (padrão do código: 1800 s / 30 min);
- migration: `migrations/0001_create_protected_quotes.sql`.

## Regra de segurança

Não colocar nenhum valor real de secret, API key, coordenada protegida ou token no GitHub, neste documento, em screenshots públicas ou no chat.

Não executar deploy durante a preparação do banco.

## Fase A — preparar D1 sem afetar o Worker atual

1. No Cloudflare Dashboard, criar um banco D1 com o nome estável:
   `fonseca-logistica-quotes`.
2. Guardar o Database ID em local privado. Não versionar o ID em documentação pública.
3. Abrir o Console do D1 e executar o conteúdo completo de
   `migrations/0001_create_protected_quotes.sql`.
4. Confirmar no Console:
   `SELECT name FROM sqlite_master WHERE type='table' AND name='protected_quotes';`
5. Confirmar as constraints/índices:
   `SELECT name, sql FROM sqlite_master WHERE tbl_name='protected_quotes' ORDER BY type, name;`
6. Não inserir dados fictícios no banco de produção.

A migration é mantida idempotente para que uma futura execução por Wrangler não falhe caso a tabela já tenha sido criada pelo Console.

## Fase B — preparar o secret

Criar um valor aleatório forte para `QUOTE_SIGNING_SECRET` (recomendado: pelo menos 32 bytes de entropia; por exemplo, 64 caracteres hexadecimais gerados por um gerador criptográfico/password manager).

Regras:

- não reutilizar senha pessoal;
- não reutilizar a chave da Geoapify;
- não salvar em arquivo versionado;
- não enviar pelo WhatsApp ou pelo chat;
- guardar em gerenciador de senhas ou armazenamento seguro.

A documentação atual da Cloudflare alerta que `wrangler secret put` cria uma nova versão e a publica imediatamente. Para preparação sem deploy, prefira configurar o secret durante a janela de ativação controlada ou usar `wrangler versions secret put` quando houver CLI/CI apropriado.

## Fase C — ativação controlada do Worker

Só executar depois de A e B concluídas e conferidas.

Configuração necessária no Worker existente `fonseca-logistica-api`:

- D1 binding: `QUOTE_DB` → banco `fonseca-logistica-quotes`;
- secret: `QUOTE_SIGNING_SECRET`;
- variável opcional: `QUOTE_PROOF_TTL_SECONDS=1800`;
- preservar integralmente os valores atuais de:
  - `GEOAPIFY_API_KEY`;
  - `ALLOWED_ORIGINS`;
  - `BASE_LAT`;
  - `BASE_LON`;
  - `ENDERECO_BASE` se ainda estiver em uso.

Não substituir configurações existentes por placeholders do arquivo `wrangler.example.jsonc`.

## Fase D — smoke test após ativação

1. Fazer um cálculo comum e confirmar HTTP 200.
2. Confirmar que a resposta contém `protectedQuote.snapshot` e `protectedQuote.proof`.
3. Confirmar que apenas calcular não cria linha em `protected_quotes`.
4. Fazer um submit protegido.
5. Confirmar:
   - HTTP 201 no primeiro submit;
   - código `FL-...`;
   - `verificationUrl` presente;
   - exatamente uma linha no D1 para o `quote_jti`.
6. Repetir o mesmo submit:
   - HTTP 200;
   - mesmo código;
   - mesma `verificationUrl`;
   - nenhuma linha duplicada.
7. Abrir a URL de verificação:
   - vigente → 🟢 VÁLIDO;
   - token inexistente → 🔴 INVÁLIDO / NÃO ENCONTRADO.
8. Confirmar que uma simulação sem submit não persiste nada.
9. Confirmar que o site e a calculadora antiga continuam calculando normalmente.

## Fase E — rollback

Se houver falha depois da ativação:

1. não apagar o D1;
2. não apagar a migration;
3. reverter a versão do Worker para a versão anterior estável;
4. preservar logs técnicos sem dados pessoais;
5. investigar antes de nova ativação.

Como o cálculo continua compatível quando `QUOTE_SIGNING_SECRET` não está presente, a versão anterior permanece referência de rollback.

## Wrangler futuro

A configuração ativa só deve ser criada depois de copiar os valores reais existentes do Worker e obter o Database ID.

O arquivo `wrangler.example.jsonc` é apenas um template deliberadamente não implantável.

Com Wrangler, a forma oficial de aplicar migrations remotas é:

`npx wrangler d1 migrations apply fonseca-logistica-quotes --remote`

A Cloudflare recomenda usar o nome estável do banco para migrations, evitando depender de um binding que possa mudar.
