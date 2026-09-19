# Fase 0 — Auditoria

A auditoria foi executada **somente em modo de leitura**. Nenhum arquivo foi alterado, nenhuma credencial real foi utilizada e, conforme a regra expressa da Fase 0, não houve commit, PR, deploy ou avanço para a Fase 1. O repositório continuou limpo durante a auditoria.

## 1. Arquitetura atual

### Componentes encontrados

O repositório contém apenas:

- `worker.js`: backend HTTP implementado como um Cloudflare Worker.
- `PLANO-MESTRE-PRODUCAO-V1.md`: especificação e sequência das fases.

Não há frontend, configuração de implantação, manifesto do Worker, suíte de testes ou dependências versionadas no repositório. O próprio plano descreve um frontend externo com calculadora, orçamento e integração com WhatsApp, mas esse código não está disponível para inspeção.

### Backend

O Worker:

1. Aceita requisições `OPTIONS` e `POST`.
2. Responde ao preflight com HTTP `204`.
3. Rejeita outros métodos com HTTP `405`.
4. Depende de:
   - `env.GEOAPIFY_API_KEY`;
   - `env.ENDERECO_BASE`.
5. Recebe coleta e entrega em JSON.
6. Geocodifica base, coleta e entrega.
7. Classifica a entrega como interna ou externa a São Bento do Sul.
8. Pretende consultar rotas `short`, `balanced` e uma terceira rota sem retorno à base.
9. Retorna distâncias e coordenadas, mas **não calcula preço**.

O CORS permanece aberto com `Access-Control-Allow-Origin: "*"`, como previsto para esta etapa.

---

## 2. Fluxo atual da requisição

### Fluxo nominal

1. **Preflight**
   - `OPTIONS` retorna `204`, sem corpo.

2. **Validação do método**
   - Qualquer método diferente de `POST` e `OPTIONS` retorna:
     ```json
     { "error": "Método não permitido." }
     ```
     com HTTP `405`.

3. **Validação do ambiente**
   - Ausência de `GEOAPIFY_API_KEY`: HTTP `500`.
   - Ausência de `ENDERECO_BASE`: HTTP `500`.

4. **Leitura do corpo**
   - JSON malformado: HTTP `400`.
   - `pickup` ou `delivery` ausentes/vazios: HTTP `400`.

5. **Geocodificação**
   - São disparadas, em paralelo, três chamadas Geoapify:
     - endereço-base;
     - coleta;
     - entrega.

6. **Validação dos resultados**
   - Base não encontrada: HTTP `422`.
   - Coleta não encontrada: HTTP `422`.
   - Entrega não encontrada: HTTP `422`.

7. **Classificação geográfica**
   - A cidade da entrega é normalizada, removendo acentos e convertendo para minúsculas.
   - Somente o valor exato `sao bento do sul` é tratado como local.
   - Qualquer outro valor, inclusive cidade vazia, é classificado como externo.

8. **Roteamento**
   - O código pretende consultar:
     - circuito completo `short`;
     - circuito completo `balanced`;
     - percurso BASE → COLETA → ENTREGA em `short`.

9. **Resposta**
   - Devido ao bug atual, o Worker retorna HTTP `502` com:
     ```json
     { "error": "Não foi possível calcular a rota." }
     ```
     mesmo quando as três consultas Geoapify de roteamento são bem-sucedidas.

10. **Falhas inesperadas**
    - Exceções são escritas com `console.error`.
    - O cliente recebe HTTP `500` e uma mensagem genérica.

---

## 3. Diagnóstico do bug

### **CRÍTICO — `Promise.all` recebe um array vazio**

A atribuição atual é:

```js
const [route, routeBalanced, routeOneWay] = await Promise.all([])
```

Assim, o `Promise.all` resolve imediatamente para `[]`, deixando as três variáveis como `undefined`.

As chamadas `getRoute(...)` aparecem depois do encerramento dessa instrução e não fazem parte do array do `Promise.all`. Elas são avaliadas como uma expressão separada, sem `await` e sem utilização dos resultados.

Consequências confirmadas:

- `route === undefined`;
- `routeBalanced === undefined`;
- `routeOneWay === undefined`;
- a condição `if (!route)` é sempre verdadeira;
- o Worker sempre responde HTTP `502` após uma geocodificação bem-sucedida;
- mesmo assim, as três chamadas de roteamento são iniciadas;
- os resultados são descartados;
- rejeições dessas Promises podem tornar-se rejeições não tratadas;
- há consumo e latência desnecessários na Geoapify, embora a resposta de erro não aguarde as rotas.

O teste controlado com `fetch` simulado confirmou:

