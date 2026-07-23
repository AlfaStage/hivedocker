# HiveDocker

Bem-vindo ao **HiveDocker**, o cliente oficial em container do HiveNode para servidores locais e homelabs.

O HiveDocker permite que você transforme qualquer servidor rodando Docker em um nó da rede HiveNode, rentabilizando sua banda ociosa ou gerenciando tráfego privado (SOCKS5 Proxy).

## Requisitos
- Docker instalado na máquina.
- Para rodar via Compose, \`docker-compose\` instalado.

## Como Instalar e Rodar

### Opção 1: Via Docker Compose (Recomendado)
A maneira mais fácil e padronizada para servidores Linux/Windows.

1. Clone o repositório ou baixe os arquivos \`docker-compose.yml\`, \`Dockerfile\`, \`package.json\`, \`server.js\` e a pasta \`public/\`.
2. No terminal, dentro da pasta do projeto, execute:
   \`\`\`bash
   docker-compose up -d --build
   \`\`\`
3. Acesse o painel local pelo navegador na porta **8080**:
   \`http://localhost:8080\` ou \`http://IP_DO_SERVIDOR:8080\`
4. Clique em "Vincular Dispositivo" e siga as instruções para autorizar no painel principal da AlfaStage.

### Opção 2: Via Docker CLI (Sem Compose)
Caso prefira rodar apenas com o comando Docker direto:

1. Compile a imagem localmente:
   \`\`\`bash
   docker build -t hivedocker .
   \`\`\`
2. Inicie o container montando o volume do arquivo de configuração para persistência:
   \`\`\`bash
   touch config.json
   docker run -d --name hivedocker -p 8080:8080 -v $(pwd)/config.json:/app/config.json --restart unless-stopped hivedocker
   \`\`\`

### Opção 3: No Docker Desktop (Windows / Mac)
Se estiver em ambiente visual (Desktop):

1. Clone/Baixe a pasta \`hivedocker\`.
2. Abra o terminal na pasta e rode \`docker-compose up -d --build\` ou use a própria interface gráfica do Docker Desktop acessando a aba "Dev Environments" ou criando o container via terminal.
3. Abra o navegador em \`http://localhost:8080\`.
4. Os logs aparecerão na aba "Containers/Apps" do Docker Desktop.

### Opção 4: Via Coolify (Self-Hosted PaaS)
Para rodar dentro do seu próprio servidor gerenciado pelo Coolify:

1. No painel do Coolify, crie um novo **Project** -> **Resource** -> **Public Repository**.
2. Cole a URL deste repositório: \`https://github.com/AlfaStage/hivedocker\`.
3. Escolha o branch \`main\` e avance.
4. O Coolify detectará automaticamente o **Dockerfile**.
5. Configure a porta **8080** no painel do Coolify para ser exposta ao público ou a um domínio customizado (Ex: \`node.meudominio.com\`).
6. Clique em **Deploy**. Quando terminar, o painel do HiveDocker estará rodando perfeitamente.

## Estrutura do Projeto
- \`server.js\`: O motor Node.js que emula o túnel TCP da HiveNode via WebSockets (o mesmo protocolo do app nativo).
- \`public/index.html\`: O dashboard simples para acompanhamento visual, ligar/desligar a antena localmente e ler os logs.
- \`config.json\`: Arquivo onde a sessão e tokens ficam guardados localmente (persistido via Docker Volumes).

## Suporte
Em caso de dúvidas, contate o suporte da AlfaStage ou crie uma Issue neste repositório.
