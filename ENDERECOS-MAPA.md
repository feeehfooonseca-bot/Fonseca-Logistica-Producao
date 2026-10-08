# Endereços ausentes e confirmação no mapa

A calculadora buscava somente um candidato no Geoapify e recusava o endereço quando esse candidato não tinha precisão suficiente. Não havia seleção manual de localização. A alteração consulta até cinco candidatos e mantém os critérios de precisão existentes. Isso amplia a busca, mas não adiciona ruas ou números ausentes à base do provedor.

Quando a busca não resolve o endereço, cada coleta e entrega permite abrir um mapa OpenStreetMap, buscar uma rua ou cidade para orientar a navegação e marcar o ponto exato. Resultados de pesquisa não confirmam automaticamente um endereço: o usuário precisa selecionar o ponto. Também pode usar a localização do dispositivo, após autorizar o navegador, e ajustar o marcador.

O Worker valida as coordenadas e consulta o município e as localidades no Geoapify. Mantém as coordenadas escolhidas, sem substituí-las por centro de município ou ponto aproximado da geocodificação reversa. Sem município brasileiro confirmado, não retorna preço. Cidade, classificação, rota e valores permanecem sob controle do servidor. As coordenadas entram na prova assinada quando essa proteção está configurada. A mensagem de WhatsApp inclui links dos pontos efetivamente utilizados no cálculo.

Editar ou limpar o endereço invalida a localização confirmada. Alterar endereços durante uma consulta impede a exibição de orçamento desatualizado. Um backend antigo que ignore coordenadas não produz uma estimativa silenciosamente incorreta: o frontend exige confirmação dos pontos pelo servidor.

## Publicação

1. Publicar `worker.js` no Worker existente `fonseca-logistica-api`, preservando todos os bindings e variáveis existentes. Nenhuma nova chave ou conta é necessária.
2. Verificar o endpoint `POST /locations/search`, com JSON `{"text":"São Bento do Sul"}`, e um orçamento com `locations.pickup` e `locations.deliveries`.
3. Publicar `index.html`, `frontend-quote.mjs` e `frontend-locations.mjs` juntos no Cloudflare Pages existente. Não publicar somente o HTML.
4. No celular, testar marcação manual na coleta e na entrega, localização com permissão aceita e recusada, múltiplas entregas, edição/limpeza após confirmação e os links enviados no WhatsApp.

O frontend usa Leaflet 1.9.4 carregado sob demanda via unpkg e tiles HTTPS do OpenStreetMap, com atribuição visível. Não faz downloads de mapa em massa, pré-carregamento ou armazenamento offline. Geoapify continua sujeito à cota gratuita existente: busca manual e geocodificação reversa consomem chamadas. A interface mostra a precisão do GPS e exige confirmação antes do cálculo.

## Verificação automatizada

`node --test --test-skip-pattern='HTML local' worker.test.mjs frontend-quote.test.mjs frontend-locations.test.mjs`

O teste do arquivo legado `TESTE-LOCAL-CELULAR.html` não integra esta verificação porque esse arquivo de aproximadamente 7,6 MB não foi baixado no checkout. Ele não foi alterado. Os scripts do HTML de produção também foram verificados com `node --check`.

Ainda é necessária verificação visual e funcional em navegador real e no Cloudflare: não havia executável Chromium disponível no ambiente de implementação, e os testes de Geoapify usam respostas simuladas. Sem exemplos concretos de endereços problemáticos, não é possível medir a melhora de cobertura da busca.
