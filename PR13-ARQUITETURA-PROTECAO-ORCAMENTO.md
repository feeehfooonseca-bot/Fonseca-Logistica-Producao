# PR #13 — Arquitetura de proteção de orçamento

## Escopo

Esta fase adiciona proteção criptográfica e persistência somente no momento da solicitação, sem alterar tarifas, geocoding, routing, classificação, arredondamento, `sharedTrips`, limite de 20 entregas ou qualquer regra comercial já aprovada.

O Worker continua sendo a única autoridade de cálculo.

## Estado auditado antes da implementação

- o Worker atual é stateless;
- não existem KV, D1 ou Durable Objects no fluxo atual;
- não existe configuração Wrangler versionada no repositório;
- o cálculo atual é feito por POST e o frontend consome `deliveries`, `sharedTrips` e `totalPrice`;
- a mensagem de WhatsApp é montada no frontend e, portanto, não pode ser tratada como comprovante;
- nenhuma simulação deve ser persistida apenas por ter sido calculada.

## Arquitetura decidida

### 1. Cálculo continua sem persistência

O cálculo existente deve continuar executando exatamente as mesmas regras.

Após obter o orçamento oficial, o Worker gera uma prova temporária assinada quando `QUOTE_SIGNING_SECRET` estiver configurado.

A prova não contém uma fórmula comercial. Ela autentica um snapshot canônico do orçamento oficial e dos endereços usados no cálculo.

A prova deve conter, no mínimo:

- versão do formato;
- `jti` aleatório;
- horário de emissão;
- horário de expiração;
- hash SHA-256 do snapshot canônico;
- assinatura HMAC-SHA-256 usando `QUOTE_SIGNING_SECRET`.

O snapshot canônico deve abranger:

- coleta;
- destinos na ordem exata;
- dados oficiais necessários de `deliveries`;
- `sharedTrips`;
- `totalPrice`;
- distância oficial total derivada exclusivamente da resposta do Worker.

Não incluir secrets nem coordenadas da base.

### 2. Alteração de rota invalida a prova

Na confirmação, o Worker recebe a prova e o snapshot correspondente.

Ele recalcula apenas o hash canônico localmente e valida a assinatura/expiração.

Ele NÃO deve refazer geocoding, routing nem recalcular tarifa na confirmação.

Se coleta, qualquer destino, ordem dos destinos, preço, distância, classificação ou grupo compartilhado tiver sido alterado, o hash não corresponde e a confirmação é rejeitada.

Assim, o backend também protege contra frontend adulterado, além da invalidação visual que será implementada na PR #14.

### 3. Persistência somente ao solicitar

Somente o endpoint de confirmação cria registro persistente.

Binding previsto: `env.QUOTE_DB` (Cloudflare D1).

Não usar KV como armazenamento autoritativo desta etapa.

Motivo arquitetural: a verificação pode ocorrer imediatamente após a gravação e precisa evitar janela de consistência eventual. D1 também permite consultas futuras por origem/status sem transformar o cálculo em armazenamento permanente.

A ausência de `QUOTE_DB` deve fazer a confirmação falhar de forma controlada e fechada, sem afetar o endpoint de cálculo existente.

### 4. Identificadores

Cada solicitação persistida terá dois identificadores distintos:

1. Código humano curto
   - prefixo `FL-`;
   - caracteres sem ambiguidades;
   - gerado aleatoriamente;
   - UNIQUE no D1;
   - serve para conferência no WhatsApp/atendimento;
   - não deve ser usado sozinho como credencial pública para exibir endereços.

2. Token público de verificação
   - alta entropia criptográfica;
   - enviado no link de verificação;
   - armazenar somente SHA-256 do token no banco;
   - lookup público feito pelo hash;
   - não registrar o token bruto em logs.

### 5. Idempotência / clique duplo

O `jti` da prova temporária deve ser UNIQUE.

Se o mesmo orçamento protegido for confirmado duas vezes por clique duplo/retry, o endpoint deve retornar o registro já criado em vez de gerar uma segunda solicitação.

### 6. Rotas do Worker

Preservar compatibilidade do endpoint atual de cálculo.

Adicionar rotas explícitas sem quebrar o POST legado:

- `POST /` — cálculo atual, compatível;
- opcionalmente alias `POST /quote` — mesmo cálculo;
- `POST /quote/submit` — valida prova e persiste solicitação;
- `GET /quote/verify/:token` — página pública de verificação.

Paths desconhecidos devem retornar 404 controlado.

Métodos incompatíveis devem retornar 405 controlado.

