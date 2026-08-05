# Live Max — License Server v3.1 (persistente)

## Por que os tokens somem?

No Render o disco do app **é apagado a cada deploy**.  
Os tokens ficavam em `licenses.json` dentro da pasta do código → sumiam.

## Solução recomendada: Persistent Disk no Render

1. No painel do Render → seu Web Service **backende**
2. **Settings** → **Disks** → **Add Disk**
   - Name: `licenses-data`
   - Mount Path: `/var/data`
   - Size: 1 GB (suficiente)
3. **Environment** → Add:
   - Key: `DB_PATH`
   - Value: `/var/data/licenses.json`
4. Salve e faça **Manual Deploy**

A partir daí os tokens sobrevivem a deploys e restarts.

## Outras variáveis

| Variável | Exemplo | Função |
|----------|---------|--------|
| `ADMIN_KEY` | senha-forte | Acesso ao painel /admin |
| `DB_PATH` | `/var/data/licenses.json` | Onde salvar os tokens |
| `MAX_DEVICES` | `2` | PC + celular por token |
| `PORT` | automático no Render | Porta HTTP |

## NÃO faça

- Não commite `licenses.json` no GitHub (já está no `.gitignore`)
- Não apague o disco `/var/data` no Render
- Não sobrescreva `licenses.json` no repositório

## Backup manual

No painel admin → **Exportar CSV** — salva a lista de tokens no seu PC.  
Faça isso de vez em quando como segurança extra.

## Deploy

```bash
npm install
# local:
ADMIN_KEY=sua-chave DB_PATH=./licenses.json node server.js
```

No Render o Start Command típico:
```
node server.js
```
(Build: `npm install`)


## Licença editável (nome + código fixo)

No painel admin você pode:

1. **Nome do cliente** — ex.: `LUCAS` (campo nota)
2. **Código fixo** — ex.: `LM-LUCAS-2026-0001`
3. Clicar **Gerar / Restaurar**

Se o banco de tokens apagar no deploy, basta **recriar com o mesmo código**.  
O cliente continua com o token que já está na extensão/app — não precisa trocar nada.

Também dá para colar uma lista:

```
LM-AAAA-BBBB-CCCC,LUCAS
LM-XXXX-YYYY-ZZZZ,MARIA
```

e clicar **Importar / Restaurar**.

**Dica:** use disco persistente no Render (`DB_PATH=/var/data/licenses.json`) para os tokens não sumirem.


## Web Push (notificação no celular com app fechado)

1. No Render, Build Command:
   ```
   npm install
   ```
2. Variáveis opcionais (já tem chave padrão no código):
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (ex: mailto:voce@email.com)

3. No celular (site): Config → **Ativar notificações**
4. Extensão 3.1.8+ envia push a cada venda

Endpoints:
- `GET /api/push/vapidPublicKey`
- `POST /api/push/subscribe` `{ token, deviceId, subscription }`
- `POST /api/push/notify` `{ token, title, body }`
