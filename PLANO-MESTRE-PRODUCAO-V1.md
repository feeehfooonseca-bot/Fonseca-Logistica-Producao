# Plano Mestre — Fonseca Logística — Produção V1

## Regra de execução
Trabalhar uma fase por vez. Não avançar sem autorização explícita. Preservar comportamento validado. Nunca gravar valores reais de GEOAPIFY_API_KEY, ENDERECO_BASE, tokens ou secrets; referências env.GEOAPIFY_API_KEY e env.ENDERECO_BASE são permitidas.

## Prioridade do projeto e preparação para escala
A prioridade absoluta da Produção V1 é a operação real da **Fonseca Logística** e o funcionamento correto, rápido, seguro e econômico do seu site. Não introduzir complexidade, abstrações ou funcionalidades apenas para atender um SaaS futuro.

Ao mesmo tempo, quando duas soluções forem igualmente adequadas para a Fonseca Logística, preferir a que seja mais modular, configurável e reaproveitável no futuro, sem aumentar risco, custo ou escopo atual. Estruturar responsabilidades de forma clara (geocodificação → classificação → roteamento → precificação → orçamento), centralizar regras/configurações quando isso beneficiar a operação atual e evitar regras comerciais espalhadas.

O SaaS é uma etapa posterior e não faz parte do escopo da Produção V1. Não implementar agora multi-tenant, cadastro de outros motoboys, planos, assinaturas, cobrança, painel SaaS ou personalização por cliente.

## Regra transversal de eficiência
Em todas as fases, além dos critérios funcionais, avaliar o custo operacional por orçamento: quantidade de chamadas externas, possibilidade de reutilização/cache, trabalho redundante e impacto de latência. Reduzir consumo da Geoapify sempre que isso puder ser feito sem comprometer precisão, segurança, comportamento validado ou ampliar indevidamente a fase. Otimizações maiores permanecem na Fase 6.

## Arquitetura
Frontend: site/calculadora, coleta/entrega, orçamento e WhatsApp. Backend: Cloudflare Worker (worker.js) + Geoapify. O backend será a fonte oficial do preço. Manter mode: "motorcycle".

Circuito completo: BASE → COLETA → ENTREGA → BASE. Dentro de São Bento do Sul: type "short". Fora: type "balanced".

## Bug atual conhecido
O worker.js contém estrutura equivalente a `const [route, routeBalanced, routeOneWay] = await Promise.all([])` seguida das chamadas getRoute. Assim route fica undefined e retorna "Não foi possível calcular a rota." Na Fase 1, restaurar Promise.all e remover a terceira chamada routeOneWay, sem misturar mudanças comerciais.

## oneWayKm
Definição oficial: BASE → COLETA → ENTREGA. Não é metade do circuito. Preferir derivar dos legs/segmentos da rota principal, se possível, evitando terceira chamada.

## Tarifas
Local comum em São Bento do Sul: até 12 km de oneWayKm = R$15; acima: R$15 + (oneWayKm - 12) × R$1,10.

Especiais a preservar: Rio Vermelho Povoado: R$20, limite de circuito 8 km, excedente R$1,10/km. Rio Vermelho Estação: R$25, limite 12 km, excedente R$1,10/km. Rio Natal: R$30, limite 16 km, excedente R$1,10/km. Antes da migração, localizar como o frontend legado identifica essas regiões.

Fora de São Bento do Sul: BALANCED no circuito completo; R$1,10 × km total. Não usar oneWayKm.

Arredondamento Produção V1: `Math.ceil(valor)`. Qualquer centavo sobe para o próximo real inteiro. Não usar `Math.ceil(valor * 2) / 2`. Em múltiplas entregas, arredondar cada entrega antes da soma.

## Múltiplas entregas
Cada entrega é precificada individualmente e pode ser removida. Para cada uma: geocodificar, classificar (local comum/especial/externa), determinar distância, calcular preço e arredondar. Somar somente preços finais. Uma entrega não aumenta a quilometragem tarifada de outra.

## Backend como autoridade
Worker calcula rota, classificação, tarifa e arredondamento e retorna preço oficial. Frontend envia dados, recebe/exibe orçamento e prepara WhatsApp. Alterações locais no DOM/JS não podem mudar o preço oficial.