### 7. Verificação pública

A URL deve ser derivada do origin real do Worker recebido na requisição, para funcionar tanto em `workers.dev` quanto em futuro domínio/route próprio sem URL hardcoded.

A página pública deve apresentar somente o necessário:

- código;
- coleta;
- destinos na ordem;
- distância oficial;
- valor oficial;
- horário da solicitação/agendamento quando disponível;
- validade;
- status.

Estados:

- 🟢 VÁLIDO — registro existente, status ativo e não expirado;
- 🟡 EXPIRADO — registro existente e validade ultrapassada;
- 🔴 INVÁLIDO / NÃO ENCONTRADO — token inexistente/malformado.

A página deve escapar qualquer conteúdo armazenado antes de gerar HTML.

Headers mínimos:

- `Content-Type: text/html; charset=UTF-8`;
- `Cache-Control: no-store`;
- CSP restritiva;
- `X-Content-Type-Options: nosniff`;
- proteção contra framing.

### 8. Dados complementares

O endpoint de confirmação pode aceitar dados que não alteram a tarifa, para a PR #14 integrar sem novo cálculo:

- nome;
- complemento/referência da coleta;
- complementos/referências das entregas;
- Agora/Agendar;
- data/hora agendada;
- item;
- Nota Fiscal Sim/Não;
- origem de campanha sanitizada.

Esses campos nunca participam da assinatura comercial de preço/rota.

Eles devem ter validação de tipo e limites de tamanho.

`origem` deve permitir somente conjunto pequeno de caracteres e comprimento limitado.

### 9. D1

Criar migration versionada, sem IDs/credenciais.

Tabela sugerida `protected_quotes` com:

- id;
- code UNIQUE;
- public_token_hash UNIQUE;
- quote_jti UNIQUE;
- status;
- created_at;
- expires_at;
- pickup;
- deliveries_json;
- official_quote_json;
- total_price;
- total_distance_km;
- source;
- customer_name;
- pickup_ref;
- delivery_refs_json;
- timing_mode;
- scheduled_at;
- item_description;
- invoice_required.

Status armazenado inicialmente: `active`.

`expired` é derivado por `expires_at`; não precisa de job.

### 10. Logs e privacidade

Não registrar:

- endereços;
- nome;
- complementos;
- token público bruto;
- prova assinada;
- snapshot completo;
- secret;
- coordenadas.

Telemetria pode registrar somente eventos técnicos e IDs internos não sensíveis, sem dados de rota.

### 11. Compatibilidade

Não alterar:

- RATE_PER_KM;
- SPECIAL_REGIONS;
- `calculatePrice`;
- modo `motorcycle`;
- tipos `short` / `balanced`;
- circuito;
- `sharedTrips`;
- limite de 20;
- geocoding v2;
- cache v2;
- CORS já aprovado;
- mensagens de erro sensíveis;
- frontend visual nesta PR.

A PR #14 será responsável por `activeQuote`, invalidação imediata na UI, Etapa 1/2, `/calcular`, origem de anúncio e geração final do WhatsApp.

## Validade

Usar 30 minutos como default para a prova/orçamento protegido.

A implementação pode aceitar variável de ambiente com limites seguros, mas deve existir default determinístico e testado.

## Testes obrigatórios da PR #13

Além de toda a suíte existente:

- cálculo sem D1 continua funcionando;
- cálculo gera prova válida quando secret configurado;
- prova adulterada é rejeitada;
- snapshot adulterado é rejeitado;
- coleta alterada rejeita;
- destino alterado rejeita;
- ordem alterada rejeita;
- preço alterado rejeita;
- `sharedTrips` alterado rejeita;
- prova expirada rejeita;
- secret ausente não permite confirmação;
- D1 ausente não permite confirmação;
- confirmação válida persiste uma vez;
- clique duplo retorna o mesmo registro;
- códigos não colidem sem retry seguro;
- token público bruto não é armazenado;
- verificação válida;
- verificação expirada;
- token inválido/não encontrado;
- escaping contra HTML/script;
- origem sanitizada;
- dados complementares não alteram preço;
- 20 entregas continuam aceitas;
- 21 continuam rejeitadas;
- todas as tarifas/regras comerciais permanecem inalteradas.

## Operação

- trabalhar somente nesta branch;
- nenhum merge;
- nenhum deploy;
- nenhum recurso Cloudflare real deve ser criado automaticamente nesta fase;
- migration e requisitos de binding devem ficar documentados;
- publicar relatório final de testes e auditoria diretamente na PR.
