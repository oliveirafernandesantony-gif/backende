# Live Max — App Companheiro (PWA)

Versão inicial do aplicativo mobile da Live Max.

## Cores
Usa exatamente a paleta oficial da extensão **Live Max 3.0.8**.

## Como testar agora (sem Supabase ainda)

1. Abra a pasta `livemax-app` no VS Code / Cursor
2. Use a extensão **Live Server** ou rode:
   ```bash
   npx serve .
   ```
3. No celular (mesma rede) ou no Chrome do PC, abra o endereço.
4. Cole qualquer token com 8+ caracteres para entrar.
5. Para simular uma live, abra o Console do navegador (F12) e rode:

```js
// Iniciar live
LiveMaxApp.onLiveStart({ viewers: 128 })

// Registrar vendas
LiveMaxApp.onSale({ product: "Kit Skincare", value: 89.90 })
LiveMaxApp.onSale({ product: "Fone Bluetooth", value: 149.00 })

// Atualizar espectadores
LiveMaxApp.onViewers(256)

// Alerta de risco
LiveMaxApp.onViolation("Possível violação detectada")

// Encerrar live
LiveMaxApp.onLiveEnd()
```

## Próximos passos
- Conectar Supabase (plano Free)
- Extensão enviar eventos em tempo real
- Botão "Encerrar Live" mandar comando de volta para a extensão
- Notificações push nativas

## Estrutura
```
livemax-app/
├── index.html      → Telas (Login + App)
├── styles.css      → Visual idêntico ao Live Max 3.0.8
├── app.js          → Lógica + API pública
├── manifest.json   → PWA instalável
├── sw.js           → Service Worker
└── icons/          → Ícones
```