- 3 chamadas de geocodificação;
- 3 chamadas de roteamento;
- resposta final HTTP `502`;
- mensagem `Não foi possível calcular a rota.`

O diagnóstico coincide com o bug documentado no plano.

### **ALTO — Falta de testes automatizados permitiu uma regressão sintaticamente válida**

`node --check worker.js` passa, pois o arquivo é sintaticamente válido. O problema é semântico: a inserção automática de ponto e vírgula separa a atribuição das chamadas subsequentes.

Não existe suíte de testes no repositório para validar:

- quantidade de chamadas à Geoapify;
- parâmetros `type` e `mode`;
- circuito dos waypoints;
- status e corpo retornados;
- escolha entre `short` e `balanced`.

---

## 4. Chamadas Geoapify e orçamento

### Geocodificação

Cada requisição válida dispara três consultas paralelas ao endpoint:

```text
https://api.geoapify.com/v1/geocode/search
```

Parâmetros:

- `text`: endereço;
- `format=json`;
- `limit=1`;
- `filter=countrycode:br`;
- `apiKey`: chave recebida pelo ambiente.

O primeiro resultado é convertido em:

```js
{
  lat,
  lon,
  city
}
```

A cidade usa, em ordem de preferência, `city`, `county` ou `municipality`.

### Roteamento

O helper consulta:

```text
https://api.geoapify.com/v1/routing
```

com:

- `waypoints` no formato `lat,lon|lat,lon|...`;
- `mode=motorcycle`;
- `type=short` por padrão, ou o tipo fornecido;
- `details=instruction_details`;
- `apiKey`.

O Worker extrai apenas `features[0].properties.distance`, converte metros para quilômetros e arredonda para uma casa decimal. Nenhuma informação de `legs`, `segments` ou instruções é preservada.

### Volume atual por requisição válida

- 3 chamadas de geocodificação;
- 3 chamadas de roteamento iniciadas;
- total: **6 chamadas externas**.

Embora o Worker responda antes de aguardar as rotas, isso não impede que os três `fetch` já iniciados consumam recursos.

### Orçamento

### **CRÍTICO — Não há motor de preços no código disponível**

O Worker atual:

- não recebe tabela de tarifas;
- não identifica Rio Vermelho Povoado, Rio Vermelho Estação ou Rio Natal;
- não calcula preço local;
- não calcula preço externo;
- não aplica `Math.ceil`;
- não retorna preço;
- não oferece múltiplas entregas.

Ele retorna somente distâncias e coordenadas.

Portanto, não é possível auditar o cálculo atualmente usado no frontend nem a identificação legada das regiões especiais. O frontend mencionado pelo plano não existe no repositório. A migração comercial deve permanecer fora da Fase 1, como determina a sequência do plano.

---

## 5. Contrato de entrada

### Método

```http
POST
Content-Type: application/json
```

### Corpo aceito

```json
{
  "pickup": "endereço de coleta",
  "delivery": "endereço de entrega"
}
```

Ambos são convertidos com `String(...)` e passam por `trim()`.

### Observações

- Campos adicionais são ignorados.
- Não existe limite de comprimento.
- Valores não textuais são convertidos:
  - números tornam-se strings;
  - objetos tornam-se `"[object Object]"`;
  - arrays tornam-se strings separadas por vírgulas.
- Não há contrato para múltiplas entregas.
- A base não é recebida do cliente; vem de `env.ENDERECO_BASE`.

### Variáveis obrigatórias

```text
GEOAPIFY_API_KEY
ENDERECO_BASE
```

Nenhum valor real dessas variáveis está versionado. As únicas referências encontradas usam `env`.

---

## 6. Contrato de saída

### Sucesso pretendido — HTTP `200`

```json
{
  "ok": true,
  "oneWayKm": 0,
  "distanceKm": 0,
  "distanceKmBalanced": 0,
  "km": 0,
  "distance": 0,
  "distance_km": 0,
  "base": {
    "lat": 0,
    "lon": 0
  },
  "pickup": {
    "lat": 0,
    "lon": 0
  },
  "delivery": {
    "lat": 0,
    "lon": 0
  }
}
```

Esse contrato está implementado, mas atualmente é inalcançável depois de uma geocodificação bem-sucedida por causa do bug crítico.

Sem o bug:

- `distanceKm`: circuito `short`;
- `distanceKmBalanced`: circuito `balanced`, ou `null`;
- `oneWayKm`: terceira rota `short`, ou `null`;
- `km`:
  - entrega local: `distanceKm`;
  - entrega externa: `distanceKmBalanced`, com fallback para `distanceKm`;
- `distance` e `distance_km`: aliases de `distanceKm`.

### Erros observados

