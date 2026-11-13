---
name: 🚀 Deployment / Release
about: Track a deployment or release
title: "[DEPLOY] "
labels: ["deployment"]
assignees: duenss
---

## 🚀 Deployment Target
- [ ] **Panel** → Cloudflare Pages (auto on push to master)
- [ ] **Bot** → Coolify / Pterodactyl (Docker image rebuild)
- [ ] **Database** → Supabase SQL migrations
- [ ] **Full Stack** → All of the above

## 📦 Version / Commit
**Commit SHA:** 
**Branch:** 
**Tag (if releasing):** v

## 📋 Changes Included
<!-- List key changes, or reference PRs/issues -->

## ✅ Pre-deployment Checklist
- [ ] All CI checks pass (GitHub Actions green)
- [ ] SQL migrations reviewed and ready (`sql/11_arreglar_estado_campanas.sql`, `sql/13_wa_estado_clientes.sql`)
- [ ] Environment variables configured in target (Coolify/Pterodactyl/Cloudflare Pages)
- [ ] Secrets rotated if needed (`BOT_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`)
- [ ] `docs/PENDIENTES.md` reviewed for blockers
- [ ] Backup of bot data/volumes taken (if applicable)

## 🔧 Deployment Steps
### Panel (Cloudflare Pages)
- [ ] Push to master triggers auto-deploy
- [ ] Verify build succeeds in Cloudflare dashboard
- [ ] Test panel loads at production URL

### Bot (Coolify / Pterodactyl)
- [ ] Trigger rebuild / "Push to Deploy" in Coolify
- [ ] Or: Update Pterodactyl server to latest image
- [ ] Verify `/api/health` returns `{"ok":true}`

### Database (Supabase)
- [ ] Execute pending migrations in SQL Editor
- [ ] Verify no RLS errors in logs

## ✅ Post-deployment Verification
- [ ] Panel loads without JS errors
- [ ] WhatsApp QR generates correctly in Ajustes
- [ ] Test message sent and received
- [ ] IA responds correctly (test cases)
- [ ] Pedidos flow works end-to-end
- [ ] Campañas/Anuncios send correctly
- [ ] No errors in bot logs

## 📝 Rollback Plan
<!-- If something goes wrong, how to revert -->

## 📋 Notes
<!-- Any additional context -->