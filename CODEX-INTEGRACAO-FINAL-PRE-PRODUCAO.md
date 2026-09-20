# CODEX — INTEGRAÇÃO FINAL PRÉ-PRODUÇÃO

## Projeto
Fonseca Logística — Production V1

Repositório: `feeehfooonseca-bot/Fonseca-Logistica-Producao`  
Branch base: `principal`

## Contexto

As Fases 0–8 do plano de produção já foram executadas.

O repositório contém o frontend oficial V1.7.3:
- `index.html`
- `TESTE-LOCAL-CELULAR.html`
- `robots.txt`
- `sitemap.xml`
- `assets/images/*`
- `familia-fonseca-v1.png`

O frontend V1.7.3 é o **BASELINE VISUAL CONGELADO**.

### Regra absoluta
NÃO alterar layout, identidade visual, fotografias, textos institucionais, tipografia, cores, espaçamentos, efeitos, máscaras, gradientes, responsividade visual ou composição sem autorização explícita.

Não redesenhar, não “melhorar” e não refatorar CSS por preferência.

O objetivo agora é concluir a integração funcional e preparar a Production V1.

## Estado do backend

O Worker é a autoridade oficial para geocodificação, roteamento, classificação local/viagem, distância, preço, arredondamento e múltiplas entregas.

O frontend NÃO deve recalcular essas regras.

### Arquitetura implementada

1. Circuito: Base → Coleta → Entrega → Base.

2. `oneWayKm`: Base → Coleta → Entrega, obtido das pernas reais da rota. Nunca calcular como metade do circuito.

3. Classificação:
- coleta E entrega dentro de São Bento do Sul = local;
- coleta OU entrega fora de São Bento do Sul = viagem.

4. Routing:
- local = Geoapify `type: short`;
- externo = Geoapify `type: balanced`;
- `mode: motorcycle`.

5. Regra local comum:
- até 12 km one-way = R$15;
- acima de 12 km = `15 + ((oneWayKm - 12) × 1,10)`.

6. Regiões especiais:
- Rio Vermelho Povoado: R$20, 8 km incluídos, excedente R$1,10/km;
- Rio Vermelho Estação: R$25, 12 km incluídos, excedente R$1,10/km;
- Rio Natal: R$30, 16 km incluídos, excedente R$1,10/km.

7. Viagem: R$1,10/km sobre o circuito total.

8. Arredondamento: `Math.ceil(valor)`. Cada entrega é calculada e arredondada individualmente antes da soma.

9. Múltiplas entregas: aceitar `{ pickup, delivery }` e `{ pickup, deliveries: [...] }`. Cada entrega deve possuir classificação, rota, preço e arredondamento independentes. A ordem da resposta acompanha a entrada. Uma entrega não pode aumentar a quilometragem tarifada de outra.

10. Segurança:
- `GEOAPIFY_API_KEY` nunca exposta ao frontend;
- `ENDERECO_BASE` protegido;
- `BASE_LAT`/`BASE_LON` opcionais;
- `ALLOWED_ORIGINS` por correspondência exata;
- sem wildcard CORS;
- Origin não permitido → 403 antes de Geoapify;
- requests server-to-server sem Origin permitidos;
- cliente não pode sobrescrever preço, tarifa, distância, coordenadas, base, classificação, routeType ou mode;
- erros/logs sanitizados;
- nenhuma coordenada protegida da base na resposta.

11. Performance:
- cache somente de geocodificação via `caches.default`;
- chave normalizada + SHA-256;
- TTL 24h;
- sem cache de rota;
- deduplicação de geocodificação na mesma requisição;
- `BASE_LAT`/`BASE_LON` válidos evitam geocodificação da base;
- fallback para `ENDERECO_BASE`.

12. Telemetria somente agregada/técnica:
`deliveryCount`, `geocodingCalls`, `routingCalls`, cache hits/misses, `technicalErrors`, `durationMs`. Nunca registrar endereços, coordenadas, API keys ou PII.

## Fase 8

Estado conhecido da suíte pré-produção: **96 testes, 96 aprovados, 0 falhas**.

A Fase 8 adicionou:
- validação mais rígida de cached geocode point;
- rejeição de distância total negativa;
- rejeição de distâncias negativas nas pernas da rota.

