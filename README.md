# PolyShi Bonding Map na Vercel

## Estrutura
```
index.html                  <- coloque aqui o seu index.html (a versão mais recente)
api/kalshi/[...path].js     <- proxy da Kalshi (substitui /api/kalshi do server.js)
api/telegram/status.js      <- GET  /api/telegram/status
api/telegram/send.js        <- POST /api/telegram/send  (botão "Enviar teste")
api/alerts/run.js           <- GET  /api/alerts/run?key=...  (um ciclo de alertas por chamada)
lib/monitor.js              <- lógica de alertas do seu server.js, adaptada
vercel.json  package.json
```

## Variáveis de ambiente (Settings > Environment Variables)
| Nome | Para quê |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token do bot |
| `TELEGRAM_CHAT_ID` | chat que recebe os alertas |
| `CRON_SECRET` | senha longa e aleatória que protege `/api/alerts/run` |
| `ALERTS_CONFIG` | opcional, JSON com os ajustes (ex.: `{"scoreMin":8,"prazoMax":7,"silencio":{"ativo":true,"inicio":"23:00","fim":"07:00"}}`) |
| `ALERTS_TZ` | opcional, fuso dos horários de silêncio e resumo (padrão `America/Sao_Paulo`) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | memória dos alertas. Crie um banco Redis (Upstash) em Storage/Marketplace e conecte ao projeto: as duas variáveis entram sozinhas |

## Alertas de hora em hora
A Vercel Hobby só agenda tarefas uma vez por dia. Use um agendador gratuito que chame a URL a cada hora cheia:
`https://SEU-SITE.vercel.app/api/alerts/run?key=SEU_CRON_SECRET`
- cron-job.org: expressão `0 * * * *` e o fuso America/Sao_Paulo.
- GitHub Actions: workflow com `schedule: - cron: "0 * * * *"` (horário UTC, pode atrasar alguns minutos) rodando `curl` na URL.

Sem o Redis, o aviso de "já enviado" some a cada reinício da função e os mesmos mercados podem ser reenviados.

## Cuidados
- No site, deixe "Ativar alertas" da página desligado: o envio automático agora é feito pelo servidor.
- `/api/telegram/send` aceita chamadas do próprio site. Como o site é público, ative a proteção por senha da Vercel (Deployment Protection) se não quiser que outras pessoas usem a página.
- Nunca coloque o token do bot no `index.html`.