| Status | Condição |
|---|---|
| `400` | JSON inválido |
| `400` | coleta ou entrega ausente |
| `405` | método não permitido |
| `422` | base, coleta ou entrega não localizada |
| `500` | variável de ambiente ausente |
| `500` | exceção inesperada/erro Geoapify aguardado |
| `502` | rota principal ausente; atualmente ocorre sempre após geocodificação válida |

Todas as respostas JSON recebem `Content-Type: application/json; charset=UTF-8`, `Cache-Control: no-store` e os cabeçalhos CORS.

---

## 7. Compatibilidade

### **ALTO — Frontend indisponível para inspeção**

O plano exige localizar os consumidores antes de remover ou renomear campos. Entretanto, o histórico completo do repositório contém somente o plano e `worker.js`; não existe código do frontend para confirmar o contrato efetivamente consumido.

Campos potencialmente compatíveis já existentes:

- Entrada:
  - `pickup`;
  - `delivery`.
- Saída:
  - `km`;
  - `distance`;
  - `distance_km`;
  - `distanceKm`;
  - `distanceKmBalanced`;
  - `oneWayKm`;
  - `base`;
  - `pickup`;
  - `delivery`.

### Recomendação de compatibilidade para a Fase 1

- Não renomear nem remover campos.
- Manter `distance`, `distance_km`, `distanceKm` e `distanceKmBalanced`.
- Manter o campo `oneWayKm` no JSON, mas sem inventar um valor:
  - como a terceira rota deve ser removida na Fase 1;
  - e o cálculo correto só será tratado na Fase 3;
  - o valor mais seguro temporariamente é `null`.
- Não adicionar preço.
- Não alterar CORS.
- Não alterar regras de arredondamento ou classificação comercial.

---

## 8. Achados e riscos classificados

### CRÍTICO

1. **Todas as requisições válidas terminam em HTTP `502`** porque `route` é sempre `undefined`.
2. **O backend não é atualmente uma autoridade de preço**, pois nenhum preço é calculado ou retornado. Isso deverá ser resolvido somente na fase comercial correspondente.

### ALTO

1. **Três chamadas de roteamento são iniciadas e descartadas**, aumentando consumo e podendo gerar rejeições não tratadas.
2. **O frontend não está disponível**, impedindo validar os aliases usados, o formato do orçamento e a identificação legada das regiões especiais.
3. **Não há testes automatizados**, apesar de o bug ser sintaticamente válido.
4. **A classificação depende somente da cidade da entrega**, não da coleta nem de uma validação territorial mais robusta.

### MÉDIO

1. **Correspondência exata da cidade:** resultados como cidade vazia, variante inesperada ou município presente em outro campo são classificados como externos.
2. **`ENDERECO_BASE` contendo apenas espaços passa na validação inicial**, pois a checagem ocorre antes do `trim()`.
3. **Entrada sem limite ou validação de tipo:** objetos e arrays podem ser enviados à geocodificação após coerção para string.
4. **A resposta expõe coordenadas da base**, embora o comentário diga que ela fica protegida no Cloudflare.
5. **A chave Geoapify está no query string**, podendo aparecer em telemetria de rede ou logs de infraestrutura; nenhum valor real está no código.
6. **O Worker pede `instruction_details`, mas descarta os detalhes**, aumentando potencialmente o tamanho da resposta Geoapify sem benefício atual.

### BAIXO

1. **`console.error(error)` registra a exceção completa**, o que deve ser revisto antes da produção final para evitar telemetria excessiva.
2. **Não há timeout explícito** para chamadas Geoapify.
3. **Não há cache** de geocodificação ou rotas.
4. **O código apresenta indentação extremamente excessiva**, dificultando revisão e manutenção. A Fase 1 não deve misturar uma reformatação ampla com a correção funcional.

### INFORMATIVO

1. O modo de transporte já está corretamente fixado como `motorcycle`.
2. O circuito completo pretendido está correto: BASE → COLETA → ENTREGA → BASE.
3. A função de rota arredonda a distância para uma casa decimal antes de devolvê-la.
4. O CORS aberto está coerente com a orientação de não alterá-lo na restauração inicial.
5. Não foram encontrados secrets reais versionados.
6. O arquivo passa na verificação sintática; isso reforça que o defeito é comportamental, não sintático.

---

## 9. Regressões a preservar e validar

A futura restauração deve cobrir os casos de referência definidos pelo plano:

