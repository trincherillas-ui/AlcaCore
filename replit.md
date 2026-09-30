# Guild Manager Discord Bot

Bot de gestión de servidores de Discord inspirado en Guild Manager, con moderación configurable, economía, niveles, autoroles, tickets y auditoría persistente.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`
- Optional env: `DISCORD_ENABLE_PRIVILEGED_INTENTS=true` after enabling Server Members Intent and Message Content Intent in Discord Developer Portal

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot.ts` — cliente Discord, comandos slash, listeners, economía, niveles, tickets y transcripciones.
- `lib/db/src/schema/guilds.ts` — configuración por servidor, perfiles, reportes, tickets, transcripciones y auditoría.
- `artifacts/api-server/src/routes` — endpoint de salud del servicio.

## Architecture decisions

- El bot usa `discord.js` con el token del bot en Secrets; la conexión OAuth de Discord no sustituye un bot token para acciones administrativas.
- Los comandos se registran por servidor cuando el bot tiene acceso; si Discord devuelve `Missing Access`, se registran globalmente para que el proceso siga funcionando.
- Los datos se particionan por `guild_id` y se guardan en PostgreSQL mediante Drizzle.
- Los roles rainbow rotan colores periódicamente porque Discord solo permite un color por rol a la vez.
- Los tickets se cierran guardando HTML completo en `ticket_transcripts` y enviando una copia al canal de logs configurado.

## Product

Incluye `/setlogschannel`, `/setticketlogschannel` y `/settranscriptschannel` para separar los logs normales, los eventos de tickets y los archivos de transcripción; además de un sistema de moderación manual y AutoMod con listas negras y blancas, avisos acumulables, sanciones, mensajes privados y logs de moderación configurables. Se integra con `/setreportschannel`, configuración de bienvenida/verificación/tickets, `/panel` para personalizar título, texto y color de los cuatro paneles, `/create rb role`, `/colores`, `/economia`, `/nivel`, `/reportar`, `/ticket`, `/ticket-panel`, `/ping` y `/help`. Los registros de auditoría, moderación y transcripciones permanecen disponibles en la base de datos.

## User preferences

- El usuario pidió respuestas y configuración en español.

## Gotchas

- Para habilitar eventos de bienvenida, AutoMod y recibir contenido completo de mensajes, activar Server Members Intent y Message Content Intent en el Developer Portal y establecer `DISCORD_ENABLE_PRIVILEGED_INTENTS=true`.
- Los comandos globales de Discord pueden tardar hasta una hora en aparecer; con el bot invitado al servidor indicado, reiniciar el servicio registra los comandos por servidor.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
