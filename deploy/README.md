# Deploy do OfertaFlow

Estes arquivos são a metade OfertaFlow da migração. O roteiro completo, com os
dois sistemas em ordem, está em `dubflow/deploy/README.md`.

- `ofertaflow.service` — painel, ingestão e publicação (Node).
- `ofertaflow-vnc.service` — a sessão gráfica (X) em que o Chrome roda.
- `ofertaflow-chrome.service` — Chrome com a extensão, na sessão gráfica.

O VNC precisa ser serviço, e não um comando dado à mão uma vez. Ele foi subido
manualmente na migração de 12/09/2026 e sobreviveria até o primeiro reboot: sem
sessão gráfica o Chrome não sobe, sem Chrome não há link de afiliado, e sem link
nada sai da fila. O sistema pareceria vivo — painel no ar, colheita rodando — e
não publicaria mais nada. Daí o `Before=ofertaflow-chrome.service`.

## Por que o Chrome é um serviço

A geração do link de afiliado e a colheita das lojas de marca **não funcionam
sem navegador logado**. O Mercado Livre devolve anti-bot (200 com ~41 KB e zero
produto) para quem não é navegador — testado do servidor, é assim que responde.

Logo: a máquina precisa de sessão gráfica, o perfil do Chrome precisa ser
persistente, e a sessão do painel de afiliados precisa ser feita uma vez à mão
pelo VNC. Sem isso o sistema coleta e nunca publica, porque nada sai da fila sem
link atribuído.

## A extensão

O serviço carrega de `/opt/ofertaflow/extension`. Copie para lá a pasta da
extensão do gerador de links — a mesma que você usa hoje no Chrome do seu PC.
