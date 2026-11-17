# HiveDocker

Cliente de túnel HiveNode para Linux, Windows e servidores com Docker. O painel local exige autenticação e mostra o estado real da conexão.

## Executar

Defina PANEL_TOKEN e execute docker compose up -d --build. O painel fica em http://127.0.0.1:8080. Digite o token, clique em Vincular aparelho e aprove o código no painel web.

A configuração é persistida no volume hivedocker_data, em /app/data/config.json. Não monte um arquivo vazio como configuração.

Variáveis: WEB_BASE (Web/API), BROKER_URL (ws:// ou wss://), PANEL_TOKEN e NODE_VISIBILITY (PUBLIC ou PRIVATE). A frota privada exige plano ativo.

## CLI Linux

hivecli controla este mesmo motor. Requer curl, jq, HiveDocker em execução e HIVE_PANEL_TOKEN. HIVE_PANEL_URL assume http://127.0.0.1:8080.

Comandos: hivecli auth, hivecli status, hivecli start, hivecli stop e hivecli logout. Vínculo registra o aparelho pela API; status lê o estado atual do túnel.

## Testes

Execute npm test para validar autenticação do painel, proteção de destinos, reinício imediato e cancelamento durante DNS.
