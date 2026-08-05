# Live Max — License Server v3

Multi-dispositivo: **mesmo token no PC (extensão) e no celular (app/site)** — máx. 2 dispositivos.

## Deploy (Render / Node)

```bash
npm install
ADMIN_KEY=sua-chave-secreta node server.js
```

Env opcional:
- `PORT` (default 3847)
- `ADMIN_KEY` (obrigatório em produção)
- `MAX_DEVICES` (default 2)
- `DB_PATH` (arquivo JSON das licenças)

## API

### POST `/api/validate` e `/api/heartbeat`
```json
{ "token": "LM-XXXX-XXXX-XXXX", "deviceId": "ext-abc123", "deviceType": "extension" }
```
`deviceType`: `extension` | `mobile` | `web`

Resposta OK:
```json
{ "ok": true, "valid": true, "deviceCount": 1, "maxDevices": 2, "message": "..." }
```

Se já houver 2 dispositivos diferentes, retorna `valid: false` com mensagem de limite.

### Admin
Painel em `/admin/` — mostra os 2 slots de dispositivo e permite **Desvinc.** (limpa todos).

## Migração
Tokens antigos com `device_id` único são migrados automaticamente para `devices[]`.