## Compatibilidade
Antes de remover/renomear campos, localizar uso no frontend. Podem existir: pickup, delivery, km, distance, distance_km, distanceKm, distanceKmBalanced.

## CORS
Atualmente `Access-Control-Allow-Origin: "*"`. Não alterar na restauração inicial. Antes da produção final, restringir às origens oficiais realmente usadas, verificando fonsecalog.com.br e eventual www.

## Otimização futura
Evitar terceira rota; classificar local/externo antes do routing; local somente SHORT; externo somente BALANCED; avaliar coordenadas protegidas da base, cache de geocoding/rotas, tratamento de falhas e telemetria sem dados pessoais desnecessários.

## Regressões conhecidas
Coleta: Rua Dr. Hans Dieter Schmidt, 879, Centenário, São Bento do Sul - SC, 89283-105.
Centro SBS: Rua Jorge Lacerda, 75, Centro, São Bento do Sul - SC, 89280-110. SHORT ≈10,0; BALANCED ≈10,8; usar SHORT.
Serra Alta: Estrada Conrado Liebl, 5000, Serra Alta, São Bento do Sul - SC, 89291-220. SHORT ≈24,1. É Serra Alta, não Rio Vermelho.
Cruzeiro: Estrada Cruzeiro, 2600, Cruzeiro, São Bento do Sul - SC, 89286-060. SHORT ≈27,0.
Rio Natal: Estrada Floresta, s/n, Rio Natal, São Bento do Sul - SC, 89293-899. SHORT ≈17,1; preservar especial.
Campo Alegre: Rua Coronel Bueno Franco, 292, Centro, Campo Alegre - SC, 89294-000. SHORT ≈27,2; BALANCED ≈30,2; externo/BALANCED.
Joinville: Rua XV de Novembro, 700, Centro, Joinville - SC, 89201-602. SHORT ≈144,3; BALANCED ≈147,5; externo/BALANCED.

## Fases
### Fase 0 — Auditoria
Somente leitura. Entregar: arquitetura atual; fluxo da requisição; diagnóstico do bug; chamadas Geoapify/orçamento; contratos de entrada/saída; compatibilidade; riscos; regressões; plano da Fase 1; arquivos a alterar; testes de aprovação. Classificar achados CRÍTICO/ALTO/MÉDIO/BAIXO/INFORMATIVO. Não alterar nada.

### Fase 1 — Restaurar Worker
Corrigir exclusivamente Promise.all; remover terceira chamada routeOneWay; restaurar SHORT + BALANCED validado; nenhuma alteração comercial; testar regressão.

### Fase 2 — Otimizar seleção de rota
Classificar local/externo antes do routing. Local somente SHORT; externo somente BALANCED; manter motorcycle; testar.

### Fase 3 — oneWayKm
Obter BASE → COLETA → ENTREGA preferencialmente sem terceira chamada; investigar legs/segments; nunca circuito/2; testar.

### Fase 4 — Motor de preços no backend
Migrar cálculo oficial. Implementar local comum, especiais, externo e arredondamento inteiro. Testar.

### Fase 5 — Múltiplas entregas
Contrato para várias entregas; classificação/distância/preço/arredondamento independentes; somar preços finais; testar.

### Fase 6 — Otimização
Coordenadas protegidas da base, cache, redução de chamadas, falhas e telemetria.

### Fase 7 — Segurança
Restringir CORS, revisar secrets/respostas/logs, confirmar backend como autoridade e ausência de chaves expostas.

### Fase 8 — Teste final
Centro SBS, Serra Alta, Cruzeiro, Rio Natal, Campo Alegre, Joinville, múltiplas entregas, endereço inválido, falha Geoapify e entradas inválidas.

### Fase 9 — Congelamento
Após aprovação final: FONSECA LOGÍSTICA — PRODUÇÃO V1.

## Instrução inicial ao Codex
Ao receber este plano pela primeira vez, execute SOMENTE A FASE 0. Não altere arquivos, não faça commit/PR/deploy, não configure Actions/Codespaces e não avance sem autorização explícita.