Não remover essas proteções.

## Objetivo desta tarefa

Executar uma **AUDITORIA DE INTEGRAÇÃO FRONTEND ↔ WORKER** antes de qualquer alteração.

Primeiro:

1. Leia:
- `PLANO-MESTRE-PRODUCAO-V1.md`
- `AUDITORIA-FASE-0.md`
- `FASE-6-OTIMIZACAO.md`
- `FASE-7-SEGURANCA.md`
- `FASE-8-VALIDACAO-PRE-PRODUCAO.md`
- `worker.js`
- `worker.test.mjs` (ou o nome equivalente existente no repositório)
- `index.html`

2. Identifique como o frontend V1.7.3 atualmente chama o backend.

3. Verifique especificamente:
- endpoint configurado;
- payload enviado;
- uma entrega;
- múltiplas entregas;
- parsing da resposta;
- exibição de preço;
- exibição de distância;
- tratamento de erro;
- botão “+ Adicionar outra entrega”;
- remoção/limpeza de entregas;
- fluxo para WhatsApp;
- qualquer cálculo de tarifa residual no navegador.

4. Verifique se frontend e Worker possuem contrato compatível.

5. Rode toda a suíte existente antes de modificar qualquer coisa.

## Regras de execução

- NÃO iniciar a Fase 9.
- NÃO fazer deploy.
- NÃO alterar secrets/Cloudflare.
- NÃO inventar URL do Worker.
- NÃO colocar API key no frontend.
- NÃO alterar o baseline visual V1.7.3.
- NÃO alterar regras comerciais sem autorização.
- NÃO substituir/remover funcionalidades existentes.
- NÃO fazer grandes refatorações desnecessárias.
- NÃO tocar em fotografia/assets visuais.

Se encontrar problema, explique causa, arquivo/trecho afetado e proponha a menor correção segura.

Antes de editar, produza relatório curto:
A. Estado atual da integração  
B. O que já está correto  
C. Problemas encontrados  
D. Correções realmente necessárias  
E. Testes que serão executados  
F. Riscos para o baseline V1.7.3

Depois implemente SOMENTE correções indispensáveis para compatibilidade frontend/Worker.

## Validação obrigatória

Após correções:
- rode novamente toda a suíte do Worker;
- valide sintaxe JavaScript do frontend;
- valide uma entrega;
- valide múltiplas entregas;
- valide ordem das entregas;
- valide cálculo individual;
- valide soma final;
- valide tratamento de erro;
- valide que nenhum cálculo comercial ficou duplicado no frontend;
- valide que nenhum secret foi exposto;
- valide referências de assets;
- valide `robots.txt`;
- valide `sitemap.xml`;
- valide canonical/SEO;
- confirme baseline visual V1.7.3 intacto.

Se possível sem credenciais reais, adicione testes determinísticos/mocks do contrato frontend ↔ Worker.

Não fazer chamadas externas pagas desnecessárias.

## Git

- Não trabalhar diretamente no branch `principal`.
- Criar branch específica.
- Alterações pequenas e auditáveis.
- Abrir Pull Request.
- Informar no PR arquivos alterados, motivo, testes executados, quantidade aprovada/falha, confirmação de visual V1.7.3 intacto, confirmação de nenhum secret e pendências de configuração/teste real no Cloudflare.
- **NÃO fazer merge automático.**
- Parar após abrir o PR e aguardar revisão.

## Critério de saída

A tarefa termina quando:
1. frontend V1.7.3 e Worker estiverem contratualmente compatíveis;
2. testes automatizados verdes;
3. nenhum secret exposto;
4. nenhuma regra de preço duplicada no frontend;
5. múltiplas entregas preservadas;
6. visual V1.7.3 intacto;
7. PR aberto e NÃO mergeado;
8. documentado o que depende de `ALLOWED_ORIGINS`, `BASE_LAT/BASE_LON` se usados, URL real do Worker, deploy Cloudflare e teste end-to-end real.

**NÃO declarar Production V1 concluída. NÃO executar Fase 9. NÃO fazer merge.**

Ao terminar, fornecer número/link do PR e resumo objetivo para revisão.
