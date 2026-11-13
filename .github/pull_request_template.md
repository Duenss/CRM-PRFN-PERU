<!-- Pull Request Template for CRM Perfumería Fina Perú -->

## 📋 Description
<!-- Describe what this PR does and why -->

## 🔗 Related Issues
<!-- Link to related issues using "Fixes #123" or "Relates to #123" -->

## ✅ Type of Change
- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] ♻️ Refactoring
- [ ] 📝 Documentation update
- [ ] 🔧 Configuration/DevOps
- [ ] 🧪 Tests
- [ ] 🔒 Security

## 🧪 Testing
<!-- Describe how you tested this change -->
- [ ] Unit tests pass (`cd bot && npm test`)
- [ ] E2E tests pass (`node scripts/e2e-panel.mjs`)
- [ ] Manual testing performed
- [ ] No console errors in panel

## 📦 Deployment Impact
- [ ] Requires SQL migration (specify which file in `/sql/`)
- [ ] Requires environment variable changes
- [ ] Requires bot restart (Docker image rebuild)
- [ ] Requires Cloudflare Pages redeploy
- [ ] No deployment action needed

## 🔐 Security Checklist
- [ ] No secrets committed (`.env`, keys, tokens)
- [ ] No sensitive data in logs/output
- [ ] Input validation implemented
- [ ] Authentication/authorization checked
- [ ] RLS policies considered (if DB changes)

## 📱 Affected Components
- [ ] **Bot** (WhatsApp, IA, pedidos, campañas, anuncios, validación)
- [ ] **Panel** (Bandeja, Pedidos, Campañas, Clientes, Catálogo, Ajustes, IA)
- [ ] **Proxy API** (Functions, auth, CORS, rate limiting)
- [ ] **Database** (Supabase schema, RLS, functions)
- [ ] **Docker/Infra** (Dockerfile, docker-compose, Coolify, Pterodactyl)

## 📝 Additional Notes
<!-- Any additional context, screenshots, or considerations -->

---

### For Reviewers
- [ ] Code follows project conventions (ESLint + Prettier)
- [ ] Tests are adequate and pass
- [ ] Documentation updated if needed
- [ ] Security implications considered
- [ ] Deployment steps documented