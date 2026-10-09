# Endereços ausentes e confirmação no mapa

A calculadora buscava somente um candidato no Geoapify e recusava o endereço quando esse candidato não tinha precisão suficiente. Não havia seleção manual de localização. A alteração consulta até cinco candidatos e mantém os critérios de precisão existentes. Isso amplia a busca, mas não adiciona ruas ou números ausentes à base do provedor.

Quando a busca não resolve o endereço, cada coleta e entrega permite abrir um mapa OpenStreetMap, buscar bairro e cidade, rua ou estabelecimento para orientar a navegação e ajustar o ponto com um pino fixo no centro. Resultados de pesquisa não confirmam automaticamente um endereço: o usuário precisa conferir e confirmar o ponto. Também pode usar a localização do dispositivo, após autorizar o navegador, e ajustar o marcador.

O Worker valida as coordenadas e consulta o município e as localidades no Geoapify. Mantém as coordenadas escolhidas, sem substituí-las por centro de município ou ponto aproximado da geocodificação reversa. Sem município brasileiro confirmado, não retorna preço. Cidade, classificação, rota e valores permanecem sob controle do servidor. As coordenadas entram na prova assinada quando essa proteção está configurada. A mensagem de WhatsApp inclui links dos pontos efetivamente utilizados no cálculo.

Editar ou limpar o endereço invalida a localização confirmada. Alterar endereços durante uma consulta impede a exibição de orçamento desatualizado. Um backend antigo que ignore coordenadas não produz uma estimativa silenciosamente incorreta: o frontend exige confirmação dos pontos pelo servidor.

## Publicação

1. Publicar `worker.js` no Worker existente `fonseca-logistica-api`, preservando todos os bindings e variáveis existentes. A busca atual funciona com a chave Geoapify existente. O teste opcional TomTom precisa do secret `TOMTOM_API_KEY`.
2. Verificar o endpoint `POST /locations/search`, com JSON `{"text":"São Bento do Sul"}`, e um orçamento com `locations.pickup` e `locations.deliveries`.
3. Publicar `index.html`, `frontend-quote.mjs` e `frontend-locations.mjs` juntos no Cloudflare Pages existente. Não publicar somente o HTML.
4. No celular, testar marcação manual na coleta e na entrega, localização com permissão aceita e recusada, múltiplas entregas, edição/limpeza após confirmação e os links enviados no WhatsApp.

O frontend usa Leaflet 1.9.4 carregado sob demanda via unpkg e tiles HTTPS do OpenStreetMap, com atribuição visível. Não faz downloads de mapa em massa, pré-carregamento ou armazenamento offline. Geoapify continua sujeito à cota gratuita existente: sugestões, busca manual e geocodificação reversa consomem chamadas. Sugestões Geoapify só são buscadas após 800 ms sem digitação e com pelo menos cinco caracteres. A interface mostra a precisão do GPS e exige confirmação antes do cálculo.

## Verificação automatizada

`node --test --test-skip-pattern='HTML local' worker.test.mjs frontend-quote.test.mjs frontend-locations.test.mjs`

O teste do arquivo legado `TESTE-LOCAL-CELULAR.html` não integra esta verificação porque esse arquivo de aproximadamente 7,6 MB não foi baixado no checkout. Ele não foi alterado. Os scripts do HTML de produção também foram verificados com `node --check`.

Ainda é necessária verificação visual e funcional em navegador real e no Cloudflare: não havia executável Chromium disponível no ambiente de implementação, e os testes de Geoapify usam respostas simuladas. Sem exemplos concretos de endereços problemáticos, não é possível medir a melhora de cobertura da busca.


## Comparar TomTom

1. Criar conta em https://my.tomtom.com e obter uma chave em **API & SDK Keys**.
2. No Cloudflare, abrir **Workers & Pages → fonseca-logistica-api → Settings → Variables and Secrets**, adicionar `TOMTOM_API_KEY` como **Secret** e salvar/publicar. Não colocar a chave no HTML, GitHub ou chat.
3. Publicar este `worker.js` e os arquivos do frontend da mesma revisão.
4. No mapa, selecionar **Testar TomTom**, informar a consulta completa (incluindo cidade) e clicar **Buscar**. Comparar a mesma consulta com **Busca atual (Geoapify)**.
5. Usar vinte exemplos reais: dez ruas com número, cinco bairros e cinco estabelecimentos. Anotar resultado encontrado, ponto correto/entrada e necessidade de ajuste. Um mapa bonito não comprova cobertura melhor.

O teste usa TomTom Orbis Places **Discover v3**, para consultas completas no botão Buscar. Não usa Discover para sugestões enquanto digita: a API própria para isso é Suggest, que exige resolução posterior. A documentação consultada lista 5.000 consultas Discover gratuitas por mês; conferir a cota no painel da conta. O mapa permanece OpenStreetMap e as rotas e preços continuam no fluxo Geoapify. Sem chave ou em erro, a interface informa a indisponibilidade e permite escolher a busca atual. Não há fallback oculto entre fontes.

Referências: https://docs.tomtom.com/places-search-api/documentation/places-search/discover ; https://docs.tomtom.com/pricing ; https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/ . Testes automatizados usam respostas simuladas; a comparação real depende da chave e de testes no navegador.
