# Segurança e pixel — preparação para ativação

## Achados verificados

- Em 09/10/2026, `/worker.js` no Pages retornava HTTP 200 com as regras comerciais. `_worker.js` agora permite somente páginas, cinco módulos de interface, imagens/fontes/vídeos em assets, robots e sitemap; todo arquivo interno/teste/migration recebe 404.
- Repositório GitHub é público. A barreira do Pages não protege a cópia pelo GitHub: tornar o repositório privado manualmente e manter a integração Cloudflare/GitHub com acesso. Código de interface continua inspecionável; nenhuma técnica no navegador impede cópia de HTML/CSS/JS.
- O fluxo possuía eventos condicionais para `fbq`, mas nenhuma inicialização no HTML. Módulo novo inicializa a biblioteca oficial, respeita escolha de medição, restringe produção a fonsecalog.com.br e www, e não ativa pixel nas prévias.
- CORS já era exato, mas não autentica clientes sem Origin. Modo de segurança novo exige origem permitida, sessão assinada e IP recebido da Cloudflare para operações protegidas.

## Proteções no código

- Validação JSON, limite de 32 KiB mesmo sem Content-Length, endereços até 500 caracteres, timeouts externos.
- Turnstile validado no servidor, incluindo `success`, hostname e action `fonseca_session`. Token Turnstile é trocado uma única vez no Siteverify por sessão própria de 20 minutos assinada, vinculada à origem e IP. Sessão fica apenas em memória no navegador. Tokens adulterados/expirados não chamam mapas.
- Contadores compartilhados no D1 existente, usando UPSERT atômico. Não usa contador em memória como proteção. Chaves são HMAC, sem IP/endereço/nome bruto; retenção curta e limpeza por Cron.
- Limites iniciais por IP/minuto: sessão 6, busca 60, cálculo 10, confirmação 10, verificação 60. IP compartilhado pode atingir o limite; acompanhar tráfego e ajustar conforme necessidade.
- Limites globais diários: 200 cálculos e 1000 buscas; variáveis `DAILY_QUOTE_LIMIT`, `DAILY_SEARCH_LIMIT` aceitam 10–10000. Contam operações, não créditos exatos dos fornecedores. Multi-entregas pode consumir vários créditos por cálculo. Não garantem que a franquia gratuita nunca seja excedida. Ao atingir limite, orienta WhatsApp.
- Falha na infraestrutura com segurança ativada retorna 503; não libera a API silenciosamente. Siteverify não aceita fallback sem validação.
- CSP por hashes dos scripts inline, sem unsafe-eval/unsafe-inline em scripts; bloqueio de iframe do site, nosniff, política de recursos. GPS continua permitido no próprio site. Leaflet usa SRI.
- Preserva prova assinada, cálculo no servidor, contrato, preços e viagens compartilhadas. Alteração durante confirmação impede abrir mensagem antiga.
- Dados pessoais não são enviados nos eventos de anúncios. PageView ao aceitar medição, ViewContent quando calculadora entra na tela, QuoteCalculated após resultado, Lead após registro protegido. Lead significa intenção/solicitação, não entrega concluída nem WhatsApp recebido. Deduplicação por código nesta página; eventID estável para o orçamento.
- Não adiciona CAPI, correspondência avançada ou venda automaticamente. Confirmar instalação prévia por Zaraz/GTM antes de ativar para evitar duas instalações do mesmo pixel.

## Configuração de uma vez — NÃO ativar flag antes de concluir dependências

1. Tornar GitHub privado em Settings → General → Danger Zone → Change visibility. Fazer pela conta proprietária. Manter a instalação GitHub da Cloudflare autorizada. Essa ação não apaga cópias/forks já feitos.
2. Cloudflare → Turnstile: criar widget gerenciado para `fonsecalog.com.br`, `www.fonsecalog.com.br` e `fix-enderecos-confirmacao-ma.fonseca-logistica-producao.pages.dev`. Não autorizar todos os hostnames. Usar chaves reais em produção; nenhuma chave de teste vai no código.
3. D1 de `QUOTE_DB`: aplicar `migrations/0002_abuse_counters.sql`. Mantém `protected_quotes`; não recria nem apaga tabela existente.
4. Worker `fonseca-logistica-api`: publicar worker.js preservando os bindings/chaves atuais. Adicionar secrets `TURNSTILE_SECRET_KEY` e `ABUSE_SIGNING_SECRET` (aleatório, pelo menos 32 caracteres, diferente da chave de orçamento). Não enviar esses secrets no chat, GitHub nem Pages.
5. Worker: atualizar `ALLOWED_ORIGINS` preservando produção e incluindo a origem estável da prévia (sem barra final). Variáveis opcionais de limite acima. Configurar Cron `15 */6 * * *` para limpar contadores antigos e registros cuja validade terminou há mais de 72 horas. A retenção física inclui o intervalo até o próximo Cron; não é promessa de exclusão exata aos 72h.
6. Pages: adicionar variáveis públicas `TURNSTILE_SITE_KEY` e `META_PIXEL_ID` (ID numérico, não token), ambientes produção/prévia conforme aplicável. Os secrets ficam somente no Worker. O pixel está sempre desligado em pages.dev mesmo com ID configurado.
7. Publicar os módulos e `_worker.js` juntos. Primeiro manter `SECURITY_ENABLED=false` em Worker e Pages durante instalação. Validar arquivos/rotas. Só após migration, chaves e frontend estarem prontos, definir `SECURITY_ENABLED=true` nos dois ambientes e publicar a configuração. Essa flag ativa o novo modo de proteção; o pacote não pode ser chamado de ativado enquanto estiver false.
8. Meta → Gerenciador de Eventos → Testar eventos: abrir domínio oficial, aceitar medição, visitar calculadora, calcular e confirmar uma solicitação real de teste autorizada. Conferir PageView/ViewContent/QuoteCalculated/Lead, ID correto e nenhuma duplicação. Prévia não gera eventos Meta. Não há ID de pixel disponível na sessão até agora; ativação e validação Meta permanecem pendentes.
9. Não usar modo “Under Attack” em toda a API JSON como proteção padrão: desafios HTML quebram fetch. Turnstile e limites cobrem o fluxo. Regras WAF e proteção DDoS da zona precisam ser inspecionadas na conta antes de afirmar que estão configuradas. Nenhuma regra de painel foi criada por este pacote.

## Verificação

`node --test --test-skip-pattern='HTML local' worker.test.mjs frontend-quote.test.mjs frontend-locations.test.mjs security.test.mjs`

180 testes aprovados antes da publicação de revisão. SQLite real verificou a consulta de limite (10 permitidas em 50 tentativas, nova janela reinicia). Scripts verificados com node --check. `refresh-csp.mjs` precisa rodar após editar scripts inline do index; teste falha se hashes estiverem desatualizados.

O HTML legado de ~7,6 MB continua não baixado/testado e está bloqueado na publicação. Turnstile real, D1 remoto, configuração Meta e limites operacionais requerem a configuração acima. Não confundir teste simulado com ativação em produção.
