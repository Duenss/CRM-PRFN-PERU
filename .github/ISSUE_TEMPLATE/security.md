---
name: 🔒 Security Issue
about: Report a security vulnerability (use privately if sensitive)
title: "[SECURITY] "
labels: ["security"]
assignees: duenss
---

## ⚠️ IMPORTANT
**If this is a critical vulnerability (exposed secrets, RCE, auth bypass, data leak), DO NOT create a public issue.**
Instead, email the project owner directly or use GitHub's private vulnerability reporting.

## 🔒 Security Issue Description
<!-- Describe the security concern -->

## 🎯 Affected Component
- [ ] Bot API endpoints
- [ ] Panel authentication/authorization
- [ ] Proxy (Cloudflare Functions)
- [ ] Database (Supabase RLS/policies)
- [ ] Docker/Infrastructure
- [ ] Secrets management
- [ ] Dependencies (supply chain)

## 📋 Severity Assessment
- [ ] **Critical** – Active exploit, data breach, full system compromise
- [ ] **High** – Auth bypass, significant data exposure, DoS
- [ ] **Medium** – Information disclosure, partial auth issues
- [ ] **Low** – Minor configuration issue, best practice violation

## 🔄 Steps to Reproduce (if safe)
<!-- Only if this doesn't expose the vulnerability further -->

## 🛡️ Suggested Fix / Mitigation
<!-- If you have a fix in mind -->

## 📝 Additional Context
<!-- References, related CVEs, etc. -->

## ✅ Checklist
- [ ] I have NOT exposed any secrets in this report
- [ ] I have verified this is not a false positive
- [ ] This report follows responsible disclosure