| Caso | Classificação esperada | Rota relevante |
|---|---|---|
| Centro, São Bento do Sul | Local | `short`, aproximadamente 10,0 km |
| Serra Alta | Local comum, não Rio Vermelho | `short`, aproximadamente 24,1 km |
| Cruzeiro | Local | `short`, aproximadamente 27,0 km |
| Rio Natal | Local especial | `short`, aproximadamente 17,1 km |
| Campo Alegre | Externo | `balanced`, aproximadamente 30,2 km |
| Joinville | Externo | `balanced`, aproximadamente 147,5 km |

Na Fase 1, os testes devem validar **seleção e retorno das rotas**, não tarifas, regiões especiais ou preço. A classificação comercial de Rio Natal e demais especiais pertence às fases posteriores.

---

## 10. Plano proposto para a Fase 1

Sem executar ainda:

1. Alterar exclusivamente o bloco de roteamento.
2. Colocar no `Promise.all` somente:
   - circuito completo `short`;
   - circuito completo `balanced`.
3. Remover a terceira chamada BASE → COLETA → ENTREGA.
4. Ajustar a desestruturação para somente `route` e `routeBalanced`.
5. Preservar `mode: "motorcycle"`.
6. Preservar todos os campos de compatibilidade.
7. Manter `oneWayKm: null` temporariamente, sem inferir que seja metade do circuito.
8. Não alterar:
   - tarifas;
   - classificação comercial;
   - arredondamento de preço;
   - CORS;
   - múltiplas entregas;
   - frontend;
   - estrutura geral do Worker.
9. Adicionar um teste controlado com `fetch` simulado para comprovar:
   - 3 geocodificações;
   - exatamente 2 rotas;
   - `short` e `balanced`;
   - circuito com quatro waypoints em ambas;
   - ausência da terceira rota;
   - resposta HTTP `200`;
   - aliases de distância preservados;
   - `oneWayKm` sem valor inventado.
10. Executar as regressões geográficas, caso sejam fornecidos ambiente e chave de teste seguros.

---

## 11. Arquivos a alterar na Fase 1

- **Obrigatório:** `worker.js`.
- **Recomendado:** um novo arquivo de teste isolado para o Worker, caso a autorização da Fase 1 permita acrescentar infraestrutura mínima de testes.
- **Não alterar:** `PLANO-MESTRE-PRODUCAO-V1.md`.
- **Frontend:** nenhum arquivo pode ser indicado porque não existe frontend neste repositório.

---

## 12. Critérios de aprovação da Fase 1

A Fase 1 poderá ser considerada aprovada quando:

1. Uma requisição válida não retornar mais `502` por `route` indefinida.
2. Forem feitas exatamente duas chamadas de roteamento.
3. Ambas usarem o circuito:
   ```text
   BASE → COLETA → ENTREGA → BASE
   ```
4. Uma chamada usar `type=short`.
5. A outra usar `type=balanced`.
6. Ambas usarem `mode=motorcycle`.
7. Não existir chamada BASE → COLETA → ENTREGA isolada.
8. O retorno local usar a distância `short` em `km`.
9. O retorno externo usar a distância `balanced` em `km`, preservando o fallback existente.
10. `distance`, `distance_km`, `distanceKm` e `distanceKmBalanced` continuarem disponíveis.
11. `oneWayKm` não for calculado como circuito dividido por dois.
12. Nenhuma tarifa ou regra comercial for introduzida.
13. CORS continuar inalterado.
14. Os erros de entrada, geocodificação e método continuarem compatíveis.
15. Nenhum secret real for adicionado ao repositório.

## Verificações executadas

- ✅ `node --check worker.js`
- ✅ `git ls-files`
- ✅ `git status --short`
- ✅ `git diff --check`
- ✅ `rg -n --no-heading 'Promise\.all|routeOneWay|getRoute|GEOAPIFY|ENDERECO_BASE|pickup|delivery|distanceKm|distance_km|oneWayKm|Access-Control|console\.error|price|pre[cç]o|Rio Vermelho|Rio Natal' worker.js PLANO-MESTRE-PRODUCAO-V1.md`
- ✅ `git log --all --name-only --pretty=format: | sed '/^$/d' | sort -u`
- ✅ `rg -n '(api[_-]?key|token|secret|ENDERECO_BASE)\s*[:=]\s*["'"'][^"'"']+["'"']' . --glob '!PLANO-MESTRE-PRODUCAO-V1.md' || true`
- ✅ `node --input-type=module <<'EOF' … EOF` — teste controlado com `fetch` simulado confirmou HTTP `502`, 3 geocodificações e 3 chamadas de rota descartadas.
- ✅ `git status --short --branch` — árvore de trabalho permaneceu limpa (`## work`).

Nenhum commit ou pull request foi criado durante a auditoria porque a Fase 0 determina explicitamente **somente leitura** e não havia alteração a registrar naquele momento.
