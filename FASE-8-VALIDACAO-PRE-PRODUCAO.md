# Fase 8 — Validação pré-produção

## Resultado executivo

A bateria final foi executada exclusivamente com mocks e dados sintéticos, sem chamadas
reais à Geoapify. A suíte terminou com **96 testes aprovados, zero falhas, zero testes
ignorados e zero pendências conhecidas no backend coberto localmente**. Destes, **51
testes/subtestes foram acrescentados na Fase 8** sobre os 45 existentes.

Foram encontrados dois defeitos reais de robustez, ambos reproduzidos por testes e
corrigidos com alterações mínimas:

1. um item antigo/incompleto do cache com coordenadas válidas, mas sem `city` e
   `localities`, era aceito e podia mudar a classificação e o preço;
2. uma distância total negativa, embora finita, retornada pelo routing era aceita e
   podia produzir quilometragem e preço inválidos.

Após as correções, cache incompleto é ignorado e consultado novamente na Geoapify, e
distâncias totais ou legs negativos são rejeitados. Não houve refatoração preventiva,
alteração de tarifa, classificação, modo ou circuito.

## Áreas cobertas

- regressão das Fases 1–7: circuito independente `BASE → COLETA → ENTREGA → BASE`, uma
  rota por entrega, `SHORT` local, `BALANCED` em viagem, modo `motorcycle`, `oneWayKm`
  derivado dos dois primeiros legs e ausência de uma terceira rota;
- tarifa local nas fronteiras 0, 11,9, 12, imediatamente acima de 12, 13, 15, 16 e 20 km;
- Rio Vermelho Povoado, Rio Vermelho Estação e Rio Natal abaixo, no limite,
  imediatamente acima e com excedente maior, por localidade do geocoder e fallback do
  endereço;
- viagens com coleta local/externa e entrega local/externa, inclusive várias entregas;
- arredondamento individual com os casos 15,00; 15,01; 15,50; 16,65; 19,95 e 20,00,
  além da soma conceitual `15 + 17 + 20 = 52`;
- uma, duas e várias entregas; repetição; combinações local/especial/viagem; ordem da
  resposta; independência de circuitos e soma dos preços individuais;
- coordenadas configuradas da base e fallback seguro; deduplicação por Unicode, caixa
  e espaços; cache hit/miss; falhas de `match`/`put`; ausência de cache de erros;
- cache adversarial com JSON inválido, objeto vazio, coordenadas fora da faixa,
  tipos inesperados e registros antigos/incompletos;
- CORS exato, múltiplas origens, origem ausente, preflight permitido/proibido,
  wildcard, configuração vazia/malformada, path, protocolo, porta, domínio parecido,
  subdomínio, prefixo e sufixo maliciosos, sempre sem `Access-Control-Allow-Origin: *`;
- tentativas do cliente de sobrescrever preço, tarifa, limites, distâncias,
  classificação, rota, modo, base, credencial, coordenadas e localidades;
- JSON/body inválidos, campos ausentes, vazios e tipos incorretos, propriedades extras,
  Unicode, espaços e repetições normalizadas;
- falha HTTP e exception de fetch, geocoder vazio/inválido, routing HTTP, estrutura
  inesperada, legs ausentes e distância negativa, com resposta controlada;
- telemetria e contrato legado/novo, sem base, credencial, endereço, coordenadas, body
  bruto, URL sensível ou stack;
- contagem de chamadas: 2 geocodings e 1 routing com base configurada; 0 geocodings e
  1 routing em cache hit; `D + 1` geocodings sem cache/base configurada e exatamente
  `D` routings; endereços repetidos deduplicam geocoding sem deduplicar entregas;
- cenários de negócio históricos (Centro, Serra Alta, Cruzeiro, Rio Natal, Campo
  Alegre, viagem longa e múltiplas entregas) por regras e distâncias sintéticas, sem
  afirmar geografia real.

## Auditoria estática e segurança

A busca estática não encontrou secrets reais, API keys atribuídas, coordenadas reais
protegidas, endereço real da base, TODO/FIXME crítico, regra de preço conflitante,
wildcard CORS no código funcional ou logging sensível. Menções a wildcard existentes
nos documentos são registros históricos; as ocorrências nos testes são asserções de
negação. O Worker possui um único ponto de chamada a `getRoute` no fluxo de orçamento;
a outra ocorrência é a definição da função. Os dois logs são JSON controlado de
telemetria e erro, sem dados pessoais.

O backend continua sendo autoridade de preço: campos extras são ignorados e todos os
valores oficiais são derivados do ambiente, geocoding, routing e regras internas.

## Correções realizadas

- validação do schema completo do ponto lido do cache (`lat`, `lon`, `city` e
  `localities`) antes de confiar no item;
- rejeição de distância total negativa e de legs negativos do routing.

## Regressões verificadas

Não foram alterados: tarifas, limites, `Math.ceil`, classificação por município,
regiões especiais, `SHORT`/`BALANCED`, `motorcycle`, circuito, TTL, compatibilidade
legada, novo formato, nem a regra de arredondar cada entrega antes da soma.

## Dependências externas ainda pendentes

### Cloudflare real

- confirmar no ambiente publicado os valores secretos de `GEOAPIFY_API_KEY`,
  `BASE_LAT`, `BASE_LON`, `ENDERECO_BASE` e `ALLOWED_ORIGINS` sem registrá-los;
- executar smoke test do Cache API nos pontos de presença reais (cache é oportunista);
- confirmar bindings, logs, latência, limites e respostas reais da Geoapify;
- validar as origens oficiais definitivas, inclusive a decisão operacional sobre `www`.

Esses itens não foram executados porque a Fase 8 proíbe deploy e chamadas reais.

### Frontend real

- validar a integração do formato legado e de `deliveries[]` com a versão efetivamente
  publicada do frontend;
- confirmar exibição de preços, remoção/ordem de entregas e conteúdo do WhatsApp;
- executar teste ponta a ponta de CORS nas origens oficiais.

O frontend não está presente neste repositório e não foi alterado.

## Conclusão

**O backend está tecnicamente pronto para seguir à Fase 9 sob o escopo validável em
ambiente local**, pois não há falha conhecida e todas as 96 verificações passam. Isso
não equivale a deploy nem aprovação da produção: o congelamento deve aguardar a
validação operacional das pendências de Cloudflare e frontend acima. Nenhum deploy,
merge ou trabalho de Fase 9 foi realizado.

## Verificação final

- `node --check worker.js`: aprovado.
- `node --test worker.test.mjs`: 96 aprovados, 0 falhas.
- `git diff --check`: aprovado.
