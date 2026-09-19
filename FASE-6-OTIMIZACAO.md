# Fase 6 — Otimização de chamadas, reutilização e telemetria

## Coordenadas protegidas da base

O Worker aceita `BASE_LAT` e `BASE_LON` como variáveis/secrets de ambiente. Quando as
duas existem, são numéricas, finitas e estão nos intervalos geográficos válidos
(`-90..90` e `-180..180`), elas são usadas diretamente e a base não é geocodificada.
Esses valores não devem ser gravados no repositório.

Se uma variável estiver ausente ou qualquer coordenada for inválida, o Worker usa
`ENDERECO_BASE` como fallback e mantém o comportamento anterior. Portanto,
`ENDERECO_BASE` deve continuar configurado durante a transição. A chave da Geoapify
continua sendo obrigatória porque coleta, entregas e rotas ainda dependem dela.

## Reutilização e cache de geocodificação

Cada requisição mantém um mapa de Promises de geocodificação indexado por uma forma
normalizada do endereço (Unicode NFKC, caixa baixa, espaços consolidados). O texto
original continua sendo enviado à Geoapify e usado pelas regras comerciais. Assim,
coleta e cada endereço de entrega distinto são geocodificados no máximo uma vez por
orçamento, inclusive quando chamadas concorrentes pedem o mesmo endereço.

Além disso, o Worker usa `caches.default`, a Cache API nativa do Cloudflare Workers,
somente para resultados válidos de geocodificação, com TTL de 24 horas. A chave é um
SHA-256 do endereço normalizado em uma URL interna: não contém a API key nem expõe o
endereço em texto. Resultados vazios, respostas de erro e rotas não são armazenados.
Qualquer falha ao ler, criar a chave ou gravar no cache é isolada: a consulta externa
continua normalmente.

O Cache API é oportunista, local aos data centers da Cloudflare e não oferece a
persistência nem a propagação global de KV/D1. Portanto, um resultado pode não estar
disponível em outra localização ou após remoção do cache. Isso reduz chamadas quando
há hit sem tornar o orçamento dependente do cache. Rotas não foram cacheadas nesta
fase para priorizar precisão de quilometragem e preço e evitar invalidação mais
complexa.

## Telemetria

Ao final de cada tentativa de orçamento, um único log JSON `quote_processing` registra:

- `deliveryCount`;
- `geocodingCalls` (requisições externas efetivamente feitas);
- `routingCalls`;
- `geocodeCacheHits` e `geocodeCacheMisses`;
- `technicalErrors` (incluindo falhas toleradas do cache);
- `durationMs`.

O log não contém API key, endereço da base, endereços de clientes ou coordenadas. A
telemetria não é devolvida ao frontend e não requer banco de dados.

## Consumo esperado de chamadas

Para uma entrega, sem hits de cache:

| Cenário | Geocoding | Routing |
| --- | ---: | ---: |
| Antes da Fase 6 | 3 (base, coleta, entrega) | 1 |
| Com `BASE_LAT`/`BASE_LON` | 2 (coleta, entrega) | 1 |
| Com coordenadas e hits para coleta/entrega | 0 | 1 |

Para `D` entregas, o routing permanece exatamente em `D`: um circuito independente
`BASE → COLETA → ENTREGA → BASE` por entrega. Sem coordenadas protegidas e sem cache,
o máximo usual é `D + 2` geocodings; com coordenadas protegidas, `D + 1`. Na prática,
o total é o número de endereços normalizados distintos entre coleta e entregas (mais
a base somente quando houver fallback) que não tenham hit de cache. Repetições dentro
do mesmo orçamento não aumentam esse número.

Não há alteração em modo/tipo de rota, classificação, distâncias, tarifas,
arredondamento individual, soma final ou compatibilidade do formato legado.

## Verificação

Os testes automatizados cobrem coordenadas válidas, fallback ausente/inválido,
reutilização por requisição, hit/miss/falha de cache, telemetria e as regressões das
Fases 1–5 (SHORT/BALANCED, motorcycle, legs, preços, especiais, arredondamento,
múltiplas entregas, contrato legado e preço do frontend ignorado).

Comandos executados:

```sh
node --check worker.js
node --test worker.test.mjs
git diff --check
```
