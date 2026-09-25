# Fase 7 — Segurança e autoridade do backend

## Política de CORS

O Worker usa a variável de ambiente `ALLOWED_ORIGINS` como allowlist. O valor é uma
lista separada por vírgulas de origins HTTPS, sem caminho e sem barra final, por
exemplo no formato `https://host,https://host:porta`. Os valores reais devem ser
definidos no Cloudflare e não ficam versionados.

A comparação é exata com o header `Origin`: scheme, hostname e porta (quando houver)
precisam coincidir. Não há comparação por prefixo, sufixo ou substring. Entradas
inválidas, origins com caminho e `*` são ignorados e nunca abrem o acesso. Quando um
browser envia um origin não autorizado, o Worker responde `403` com JSON genérico,
sem headers CORS e antes de geocodificar ou rotear.

Uma requisição sem `Origin` continua sendo processada normalmente, para preservar
integrações legítimas server-to-server, e não recebe `Access-Control-Allow-Origin`.
CORS é uma proteção do navegador, não um mecanismo de autenticação.

Um `OPTIONS` autorizado recebe `204`, o origin autorizado, os métodos `POST, OPTIONS`,
o header permitido `Content-Type`, `Vary: Origin` e o tempo de cache do preflight.
Um `OPTIONS` não autorizado recebe `403` e não libera CORS. Nenhuma resposta usa
`Access-Control-Allow-Origin: *`.

## Configuração manual no Cloudflare

Antes da produção, configurar no ambiente correto do Worker:

- `ALLOWED_ORIGINS`: variável com todos e somente os origins oficiais, separados por
  vírgula. Confirmar explicitamente cada variante necessária, inclusive `www` e porta;
- `GEOAPIFY_API_KEY`: secret, nunca variável pública ou valor no código;
- `BASE_LAT` e `BASE_LON`: variáveis protegidas ou secrets com as coordenadas da base;
- `ENDERECO_BASE`: variável protegida ou secret mantido como fallback durante a
  transição descrita na Fase 6.

Depois da configuração, validar os origins reais em cada ambiente. A ausência de
`ALLOWED_ORIGINS` é segura: chamadas com `Origin` falham fechadas, enquanto chamadas
sem `Origin` continuam sujeitas às validações normais do endpoint. Nenhuma alteração
de configuração ou deploy foi feita nesta fase.

## Backend como autoridade

O contrato de entrada continua aceitando somente os endereços `pickup` e `delivery`,
ou `pickup` e `deliveries`. Campos adicionais não participam do cálculo. Em especial,
preço, total, tarifa, distâncias, classificação, tipo e modo de rota, coordenadas,
base e chave enviados pelo cliente são ignorados.

O backend continua determinando `motorcycle`, `short` ou `balanced`, geocodificando os
endereços, formando o circuito, extraindo `oneWayKm` dos legs e aplicando internamente
as tarifas, regiões especiais e `Math.ceil`. As tarifas e regras comerciais não foram
alteradas. A resposta legada mantém seus aliases e resultados, mas deixa de expor as
coordenadas protegidas da base.

## Erros, logs e dados sensíveis

As respostas de erro são mensagens controladas e não contêm exceções, stack traces,
URLs externas, detalhes de infraestrutura ou nomes de configuração ausente. Falhas
inesperadas geram somente um evento interno genérico, sem serializar o objeto de erro.

A telemetria da Fase 6 permanece com `deliveryCount`, `geocodingCalls`,
`routingCalls`, `geocodeCacheHits`, `geocodeCacheMisses`, `technicalErrors` e
`durationMs`. Ela não registra corpo da requisição, API key, endereço da base,
endereços de clientes, coordenadas ou URLs da Geoapify. Não se deve adicionar esses
dados a logs operacionais futuros.

## Cache

O cache continua restrito a resultados válidos de geocodificação. Sua chave contém
somente o SHA-256 do endereço normalizado: não contém endereço em texto nem API key.
Erros e resultados vazios não são cacheados, pontos lidos do cache são validados e
falhas do cache são toleradas. O cache não armazena preço nem altera as decisões de
classificação, rota ou tarifa. Não foram adicionados KV, D1 ou Durable Objects.

## Auditoria de credenciais

Foi feita uma busca nos arquivos versionados por identificadores sensíveis, padrões de
atribuição de credenciais, chaves privadas e credenciais embutidas em URLs. Não foi
encontrado valor real de API key, token, secret ou credencial. As ocorrências são
referências a variáveis de ambiente, documentação e valores claramente fictícios dos
testes. Nenhum arquivo suspeito precisou ser removido.

## Proteção contra abuso

Não foi criado rate limiter em memória nem limite comercial de entregas. Rate limiting,
regras de WAF e proteção contra abuso devem ser avaliados em uma etapa operacional e
configurados com recursos próprios da Cloudflare, com limites baseados no tráfego real,
observabilidade e tratamento específico para o endpoint. Isso evita estado inconsistente
entre isolates e não adiciona infraestrutura nesta fase.
